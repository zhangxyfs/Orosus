/** 会话组端点（web 批 T3 本任务面 + T4 写侧 + T5 交互应答 + T9 会话池数据面）：GET events（分页
 *  回放——§3 形状）、GET stream（SSE——路由面，通道本体在 sse.ts）、POST send / DELETE queue /
 *  GET status（T4——消息写入链路：@ 引用展开 + 贴图 imageIds 解析 + promptId 幂等 + 202 受理即回）、
 *  POST answer（T5——interaction 应答落点，桥本体在 bridge-ui.ts）、GET bootstrap / GET sessions /
 *  POST sessions 三形态 / POST workspaces hide / POST pin / title / archive / unarchive / GET archived /
 *  DELETE / export.md（T9——左栏会话列表的全部数据面：分组/置顶/归档/删除守卫/导出/fresh 沿用/
 *  工作区显隐/跨项目创建；POST title 为 T15 审查补漏——B11 重命名任意会话的 setTitle 直挂）。
 *  会话解析：池内 host 优先（live 扇出源）；未托管但盘上存在 → viewer
 *  只读化身（回放可用，live 帧无——本进程无写者时本就无 live；send 对 viewer → 409 拒绝形）；
 *  不在盘 → 404。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { locateSessionFile, readSessionHead } from "@orosus/core";
import { OROSUS_VERSION } from "@orosus/contracts/version";
import { registerRoute, readBody, sendJson } from "./server.ts";
import { webHostPool } from "./mod.ts";
import { openStream } from "./sse.ts";
import type { HostedSession } from "./hosted.ts";
import { freshOf, type PoolScanRow, type ScanSnapshot } from "./hostpool.ts";
import { resolveAtRefs } from "../atfile.ts";
import { INPUT_ECHO_EVENT } from "../session-io.ts";
import { MAX_IMAGES_PER_MESSAGE, resolveImageIds } from "./api-files.ts";
import { webCommandUiOf } from "./bridge-ui.ts";
import { askBtw, abortBtw } from "./btw-service.ts";
import { readPins, togglePin } from "./pins.ts";
import { hideCwd, readHidden, unhideCwd } from "./workspaces.ts";
import { archiveSession, deleteSession, listArchived, renderMarkdown, unarchiveSession } from "./session-actions.ts";
import { bucketCwd, headerCwd } from "./buckets.ts";
import { updateInfoNow } from "../update-check.ts";
import { setTitle } from "../sessions.ts";

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

/** sid → 桶目录（archive 路由用：盘上定位取桶；不在盘 = undefined）。 */
const bucketDirOf = (root: string, sid: string): string | undefined => {
  const loc = locateSessionFile(root, sid);
  return loc === undefined ? undefined : dirname(loc.dir);
};

