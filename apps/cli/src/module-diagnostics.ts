import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "./i18n/app.ts";

/** 诊断弹窗条目标签（S4 三分类）：激活失败 / 级联 / 加载失败。 */ // i18n:diag 类型面/判据值——显示面走 moddiag.tag.* 键
export type DiagTag = "激活失败" | "级联" | "加载失败"; // 类型面字面量（判据值）；显示面走 moddiag.tag.* 键 // i18n:diag 类型面/判据值——显示面走 moddiag.tag.* 键

export interface DiagEntry {
  name: string;
  tag: DiagTag;
  reason: string;
  count: number;
  last: string; // ISO 时间戳（S11：不去重同原因多次发生——次数本身是信息）
}

/** 一级列表收集范围（S3 定案四类）：模块级失败事件码白名单。 */
const COLLECTED_CODES = new Set(["kernel.module.failed", "kernel.discover.fail", "kernel.discover.skip", "kernel.discover.missing"]);

/** skip 只收「加载失败」语义的行（S3 机械判据）：「包描述读取失败」/「入口读取失败」（公共子串「读取失败」） // i18n:diag 类型面/判据值——显示面走 moddiag.tag.* 键
 *  与「（source 目录）无入口」；排除「无模块入口」良性形态（目录非模块，discover.ts 的目录扫描信息行）。 */
function isLoadFailureSkip(msg: string): boolean {
  if (msg.includes("读取失败")) return true; // i18n:diag 协议判据——匹配 core 日志中文原文（诊断面不翻边界）
  return msg.includes("无入口") && !msg.includes("无模块入口"); // i18n:diag 同上（classifyFailure 双语扩表先例——随语扩表走查定）
}

/** 模块名提取（T8 现状取证）：data.module 优先（结构化，T5/T7 已补）；msg 前缀「目录 X」「模块 X」兜底（前一天的历史行）。 */
function extractModuleName(rec: { msg?: unknown; data?: unknown }): string | undefined {
  const dm = (rec.data as Record<string, unknown> | undefined)?.["module"];
  if (typeof dm === "string" && dm !== "") return dm;
  const m = /^(?:目录|模块) ([^\s（]+)/.exec(typeof rec.msg === "string" ? rec.msg : ""); // i18n:diag 日志原文判据
  return m?.[1];
}

/** 标签推断（S4）：discover.* → 加载失败；原因含「级联」或「不可用（」或「无可用提供者」→ 级联（topo 两形态 + // i18n:diag 类型面/判据值——显示面走 moddiag.tag.* 键
 *  activate 级联形；「提供者模块 bug」分支不含三关键词、正确落激活失败）；其余 → 激活失败。 */ // i18n:diag 类型面/判据值——显示面走 moddiag.tag.* 键
function tagOf(code: string, reason: string): DiagTag {
  if (code.startsWith("kernel.discover.")) return "加载失败"; // i18n:diag 类型面/判据值——显示面走 moddiag.tag.* 键
  // i18n:diag 判据关键词跟 failReason 语言（kernelT 缺省 zh；en 态走查后随语扩表——classifyFailure 先例）
  if (reason.includes("不可用（") || reason.includes("无可用提供者") || reason.includes("级联降级") || reason.includes("is degraded") || reason.includes("not registered")) return "级联"; // i18n:diag 双语判据（级联降级=kernelT 输出形；随语扩表走查定）
  return "激活失败"; // i18n:diag 类型面/判据值——显示面走 moddiag.tag.* 键
}

/**
 * 诊断日志读取器（T8，弹窗数据源——宿主读当前会话日志，核心零改动）：
 * 读当天 + 前一天两个 diagnostic-*.jsonl（S2：日期按 UTC 取，与 logger.ts 的
 * toISOString().slice(0, 10) 滚动同式——跨天长会话的失败在前一天文件里）；
 * 逐行 JSON.parse（坏行跳过）、按事件码白名单过滤、按「模块名 + 原因」聚合计次，
 * 输出按 last 倒序。
 */
