import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import * as theme from "./theme.ts";
import { stripAnsi } from "./tui/width.ts";
import { DocModel } from "./tui/docmodel.ts";
import { SPIN_FRAMES } from "./tui/fullapp.ts";
import type { SubagentRosterEntry } from "@orosus/contracts/module";
import { ESC_CANCELLED } from "./i18n/protocol-strings.ts";
import { t } from "./i18n/app.ts";

/**
 * /tasks 命令与全屏查看窗（M4.5 T11 / 决策 21/22）：
 * 列表格式（用户拍板）：`[子代理] <编号> <简述> · <状态>`、`[孙代理] <父编号> - <孙编号> <简述> · <状态>`——
 * 孙行紧跟父行；三色（运行中绿 / 已完成灰 / 失败红，被停算失败）；等审批标注。
 * 查看窗：顶栏（编号+标题+状态）+ 消息流（DocModel 主窗口同款渲染）；实时保留最近 500 条动态。
 */

/** 查看窗消息流保留量（设计空白：最近 500 条动态，更早去会话文件翻）。 */
const VIEW_EVENT_KEEP = 500;

const STATUS_TEXT: Record<SubagentRosterEntry["status"], string> = {
  queued: t("sub.status.queued"),
  running: t("sub.status.running"),
  completed: t("tasks.status.completed"),
  failed: t("sub.status.failed"),
};
const STATUS_COLOR: Record<SubagentRosterEntry["status"], Parameters<typeof theme.fg>[0]> = {
  queued: "accent",
  running: "accent",
  completed: "muted",
  failed: "err",
};

/** 列表行拼装：亲缘分组（孙行紧跟父行——快照的入队序已保证，孤儿孙顶层补位）+ 等审批标注 + 三色。 */
export function tasksListRows(entries: readonly SubagentRosterEntry[]): string[] {
  const rows: string[] = [];
  const emit = (e: SubagentRosterEntry): void => {
    const rel = e.depth === 2 ? `${e.parentId} - ${e.id}` : e.id;
    const stat = t(`sub.status.${e.status}`, undefined, STATUS_TEXT[e.status]) + (e.pendingApproval !== undefined ? ` ${t("tasks.tag.pendingApproval")}` : "") + (e.background ? ` ${t("tasks.tag.background")}` : "");
    const line = `${e.depth === 2 ? t("tasks.tag.grandchild") : t("tasks.tag.child")} ${rel} ${e.label} · ${stat}`;
    rows.push(theme.fg(STATUS_COLOR[e.status], line));
  };
  for (const parent of entries.filter((e) => e.depth === 1)) {
    emit(parent);
    for (const child of entries.filter((e) => e.depth === 2 && e.parentId === parent.id)) emit(child);
  }
  for (const orphan of entries.filter((e) => e.depth === 2 && !entries.some((p) => p.id === e.parentId))) emit(orphan);
  return rows;
}

/** 空册占位行（用户拍板：/tasks 无条件开列表——空态也开，占位行说明怎么派活）。 */
export function emptyTasksRow(): string {
  return theme.dim(t("tasks.empty"));
}

/** 卸载 tool-subagent 的守卫（2026-09-27 用户拍板）：有在跑/排队/挂审批的子代理不许卸——
 *  内核 runner 不随模块卸载死，但派活工具面会消失，在跑的单子就没人派得出停工具、模型也管不着了。
 *  拦下并指路（/tasks 逐个停或双击 Esc 全停）；空闲册（含已结束保留条目）不拦。 */
export function subagentUnloadBlock(entries: readonly SubagentRosterEntry[]): string | undefined {
  const active = entries.filter((e) => e.status === "queued" || e.status === "running");
  if (active.length === 0) return undefined;
  const pending = active.filter((e) => e.pendingApproval !== undefined).length;
  return t("tasks.unloadBlocked", { n: active.length, m: pending > 0 ? pending : undefined });
}

/** 行选中解析：彩色行 → 编号（choose 回串解析用）。 */
export function taskIdOfRow(row: string): string | undefined {
  const m = /\] (?:[0-9a-f]{8} - )?([0-9a-f]{8}) /.exec(stripAnsi(row));
  return m?.[1];
}

