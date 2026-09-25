import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 诊断弹窗条目标签（S4 三分类）：激活失败 / 级联 / 加载失败。 */
export type DiagTag = "激活失败" | "级联" | "加载失败";

export interface DiagEntry {
  name: string;
  tag: DiagTag;
  reason: string;
  count: number;
  last: string; // ISO 时间戳（S11：不去重同原因多次发生——次数本身是信息）
}

/** 一级列表收集范围（S3 定案四类）：模块级失败事件码白名单。 */
const COLLECTED_CODES = new Set(["kernel.module.failed", "kernel.discover.fail", "kernel.discover.skip", "kernel.discover.missing"]);

/** skip 只收「加载失败」语义的行（S3 机械判据）：「包描述读取失败」/「入口读取失败」（公共子串「读取失败」）
 *  与「（source 目录）无入口」；排除「无模块入口」良性形态（目录非模块，discover.ts 的目录扫描信息行）。 */
function isLoadFailureSkip(msg: string): boolean {
  if (msg.includes("读取失败")) return true;
  return msg.includes("无入口") && !msg.includes("无模块入口");
}

/** 模块名提取（T8 现状取证）：data.module 优先（结构化，T5/T7 已补）；msg 前缀「目录 X」「模块 X」兜底（前一天的历史行）。 */
function extractModuleName(rec: { msg?: unknown; data?: unknown }): string | undefined {
  const dm = (rec.data as Record<string, unknown> | undefined)?.["module"];
  if (typeof dm === "string" && dm !== "") return dm;
  const m = /^(?:目录|模块) ([^\s（]+)/.exec(typeof rec.msg === "string" ? rec.msg : "");
  return m?.[1];
}

/** 标签推断（S4）：discover.* → 加载失败；原因含「级联」或「不可用（」或「无可用提供者」→ 级联（topo 两形态 +
 *  activate 级联形；「提供者模块 bug」分支不含三关键词、正确落激活失败）；其余 → 激活失败。 */
function tagOf(code: string, reason: string): DiagTag {
  if (code.startsWith("kernel.discover.")) return "加载失败";
  if (reason.includes("级联") || reason.includes("不可用（") || reason.includes("无可用提供者")) return "级联";
  return "激活失败";
}

/**
 * 诊断日志读取器（T8，弹窗数据源——宿主读当前会话日志，核心零改动）：
 * 读当天 + 前一天两个 diagnostic-*.jsonl（S2：日期按 UTC 取，与 logger.ts 的
 * toISOString().slice(0, 10) 滚动同式——跨天长会话的失败在前一天文件里）；
 * 逐行 JSON.parse（坏行跳过）、按事件码白名单过滤、按「模块名 + 原因」聚合计次，
 * 输出按 last 倒序。
 */
export function readDiagnostics(dir: string, now: Date): DiagEntry[] {
  const days = [now, new Date(now.getTime() - 86_400_000)].map((d) => d.toISOString().slice(0, 10));
  const byKey = new Map<string, DiagEntry>();
  for (const day of days) {
    const file = join(dir, `diagnostic-${day}.jsonl`);
    if (!existsSync(file)) continue; // 缺文件静默跳过
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      let rec: { ts?: unknown; code?: unknown; msg?: unknown; data?: unknown };
      try {
        rec = JSON.parse(raw) as typeof rec;
      } catch {
        continue;
      }
      if (typeof rec.code !== "string" || !COLLECTED_CODES.has(rec.code)) continue;
      if (typeof rec.msg !== "string") continue;
      if (rec.code === "kernel.discover.skip" && !isLoadFailureSkip(rec.msg)) continue;
      const name = extractModuleName(rec);
      if (name === undefined || typeof rec.ts !== "string") continue;
      const key = `${name}\u0000${rec.msg}`;
      const existing = byKey.get(key);
      if (existing !== undefined) {
        existing.count++;
        if (rec.ts > existing.last) existing.last = rec.ts;
      } else {
        byKey.set(key, { name, tag: tagOf(rec.code, rec.msg), reason: rec.msg, count: 1, last: rec.ts });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
}