export function readDiagnostics(dir: string, now: Date): DiagEntry[] {
  const byKey = new Map<string, DiagEntry>();
  for (const rec of iterCollectedLines(dir, now)) {
    const name = extractModuleName(rec);
    if (name === undefined) continue;
    const key = `${name}\u0000${rec.msg}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.count++;
      if (rec.ts > existing.last) existing.last = rec.ts;
    } else {
      byKey.set(key, { name, tag: tagOf(rec.code, rec.msg), reason: rec.msg, count: 1, last: rec.ts });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
}

/** 原始失败事件行（不聚合）——二级详情的时间线与连带反查数据源（T10）。 */
export interface DiagLine {
  ts: string;
  code: string;
  msg: string;
  data?: Record<string, unknown>;
}

/** 事件行的结构化模块名（data.module——T5/T7 已补；缺省时 undefined，msg 前缀兜底只在聚合读取器做）。 */
export const moduleOf = (e: DiagLine): string | undefined => {
  const m = e.data?.["module"];
  return typeof m === "string" && m !== "" ? m : undefined;
};

/** S2 两日窗口内白名单失败事件的原始行遍历（readDiagnostics 与 readDiagRawLines 共享——窗口/坏行/白名单/skip 分叉同口径）。 */
function* iterCollectedLines(dir: string, now: Date): Generator<DiagLine> {
  const days = [now, new Date(now.getTime() - 86_400_000)].map((d) => d.toISOString().slice(0, 10));
  for (const day of days) {
    const file = join(dir, `diagnostic-${day}.jsonl`);
    if (!existsSync(file)) continue; // 缺文件静默跳过
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      let rec: { ts?: unknown; code?: unknown; msg?: unknown; data?: unknown };
      try {
        rec = JSON.parse(raw) as typeof rec;
      } catch {
        continue; // 坏行跳过
      }
      if (typeof rec.code !== "string" || !COLLECTED_CODES.has(rec.code)) continue;
      if (typeof rec.msg !== "string" || typeof rec.ts !== "string") continue;
      if (rec.code === "kernel.discover.skip" && !isLoadFailureSkip(rec.msg)) continue;
      yield { ts: rec.ts, code: rec.code, msg: rec.msg, ...(rec.data !== undefined ? { data: rec.data as Record<string, unknown> } : {}) };
    }
  }
}

/** 读窗口内白名单失败事件的原始行（不聚合、不排序）。 */
export function readDiagRawLines(dir: string, now: Date): DiagLine[] {
  return [...iterCollectedLines(dir, now)];
}

/** 二级详情文本拼装（T10/S9）：失败原因全文 / 连带影响 / 事件时间线 / 修复指引（三类模板）。
 *  rawEvents = 与该模块相关的事件行（本模块的 + 点名该模块的——主犯拖累反查靠后者）。 */
export function renderDetail(entry: DiagEntry, rawEvents: readonly DiagLine[]): string {
  const sections: string[] = [];
  sections.push(t("moddiag.reason", { reason: entry.reason, count: entry.count, time: entry.last.slice(11, 19) }));

  // 连带影响：从犯（原因点名提供者）= 被谁拖累；无提供者形态 = 说明；主犯 = 反查点名它的事件
  const prov = /的提供者 ([^\s（、]+) 不可用|的提供者 ([^\s（、]+) 已降级/.exec(entry.reason);
  const cascadeLines: string[] = [];
  if (prov !== null) {
    const providerName = prov[1] ?? prov[2] ?? "";
    cascadeLines.push(t("moddiag.cascade.victim", { name: providerName }));
    cascadeLines.push(t("moddiag.cascade.recover", { name: providerName }));
  } else if (entry.reason.includes("无可用提供者")) { // i18n:diag 判据
    cascadeLines.push(t("moddiag.cascade.noProvider"));
    cascadeLines.push(t("moddiag.cascade.installProvider"));
  }
  const victims = [...new Set(rawEvents
    .filter((e) => e.msg.includes(`的提供者 ${entry.name}`) && moduleOf(e) !== entry.name) // i18n:diag 日志原文判据
    .map((e) => moduleOf(e))
    .filter((n): n is string => n !== undefined))];
  if (victims.length > 0) {
    cascadeLines.push(t("moddiag.cascade.victims", { names: victims.join("、") }));
  }
  if (cascadeLines.length > 0) sections.push(`${t("moddiag.impact")}\n${cascadeLines.join("\n")}`);

  const mine = rawEvents.filter((e) => moduleOf(e) === entry.name).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (mine.length > 0) {
    sections.push(`${t("moddiag.timeline.title")}\n${mine.map((e) => `${e.ts.slice(11, 19)}  ${e.msg.split("\n")[0] ?? e.msg}`).join("\n")}`);
  }

  const logHint = t("moddiag.logHint");
  const guide = entry.tag === "级联" // i18n:diag 类型面/判据值——显示面走 moddiag.tag.* 键
	    ? t("moddiag.guide.cascade")
    : entry.tag === "加载失败" // i18n:diag 类型面/判据值——显示面走 moddiag.tag.* 键
	      ? t("moddiag.guide.load")
	      : t("moddiag.guide.default");
	sections.push(`${t("moddiag.guide.title")}
${guide}
${logHint}`);
  return sections.join("\n\n");
}