/** 读子代理会话文件事件（末 VIEW_EVENT_KEEP 条）：路径形状 <桶>/<主sid>/agents/agents_<编号>/agents/session.jsonl。 */
export function agentEventsFromFile(sessionsDir: string, mainSid: string, id: string): { type: string; [k: string]: unknown }[] {
  const file = join(sessionsDir, mainSid, "agents", `agents_${id}`, "agents", "session.jsonl");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events = raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
  return events.slice(-VIEW_EVENT_KEEP);
}

/** 查看窗文本：顶栏状态行 + 消息流回放（DocModel 主窗口同款渲染——跑完的结论就是流的末条）。 */
// width = 折行列宽：宿主（main.ts openTasks）传「终端宽 − 盒框 4 列」——查看窗全屏时折行跟全窗口走；
// 78 只是纯函数/行模式的缺省口径。
// fold（走查④，2026-09-29）：查看窗内容快捷键与主窗一致——Alt+E/O/F 的折叠态由查看窗 keys
// 持有（闭包跨 live 刷新保持），渲染侧只是把三态设进一次性 DocModel（主窗同款折叠语义零新逻辑）。
export interface AgentViewFoldState {
	thinkOpen: boolean;
	toolOpen: boolean;
	errOpen: boolean;
}

export function renderAgentView(entry: SubagentRosterEntry, events: readonly { type: string; [k: string]: unknown }[], width = 78, fold: AgentViewFoldState = { thinkOpen: false, toolOpen: false, errOpen: false }): string {
  const dm = new DocModel();
  dm.thinkOpen = fold.thinkOpen;
  dm.toolOpen = fold.toolOpen;
  dm.errOpen = fold.errOpen;
  dm.historyFrom([...events], width);
  const stat = t("agentview.stat", { status: t(`sub.status.${entry.status}`, undefined, STATUS_TEXT[entry.status]), approval: entry.pendingApproval !== undefined ? "1" : undefined, n: entry.turns, err: entry.error !== undefined ? (entry.error.split("\n")[0] ?? "").slice(0, 60) : undefined });
  const head = theme.fg(STATUS_COLOR[entry.status], t("agentview.head", { stat, role: entry.roleName, background: entry.background ? "1" : undefined }));
  // 生成中尾行（2026-10-01 走查④拍板）：运行/排队态在内容末尾挂「⠸ 正在生成…」——与主窗 tailLine
  // 同形。帧号取系统时钟秒位（live 刷新 1s tick 一帧——主窗 busyTimer 100ms 不共用：这里每帧重读
  // 子代理会话文件，1s 是文件重读成本的既定节拍）。配合查看窗 pinned 贴底，此行恒在窗口底部可见。
  const busy = entry.status === "queued" || entry.status === "running";
  const frame = SPIN_FRAMES[Math.floor(Date.now() / 1000) % SPIN_FRAMES.length]!;
  const tail = busy ? theme.fg("accent", frame) + " " + theme.fg("muted", t("tasks.view.generating")) : "";
  return [head, ...dm.frameLines(width), ...(tail !== "" ? [tail] : "")].join("\n");
}

/**
 * 查看窗增量渲染器（m5-agentview-perf T2）：把「每帧全量读盘 + 全量 JSON 解析 + 新建 DocModel 回放」
 * 换成「文件没变不重读、变了只解析新增行、喂给常驻模型」——每帧成本从随总输出线性降到只跟新增量
 * 相关（旧条目折行缓存挂条目跨帧复用，主窗同款收益）。文件判据 = mtime+size 双判（D2）；续读首行
 * 解析失败或偏移越界 → 全量重建（D3，防文件被重写/轮转）；首屏锚定末 VIEW_EVENT_KEEP 条、之后
 * 新增全收（D4）；不启用轮次裁剪/远区淘汰（D5）；折叠切换只击穿折叠类条目缓存（D6——DocModel
 * 条目缓存键含折叠态，设字段自动失效）。
 */
