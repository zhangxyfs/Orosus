import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isSafeSessionId, scanBucketSessions } from "./dir.ts";
import { pidAlive, readLockPid } from "./jsonl.ts";
import { isEmptySessionHead, readSessionHead, readSqliteHead } from "./tree.ts";

/** 删除整个会话目录（2026-10-01 用户拍板清理批）：<sid>/ 连带 agents/ 主文件与锁、db/、spill/ 一并清。
 *  调用方保证会话已关（store close 后无句柄——Windows 下活句柄会让 rmSync 失败）。id 先过 CS-12 格式闸。
 *  目录不存在 = 幂等 false。删除失败抛错由调用方定口径（清理是尽力而为面，不该炸启动）。 */
export function purgeSessionDir(bucketDir: string, sessionId: string): boolean {
  if (!isSafeSessionId(sessionId)) return false;
  const dir = join(bucketDir, sessionId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 空会话清扫结果：removed = 已清目录名；locked = 空壳但在他实例占用中跳过（活锁 pid）。 */
export interface EmptySessionSweep {
  removed: string[];
  locked: string[];
}

/** 单桶空会话清扫（2026-10-01 用户拍板）：启动时清掉上次异常退出残留的 0 消息壳（正常退出由退出漏斗
 *  就地清，走不到这的才是这里的对象）。判定 = isEmptySessionHead；活锁（锁在且持有 pid 活着——他实例
 *  正开着这个空会话）跳过防误删，stale 锁（持有者已死）照清。单会话读失败/删除失败跳过不炸整体——
 *  清扫是尽力而为面。keep = 显式豁免（如 --resume 即将打开的目标）。 */
export function sweepEmptySessions(bucketDir: string, keep: ReadonlySet<string> = new Set()): EmptySessionSweep {
  const out: EmptySessionSweep = { removed: [], locked: [] };
  for (const e of scanBucketSessions(bucketDir)) {
    if (keep.has(e.id)) continue;
    // 后端分读（sqlite 误杀防线）：readSessionHead 是 jsonl 读法——直接啃 sqlite 二进制会行行解析失败、
    // 把有内容的会话误判成空。sqlite 后端走 readSqliteHead；库不可用/打不开 = undefined = 不判不清。
    const head = e.file.endsWith(".sqlite") ? readSqliteHead(e.file) : readSessionHead(e.file);
    if (head === undefined || !isEmptySessionHead(head)) continue;
    const lockPid = readLockPid(join(e.dir, "agents", "session.lock"));
    if (lockPid !== null && pidAlive(lockPid)) {
      out.locked.push(e.id);
      continue;
    }
    try {
      if (purgeSessionDir(bucketDir, e.id)) out.removed.push(e.id);
    } catch {
      /* Windows 句柄残留等瞬时占用——跳过，下次启动再试 */
    }
  }
  return out;
}
