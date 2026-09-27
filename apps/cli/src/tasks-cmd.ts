import { readFileSync } from "node:fs";
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
export function renderAgentView(entry: SubagentRosterEntry, events: readonly { type: string; [k: string]: unknown }[], width = 78): string {
  const dm = new DocModel();
  dm.historyFrom([...events], width);
  const stat =
    `${STATUS_TEXT[entry.status]}${entry.pendingApproval !== undefined ? " · 等审批" : ""} · ${entry.turns} 轮` +
    (entry.error !== undefined ? ` · ${(entry.error.split("\n")[0] ?? "").slice(0, 60)}` : "");
  const head = theme.fg(STATUS_COLOR[entry.status], `状态：${stat}${entry.roleName !== undefined ? ` · 工种 ${entry.roleName}` : ""}${entry.background ? " · 后台" : ""}`);
  return [head, ...dm.frameLines(width)].join("\n");
}
