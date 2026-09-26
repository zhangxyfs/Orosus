import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { ForkedSessionStore } from "../session/fork.ts";
import { claimContains, createWriteGate, normalizeClaimPath, type WriteGate } from "./writegate.ts";
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

/** 静态可判的「会写的工具」名册（决策 24③）：bash 一律算写整仓；未报备的写手算整仓。
 *  名单外工具静态判不了（第三方写工具不占闸——越界回执仍会抓到实际写）。 */
export const WRITE_CAPABLE_TOOLS: ReadonlySet<string> = new Set(["tool-fs__write", "tool-fs__edit", "tool-shell__bash"]);

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

/** 写记账（决策 24⑤ 越界回执的取数口径）：可识别路径逐条（fs 写/改的 path——含被拦尝试）；
 *  bash 实际写不可从命令串还原 → 命令串原样备查（整仓排队兜）。 */
interface WriteRecords {
  actual: Set<string>;
  attempts: Set<string>;
  bashCommands: string[];
}

/** 写记账 + 写绑定皮（决策 24①执行期绑定）：报备了的写工具越界直接报错（被拦尝试也记账——抓「想写别处」的意图）。 */
function wrapForWriteReceipt(t: import("@orosus/contracts/tool").Tool, declaredPaths: string[] | undefined, rec: WriteRecords, cwd: string): import("@orosus/contracts/tool").Tool {
  return {
    ...t,
    resolveExecution: async (input) => {
      const exec = await t.resolveExecution(input);
      if (exec.accesses === undefined || exec.accesses.every((a) => a.kind !== "fs.write")) {
        // bash 命令串备查（不透明写——回执附原文）
        if (t.name === "tool-shell__bash") {
          const cmd = (input as { command?: unknown }).command;
          if (typeof cmd === "string" && cmd !== "") rec.bashCommands.push(cmd);
        }
        return exec;
      }
      return {
        ...exec,
        execute: async (tc) => {
          const writePaths = exec.accesses!.filter((a): a is { kind: "fs.write"; path: string } => a.kind === "fs.write").map((a) => a.path);
          for (const wp of writePaths) rec.attempts.add(wp);
          if (declaredPaths !== undefined) {
            // 写绑定（决策 24①执行期绑定）：报备了的，写目标必须落在某条报备内（目录包含）
            const bad = writePaths.find((wp) => {
              const folded = foldPath(cwd, wp);
              return !declaredPaths!.some((d) => claimContains(d, folded));
            });
            if (bad !== undefined) {
              return {
                output: `写路径越界：${bad} 不在报备的写路径内（报备：${declaredPaths.join("、")}）——只写报备内的路径，或请主代理在派活时补 writePaths`,
                isError: true,
              };
            }
          }
          const r = await exec.execute(tc);
          if (!r.isError) for (const wp of writePaths) rec.actual.add(wp);
          return r;
        },
      };
    },
  };
}

/** 写路径折叠比较（归一同款：resolve〔相对工作目录〕+ win32 大小写折叠——声明路径已归一，写目标现场归一到同基）。 */
function foldPath(cwd: string, target: string): string {
  const r = resolve(cwd, target);
  return (process.platform === "win32" ? r.toLowerCase() : r).split(/[\\/]/).join("/");
}

/** 越界回执组装（决策 24⑤）：actual ∪ attempts 逐条比对报备——不在报备内的列入；未报备（整仓）= 全部列入。 */
function buildReceipt(rec: WriteRecords, declaredPaths: string[] | undefined, cwd: string): { outOfBounds?: string[]; bashCommands?: string[] } {
  const all = [...new Set([...rec.actual, ...rec.attempts])].map((p) => foldPath(cwd, p));
  const outOfBounds = declaredPaths !== undefined
    ? all.filter((p) => !declaredPaths.some((d) => claimContains(d, p)))
    : all; // 未报备却写了——全部列入（整仓排队兜过冲突，回执如实报）
  return {
    ...(outOfBounds.length > 0 ? { outOfBounds } : {}),
    ...(rec.bashCommands.length > 0 ? { bashCommands: rec.bashCommands } : {}),
  };
}

