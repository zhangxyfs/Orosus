import { isSafeSessionId } from "./dir.ts";
import type { SessionEvent, SessionStore } from "./types.ts";

/** fork 复合存储（D41）：投影 = 父会话截至 atEntryId（含）的前缀 + 自身追加；写只进 own。
 *  零复制——父文件只读；append-only 与"每事件唯一 id"两条不变量都不破坏（复制方案两条都破坏）。 */
export class ForkedSessionStore implements SessionStore {
  readonly sessionId: string;
  private readonly parentStore: SessionStore;
  private readonly atEntryId?: string | undefined;
  /** CS-05（2026-09-28 code review）：atEntryId 在父投影中找不到时的降级口径——默认 throw（活 API 语义），
   *  "fullPrefix" 只属盘上链重建（openSessionView——撕裂/截断后 sourceEntryId 可能已不在父投影）。 */
  private readonly onMissing: "throw" | "fullPrefix";
  private readonly ownStore: SessionStore;
  private parentCache: SessionEvent[] | undefined;
  /** CS-10（2026-09-28 code review）：own 后端带 lifetimeUsage（jsonl）才透传——条件挂载与 forwardingStore
   *  「缺省不挂」同款（types.ts 注：内存/SQLite 后端可缺省，调用方回退当前会话口径；声明须可选属性，
   *  exactOptionalPropertyTypes 下「缺席」≠「值为 undefined」）。own 是 JsonlSessionStore 时天然带 fork
   *  子体跳过口径（子体自身不计、父文件按兄弟计入），语义恰好正确；旧实现不透传——fork 会话存活期间
   *  h.usage() 的 lifetime 恒 undefined，退出再 resume 又出现，两种口径无说明。 */
  readonly lifetimeUsage?: NonNullable<SessionStore["lifetimeUsage"]>;

  constructor(opts: { parent: SessionStore; atEntryId?: string; onMissing?: "throw" | "fullPrefix"; own: SessionStore }) {
    this.parentStore = opts.parent;
    this.ownStore = opts.own;
    this.atEntryId = opts.atEntryId;
    this.onMissing = opts.onMissing ?? "throw";
    this.sessionId = opts.own.sessionId;
    if (opts.own.lifetimeUsage !== undefined) {
      const own = opts.own;
      this.lifetimeUsage = () => own.lifetimeUsage!(); // 经对象调用保 this（解构裸函数会丢接收者）
    }
  }

  async all(): Promise<SessionEvent[]> {
    if (this.parentCache === undefined) {
      let events = await this.parentStore.all();
      if (this.atEntryId !== undefined) {
        const i = events.findIndex((e) => e.id === this.atEntryId);
        // CS-05（2026-09-28 code review）：旧实现找不到 atEntryId 无条件宽松降级全量父前缀——运行期出口
        // （h.fork）早已校验并钉为 bug 口径（fork.test「防宽松降级静默变全量前缀」），启动期出口
        // （createHarness fork 分支、subagent forkFrom）却静默吞坏分叉点，两出口校验不对称。默认改为 throw
        // 统一口径；盘上链重建（openSessionView）显式传 onMissing:"fullPrefix" 保持宽容（见构造器注）。
        if (i < 0) {
          if (this.onMissing === "throw") throw new Error(`fork 分叉点不在父会话投影内：${this.atEntryId}`);
        } else {
          events = events.slice(0, i + 1);
        }
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
    // CS-04 修复（2026-09-28 code review）：旧判据四条全中才拼装（含 session/fork 事件在场）——但 header 与
    // session/fork 是两次独立 append（两次 drain 批次间可崩溃），撕裂尾部切断 session/fork 行时 repairFile
    // 也会把它当 torn tail 截掉，两种形态都留下「header{parentSession} 在场、fork 事件缺席」的子体文件；
    // 打开它被当根会话、父前缀静默丢失，verifyChain 不报（自身段链内自洽），而树视图（只看 header.
    // parentSession）仍显示它有父——行为自相矛盾。放宽为 header.parentSession 非空即按子体上溯；fork 事件
    // 缺席时以全量父前缀投影 + warn 显式留痕（比静默退化为自身段好）。
    if (header === undefined || parentId === null || parentId === undefined) return store; // 非子体：裸 store 原样返回
    const parent = String(parentId);
    // CS-12（2026-09-28 code review）：parentSession 出自文件内容（可篡改面）——旧实现直接交给 locate/
    // makeStore 的路径 join，含 "../" 段可逃逸会话桶（实测桶外建目录文件）。不合形按「找不到祖先」处理
    //（截断 + warn），不炸打开。
    if (!isSafeSessionId(parent)) {
      opts.sink?.warn("session.fork-parent-invalid", `header.parentSession 非法（${JSON.stringify(parent)}），按找不到祖先处理、就地截断`, { sessionId, parentSession: parent });
      return store;
    }
    if (forkEvent === undefined) {
      opts.sink?.warn("session.fork-event-missing", "fork 事件缺失（header 与 session/fork 两次 append 间的崩溃窗口，或撕裂尾被 repairFile 截断），按全量父前缀投影", { sessionId, parentSession: parent });
    }
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
    const at = forkEvent === undefined ? undefined : (forkEvent as { sourceEntryId?: unknown }).sourceEntryId;
    // CS-05：onMissing:"fullPrefix" 显式保留盘上链重建的宽容降级——sourceEntryId 指向的事件可能已被
    // 撕裂截断/修复移出父投影，此时按全量父前缀投影优于让会话打不开（活 API 出口走默认 throw）。
    return new ForkedSessionStore({ parent: parentView, ...(typeof at === "string" ? { atEntryId: at } : {}), onMissing: "fullPrefix", own: store });
  };
  return { store: await openFrom(opts.sessionId, opts.bucket, 0), chain };
}

/** 读侧自修复 pass（§6.1，D41）：parentId 链断裂 / seq 非单调 / 孤儿 tool/result / 未闭合 tool/call
 *  ——返回问题描述清单（调用方 sink.warn 逐条诊断；可自动修复的撕裂尾部归 repairFile）。
 *  T5（m5-resume-perf）窗口头感知：windowedHead:true 时每段允许一处「种子尾→窗口首」接缝——窗口镜像
 *  装载（T7）的事件首条 parentId 合法指向窗外（文件前段未读入），按子段根切分豁免该对、两侧各自校验；
 *  每段只豁免第一处（接缝按构造唯一），窗口体内的真断链照报；seq 单调与孤儿配对不受影响。缺省不传
 *  = 与全量校验逐字节一致（既有调用零感知）。
 *  豁免粒度=每段一次而非仅首段（方案字面是「首段」）：T11 祖先链同窗口装载时，fork 投影每代一段、
 *  各有一条自己的接缝——只豁免首段会让子代段误报（单会话镜像两口径等价）。 */
export function verifyChain(events: SessionEvent[], opts?: { windowedHead?: boolean }): string[] {
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
    let junctionLeft = opts?.windowedHead === true; // 本段接缝豁免额度（窗口态才有一处，用掉即关门）
    for (let i = 1; i < seg.length; i++) {
      const prev = seg[i - 1]!;
      const e = seg[i]!;
      if (e.parentId !== prev.id) {
        if (junctionLeft) {
          junctionLeft = false;
          continue; // 接缝：本对跳过（parentId 越窗 + seq 跨接缝两类都不查），从 e 起按新子段校验
        }
        issues.push(`parentId 链断裂：seq ${e.seq}（${e.type}）的 parentId 指向 ${e.parentId ?? "null"}，前一条是 ${prev.id}`);
      }
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
