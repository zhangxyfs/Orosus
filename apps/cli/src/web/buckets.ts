/** bucket→cwd 反查（web 批 T9，B3）：桶内代表会话 header 首行 JSON 的 cwd 字段（harness.ts
 *  ensureHeader 落盘必写）。惰性 + 进程内缓存 Map——桶名 = encodeCwd(cwd)（清洗段 + 路径 hash）
 *  对 cwd 双射，同名桶恒同 cwd，一次反查终身有效；盘读计数器导出供测试断言缓存命中
 *  （§5 律三：扫描解析有缓存，成本不随客户端数放大）。
 *  边界注记：core readSqliteHead 未导出（brief 消费面 = readSessionHead/readSessionHead 族），
 *  sqlite 后端会话的首行解析按坏行跳过——桶内只要有一个 jsonl 会话即可反查成功；全 sqlite 桶
 *  反查 miss（组名回落桶名），属可接受降级。 */
import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { scanBucketSessions } from "@orosus/core";

/** 反查缓存（键 = root + 桶名；值 undefined 也缓存——坏桶不反复试盘）。 */
const cwdCache = new Map<string, string | undefined>();

/** 盘读次数（测试断言面：缓存命中不放大盘读）。 */
let reads = 0;

export function bucketCwdReads(): number {
  return reads;
}

/** 会话 header 首行读 cwd（预算 4KB——header 含 moduleSummary 三计数，恒小；T2 hostpool 同源实现
 *  迁入本件统一归口）。坏行/无 header → undefined（调用方兜底）。 */
export function headerCwd(file: string): string | undefined {
  try {
    const buf = Buffer.alloc(4096);
    const fd = openSync(file, "r");
    try {
      const n = readSync(fd, buf, 0, buf.length, 0);
      const nl = buf.indexOf(0x0a);
      const line = buf.toString("utf8", 0, Math.min(n, nl === -1 ? buf.length : nl));
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined; // 坏行/无 header——调用方兜底
  }
}

/** 桶 → cwd 反查（惰性、缓存）：桶内任一会话（mtime 序首个可读者）的 header 首行 cwd。 */
export function bucketCwd(root: string, bucket: string): string | undefined {
  const key = `${root}\u0000${bucket}`;
  if (cwdCache.has(key)) return cwdCache.get(key);
  reads++;
  let cwd: string | undefined;
  for (const e of scanBucketSessions(join(root, bucket))) {
    cwd = headerCwd(e.file);
    if (cwd !== undefined) break;
  }
  cwdCache.set(key, cwd);
  return cwd;
}
