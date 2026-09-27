import * as theme from "./theme.ts";
import type { SubagentRosterEntry } from "@orosus/contracts/module";

/**
 * 前台子代理 agent 组显示（2026-09-27 用户拍板格式，照 kimi agent-group 定式）：
 *
 *   3 explore agents 运行中
 *   ├─  explore 修登录样式  glm-4.7·high·5次·12秒·3.2k·运行中
 *   └─  explore 跑测试  glm-4.7·off·2次·8秒·1.1k·完成
 *
 * 首行 = 数量 + 工种 + 聚合状态；**括号统计段只在全部结束时显示**（Σ工具调用 · Σ词元 · 总时长）。
 * 子行 = 树连接符 + 工种 + 短标题 + 模型·思考·工具调用数·运行时间·词元·状态；最多 8 行（并发上限 8），
 * 超出按「运行中 → 排队 → 失败 → 完成」分桶挑前 8（照 ZCode——按序 slice 会只剩已完成行），尾行注余量。
 * 三色：运行中/排队 accent（青玉）、完成 muted（灰）、失败 err（红）。孙代理在父行下再缩一级（│ 嵌套）。
 */

/** 子行显示上限（决策 5：并发硬上限 8——同一时刻在跑的不会超 8，分桶挑选防已完成挤占）。 */
const GROUP_ROW_MAX = 8;

/** 标题截断（用户拍板「标题要简短」——spawn 描述建议 ≤20 字，超长显示侧截断兜底）。 */
const TITLE_MAX = 20;

const STATUS_COLOR: Record<SubagentRosterEntry["status"], Parameters<typeof theme.fg>[0]> = {
  queued: "accent",
  running: "accent",
  completed: "muted",
  failed: "err",
};

/** 词元缩写（kimi formatTokenCount 同款：<1000 原样，≥1000 保留一位小数 k）。 */
const fmtTok = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);

