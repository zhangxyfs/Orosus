/** 会话组端点（web 批 T3 本任务面 + T4 写侧 + T5 交互应答）：GET events（分页回放——§3 形状）、
 *  GET stream（SSE——路由面，通道本体在 sse.ts）、POST send / DELETE queue / GET status（T4——消息
 *  写入链路：@ 引用展开 + 贴图 imageIds 解析 + promptId 幂等 + 202 受理即回）、POST answer（T5——
 *  interaction 应答落点，桥本体在 bridge-ui.ts）。会话解析：池内 host 优先（live 扇出源）；未托管但
 *  盘上存在 → viewer 只读化身（回放可用，live 帧无——本进程无写者时本就无 live；send 对 viewer →
 *  409 拒绝形）；不在盘 → 404。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { locateSessionFile, readSessionHead } from "@orosus/core";
import { registerRoute, readBody, sendJson } from "./server.ts";
import { webHostPool } from "./mod.ts";
import { openStream } from "./sse.ts";
import type { HostedSession } from "./hosted.ts";
import { resolveAtRefs } from "../atfile.ts";
import { INPUT_ECHO_EVENT } from "../session-io.ts";
import { MAX_IMAGES_PER_MESSAGE, resolveImageIds } from "./api-files.ts";
import { webCommandUiOf } from "./bridge-ui.ts";

/** 回放分页每页上限（自创值登记——§5 律三：首屏有界，长会话按需加载）。 */
export const EVENTS_PAGE_CAP = 200;

/** send JSON 体上限（T4 定档自创值——文本 + imageIds 远小于此；防失控客户端撑内存。§5 表补录
 *  见 T4 报告）。 */
const SEND_BODY_MAX_BYTES = 1024 * 1024;

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

/** 会话解析（四端点同口径）：host 优先；盘上未托管 → viewer；否则 undefined（404）。pool 由调用方
 *  传入（send 的 imageIds 解析与 status 的 label 装配同用 root）。 */
const resolveSession = async (pool: ReturnType<typeof webHostPool>, sid: string): Promise<HostedSession | undefined> => {
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
  const pool = webHostPool();
  const hs = await resolveSession(pool, sid);
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
    const pool = webHostPool();
    const hs = await resolveSession(pool, sid);
    if (hs === undefined) {
      notFound(res);
      return;
    }
    const after = intParam(queryParams(req), "after") ?? 0;
    openStream(res, hs, after);
  })();
});

/** POST /api/sessions/:sid/send {text, imageIds?, promptId?} → 202 {ok}|{ok,queued,index}|
 *  {ok,noop} | 409 {error,holder?}（§3）。
 *  - 受理即回（HostedSession.accept——turn 终值经事件流反馈，HTTP 不挂整轮；busy 期入队同步定形）。
 *  - promptId 幂等键（网络重试场景，kimi/qwen 先例）：admission Map 去重（HostedSession 持有，保留
 *    最近 256——自创值登记）；重复受理回 {ok:true,noop:true}。校验失败（400）不烧 id。
 *  - @ 引用发送期展开（resolveAtRefs——atfile.ts:16 纯函数直 import，基址 = 会话 cwd 而非
 *    process.cwd——§4-8）：content 含 [@path] 附件块；发出体 ≠ 原文时原文经 host/input-echo 旁注
 *    紧随落盘（main.ts:1234 对齐——上键召回取原文的 web 同构）。
 *  - imageIds = uploads 发形 id（≤6 张/消息——自创值登记 D6），解析域 = 会话 media 目录（跨会话
 *    引用一步不可越）；图片以路径引用透传进 user/message 的 image part（core 现成）。
 *  - viewer 会话 / 撞他进程活锁 / 已关 → 409 形（SendResult 原样透传）。 */
