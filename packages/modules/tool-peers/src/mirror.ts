import { createRequire } from "node:module";
import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { countNotes, importNotesProgressive, readSourceNotes, sha1hex16, zcodeBucketKey, type LlmStream, type OrganizeProgress, type PeerHomes, type SourceNote } from "./importers.ts";
import { memoryBucketKey } from "./roots.ts";

/** 镜像探测件（m5-peers-import-fix T3/T4）：跨项目镜像导入 = 扫全部项目桶 → 归属反查（依据实锚，
 *  见方案五源对照表）→ 各归各桶。**全部纯机械、零模型**；反查失败的桶跳过并报数（unresolved），
 *  绝不猜着写桶（G13/G14 铁律）。 */

export interface MirrorBucket {
  sourceId: "claude-code" | "qwen" | "zcode" | "reasonix";
  /** 源桶 memory 目录（笔记所在地）。 */
  sourceDir: string;
  /** 归属项目绝对路径；undefined = unresolved（导入跳过并报数）。 */
  projectPath: string | undefined;
  how: "session-cwd" | "session-db" | "sessions-dir" | "dirname-heuristic" | "unresolved";
  noteCount: number;
}

/** 排序稳定的目录条目枚举（目录不存在/不可读 = []）。 */
function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  } catch { return []; }
}

/* ── G13：会话文件头 8KB 抓首个 cwd ── */

export interface CwdProbe { cwd?: string; conflict: boolean }

/** G13 归属反查（cc/qwen 共用）：每个候选会话文件只读头部 8KB 找首个 `"cwd":"..."` JSON 字段
 *  （实机 :3 起命中——绝不整读大文件）。无 cwd 的文件跳过不计；多文件读出的 cwd 去重后多于一个
 *  = conflict（键碰撞/多项目混装——**任何平台直 unresolved、不落启发式**，第三轮 doc-review 定案）；
 *  仅单一值采纳；零 cwd 可得 = 无冲突无值（启发式的触发条件——与 conflict 是两回事）。 */
export function extractProjectCwd(candidates: string[]): CwdProbe {
  const cwds = new Set<string>();
  for (const f of candidates) {
    let head = "";
    try {
      const fd = openSync(f, "r");
      try {
        const buf = Buffer.alloc(8_192);
        const n = readSync(fd, buf, 0, buf.length, 0);
        head = buf.toString("utf8", 0, n);
      } finally { closeSync(fd); }
    } catch { continue; }   // 读不开的文件跳过不计
    const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m === null) continue;
    try {
      const cwd = JSON.parse(`"${m[1]}"`) as string;   // 走 JSON 反转义（路径里的 \" \\ 等）
      if (cwd !== "") cwds.add(cwd);
    } catch { /* 坏转义跳过 */ }
  }
  if (cwds.size > 1) return { conflict: true };
  const [only] = cwds;
  return only === undefined ? { conflict: false } : { cwd: only, conflict: false };
}

/** G13 候选会话文件：目录下 *.jsonl 按文件名排序取前 3。cc = 项目目录下；qwen = chats/ 下。 */
function jsonlCandidates(dir: string): string[] {
  try {
    return readdirSync(dir).filter(n => n.endsWith(".jsonl")).sort().slice(0, 3).map(n => join(dir, n));
  } catch { return []; }
}

/* ── G14：win 盘符目录名启发式（仅 cc）── */

/** G14 启发式反推（仅 win、仅 cc；触发条件 = **零 cwd 可得**，G13 冲突桶任何平台不启用）：
 *  目录名 `^([A-Za-z])--(.+)$` 取盘符；rest 中 `-` 有「路径分隔符 / 字面量连字符」两义、静态不可分辨
 *  （sanitizeRoot 回程恒真、无法自证）→ 枚举全部解读（每个 `-` 二选一，组合数 ≤2^k，k>4 截断），
 *  取**磁盘真实存在**的唯一解读；零命中或多命中 → undefined。exists 注入口供测试（默认真盘）。 */
export function heuristicWinPath(dirname: string, exists: (p: string) => boolean = existsSync): string | undefined {
  if (process.platform !== "win32") return undefined;   // 非 win 平台不做目录名启发式
  const m = dirname.match(/^([A-Za-z])--(.+)$/);
  if (m === null) return undefined;
  const drive = m[1]!;
  const rest = m[2]!;
  const dashes = [...rest.matchAll(/-/g)].length;
  if (dashes > 4) return undefined;   // ≤2^k 截断（G14 纪律）
  const hits = new Set<string>();
  for (let mask = 0; mask < 1 << dashes; mask++) {
    const segs: string[] = [];
    let seg = "";
    let d = 0;
    for (const ch of rest) {
      if (ch !== "-") { seg += ch; continue; }
      if ((mask >> d++) & 1) seg += "-";   // 该位 = 字面量连字符
      else { segs.push(seg); seg = ""; }   // 该位 = 路径分隔符
    }
    segs.push(seg);
    if (segs.some(s => s === "")) continue;   // 空段（信息已被 sanitize 折叠）不解
    const p = `${drive}:\\${segs.join("\\")}`;
    if (exists(p)) hits.add(p);
  }
  if (hits.size !== 1) return undefined;
  return [...hits][0]!;
}

