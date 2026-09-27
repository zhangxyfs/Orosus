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
import { SUBAGENT_CONCLUSION_TAIL, SUBAGENT_CONCURRENCY, SUBAGENT_ID_LEN, SUBAGENT_MAX_TURNS, SUBAGENT_ROSTER_KEEP } from "./constants.ts";
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
  /** 后台单子收场送回（M4.5 T9/决策 17）：harness 侧积压 + 闲时自动送回轮；缺省不装（测试/无头不送）。 */
  onBackgroundDelivery?: (line: string) => void;
  /** 思考档位解析（M4.5 / 2026-09-27：子代理跟随 /effort 档——agent 组行显示 <思考> 段）；缺省不带。 */
  resolveEffort?: () => Promise<string | undefined>;
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

/** 花名册条目（内核态——决策 19/21：子+孙同册；对外快照形态走 SubagentRosterEntry）。 */
interface RosterEntry {
  id: string;
  depth: 1 | 2;
  parentId?: string;
  label: string;
  background: boolean;
  roleName?: string;
  model?: string;
  status: "queued" | "running" | "completed" | "failed";
  turns: number;
  enqueuedAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  conclusion?: string;
  outOfBounds?: string[];
  bashCommands?: string[];
  pendingApproval?: { callId: string; tool: string; reason: string; resolve: (allow: boolean) => void } | undefined;
  writeClaim?: { paths: string[]; wholeRepo: boolean };
  controller?: AbortController | undefined;   // running 时在——stop 全停的靶
  cancel?: (() => void) | undefined;           // 各等待阶段的取消口（并发位排队/写闸排队/审批挂起）
  usageTotal?: { input: number; output: number }; // 词元累计（结束记主会话账）
  toolCalls?: number;                          // 已发出的工具调用数（agent 组行显示）
  effort?: string;                             // 思考档位（跟随 /effort 解析）
}

/**
 * 内核子代理执行口（M4.5 T1：开子会话 + 跑对话循环 + 取结论）。
 * 会话文件落主会话文件夹（决策 19：树扫描天然免疫——scanBucketSessions 不递归）；
 * 工具面 = 主对话活工具抄一份（到顶剥派活类 + 按工种减）+ 写记账皮；审批走子代理独立 bus 接回主关卡。
 * 写协调闸（决策 24）一 harness 一实例——主对话写预约经 harness 挂主 bus 检查（gate 出口透出）。
 * T8：并发位 8（嵌套满载快败）→ 写闸（等待期间位不撒手）→ 跑；花名册同册管子+孙（保留 32 条已结束）；
 * 后台入册即返；stop/会话关闭全停（挂起审批自动回绝）。
 */
