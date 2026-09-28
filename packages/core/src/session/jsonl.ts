import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type SessionEvent, type SessionStore } from "./types.ts";
import { scanBucketSessions } from "./dir.ts";

/** POSIX 专属硬化在 Windows 上降级（§6.1）：审计标记，不静默弱化。 */
export function hardeningNote(): string | null {
  return process.platform === "win32" ? "session-hardening: partial (windows)" : null;
}

/** 锁持有者 pid 是否仍活着（CS-03）：signal 0 探活——ESRCH = 已死；EPERM（权限不足/Windows 系统进程）
 *  按活着处理（宁拒勿撞：把活实例误判成 stale 会重新引入双写）。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读锁文件首行 pid（CS-03）：损坏/空文件返回 null——按 stale 回收处理，坏锁文件不许死锁后续打开。 */
function readLockPid(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").split("\n")[0]!.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 崩溃修复（§6.1）：torn tail 截断 + 未闭合 turn 补 turn/end{kind:"interrupted"}。 */
export function repairFile(path: string): { truncated: boolean; interruptedClosed: boolean } {
  if (!existsSync(path)) return { truncated: false, interruptedClosed: false };
  const raw = readFileSync(path, "utf8");
  // 崩溃切口恰好落在换行前：最后一行是合法 JSON（truncated=false）但文件缺尾 \n——不规范化的话，
  // 下一次 append 会把新旧两条记录合并到同一行，再开时按 torn tail 处理、双事件静默丢失
  const needsNewline = raw.length > 0 && !raw.endsWith("\n");
  const lines = raw.split("\n");
  const good: string[] = [];
  let truncated = false;
  for (const line of lines) {
    if (line === "") continue;
    try {
      JSON.parse(line);
      good.push(line);
    } catch {
      truncated = true;
      break; // torn tail：截掉该行及之后一切
    }
  }
  let interruptedClosed = false;
  const events = good.map((l) => JSON.parse(l) as SessionEvent);
  const lastTurnStart = events.map((e, i) => (e.type === "turn/start" ? i : -1)).filter((i) => i >= 0).pop();
  const hasTurnEndAfter = lastTurnStart !== undefined && events.slice(lastTurnStart).some((e) => e.type === "turn/end");
  if (lastTurnStart !== undefined && !hasTurnEndAfter) {
    // 未闭合 turn：先补 turn 内缺 tool/result 的 call（M3/D41——日志里不许出现无结果的 tool/call），
    // 再补 turn/end{interrupted}
    const inTurn = events.slice(lastTurnStart);
    const called = new Set(inTurn.filter((e) => e.type === "tool/call").map((e) => String(e.callId)));
    const resulted = new Set(inTurn.filter((e) => e.type === "tool/result").map((e) => String(e.callId)));
    let last = events[events.length - 1]!;
    for (const callId of called) {
      if (resulted.has(callId)) continue;
      last = {
        v: 1,
        id: newId("e"),
        parentId: last.id,
        seq: last.seq + 1,
        ts: new Date().toISOString(),
        type: "tool/result",
        callId,
        output: "[已中止：工具未执行]",
        isError: true,
      };
      events.push(last);
    }
    events.push({
      v: 1,
      id: newId("e"),
      parentId: last.id,
      seq: last.seq + 1,
      ts: new Date().toISOString(),
      type: "turn/end",
      kind: "interrupted",
    });
    interruptedClosed = true;
  }
  if (truncated || interruptedClosed || needsNewline) {
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  }
  return { truncated, interruptedClosed };
}

/** 单条事件 → usage 增量（CS-06：sumUsage 与 lifetimeUsage 兄弟循环共用同一口径——旧实现两处分支
 *  手工同步，M4.5 引入 session/subagent-usage 时只改了 sumUsage，兄弟循环漏计、与当前会话口径分叉）。
 *  返回 undefined = 该事件无用量。三形态互斥：一事件只属一形态（M4.5 子代理账 + T5/D45 双形态）。 */
export function usageDelta(e: SessionEvent): { input: number; output: number } | undefined {
  // M4.5 子代理批：子代理用量记在主会话账上（session/subagent-usage——不进投影，只进统计）
  if (e.type === "session/subagent-usage") {
    const u = e.usage as { input?: number; output?: number } | undefined;
    return { input: u?.input ?? 0, output: u?.output ?? 0 };
  }
  if (e.type === "assistant/chunk") {
    const c = e.chunk as { type?: string; input?: number; output?: number } | undefined;
    if (c?.type === "usage") return { input: c.input ?? 0, output: c.output ?? 0 };
    return undefined;
  }
  // T5/D45 双形态：新会话 usage 落 assistant/message（断流后无 chunk）；旧会话落 chunk——一事件只属一形态
  if (e.type === "assistant/message") {
    const u = e.usage as { input?: number; output?: number } | undefined;
    if (u !== undefined) return { input: u.input ?? 0, output: u.output ?? 0 };
  }
  return undefined;
}

/** usage 求和（当前会话口径：/usage 与 lifetimeUsage 共用）。 */
export function sumUsage(events: SessionEvent[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const e of events) {
    const d = usageDelta(e);
    if (d !== undefined) {
      input += d.input;
      output += d.output;
    }
  }
  return { input, output };
}

/** 末条真实 usage 的总量（/context 已用回退口径——2026-09-20 用户实测：resume 后运行期锚点为空恒显 ~0）。
 *  与 sumUsage 同双形态口径但取末条非求和：usage 的 input 是该请求的全量上下文足迹，末条即最近上下文规模。 */
export function lastUsageTotal(events: SessionEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "assistant/chunk") {
      const c = e.chunk as { type?: string; input?: number; output?: number } | undefined;
      if (c?.type === "usage") return (c.input ?? 0) + (c.output ?? 0);
      continue;
    }
    if (e.type === "assistant/message") {
      const u = e.usage as { input?: number; output?: number } | undefined;
      if (u !== undefined) return (u.input ?? 0) + (u.output ?? 0);
    }
  }
  return undefined;
}

