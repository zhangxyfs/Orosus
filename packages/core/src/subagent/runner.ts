import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  SubagentOutcome,
  SubagentPort,
  SubagentRosterEntry,
  SubagentSpawnRequest,
} from "@orosus/contracts/module";
import type { StreamFn } from "@orosus/contracts/provider";
import { createEventBus } from "../kernel/bus.ts";
import { createToolRegistry } from "../tool/registry.ts";
import { agentLoop } from "../loop/loop.ts";
import { LOG_TYPES, type SessionEvent, type SessionStore } from "../session/types.ts";
import { SUBAGENT_CONCLUSION_TAIL, SUBAGENT_ID_LEN, SUBAGENT_MAX_TURNS } from "./constants.ts";
import type { ModuleGraph } from "../kernel/kernel.ts";
import type { DiagSink } from "../diag/logger.ts";

/** runner 依赖（createHarness 闭包注入——照 sessionForkFn 先例：调用期读最新值，激活期不可用）。 */
export interface SubagentDeps {
  /** 主会话 store（亲缘 header 的 parentSession + forkFrom 的父投影源）。 */
  mainStore: SessionStore;
  /** 会话桶目录（子代理会话落 <桶>/<主sid>/agents/agents_<编号>/agents/session.jsonl——决策 19）。 */
  sessionsDir: string;
  sink: DiagSink;
  cwd: string;
  /** 造子会话 store（JsonlStore 原生形状：dir + sessionId）。 */
  makeStore: (sessionId: string, dir: string) => SessionStore;
  /** 活图访问器（reload 换图后读新值——工具面/审批转发都取当刻图）。 */
  graph: () => ModuleGraph;
  /** 配置 sections 访器（[tool-subagent] 的 model/approvalMode 读这里——内核消费侧）。 */
  configSections: () => Map<string, Record<string, unknown>>;
  /** 父模型解析（三来源兜底——resolveProvider 同款）。 */
  resolveParentModel: () => { stream: StreamFn; model: string };
  /** 限定形模型解析（settings/工种给的值——resolveModelValue 同款，支持钉槽）。 */
  resolveModel: (value: string) => { stream: StreamFn; model: string };
}

/** 8 位编号（决策 20：唯一同源；撞活动册或撞盘上既有目录都重生成）。 */
const allocId = (taken: Set<string>, agentsDir: string): string => {
  for (let i = 0; i < 8; i++) {
    const id = randomBytes(SUBAGENT_ID_LEN / 2).toString("hex");
    if (taken.has(id)) continue;
    if (existsSync(join(agentsDir, `agents_${id}`))) continue; // resume 后旧 agents_ 目录也算占用
    taken.add(id);
    return id;
  }
  throw new Error("子代理编号生成撞码（连续 8 次——概率趋零，请重试）");
};

/** assistant/message → 文本（结论提取；reasoning 段不算结论）。 */
const textOf = (e: SessionEvent): string =>
  ((e.content ?? []) as { kind?: string; text?: string }[])
    .filter((p) => p.kind === "text")
    .map((p) => p.text ?? "")
    .join("");

/** 子代理系统提示词（决策 14：角色段 → 工种正文 → 扩展位〔空位注释〕）。 */
const buildSystemPrompt = (req: SubagentSpawnRequest): string => {
  const trimmed = req.rolePrompt?.trim() ?? "";
  const role = trimmed !== "" ? trimmed : "You are a general-purpose coding and research assistant. Complete the given task end to end.";
  return [
    "## Role\nYou are an Orosus sub-agent — an independent helper dispatched for exactly one task. You do not share the dispatching conversation's context (unless history was explicitly attached): work from the task brief alone, use tools as needed, and finish with a final answer — only the final answer is returned to the dispatcher.",
    `## Role Definition${req.roleName !== undefined ? ` (${req.roleName})` : ""}\n${role}`,
    "## Sub-agent Notes\n- Reply in the same language as the task brief.\n- The last assistant message is taken as the deliverable: end with a concise final answer (conclusion first, details after), not a progress report.",
    // 扩展位（预留——决策 14 段序：角色段 → 工种正文 → 扩展位）
  ].join("\n\n");
};

/** 三来源模型解析（决策 7：/settings 配置 > 工种文件 > 跟父）。 */
const resolveAgentModel = (
  deps: SubagentDeps,
  req: SubagentSpawnRequest,
): { stream: StreamFn; model: string; source: string } => {
  const cfgModel = deps.configSections().get("tool-subagent")?.model;
  if (typeof cfgModel === "string" && cfgModel !== "") {
    return { ...deps.resolveModel(cfgModel), source: "settings" };
  }
  if (req.model !== undefined && req.model !== "") {
    return { ...deps.resolveModel(req.model), source: "role" };
  }
  return { ...deps.resolveParentModel(), source: "parent" };
};

