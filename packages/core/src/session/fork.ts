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
