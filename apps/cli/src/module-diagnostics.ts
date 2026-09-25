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

/** 原始失败事件行（不聚合）——二级详情的时间线与连带反查数据源（T10）。 */
export interface DiagLine {
  ts: string;
  code: string;
  msg: string;
  data?: Record<string, unknown>;
}

const moduleOf = (e: DiagLine): string | undefined => {
  const m = e.data?.["module"];
  return typeof m === "string" && m !== "" ? m : undefined;
};

/** 读窗口内白名单失败事件的原始行（同 readDiagnostics 的过滤口径，不聚合、不排序）。 */
export function readDiagRawLines(dir: string, now: Date): DiagLine[] {
  const days = [now, new Date(now.getTime() - 86_400_000)].map((d) => d.toISOString().slice(0, 10));
  const out: DiagLine[] = [];
  for (const day of days) {
    const file = join(dir, `diagnostic-${day}.jsonl`);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      let rec: { ts?: unknown; code?: unknown; msg?: unknown; data?: unknown };
      try {
        rec = JSON.parse(raw) as typeof rec;
      } catch {
        continue;
      }
      if (typeof rec.code !== "string" || !COLLECTED_CODES.has(rec.code)) continue;
      if (typeof rec.msg !== "string" || typeof rec.ts !== "string") continue;
      if (rec.code === "kernel.discover.skip" && !isLoadFailureSkip(rec.msg)) continue;
      out.push({ ts: rec.ts, code: rec.code, msg: rec.msg, ...(rec.data !== undefined ? { data: rec.data as Record<string, unknown> } : {}) });
    }
  }
  return out;
}

/** 二级详情文本拼装（T10/S9）：失败原因全文 / 连带影响 / 事件时间线 / 修复指引（三类模板）。
 *  rawEvents = 与该模块相关的事件行（本模块的 + 点名该模块的——主犯拖累反查靠后者）。 */
export function renderDetail(entry: DiagEntry, rawEvents: readonly DiagLine[]): string {
  const sections: string[] = [];
  sections.push(`【失败原因】\n${entry.reason}\n（共 ${entry.count} 次 · 最后 ${entry.last.slice(11, 19)}）`);

  // 连带影响：从犯（原因点名提供者）= 被谁拖累；无提供者形态 = 说明；主犯 = 反查点名它的事件
  const prov = /的提供者 ([^\s（、]+) 不可用|的提供者 ([^\s（、]+) 已降级/.exec(entry.reason);
  const cascadeLines: string[] = [];
  if (prov !== null) {
    const providerName = prov[1] ?? prov[2] ?? "";
    cascadeLines.push(`因硬依赖能力的提供者 ${providerName} 不可用/已降级，本模块被级联降级（本模块代码无问题）。`);
    cascadeLines.push(`恢复 ${providerName} 后本模块自动恢复（下次 reload 生效）；单独重试本模块无用——依赖不满足是护栏在正确工作。`);
  } else if (entry.reason.includes("无可用提供者")) {
    cascadeLines.push("依赖的能力没有安装提供者（未安装/未声明）。");
    cascadeLines.push("安装或启用提供该能力的模块后，本模块自动恢复（下次 reload 生效）。");
  }
  const victims = [...new Set(rawEvents
    .filter((e) => e.msg.includes(`的提供者 ${entry.name}`) && moduleOf(e) !== entry.name)
    .map((e) => moduleOf(e))
    .filter((n): n is string => n !== undefined))];
  if (victims.length > 0) {
    cascadeLines.push(`本模块的失败已连带拖累：${victims.join("、")}（依赖它的模块在本模块恢复前不可用）。`);
  }
  if (cascadeLines.length > 0) sections.push(`【连带影响】\n${cascadeLines.join("\n")}`);

  const mine = rawEvents.filter((e) => moduleOf(e) === entry.name).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (mine.length > 0) {
    sections.push(`【事件时间线】\n${mine.map((e) => `${e.ts.slice(11, 19)}  ${e.msg.split("\n")[0] ?? e.msg}`).join("\n")}`);
  }

  const logHint = "· 诊断日志：~/.orosus/logs/diagnostic-<日期>.jsonl";
  const guide = entry.tag === "级联"
    ? "· 根因在它依赖的提供者模块——恢复提供者后本模块自动恢复\n· 单独重试本模块无用——依赖不满足是护栏在正确工作\n· 临时规避：重启进程"
    : entry.tag === "加载失败"
      ? "· 发现期加载失败：模块未进图、不影响主程序运行\n· 修复模块源码后 /reload（或重开本窗口）即可看到更新\n· 本地模块入口规范：index.{ts,js} 或 package.json 的 exports[\"./module\"]"
      : "· 检查模块配置与依赖后重试挂载（模块面板 Enter 或 /reload）\n· 临时规避：重启进程（新进程按盘上配置干净激活）";
  sections.push(`【修复指引】\n${guide}\n${logHint}`);
  return sections.join("\n\n");
}
