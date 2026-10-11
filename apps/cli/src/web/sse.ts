/** SSE 通道（web 批 T3）——帧写器 + 每会话客户端注册表 + 事件回放，浏览器与 server 的实时动脉。
 *  - 唯一订阅扇出（GC3/§4-3）：HostedSession 是 core events()/liveChunks() 的唯一订阅者；本件在
 *    HostedSession 的 onEvent/onChunk/onQueue 订阅口之上向 N 个 SSE 客户端扇出——每 HostedSession
 *    一个客户端注册表（Set），禁止每连接各订 core 通道。
 *  - 单条写串行化 Promise 链（qwen sse-events 先例）：每客户端一切帧（首帧组/backfill/ev/chunk/
 *    interaction/queue/phase/心跳）都经同一链排队——不串行化会内存无界 + 帧字节交错；每次帧体 = 单次
 *    res.write（帧内无交错），res.write()===false → await drain 与 close/error 竞争，写超时 >30s
 *    逐出清理（自创值登记——慢客户端不拖垮进程）。
 *  - 注册先于快照（brief 明文）：新连接先入扇出注册表（后续帧全部经写链排队 = 缓冲模式）再取 after
 *    之后回放段（HostedSession.replayAfter——ring 快路径 + 全量 history() 兜底），快照与 live 帧按
 *    seq 去重后依次写出（先快照后注册会在两步之间漏事件）。
 *  - 帧序纪律（§3）：ev/interaction/queue/phase 等直发帧写出前先 flush 该客户端挂起的 chunk 合批
 *    （50ms 窗不得造成「转正 ev 先于末批 chunk」乱序）；chunk 廉价 markdown 昂贵——每客户端每窗至多
 *    一帧（§5 律二，kimi/qwen 先例）。
 *  - id 纪律（§3）：ev 帧独占 `id: <seq>`（断线重连带 after 续传的游标锚）；其余帧型不带 id 不烧号。
 *  - interaction 重放（dsh 先例「刷新后审批卡还在」）：pending 集合由 T5 bridge-ui 持有，本件只留
 *    重放源注册口（SSE 每次（重）连接回调拉取重发原帧）与 live 直发口。
 *  - 心跳 15s（unref）；首帧组 retry: 3000 + `: connected`（防中间层掐零字节空闲流——qwen/dsh 先例）；
 *    响应头 X-Accel-Buffering: no + Cache-Control: no-cache。 */
import type { ServerResponse } from "node:http";
import type { SessionEvent } from "@orosus/core";
import type { BtwFrame, HostedSession } from "./hosted.ts";

/** 自创值登记（方案 §5 表——改值先查那里）：SSE chunk 合批 50ms flush、首帧 retry 提示 3000ms、
 *  心跳 15s（unref）、写超时 >30s 逐出。测试经 configureSseTimers 注入短窗（心跳/写超时）。 */
export interface SseTimers {
  /** 心跳间隔（`: ping` 注释帧；unref）。 */
  pingMs: number;
  /** chunk 合批 flush 窗（每客户端每窗至多一帧）。 */
  chunkFlushMs: number;
  /** 单帧写超时（drain 不来即逐出断开）。 */
  writeTimeoutMs: number;
}

export const SSE_TIMERS: SseTimers = { pingMs: 15_000, chunkFlushMs: 50, writeTimeoutMs: 30_000 };

/** 测试注入面：心跳/写超时/合批窗的短窗覆写（afterEach 复原——见 sse.test.ts）。 */
export function configureSseTimers(over: Partial<SseTimers>): void {
  Object.assign(SSE_TIMERS, over);
}

/** interaction 帧载荷（§3：{"id","kind","title","items"?,"values"?,"text"?,"secret"?}——形状由 T5
 *  bridge-ui 定，本件宽 Record 透传）。 */
export type InteractionPayload = Record<string, unknown> & { id: string };

/** pending interaction 重放源（T5 持有 pending 集合；SSE 每次（重）连接时回调拉取重发原帧）。 */
type InteractionSource = () => InteractionPayload[];

const interactionSources = new WeakMap<HostedSession, InteractionSource>();

// ---------- 客户端注册表（每 HostedSession 一个 Set） ----------