/** append-only JSONL 后端（§6.1 写入硬化三件套 + 每文件写队列串行化）。
 *  会话树批 T3 目录化：每会话一目录——主文件落 <桶>/<sid>/agents/session.jsonl（决策点 4/16）。
 *  懒建语义保持（D46）：零 append 零落盘，连会话目录也不建；首写时递归建目录（0o700）+ 文件（0o600）。 */
export class JsonlSessionStore implements SessionStore {
  readonly sessionId: string;
  private readonly file: string;
  private readonly dir: string;
  private seq = 0;
  private lastId: string | null = null;
  private queue: Promise<void> = Promise.resolve(); // 每文件写队列：seq 单调的串行化保证（链上永不 reject——见 append 的 CS-02 注）
  private buffer: string[] = [];
  /** 本轮未决 append 的 settle 手柄（CS-02）：drain 结局逐个带回调用方——成功 resolve(event)、失败 reject。 */
  private pending: { event: SessionEvent; resolve: (e: SessionEvent) => void; reject: (err: Error) => void }[] = [];
  private drainError: Error | null = null; // 最近一次 drain 失败：buffer 仍有滞留期间 flush/close 复抛（不许谎报已落盘）
  private events: SessionEvent[] = []; // 内存镜像：all() 供 loop 投影（§6.2）；重开实例时从磁盘恢复
  private closed = false;
  private readonly lockFile: string; // CS-03 单写者锁：<sid>/agents/session.lock（与主文件同目录）
  private lockHeld = false;