/* ── zcode：session.directory 正向重算键匹配 ── */

/** zcode 归属表（探针闭环实锚）：node:sqlite 只读开 `cli/db/db.sqlite`（WAL 并发安全），
 *  `SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL`，逐路径重算
 *  zcodeBucketKey 与桶名**精确匹配**（Map：桶名 → 项目路径）。db 打不开/schema 变更/文件锁 =
 *  undefined（调用方全桶 unresolved，try-catch 包死——绝不写他家的库，只读失败不回退读写开）。 */
function zcodeProjectDirs(dbPath: string): Map<string, string> | undefined {
  let db: import("node:sqlite").DatabaseSync;
  try {
    const require = createRequire(import.meta.url);
    const mod = require("node:sqlite") as typeof import("node:sqlite");
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
  } catch { return undefined; }
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const rows = db.prepare("SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL").all() as { directory: unknown }[];
    const map = new Map<string, string>();
    for (const r of rows) {
      if (typeof r.directory !== "string" || r.directory === "") continue;
      const key = zcodeBucketKey(r.directory);
      if (!map.has(key)) map.set(key, r.directory);
    }
    return map;
  } catch { return undefined; }
  finally { try { db.close(); } catch { /* 已坏 */ } }
}

/* ── reasonix：sessions 扁平键反推 ── */

/** sessions 扁平键 `X_rest` 的枚举解读（`_` 两义：分隔符 vs 段内字面量——第二轮 doc-review 定案）：
 *  首段 = 盘符（单字母），其余各段之间每个接缝二选一（`\` 分隔 / `_` 字面量拼接），组合 ≤2^k、
 *  k>4 截断（G14 同纪律）。空段解读跳过。 */
function sessionKeyPaths(dirname: string): string[] {
  const parts = dirname.split("_");
  const drive = parts[0] ?? "";
  if (!/^[A-Za-z]$/.test(drive)) return [];
  const rest = parts.slice(1);
  if (rest.length === 0) return [];
  const seams = rest.length - 1;
  if (seams > 4) return [];
  const out: string[] = [];
  for (let mask = 0; mask < 1 << seams; mask++) {
    let joined = rest[0]!;
    for (let i = 0; i < seams; i++) {
      joined += ((mask >> i) & 1) === 1 ? `_${rest[i + 1]!}` : `\\${rest[i + 1]!}`;   // 位 1 = 字面量 _ 接缝
    }
    const p = `${drive}:\\${joined}`;
    if (p.includes("\\\\")) continue;   // 空段（`__` 被当双分隔）不解
    out.push(p);
  }
  return out;
}

/** 四家镜像扫描（D10：codex 不适用——全局无项目维度）。
 *  cc：三级（session-cwd → win 启发式 → unresolved；G13 冲突桶直 unresolved 不落启发式）。
 *  qwen：两级（session-cwd → unresolved；键全小写不可逆，无启发式兜底）。
 *  zcode：db 键精确匹配（db 失败 = 全桶 unresolved）。
 *  reasonix：memory/<sha1(cwd)[:16]>/ 桶 + sessions 扁平键反推（sessions 缺失/无目录 = 全桶 unresolved，
 *  散置 jsonl 不参与——只取目录条目）。空桶（无 .md）不出列。 */
