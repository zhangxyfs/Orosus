import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as theme from "./theme.ts";
import { stripAnsi } from "./tui/width.ts";
import { DocModel } from "./tui/docmodel.ts";
import type { SubagentRosterEntry } from "@orosus/contracts/module";

/**
 * /tasks 命令与全屏查看窗（M4.5 T11 / 决策 21/22）：
 * 列表格式（用户拍板）：`[子代理] <编号> <简述> · <状态>`、`[孙代理] <父编号> - <孙编号> <简述> · <状态>`——
 * 孙行紧跟父行；三色（运行中绿 / 已完成灰 / 失败红，被停算失败）；等审批标注。
 * 查看窗：顶栏（编号+标题+状态）+ 消息流（DocModel 主窗口同款渲染）；实时保留最近 500 条动态。
 */

/** 查看窗消息流保留量（设计空白：最近 500 条动态，更早去会话文件翻）。 */
const VIEW_EVENT_KEEP = 500;

const STATUS_TEXT: Record<SubagentRosterEntry["status"], string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
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
    const stat = STATUS_TEXT[e.status] + (e.pendingApproval !== undefined ? " · 等审批" : "") + (e.background ? " · 后台" : "");
    const line = `${e.depth === 2 ? "[孙代理]" : "[子代理]"} ${rel} ${e.label} · ${stat}`;
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
  return theme.dim("（暂无在册子代理——对模型说「派个子代理去 …」后这里会列出；后台跑完结论自动送回对话）");
}

/** 卸载 tool-subagent 的守卫（2026-09-27 用户拍板）：有在跑/排队/挂审批的子代理不许卸——
 *  内核 runner 不随模块卸载死，但派活工具面会消失，在跑的单子就没人派得出停工具、模型也管不着了。
 *  拦下并指路（/tasks 逐个停或双击 Esc 全停）；空闲册（含已结束保留条目）不拦。 */
export function subagentUnloadBlock(entries: readonly SubagentRosterEntry[]): string | undefined {
  const active = entries.filter((e) => e.status === "queued" || e.status === "running");
  if (active.length === 0) return undefined;
  const pending = active.filter((e) => e.pendingApproval !== undefined).length;
  return `有 ${active.length} 个子代理在跑${pending > 0 ? `（含 ${pending} 个挂起审批）` : ""}——先停掉再卸载：/tasks 逐个停，或双击 Esc 全停`;
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
export function renderAgentView(entry: SubagentRosterEntry, events: readonly { type: string; [k: string]: unknown }[], width = 78): string {
  const dm = new DocModel();
  dm.historyFrom([...events], width);
  const stat =
    `${STATUS_TEXT[entry.status]}${entry.pendingApproval !== undefined ? " · 等审批" : ""} · ${entry.turns} 轮` +
    (entry.error !== undefined ? ` · ${(entry.error.split("\n")[0] ?? "").slice(0, 60)}` : "");
  const head = theme.fg(STATUS_COLOR[entry.status], `状态：${stat}${entry.roleName !== undefined ? ` · 工种 ${entry.roleName}` : ""}${entry.background ? " · 后台" : ""}`);
  return [head, ...dm.frameLines(width)].join("\n");
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
      label: m?.label ?? "（历史任务）",
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
        out.set(id, { label: c.description ?? "（历史任务）", background: c.background === true, ...(c.role !== undefined ? { roleName: c.role } : {}) });
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
