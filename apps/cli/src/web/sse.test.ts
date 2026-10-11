/** web 批 T3 伴生测试：SSE 通道与事件回放——brief ①-⑨ 逐条 + 路由层真栈（GET events 分页 + stream 集成）。
 *  机制层（①-⑨）：裸 node:http server 直挂 openStream + HostedSession（注入 pushable fake harness
 *  ——T2 makeFakeHarness 先例）——真 socket 真帧流，事件/chunk/queue/interaction 注入全手工可控；
 *  路由层：runWebSubcommand 真栈（T2 ⑨ 同款 handover 托管）盖 GET events 分页形状、stream 首帧组与
 *  backfill、404 面。心跳/写超时经 configureSseTimers 注入短窗（brief ③⑧ 明文），50ms 合批窗保持
 *  生产值（⑥ 的硬计数断言在生产窗口下成立）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeCwd, JsonlSessionStore, type Harness, type SessionEvent } from "@orosus/core";
import type { CommandUi } from "@orosus/contracts/module";
import type { Chunk } from "@orosus/contracts/provider";
import { HostedSession } from "./hosted.ts";
import {
  clearPendingInteractionSource, configureSseTimers, openStream, sendInteractionFrame,
  setPendingInteractionSource, SSE_TIMERS, sseClientCount,
} from "./sse.ts";
import { runWebSubcommand, webHostPool } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";

/** 轮询等待（20ms 步进；超时抛错）。 */
const waitFor = async (pred: () => boolean, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor 超时");
};

/** 无头 CommandUi（T2 测试同款——T5 WebCommandUi 接位前的事实形态）。 */
const headlessUi: CommandUi = {
  ask: async () => { throw new Error("无交互环境（headless）"); },
  askSecret: async () => { throw new Error("无交互环境（headless）"); },
  choose: async () => { throw new Error("无交互环境（headless）"); },
  confirm: async () => { throw new Error("无交互环境（headless）"); },
};

/** pushable fake harness：events()/liveChunks() 为可外部投喂的驻留队列；history 为可注入异步工厂
 *  （④ 的连接期并发注入靠 gate 住 history 取数窗）；其余成员 T2 makeFakeHarness 同款无头面。 */
const makePushHarness = (history: () => Promise<SessionEvent[]>): {
  h: Harness;
  pushEvent: (e: SessionEvent) => void;
  pushChunk: (t: string) => void;
} => {
  let stopped = false;
  const evQ: SessionEvent[] = [];
  const evWaiters: Array<() => void> = [];
  const chQ: Chunk[] = [];
  const chWaiters: Array<() => void> = [];
  const iterate = <T>(q: T[], ws: Array<() => void>): AsyncGenerator<T> => (async function* () {
    for (;;) {
      while (q.length > 0) yield q.shift()!;
      if (stopped) return;
      await new Promise<void>((r) => { ws.push(r); });
    }
  })();
  const h: Harness = {
    sessionId: "s_push",
    prompt: async () => undefined,
    cancel: () => {},
    steer: () => false,
    events: () => iterate(evQ, evWaiters),
    history: () => history(),
    ensureHistoryFull: async () => {},
    eventsBefore: async () => [],
    liveChunks: () => iterate(chQ, chWaiters),
    usage: async () => ({ current: { input: 0, output: 0 } }),
    status: () => ({ model: "fake/x", overridden: false, sessionId: "s_push", modules: { active: 0, failed: 0, discovered: 0 } }),
    setLabel: async () => {},
    fork: async () => ({ sessionId: "s_push" }),
    tree: async () => [],
    setModel: async () => {},
    configuredLanguage: () => undefined,
    setLanguage: async () => {},
    setEffort: () => {},
    subagents: () => [],
    answerSubagentApproval: () => false,
    stopAllSubagents: () => {},
    llm: () => { throw new Error("no llm"); },
    pendingConfirms: () => [],
    log: () => {},
    setModuleT: () => {},
    graph: () => ({ bus: { on: () => () => {} } }) as never,
    reload: async () => ({}) as never,
    close: async () => { stopped = true; wakeAll(evWaiters); wakeAll(chWaiters); },
  };
  return {
    h,
    pushEvent: (e) => { evQ.push(e); wakeAll(evWaiters); },
    pushChunk: (t) => { chQ.push({ type: "text/delta", text: t } as Chunk); wakeAll(chWaiters); },
  };
};