/** 单客户端状态：写串行化链 + chunk 合批缓冲 + 去重游标 + 订阅退订口。 */
interface SseClient {
  res: ServerResponse;
  hs: HostedSession;
  /** 单条写串行化链：一切帧 + 心跳过链（帧间序 = 入链序）。 */
  chain: Promise<void>;
  /** 挂起的 chunk 合批文本（50ms 窗内拼接，一次成帧）。 */
  chunkBuf: string;
  /** 挂起的 btw 批（累积式——窗内后到覆盖先到，一次成帧；§5 律二同款降频）。 */
  btwBuf: BtwFrame | undefined;
  chunkTimer: NodeJS.Timeout | undefined;
  pingTimer: NodeJS.Timeout | undefined;
  /** 已写出最新 ev seq——快照段与 live 帧的去重锚（注册先于快照的竞争窗由此兜住）。 */
  lastSeq: number;
  closed: boolean;
  /** hs 三订阅退订（断连/逐出时全摘）。 */
  unsubs: Array<() => void>;
}

const fanouts = new Map<HostedSession, Set<SseClient>>();

/** 注册表现存客户端数（测试 introspection——背压逐出断言用）。 */
export function sseClientCount(hs: HostedSession): number {
  return fanouts.get(hs)?.size ?? 0;
}

// ---------- 帧写器 ----------

/** SSE 帧写出（§3 形状）：`id:` 行仅 ev 帧携带（唯一带 id 的帧型——其余帧不烧号）；一次调用 = 单次
 *  res.write = 完整一帧（帧内无交错）。返回 res.write 结果——false = 写缓冲满，调用方进 drain 竞争。 */