export function scanMirrorSources(homes: PeerHomes): MirrorBucket[] {
  const out: MirrorBucket[] = [];

  // cc —— projects/<sanitize(键)>/memory + 项目目录下会话 *.jsonl
  const claudeProjects = join(homes.claude ?? "", "projects");
  for (const entry of listDirs(claudeProjects)) {
    const sourceDir = join(claudeProjects, entry, "memory");
    const noteCount = countNotes(sourceDir);
    if (noteCount === 0) continue;
    const probe = extractProjectCwd(jsonlCandidates(join(claudeProjects, entry)));
    if (probe.conflict) { out.push({ sourceId: "claude-code", sourceDir, projectPath: undefined, how: "unresolved", noteCount }); continue; }
    if (probe.cwd !== undefined) { out.push({ sourceId: "claude-code", sourceDir, projectPath: probe.cwd, how: "session-cwd", noteCount }); continue; }
    const guessed = heuristicWinPath(entry);   // 触发条件：零 cwd 可得（G14）
    out.push(guessed === undefined
      ? { sourceId: "claude-code", sourceDir, projectPath: undefined, how: "unresolved", noteCount }
      : { sourceId: "claude-code", sourceDir, projectPath: guessed, how: "dirname-heuristic", noteCount });
  }

  // qwen —— projects/<小写键>/memory + chats/ 下会话 *.jsonl（无启发式兜底）
  const qwenProjects = join(homes.qwen ?? "", "projects");
  for (const entry of listDirs(qwenProjects)) {
    const sourceDir = join(qwenProjects, entry, "memory");
    const noteCount = countNotes(sourceDir);
    if (noteCount === 0) continue;
    const probe = extractProjectCwd(jsonlCandidates(join(qwenProjects, entry, "chats")));
    out.push(!probe.conflict && probe.cwd !== undefined
      ? { sourceId: "qwen", sourceDir, projectPath: probe.cwd, how: "session-cwd", noteCount }
      : { sourceId: "qwen", sourceDir, projectPath: undefined, how: "unresolved", noteCount });
  }

  // zcode —— memories/projects/<slug-hash16>/memory + db.directory 键精确匹配
  const zcodeProjects = join(homes.zcode ?? "", "cli", "memories", "projects");
  const zcodeDirs = zcodeProjectDirs(join(homes.zcode ?? "", "cli", "db", "db.sqlite"));
  for (const entry of listDirs(zcodeProjects)) {
    const sourceDir = join(zcodeProjects, entry, "memory");
    const noteCount = countNotes(sourceDir);
    if (noteCount === 0) continue;
    const hit = zcodeDirs?.get(entry);
    out.push(hit === undefined
      ? { sourceId: "zcode", sourceDir, projectPath: undefined, how: "unresolved", noteCount }
      : { sourceId: "zcode", sourceDir, projectPath: hit, how: "session-db", noteCount });
  }

  // reasonix —— memory/<sha1[:16]>/ 桶 + sessions 扁平键目录反推
  // `memory/global` 是当前 Go 版的全局位（GlobalDir）——方案「不做」明确第一版不导入，跳过不计桶
  // （否则它会以 unresolved 身份混进「未能定位」报数——不写盘但口径误导）
  const reasonixMemory = join(homes.reasonix ?? "", "memory");
  const sessionDirs = listDirs(join(homes.reasonix ?? "", "sessions"));   // 只取目录条目（散 jsonl 不参与）
  for (const entry of listDirs(reasonixMemory)) {
    if (entry === "global") continue;
    const sourceDir = join(reasonixMemory, entry);
    const noteCount = countNotes(sourceDir);
    if (noteCount === 0) continue;
    const hits = new Set<string>();
    for (const sd of sessionDirs) {
      for (const cand of sessionKeyPaths(sd)) {
        if (sha1hex16(cand) === entry) hits.add(cand);   // 正向算键命中桶名才采纳
      }
    }
    const [only] = hits;
    out.push(only === undefined
      ? { sourceId: "reasonix", sourceDir, projectPath: undefined, how: "unresolved", noteCount }
      : { sourceId: "reasonix", sourceDir, projectPath: only, how: "sessions-dir", noteCount });
  }
  return out;
}

/* ── T4：镜像导入件 ── */

export interface MirrorImportResult { projects: number; imported: number; updated: number; skipped: number; unresolved: number }

/** 镜像导入（T4）：只跑 projectPath 非 undefined 的桶（unresolved 计数跳过）；
 *  destDir = memoryBase/<memoryBucketKey(projectPath)>/memory——逐桶复用 importNotesProgressive
 *  （**覆盖语义**〔2026-10-08 用户拍板〕/整理通道/进度回调/强停全现成，桶间互不干扰）。onProject **前置**
 *  （第 N/共 M 个项目——importNotesProgressive 同款前置纪律），label = 项目路径；onProgress 逐条透传。
 *  signal 强停 = 当前桶硬中断 + 后续桶不跑（走查十二-④ 同语义）。codex 等全局源不在此件（宿主按源
 *  分流，导当前桶）。 */
export async function importMirror(
  memoryBase: string,
  buckets: MirrorBucket[],
  opts: { organize?: boolean; llm?: LlmStream; onProject?: (done: number, total: number, label: string) => void; onProgress?: OrganizeProgress; signal?: AbortSignal } = {},
): Promise<MirrorImportResult> {
  const runnable = buckets.filter(b => b.projectPath !== undefined);
  const total = runnable.length;
  const unresolved = buckets.length - total;
  let imported = 0, updated = 0, skipped = 0, projects = 0;
  for (const [i, b] of runnable.entries()) {
    if (opts.signal?.aborted === true) break;   // 强停：后续桶不跑
    opts.onProject?.(i + 1, total, b.projectPath!);   // 前置：先报项目进度再搬
    const notes: SourceNote[] = readSourceNotes(b.sourceDir);
    const destDir = join(memoryBase, memoryBucketKey(b.projectPath!), "memory");
    const r = await importNotesProgressive(destDir, notes, {
      ...(opts.organize === true ? { organize: true } : {}),
      ...(opts.llm !== undefined ? { llm: opts.llm } : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    imported += r.imported;
    updated += r.updated;
    skipped += r.skipped;
    projects++;
  }
  return { projects, imported, updated, skipped, unresolved };
}