/**
 * 内核子代理执行口（M4.5 T1：开子会话 + 跑对话循环 + 取结论）。
 * 会话文件落主会话文件夹（决策 19：树扫描天然免疫——scanBucketSessions 不递归）；
 * 工具面 = 主对话活工具原样抄一份（T2 起按工种减/到顶剥）；审批走子代理独立 bus（T2 接回主关卡）。
 */
export function createSubagentRunner(deps: SubagentDeps): SubagentPort {
  const takenIds = new Set<string>();

  const agentsDirOf = (): string => join(deps.sessionsDir, deps.mainStore.sessionId, "agents");

  const runOne = async (
    req: SubagentSpawnRequest,
    id: string,
    callerSignal: AbortSignal | undefined,
  ): Promise<SubagentOutcome> => {
    const agentsDir = agentsDirOf();
    const agentSid = `agents_${id}`;
    const agentStore = deps.makeStore(agentSid, agentsDir);
    const spillDir = join(agentsDir, agentSid, "spill"); // 显式传——默认拼装 join(sessionsDir, sid, "spill") 会落错位（harness.ts spill 同款坑）
    const maxTurns = Math.min(req.maxTurns ?? SUBAGENT_MAX_TURNS, SUBAGENT_MAX_TURNS);
    let turns = 0;
    let lastText = "";
    let endKind = "completed";
    let endError: string | undefined;
    const abortedByCap = (): boolean => turns >= maxTurns;

    const controller = new AbortController();
    if (callerSignal !== undefined) {
      // 前台取消链（决策 11：跟主对话取消信号走——主 turn 的 signal 打断即打断）
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      await agentStore.append(LOG_TYPES.sessionHeader, {
        format: 1,
        cwd: deps.cwd,
        parentSession: deps.mainStore.sessionId, // 文件头亲缘——树扫描不递归、不当独立会话
      });
      await agentStore.append(LOG_TYPES.userMessage, { content: [{ kind: "text", text: req.prompt }] });

      const resolved = resolveAgentModel(deps, req);
      // 工具面：抄主对话活工具（墓碑不复活——toolInfos 名单 ∩ list；T2 起按工种减 + 到顶剥派活类）
      const liveNames = new Set(deps.graph().tools.toolInfos().map((t) => t.name));
      const bus = createEventBus(deps.sink); // 子代理独立 bus：steering/followUp/审批都不串主对话（T2 在此接审批回主关卡）
      const tools = createToolRegistry({ bus, sink: deps.sink, spillDir });
      for (const t of deps.graph().tools.list().filter((t2) => liveNames.has(t2.name))) {
        tools.register(t, t.name.split("__")[0]!);
      }

      for await (const e of agentLoop({
        session: agentStore,
        bus,
        tools,
        provider: resolved.stream,
        model: resolved.model,
        system: buildSystemPrompt(req),
        signal: controller.signal,
        sink: deps.sink,
      })) {
        if (e.type === LOG_TYPES.turnStep) {
          turns++;
          if (abortedByCap()) controller.abort(); // 轮数保险丝（决策 10）：到顶即停，结论取最后回复
        } else if (e.type === LOG_TYPES.assistantMessage) {
          const t = textOf(e);
          if (t !== "") lastText = t;
        } else if (e.type === LOG_TYPES.turnEnd) {
          endKind = String((e as { kind?: unknown }).kind ?? "completed");
          const em = (e as { errorMessage?: unknown }).errorMessage;
          if (typeof em === "string") endError = em;
        }
      }
    } catch (err) {
      endKind = "error";
      endError = err instanceof Error ? err.message : String(err);
    } finally {
      await agentStore.flush().catch(() => undefined);
      await agentStore.close().catch(() => undefined);
    }

    const conclusion = lastText.slice(-SUBAGENT_CONCLUSION_TAIL); // 保尾（决策 10）
    if (endKind === "completed" && !abortedByCap()) {
      return { id, status: "completed", turns, conclusion };
    }
    const error =
      endKind === "interrupted"
        ? abortedByCap() ? `已达轮数上限 ${maxTurns}，结论为最后回复` : "已被取消（子代理被停止）"
        : endError ?? "子代理执行失败";
    return { id, status: "failed", turns, conclusion, error };
  };

  return {
    async spawn(req, caller) {
      if (req.background === true) {
        throw new Error("后台跑法未落地（M4.5 T8 接入）");
      }
      const id = allocId(takenIds, agentsDirOf());
      return runOne(req, id, caller?.signal);
    },
    list(): SubagentRosterEntry[] {
      return []; // 花名册在 M4.5 T8 落地（子+孙同册、保留 32 条已结束）
    },
    stop(): boolean {
      return false; // 停止口在 M4.5 T8 落地
    },
  };
}