/** 请求体字符串字段（非空串才算在场——POST sessions 三形态/workspaces hide 共用）。 */
const bodyStr = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

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
  let hs = await resolveSession(pool, sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  // 写意图升级（2026-10-12 走查修）：浏览态（viewer）会话键入即写——先换轨 host 再受理；
  // 外部进程活锁在 runText 锁检面定形 409（holder 人话——§8-3 TUI+web 写互斥不变）
  if (pool !== undefined && pool.host(sid) === undefined) {
    hs = await pool.ensureHost(sid).catch(() => undefined) ?? hs;
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

/** POST /api/sessions/:sid/btw {tab, q} → 202 {ok}（W5 多轮侧问受理口——选项卡内提问的数据面）：
 *  - tab = btw 选项卡 id（前端 pane 铸，如 "btw-1"）；q = 本轮问题。受理即回（fire-and-forget）——
 *    答案/查证/失败经 SSE `event: btw` 帧回流（帧带 tab/round，sse.ts 透传）。
 *  - 同 tab 新问先中止旧在飞（per-tab 单飞）；已完成轮 rounds 随实例存活——第二问请求体自动含
 *    前轮问答 + 最新主历史（每轮重取）。只读工具面（read/grep/glob）+ 保险丝 8 轮在 btw-service。
 *  - 零落盘（D6）：不经 store/loop——主会话 history 与子代理目录均无 btw 痕迹。
 *  - 浏览态（viewer）会话键入即写意图——同 send 升级 host 再受理（写互斥/活锁口径一致）。 */
registerRoute("POST", "/api/sessions/:sid/btw", async (req, res, params) => {
  const sid = params["sid"] ?? "";
  const pool = webHostPool();
  let hs = await resolveSession(pool, sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  if (pool !== undefined && pool.host(sid) === undefined) {
    hs = await pool.ensureHost(sid).catch(() => undefined) ?? hs; // 写意图升级（send 同款）
  }
  if (hs.core === undefined) {
    sendJson(res, 409, { ok: false, error: "会话装配失败" });
    return;
  }
  const raw = await readBody(req, SEND_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { tab?: unknown; q?: unknown; abort?: unknown; model?: unknown; effort?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  const tab = typeof body.tab === "string" ? body.tab.trim() : "";
  /* 走查修④（2026-10-13 用户报障）：{tab, abort:true} = 停止该 tab 在飞侧问（对齐主 composer
   *  忙时停止钮）——abortBtw 落定当前轮（〔已停止〕尾注 + answer 帧），无实例则静默 202。 */
  if (body.abort === true) {
    if (tab === "") {
      sendJson(res, 400, { ok: false, error: "tab 不能为空" });
      return;
    }
    abortBtw(hs, tab);
    sendJson(res, 202, { ok: true });
    return;
  }
  const q = typeof body.q === "string" ? body.q.trim() : "";
  if (tab === "" || q === "") {
    sendJson(res, 400, { ok: false, error: "tab 与 q 不能为空" });
    return;
  }
  /* tab 级临时覆盖（2026-10-13 走查——侧问 composer 模型/思考档芯片）：非字符串忽略 */
  const model = typeof body.model === "string" && body.model.trim() !== "" ? body.model.trim() : undefined;
  const effort = typeof body.effort === "string" && body.effort.trim() !== "" ? body.effort.trim() : undefined;
  askBtw(hs, tab, q, { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }); // 受理即回——流经 onBtw 扇出（SSE btw 帧）
  sendJson(res, 202, { ok: true });
});

// ---------- T9：跨项目会话池数据面（bootstrap / sessions / 三形态创建 / 显隐 / 置顶 / 归档 / 删除 / 导出）----------

/** 组内行序（⑥ /ps 序义——ps.ts PHASE_ORDER 同序复刻：web/* 不改既有件，本地同源常量）：
 *  活体行按相位序（等审批 → 等问询 → 跑 → 错 → 闲）在前，死行按 mtime 新到旧在后。 */
const PHASE_ORDER: Record<string, number> = {
  "waiting-approval": 0,
  "waiting-input": 1,
  running: 2,
  error: 3,
  idle: 4,
};

/** 左栏会话行（§3 :218 SessionRow + fresh?:true——B12/B13 前端消费面〔fresh 无归档钮/占位文案〕，
 *  可选键缺席 = 语义假，exactOptionalPropertyTypes 口径条件展开）。 */
export interface SessionRow {
  sid: string;
  label: string;
  relMs: number;
  live: boolean;
  kind?: "tui" | "line" | "web";
  phase?: string;
  model?: string;
  preview?: string;
  cur?: true;
  fresh?: true;
}

/** 行相位（rowOf 同一优先序：托管实时优先 → peers live.json；无相位 = 死行）。 */
const rowPhase = (pool: NonNullable<ReturnType<typeof webHostPool>>, snap: ScanSnapshot, r: PoolScanRow): string | undefined =>
  pool.host(r.sid)?.phase() ?? snap.peers.get(r.sid)?.phase;

/** 扫描行 → 协议行：live/phase/kind 托管优先（实时）→ peers 次之（live.json）；relMs 以
 *  max(mtime, lastEventAt) 为活动锚。 */
const rowOf = (pool: NonNullable<ReturnType<typeof webHostPool>>, snap: ScanSnapshot, r: PoolScanRow): SessionRow => {
  const hosted = pool.host(r.sid);
  const peer = snap.peers.get(r.sid);
  const phase = rowPhase(pool, snap, r);
  const model = hosted?.coreStatus()?.model ?? peer?.model;
  return {
    sid: r.sid,
    label: r.label,
    relMs: Date.now() - Math.max(r.mtimeMs, peer?.lastEventAt ?? 0),
    live: hosted !== undefined || peer !== undefined,
    ...(hosted !== undefined ? { kind: "web" as const } : peer !== undefined ? { kind: peer.kind } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(model !== undefined && model !== "" ? { model } : {}),
    ...(peer?.preview !== undefined ? { preview: peer.preview } : {}),
    ...(pool.cursorSid() === r.sid ? { cur: true as const } : {}),
    ...(r.fresh ? { fresh: true as const } : {}),
  };
};

/** GET /api/sessions → {pinned, groups}（§3 :210）：groups 已过滤 hidden 桶（B10）与 archived 会话
 *  （B12）；组名 = basename(cwd)；置顶区独立成列（B2，pins.json 序）且同样过滤 hidden/archived。 */
registerRoute("GET", "/api/sessions", async (_req, res) => {
  const pool = webHostPool();
  if (pool === undefined) {
    sendJson(res, 200, { pinned: [], groups: [] });
    return;
  }
  const snap = pool.snapshot();
  const hidden = new Set(readHidden(pool.home));
  const rowsBySid = new Map(snap.rows.map((r) => [r.sid, r]));

  const byBucket = new Map<string, PoolScanRow[]>();
  for (const r of snap.rows) {
    if (r.archived) continue; // B12：归档不进左栏
    const list = byBucket.get(r.bucket);
    if (list !== undefined) list.push(r);
    else byBucket.set(r.bucket, [r]);
  }
  const groups = [...byBucket.entries()]
    .map(([bucket, rows]) => {
      const cwd = snap.buckets.get(bucket) ?? "";
      return { bucket, cwd, rows, hidden: hidden.has(cwd) };
    })
    .filter((g) => !g.hidden) // B10：hidden 桶不出列
    .map((g) => ({
      bucket: g.bucket,
      name: basename(g.cwd) || g.bucket, // 组名 = basename(cwd)（B3；反查失败回落桶名）
      cwd: g.cwd,
      newest: Math.max(...g.rows.map((r) => r.mtimeMs)),
      sessions: g.rows
        .toSorted((a, b) => {
          const pa = PHASE_ORDER[rowPhase(pool, snap, a) ?? ""] ?? 99;
          const pb = PHASE_ORDER[rowPhase(pool, snap, b) ?? ""] ?? 99;
          return pa !== pb ? pa - pb : b.mtimeMs - a.mtimeMs;
        })
        .map((r) => rowOf(pool, snap, r)),
    }))
    .toSorted((a, b) => b.newest - a.newest); // 工作区按最新活动在前

  const pinned: SessionRow[] = [];
  for (const sid of readPins(pool.home)) {
    const r = rowsBySid.get(sid);
    if (r === undefined || r.archived) continue;
    if (hidden.has(snap.buckets.get(r.bucket) ?? "")) continue; // hidden 桶的置顶一并隐（显隐压过置顶）
    pinned.push(rowOf(pool, snap, r));
  }
  sendJson(res, 200, { pinned, groups: groups.map(({ bucket, name, cwd, sessions }) => ({ bucket, name, cwd, sessions })) });
});

/** GET /api/bootstrap → {version, projects, pinned, currentSid?, update?}（§3 :208）：projects 含 hidden
 *  工作区全量（hidden:true——cwd 切换芯片找回入口，B10）；currentSid = 池当前游标（/web 交接指向；
 *  无则前端开最新）；update? = {current,latest}——T12 接线：updateInfoNow() 缓存直读（启动检查点火
 *  的「确有新版」现值；server 无后台轮检，新鲜度与 /api/update 懒取同源 npm registry 通道）。
 *  未查过/无新版 → 字段缺省（A4 胶囊首开不显，前端收 /api/update 懒取回包后补显）。 */
registerRoute("GET", "/api/bootstrap", async (_req, res) => {
  const pool = webHostPool();
  if (pool === undefined) {
    sendJson(res, 200, { version: OROSUS_VERSION, projects: [], pinned: [] });
    return;
  }
  const snap = pool.snapshot();
  const hidden = new Set(readHidden(pool.home));
  const projects = [...snap.buckets.entries()].map(([bucket, cwd]) => ({
    bucket,
    cwd,
    name: basename(cwd) || bucket,
    ...(hidden.has(cwd) ? { hidden: true as const } : {}),
  }));
  const cur = pool.current();
  const upd = updateInfoNow();
  sendJson(res, 200, {
    version: OROSUS_VERSION,
    projects,
    pinned: readPins(pool.home),
    ...(cur !== undefined ? { currentSid: cur.sid } : {}),
    ...(upd !== undefined ? { update: { current: OROSUS_VERSION, latest: upd.latest } } : {}),
  });
});

/** POST /api/sessions {cwd?, resumeSid?, forkFrom?} → {sid, reused?:true}（§3 :219 三形态）：
 *  - cwd 缺省 = 当前会话所在项目（pool.current()?.cwd ?? pool 启动 cwd）——顶栏「＋ 新会话」
 *    （B1 跟随语义）；带 cwd = 工作区行 ＋ / cwd 芯片显式指定（B9/D5）；
 *  - resumeSid = 打开既有会话（host 换轨——viewer 化身先关）；forkFrom = 分叉新会话；
 *  - 同项目已有 fresh 空会话 → 沿用返回该 sid（reused:true，B13——池内 per-cwd 互斥，并发双击
 *    不落两个 fresh）；
 *  - 打开/创建即切当前游标（switchCurrent——currentSid 与 B1 跟随基准随之迁移）；
 *  - cwd 在 hidden 表 → 自动移出（B10 找回：POST {同 cwd} 建会话即重新可见）。 */
registerRoute("POST", "/api/sessions", async (req, res) => {
  const pool = webHostPool();
  if (pool === undefined) {
    notFound(res);
    return;
  }
  const raw = await readBody(req, SEND_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { cwd?: unknown; resumeSid?: unknown; forkFrom?: unknown } = {};
  const text = raw.toString("utf8").trim();
  if (text !== "") {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid json" });
      return;
    }
  }
  const cwd = bodyStr(body.cwd);
  const resumeSid = bodyStr(body.resumeSid);
  const forkFrom = bodyStr(body.forkFrom);
  if ([cwd, resumeSid, forkFrom].filter((x) => x !== undefined).length > 1) {
    sendJson(res, 400, { ok: false, error: "cwd/resumeSid/forkFrom 三选一" });
    return;
  }
  const targetLoc = resumeSid !== undefined ? locateSessionFile(pool.root, resumeSid)
    : forkFrom !== undefined ? locateSessionFile(pool.root, forkFrom)
      : undefined;
  if ((resumeSid !== undefined || forkFrom !== undefined) && targetLoc === undefined) {
    sendJson(res, 404, { ok: false, error: "会话不存在" });
    return;
  }
  try {
    // B1 跟随链：显式 cwd > 目标会话自身 cwd（resume/fork 落在它自己的项目——跨项目打开不串桶）>
    // 当前会话所在项目（游标指向 viewer 化身时经 lookup 兜底取 cwd）> server 启动 cwd
    const cursorCwd = pool.current()?.cwd
      ?? (pool.cursorSid() !== undefined ? pool.lookup(pool.cursorSid()!)?.cwd : undefined);
    const targetCwd = cwd
      ?? (targetLoc !== undefined ? headerCwd(targetLoc.file) : undefined)
      ?? cursorCwd
      ?? pool.startCwd;
    const { hs, reused } = await pool.openSession({
      cwd: targetCwd,
      ...(resumeSid !== undefined ? { resumeSid } : {}),
      ...(forkFrom !== undefined ? { forkFrom } : {}),
    });
    pool.switchCurrent(hs.sid);
    unhideCwd(pool.home, hs.cwd); // B10 找回：该 cwd 建会话自动移出 hidden（幂等）
    /* fork 自动命名（2026-10-12 走查修——TUI main.ts:1007 既有拍板「fork <父标题>」的 web 补齐：
     *  fork 子体自身文件只有 header+fork 标记，firstUser/label 双缺 → 左栏裸显「（未命名会话）」；
     *  经 h.setLabel 活写口落 session/label（autoTitle 见已有 label 即跳过——不覆盖）。 */
    if (forkFrom !== undefined && !reused && hs.core !== undefined) {
      const parentHead = readSessionHead(targetLoc!.file);
      const parentTitle = parentHead?.label ?? parentHead?.firstUser;
      if (parentTitle !== undefined && parentTitle !== "") {
        await hs.core.setLabel(`fork ${parentTitle}`).catch(() => undefined);
        pool.invalidateScan();
      }
    }
    sendJson(res, 200, { sid: hs.sid, ...(reused ? { reused: true } : {}) });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /api/sessions/:sid/current → {ok}（前端点击切换同步 server 侧「当前会话」游标——
 *  走查补：此前游标只在 POST /api/sessions 打开时切换，纯点击切换 server 不知情，
 *  cur 行标记与 B1 项目跟随全失效）。游标是纯视图态——不校验会话存在性（viewer 化身同样可作游标）。 */
registerRoute("POST", "/api/sessions/:sid/current", (req, res, params) => {
  const pool = webHostPool();
  if (pool === undefined) {
    notFound(res);
    return;
  }
  const sid = params["sid"] ?? "";
  if (sid === "") {
    sendJson(res, 400, { ok: false, error: "missing sid" });
    return;
  }
  pool.switchCurrent(sid);
  sendJson(res, 200, { ok: true });
});

/** POST /api/workspaces/hide {cwd} → {ok}（§3 :212，B10）：移除工作区（仅显隐——文件与会话保留）；
 *  找回 = POST /api/sessions {同 cwd} 自动移出（或 unarchive 联动）。 */
registerRoute("POST", "/api/workspaces/hide", async (req, res) => {
  const pool = webHostPool();
  const raw = await readBody(req, SEND_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { cwd?: unknown } = {};
  const text = raw.toString("utf8").trim();
  if (text !== "") {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid json" });
      return;
    }
  }
  if (typeof body.cwd !== "string" || body.cwd === "") {
    sendJson(res, 400, { ok: false, error: "missing cwd" });
    return;
  }
  if (pool !== undefined) hideCwd(pool.home, body.cwd);
  sendJson(res, 200, { ok: true });
});

/** POST /api/sessions/:sid/pin → {ok, pinned}（B2/B11 置顶 toggle——§3 端点表未列的补面：前端
 *  悬停钮/右键「置顶」的消费口，pins.ts togglePin 的路由接线；不校验会话存在〔对已删会话的置顶
 *  在读侧自然跳过〕）。 */
registerRoute("POST", "/api/sessions/:sid/pin", async (req, res, params) => {
  const pool = webHostPool();
  if (pool === undefined) {
    notFound(res);
    return;
  }
  const raw = await readBody(req, SEND_BODY_MAX_BYTES); // 排空请求体（keep-alive 管线卫生）
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  const pinned = togglePin(pool.home, params["sid"] ?? "");
  sendJson(res, 200, { ok: true, pinned });
});

/** POST /api/sessions/:sid/title {title} → {ok}（B11 重命名任意会话——方案漏列、T15 审查补漏）：
 *  写路按持有者分派——**托管中（host 在池）走 core `setLabel` 活写口**（session/label 事件回流 SSE；
 *  旁路写在 CS-03 单写者锁下必抛——host 持锁）；**非托管走 setTitle 旁路写**（sessions.ts:187——
 *  不碰 host：无活写者的盘上会话可命名；外部进程活锁中的会话撞 CS-03 单写者锁 → per-request
 *  catch 净 400 拒绝〔按设计正确〕）。无 resume 劫持当前会话的副作用；截断 200 字符（kimi 同款）；
 *  label 落盘后经扫描缓存失效在左栏下一轮轮询出新。 */
registerRoute("POST", "/api/sessions/:sid/title", async (req, res, params) => {
  const pool = webHostPool();
  if (pool === undefined) {
    notFound(res);
    return;
  }
  const sid = params["sid"] ?? "";
  const raw = await readBody(req, SEND_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { title?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title === "") {
    sendJson(res, 400, { ok: false, error: "title 不能为空" });
    return;
  }
  const hosted = pool.host(sid);
  if (hosted !== undefined) {
    const h = hosted.core; // 写者在池——活写口（事件回流 + host 自己的写锁）
    if (h === undefined) {
      notFound(res);
      return;
    }
    await h.setLabel(title);
  } else {
    const r = await setTitle(pool.root, "", sid, title); // target 恒给——currentSid 形参不参与
    if (r === undefined) {
      notFound(res);
      return;
    }
  }
  pool.invalidateScan();
  sendJson(res, 200, { ok: true });
});

/** POST /api/sessions/:sid/archive → {ok}（§3 :213，B12）：写 agents/archived 标记（内容 = ISO 一行）；
 *  fresh 空会话 → 400（盘上判据 isEmptySessionHead；托管无盘 fresh 由池面拦截）；不在盘 → 404。 */
registerRoute("POST", "/api/sessions/:sid/archive", async (req, res, params) => {
  const pool = webHostPool();
  if (pool === undefined) {
    notFound(res);
    return;
  }
  const sid = params["sid"] ?? "";
  const raw = await readBody(req, SEND_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  const hosted = pool.lookup(sid);
  if (hosted !== undefined && await freshOf(hosted)) {
    sendJson(res, 400, { ok: false, error: "空会话不能归档" }); // 托管 fresh（header 懒写不在盘）
    return;
  }
  const bucketDir = hosted !== undefined ? join(pool.root, hosted.bucket) : bucketDirOf(pool.root, sid);
  if (bucketDir === undefined) {
    notFound(res);
    return;
  }
  const r = archiveSession(bucketDir, sid);
  if (r.ok) {
    pool.invalidateScan();
    sendJson(res, 200, { ok: true });
  } else {
    sendJson(res, r.status, { ok: false, error: r.error });
  }
});

/** POST /api/sessions/:sid/unarchive → {ok}（§3 :214，B12/F10）：删标记文件；该会话 cwd 在 hidden
 *  表 → server 同步 unhide（恢复即找回——落 server 侧保证原子）；不在盘 → 404。 */
registerRoute("POST", "/api/sessions/:sid/unarchive", async (req, res, params) => {
  const pool = webHostPool();
  if (pool === undefined) {
    notFound(res);
    return;
  }
  const sid = params["sid"] ?? "";
  const raw = await readBody(req, SEND_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  const loc = locateSessionFile(pool.root, sid);
  if (loc === undefined) {
    notFound(res);
    return;
  }
  unarchiveSession(join(pool.root, loc.bucket), sid);
  const cwd = bucketCwd(pool.root, loc.bucket);
  if (cwd !== undefined && cwd !== "") unhideCwd(pool.home, cwd); // 恢复即找回（§3 端点注释）
  pool.invalidateScan();
  sendJson(res, 200, { ok: true });
});

/** GET /api/archived → {items}（§3 :215，B12/F10）：已归档列表（title/cwd/双时间——归档时刻倒序；
 *  session-actions.listArchived，bucketCwd 反查缓存命中）。 */
registerRoute("GET", "/api/archived", async (_req, res) => {
  const pool = webHostPool();
  if (pool === undefined) {
    sendJson(res, 200, { items: [] });
    return;
  }
  sendJson(res, 200, { items: listArchived(pool.root) });
});

/** DELETE /api/sessions/:sid → {ok}|409（§3 :216，B11）：purgeSessionDir + 活锁守卫（外部进程
 *  live pid 活 / lock 活锁 → 409）；本进程 host 托管会话（含当前与非当前）先 close 再删（viewer 不豁免）——
 *  自身 presence 不作锁。守卫与删尽序在 session-actions.deleteSession（测试 ⑪ 面）。 */
registerRoute("DELETE", "/api/sessions/:sid", async (_req, res, params) => {
  const pool = webHostPool();
  if (pool === undefined) {
    notFound(res);
    return;
  }
  const r = await deleteSession(pool.root, params["sid"] ?? "", pool);
  if (r.ok) {
    pool.invalidateScan();
    sendJson(res, 200, { ok: true });
  } else {
    sendJson(res, r.status, { ok: false, error: r.error });
  }
});

/** GET /api/sessions/:sid/export.md → text/markdown（attachment，§3 :217，B11）：SessionEvent 流 →
 *  markdown（renderMarkdown——user/assistant 分节 + thinking 折叠引用 + 工具行摘要）+ 标题头
 *  （session/label 优先）；会话解析同口径（host → viewer → 404）。 */
registerRoute("GET", "/api/sessions/:sid/export.md", async (_req, res, params) => {
  const sid = params["sid"] ?? "";
  const pool = webHostPool();
  const hs = await resolveSession(pool, sid);
  if (hs === undefined || pool === undefined) {
    notFound(res);
    return;
  }
  const events = await hs.replayAfter(0);
  const loc = locateSessionFile(pool.root, hs.sid);
  const head = loc !== undefined ? readSessionHead(loc.file) : undefined;
  const title = head?.label ?? head?.firstUser ?? hs.sid;
  const md = `# ${title}\n\n> 会话 ID：${hs.sid}\n> 项目：${hs.cwd}\n> 导出时间：${new Date().toISOString()}\n\n---\n${renderMarkdown(events)}`;
  res.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="oro-${hs.sid}.md"`,
    "cache-control": "no-store",
  });
  res.end(md);
});
