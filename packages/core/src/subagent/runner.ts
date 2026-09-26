import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  SubagentOutcome,
  SubagentPort,
  SubagentRosterEntry,
  SubagentSpawnRequest,
} from "@orosus/contracts/module";
import type { StreamFn } from "@orosus/contracts/provider";
import { CORE_POINTS, createEventBus } from "../kernel/bus.ts";
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

/** 派活类工具前缀（决策 1：tool-subagent__* 族）。 */
const SPAWN_TOOL_PREFIX = "tool-subagent__";

/** 派活类工具判定（决策 4 双层门控共用同一函数——注册面过滤与运行时拦截都走它，防两处逻辑漂移）。 */
export const isSpawnClassTool = (name: string): boolean => name.startsWith(SPAWN_TOOL_PREFIX);

/** 该深度允不允许派活类工具：子代理（1 层）可再派孙代理；孙代理（2 层）到顶。 */
export const spawnAllowedAtDepth = (depth: 1 | 2): boolean => depth < 2;

/** 执行上下文（M4.5）：当前异步链跑在哪个子代理的循环里——深度自证（模块不用传深度，
 *  孙代理派单经 ALS 自然拿到父上下文）。主对话执行的工具 = 无 store（深度 1）。 */
const execContext = new AsyncLocalStorage<{ agentId: string; depth: 1 | 2 }>();

/** 审批模式解析（决策 3 第一层：手动配置 > 跟随主对话 > 默认 Ask）。
 *  跟随 = 主对话运行期档 never（从不询问）→ 子代理 auto；否则 ask。
 *  主对话运行期档经 approval 模块服务 approval.current-mode 读取（服务倒挂——approval 模块挂、内核运行期取）。 */
const resolveApprovalMode = async (deps: SubagentDeps): Promise<"auto" | "ask"> => {
  const cfgMode = deps.configSections().get("tool-subagent")?.approvalMode;
  if (cfgMode === "auto" || cfgMode === "ask") return cfgMode; // 手动配置优先
  const svc = await deps.graph().services.getOptional("approval.current-mode");
  const mainMode = typeof svc === "function" ? (svc as () => string)() : undefined;
  return mainMode === "never" ? "auto" : "ask"; // 跟随主对话；无 approval 模块/无服务 = 默认 Ask
};

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
    depth: 1 | 2,
    parentId: string | undefined,
    callerSignal: AbortSignal | undefined,
  ): Promise<SubagentOutcome> => {
    const agentsDir = agentsDirOf();
    const agentSid = `agents_${id}`;
    const agentStore = deps.makeStore(agentSid, agentsDir);
    const spillDir = join(agentsDir, agentSid, "spill"); // 显式传——默认拼装 join(sessionsDir, sid, "spill") 会落错位（harness.ts spill 同款坑）
    const maxTurns = Math.min(req.maxTurns ?? SUBAGENT_MAX_TURNS, SUBAGENT_MAX_TURNS);
    const approvalMode = await resolveApprovalMode(deps); // spawn 时定格（决策 3 第一层）
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
        parentSession: parentId ?? deps.mainStore.sessionId, // 亲缘：孙代理挂父代理编号、子代理挂主会话（决策 19 同册同理）
      });
      await agentStore.append(LOG_TYPES.userMessage, { content: [{ kind: "text", text: req.prompt }] });

      const resolved = resolveAgentModel(deps, req);
      // 工具面：抄主对话活工具（墓碑不复活——toolInfos 名单 ∩ list）→ 到顶剥派活类（决策 4①）
      // → 按工种减（只能减不能加——allowedTools 里的未知名静默无效）→ 再减黑名单
      const liveNames = new Set(deps.graph().tools.toolInfos().map((t) => t.name));
      const allowed = req.allowedTools !== undefined ? new Set(req.allowedTools) : undefined;
      const disallowed = req.disallowedTools !== undefined ? new Set(req.disallowedTools) : undefined;
      const bus = createEventBus(deps.sink); // 子代理独立 bus：steering/followUp 不串主对话
      const tools = createToolRegistry({ bus, sink: deps.sink, spillDir });
      for (const t of deps.graph().tools.list().filter((t2) => liveNames.has(t2.name))) {
        if (isSpawnClassTool(t.name) && !spawnAllowedAtDepth(depth)) continue; // 到顶剥（决策 4①）——模型看不见就不会浪费一轮
        if (allowed !== undefined && !allowed.has(t.name)) continue;
        if (disallowed !== undefined && disallowed.has(t.name)) continue;
        tools.register(t, t.name.split("__")[0]!);
      }
      // 审批关卡（决策 3 第二层，T2）：agent bus 的 toolPreExecute → 运行时双层门控第二道（决策 4②）
      // + 模式分流——auto 照单放行；ask 转发主对话关卡（带 ask-risky 档提示与子代理身份，主对话在问时弹串行队列）
      bus.on(CORE_POINTS.toolPreExecute, async (payload) => {
        const p = payload as { name: string; [k: string]: unknown };
        if (isSpawnClassTool(p.name) && !spawnAllowedAtDepth(depth)) {
          return { deny: true, reason: "嵌套已达两层上限——孙代理不能再派子代理（决策 4）" };
        }
        if (approvalMode === "auto") return undefined; // 从不询问：不过主关卡
        const veto = await deps.graph().bus.waterfall(CORE_POINTS.toolPreExecute, {
          ...p,
          mode: "ask-risky", // 需要时候询问（决策 3：AWN 档语义——主对话更严档不放宽到此档之下）
          subagent: { agentId: id, depth, parentId, background: req.background === true, label: req.label },
        });
        return veto ?? undefined;
      }, `subagent:${id}`); // owner 记子代理身份——诊断日志可辨来源

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
      const ctx = execContext.getStore();
      // 运行时门控（决策 4②：与注册面同一个判断函数——缓存/通配/幻觉漏出的派活调用在此拦截）
      if (ctx !== undefined && !spawnAllowedAtDepth(ctx.depth)) {
        throw new Error("嵌套已达两层上限——孙代理不能再派子代理（决策 4）");
      }
      // 嵌套一律前台（决策 4③：孙代理收不到后台完成通知——qwen 教训）
      if (ctx !== undefined && req.background === true) {
        throw new Error("嵌套子代理（孙代理）一律前台——不支持后台（决策 4③）");
      }
      const depth: 1 | 2 = ctx === undefined ? 1 : 2;
      const id = allocId(takenIds, agentsDirOf());
      if (req.background === true) {
        throw new Error("后台跑法未落地（M4.5 T8 接入）");
      }
      // 亲缘挂父代理会话 id（agents_<编号>——JsonlStore sessionId 形态；主对话派单 = 主会话 id）
      return execContext.run({ agentId: id, depth }, () => runOne(req, id, depth, ctx !== undefined ? `agents_${ctx.agentId}` : undefined, caller?.signal));
    },
    list(): SubagentRosterEntry[] {
      return []; // 花名册在 M4.5 T8 落地（子+孙同册、保留 32 条已结束）
    },
    stop(): boolean {
      return false; // 停止口在 M4.5 T8 落地
    },
  };
}