export interface AgentViewIO {
  /** 文件元信息；文件不存在返回 undefined（真盘实现 statSync 包 try）。 */
  stat(file: string): { mtimeMs: number; size: number } | undefined;
  /** 从字节偏移读到文件尾。offset 恒落在已消费的完整行边界上（renderer 只按完整行推进）。 */
  readFrom(file: string, offset: number): string;
}

export interface AgentViewRenderer {
  /** 全量文本（状态行 + 消息流 + 生成中尾行——与 renderAgentView 同形）。 */
  render(width: number): string;
  /** 折叠键切换（Alt+E/O/F）：改常驻模型折叠字段，条目缓存按折叠态自动击穿（D6）。 */
  setFold(patch: Partial<AgentViewFoldState>): void;
  /** 测试观察口：JSON.parse 累计次数（「只解析新增行」断言——debugWrapCalls 先例同款）。 */
  readonly parseCount: number;
  /** 测试观察口：readFrom 累计调用次数（「未变不重读」断言）。 */
  readonly readCount: number;
}

/** 真盘 IO：statSync 双判元信息 + openSync/readSync 从偏移续读（不全量 readFileSync）。 */
const realAgentViewIO: AgentViewIO = {
  stat: (file) => {
    try {
      const s = statSync(file);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return undefined;
    }
  },
  readFrom: (file, offset) => {
    let fd: number;
    try {
      fd = openSync(file, "r");
    } catch {
      return "";
    }
    try {
      const size = fstatSync(fd).size;
      if (offset >= size) return "";
      const buf = Buffer.alloc(size - offset);
      let read = 0;
      while (read < buf.length) {
        const n = readSync(fd, buf, read, buf.length - read, offset + read);
        if (n <= 0) break;
        read += n;
      }
      return buf.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  },
};

export function createAgentViewRenderer(
  sessionsDir: string,
  entry: SubagentRosterEntry,
  readEntry: () => SubagentRosterEntry,
  locate: () => { sid: string; id: string },
  opts?: { io?: AgentViewIO; now?: () => number },
): AgentViewRenderer {
  const io = opts?.io ?? realAgentViewIO;
  const now = opts?.now ?? Date.now;
  // 常驻模型（含折叠态——setFold 直改；entry 仅首屏快照语义，活体取数走 readEntry）；全量重建换新实例、折叠态随迁
  let dm = new DocModel();
  let fileState: { mtimeMs: number; size: number } | undefined;
  let offset = 0; // 上次消费到的字节偏移（恒在完整行边界）
  let bodyCache: { w: number; lines: string[] } | undefined; // 正文行数组缓存（键含宽度——拖宽不得复用旧折行）
  let parseCount = 0;
  let readCount = 0;

  const rebuildModel = (): void => {
    const fold = { thinkOpen: dm.thinkOpen, toolOpen: dm.toolOpen, errOpen: dm.errOpen };
    dm = new DocModel();
    dm.thinkOpen = fold.thinkOpen;
    dm.toolOpen = fold.toolOpen;
    dm.errOpen = fold.errOpen;
  };

  const fullRebuild = (file: string, width: number): void => {
    const raw = io.readFrom(file, 0);
    readCount++;
    const events: { type: string; [k: string]: unknown }[] = [];
    for (const l of raw.split("\n")) {
      if (l.trim() === "") continue;
      events.push(JSON.parse(l) as { type: string; [k: string]: unknown }); // 坏行抛错 = agentEventsFromFile 同语义
      parseCount++;
    }
    rebuildModel();
    dm.historyFrom(events.slice(-VIEW_EVENT_KEEP), width); // D4：首屏锚定末 500 条
    offset = Buffer.byteLength(raw, "utf8"); // 全消费（含尾部残段——与旧全量读同口径）
    bodyCache = undefined;
  };

  const render = (width: number): string => {
    const { sid, id } = locate();
    const file = join(sessionsDir, sid, "agents", `agents_${id}`, "agents", "session.jsonl");
    const st = io.stat(file);
    if (st === undefined) {
      // 文件缺失 = 空流（agentEventsFromFile catch 同语义）；清态，文件再出现时走全量重建
      if (fileState !== undefined) {
        rebuildModel();
        offset = 0;
        bodyCache = undefined;
      }
      fileState = undefined;
    } else if (fileState === undefined || st.mtimeMs !== fileState.mtimeMs || st.size !== fileState.size) {
      if (fileState !== undefined && offset > 0 && st.size >= offset) {
        // 增量：从上次偏移续读，只解析新增完整行；尾段无 \n 收尾 = 写入中的半行，不消费等下一帧
        const chunk = io.readFrom(file, offset);
        readCount++;
        const parts = chunk.split("\n");
        const tail = parts.pop() ?? ""; // chunk 以 \n 收尾时为 ""
        const parsed: { type: string; [k: string]: unknown }[] = [];
        let ok = true;
        for (const l of parts) {
          if (l.trim() === "") continue;
          try {
            parsed.push(JSON.parse(l) as { type: string; [k: string]: unknown });
            parseCount++;
          } catch {
            ok = false; // D3：续读首行不是完整行（文件被重写、偏移落在行中间）→ 全量重建
            break;
          }
        }
        if (ok) {
          if (parsed.length > 0) dm.historyFrom(parsed, width);
          offset += Buffer.byteLength(chunk.slice(0, chunk.length - tail.length), "utf8");
          bodyCache = undefined;
        } else {
          fullRebuild(file, width);
        }
      } else {
        fullRebuild(file, width); // 首见 / 偏移越界（文件重写变小——D3）
      }
      fileState = st;
    }
    if (bodyCache === undefined || bodyCache.w !== width) {
      bodyCache = { w: width, lines: dm.frameLines(width) };
    }
    // 活体行现算（首屏后冻结即 bug——状态行/尾行每帧取 readEntry 最新态 + 秒位帧号）
    const e = readEntry();
    const stat = t("agentview.stat", { status: t(`sub.status.${e.status}`, undefined, STATUS_TEXT[e.status]), approval: e.pendingApproval !== undefined ? "1" : undefined, n: e.turns, err: e.error !== undefined ? (e.error.split("\n")[0] ?? "").slice(0, 60) : undefined });
    const head = theme.fg(STATUS_COLOR[e.status], t("agentview.head", { stat, role: e.roleName, background: e.background ? "1" : undefined }));
    const busy = e.status === "queued" || e.status === "running";
    const frame = SPIN_FRAMES[Math.floor(now() / 1000) % SPIN_FRAMES.length]!;
    const tail = busy ? theme.fg("accent", frame) + " " + theme.fg("muted", t("tasks.view.generating")) : "";
    return [head, ...bodyCache.lines, ...(tail !== "" ? [tail] : "")].join("\n");
  };

  return {
    render,
    setFold: (patch) => {
      if (patch.thinkOpen !== undefined) dm.thinkOpen = patch.thinkOpen;
      if (patch.toolOpen !== undefined) dm.toolOpen = patch.toolOpen;
      if (patch.errOpen !== undefined) dm.errOpen = patch.errOpen;
      bodyCache = undefined; // 行数组重算一次（折叠类条目缓存按折叠态自动击穿——D6）
    },
    get parseCount() { return parseCount; },
    get readCount() { return readCount; },
  };
}

/**
 * 历史子代理名册（2026-09-27 用户拍板：不删旧数据就得能查看——/tasks 列出盘上历史，最新在最上）。
 * 从主会话文件夹的 agents/ 目录重建：状态/轮数/工具调用/词元/起止时间取自各子代理会话文件；
 * 简述/后台/工种取自主会话文件里 spawn 工具调用的参数（callId 配对结果文本中的 8 位编号）。
 * 一期口径注记：状态按最后 turn/end 推断（completed→已完成，其余→失败）——截断收尾（撞限/超时）
 * 在旧文件里同为 interrupted，归入失败；新单子由活名册展示（带 truncated 标注），不在此纠偏。
 */
export function loadHistoricalSubagents(sessionsDir: string, mainSid: string): SubagentRosterEntry[] {
  const agentsDir = join(sessionsDir, mainSid, "agents");
  let dirs: string[];
  try {
    dirs = readdirSync(agentsDir).filter((d) => /^agents_[0-9a-f]{8}$/.test(d));
  } catch {
    return [];
  }
  const meta = spawnMetaFromMainSession(sessionsDir, mainSid);
  const out: SubagentRosterEntry[] = [];
  for (const d of dirs) {
    const id = d.slice("agents_".length);
    let events: { type: string; ts?: string; [k: string]: unknown }[];
    try {
      events = readFileSync(join(agentsDir, d, "agents", "session.jsonl"), "utf8")
        .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { type: string; ts?: string });
    } catch {
      continue;
    }
    if (events.length === 0) continue;
    const header = events[0] as { parentSession?: string };
    const steps = events.filter((e) => e.type === "turn/step").length;
    const toolCalls = events.filter((e) => e.type === "tool/call").length;
    const lastEnd = [...events].reverse().find((e) => e.type === "turn/end") as { kind?: string } | undefined;
    const status: SubagentRosterEntry["status"] = lastEnd?.kind === "completed" ? "completed" : "failed";
    const usage = events.reduce(
      (acc, e) => {
        const u = (e as { usage?: { input?: number; output?: number } }).usage;
        return u === undefined ? acc : { input: acc.input + (u.input ?? 0), output: acc.output + (u.output ?? 0) };
      },
      { input: 0, output: 0 },
    );
    const parent = typeof header.parentSession === "string" && header.parentSession.startsWith("agents_")
      ? header.parentSession.slice("agents_".length) : undefined;
    const m = meta.get(id);
    out.push({
      id,
      depth: parent !== undefined ? 2 : 1,
      ...(parent !== undefined ? { parentId: parent } : {}),
      label: m?.label ?? t("tasks.history.label"),
      status,
      background: m?.background ?? false,
      ...(m?.roleName !== undefined ? { roleName: m.roleName } : {}),
      turns: steps,
      ...(toolCalls > 0 ? { toolCalls } : {}),
      ...(usage.input + usage.output > 0 ? { usage } : {}),
      enqueuedAt: events[0]?.ts ?? "",
      ...(events[events.length - 1]?.ts !== undefined ? { endedAt: events[events.length - 1]!.ts } : {}),
    });
  }
  return out;
}

