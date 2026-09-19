import { readdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { orosusHome } from "@orosus/contracts/home";
import { join } from "node:path";
import { scanSessionFiles, type SessionFileEntry } from "@orosus/core";

/** `orosus sessions prune`（M4-1 T2/D47）：显式清理会话文件——缺省 dry-run，`--apply` 才删；
 *  不做启动期自动 GC（静默删数据违背「降级必须吵闹」）。清单复用 T1 统一件 scanSessionFiles
 *  （根平铺 + 项目桶），不另造目录遍历。自创值钉死（D47/方案 §12 镜头）：--days 缺省 30；
 *  「空」= 事件数 0（0 字节或仅 header）；「当前会话」= 全域 mtime 最新恒不动（子命令无会话态，保守代理）。 */

export function isSessionsSubcommand(argv: string[]): boolean {
  return argv[0] === "sessions" && argv[1] === "prune";
}

export interface PruneOptions { days: number; apply: boolean }

const PRUNE_USAGE = "用法: orosus sessions prune [--days N] [--dry-run|--apply]（缺省 dry-run 30 天）";

export function parsePruneFlags(rest: string[]): PruneOptions {
  const opts: PruneOptions = { days: 30, apply: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--dry-run") opts.apply = false;
    else if (a === "--apply") opts.apply = true;
    else if (a === "--days") {
      const v = rest[++i];
      const n = v !== undefined ? Number(v) : NaN;
      if (!Number.isInteger(n) || n < 1) throw new Error(`--days 须为正整数（得到 ${String(v)}）\n${PRUNE_USAGE}`);
      opts.days = n;
    } else throw new Error(`未知参数 ${a}\n${PRUNE_USAGE}`);
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
  io.out(`扫描 ${entries.length} 个会话文件（根平铺 + 项目桶，清理器 T2/D47）`);
  io.out(`计划删除 ${plan.deletions.length} 个：空文件（0 字节或仅 header）${empty} 个 + 超过 ${opts.days} 天 ${stale} 个；保留 ${plan.kept} 个（含 mtime 最新的当前会话）。`);
  for (const d of plan.deletions) io.out(`  将删 ${d.id}［${d.reason === "empty" ? "空" : "过期"}］`);
  if (!opts.apply) {
    io.out("dry-run（缺省）——未删除任何文件；确认后加 --apply 执行。");
    return 0;
  }
  for (const d of plan.deletions) rmSync(d.file);
  // 桶目录卫生：删后变空的桶目录一并移除（不递归、只动本次涉及目录）
  for (const dirNow of new Set(plan.deletions.map((d) => d.dir))) {
    try { if (readdirSync(dirNow).length === 0) rmdirSync(dirNow); } catch { /* 并发变化则留待下轮 */ }
  }
  io.out(`已删除 ${plan.deletions.length} 个文件。`);
  return 0;
}