registerRoute("POST", "/api/sessions/:sid/send", async (req, res, params) => {
  const sid = params["sid"] ?? "";
  const pool = webHostPool();
  const hs = await resolveSession(pool, sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const raw = await readBody(req, SEND_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { text?: unknown; imageIds?: unknown; promptId?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  const text = typeof body.text === "string" ? body.text : undefined;
  const promptId = typeof body.promptId === "string" && body.promptId !== "" ? body.promptId : undefined;
  const imageIds = Array.isArray(body.imageIds) ? body.imageIds.filter((x): x is string => typeof x === "string") : undefined;
  const nImages = imageIds?.length ?? 0;
  if ((text === undefined || text.trim() === "") && nImages === 0) {
    sendJson(res, 400, { ok: false, error: "text 不能为空" });
    return;
  }
  if (nImages > MAX_IMAGES_PER_MESSAGE) {
    sendJson(res, 400, { ok: false, error: `每条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片` });
    return;
  }
  // imageIds → 绝对路径（先于 promptId admission——坏请求不烧幂等键）
  let images: string[] | undefined;
  if (nImages > 0) {
    const sessionDir = hs.sessionDir;
    if (sessionDir === undefined) {
      sendJson(res, 409, { ok: false, error: "会话装配失败" });
      return;
    }
    const r = resolveImageIds(sessionDir, imageIds!);
    if ("error" in r) {
      sendJson(res, 400, { ok: false, error: r.error });
      return;
    }
    images = r.images;
  }
  // promptId admission：重复 id → noop 受理形（消息已在途/在队——不再二次受理）
  if (promptId !== undefined && !hs.admitPromptId(promptId)) {
    sendJson(res, 202, { ok: true, noop: true });
    return;
  }
  // @ 引用展开（main.ts:1207-1209 同款）+ input-echo 旁注（发出体 ≠ 原话时原话随盘）
  const { text: cleaned, attachments } = resolveAtRefs(text ?? "", hs.cwd);
  const withAt = attachments.length > 0 ? `${cleaned}\n\n${attachments.join("\n\n")}` : cleaned;
  const afterUserEvent = withAt !== (text ?? "")
    ? [{ type: INPUT_ECHO_EVENT, fields: { text: text ?? "" } }]
    : undefined;
  const { result } = await hs.accept(withAt, images, afterUserEvent);
  // 展开降型（interface 无隐式索引签名——sendJson 收 Record；字段集即 §3 send 形 + T6 命令面
  // output/mark 两键——cmdrouter 路由信号，T16 前端消费）
  if (result.ok) sendJson(res, 202, { ...result });
  else sendJson(res, 409, { ...result });
  // /quit 族（G10 web 语义 = 关当前会话，server 常驻）：mark:"quit" 由本端点执行——响应先落地
  // 再关（50ms 拆接同款窗，T4 CONNECTION_TEARDOWN_MS 先例），HostedSession.close 同 CLI 退出
  // 序（presence/close/purgeIfEmpty）；busy 形已在分流点先 cancel（D15 特例）。
  if (result.mark === "quit") {
    const sidOf = hs.sid;
    const timer = setTimeout(() => { void pool?.remove(sidOf).catch(() => undefined); }, 50);
    timer.unref?.();
  }
});

/** DELETE /api/sessions/:sid/queue/:index → {ok}（§3：index 以最近 queue 帧快照为准；撤回即广播
 *  新快照——HostedSession.onQueue → SSE queue 帧；并发撤回按 server 当前表重算，不在队 = 404）。
 *  DELETE 携 content-type: application/json（T1 写方法护栏合规形态——无体也带头，T16 api.js 约定）。 */
registerRoute("DELETE", "/api/sessions/:sid/queue/:index", async (_req, res, params) => {
  const sid = params["sid"] ?? "";
  const pool = webHostPool();
  const hs = await resolveSession(pool, sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const index = Number(params["index"] ?? "");
  if (!Number.isInteger(index) || index < 0) {
    sendJson(res, 400, { ok: false, error: "invalid index" });
    return;
  }
  if (hs.withdraw(index)) sendJson(res, 200, { ok: true });
  else sendJson(res, 404, { ok: false, error: "not in queue" });
});

/** GET /api/sessions/:sid/status → {sid,label,model,effort,permission,busy,phase,cwd,bucket}（§3）。
 *  装配口径（§4-18——勿把 h.status() 当唯一数据源）：model/effort 取 h.status()（实返仅
 *  {model,overridden,sessionId,effort?,modules}）；busy/phase 由 HostedSession 推算；permission
 *  读 approval.current-mode 服务（[approval] 配置 + 会话 override）；label 经 readSessionHead
 *  （session/label ?? firstUser 兜底）；sid/cwd/bucket 来自 HostedSession。九键恒在（未设 effort/
 *  label 为空串——JSON 序列化不掉键，前端显示侧自定兜底形态）。 */
registerRoute("GET", "/api/sessions/:sid/status", async (_req, res, params) => {
  const sid = params["sid"] ?? "";
  const pool = webHostPool();
  const hs = await resolveSession(pool, sid);
  if (hs === undefined || pool === undefined) {
    notFound(res);
    return;
  }
  const core = hs.coreStatus();
  const loc = locateSessionFile(pool.root, hs.sid);
  const head = loc !== undefined ? readSessionHead(loc.file) : undefined;
  const permission = await hs.permissionMode();
  sendJson(res, 200, {
    sid: hs.sid,
    label: head?.label ?? head?.firstUser ?? "",
    model: core?.model ?? "",
    effort: core?.effort ?? "",
    permission,
    busy: hs.busy(),
    phase: hs.phase(),
    cwd: hs.cwd,
    bucket: hs.bucket,
  });
});

/** POST /api/sessions/:sid/answer {id, value} | {id, cancelled:true} → {ok:true} | {ok:true,noop:true}
 *  （§3 interaction 应答协议落点——桥本体 bridge-ui.ts）。
 *  - value 形态分 kind：choose=选中项原文 / chooseSide={item,value} 对 / ask|askSecret=文本 /
 *    confirm="true"|"false" / chooseEx=多选数组（归一与契约校验在 WebCommandUi.valueOf）。
 *  - cancelled:true → server 侧挂起 Promise reject「已取消（Esc）」（approval 拒绝路径同 TUI Esc；
 *    confirm 按契约折 false）。
 *  - 重复/晚到应答（已 settle 的 id）→ {ok:true,noop:true} 幂等——多端抢答先到先得（§3）。
 *  - 未装配交互桥的会话（viewer/headless 池）无挂起可能 → 同 noop 形（不应 409：answer 不写状态）。 */
registerRoute("POST", "/api/sessions/:sid/answer", async (req, res, params) => {
  const sid = params["sid"] ?? "";
  const pool = webHostPool();
  const hs = await resolveSession(pool, sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const raw = await readBody(req, SEND_BODY_MAX_BYTES); // ask 长文本粘贴同量级上限（send 同款自创值）
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { id?: unknown; value?: unknown; cancelled?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  const id = typeof body.id === "string" && body.id !== "" ? body.id : undefined;
  if (id === undefined) {
    sendJson(res, 400, { ok: false, error: "missing id" });
    return;
  }
  const ui = webCommandUiOf(hs);
  if (ui === undefined) {
    sendJson(res, 200, { ok: true, noop: true }); // 无桥 = 无挂起（viewer/headless 池）
    return;
  }
  if (body.cancelled === true) {
    ui.cancel(id);
    sendJson(res, 200, { ok: true });
    return;
  }
  const delivered = ui.answer(id, body.value);
  sendJson(res, 200, { ok: true, ...(delivered ? {} : { noop: true }) });
});

/** POST /api/sessions/:sid/cancel → {ok}（§3：h.cancel + stopAllSubagents——D11 发送键 stop 态 /
 *  D12 双击 Esc 的服务端全停口；busy 期 /quit 族先 cancel 的同款动作 T6 已消费）。
 *  - **既定语义（T5 钉住，测试 ①钉）**：不 resolve 挂起的 interaction 卡——turn 阻塞至卡片应答或
 *    close；前端双击 Esc 连带 POST /answer {cancelled} 是 T16 的职责，本端点不越权 fail-close。
 *  - stopAllSubagents 把挂起审批自动按拒绝收场（决策 3/12——绝不卡死）。
 *  - 无请求体字段（content-type: application/json 头即 T1 写护栏合规形态；体读后弃——连接卫生）。 */
registerRoute("POST", "/api/sessions/:sid/cancel", async (req, res, params) => {
  const sid = params["sid"] ?? "";
  const pool = webHostPool();
  const hs = await resolveSession(pool, sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const raw = await readBody(req, SEND_BODY_MAX_BYTES); // 排空请求体（keep-alive 管线卫生；无字段可解析）
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  hs.cancel();
  sendJson(res, 200, { ok: true });
});