  constructor(opts: { dir: string; sessionId?: string }) {
    mkdirSync(opts.dir, { recursive: true }); // 桶目录构造期建（D46 既有语义——装配层保证桶在）
    this.sessionId = opts.sessionId ?? newId("s");
    this.dir = opts.dir;
    this.file = join(opts.dir, this.sessionId, "agents", "session.jsonl");
    this.lockFile = join(opts.dir, this.sessionId, "agents", "session.lock");
    repairFile(this.file);
    if (existsSync(this.file)) {
      this.fileEnsured = true;
      const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const e = JSON.parse(line) as SessionEvent;
        this.seq = e.seq;
        this.lastId = e.id;
        this.events.push(e);
      }
    }
    // M4-1 T0（D46 止血）：文件不再构造期预建——零 append 的临时会话零落盘；首写时 ensureFile 以 0o600 懒建。
    // 既有文件的权限校正与 dev/ino 身份记录保留（POSIX 语义）。
    if (process.platform !== "win32" && existsSync(this.file)) {
      const st = statSync(this.file);
      if ((st.mode & 0o777) !== 0o600) chmodSync(this.file, 0o600);
      // dev/ino 身份校验：记录打开时的身份，防符号链接替换（POSIX 语义）
      this.devIno = `${st.dev}:${st.ino}`;
    }
  }

  private devIno: string | null = null;
  private fileEnsured = false;

  /** 首写前懒建：会话目录 + agents/（0o700，含既有目录权限校正）→ 文件（0o600——构造期预建的权限硬化语义原样移到此处）。
   *  CS-02 顺修：fileEnsured 在 mkdir/open 全部成功后才置位——旧实现先置位再建，一次失败后懒建被永久跳过、追加恒失败。 */
  private ensureFile(): void {
    if (this.fileEnsured) return;
    const sessionDir = join(this.dir, this.sessionId);
    const agentsDir = join(sessionDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    if (process.platform !== "win32") {
      chmodSync(agentsDir, 0o700);
      chmodSync(sessionDir, 0o700); // 既有目录权限校正（决策点 5——目录与文件同档硬化）
    }
    const fd = openSync(this.file, "a", 0o600);
    closeSync(fd);
    if (process.platform !== "win32") chmodSync(this.file, 0o600);
    this.fileEnsured = true;
  }

  /** CS-03（2026-09-28 code review）单写者锁：同一 sessionId 的两个实例并发 append 会从同一尾巴读出
   *  相同 seq/lastId，随后重复 seq + 同 parentId 分岔的两条链交织落盘（O_APPEND 只保证字节不撕裂，管不了
   *  信封层撞号；sqlite 后端有 idx_events_session_seq 唯一索引兜底，jsonl 静默损坏）。锁 = <sid>/agents/
   *  session.lock（O_EXCL 创建，内容 pid + 抢锁时间）。取舍：抢锁放首次 drain（首次落盘）而非构造期——
   *  ① 保 D46 懒建语义（零 append 仍零落盘，连会话目录都不建）；② 只读第二实例（fork 视图/树扫描/测试）
   *  不 append 即不受影响，构造与读路径零变化。持有者活着 → 抛错（append 侧经 CS-02 机制 reject，
   *  等价 sqlite 唯一索引兜底但更早更明确）；已死/锁文件损坏 → stale 回收重建（进程崩溃未 close 的自愈）。
   *  与 CS-02 自愈天然协同：抢锁失败 → 本批 append reject、buffer 保留，另一实例退出后下次 drain 重试成功。 */
  private ensureLock(): void {
    if (this.lockHeld) return;
    const create = (): void => {
      const fd = openSync(this.lockFile, "wx", 0o600);
      try {
        writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
    };
    try {
      create();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = readLockPid(this.lockFile);
      if (pid !== null && pidAlive(pid)) {
        throw new Error(`会话 ${this.sessionId} 已在另一实例打开（pid ${pid}）——双开并发写会 seq 撞号/parentId 链交织；关闭另一实例后重试`, { cause: err });
      }
      // stale 锁（持有者已崩溃退出）或坏锁文件：回收重建。竞争窗口内被他人抢先重建 = 再撞 EEXIST → 上抛，下轮 drain 重试
      rmSync(this.lockFile, { force: true });
      create();
    }
    this.lockHeld = true;
  }

  /** 释放写锁（close 路径）：best-effort——残留锁会被后续打开按 stale（pid 已死）回收。 */
  private releaseLock(): void {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    try {
      rmSync(this.lockFile, { force: true });
    } catch { /* 释放失败留档：stale 回收兜底 */ }
  }

  append(type: string, fields: Record<string, unknown> = {}): Promise<SessionEvent> {
    if (this.closed) return Promise.reject(new Error("store closed"));
    // 信封字段最终生效（同 InMemory：fields 不得打穿 v/id/parentId/seq/ts/type）
    const event: SessionEvent = {
      ...fields,
      v: 1,
      id: newId("e"),
      parentId: this.lastId,
      seq: ++this.seq,
      ts: new Date().toISOString(),
      type,
    };
    this.lastId = event.id;
    this.events.push(event); // 入队即入镜像：all()/投影不等落盘（§6.7 前半——UI 可见性不构成持久化承诺）
    this.buffer.push(JSON.stringify(event) + "\n");
    // CS-02 修复（2026-09-28 code review）：旧实现 queue 只链 .then 且 append 即刻假成功——drain 一次抛错
    // （盘满/文件被占/prune 删档）后 queue 永久 rejected：后续 drain 全跳过、buffer 滞留内存、每次 append
    // 又在被拒链上挂 .then 产生无人接的 rejection 崩进程。现在 drain 的结局收拢到本批 pending：
    // 失败时 append reject（错误带内到调用侧——与 store closed 同一 reject 约定，不假成功；模块面
    // fire-and-forget 由 kernel 包装 catch 进诊断），事件保留在 buffer/镜像（已转发不回滚，seq/parentId
    // 链不破），下一次 append 的 drain 原样重试——盘恢复后自愈落盘。队列链本身永不 reject。
    const settled = new Promise<SessionEvent>((resolve, reject) => {
      this.pending.push({ event, resolve, reject });
    });
    this.queue = this.queue
      .then(() => this.drain())
      .then(
        () => this.settlePending(undefined),
        (err: unknown) => this.settlePending(err),
      );
    return settled;
  }

  /** drain 结局分发给本批 pending append：成功逐个 resolve（事件已落盘）；失败统一 reject 并保留 buffer
   *  待下次 drain 重试（drain 内 throw 均为同步 fs 错误，此处只收拢、不向上抛——队列不因写失败毒化）。 */
  private settlePending(err: unknown): void {
    const batch = this.pending;
    this.pending = [];
    if (err === undefined) {
      this.drainError = null;
      for (const p of batch) p.resolve(p.event);
      return;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    this.drainError = e;
    for (const p of batch) p.reject(e);
  }

  private drain(): void {
    if (this.buffer.length === 0) return;
    this.ensureFile(); // 首写懒建（T0）——权限 0o600 与原构造期预建语义一致
    this.ensureLock(); // CS-03：首写抢单写者锁（幂等；写队列串行内调用，实例内无竞态）
    if (this.devIno !== null && process.platform !== "win32") {
      const st = statSync(this.file);
      if (`${st.dev}:${st.ino}` !== this.devIno) throw new Error("log file replaced (symlink attack?)");
    }
    appendFileSync(this.file, this.buffer.join(""));
    this.buffer = [];
  }

  all(): Promise<SessionEvent[]> {
    return Promise.resolve([...this.events]);
  }

  /** 跨会话累计（/usage 口径修复：重启后此前会话的用量不归零）。当前会话取内存镜像——
   *  buffer 可能未 drain；其余会话读盘，坏行（torn tail）跳过不炸。会话数按文件计（有用量才算）。
   *  fork 子体整文件跳过（M4-2 T4/B3）：header.parentSession 非空 = fork 子体，其 usage 不入累计
   *  ——lineage 以父计（cc-haha 同款）；当前会话自身是子体时同样跳过（父文件仍在同桶被计入）。
   *  会话树批 T4：兄弟枚举改「本桶全会话目录 agents/ 内 session.jsonl」（scanBucketSessions 统一件）——
   *  口径不变，只换路径方式（决策点 13）。 */
  async lifetimeUsage(): Promise<{ input: number; output: number; sessions: number }> {
    let input = 0;
    let output = 0;
    let sessions = 0;
    const ownHeader = this.events[0];
    const ownParent = (ownHeader as { parentSession?: unknown } | undefined)?.parentSession;
    const ownIsForkChild = ownHeader !== undefined && ownHeader.type === "session/header"
      && ownParent !== null && ownParent !== undefined;
    if (!ownIsForkChild) {
      const u = sumUsage(this.events);
      input += u.input;
      output += u.output;
      if (u.input > 0 || u.output > 0) sessions++;
    }
    const siblings = scanBucketSessions(this.dir)
      .filter((e) => e.file.endsWith(".jsonl") && e.id !== this.sessionId) // 当前会话已按内存镜像计（或为 fork 子体跳过）
      .toSorted((a, b) => a.id.localeCompare(b.id));
    for (const sibling of siblings) {
      let fileInput = 0;
      let fileOutput = 0;
      let isForkChild = false;
      let seenFirst = false;
      for (const line of readFileSync(sibling.file, "utf8").split("\n")) {
        if (line === "") continue;
        let e: SessionEvent;
        try {
          e = JSON.parse(line) as SessionEvent;
        } catch {
          continue; // 他会话 torn tail：累计值不因坏行中断
        }
        if (!seenFirst) {
          seenFirst = true;
          const ps = (e as { parentSession?: unknown }).parentSession;
          if (e.type === "session/header" && ps !== null && ps !== undefined) isForkChild = true;
        }
        if (isForkChild) continue; // 子体整文件跳过——含 sessions 计数
        // CS-06（2026-09-28 code review）：兄弟循环改走 usageDelta 共用口径——旧内联分支只有 chunk/message
        // 两形态，session/subagent-usage 行落穿不计：重启后 /usage 项目累计丢失所有历史会话的子代理用量，
        // 而当前会话照计（sumUsage 有该分支）——同一天数字随重启跳变。与 torn-tail 跳坏行的容错需求不冲突
        //（坏行在上方 JSON.parse 即 continue，到达不了这里）。
        const d = usageDelta(e);
        if (d !== undefined) {
          fileInput += d.input;
          fileOutput += d.output;
        }
      }
      if (isForkChild) continue;
      input += fileInput;
      output += fileOutput;
      if (fileInput > 0 || fileOutput > 0) sessions++;
    }
    return { input, output, sessions };
  }

  async flush(): Promise<void> {
    await this.queue; // 队列链永不 reject（失败收拢在 settlePending）——但 buffer 仍有滞留 = 落盘未完成
    if (this.buffer.length > 0) throw this.drainError ?? new Error("session log 未落盘（drain 失败后滞留）");
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.queue;
      if (this.buffer.length > 0) throw this.drainError ?? new Error("session log 未落盘（drain 失败后滞留）");
    } finally {
      this.releaseLock(); // CS-03：close 后本 store 永不再写——锁必须释放（哪怕落盘失败在抛错）
    }
  }
}