export function createSubagentRunner(deps: SubagentDeps): SubagentPort & {
  gate: WriteGate;
  answerApproval: (agentId: string, allow: boolean) => boolean;
  stopAll: () => void;
} {
  const takenIds = new Set<string>();
  const gate = createWriteGate(deps.cwd);
  const roster = new Map<string, RosterEntry>(); // 入队序（孙代理天然紧跟其父之后入册）
  let runningSlots = 0;
  const slotQueue: { agentId: string; enter: () => void; reject: (err: Error) => void }[] = [];

  const agentsDirOf = (): string => join(deps.sessionsDir, deps.mainStore.sessionId, "agents");

  /** 并发位（决策 5：硬上限 8，含前台后台孙代理；排队的先来先服务；嵌套满载立即失败不排队——决策 4③）。 */
  const acquireSlot = (id: string, depth: 1 | 2): Promise<void> => {
    if (runningSlots < SUBAGENT_CONCURRENCY) {
      runningSlots++;
      return Promise.resolve();
    }
    if (depth === 2) {
      return Promise.reject(new Error(`嵌套满载：${SUBAGENT_CONCURRENCY} 个并发位已满——孙代理立即失败不排队（防父子互等槽位，决策 4③）`));
    }
    return new Promise<void>((resolve, reject) => {
      const w = {
        agentId: id,
        enter: () => { runningSlots++; resolve(); },
        reject,
      };
      slotQueue.push(w);
    });
  };
  const releaseSlot = (): void => {
    runningSlots--;
    const next = slotQueue.shift();
    if (next !== undefined) next.enter();
  };

  const snapshotEntry = (e: RosterEntry): SubagentRosterEntry => ({
    id: e.id,
    depth: e.depth,
    ...(e.parentId !== undefined ? { parentId: e.parentId } : {}),
    label: e.label,
    status: e.status,
    background: e.background,
    ...(e.roleName !== undefined ? { roleName: e.roleName } : {}),
    ...(e.model !== undefined ? { model: e.model } : {}),
    turns: e.turns,
    enqueuedAt: e.enqueuedAt,
    ...(e.startedAt !== undefined ? { startedAt: e.startedAt } : {}),
    ...(e.endedAt !== undefined ? { endedAt: e.endedAt } : {}),
    ...(e.error !== undefined ? { error: e.error } : {}),
    ...(e.pendingApproval !== undefined ? { pendingApproval: { callId: e.pendingApproval.callId, tool: e.pendingApproval.tool, reason: e.pendingApproval.reason } } : {}),
    ...(e.writeClaim !== undefined ? { writeClaim: e.writeClaim } : {}),
    ...(e.toolCalls !== undefined ? { toolCalls: e.toolCalls } : {}),
    ...(e.usageTotal !== undefined ? { usage: e.usageTotal } : {}),
    ...(e.effort !== undefined ? { effort: e.effort } : {}),
  });

  /** 在册清单：全部进行中 + 最近 SUBAGENT_ROSTER_KEEP 条已结束（更早只留会话文件——决策 19）。 */
  const listInternal = (): SubagentRosterEntry[] => {
    const active: RosterEntry[] = [];
    const finished: RosterEntry[] = [];
    for (const e of roster.values()) (e.status === "queued" || e.status === "running" ? active : finished).push(e);
    const kept = finished.slice(-SUBAGENT_ROSTER_KEEP);
    return [...active, ...kept].map(snapshotEntry);
  };

  const settle = (entry: RosterEntry, outcome: SubagentOutcome): void => {
    entry.status = outcome.status;
    entry.endedAt = new Date().toISOString();
    entry.conclusion = outcome.conclusion;
    if (outcome.error !== undefined) entry.error = outcome.error;
    if (outcome.outOfBounds !== undefined) entry.outOfBounds = outcome.outOfBounds;
    if (outcome.bashCommands !== undefined) entry.bashCommands = outcome.bashCommands;
    entry.controller = undefined;
    entry.cancel = undefined;
    entry.pendingApproval?.resolve(false); // 兜底（正常路径已清）
    entry.pendingApproval = undefined;
    // 词元记主会话账上（设计空白口径）：不入模型投影（deriveMessages 不识此类型），只进统计
    if (entry.usageTotal !== undefined) {
      deps.mainStore.append(LOG_TYPES.subagentUsage, { agentId: entry.id, usage: entry.usageTotal }).catch(() => undefined);
    }
    // 送回行（决策 17 + 设计空白文案）：[非用户输入] 头防伪装；结论/错误取首行；失败单子也送（用户须知）
    if (entry.background && deps.onBackgroundDelivery !== undefined) {
      const firstLine = (outcome.conclusion !== "" ? outcome.conclusion : outcome.error ?? "").split("\n")[0]!.slice(0, 200);
      const verdict = outcome.status === "completed" ? "完成" : "失败";
      deps.onBackgroundDelivery(`[非用户输入] 后台子代理 ${entry.label} ${verdict}：${firstLine}`);
    }
  };

  const runOne = async (
    req: SubagentSpawnRequest,
    id: string,
    depth: 1 | 2,
    parentAgentId: string | undefined,
    callerSignal: AbortSignal | undefined,
    entry: RosterEntry,
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
    entry.controller = controller;
    entry.cancel = () => controller.abort(); // running 阶段的取消口（排队阶段由 spawn 编排层覆写）
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
      // 纯只读代理不占闸（空报备 + 非整仓）：不排队、不冲突、不受同血缘快败——「改派只读孙代理」的正解形态
      const holdsGate = wholeRepo || (declaredPaths ?? []).length > 0;
      if (holdsGate) {
        entry.writeClaim = { paths: declaredPaths ?? [], wholeRepo };
        await gate.acquire(id, { paths: declaredPaths ?? [], wholeRepo }, ancestors);
      }
      // 审批关卡（决策 3 第二层，T2）：agent bus 的 toolPreExecute → 运行时双层门控第二道（决策 4②）
      // + 模式分流——auto 照单放行；ask 转发主对话关卡（带 ask-risky 档提示与子代理身份，主对话在问时弹串行队列）。
      // 后台 Ask 档的询问走 park（挂起不抢占——花名册记 pendingApproval，宿主有空再批；被停自动按拒绝收场）。
      bus.on(CORE_POINTS.toolPreExecute, async (payload) => {
        const p = payload as { name: string; callId: string; [k: string]: unknown };
        if (isSpawnClassTool(p.name) && !spawnAllowedAtDepth(depth)) {
          return { deny: true, reason: "嵌套已达两层上限——孙代理不能再派子代理（决策 4）" };
        }
        if (approvalMode === "auto") return undefined; // 从不询问：不过主关卡
        const background = req.background === true;
        const park = background
          ? (info: { tool: string; reason: string }): Promise<boolean> => new Promise((resolve) => {
              entry.pendingApproval = {
                callId: String(p.callId),
                tool: info.tool,
                reason: info.reason,
                resolve: (allow) => { entry.pendingApproval = undefined; resolve(allow); },
              };
            })
          : undefined; // 前台：照常弹在主界面串行审批队列（主关卡 ctx.ui 直问）
        const veto = await deps.graph().bus.waterfall(CORE_POINTS.toolPreExecute, {
          ...p,
          mode: "ask-risky", // 需要时候询问（决策 3：AWN 档语义——主对话更严档不放宽到此档之下）
          subagent: { agentId: id, depth, parentId: parentAgentId, background, label: req.label, ...(park !== undefined ? { park } : {}) },
        });
        return veto ?? undefined;
      }, `subagent:${id}`); // owner 记子代理身份——诊断日志可辨来源

      // 思考档位（2026-09-27）：子代理跟随 /effort 解析（与主对话同链）；记册供 agent 组行显示
      const effort = deps.resolveEffort !== undefined ? await deps.resolveEffort() : undefined;
      if (effort !== undefined) entry.effort = effort;
      for await (const e of agentLoop({
        session: forkSession, // 带历史开局 = 复合投影（父前缀 + own 追加）；空白开局 = 纯 own
        bus,
        tools,
        provider: resolved.stream,
        model: resolved.model,
        system: buildSystemPrompt(req),
        ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        signal: controller.signal,
        sink: deps.sink,
      })) {
        if (e.type === LOG_TYPES.toolCall) {
          entry.toolCalls = (entry.toolCalls ?? 0) + 1;
        } else if (e.type === LOG_TYPES.turnStep) {
          turns++;
          entry.turns = turns;
          if (abortedByCap()) controller.abort(); // 轮数保险丝（决策 10）：到顶即停，结论取最后回复
        } else if (e.type === LOG_TYPES.assistantMessage) {
          const t = textOf(e);
          if (t !== "") lastText = t;
          const u = (e as { usage?: { input: number; output: number } }).usage;
          if (u !== undefined) {
            entry.usageTotal = { input: (entry.usageTotal?.input ?? 0) + u.input, output: (entry.usageTotal?.output ?? 0) + u.output };
          }
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
      // 坏参数 = 拒绝（单子从未开跑、不入册）：forkFrom 分叉点与写报备归一都在编排前校验（runOne 内同款校验兜底）
      if (typeof req.forkFrom === "string") {
        const parentEvents = await deps.mainStore.all();
        if (!parentEvents.some((e) => e.id === req.forkFrom)) {
          throw new Error(`forkFrom 分叉点不在主会话投影内：${req.forkFrom}`);
        }
      }
      if (req.writePaths !== undefined) {
        for (const p of req.writePaths) {
          const n = normalizeClaimPath(deps.cwd, p);
          if (!n.ok) throw new Error(n.error);
        }
      }
      const id = allocId(takenIds, agentsDirOf());
      const entry: RosterEntry = {
        id, depth,
        ...(ctx !== undefined ? { parentId: ctx.agentId } : {}),
        label: req.label,
        background: req.background === true,
        ...(req.roleName !== undefined ? { roleName: req.roleName } : {}),
        status: "queued",
        turns: 0,
        enqueuedAt: new Date().toISOString(),
      };
      roster.set(id, entry);

      // 单子全流程：并发位（嵌套满载快败）→ 写闸（等待期间位不撒手——先占 8 位之一再排闸）→ 跑 → 记册
      const run = async (): Promise<SubagentOutcome> => {
        await acquireSlot(id, depth); // 排队期被停 = reject（编排层统一 settle）
        entry.status = "running";
        entry.startedAt = new Date().toISOString();
        try {
          return await execContext.run({ agentId: id, depth }, () => runOne(req, id, depth, ctx?.agentId, caller?.signal, entry));
        } finally {
          releaseSlot();
        }
      };

      if (req.background === true) {
        // 后台：入册即返编号（决策 12——拿到编号继续聊）；结论经送回缝进对话（T9），出错不静默——记册 + 诊断日志
        void run().then(
          (outcome) => settle(entry, outcome),
          (err) => settle(entry, { id, status: "failed", turns: entry.turns, conclusion: "", error: err instanceof Error ? err.message : String(err) }),
        );
        return { id };
      }
      try {
        const outcome = await run();
        settle(entry, outcome);
        return outcome;
      } catch (err) {
        // runOne 的错误已带内化为 failed outcome；这里只剩编排层拒绝（并发位/排队被停）——转 outcome 给工具层
        const outcome: SubagentOutcome = { id, status: "failed", turns: entry.turns, conclusion: "", error: err instanceof Error ? err.message : String(err) };
        settle(entry, outcome);
        return outcome;
      }
    },
    list: listInternal,
    stop(id) {
      const entry = roster.get(id);
      if (entry === undefined || entry.status === "completed" || entry.status === "failed") return false;
      entry.pendingApproval?.resolve(false); // 未答审批自动按「拒绝」收场（决策 3/12——绝不卡死）
      entry.pendingApproval = undefined;
      if (entry.status === "queued") {
        // 排队中（并发位或写闸）：并发位队列直接移出拒绝；写闸队列走 gate.release 的 reject 路径。
        // settle 由编排层的拒绝路径统一做（这里不直接收场——防双记账）。
        const idx = slotQueue.findIndex((w) => w.agentId === id);
        if (idx >= 0) {
          const w = slotQueue.splice(idx, 1)[0]!;
          w.reject(new Error("已被停止——排队中的单子按失败收场"));
          return true;
        }
        gate.release(id); // 写闸排队者：reject → runOne catch → failed outcome → settle
        entry.cancel?.();
        return true;
      }
      entry.cancel?.(); // running：打断循环 → interrupted → failed outcome → settle
      return true;
    },
    gate, // 写协调闸出口（M4.5 T7——harness 挂主对话写预约检查用）
    answerApproval(agentId, allow) {
      const entry = roster.get(agentId);
      if (entry === undefined || entry.pendingApproval === undefined) return false;
      entry.pendingApproval.resolve(allow);
      return true;
    },
    stopAll() {
      // 会话关闭全停（决策 12）：在跑/排队/挂起审批全部收场——挂起审批按拒绝，绝不留活口
      for (const entry of roster.values()) {
        if (entry.status === "completed" || entry.status === "failed") continue;
        this.stop(entry.id);
      }
    },
  };
}
