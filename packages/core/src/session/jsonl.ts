import { appendFileSync, chmodSync, closeSync, constants, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, readSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { newId, type SessionEvent, type SessionStore } from "./types.ts";
import { isSafeSessionId, scanBucketSessions } from "./dir.ts";
import { openSessionDbReadOnly, sqliteAvailable } from "./sqlite.ts";
import { eventsFrom, lastCompaction, scanEventLines, writeEventRows, type ScanLine } from "./eventindex.ts";

/** T7 装载分流阈（D6：cc SKIP_PRECOMPACT_THRESHOLD 同值 5MB）——小于此走全量快路径（零行为变化）。 */
const WINDOW_LOAD_MIN_BYTES = 5 * 1024 * 1024;
/** T7 头种子预算（D7：readSessionHead 的 HEAD_MAX_BYTES=16KB 同值——tree.ts:11 沿用）。 */
const HEAD_SEED_BYTES = 16 * 1024;

/** CS-07（2026-09-28 code review）：追加路径的打开旗标——POSIX 用数值 O_APPEND|O_NOFOLLOW|O_CREAT
 *  （§6.1「写入硬化三件套」(b) 承诺的 O_NOFOLLOW：字符串旗标表达不了，须数值组合；符号链接终点直接
 *  ELOOP 拒开），Windows 无 O_NOFOLLOW 等价物、降级字符串 "a"（hardeningNote 同款审计口径）。纯函数
 *  （platform 可注入）——跨平台可测。 */
export function sessionAppendFlag(platform: NodeJS.Platform = process.platform): string | number {
  if (platform === "win32") return "a";
  return constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | constants.O_CREAT; // O_NOFOLLOW 个别宿主未定义 → 0（退化为 O_APPEND|O_CREAT，不炸）
}

/** CS-07：硬化追加——POSIX 数值旗标路径经 fd 写（appendFileSync 的 options.flag 类型只收字符串，数值
 *  组合开不了），O_APPEND 保证偏移原子；mode 0o600 只在建文件时生效（活会话文件被外部删除后重建不再
 *  落到 umask 缺省 0o644——硬化静默丢失的次级后果）。 */
function appendHardened(file: string, data: string): void {
  const flags = sessionAppendFlag();
  if (typeof flags === "string") {
    appendFileSync(file, data, { flag: flags, mode: 0o600 });
    return;
  }
  const fd = openSync(file, flags, 0o600);
  try {
    const buf = Buffer.from(data, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
}

/** POSIX 专属硬化在 Windows 上降级（§6.1）：审计标记，不静默弱化。 */
export function hardeningNote(): string | null {
  return process.platform === "win32" ? "session-hardening: partial (windows)" : null;
}

/** 锁持有者 pid 是否仍活着（CS-03）：signal 0 探活——ESRCH = 已死；EPERM（权限不足/Windows 系统进程）
 *  按活着处理（宁拒勿撞：把活实例误判成 stale 会重新引入双写）。
 *  2026-10-01 起导出：空会话清扫（cleanup.ts）复用同款判活——锁在且持有者活着 = 他实例占用，跳过不清。 */
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
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").split("\n")[0]!.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 未闭合 turn 补结尾（repairFile 与 T7 窗口装载共用的纯函数段）：最后一个 turn/start 之后若无
 *  turn/end，先补 turn 内缺 tool/result 的 call（M3/D41——日志里不许出现无结果的 tool/call）再补
 *  turn/end{kind:"interrupted"}。输入事件序列不修改，返回应补事件（可能为空）。 */
function synthesizeUnclosed(events: SessionEvent[]): SessionEvent[] {
  const synthesized: SessionEvent[] = [];
  const lastTurnStart = events.map((e, i) => (e.type === "turn/start" ? i : -1)).filter((i) => i >= 0).pop();
  const hasTurnEndAfter = lastTurnStart !== undefined && events.slice(lastTurnStart).some((e) => e.type === "turn/end");
  if (lastTurnStart !== undefined && !hasTurnEndAfter) {
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
      synthesized.push(last);
    }
    const end: SessionEvent = {
      v: 1,
      id: newId("e"),
      parentId: last.id,
      seq: last.seq + 1,
      ts: new Date().toISOString(),
      type: "turn/end",
      kind: "interrupted",
    };
    events.push(end);
    synthesized.push(end);
  }
  return synthesized;
}

/** 崩溃修复（§6.1）：torn tail 截断 + 未闭合 turn 补 turn/end{kind:"interrupted"}。
 *  CS-11（2026-09-28 code review）：修复动作改为「最小写面」——旧实现一旦要修就 writeFileSync 全文覆写，
 *  覆写中途再崩溃丢整段会话历史；且 openSessionView 上溯祖先时每层构造 JsonlSessionStore 都触发修复性
 *  改写（读意图写盘、暴露面随链长放大）。现在：torn tail 用 ftruncate 原地截断（字节偏移精确到坏行起点）、
 *  补事件/补缺尾换行用 appendFileSync 追加——任何时刻崩溃只留下「更短但合法」的文件，下次 repairFile
 *  幂等续修；好行的原始字节一概不动（旧覆写会顺带重排/重序列化，现为保真）。
 *  T1（m5-resume-perf）：opts.raw 免二次读盘（调用方已读内容直接复用）；opts.probeOnly 只探测判断不写盘。
 *  传 raw 时回传 repaired = 修复动作后盘上最终内容（修复态与 raw 不一致——torn tail 截断/补 synthesized
 *  /补尾换行都会改内容；调用方建内存镜像必须用修复后形态，否则 parse 炸/缺事件）。不传 raw 时 repaired
 *  不回传（老调用方零感知，签名向后兼容）。 */
export function repairFile(path: string, opts?: { probeOnly?: boolean; raw?: string }): { truncated: boolean; interruptedClosed: boolean; repaired?: string } {
  if (!existsSync(path)) return { truncated: false, interruptedClosed: false };
  const raw = opts?.raw ?? readFileSync(path, "utf8");
  // 崩溃切口恰好落在换行前：最后一行是合法 JSON（truncated=false）但文件缺尾 \n——不规范化的话，
  // 下一次 append 会把新旧两条记录合并到同一行，再开时按 torn tail 处理、双事件静默丢失
  const needsNewline = raw.length > 0 && !raw.endsWith("\n");
  const lines = raw.split("\n");
  const good: string[] = [];
  let truncated = false;
  let cutChar: number | undefined; // torn tail 起点（raw 内字符偏移；截断长度经 Buffer.byteLength 换算——中文等多字节内容 char≠byte）
  let pos = 0;
  for (const line of lines) {
    const start = pos;
    pos += line.length + 1; // +1 = 行尾 "\n"（末行无换行则越界 1，仅在未被 break 命中时发生、无消费方）
    if (line === "") continue;
    try {
      JSON.parse(line);
      good.push(line);
    } catch {
      truncated = true;
      cutChar = start;
      break; // torn tail：截掉该行及之后一切
    }
  }
  const events = good.map((l) => JSON.parse(l) as SessionEvent);
  const synthesized = synthesizeUnclosed(events);
  const interruptedClosed = synthesized.some((e) => e.type === "turn/end");
  const tail =
    (!truncated && needsNewline ? "\n" : "") + synthesized.map((e) => JSON.stringify(e) + "\n").join("");
  // 修复后盘上最终内容：好行逐行带尾 \n + synthesized 行（ftruncate 截到坏行起点=好行序列、补换行/
  // 补事件都走追加——三种修复动作的乘积恰等于此拼装；未发生修复时盘上内容 = raw 原样，缺尾 \n 也在）
  const wrote = truncated || tail !== "";
  const repaired = opts?.raw === undefined ? undefined : wrote
    ? good.map((l) => l + "\n").join("") + synthesized.map((e) => JSON.stringify(e) + "\n").join("")
    : raw;
  if (opts?.probeOnly) {
    return repaired !== undefined ? { truncated, interruptedClosed, repaired } : { truncated, interruptedClosed };
  }
  if (truncated && cutChar !== undefined) {
    // 原地截断到坏行起点（该点之前必然以 "\n" 收尾或为文件头——截后文件保持行完整性）
    const fd = openSync(path, "r+");
    try {
      ftruncateSync(fd, Buffer.byteLength(raw.slice(0, cutChar), "utf8"));
    } finally {
      closeSync(fd);
    }
  }
  if (tail !== "") appendFileSync(path, tail);
  return repaired !== undefined ? { truncated, interruptedClosed, repaired } : { truncated, interruptedClosed };
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

/** sqlite 兄弟会话的用量聚合（CS-14，2026-09-28 code review）：openSessionDbReadOnly 只读开库（busy_timeout
 *  对齐 store、避免读路径写副作用），全量行走 usageDelta——与 jsonl 兄弟循环同口径（subagent-usage 双形态都计）。
 *  fork 子体判定同 jsonl：首事件 header.parentSession 非空 = 子体整库跳过（lineage 以父计）。
 *  库不可读/无 header/查询报错 = undefined（调用方跳过该会话，坏库不炸累计——torn-tail 跳行同族容错）。 */
function sqliteSiblingUsage(file: string): { input: number; output: number; isForkChild: boolean } | undefined {
  if (!sqliteAvailable()) return undefined;
  const db = openSessionDbReadOnly(file);
  if (db === undefined) return undefined;
  try {
    const headerRow = db.prepare("SELECT json FROM events WHERE type = 'session/header' ORDER BY seq LIMIT 1").get() as { json?: string } | undefined;
    if (headerRow === undefined) return undefined; // 无 header = 非会话库/空库
    const h = JSON.parse(String(headerRow.json)) as { parentSession?: unknown };
    const isForkChild = h.parentSession !== null && h.parentSession !== undefined;
    let input = 0;
    let output = 0;
    for (const row of db.prepare("SELECT json FROM events ORDER BY seq").all() as { json: string }[]) {
      const d = usageDelta(JSON.parse(row.json) as SessionEvent);
      if (d !== undefined) {
        input += d.input;
        output += d.output;
      }
    }
    return { input, output, isForkChild };
  } catch {
    return undefined;
  } finally {
    try { db.close(); } catch { /* 已坏 */ }
  }
}

/** jsonl 兄弟会话用量聚合（T3 从 lifetimeUsage 兄弟循环抽出——与 sqliteSiblingUsage 成对，同挂缓存）。
 *  口径与抽出前逐行等价：usageDelta 双形态、首行 header 判 fork 子体、坏行跳行不炸。读失败（文件竞态
 *  消失）= undefined 跳过——旧实现 readFileSync 无 try 会炸整个 /usage，统一按 sqlite 兄弟同口径容错。 */
function jsonlSiblingUsage(file: string): { input: number; output: number; isForkChild: boolean } | undefined {
  let input = 0;
  let output = 0;
  let isForkChild = false;
  let seenFirst = false;
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return undefined;
  }
  for (const line of lines) {
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
    const d = usageDelta(e);
    if (d !== undefined) {
      input += d.input;
      output += d.output;
    }
  }
  return { input, output, isForkChild };
}

/** T3（m5-resume-perf）：兄弟聚合 (mtime,size) 缓存——append-only 语义下 (mtime,size) 不变 ⇒ 内容不变
 *  （mtime+size 双判，同毫秒坑在档由调用方 utimes 前移兜），命中免读盘：/settings 每开重付 177ms
 *  全语料扫描归零。key=文件路径；agg 为 undefined 也记键（坏库/消失的结果同样缓存，mtime 变才重试）。 */
const usageCache = new Map<string, { mtimeMs: number; size: number; agg: { input: number; output: number; isForkChild: boolean } | undefined }>();

/** 兄弟聚合统一入口：mtime+size 双判缓存，miss/变更才重读（jsonl 兄弟逐行 / sqlite 兄弟开库）。 */
function siblingUsageCached(file: string): { input: number; output: number; isForkChild: boolean } | undefined {
  let mtimeMs: number;
  let size: number;
  try {
    const st = statSync(file);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    return undefined; // 文件消失（竞态）——跳过该兄弟
  }
  const hit = usageCache.get(file);
  if (hit !== undefined && hit.mtimeMs === mtimeMs && hit.size === size) return hit.agg;
  const agg = file.endsWith(".sqlite") ? sqliteSiblingUsage(file) : jsonlSiblingUsage(file);
  usageCache.set(file, { mtimeMs, size, agg });
  return agg;
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

  constructor(opts: { dir: string; sessionId?: string; load?: "window" | "full"; index?: { dbFile: string; bucket: string } }) {
    const sid = opts.sessionId ?? newId("s");
    // CS-12（2026-09-28 code review）：sessionId 直接进 join(this.dir, sid, "agents", "session.jsonl")——
    // 旧实现无格式校验，"../escaped" 类 id 一次 append 即在桶外建目录与文件（--resume 旗标无存在性/格式闸
    // 直透 makeStore 到此处，实测桶外逃逸）。不合形响亮抛错（真实 id 形态 s_<base32>/agents_<编号> 天然通过）。
    if (!isSafeSessionId(sid)) throw new Error(`会话 id 非法：${JSON.stringify(sid)}（只许 [A-Za-z0-9] 且首字符为字母数字——防桶逃逸，CS-12）`);
    mkdirSync(opts.dir, { recursive: true }); // 桶目录构造期建（D46 既有语义——装配层保证桶在）
    this.sessionId = sid;
    this.dir = opts.dir;
    this.file = join(opts.dir, this.sessionId, "agents", "session.jsonl");
    this.lockFile = join(opts.dir, this.sessionId, "agents", "session.lock");
    // T7（m5-resume-perf）：装载策略分派——缺省 full（core 层显式 opt-in 窗口，测试可控；harness 装配层
    // 按 OROSUS_SESSION_LOAD 与文件大小决定）。窗口路径失败兜底 = 全量（等价不可证=回退全量，宁慢不错）。
    if ((opts.load ?? "full") === "window") {
      this.loadViaWindow(opts.index);
    } else {
      this.loadFull();
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

  /** 装载结果口径（只读口——验收门 7 耗时埋点 mode 的数据源：loadMode 两态分不清索引路与嗅探路）。 */
  private _loadMode: "window" | "full" = "full";
  private _loadPath: "index" | "sniff" | "full" = "full";
  /** 窗口装载的降级原因（T11 埋点 fallback 字段与 diag 数据源）：legacy-compaction = v2/v3 老格式
   *  无条件回退；no-compaction = ≥5MB 但无压缩点（窗口无从定位，语义上应全量）；index-drift = 索引
   *  路径 pread 坏行/段不符（降级嗅探或全量）。 */
  private _loadFallback: string | undefined = undefined;
  get loadMode(): "window" | "full" { return this._loadMode; }
  get loadPath(): "index" | "sniff" | "full" { return this._loadPath; }
  get loadFallback(): string | undefined { return this._loadFallback; }

  /** 全量装载（=T1 合读后的现状代码原样）：repairFile(file,{raw}) 修复 + 全行 parse 入镜像。 */
  private loadFull(): void {
    const raw = existsSync(this.file) ? readFileSync(this.file, "utf8") : undefined;
    const rep = repairFile(this.file, raw !== undefined ? { raw } : undefined);
    if (raw !== undefined) {
      this.fileEnsured = true;
      const lines = (rep.repaired ?? raw).split("\n").filter(Boolean);
      for (const line of lines) {
        const e = JSON.parse(line) as SessionEvent;
        this.seq = e.seq;
        this.lastId = e.id;
        this.events.push(e);
      }
    }
    this._loadMode = "full";
    this._loadPath = "full";
  }

  /** 窗口装载分流（T7 三层的①）：文件不存在/为空 = 空镜像同现状；< 5MB 全量快路径（D6——零行为
   *  变化，小会话整读零风险零收益）；≥ 5MB 先索引路径、不可用走前向嗅探备胎。 */
  private loadViaWindow(index?: { dbFile: string; bucket: string }): void {
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      return; // 文件不存在 = 空镜像（与全量路径一致）
    }
    if (size === 0) return;
    if (size < WINDOW_LOAD_MIN_BYTES) {
      this.loadFull();
      return;
    }
    if (index !== undefined && sqliteAvailable()) {
      const lc = lastCompaction(index.dbFile, index.bucket, this.sessionId, this.file);
      if (lc !== undefined && lc.v4 && this.loadIndexed(index, lc)) return;
    }
    this.loadSniffed(index);
  }

  /** 头种子（D7）：首 16KB 预算读，取 header/label/fork 三类（fork 子体的 header+fork 恒在文件前两
   *  行——T11 祖先链判据依赖；只读后半段会丢标题与 fork 元数据）。预算内逐行 parse，其余类型跳过。 */
  private readHeadSeeds(): SessionEvent[] {
    const seeds: SessionEvent[] = [];
    let fd: number;
    try {
      fd = openSync(this.file, "r");
    } catch {
      return seeds;
    }
    try {
      const buf = Buffer.alloc(HEAD_SEED_BYTES);
      const n = readSync(fd, buf, 0, HEAD_SEED_BYTES, 0);
      for (const line of buf.toString("utf8", 0, n).split("\n")) {
        if (line === "") continue;
        try {
          const e = JSON.parse(line) as SessionEvent;
          if (e.type === "session/header" || e.type === "session/label" || e.type === "session/fork") seeds.push(e);
        } catch { /* 预算内坏行跳过 */ }
      }
    } catch {
      return seeds;
    } finally {
      closeSync(fd);
    }
    return seeds;
  }

  /** 索引路径（T7 三层之②主路）：lastCompaction 已判 v4 → 头种子 + eventsFrom(压缩 seq) 连续段
   *  pread 逐行 parse → 镜像 = 种子 + 压缩事件起全部尾事件（前面字节零接触）。任一坏行/段不符 =
   *  false（调用方降级嗅探——装载永不因索引坏而死）。 */
  private loadIndexed(index: { dbFile: string; bucket: string }, lc: { byteOffset: number; seq: number; v4: boolean }): boolean {
    const segs = eventsFrom(index.dbFile, index.bucket, this.sessionId, lc.seq);
    if (segs.length === 0) return false;
    const lastSeg = segs[segs.length - 1]!;
    const lastEnd = lastSeg.byteOffset + lastSeg.byteLength;
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      return false;
    }
    // 新鲜度铁律（2026-10-05 复核修——严重数据丢失路径）：索引段必须精确到 EOF 才可用。陈旧索引
    // （索引后文件又追加了事件——祖先链无预刷新护送即达）下按旧 lastEnd 装载会把新事件静默丢出
    // 镜像、且 repairWindowTail 会把它们当好撕裂尾 ftruncate 掉。不符 → false 走嗅探（重扫自愈：
    // 嗅探读的是文件本体，撕裂尾判断不受索引影响，并顺手重写索引）。
    if (size !== lastEnd) return false; // 变矮=外物截断；变高=索引落后（追加未追平）——都降级
    const tail: SessionEvent[] = [];
    let fd: number;
    try {
      fd = openSync(this.file, "r");
    } catch {
      return false;
    }
    try {
      for (const seg of segs) {
        const buf = Buffer.alloc(seg.byteLength);
        const n = readSync(fd, buf, 0, seg.byteLength, seg.byteOffset);
        if (n !== seg.byteLength) return false;
        for (const line of buf.toString("utf8").split("\n")) {
          if (line === "") continue;
          try {
            tail.push(JSON.parse(line) as SessionEvent);
          } catch {
            return false; // 坏行 = 漂移 → 降级嗅探
          }
        }
      }
    } finally {
      closeSync(fd);
    }
    const seeds = this.readHeadSeeds().filter((s) => s.seq < lc.seq);
    this.events = [...seeds, ...tail];
    this.repairWindowTail(lastEnd);
    const last = this.events[this.events.length - 1];
    if (last !== undefined) {
      this.seq = last.seq;
      this.lastId = last.id;
    }
    this.fileEnsured = true;
    this._loadMode = "window";
    this._loadPath = "index";
    return true;
  }

  /** 前向嗅探备胎（T7 三层之③，v1.1 算法 + 顺手建索引）：scanEventLines 1MB 块前向扫——header/label/
   *  fork 入种子；turn/compaction 必 parse（v4 → 累积器清零为 [该事件]；v2/v3 → 无条件中止转全量——
   *  即使老格式是文件末条，窗口投影也会因 keepUserAt 下标全部越界被滤只剩 summaryMsg、保留消息静默
   *  丢失）；压缩点之前的其余行瞄一眼就跳过不 parse（D11——最终未见过压缩点则本来就该全量）；
   *  压缩点之后的行 parse 入累积器。扫描产出 (offset,length,type) 顺手写进事件索引（D14 ①装载路径
   *  重建——本次备胎、下次索引）。 */
  private loadSniffed(index?: { dbFile: string; bucket: string }): void {
    const seeds: SessionEvent[] = [];
    let acc: SessionEvent[] = [];
    let seenCompaction = false;
    let lastEnd = 0;
    let aborted = false;
    let abortReason: string | undefined;
    const rows: ScanLine[] = [];
    for (const line of scanEventLines(this.file, 0)) {
      rows.push(line);
      lastEnd = line.byteOffset + line.byteLength + 1;
      if (line.type === "session/header" || line.type === "session/label" || line.type === "session/fork") {
        try {
          seeds.push(JSON.parse(line.bytes.toString("utf8")) as SessionEvent);
        } catch { /* 种子坏行跳过（修复后下次补） */ }
      } else if (line.type === "turn/compaction") {
        let ev: SessionEvent;
        try {
          ev = JSON.parse(line.bytes.toString("utf8")) as SessionEvent;
        } catch {
          continue; // 压缩行本身撕裂：不入窗（修复后下次刷新补）；继续扫更晚的压缩点
        }
        if (!Array.isArray(ev.keptUsers)) {
          aborted = true; // v2/v3 老格式：无条件回退全量（doc-review 二轮勘正定案）
          abortReason = "legacy-compaction";
          break;
        }
        acc = [ev];
        seenCompaction = true;
      } else if (seenCompaction) {
        try {
          acc.push(JSON.parse(line.bytes.toString("utf8")) as SessionEvent);
        } catch {
          continue; // 窗内坏行跳过（全量路径的 repairFile 会处置撕裂尾；中段坏行两路径同吞）
        }
      }
      // 压缩点之前的非种子行：跳过不 parse（D11「瞄一眼就跳过」）
    }
    if (aborted || !seenCompaction) {
      this._loadFallback = aborted ? abortReason : "no-compaction";
      // T7③「顺手建索引」补（2026-10-05 全量对账）：无压缩路径扫描已完整（EOF 达成）——落行让翻页
      // 免走 ③ 兜底；legacy-abort 路径行集不完整（扫至老格式即断）不落（③ 单会话补建覆盖）。
      if (!aborted && index !== undefined && sqliteAvailable()) {
        try {
          const st = statSync(this.file);
          writeEventRows(index.dbFile, index.bucket, this.sessionId, rows, { mtimeMs: st.mtimeMs, size: st.size, indexedBytes: lastEnd });
        } catch { /* 索引 best-effort */ }
      }
      this.loadFull();
      return;
    }
    const compactionSeq = acc[0]!.seq;
    this.events = [...seeds.filter((s) => s.seq < compactionSeq), ...acc];
    this.repairWindowTail(lastEnd);
    const last = this.events[this.events.length - 1];
    if (last !== undefined) {
      this.seq = last.seq;
      this.lastId = last.id;
    }
    this.fileEnsured = true;
    this._loadMode = "window";
    this._loadPath = "sniff";
    // D14 ①装载路径重建：扫描产出顺手落索引（一遍扫描两用）——下次装载走索引路径
    if (index !== undefined && sqliteAvailable()) {
      try {
        const st = statSync(this.file);
        writeEventRows(index.dbFile, index.bucket, this.sessionId, rows, { mtimeMs: st.mtimeMs, size: st.size, indexedBytes: lastEnd });
      } catch { /* 索引 best-effort：失败不挡装载 */ }
    }
  }

  /** 窗口装载的尾部修复（D8——坏行恒在尾）：镜像装载止于最后完好行（lastGoodEnd），其后内容 =
   *  撕裂尾 → ftruncate 原地截断；未闭合 turn 补结尾按镜像判定（turn/start 在窗内可判；更早的
   *  start 窗外不可见——全量装载的 repairFile 幂等续修兜底）。修复动作照旧（ftruncate/append）。 */
  private repairWindowTail(lastGoodEnd: number): void {
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    if (size > lastGoodEnd) {
      const fd = openSync(this.file, "r+");
      try {
        ftruncateSync(fd, lastGoodEnd);
      } finally {
        closeSync(fd);
      }
    }
    const synthesized = synthesizeUnclosed(this.events);
    if (synthesized.length > 0) {
      appendFileSync(this.file, synthesized.map((e) => JSON.stringify(e) + "\n").join(""));
      const last = this.events[this.events.length - 1];
      if (last !== undefined) {
        this.seq = last.seq;
        this.lastId = last.id;
      }
    }
  }

  private devIno: string | null = null;
  private fileEnsured = false;

  /** 首写前懒建：会话目录 + agents/（0o700，含既有目录权限校正）→ 文件（0o600——构造期预建的权限硬化语义原样移到此处）。
   *  CS-02 顺修：fileEnsured 在 mkdir/open 全部成功后才置位——旧实现先置位再建，一次失败后懒建被永久跳过、追加恒失败。
   *  CS-07 顺修：打开用 sessionAppendFlag（POSIX = O_APPEND|O_NOFOLLOW|O_CREAT——懒建/重建不再吃符号链接），
   *  建成即 statSync 补记 dev/ino——旧实现只记构造期已存在的文件，懒建的新会话（多数会话）终身
   *  devIno === null、drain 的替换校验恒假（§6.1 硬化承诺对新会话零覆盖）。 */
  private ensureFile(): void {
    if (this.fileEnsured) return;
    const sessionDir = join(this.dir, this.sessionId);
    const agentsDir = join(sessionDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    if (process.platform !== "win32") {
      chmodSync(agentsDir, 0o700);
      chmodSync(sessionDir, 0o700); // 既有目录权限校正（决策点 5——目录与文件同档硬化）
    }
    const fd = openSync(this.file, sessionAppendFlag(), 0o600);
    closeSync(fd);
    if (process.platform !== "win32") {
      chmodSync(this.file, 0o600);
      const st = statSync(this.file);
      this.devIno = `${st.dev}:${st.ino}`; // 懒建同样记录身份
    }
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
    appendHardened(this.file, this.buffer.join("")); // CS-07：O_NOFOLLOW 数值旗标（POSIX）+ 重建兜底 mode 0o600
    this.buffer = [];
  }

  all(): Promise<SessionEvent[]> {
    return Promise.resolve([...this.events]);
  }

  /** T8（m5-resume-perf）懒升级：窗口镜像整文件重读替换为全量并置 loadMode="full"（幂等——全量态
   *  noop，二调零读盘）。all() 契约不变；append 续写锚随镜像末条推进（全量末条=窗口末条=文件真实
   *  末条，链无缝）。撕裂尾防御：首条坏行即止（append-only 保证坏只可能在尾）。 */
  async ensureFull(): Promise<void> {
    if (this._loadMode === "full") return;
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return; // 文件消失（极端竞态）——保持现镜像
    }
    const events: SessionEvent[] = [];
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      let e: SessionEvent;
      try {
        e = JSON.parse(line) as SessionEvent;
      } catch {
        break; // 撕裂尾恒在尾——其后无好行
      }
      events.push(e);
    }
    this.events = events;
    const last = events[events.length - 1];
    if (last !== undefined) {
      this.seq = last.seq;
      this.lastId = last.id;
    }
    this._loadMode = "full";
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
      .filter((e) => e.id !== this.sessionId) // 当前会话已按内存镜像计（或为 fork 子体跳过）
      .toSorted((a, b) => a.id.localeCompare(b.id));
    for (const sibling of siblings) {
      // CS-14（2026-09-28 code review）：旧 filter 只留 .jsonl——sessionStore 从 jsonl 切 sqlite 后同桶并存
      // 两种后端（tree.test「混合后端同树共览」明确支持），/usage 项目累计静默丢掉全部 sqlite 会话。两后端
      // 统一走 siblingUsageCached（T3：mtime+size 双判缓存——append-only 下命中免读盘，177ms 重付归零；
      // 口径 usageDelta + fork 子体跳过不变）。
      const agg = siblingUsageCached(sibling.file);
      if (agg === undefined || agg.isForkChild) continue; // 子体整文件/库跳过——含 sessions 计数
      input += agg.input;
      output += agg.output;
      if (agg.input > 0 || agg.output > 0) sessions++;
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