export function writeFrame(res: ServerResponse, event: string, data: unknown, id?: number): boolean {
  const head = id !== undefined ? `id: ${id}\n` : "";
  return res.write(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 写任务：单帧写出 + 背压处理（write()===false → await drain 与 close/error/写超时竞争——胜者
 *  drain 则继续，连接死/超时则逐出清理）。 */
const writeTask = (c: SseClient, frame: () => boolean): Promise<void> => {
  if (c.closed) return Promise.resolve();
  const backpressure = frame();
  return backpressure ? Promise.resolve() : drainOrEvict(c);
};

/** drain 竞争（qwen 先例）：drain 到来 → 续写；close/error → 逐出；写超时（>30s，自创值登记）→
 *  逐出断开——慢消费者不拖垮进程（server 内存有界：链停在首帧满缓冲处，不再累积 socket 写入）。 */
const drainOrEvict = (c: SseClient): Promise<void> =>
  new Promise((resolve) => {
    if (c.closed) {
      resolve();
      return;
    }
    let settled = false;
    const done = (evict: boolean): void => {
      if (settled) return;
      settled = true;
      c.res.off("drain", onDrain);
      c.res.off("close", onDown);
      c.res.off("error", onDown);
      clearTimeout(timer);
      if (evict) dropClient(c);
      resolve();
    };
    const onDrain = (): void => done(false);
    const onDown = (): void => done(true);
    const timer = setTimeout(() => done(true), SSE_TIMERS.writeTimeoutMs);
    timer.unref?.();
    c.res.once("drain", onDrain);
    c.res.once("close", onDown);
    c.res.once("error", onDown);
  });

/** 入链（单条写串行化）：任务异常 = 客户端不可写——逐出清理且链不断（后续任务过 closed 检查即 no-op）。 */
const enqueue = (c: SseClient, task: () => Promise<void> | void): void => {
  c.chain = c.chain.then(task).catch(() => dropClient(c));
};

/** 摘注册 + 停计时器 + 退订 + 断连接（幂等；不写帧）。 */
const detachClient = (c: SseClient): void => {
  if (c.closed) return;
  c.closed = true;
  for (const off of c.unsubs.splice(0)) {
    try { off(); } catch { /* 退订不炸 */ }
  }
  if (c.chunkTimer !== undefined) {
    clearTimeout(c.chunkTimer);
    c.chunkTimer = undefined;
  }
  if (c.pingTimer !== undefined) {
    clearInterval(c.pingTimer);
    c.pingTimer = undefined;
  }
  c.chunkBuf = "";
  c.btwBuf = undefined;
  const set = fanouts.get(c.hs);
  if (set !== undefined) {
    set.delete(c);
    if (set.size === 0) fanouts.delete(c.hs); // 空注册表项即回收——强引用不随会话累积
  }
};

const dropClient = (c: SseClient): void => {
  detachClient(c);
  try { c.res.destroy(); } catch { /* 已断 */ }
};

// ---------- chunk 专用 50ms 合批（§5 律二） ----------

const armChunkFlush = (c: SseClient): void => {
  if (c.chunkTimer !== undefined) return;
  c.chunkTimer = setTimeout(() => {
    c.chunkTimer = undefined;
    flushChunkBatch(c);
  }, SSE_TIMERS.chunkFlushMs);
  c.chunkTimer.unref?.();
};

/** 落地挂起的 chunk 批：一次成帧入链（取消计时器——窗提前关）。btw 批同窗落地（累积式覆盖——
 *  一次成帧；§3 帧型表外新增帧面，T6 报告登记）。 */
const flushChunkBatch = (c: SseClient): void => {
  if (c.chunkTimer !== undefined) {
    clearTimeout(c.chunkTimer);
    c.chunkTimer = undefined;
  }
  const text = c.chunkBuf;
  if (text !== "" && !c.closed) {
    c.chunkBuf = "";
    enqueue(c, () => writeTask(c, () => writeFrame(c.res, "chunk", { text })));
  }
  const btw = c.btwBuf;
  if (btw !== undefined && !c.closed) {
    c.btwBuf = undefined;
    enqueue(c, () => writeTask(c, () => writeFrame(c.res, "btw", btw)));
  }
};

/** 直发帧（ev/interaction/queue/phase/shutdown 前置的帧序纪律）：先 flush 该客户端挂起的 chunk 批
 *  再入链（两任务同链——序 = 入链序），杜绝「转正 ev 先于末批 chunk」。 */
const sendDirect = (c: SseClient, event: string, data: unknown, id?: number): void => {
  flushChunkBatch(c);
  enqueue(c, () => writeTask(c, () => writeFrame(c.res, event, data, id)));
};

/** ev 帧（唯一带 id 的帧型）：入链期与任务期双重 seq 去重（快照段可能已覆盖 live 帧——注册先于
 *  快照的竞争窗）。 */
const sendEv = (c: SseClient, e: SessionEvent): void => {
  if (e.seq <= c.lastSeq) return;
  flushChunkBatch(c);
  enqueue(c, () => {
    if (e.seq <= c.lastSeq || c.closed) return;
    c.lastSeq = e.seq;
    return writeTask(c, () => writeFrame(c.res, "ev", e, e.seq));
  });
};

/** 快照任务（注册先于快照的后半步）：取 after 之后回放段（HostedSession.replayAfter——ring 快路径
 *  + 全量 history() 兜底）逐帧写出，随后重放仍挂起的 interaction（T5 源）+ 当前相位快照。取数期间
 *  到达的 live 帧已在本任务之后排队（链序），seq 去重兜住重叠——不重不漏。 */
const enqueueSnapshot = (c: SseClient, after: number): void => {
  enqueue(c, async () => {
    if (c.closed) return;
    let snap: SessionEvent[] = [];
    try {
      snap = await c.hs.replayAfter(after);
    } catch { /* 回放失败：保底空段（live 帧照常——重连接 after 续传兜底） */ }
    for (const e of snap) {
      if (c.closed) return;
      if (e.seq <= c.lastSeq) continue;
      c.lastSeq = e.seq;
      if (!writeFrame(c.res, "ev", e, e.seq)) {
        await drainOrEvict(c);
        if (c.closed) return;
      }
    }
    const src = interactionSources.get(c.hs);
    if (src !== undefined) {
      for (const p of src()) {
        if (c.closed) return;
        if (!writeFrame(c.res, "interaction", p)) {
          await drainOrEvict(c);
          if (c.closed) return;
        }
      }
    }
    if (!c.closed && !writeFrame(c.res, "phase", { phase: c.hs.phase(), busy: c.hs.busy() })) {
      await drainOrEvict(c);
    }
  });
};

// ---------- 对外面 ----------

/** SSE 流开启（brief 签名）：首帧组 + 注册进扇出（先于快照）+ 快照段 + live 订阅 + 15s 心跳 +
 *  断连清理。全程同步返回（快照/live 全走写链——缓冲模式）。 */
export function openStream(res: ServerResponse, hs: HostedSession, after: number): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache", // §3 流响应头（与 X-Accel-Buffering 同对——代理层不得缓冲）
    "x-accel-buffering": "no",
  });
  const c: SseClient = {
    res,
    hs,
    chain: Promise.resolve(),
    chunkBuf: "",
    btwBuf: undefined,
    chunkTimer: undefined,
    pingTimer: undefined,
    lastSeq: after, // 重连游标：seq ≤ after 客户端已知——去重锚初值
    closed: false,
    unsubs: [],
  };
  // 注册先于快照（brief 明文）：先入扇出注册表——live 帧经链排队在快照段之后（缓冲模式）
  let set = fanouts.get(hs);
  if (set === undefined) {
    set = new Set();
    fanouts.set(hs, set);
  }
  set.add(c);
  // 首帧组（§3：retry 防中间层掐零字节空闲流 + connected 注释——T2 行为原样）
  enqueue(c, () => writeTask(c, () => res.write("retry: 3000\n: connected\n\n")));
  enqueueSnapshot(c, after);
  // live 订阅（在快照任务之后挂——新事件帧经链排在快照段之后，seq 去重兜住重叠）
  c.unsubs.push(
    hs.onEvent((e) => {
      sendEv(c, e);
      if (e.type === "turn/start" || e.type === "turn/end") {
        sendDirect(c, "phase", { phase: hs.phase(), busy: hs.busy() }); // 相位随 turn 起落
      }
    }),
    hs.onChunk((t) => {
      if (c.closed) return;
      c.chunkBuf += t;
      armChunkFlush(c);
    }),
    hs.onQueue((items) => sendDirect(c, "queue", { items })), // 整表快照帧（多标签一致性）
    hs.onBtw((f) => { // T6 侧问流帧（累积式合批——与主流 chunk 通道分面不串台）
      if (c.closed) return;
      c.btwBuf = f;
      armChunkFlush(c);
    }),
  );
  // 15s 心跳（unref）：注释帧 `: ping`，不带 id/event
  c.pingTimer = setInterval(() => {
    if (c.closed) return;
    enqueue(c, () => writeTask(c, () => c.res.write(": ping\n\n")));
  }, SSE_TIMERS.pingMs);
  c.pingTimer.unref?.();
  res.once("close", () => dropClient(c));
  res.once("error", () => dropClient(c)); // socket 级错误兜底（未监听 error 会炸进程）
}