/** spawn 结果文本 → 8 位子代理编号（/tasks 历史重建与 DocModel 回放组共用一口——两处口径必须一致，
 *  否则同一结果抠出的编号集合不同会错挂：前台「- <id> · …」/后台「…：<id>、<id>」两形态都覆盖）。 */
export function spawnIdsIn(output: string): string[] {
  return [...String(output ?? "").matchAll(/[0-9a-f]{8}/g)].map((m) => m[0]!);
}

/** 主会话文件 → spawn 调用元数据（id → 简述/后台/工种）：call 事件记参数、result 事件按 callId 配对，
 *  结果文本里抠 8 位编号（spawnIdsIn 共用口）。 */
function spawnMetaFromMainSession(sessionsDir: string, mainSid: string): Map<string, { label: string; background: boolean; roleName?: string }> {
  let raw: string;
  try {
    raw = readFileSync(join(sessionsDir, mainSid, "agents", "session.jsonl"), "utf8");
  } catch {
    return new Map();
  }
  const calls = new Map<string, { description?: string; background?: boolean; role?: string }>();
  const out = new Map<string, { label: string; background: boolean; roleName?: string }>();
  for (const l of raw.split("\n")) {
    if (l.trim() === "") continue;
    let e: { type?: string; callId?: string; name?: string; args?: Record<string, unknown>; output?: string };
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type === "tool/call" && e.name === "tool-subagent__spawn" && typeof e.callId === "string") {
      const desc = typeof e.args?.description === "string" ? (e.args.description as string) : undefined;
      const role = typeof e.args?.role === "string" ? (e.args.role as string) : undefined;
      calls.set(e.callId, {
        ...(desc !== undefined ? { description: desc } : {}),
        background: e.args?.background === true,
        ...(role !== undefined ? { role } : {}),
      });
    } else if (e.type === "tool/result" && typeof e.callId === "string" && calls.has(e.callId)) {
      const c = calls.get(e.callId)!;
      for (const id of spawnIdsIn(String(e.output ?? ""))) {
        out.set(id, { label: c.description ?? t("tasks.history.label"), background: c.background === true, ...(c.role !== undefined ? { roleName: c.role } : {}) });
      }
    }
  }
  return out;
}

