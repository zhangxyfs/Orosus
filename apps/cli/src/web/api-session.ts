/** 会话组端点（web 批 T3 本任务面）：GET events（分页回放——§3 形状）+ GET stream（SSE——路由面，
 *  通道本体在 sse.ts）。send/answer/cancel/queue 撤回/status 等写侧端点是 T4/T5/T9 交付物——YAGNI
 *  不预铺。T2 的最小 stream 路由（mod.ts）已由本件接管升级（首帧组行为不回归——hosted.test.ts ⑨）。
 *  会话解析：池内 host 优先（live 扇出源）；未托管但盘上存在 → viewer 只读化身（回放可用，live 帧
 *  无——本进程无写者时本就无 live）；不在盘 → 404。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerRoute, sendJson } from "./server.ts";
import { webHostPool } from "./mod.ts";
import { openStream } from "./sse.ts";
import type { HostedSession } from "./hosted.ts";

/** 回放分页每页上限（自创值登记——§5 律三：首屏有界，长会话按需加载）。 */
export const EVENTS_PAGE_CAP = 200;

const notFound = (res: ServerResponse): void => {
  sendJson(res, 404, { ok: false, error: "not found" });
};

const queryParams = (req: IncomingMessage): URLSearchParams => {
  const url = req.url ?? "";
  const qi = url.indexOf("?");
  return new URLSearchParams(qi >= 0 ? url.slice(qi + 1) : "");
};

/** 非负整数查询参（缺省/非法 → undefined；上限 1e15 防 +limit 溢出浮点域）。 */
const intParam = (qs: URLSearchParams, key: string): number | undefined => {
  const raw = qs.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 1e15 ? n : undefined;
};

/** 会话解析（两端点同口径）：host 优先；盘上未托管 → viewer；否则 undefined（404）。 */
const resolveSession = async (sid: string): Promise<HostedSession | undefined> => {
  const pool = webHostPool();
  if (pool === undefined) return undefined;
  const hosted = pool.host(sid);
  if (hosted !== undefined) return hosted;
  return pool.viewer(sid).then(
    (hs) => hs,
    () => undefined, // 不在盘/装配失败——调用方 404
  );
};

/** GET /api/sessions/:sid/events?after&limit → {ok, events, hasMore, latestSeq}（§3 形状）。
 *  数据源 = core eventsBefore 游标（harness 索引查段 + pread——§5 律三「扫描解析有缓存、成本不随
 *  客户端数放大」；HostedSession.eventsPage 透传）。
 *  语义：after 缺省 → 最新一页（≤limit 条最新事件升序——首屏有界）；after=N → seq>N 的前 limit 条
 *  升序（正向补页——重连补洞/滚动翻页同游标语义，与 stream 的 after 一致）；hasMore = 页尾之后还有
 *  事件（seq > 页尾，正向游标未到头）；latestSeq = 会话当前最大 seq（重连/续传游标锚）。 */
registerRoute("GET", "/api/sessions/:sid/events", async (req, res, params) => {
  const sid = params["sid"] ?? "";
  const hs = await resolveSession(sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const qs = queryParams(req);
  const limitRaw = intParam(qs, "limit") ?? EVENTS_PAGE_CAP;
  const limit = Math.max(1, Math.min(limitRaw, EVENTS_PAGE_CAP));
  const after = intParam(qs, "after");

  // 会话最新 seq（索引查最新 1 条——cheap）
  const newest = await hs.eventsPage(Number.MAX_SAFE_INTEGER, 1);
  const latestSeq = newest.length > 0 ? newest[0]!.seq : 0;

  let events;
  let pageEnd: number;
  if (after === undefined) {
    events = await hs.eventsPage(Number.MAX_SAFE_INTEGER, limit); // 最新一页
    pageEnd = events.length > 0 ? events[events.length - 1]!.seq : 0;
  } else {
    // 正向页：seq < after+limit+1 的最新 limit 条再滤 seq>after（稀疏 seq 下仍正确）
    events = (await hs.eventsPage(after + limit + 1, limit)).filter((e) => e.seq > after);
    pageEnd = events.length > 0 ? events[events.length - 1]!.seq : after;
  }
  sendJson(res, 200, { ok: true, events, hasMore: pageEnd < latestSeq, latestSeq });
});

/** GET /api/sessions/:sid/stream?after → SSE（通道本体 sse.ts openStream——首帧组/backfill/live/
 *  合批/心跳/背压/interaction 重放全在彼处）。 */
registerRoute("GET", "/api/sessions/:sid/stream", (req, res, params) => {
  void (async () => {
    const sid = params["sid"] ?? "";
    const hs = await resolveSession(sid);
    if (hs === undefined) {
      notFound(res);
      return;
    }
    const after = intParam(queryParams(req), "after") ?? 0;
    openStream(res, hs, after);
  })();
});