/** 清退广播（G15，mod.ts onShutdown 消费）：全部客户端写 shutdown 帧 + end（§3 帧型，不带 id）。
 *  T2 行为原样——同步写不走写链（链可能正卡在慢客户端 drain 上；单帧单 write 无帧内交错，帧间乱序
 *  无害——shutdown 是末帧），50ms 拆连接窗在 server.ts CONNECTION_TEARDOWN_MS。 */
export function broadcastShutdownFrames(reason: string): void {
  for (const [hs, set] of Array.from(fanouts)) {
    for (const c of Array.from(set)) {
      detachClient(c);
      try {
        c.res.write(`event: shutdown\ndata: ${JSON.stringify({ reason })}\n\n`);
        c.res.end();
      } catch { /* 已断连接——客户端走重连耗尽判定（G15 兜底） */ }
    }
    fanouts.delete(hs);
  }
}

/** T5 注册 pending interaction 重放源（SSE 每次（重）连接时回调拉取重发原帧——id 复用）。 */
export function setPendingInteractionSource(hs: HostedSession, src: InteractionSource): void {
  interactionSources.set(hs, src);
}

/** 摘除重放源（会话关闭/测试清理）。 */
export function clearPendingInteractionSource(hs: HostedSession): void {
  interactionSources.delete(hs);
}

/** T5 interaction 帧 live 直发（新挂起的 interaction 广播给该会话全部客户端）。 */
export function sendInteractionFrame(hs: HostedSession, payload: InteractionPayload): void {
  const set = fanouts.get(hs);
  if (set === undefined) return;
  for (const c of Array.from(set)) sendDirect(c, "interaction", payload);
}
