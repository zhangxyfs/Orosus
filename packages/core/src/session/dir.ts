import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** 会话目录按项目分桶（D46）：cwd 编码为安全目录名——非 [A-Za-z0-9._-] 一律替换为 "-"，
 *  清洗段截断 50 字符后接 8 hex 路径 hash 防碰撞（`D--develop-Orosus-a1b2c3d4` 形态）。
 *  纯函数：store 不感知桶语义，由 CLI 装配时调用（架构节定案）。 */
export function encodeCwd(cwd: string): string {
  const cleaned = cwd.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 50);
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return `${cleaned}-${hash}`;
}

/** 扫描条目（会话树批 T2 目录化）：id = 会话目录名、file = agents/ 内主文件、dir = 会话目录本身
 *  （要桶路径 = dirname(dir)——store 构造的 dir 参数语义是桶，D46）、bucket = 桶目录名。
 *  size = 主文件字节数（T9 索引 mtime+size 增量判据）。 */
export interface SessionFileEntry {
  id: string;
  file: string;
  dir: string;
  mtimeMs: number;
  size: number;
  bucket: string;
}

/** 单桶扫描（会话树批 T4）：桶目录 → 会话目录列表（新形态）。scanSessionFiles 的内层循环抽出——
 *  lifetimeUsage 等只知桶路径的消费方复用（bucket 参数缺省取 basename）。 */
export function scanBucketSessions(bucketDir: string, bucket?: string): SessionFileEntry[] {
  const bucketName = bucket ?? basename(bucketDir);
  const out: SessionFileEntry[] = [];
  let sids;
  try { sids = readdirSync(bucketDir, { withFileTypes: true }); } catch { return out; }
  for (const sid of sids) {
    if (!sid.isDirectory()) continue;
    const agentsDir = join(bucketDir, sid.name, "agents");
    let names;
    try { names = readdirSync(agentsDir); } catch { continue; }
    const main = names.find((n) => n === "session.jsonl" || n === "session.sqlite");
    if (main === undefined) continue;
    const file = join(agentsDir, main);
    let st;
    try { st = statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ id: sid.name, file, dir: join(bucketDir, sid.name), mtimeMs: st.mtimeMs, size: st.size, bucket: bucketName });
  }
  return out;
}

/** 单层扫描（会话树批 T2 目录化）：只认「每会话一目录」新形态——根 → 桶 → 会话目录 → agents/ 内主文件
 *  （session.jsonl | session.sqlite，决策点 4/16）。旧平铺形态（桶根裸文件与根平铺）一律不识别
 *  （2026-09-26 拍板：项目未发布无存量用户，历史会话由用户手动清理）；桶根下的普通文件与无 agents/
 *  主文件的目录自然跳过。/sessions 列表、resume/fork 定位、prune 共用同一实现（铁律禁 core 反向
 *  import apps，统一件落 core 侧）。纯函数；单桶不可读不炸整体。 */
export function scanSessionFiles(root: string): SessionFileEntry[] {
  const out: SessionFileEntry[] = [];
  try {
    for (const bucket of readdirSync(root, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue;
      out.push(...scanBucketSessions(join(root, bucket.name), bucket.name));
    }
  } catch { /* 根不存在（尚无任何会话）*/ }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 定位既有会话（新形态）——resume/fork 定位 sid 的统一入口；未找到 undefined（调用方决定报错口径）。
 *  opts.bucket = 桶名限定（会话树批 #17 项目内封闭：交互面只认当前项目桶；prune/祖先定位等宿主级消费不传 = 全域）。 */
export function locateSessionFile(root: string, sessionId: string, opts?: { bucket?: string }): SessionFileEntry | undefined {
  return scanSessionFiles(root).find((e) => e.id === sessionId && (opts?.bucket === undefined || e.bucket === opts.bucket));
}

/** 会话主文件是否存在于该桶（会话树批 T1——同桶快路径判据；T2 目录化后按新形态查 agents/ 内主文件）。 */
export function sessionFileExists(bucket: string, sessionId: string): boolean {
  return existsSync(join(bucket, sessionId, "agents", "session.jsonl")) || existsSync(join(bucket, sessionId, "agents", "session.sqlite"));
}

/** 祖先定位（会话树批 T1 断代修复）：hintBucket 命中直返（同桶链快路径——免全根扫描）；否则全根扫描兜底
 *  （存量跨桶链只读兼容）。返回桶目录路径；找不到 undefined。scan 条目 dir 是会话目录——桶 = dirname(dir)。 */
export function locateSessionBucket(root: string | undefined, sessionId: string, hintBucket?: string): string | undefined {
  if (hintBucket !== undefined && sessionFileExists(hintBucket, sessionId)) return hintBucket;
  if (root === undefined) return undefined;
  const loc = locateSessionFile(root, sessionId);
  return loc === undefined ? undefined : dirname(loc.dir);
}