/** /tasks 列表排序（2026-09-27 拍板：最新在最上、第一页永远是最新）：按开跑/入队时间倒序，
 *  活名册与历史名册合并后统一排；孙代理不参与顶层排序（渲染时紧跟父行——决策 21 分组保持）。 */
export function sortNewestFirst(entries: readonly SubagentRosterEntry[]): SubagentRosterEntry[] {
  const t = (e: SubagentRosterEntry): number => {
    const v = Date.parse(e.startedAt ?? e.enqueuedAt);
    return Number.isNaN(v) ? 0 : v;
  };
  return [...entries].sort((a, b) => t(b) - t(a));
}

/** /tasks（M4.5 T11 / 决策 21-22）：子代理任务列表（含孙代理亲缘分组）→ 回车看查看窗 / 应答挂起审批。
 *  全屏走 app.pickOverlay（原生列表弹窗）；行模式走 commandUi.choose（readline）。
 *  2026-09-27 拍板：查看窗 Esc 关闭后回列表页（不是一路关到底）——全屏循环里查看窗之后的
 *  pickOverlay 落 m5 T2 的 FIFO 队列（pendingUi 被查看窗占着），关窗即自动回列表；行模式无弹窗栈，一轮即止。
 *  m5-split-main T10：自 main.ts 归并本件（依赖件五件早已在此）；h/sessionsDir/commandUi/notify 经参数注入（D2）。 */
