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

/** 会话文件内 session/header 行读 cwd（预算 8KB；T18 走查修：真实会话首行常是 mcp/manifest——
 *  模块装载先于首条 header 落盘，逐行扫前几行取首个 session/header，不再钉死第 1 行）。坏行/预算内
 *  无 header → undefined（调用方兜底）。 */
export function headerCwd(file: string): string | undefined {
  try {
    const buf = Buffer.alloc(8192);
    const fd = openSync(file, "r");
    try {
      const n = readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.toString("utf8", 0, n).split("\n")) {
        if (line === "") continue;
        let parsed: { type?: unknown; cwd?: unknown };
        try {
          parsed = JSON.parse(line) as { type?: unknown; cwd?: unknown };
        } catch {
          return undefined; // 截断行/坏行止损（header 恒在文件头部——首坏行即无 header 可读）
        }
        if (parsed.type !== "session/header") continue;
        const cwd = parsed.cwd;
        return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
      }
      return undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined; // 坏行/无 header——调用方兜底
  }
}

/** 桶 → cwd 反查（惰性、缓存）：桶内任一会话（mtime 序首个可读者）的 session/header 行 cwd。
 *  T18 走查修：undefined 不再缓存——fresh 会话盘上只有 mcp/manifest（header 懒写），首查必 miss；
 *  桶名对 cwd 双射的前提是「读到过 header」，miss 时缓存会让该桶在本进程生命期内恒 ""（用户发出
 *  首条消息、header 落盘后也不自愈）。miss 重试的盘读成本被 snapshot 1s TTL 门住（每次快照至多一轮）。 */
export function bucketCwd(root: string, bucket: string): string | undefined {
  const key = `${root}\u0000${bucket}`;
  if (cwdCache.has(key)) return cwdCache.get(key);
  reads++;
  let cwd: string | undefined;
  for (const e of scanBucketSessions(join(root, bucket))) {
    cwd = headerCwd(e.file);
    if (cwd !== undefined) break;
  }
  if (cwd !== undefined) cwdCache.set(key, cwd); // 只缓存成功读（失败见上注——fresh 桶待 header 落盘后自愈）
  return cwd;
}
