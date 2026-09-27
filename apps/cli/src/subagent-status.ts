import * as theme from "./theme.ts";
import type { SubagentRosterEntry } from "@orosus/contracts/module";

/**
 * 主窗口子代理状态行（M4.5 T10 / 决策 13：前台实时可见）。
 * 拍板要素（原文未落盘——按要素拟稿，T17 回写请用户复核）：首行 + 子行、完成时带括号统计段、三色
 * （运行中绿 / 已完成灰 / 失败红）。只统计前台（非后台——后台走输入行计数 T13）；空 = 整段消失。
 * 孙代理子行紧跟父行（缩进 └）；已结束的前台单子闪现 10 秒（完成统计段随结果进流区后自灭）。
 */

/** 已结束前台单子的闪现窗口（ms）——结束后状态行短暂保留「已完成/失败（统计段）」再消失。 */
const FINISHED_FLASH_MS = 10_000;

const STATUS_COLOR: Record<SubagentRosterEntry["status"], Parameters<typeof theme.fg>[0]> = {
  queued: "accent",
  running: "accent",
  completed: "muted",
  failed: "err",
};

/** 时长文案（与面板 elapsedText 同口径的简版：秒/分秒/时分）。 */
const durText = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分 ${String(total % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(total / 3600)} 时 ${String(Math.floor(total / 60) % 60).padStart(2, "0")} 分`;
};

const statusText = (e: SubagentRosterEntry): string => {
  if (e.status === "queued") return e.pendingApproval !== undefined ? "排队中 · 等审批" : "排队中";
  if (e.status === "running") return e.pendingApproval !== undefined ? `运行中 ${e.turns} 轮 · 等审批` : `运行中 ${e.turns} 轮`;
  // 完成时带括号统计段（拍板要素）：轮数 + 时长；失败带错误首行
  const dur = durText(Date.parse(e.endedAt ?? e.enqueuedAt) - Date.parse(e.startedAt ?? e.enqueuedAt));
  return e.status === "completed"
    ? `已完成（${e.turns} 轮 · ${dur}）`
    : `失败（${e.turns} 轮 · ${(e.error ?? "未知").split("\n")[0]!.slice(0, 40)}）`;
};

/** 状态行拼装（纯函数）：前台（非后台）在册条目 → 首行/子行；后台条目与过期闪现不出现。 */
export function subagentStatusLines(entries: readonly SubagentRosterEntry[], now: number = Date.now()): string[] {
  const visible = entries.filter((e) => {
    if (e.background) return false; // 后台不进状态行（输入行计数 T13 的口径）
    if (e.status === "completed" || e.status === "failed") {
      return e.endedAt !== undefined && now - Date.parse(e.endedAt) < FINISHED_FLASH_MS; // 闪现窗口
    }
    return true;
  });
  const lines: string[] = [];
  for (const parent of visible.filter((e) => e.depth === 1)) {
    const color = STATUS_COLOR[parent.status];
    lines.push(theme.fg(color, `◆ 子代理 ${parent.id} ${parent.label} · ${statusText(parent)}`));
    for (const child of visible.filter((e) => e.depth === 2 && e.parentId === parent.id)) {
      const ccolor = STATUS_COLOR[child.status];
      lines.push(theme.fg(ccolor, `  └ ${child.id} ${child.label} · ${statusText(child)}`));
    }
  }
  // 孤儿孙代理（父已出闪现窗口）不丢——顶层显示
  for (const orphan of visible.filter((e) => e.depth === 2 && !visible.some((p) => p.id === e.parentId))) {
    const color = STATUS_COLOR[orphan.status];
    lines.push(theme.fg(color, `◆ 孙代理 ${orphan.id} ${orphan.label} · ${statusText(orphan)}`));
  }
  return lines;
}

/** 输入行计数口径（M4.5 T13 / 设计空白）：只统计后台运行中——前台走状态行（T10）、排队不算「正在执行」。 */
export function backgroundRunningCount(entries: readonly SubagentRosterEntry[]): number {
  return entries.filter((e) => e.background && e.status === "running").length;
}

/** 输入行计数文案（T13）：「N 任务正在执行」青绿色；为零 = 空串（整段消失）。 */
export function subagentCountHint(count: number): string {
  if (count <= 0) return "";
  return theme.fg("accent", `${count} 任务正在执行`);
}