/** 种子事件（seq 单调；content 供帧载荷透传断言）。 */
const mkEvent = (seq: number, type = "user/message", extra: Record<string, unknown> = {}): SessionEvent => ({
  v: 1,
  id: `e${seq}`,
  parentId: null,
  seq,
  ts: "2026-10-11T00:00:00.000Z",
  type,
  content: [{ kind: "text", text: `事件${seq}` }],
  ...extra,
});

// ---------- SSE 客户端读取面 ----------

interface SseFrame { id?: number; event?: string; data?: string; comment?: string; retry?: string }

/** 解析完整帧块（\n\n 分隔；末块可能未终结——不解析）。 */
const parseFrames = (raw: string): SseFrame[] => {
  const out: SseFrame[] = [];
  const blocks = raw.split("\n\n");
  for (let i = 0; i < blocks.length - 1; i++) {
    const f: SseFrame = {};
    for (const line of blocks[i]!.split("\n")) {
      if (line.startsWith("id: ")) f.id = Number(line.slice(4));
      else if (line.startsWith("event: ")) f.event = line.slice(7);
      else if (line.startsWith("data: ")) f.data = line.slice(6);
      else if (line.startsWith(": ")) f.comment = line.slice(2);
      else if (line.startsWith("retry: ")) f.retry = line.slice(7);
    }
    out.push(f);
  }
  return out;
};

/** 唤醒驻留生成器的全部等待者（pushable fake harness 用——模块级，避免每调用重建闭包）。 */
const wakeAll = (ws: Array<() => void>): void => {
  for (const w of ws.splice(0)) w();
};

interface SseConn {
  raw: () => string;
  frames: () => SseFrame[];
  ended: Promise<void>;
  destroy: () => void;
}

/** 连接一条 SSE 流（真 socket 真读）；headers 供 token 鉴权（真栈路由用例）。 */
const connectSse = (port: number, path: string, headers: Record<string, string> = {}): SseConn => {
  let buf = "";
  let settle: (() => void) | undefined;
  const ended = new Promise<void>((resolve) => { settle = resolve; });
  const onEnd = (): void => { settle?.(); };
  const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (c: string) => { buf += c; });
    res.on("end", onEnd);
    res.on("error", onEnd);
  });
  req.on("error", onEnd);
  req.end(); // 请求即发（不 end 则永不到达 server）
  return { raw: () => buf, frames: () => parseFrames(buf), ended, destroy: () => { req.destroy(); } };
};

