import type { SessionEvent, SessionStore } from "./types.ts";

/** fork 复合存储（D41）：投影 = 父会话截至 atEntryId（含）的前缀 + 自身追加；写只进 own。
 *  零复制——父文件只读；append-only 与"每事件唯一 id"两条不变量都不破坏（复制方案两条都破坏）。 */
export class ForkedSessionStore implements SessionStore {
  readonly sessionId: string;
  private readonly parentStore: SessionStore;
  private readonly atEntryId?: string | undefined;
  private readonly ownStore: SessionStore;
  private parentCache: SessionEvent[] | undefined;

  constructor(opts: { parent: SessionStore; atEntryId?: string; own: SessionStore }) {
    this.parentStore = opts.parent;
    this.ownStore = opts.own;
    this.atEntryId = opts.atEntryId;
    this.sessionId = opts.own.sessionId;
  }

  async all(): Promise<SessionEvent[]> {
    if (this.parentCache === undefined) {
      let events = await this.parentStore.all();
      if (this.atEntryId !== undefined) {
        const i = events.findIndex((e) => e.id === this.atEntryId);
        if (i >= 0) events = events.slice(0, i + 1);
        // 找不到 atEntryId → 全量父前缀（宽松降级；孤儿结果由投影防御性跳过，链问题由 verifyChain 报告）
      }
      this.parentCache = events;
    }
    return [...this.parentCache, ...(await this.ownStore.all())];
  }

  append(type: string, fields?: Record<string, unknown>): Promise<SessionEvent> {
    return this.ownStore.append(type, fields);
  }

  flush(): Promise<void> {
    return this.ownStore.flush();
  }

  async close(): Promise<void> {
    await this.ownStore.close();
    await this.parentStore.close(); // 幂等——fork 自活会话时父 store 归旧 harness，双关无害
  }
}

/** 祖先链深度上限（会话树批 T1）：超限就地截断——防御性降级优于崩溃（同款宽松降级哲学见 all() 的 atEntryId 注释）。 */
const FORK_CHAIN_MAX_DEPTH = 32;

/** 打开「会话的完整视图」（会话树批 T1——链式 fork 断代修复）：目标会话若是 fork 子体，递归拼装
 *  「祖先链投影 + 自身段」。祖先按 header.parentSession 逐级上溯（每层经 locate 定位所在桶——同桶链
 *  hint 快路径、跨桶存量链全根扫描兜底），分叉点取该层 session/fork.sourceEntryId（fork 即刻落盘保证
 *  恒在自己文件前两行）；深度上限 32 + 已访问集合防环（超限/成环就地截断并 warn）。祖先文件找不到 =
 *  就地截断（只用最近可得的段）——链缺口由 verifyChain 报告，调用方看到的是「最近可得的完整投影」。
 *  async 原因：读祖辈元数据须等 store.all()（jsonl 构造期全读、all() 出内存镜像）。 */
export async function openSessionView(opts: {
  /** 目标会话 id（顶层由调用方保证存在——不存在时 all() 为空、按裸 store 返回，父前缀为空，与旧语义一致）。 */
  sessionId: string;
  /** 目标会话所在桶目录（store 构造的 dir 参数语义是桶，D46）。 */
  bucket: string;
  makeStore: (sessionId: string, bucket: string) => SessionStore;
  /** 祖先定位：返回祖先所在桶；找不到 undefined = 截断（通常 = dir.ts locateSessionBucket 包一层）。 */
  locate: (sessionId: string) => { bucket: string } | undefined;
  sink?: { warn: (code: string, msg: string, data?: Record<string, unknown>) => void };
}): Promise<{ store: SessionStore; chain: string[] }> {
  const chain: string[] = []; // 自上而下祖先 id 链（诊断日志用）
  const visited = new Set<string>();
  const openFrom = async (sessionId: string, bucket: string, depth: number): Promise<SessionStore> => {
    const store = opts.makeStore(sessionId, bucket);
    const own = await store.all();
    const header = own.find((e) => e.type === "session/header");
    const forkEvent = own.find((e) => e.type === "session/fork");
    chain.unshift(sessionId);
    const parentId = (header as { parentSession?: unknown } | undefined)?.parentSession;
    if (header === undefined || parentId === null || parentId === undefined || forkEvent === undefined) return store; // 非子体：裸 store 原样返回
    const parent = String(parentId);
    if (depth >= FORK_CHAIN_MAX_DEPTH || visited.has(parent)) {
      opts.sink?.warn("session.fork-chain-truncated", depth >= FORK_CHAIN_MAX_DEPTH ? `祖先链深超 ${FORK_CHAIN_MAX_DEPTH}，就地截断` : "祖先链成环，就地截断", { sessionId, parentSession: parent });
      return store;
    }
    visited.add(sessionId);
    const parentLoc = opts.locate(parent);
    if (parentLoc === undefined) {
      opts.sink?.warn("session.fork-parent-missing", "祖代会话文件找不到，就地截断（最近可得的段）", { sessionId, parentSession: parent });
      return store;
    }
    const parentView = await openFrom(parent, parentLoc.bucket, depth + 1);
    const at = (forkEvent as { sourceEntryId?: unknown }).sourceEntryId;
    return new ForkedSessionStore({ parent: parentView, ...(typeof at === "string" ? { atEntryId: at } : {}), own: store });
  };
  return { store: await openFrom(opts.sessionId, opts.bucket, 0), chain };
}

/** 读侧自修复 pass（§6.1，D41）：parentId 链断裂 / seq 非单调 / 孤儿 tool/result / 未闭合 tool/call
 *  ——返回问题描述清单（调用方 sink.warn 逐条诊断；可自动修复的撕裂尾部归 repairFile）。 */
export function verifyChain(events: SessionEvent[]): string[] {
  const issues: string[] = [];
  // 根分段（首轮 P1）：fork 复合投影 = parent(seq 1..M) + own(seq 1..N、首条 parentId=null)——
  // 逐条校验必误报。以根事件（parentId=null 且 header）分段，段内校验链/seq；孤儿与未闭合 call 按段配对
  const segments: SessionEvent[][] = [];
  let current: SessionEvent[] = [];
  for (const e of events) {
    if (e.parentId === null && e.type === "session/header" && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push(e);
  }
  if (current.length > 0) segments.push(current);
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) {
      const prev = seg[i - 1]!;
      const e = seg[i]!;
      if (e.parentId !== prev.id) issues.push(`parentId 链断裂：seq ${e.seq}（${e.type}）的 parentId 指向 ${e.parentId ?? "null"}，前一条是 ${prev.id}`);
      if (e.seq <= prev.seq) issues.push(`seq 非单调：seq ${e.seq}（${e.type}）未超过前一条 ${prev.seq}`);
    }
  }
  const seenCalls = new Set<string>();
  const results = new Set<string>();
  for (const e of events) {
    if (e.type === "tool/call") seenCalls.add(String(e.callId));
    if (e.type === "tool/result") {
      const callId = String(e.callId);
      if (!seenCalls.has(callId)) issues.push(`孤儿 tool/result：callId ${callId} 无对应的 tool/call（截断/损坏片段）`);
      results.add(callId);
    }
  }
  for (const callId of seenCalls) {
    if (!results.has(callId)) issues.push(`未闭合 tool/call：callId ${callId} 缺 tool/result`);
  }
  return issues;
}
