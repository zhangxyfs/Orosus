/** 会话单写者锁小件（CS-03 基座 + m5-collab T1 扩建）：从 jsonl.ts 抽出供 jsonl/sqlite 两后端共用
 *  （D6——锁语义不随后端漂移：同路径 <sid>/agents/session.lock、同首次落盘抢锁、同死 pid 回收、
 *  同 close 释放）。T1 三件增量：
 *  ① 裸 Error → SessionLockedError（结构化 holder {pid, since, label?}——文案要的「对方是谁」进类型，
 *     最终用户文案由 CLI 渲染层 t() 从 holder 组装〔D16：core 协议层不带最终文案，message 只作诊断兜底〕）；
 *  ② 锁载荷第三行补 label（可选——抢锁时点快照；无 label 历史维持旧两行格式，老读者 readLockPid 不受影响）；
 *  ③ sqlite 后端补同款锁（此前双开裸奔，仅 idx_events_session_seq 唯一索引兜撞号）。
 *  语义不变量（CS-03 原注照承）：抢锁放首次落盘而非构造期——只读打开永不锁；持有者活着 →
 *  SessionLockedError；已死/锁文件损坏 → stale 回收重建；与 CS-02 自愈协同（抢锁失败 buffer 保留，
 *  对方退出后下次 drain 重试成功自动续写）。 */

import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export const SESSION_LOCK_FILE = "session.lock";

/** 锁持有者 pid 是否仍活着（CS-03）：signal 0 探活——ESRCH = 已死；EPERM（权限不足/Windows 系统进程）
 *  按活着处理（宁拒勿撞：把活实例误判成 stale 会重新引入双写）。
 *  2026-10-01 起导出：空会话清扫（cleanup.ts）复用同款判活——锁在且持有者活着 = 他实例占用，跳过不清。
 *  （本件自 jsonl.ts 迁入〔m5-collab T1 抽锁小件〕，jsonl.ts 转出口保持原表面不动。） */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读锁文件首行 pid（CS-03）：损坏/空文件返回 null——按 stale 回收处理，坏锁文件不许死锁后续打开。 */
export function readLockPid(file: string): number | null {
  return readLockHolder(file)?.pid ?? null;
}

/** 锁载荷（谁、何时、标题——Reasonix SessionLeaseInfo 化用；label 为第三行可选段）。 */
export interface LockHolder {
  pid: number;
  since: string; // 抢锁时刻 ISO 串
  label?: string | undefined; // 抢锁时点会话标题快照（无 label 历史 = undefined——陈旧补全走 live.json，见 T6）
}

/** 读锁载荷：两行旧锁（label 缺）与三行新锁通吃；损坏/空文件/首行 pid 非法 → null（按 stale 回收）。 */
export function readLockHolder(file: string): LockHolder | null {
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return null;
  }
  const pid = Number.parseInt((lines[0] ?? "").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const since = (lines[1] ?? "").trim();
  const label = (lines[2] ?? "").trim();
  return { pid, since, ...(label !== "" ? { label } : { label: undefined }) };
}

/** 撞锁结构化错误（T1）：holder 为对方锁载荷实读——CLI 渲染层据此 t() 组装人话文案（pid/since/label）。 */
export class SessionLockedError extends Error {
  readonly holder: LockHolder;
  constructor(holder: LockHolder) {
    super(`会话正被另一个 Orosus 进程使用（pid ${holder.pid}，起于 ${holder.since}${holder.label !== undefined ? `，标题「${holder.label}」` : ""}）`);
    this.name = "SessionLockedError";
    this.holder = holder;
  }
}

/** 单写者锁（O_EXCL 创建，0o600）：实例级状态（held）+ 盘上互斥（文件在 = 有人写）。 */
export class SessionWriteLock {
  private held = false;
  constructor(private readonly lockFile: string) {}

  get isHeld(): boolean {
    return this.held;
  }

  /** 抢锁（幂等——已持有 noop）：label 为抢锁时点标题快照（可选；只在创建那刻写入，事后改名不重写——
   *  陈旧标题由消费侧按 pid 查 live.json 补全〔T6〕，锁文件不做活更新）。 */
  acquire(label?: string): void {
    if (this.held) return;
    const create = (): void => {
      const fd = openSync(this.lockFile, "wx", 0o600);
      try {
        // label 压平成单行（载荷逐行格式：pid / since / label?——标题含换行会撕裂行格式）
        const flat = label?.replace(/\s*\n\s*/g, " ").trim();
        writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}${flat !== undefined && flat !== "" ? `\n${flat}` : ""}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
    };
    try {
      create();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLockHolder(this.lockFile);
      if (holder !== null && pidAlive(holder.pid)) throw new SessionLockedError(holder);
      // stale 锁（持有者已崩溃退出）或坏锁文件：回收重建。竞争窗口内被他人抢先重建 = 再撞 EEXIST → 上抛，下轮 drain 重试
      rmSync(this.lockFile, { force: true });
      create();
    }
    this.held = true;
  }

  /** 释放（close 路径）：best-effort——残留锁会被后续打开按 stale（pid 已死）回收。 */
  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      rmSync(this.lockFile, { force: true });
    } catch { /* 释放失败留档：stale 回收兜底 */ }
  }
}