export const openTasks = async (
  app: import("./tui/fullapp.ts").FullApp | undefined,
  out: (s: string) => void,
  deps: {
    getH: () => import("@orosus/core").Harness;
    sessionsDir: string;
    commandUi: import("@orosus/contracts/module").CommandUi;
    notify: (msg: string) => void;
    /** 测试缝（m5-agentview-perf T3）：注入假盘观察查看窗读盘行为；缺省走真盘 IO。 */
    viewIO?: AgentViewIO;
  },
): Promise<void> => {
	for (;;) {
		// 名册合并（2026-09-27 拍板：不删旧数据就得能查看）：活名册（本进程）∪ 盘上历史（agents/ 目录重建，
		// 简述/后台/工种从主会话 spawn 调用回查），按 id 去重——活名册优先（状态新鲜带 truncated）；
		// 排序最新在最上（用户拍板：第一页永远是最新，上一轮对话的派单自然沉为历史）。每轮现取——
		// 查看窗停留期间状态会变（跑完/新增），回列表该是新鲜册
		const h = deps.getH();
		const live = h.subagents();
		const liveIds = new Set(live.map((e) => e.id));
		const entries = sortNewestFirst([...live, ...loadHistoricalSubagents(deps.sessionsDir, h.sessionId).filter((e) => !liveIds.has(e.id))]);
		// 空册也开列表（用户拍板 2026-09-27：/tasks 无条件开）——占位行说明派活方式，回车无事发生
		const rows = entries.length > 0 ? tasksListRows(entries) : [emptyTasksRow()];
		let idx: number;
		if (app !== undefined) {
			const picked = await app.pickOverlay(t("tasks.title"), rows);
			if (picked === undefined || entries.length === 0) return; // Esc / 空态占位行
			idx = picked;
		} else {
			const picked = await deps.commandUi.choose(t("tasks.title"), rows);
			if (entries.length === 0) return;
			idx = rows.indexOf(picked);
			if (idx < 0) return;
		}
		// 选中行 → 名册条目（CM-02 修复）：rows 经 tasksListRows 亲缘重排（孙行紧跟父行、孤儿孙补位），
		// 显示行下标与 entries（sortNewestFirst 时间序）位次错开——孙代理在场时 entries[idx] 是另一条
		// （选 A 执行 B：查看窗开错会话流、审批答错子代理）。经 taskIdOfRow 从选中行反查编号、再按 id
		// 找真条目（tasks-cmd 既有件，行模式 choose 回串解析同源）。
		const pickedId = taskIdOfRow(rows[idx]!);
		const entry = pickedId === undefined ? undefined : entries.find((e) => e.id === pickedId);
		if (entry === undefined) return; // 行解析不出编号（理论不可达）——安全退出而非错配条目
		// 等审批的行 → 应答（决策 3 第二层「有空再批」的出口；同 commandUi 串行队列）——应答完回列表；
		// 应答菜单的 Esc 不答也不退出（2026-09-28 拍板「Esc 返回上一级」）——回任务列表
		if (entry.pendingApproval !== undefined) {
			try {
				const ans = await deps.commandUi.choose(t("tasks.approval.title", { id: entry.id, label: entry.label, tool: entry.pendingApproval.tool, reason: entry.pendingApproval.reason }), [t("tasks.approval.allow"), t("tasks.approval.deny")]);
				const allow = ans === t("tasks.approval.allow");
				h.answerSubagentApproval(entry.id, allow);
				deps.notify(allow ? t("tasks.approval.allowed", { id: entry.id, tool: entry.pendingApproval.tool }) : t("tasks.approval.denied", { id: entry.id, tool: entry.pendingApproval.tool }));
			} catch (err) {
				if (err instanceof Error && err.message === ESC_CANCELLED) continue; // Esc → 回列表（审批保持挂起）
				throw err;
			}
			continue;
		}
		// 查看窗（决策 22：顶栏 + 消息流主窗口同款渲染；跑着的实时刷）。
		// 折行宽 = 全终端宽 − 盒框 4 列（2026-09-27 拍板：按全窗口大小折行，不是 78 定宽——live 每帧现取，拖宽即时回流）
		const viewW = (): number => Math.max(40, (process.stdout.columns ?? 80) - 4);
		// 内容快捷键与主窗一致（走查④，2026-09-29）：Alt+E/O/F 切查看窗内思考/工具明细/失败体折叠态——
		// 折叠态在闭包（跨 live 刷新保持，每次开窗默认收起与主窗同）；键提示行显示「思考 · 明细 · 失败」
		const fold: AgentViewFoldState = { thinkOpen: false, toolOpen: false, errOpen: false };
		// m5-agentview-perf T3：三路消费（实时刷新 liveView / 首屏 body / 三个折叠键 run）全走增量渲染器——
		// 文件未变不重读、变了只解析新增行、常驻模型折行跨帧复用（旧路 renderNow 每路全量冷算，每帧
		// 随子代理输出线性增长即查看窗卡顿根因）。行模式分支（app === undefined）走同一段，同受益。
		const renderer = createAgentViewRenderer(
			deps.sessionsDir,
			entry,
			() => h.subagents().find((e) => e.id === entry.id) ?? entry, // 活体取数口：状态行/尾行每帧现取最新态
			() => ({ sid: h.sessionId, id: entry.id }),
			deps.viewIO !== undefined ? { io: deps.viewIO } : undefined,
		);
		const liveView = entry.status === "queued" || entry.status === "running" ? () => renderer.render(viewW()) : undefined;
		const body = renderer.render(viewW());
		if (app !== undefined) {
			app.viewText(t("tasks.view.title", { id: entry.id, label: entry.label }), body, {
				layout: "full",
				bottom: true, // 2026-09-27 拍板：全屏 + 自动滚底（实时刷跟随末页）
				...(liveView !== undefined ? { live: liveView } : {}),
				keys: {
					"alt+e": { label: t("tasks.view.keyThink"), run: () => { fold.thinkOpen = !fold.thinkOpen; renderer.setFold(fold); return renderer.render(viewW()); } },
					"alt+o": { label: t("tasks.view.keyTool"), run: () => { fold.toolOpen = !fold.toolOpen; renderer.setFold(fold); return renderer.render(viewW()); } },
					"alt+f": { label: t("sub.status.failed"), run: () => { fold.errOpen = !fold.errOpen; renderer.setFold(fold); return renderer.render(viewW()); } },
				},
			});
			continue; // 查看窗排在 pendingUi——Esc 关窗后队里的列表自动顶上（回列表页拍板）
		}
		out(body);
		return; // 行模式一轮即止（无弹窗栈可回）
	}
};