/**
 * 内核子代理执行口（M4.5 T1：开子会话 + 跑对话循环 + 取结论）。
 * 会话文件落主会话文件夹（决策 19：树扫描天然免疫——scanBucketSessions 不递归）；
 * 工具面 = 主对话活工具抄一份（到顶剥派活类 + 按工种减）+ 写记账皮；审批走子代理独立 bus 接回主关卡。
 * 写协调闸（决策 24）一 harness 一实例——主对话写预约经 harness 挂主 bus 检查（gate 出口透出）。
 */
export function createSubagentRunner(deps: SubagentDeps): SubagentPort & { gate: WriteGate } {
  const takenIds = new Set<string>();
  const gate = createWriteGate(deps.cwd);

  const agentsDirOf = (): string => join(deps.sessionsDir, deps.mainStore.sessionId, "agents");

  const runOne = async (
    req: SubagentSpawnRequest,
    id: string,
    depth: 1 | 2,
    parentAgentId: string | undefined,
    callerSignal: AbortSignal | undefined,
  ): Promise<SubagentOutcome> => {
    const agentsDir = agentsDirOf();
    const agentSid = `agents_${id}`;
    const agentStore = deps.makeStore(agentSid, agentsDir);
    const spillDir = join(agentsDir, agentSid, "spill"); // 显式传——默认拼装 join(sessionsDir, sid, "spill") 会落错位（harness.ts spill 同款坑）
    const maxTurns = Math.min(req.maxTurns ?? SUBAGENT_MAX_TURNS, SUBAGENT_MAX_TURNS);
    const approvalMode = await resolveApprovalMode(deps); // spawn 时定格（决策 3 第一层）
    const records: WriteRecords = { actual: new Set(), attempts: new Set(), bashCommands: [] };
    let declaredPaths: string[] | undefined;
    // 同血缘判定（决策 24②快败）：父代理编号（两层内先代只有父）
    const ancestors = parentAgentId !== undefined ? [parentAgentId] : [];
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

    // 带聊天记录开局（决策 6）：forkFrom 字符串 = 精确分叉点（在主会话投影内才合法——照 sessionForkFn
    // 严校验；ForkedSessionStore 的「找不到 → 全量前缀」宽松降级只属盘上链重建，不属活 API）；
    // true = 到当前末尾（模块侧拿不到事件 id，内核解析尾部）。坏参数 = 拒绝（单子从未开跑），不走带内 failed。
    let forkAt: string | undefined;
    if (req.forkFrom !== undefined && req.forkFrom !== false) {
      const parentEvents = await deps.mainStore.all();
      if (req.forkFrom === true) {
        forkAt = parentEvents.at(-1)?.id; // 主会话还没有任何消息 = 没什么可带，退空白开局
      } else if (!parentEvents.some((e) => e.id === req.forkFrom)) {
        throw new Error(`forkFrom 分叉点不在主会话投影内：${req.forkFrom}`);
      } else {
        forkAt = req.forkFrom;
      }
    }

    try {
      await agentStore.append(LOG_TYPES.sessionHeader, {
        format: 1,
        cwd: deps.cwd,
        parentSession: parentAgentId !== undefined ? `agents_${parentAgentId}` : deps.mainStore.sessionId, // 亲缘：孙代理挂父代理会话、子代理挂主会话（决策 19 同册同理）
      });
      // forkFrom 已在上文预检（尾部解析或精确 id 校验）；own 文件记分叉点，复合投影经 ForkedSessionStore 拼装
      let forkSession: SessionStore = agentStore;
      if (forkAt !== undefined) {
        await agentStore.append(LOG_TYPES.sessionFork, { sourceEntryId: forkAt, parentSession: deps.mainStore.sessionId });
        forkSession = new ForkedSessionStore({ parent: deps.mainStore, atEntryId: forkAt, own: agentStore });
      }
      await agentStore.append(LOG_TYPES.userMessage, { content: [{ kind: "text", text: req.prompt }] });

      const resolved = resolveAgentModel(deps, req);
      // 工具面：抄主对话活工具（墓碑不复活——toolInfos 名单 ∩ list）→ 到顶剥派活类（决策 4①）
      // → 按工种减（只能减不能加——allowedTools 里的未知名静默无效）→ 再减黑名单
      // → 全员包写记账皮（决策 24⑤：实际写/被拦尝试/bash 命令串——回执的取数口径）
      const liveNames = new Set(deps.graph().tools.toolInfos().map((t) => t.name));
      const allowed = req.allowedTools !== undefined ? new Set(req.allowedTools) : undefined;
      const disallowed = req.disallowedTools !== undefined ? new Set(req.disallowedTools) : undefined;
      const bus = createEventBus(deps.sink); // 子代理独立 bus：steering/followUp 不串主对话
      const tools = createToolRegistry({ bus, sink: deps.sink, spillDir });
      // 写报备归一（决策 24①）：禁通配符、限项目内、大小写折叠——报备失败 = 单子拒绝（模糊报备等于没有报备）
      if (req.writePaths !== undefined) {
        const norm = req.writePaths.map((p) => normalizeClaimPath(deps.cwd, p));
        const bad = norm.find((n) => !n.ok);
        if (bad !== undefined) throw new Error((bad as { ok: false; error: string }).error);
        declaredPaths = norm.map((n) => (n as { ok: true; path: string }).path);
      }
      const faceNames = new Set<string>();
      for (const t of deps.graph().tools.list().filter((t2) => liveNames.has(t2.name))) {
        if (isSpawnClassTool(t.name) && !spawnAllowedAtDepth(depth)) continue; // 到顶剥（决策 4①）——模型看不见就不会浪费一轮
        if (allowed !== undefined && !allowed.has(t.name)) continue;
        if (disallowed !== undefined && disallowed.has(t.name)) continue;
        faceNames.add(t.name);
        tools.register(wrapForWriteReceipt(t, declaredPaths, records, deps.cwd), t.name.split("__")[0]!);
      }
      // 写协调闸（决策 24②）：先报备归一——报备了的按路径占闸；没报备但工具面含会写的（bash/写工具）
      // = 算整仓（保守排队，③）；纯只读代理不占闸。同血缘撞车快败在闸内判定。等待期间不撒手（并发位纪律在调用方）。
      const wholeRepo = declaredPaths === undefined && [...faceNames].some((n) => WRITE_CAPABLE_TOOLS.has(n));
      await gate.acquire(id, { paths: declaredPaths ?? [], wholeRepo }, ancestors);
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
          subagent: { agentId: id, depth, parentId: parentAgentId, background: req.background === true, label: req.label },
        });
        return veto ?? undefined;
      }, `subagent:${id}`); // owner 记子代理身份——诊断日志可辨来源

      for await (const e of agentLoop({
        session: forkSession, // 带历史开局 = 复合投影（父前缀 + own 追加）；空白开局 = 纯 own
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
      gate.release(id); // 闸随持闸者结束释放（决策 24②：完成/失败/被停都算——被停占闸不放就是另一种死锁）
      await agentStore.flush().catch(() => undefined);
      await agentStore.close().catch(() => undefined);
    }

    // 越界回执（决策 24⑤）：实际写/被拦尝试 ∉ 报备 → 列入（宿主自己记的，模型伪造不了）；bash 命令串备查
    const receipt = buildReceipt(records, declaredPaths, deps.cwd);
    const conclusion = lastText.slice(-SUBAGENT_CONCLUSION_TAIL); // 保尾（决策 10）
    if (endKind === "completed" && !abortedByCap()) {
      return { id, status: "completed", turns, conclusion, ...receipt };
    }
    const error =
      endKind === "interrupted"
        ? abortedByCap() ? `已达轮数上限 ${maxTurns}，结论为最后回复` : "已被取消（子代理被停止）"
        : endError ?? "子代理执行失败";
    return { id, status: "failed", turns, conclusion, error, ...receipt };
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
      return execContext.run({ agentId: id, depth }, () => runOne(req, id, depth, ctx?.agentId, caller?.signal));
    },
    list(): SubagentRosterEntry[] {
      return []; // 花名册在 M4.5 T8 落地（子+孙同册、保留 32 条已结束）
    },
    stop(): boolean {
      return false; // 停止口在 M4.5 T8 落地
    },
    gate, // 写协调闸出口（M4.5 T7——harness 挂主对话写预约检查用）
  };
}