/** 时长（精确到秒）：<60「N秒」；<1时「M分SS秒」；否则「H时M分」。 */
const fmtDur = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}秒`;
  if (total < 3600) return `${Math.floor(total / 60)}分${String(total % 60).padStart(2, "0")}秒`;
  return `${Math.floor(total / 3600)}时${Math.floor(total / 60) % 60}分`;
};

const isTerminal = (e: SubagentRosterEntry): boolean => e.status === "completed" || e.status === "failed";

const statusWord = (e: SubagentRosterEntry): string => {
  const base = e.status === "queued" ? "排队中" : e.status === "running" ? "运行中" : e.status === "completed" ? "完成" : "失败";
  return base + (e.pendingApproval !== undefined ? "·等审批" : "") + (e.background ? "·后台" : "");
};

const rowDur = (e: SubagentRosterEntry, now: number): number => {
  const start = Date.parse(e.startedAt ?? e.enqueuedAt);
  const end = e.endedAt !== undefined ? Date.parse(e.endedAt) : now;
  return end - start;
};

/** 子行统计段：模型·思考·工具调用数·运行时间·词元（缺省段跳过——kimi 同款）。 */
const rowStats = (e: SubagentRosterEntry, now: number): string => {
  const segs = [
    e.model,
    e.effort,
    e.toolCalls !== undefined ? `${e.toolCalls}次` : undefined,
    fmtDur(rowDur(e, now)),
    e.usage !== undefined ? fmtTok(e.usage.input + e.usage.output) : undefined,
  ].filter((x): x is string => x !== undefined && x !== "");
  return segs.join("·");
};

/** 分桶挑选要显示的行（运行中 → 排队 → 失败 → 完成，各桶保下入册序）。 */
const pickRows = (flat: SubagentRosterEntry[]): SubagentRosterEntry[] => {
  const buckets: SubagentRosterEntry["status"][] = ["running", "queued", "failed", "completed"];
  const out: SubagentRosterEntry[] = [];
  for (const b of buckets) {
    for (const e of flat) {
      if (out.length >= GROUP_ROW_MAX) break;
      if (e.status === b && !out.includes(e)) out.push(e);
    }
  }
  return out;
};

/**
 * agent 组整块（首行 + 子行，纯函数——DocModel 组条目每帧现调）。
 * entries = 本组认领的全部条目（前台后台都在，后台行带标注）；now 供运行时长现算。
 */
export function agentGroupLines(entries: readonly SubagentRosterEntry[], now: number = Date.now()): string[] {
  if (entries.length === 0) return [];
  // ── 首行：数量 + 工种（全组同名才显，否则「子代理」）+ 聚合状态；括号段只在全部终态 ──
  const roles = [...new Set(entries.map((e) => e.roleName ?? "general"))];
  const role = roles.length === 1 ? roles[0]! : "子代理";
  const active = entries.filter((e) => !isTerminal(e));
  const failed = entries.filter((e) => e.status === "failed");
  const done = entries.filter((e) => e.status === "completed");
  let state: string;
  let color: Parameters<typeof theme.fg>[0];
  if (active.length > 0) {
    state = "运行中";
    color = "accent";
  } else if (failed.length === 0) {
    state = "完成";
    color = "muted";
  } else if (done.length === 0) {
    state = "失败";
    color = "err";
  } else {
    state = `完成（${done.length}/${entries.length}）`; // 混合终态：M/N 完成
    color = "err";
  }
  let header = theme.fg(color, `● ${entries.length} ${role} agents ${state}`);
  if (active.length === 0) {
    // 括号统计段（只在结束时显示——用户拍板）：Σ工具调用 · Σ词元 · 总时长（首末跨度）
    const tools = entries.reduce((n, e) => n + (e.toolCalls ?? 0), 0);
    const tok = entries.reduce((n, e) => n + (e.usage !== undefined ? e.usage.input + e.usage.output : 0), 0);
    const starts = entries.map((e) => Date.parse(e.startedAt ?? e.enqueuedAt));
    const ends = entries.map((e) => Date.parse(e.endedAt ?? e.startedAt ?? e.enqueuedAt));
    const span = Math.max(0, Math.max(...ends) - Math.min(...starts));
    header += theme.dim(`（${tools} 工具调用 · ${fmtTok(tok)} 词元 · ${fmtDur(span)}）`);
  }

  // ── 子行：父子摊平树（父行 ├─/└─，孙行嵌套 │/空续接）→ 分桶挑选 → 连接符按显示序现算 ──
  const orphans = entries.filter((e) => e.depth === 2 && !entries.some((p) => p.id === e.parentId));
  const flat: { e: SubagentRosterEntry; depth: 0 | 1 }[] = [];
  for (const parent of entries.filter((x) => x.depth === 1 || (x.depth === 2 && orphans.includes(x)))) {
    flat.push({ e: parent, depth: 0 });
    for (const child of entries.filter((x) => x.depth === 2 && x.parentId === parent.id)) flat.push({ e: child, depth: 1 });
  }
  const shown = pickRows(flat.map((x) => x.e));
  const depthOf = (e: SubagentRosterEntry): 0 | 1 => flat.find((x) => x.e === e)!.depth;
  const lines: string[] = [header];
  for (let i = 0; i < shown.length; i++) {
    const e = shown[i]!;
    const d = depthOf(e);
    // 同级末位判定：显示序里此后还有同级 → ├─，否则 └─；孙行的父级续接前缀（父行之后还有父级同行 → │）
    const hasSameAfter = shown.slice(i + 1).some((x) => depthOf(x) === d);
    const branch = hasSameAfter ? "├─" : "└─";
    const prefix = d === 1 && shown.slice(i + 1).some((x) => depthOf(x) === 0) ? "│  " : d === 1 ? "   " : "";
    const title = e.label.length > TITLE_MAX ? `${e.label.slice(0, TITLE_MAX)}…` : e.label;
    const name = theme.fg("accent", `${e.roleName ?? "general"} ${title}`);
    const stats = theme.dim(`  ${rowStats(e, now)}`);
    const st = theme.fg(STATUS_COLOR[e.status], statusWord(e));
    lines.push(`  ${prefix}${branch}  ${name}${stats}·${st}`); // 状态前不加空格——拍板模板全 · 连
  }
  const rest = flat.length - shown.length;
  if (rest > 0) lines.push(theme.dim(`  …还有 ${rest} 个（/tasks 看全部）`));
  return lines;
}

/** 输入行计数口径（M4.5 T13 / 设计空白）：只统计后台运行中——前台走 agent 组（流区内）、排队不算「正在执行」。 */
export function backgroundRunningCount(entries: readonly SubagentRosterEntry[]): number {
  return entries.filter((e) => e.background && e.status === "running").length;
}

/** 输入行计数文案（T13）：「N 任务正在执行」青绿色；为零 = 空串（整段消失）。 */
export function subagentCountHint(count: number): string {
  if (count <= 0) return "";
  return theme.fg("accent", `${count} 任务正在执行`);
}