const waitForFrame = async (conn: SseConn, pred: (frames: SseFrame[]) => boolean, ms = 8_000): Promise<SseFrame[]> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const frames = conn.frames();
    if (pred(frames)) return frames;
    if (Date.now() > deadline) throw new Error(`waitForFrame 超时：已收 [${conn.raw()}]`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** 引导门放行形态的 config.toml（T1/T2 测试同款）。 */
const writeProviderConfig = (home: string): void => {
  writeFileSync(join(home, "config.toml"), 'model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "http://127.0.0.1:9"\n', "utf8");
};

describe("web T3：SSE 通道与事件回放", () => {
  const dirs: string[] = [];
  const hostedAll: HostedSession[] = [];
  const servers: Server[] = [];
  let timersDefault: { pingMs: number; chunkFlushMs: number; writeTimeoutMs: number };

  const tmpDir = (pfx: string): string => {
    const d = mkdtempSync(join(tmpdir(), pfx));
    dirs.push(d);
    return d;
  };

  /** 注入式 HostedSession（fake harness + tmp sessionsRoot——presence 落盘不触真实 home）。 */
  const makeHosted = (work: string, historyFn: () => Promise<SessionEvent[]>): {
    hs: HostedSession;
    pushEvent: (e: SessionEvent) => void;
    pushChunk: (t: string) => void;
  } => {
    const push = makePushHarness(historyFn);
    const hs = new HostedSession({ cwd: work, commandUi: headlessUi, harness: push.h, sessionsRoot: join(work, "sessions") });
    hostedAll.push(hs);
    return { hs, pushEvent: push.pushEvent, pushChunk: push.pushChunk };
  };

  /** 裸 SSE server：handler 直挂 openStream（机制层①-⑨——不经路由/鉴权，聚焦通道本身）。 */
  const startBare = (resolve: () => { hs: HostedSession; after: number }): Promise<{ server: Server; port: number }> =>
    new Promise((resolveListen) => {
      const server = createHttpServer((req, res) => {
        const qi = (req.url ?? "").indexOf("?");
        const qs = new URLSearchParams(qi >= 0 ? (req.url ?? "").slice(qi + 1) : "");
        const after = Math.max(0, Number(qs.get("after") ?? "0") || 0);
        const { hs } = resolve();
        openStream(res, hs, after);
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolveListen({ server, port: (server.address() as AddressInfo).port }));
    });

  beforeEach(() => {
    timersDefault = { ...SSE_TIMERS }; // 用例级注入前快照——afterEach 复原（防短窗泄漏到后续用例）
  });

  afterEach(async () => {
    configureSseTimers(timersDefault);
    shutdownWebServer("test-cleanup"); // 真栈用例兜底清退（幂等）
    for (const s of servers.splice(0)) {
      s.close(() => undefined);
      s.closeAllConnections?.(); // SSE 长连接不拖 afterEach
    }
    for (const hs of hostedAll.splice(0)) await hs.close().catch(() => undefined);
    while (dirs.length > 0) {
      const d = dirs.pop()!;
      try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows 句柄迟到则留给系统 tmp 清理 */ }
    }
  });

  it("① 首帧组→backfill→live：retry/connected 先行，after=2 收 seq 3-5 补齐段，live ev 6 在其后", async () => {
    const work = tmpDir("orosus-web-t3-");
    const hist = [1, 2, 3, 4, 5].map((n) => mkEvent(n));
    const { hs, pushEvent } = makeHosted(work, async () => hist.slice());
    await hs.ready;
    const { port } = await startBare(() => ({ hs, after: 2 }));
    const conn = connectSse(port, "/?after=2");

    const fs1 = await waitForFrame(conn, (fs) => fs.some((f) => f.comment === "connected"));
    expect(fs1[0]).toMatchObject({ retry: "3000", comment: "connected" }); // 首帧组（§3 防中间层掐零字节流）
    expect(fs1[0]!.id).toBeUndefined();

    const fs2 = await waitForFrame(conn, (fs) => fs.filter((f) => f.event === "ev").length >= 3);
    expect(fs2.filter((f) => f.event === "ev").map((f) => f.id)).toEqual([3, 4, 5]); // backfill = after 之后段
    expect(JSON.parse(fs2.find((f) => f.event === "ev")!.data!).type).toBe("user/message");

    pushEvent(mkEvent(6)); // live 帧注入
    const fs3 = await waitForFrame(conn, (fs) => fs.some((f) => f.event === "ev" && f.id === 6));
    const evIds = fs3.filter((f) => f.event === "ev").map((f) => f.id);
    expect(evIds).toEqual([3, 4, 5, 6]);
    expect(evIds.indexOf(6)).toBeGreaterThan(evIds.indexOf(5)); // live 严格在补齐段之后
    conn.destroy();
  }, 30_000);

  it("② chunk 帧文本透传：注入增量文本原样到达（多字节 + 换行走 JSON 转义不破帧界）", async () => {
    const work = tmpDir("orosus-web-t3-");
    const { hs, pushChunk } = makeHosted(work, async () => []);
    await hs.ready;
    const { port } = await startBare(() => ({ hs, after: 0 }));
    const conn = connectSse(port, "/?after=0");
    await waitForFrame(conn, (fs) => fs.some((f) => f.comment === "connected"));
    pushChunk("流式增量①△\n第二行");
    const chunkFrames = await waitForFrame(conn, (fr) => fr.some((f) => f.event === "chunk"));
    const chunkFrame = chunkFrames.find((f) => f.event === "chunk")!;
    expect(JSON.parse(chunkFrame.data!)).toEqual({ text: "流式增量①△\n第二行" }); // §3 chunk 帧 {"text"}
    conn.destroy();
  }, 30_000);

  it("③ 心跳（生产 15s——测试注入 60ms 短窗）：注释 ping 帧周期到达、不带 id", async () => {
    configureSseTimers({ pingMs: 60 });
    const work = tmpDir("orosus-web-t3-");
    const { hs } = makeHosted(work, async () => []);
    await hs.ready;
    const { port } = await startBare(() => ({ hs, after: 0 }));
    const conn = connectSse(port, "/?after=0");
    const pingFrames = await waitForFrame(conn, (fr) => fr.filter((f) => f.comment === "ping").length >= 2, 5_000);
    const pings = pingFrames.filter((f) => f.comment === "ping");
    expect(pings.length).toBeGreaterThanOrEqual(2); // 周期性（非一次性）
    for (const p of pings) {
      expect(p.id).toBeUndefined();
      expect(p.event).toBeUndefined();
    }
    conn.destroy();
  }, 30_000);

  it("④ 断线重连 after=latestSeq 不重不漏（连接期并发注入——history 取数窗内的 live 事件不丢不重）", async () => {
    const work = tmpDir("orosus-web-t3-");
    const hist = [1, 2, 3, 4, 5].map((n) => mkEvent(n));
    let releaseHist!: () => void;
    const gate = new Promise<void>((r) => { releaseHist = r; });
    const { hs, pushEvent } = makeHosted(work, async () => { await gate; return hist.slice(); });
    await hs.ready;
    const { port } = await startBare(() => ({ hs, after: 2 }));

    const a = connectSse(port, "/?after=2");
    await waitForFrame(a, (fs) => fs.some((f) => f.comment === "connected")); // 已注册+快照任务已入链（挂在 history gate 上）
    pushEvent(mkEvent(6)); // 并发注入：快照取数窗内的 live 事件——只能排队快照之后（缓冲模式）
    releaseHist();
    const fsA = await waitForFrame(a, (fs) => fs.some((f) => f.event === "ev" && f.id === 6));
    expect(fsA.filter((f) => f.event === "ev").map((f) => f.id)).toEqual([3, 4, 5, 6]); // 快照段 3-5 + live 6，各一次
    a.destroy();

    const b = connectSse(port, "/?after=6"); // 重连：游标 = 已收最新 seq
    pushEvent(mkEvent(7));
    const fsB = await waitForFrame(b, (fs) => fs.some((f) => f.event === "ev" && f.id === 7));
    expect(fsB.filter((f) => f.event === "ev").map((f) => f.id)).toEqual([7]); // 不重（≤6 未再来）不漏（7 到达）
    b.destroy();
  }, 30_000);

  it("⑤ queue/phase 帧随队列/turn 事件发出：入队整表快照、turn 起落 phase running/idle、撤回空表", async () => {
    const work = tmpDir("orosus-web-t3-");
    const { hs, pushEvent } = makeHosted(work, async () => []);
    await hs.ready;
    const { port } = await startBare(() => ({ hs, after: 0 }));
    const conn = connectSse(port, "/?after=0");
    await waitForFrame(conn, (fs) => fs.some((f) => f.comment === "connected"));

    hs.enqueue("排队消息A"); // 入队 → queue 帧整表快照
    const fsQ = await waitForFrame(conn, (fs) => fs.some((f) => f.event === "queue"));
    expect(JSON.parse(fsQ.find((f) => f.event === "queue")!.data!)).toEqual({ items: [{ index: 0, text: "排队消息A" }] });

    pushEvent(mkEvent(1, "turn/start"));
    const fsR = await waitForFrame(conn, (fs) => fs.some((f) => f.event === "phase" && JSON.parse(f.data!).phase === "running"));
    expect(JSON.parse(fsR.find((f) => f.event === "phase" && JSON.parse(f.data!).phase === "running")!.data!)).toEqual({ phase: "running", busy: true });

    pushEvent(mkEvent(2, "turn/end"));
    await waitForFrame(conn, (fs) => fs.some((f) => f.event === "phase" && JSON.parse(f.data!).phase === "idle"));

    expect(hs.withdraw(0)).toBe(true); // 撤回 → 空表快照
    await waitForFrame(conn, (fs) => {
      const qs = fs.filter((f) => f.event === "queue");
      return qs.length >= 2 && JSON.parse(qs[qs.length - 1]!.data!).items.length === 0;
    });

    // 帧序：phase(running) 紧随其 turn/start 的 ev 帧之后
    const fs = conn.frames();
    const evStart = fs.findIndex((f) => f.event === "ev" && f.id === 1);
    const phaseRunning = fs.findIndex((f) => f.event === "phase" && JSON.parse(f.data!).phase === "running");
    expect(evStart).toBeGreaterThanOrEqual(0);
    expect(phaseRunning).toBeGreaterThan(evStart);
    conn.destroy();
  }, 30_000);

  it("⑥ 合批硬断言（§5 律二）：60ms 内注入 100 个小 chunk → chunk 帧数 ≤3 且文本拼接无损", async () => {
    const work = tmpDir("orosus-web-t3-");
    const { hs, pushChunk } = makeHosted(work, async () => []);
    await hs.ready;
    const { port } = await startBare(() => ({ hs, after: 0 }));
    const conn = connectSse(port, "/?after=0");
    await waitForFrame(conn, (fs) => fs.some((f) => f.event === "phase")); // 快照段落定（初始 phase 帧）

    const parts: string[] = [];
    for (let i = 0; i < 100; i++) { // 同步紧凑注入——全部落在 50ms flush 窗内
      const p = `片${i};`;
      parts.push(p);
      pushChunk(p);
    }
    await new Promise((r) => setTimeout(r, 400)); // flush 窗全部落定
    const chunks = conn.frames().filter((f) => f.event === "chunk");
    expect(chunks.length).toBeGreaterThanOrEqual(1); // sanity：确实有帧
    expect(chunks.length).toBeLessThanOrEqual(3); // 硬计数（brief 明文）：合批生效而非 100 帧
    expect(chunks.map((f) => JSON.parse(f.data!).text).join("")).toBe(parts.join("")); // 拼接无损
    conn.destroy();
  }, 30_000);

  it("⑦ id 纪律：ev 帧独占 id（backfill 与 live 同规），chunk/queue/phase/interaction/ping/首帧组不带 id", async () => {
    configureSseTimers({ pingMs: 80 });
    const work = tmpDir("orosus-web-t3-");
    const hist = [1, 2].map((n) => mkEvent(n));
    const { hs, pushEvent, pushChunk } = makeHosted(work, async () => hist.slice());
    setPendingInteractionSource(hs, () => [{ id: "ix1", kind: "confirm", title: "确认吗" }]);
    await hs.ready;
    const { port } = await startBare(() => ({ hs, after: 0 }));
    const conn = connectSse(port, "/?after=0");
    await waitForFrame(conn, (fs) => fs.some((f) => f.comment === "connected"));
    pushEvent(mkEvent(3)); // live ev
    pushChunk("增量");
    hs.enqueue("排队");
    pushEvent(mkEvent(4, "turn/start"));
    pushEvent(mkEvent(5, "turn/end"));
    await waitForFrame(conn, (fs) =>
      fs.some((f) => f.event === "phase") && fs.some((f) => f.comment === "ping")
      && fs.some((f) => f.event === "queue") && fs.some((f) => f.event === "chunk")
      && fs.filter((f) => f.event === "ev").length >= 5);
    const fs = conn.frames();
    for (const f of fs) {
      if (f.id !== undefined) expect(f.event).toBe("ev"); // 带 id 的帧只可能是 ev（其余不烧号）
      if (f.event === "ev") expect(f.id).toBeDefined(); // ev 必带 id: <seq>
      if (f.event !== undefined && f.event !== "ev") expect(f.id).toBeUndefined();
    }
    expect(fs.filter((f) => f.event === "ev").map((f) => f.id)).toEqual([1, 2, 3, 4, 5]); // backfill+live 全带且单调
    conn.destroy();
    clearPendingInteractionSource(hs);
  }, 30_000);

  it("⑧ 背压：慢消费者（不读 socket）写超时逐出断开；健康客户端与 server 不拖垮", async () => {
    configureSseTimers({ writeTimeoutMs: 250 }); // 生产 >30s——测试注入短窗（brief 明文）
    const work = tmpDir("orosus-web-t3-");
    const { hs, pushEvent } = makeHosted(work, async () => []);
    await hs.ready;
    const { port } = await startBare(() => ({ hs, after: 0 }));
    const big = "x".repeat(200_000);

    const healthy = connectSse(port, "/?after=0");
    await waitForFrame(healthy, (fs) => fs.some((f) => f.comment === "connected"));
    expect(sseClientCount(hs)).toBe(1);

    // 慢消费者：停读必须停在 socket 上（IncomingMessage.pause 只停 data 事件——Node 仍代读仍 ACK，
    // TCP 窗永不收紧，server 看不到背压；socket.pause 才真正停收 → 接收窗收紧 → 写缓冲堆积）。
    // 其连接终局由 server 侧注册表断言（暂停 socket 上客户端侧 close/error 事件投递平台相关，不可依赖）。
    const slowReq = httpRequest({ host: "127.0.0.1", port, path: "/?after=0" }, (res) => { res.socket.pause(); });
    slowReq.end();
    await waitFor(() => sseClientCount(hs) === 2);

    for (let i = 1; i <= 100; i++) pushEvent(mkEvent(i, "user/message", { blob: big })); // ~20MB 帧流
    await waitFor(() => sseClientCount(hs) === 1, 9_000); // 写缓冲满 → drain 不来 → 250ms 写超时 → 逐出摘册
    await waitForFrame(healthy, (fs) => fs.some((f) => f.event === "ev" && f.id === 100)); // 健康客户端全量到达
    pushEvent(mkEvent(101, "user/message", { blob: big }));
    await waitForFrame(healthy, (fs) => fs.some((f) => f.event === "ev" && f.id === 101)); // server 仍健康收帧
    expect(sseClientCount(hs)).toBe(1); // 慢客户端已逐出、不再回来
    healthy.destroy();
    slowReq.destroy();
  }, 45_000);

  it("⑨ pending interaction 重放：重连接收同 id 原帧（重放源回调拉取）；live 直发走 sendInteractionFrame", async () => {
    const work = tmpDir("orosus-web-t3-");
    const { hs } = makeHosted(work, async () => []);
    await hs.ready;
    const { port } = await startBare(() => ({ hs, after: 0 }));
    const payload = { id: "ix7", kind: "choose", title: "选择处理方式", items: ["方案一", "方案二"] };
    setPendingInteractionSource(hs, () => [payload]); // T5 桥的重放源（此处测试桩）

    const a = connectSse(port, "/?after=0");
    const fsA = await waitForFrame(a, (fs) => fs.some((f) => f.event === "interaction"));
    const ia = fsA.find((f) => f.event === "interaction")!;
    expect(ia.id).toBeUndefined(); // interaction 帧不带 id（⑦ 纪律同源）
    expect(JSON.parse(ia.data!)).toEqual(payload);
    a.destroy();

    const b = connectSse(port, "/?after=0"); // 断开重连 → 重收同 id 原帧（dsh 先例）
    const fsB = await waitForFrame(b, (fs) => fs.some((f) => f.event === "interaction"));
    expect(fsB.find((f) => f.event === "interaction")!.data).toBe(ia.data); // 字节级同帧
    b.destroy();

    const c = connectSse(port, "/?after=0"); // live 直发面（T5 挂起新 interaction 时广播）
    await waitForFrame(c, (fs) => fs.some((f) => f.event === "phase")); // 先等注册+快照落定（请求到达 server 的竞态窗）
    sendInteractionFrame(hs, { id: "iy8", kind: "confirm", title: "确认执行" });
    await waitForFrame(c, (fs) => fs.some((f) => f.event === "interaction" && (JSON.parse(f.data!) as { id: string }).id === "iy8"));

    clearPendingInteractionSource(hs); // 清源后新连接不再重放
    const d = connectSse(port, "/?after=0");
    await waitForFrame(d, (fs) => fs.some((f) => f.event === "phase")); // 快照段落定
    await new Promise((r) => setTimeout(r, 150));
    expect(d.frames().some((f) => f.event === "interaction")).toBe(false);
    c.destroy();
    d.destroy();
  }, 30_000);

  it("路由层（真栈 runWebSubcommand）：GET events 分页形状（最新一页/after 正向页/翻过头空）+ stream 首帧组与 backfill + 404", async () => {
    const home = tmpDir("orosus-web-t3-stack-");
    writeProviderConfig(home);
    const cwd = tmpDir("orosus-web-t3-cwd-");
    const bucket = join(home, "sessions", encodeCwd(cwd));
    const sid = "s_page";
    { // 种子会话：header（seq 1）+ 5 条 user/message（seq 2-6）
      const store = new JsonlSessionStore({ dir: bucket, sessionId: sid });
      await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
      for (let i = 1; i <= 5; i++) await store.append("user/message", { content: [{ kind: "text", text: `第${i}条` }] });
      await store.close();
    }

    const lines: string[] = [];
    const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
    await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
    const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
    const auth = { "x-orosus-token": inst.token };
    const base = `http://127.0.0.1:${inst.port}`;

    type EventsBody = { ok?: boolean; events?: SessionEvent[]; hasMore?: boolean; latestSeq?: number };
    const get = async (p: string): Promise<{ status: number; body: EventsBody }> => {
      const r = await fetch(base + p, { headers: auth });
      return { status: r.status, body: (await r.json()) as EventsBody };
    };

    const first = await get(`/api/sessions/${sid}/events`); // 无 after → 最新一页（首屏有界 §5 律三）
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.events!.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]); // 6 种子 + mcp/manifest（host 装配期追加）
    expect(first.body.hasMore).toBe(false);
    expect(first.body.latestSeq).toBe(7);

    const page = await get(`/api/sessions/${sid}/events?after=2&limit=2`); // after 正向页：seq>2 前 2 条
    expect(page.body.events!.map((e) => e.seq)).toEqual([3, 4]);
    expect(page.body.hasMore).toBe(true); // 页尾 seq 4 < latestSeq 7
    expect(page.body.latestSeq).toBe(7);

    const over = await get(`/api/sessions/${sid}/events?after=99`); // 翻过头 → 空
    expect(over.body.events).toEqual([]);
    expect(over.body.hasMore).toBe(false);
    expect(over.body.latestSeq).toBe(7);

    expect((await get(`/api/sessions/s_none/events`)).status).toBe(404); // 未知 sid
    expect((await fetch(`${base}/api/sessions/s_none/stream`, { headers: auth })).status).toBe(404);

    const conn = connectSse(inst.port, `/api/sessions/${sid}/stream?after=4`, auth);
    const got = await waitForFrame(conn, (fr) => fr.some((f) => f.event === "ev" && f.id === 7));
    expect(got[0]).toMatchObject({ retry: "3000", comment: "connected" }); // 首帧组不回归
    expect(got.filter((f) => f.event === "ev").map((f) => f.id)).toEqual([5, 6, 7]); // backfill = after=4 之后段
    expect(got.some((f) => f.event === "phase")).toBe(true); // 连接期初始相位帧
    conn.destroy();

    shutdownWebServer("test");
    expect(await run).toBe(0);
    expect(webHostPool()).toBeUndefined(); // 契约：清退后 webHostPool() 恒 undefined（T2 审查指针②）
  }, 60_000);
});
