import { readdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { orosusHome } from "@orosus/contracts/home";
import { dirname, join } from "node:path";
import { scanSessionFiles, type SessionFileEntry } from "@orosus/core";
import { t } from "./i18n/app.ts";

/** `orosus sessions prune`（M4-1 T2/D47）：显式清理会话文件——缺省 dry-run，`--apply` 才删；
 *  不做启动期自动 GC（静默删数据违背「降级必须吵闹」）。清单复用 T1 统一件 scanSessionFiles
 *  （根平铺 + 项目桶），不另造目录遍历。自创值钉死（D47/方案 §12 镜头）：--days 缺省 30；
 *  「空」= 事件数 0（0 字节或仅 header）；「当前会话」= 全域 mtime 最新恒不动（子命令无会话态，保守代理）。 */

export function isSessionsSubcommand(argv: string[]): boolean {
  return argv[0] === "sessions" && argv[1] === "prune";
}

export interface PruneOptions { days: number; apply: boolean }

const PRUNE_USAGE = (): string => t("prune.usage"); // m5-i18n T9：用法块走键

export function parsePruneFlags(rest: string[]): PruneOptions {
  const opts: PruneOptions = { days: 30, apply: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--dry-run") opts.apply = false;
    else if (a === "--apply") opts.apply = true;
    else if (a === "--days") {
      const v = rest[++i];
      const n = v !== undefined ? Number(v) : NaN;
      if (!Number.isInteger(n) || n < 1) throw new Error(`${t("prune.badDays", { v: String(v) })}\n${PRUNE_USAGE()}`);
      opts.days = n;
    } else throw new Error(`${t("args.unknown", { v: a })}\n${PRUNE_USAGE()}`);
  }
  return opts;
}

/** 计划条目 = 扫描条目 + 事件数（「空」判定依据）。 */
export interface PruneEntry extends SessionFileEntry { eventCount: number }

/** 纯函数：清单 + mtime + 事件数 → 保留/删除计划（测试主体，不碰盘）。
 *  判定序：全域最新恒不动 → 空（事件数 0，无论龄）→ 过期（mtime 严格早于 now - days 天）。 */
export function buildPrunePlan(
  entries: PruneEntry[],
  opts: { days: number; now: number },
): { deletions: { id: string; file: string; dir: string; reason: "empty" | "stale" }[]; kept: number } {
  let newest: PruneEntry | undefined;
  for (const e of entries) if (newest === undefined || e.mtimeMs > newest.mtimeMs) newest = e;
  const cutoff = opts.now - opts.days * 86_400_000;
  const deletions: { id: string; file: string; dir: string; reason: "empty" | "stale" }[] = [];
  let kept = 0;
  for (const e of entries) {
    if (e === newest) { kept++; continue; } // 「当前会话」保守代理
    if (e.eventCount === 0) { deletions.push({ id: e.id, file: e.file, dir: e.dir, reason: "empty" }); continue; }
    if (e.mtimeMs < cutoff) { deletions.push({ id: e.id, file: e.file, dir: e.dir, reason: "stale" }); continue; }
    kept++;
  }
  return { deletions, kept };
}

/** 事件数：jsonl = 非空行数 - 1（header 不算事件——0 字节/仅 header 均 0）；sqlite 打开数行过重，
 *  保守视为非空（只按龄判定——sqlite 会话罕见且体积小）。 */
function countEvents(file: string): number {
  if (file.endsWith(".sqlite")) return 1;
  try {
    return Math.max(0, readFileSync(file, "utf8").split("\n").filter(Boolean).length - 1);
  } catch {
    return 1; // 不可读 = 保守非空（只按龄）——返回 0 会让 --apply 误删不可读文件（code-review Spec P1）
  }
}

export async function runPruneSubcommand(
  argv: string[],
  io: { out(s: string): void; root?: string; now?: number },
): Promise<number> {
  const opts = parsePruneFlags(argv.slice(2));
  const root = io.root ?? join(orosusHome(), "sessions");
  const now = io.now ?? Date.now();
  const entries: PruneEntry[] = scanSessionFiles(root).map((e) => ({ ...e, eventCount: countEvents(e.file) }));
  const plan = buildPrunePlan(entries, { days: opts.days, now });
  const empty = plan.deletions.filter((d) => d.reason === "empty").length;
  const stale = plan.deletions.length - empty;
  // CM-18（2026-09-28 code review）：scanSessionFiles 是全域扫描（根平铺 + 全部项目桶，dir.ts 的宿主级
  // 消费口径）——旧文案「项目桶」暗示只动当前项目，用户会误判清理的爆炸半径；跨项目是设计（子命令无项目态）
  io.out(t("prune.scanHeader", { n: entries.length }));
  io.out(t("prune.plan", { n: plan.deletions.length, empty, days: opts.days, stale, kept: plan.kept }));
  for (const d of plan.deletions) io.out(t("prune.row", { id: d.id, reason: d.reason === "empty" ? t("prune.reason.empty") : t("prune.reason.stale") }));
  if (!opts.apply) {
    io.out(t("prune.dryRun"));
    return 0;
  }
  // 会话树批 T4（设计空白 16）：删除粒度 = 整会话目录（含 agents/ 与 spill/）——会话既删、其日志与溢写文件同灭；
  // spill 的绝对路径引用随日志一起消失，「不搬动 spill」约束保护的是存活会话，不挡死会话的清理。
  // force（CM-18）：扫描与删除之间目录被并发实例删掉时 ENOENT 不再中断整批（旧实现半删 + 裸堆栈）
  for (const d of plan.deletions) rmSync(d.dir, { recursive: true, force: true });
  // 桶目录卫生（判据改桶 = dirname(会话目录)，删后变空的桶一并移除——不递归、只动本次涉及目录）
  for (const bucketDir of new Set(plan.deletions.map((d) => dirname(d.dir)))) {
    try { if (readdirSync(bucketDir).length === 0) rmdirSync(bucketDir); } catch { /* 并发变化则留待下轮 */ }
  }
  io.out(t("prune.done", { n: plan.deletions.length }));
  return 0;
}
