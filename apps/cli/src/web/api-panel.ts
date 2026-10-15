/** 面板数据端点（web 批 T7 + T10 两任务面）：GET /tasks 子代理名册（活名册 ∪ 盘上历史去重——§1 G3）、
 *  POST /subagents/:id/approval 后台子代理挂起审批应答、GET /subagents/:id/events transcript 回放
 *  （末 500——§5 自创值）；T10 任务面：GET /panel（PanelData 同形 JSON——E2/E3 同口径聚合 +
 *  E6 全桶 peers 合并 + E7 任务清单投影）+ POST /modules/:name/toggle（E4 插拔链：closure →
 *  setModuleEnabledInConfig → h.reload 返回 ReloadReport 摘要）。
 *  T14 任务面（更多菜单四窗数据面——A7 ⋮ 菜单，TUI Ctrl+E/P/H/O 的 web 化）：GET /diagnostics
 *  （graph().audit() failed 行 + logDir）、GET /launchers（active 模块 launcher 登记投影——
 *  collectLauncher〔module-launcher.ts〕Ctrl+P 同源；方案 A7 引 moduleCards() 系笔误——panel 卡
 *  是 TUI 渲染面（widgets 含 getter 不可序列化、无 module/desc 键），§3 :272 端点名/形状与原型
 *  「带界面模块的启动器」均指向 launcher 面）、GET /sessions/:sid/hooks-activity（hooks/run 事件
 *  分桶归属最近 user/message——buildHookBuckets〔hooks-ui.ts:111〕同源单口）、GET /sessions/:sid/
 *  compaction（末条 turn/compaction 的 summary/stats 或 404）。
 *  数据源全部走 CLI 纯函数件（tasks-cmd/modules-ui/usage-text/module-deps/module-toggle/hooks-ui/
 *  module-launcher——§2 依赖方向白名单）与 HostedSession.core 只读口；/panel 结果 1s 缓存 +
 *  事件驱动失效（§5 律三：turn/todo 事件到达即刷、模块插拔端点显式失效——refreshPanel 不随每请求
 *  重算 history）；更多菜单四端点是打开即拉面（非轮询）——现读不缓存（/tasks 同口径）。
 *  T11 增量：network.connections 填充（T10 跨任务指针——TUI 渲染期另并 mcpConnRows 的 web 版，
 *  装配期 await mcp.catalog 服务现读）+ mcpCatalogService/mcpCatalogRowsOf 导出（api-settings
 *  的 MCP 页同源消费）+ invalidatePanelCache 导出（MCP ops 写盘 reload 后显式失效，toggle 同口径）。
 *  批次三 W4 任务面（问题 2）：GET /sessions/:sid/subagents/:id/todo——子代理 todo 悬浮条数据
 *  （子代理会话文件末条 tool-todo/write 的 panelTasksFromEvent 同源投影，1s 缓存 panel 同款口径）。 */
import type { ServerResponse } from "node:http";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { ReloadReport, SessionEvent } from "@orosus/core";
import { orosusHome } from "@orosus/contracts/home";
import type { McpCatalogRow } from "@orosus/mcp";
import type { SubagentRosterEntry } from "@orosus/contracts/module";
import { registerRoute, readBody, sendJson } from "./server.ts";
import { webHostPool } from "./mod.ts";
import type { HostedSession } from "./hosted.ts";
import { agentEventsFromFile, loadHistoricalSubagents, sortNewestFirst, subagentUnloadBlock } from "../tasks-cmd.ts";
import { panelTasksFromEvent } from "../todo-panel.ts";
import { refreshPanel, getPanelCache, lockReasonFor, type ModulesUiDeps } from "../modules-ui.ts";
import { shortenPath, lastUsageOf } from "../usage-text.ts";
import { computeMountClosure, computeUnmountClosure } from "../module-deps.ts";
import { setModuleEnabledInConfig } from "../module-toggle.ts";
import { moduleConfigFileFor } from "../config-face.ts";
import { toggleResultText } from "../module-toggle-result.ts";
import { envProxyUrl, readWindowsSystemProxy, detectTunProxy, proxyDisplayText } from "../proxy-env.ts";
import { buildHookBuckets } from "../hooks-ui.ts";
import { collectLaunchers } from "../module-launcher.ts";
import { activeModuleNamesOf, closeGoneDialogs } from "./bridge-ui.ts"; // web-dialog 批 T6：owner 关窗接线
import type { PanelData } from "../tui/fullapp.ts";
import type { PeerEntry } from "../ps.ts";
import { t } from "../i18n/app.ts";

/** 会话解析后的 JSON 体上限（approval {allow} 量级——send 1MiB 同款自创值口径，防失控客户端）。 */
const PANEL_BODY_MAX_BYTES = 1024 * 1024;

/** panel 结果缓存 TTL（§5 律三 / 自创值登记「panel 缓存 1s（事件失效）」）：2s 轮询 × N 标签共享
 *  同一份装配结果——refreshPanel（history 全量读）成本不随客户端数放大；事件到达（turn/todo）
 *  即失效，下一请求重算出新值。 */
export const PANEL_CACHE_MS = 1_000;

const notFound = (res: ServerResponse): void => {
  sendJson(res, 404, { ok: false, error: "not found" });
};

/** 会话解析（api-session 同口径）：host 优先（活名册源）；盘上未托管 → viewer 只读化身（历史/回放
 *  可用，活名册恒空——本进程无跑着的单子）；不在盘 → 404。 */
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

// ---------- panel 装配（E2/E3 同口径聚合 + E6 peers 合并 + E7 任务投影） ----------

/** mcp.catalog 服务现取（T11——mcp-ui.mcpCatalogRows 的 web 版：getOptional 是异步口（cmdrouter 同注），
 *  漏 await 会拿到 Promise 恒非函数；模块未启用/换代 stale 抛错 = undefined——调用方按空表处理）。
 *  api-settings 的 GET/ops 与本件 connections 填充同源消费（MCP 面单一数据口）。 */
export const mcpCatalogService = async (h: NonNullable<HostedSession["core"]>): Promise<(() => McpCatalogRow[]) | undefined> => {
  try {
    const svc = await h.graph().services.getOptional("mcp.catalog");
    return typeof svc === "function" ? (svc as () => McpCatalogRow[]) : undefined;
  } catch {
    return undefined; // 图换代窗（CK-12 stale 守卫）——按服务缺席处理
  }
};

/** catalog 行快照（服务缺席 = 空表——mcp-ui 同语义：模块未启用不炸，消费面给指路文案）。 */
export const mcpCatalogRowsOf = async (h: NonNullable<HostedSession["core"]>): Promise<McpCatalogRow[]> =>
  (await mcpCatalogService(h))?.() ?? [];

/** mcp.catalog 行 → 「网络 · MCP」卡连接行投影（TUI mcpConnRows〔mcp-ui.ts:48〕同式：五态原文照传、
 *  说明段 = t("conn.desc") 传输型 + 工具数、connectMs 仅 connected 行带）。 */
const connRowOf = (r: McpCatalogRow): { name: string; state: McpCatalogRow["state"]; desc: string; connectMs?: number } => ({
  name: r.name,
  state: r.state,
  desc: t("conn.desc", { n: r.toolCount ?? "", transport: r.transport === "http" ? "HTTP" : "stdio" }),
  ...(r.state === "connected" && r.connectMs !== undefined ? { connectMs: r.connectMs } : {}),
});

/** GET /panel 响应体（§3 :232 PanelData 同形投影）：permissionNext 是函数（不可序列化——权限面
 *  归 T8 /permission 端点族）、cards 是 TUI 卡渲染面（§3 形状无此键——T15/T16 无消费方，YAGNI），
 *  均不进 JSON；elapsedMs 由托管装配时刻（hs.createdAt——F5 九轮⑤「本次托管开始」同义，resume
 *  旧会话不显示历史年龄）现算。 */
interface WebPanelData {
  model: string;
  session: string;
  cwd: string;
  elapsedMs: number;
  tokens: PanelData["tokens"];
  contextWindow: number;
  /** 上下文条（E3）：used = 末条 usage 输入，window = resolveContextWindow 解析链（configFace 同源，
   *  无显式配置回落 200k），pct = min(100, round(used/window×100))——ctxUsageText 同式。 */
  ctx: { used: number; window: number; pct: number };
  modules: PanelData["modules"];
  tasks: PanelData["tasks"];
  network?: PanelData["network"];
  peers?: { self?: PeerEntry; list: PeerEntry[] };
}

/** 系统代理一次读（缓存 Promise——reg query ~20ms，main.ts systemProxyOnce 同款纪律：展示专用）。 */
let systemProxyOnce: Promise<string | undefined> | undefined;

/** peers 行相位（/ps 序义排序键）：本进程托管行实时优先（T9 rowPhase 同口径）→ live.json 次之。 */
const peerPhase = (p: PeerEntry): PeerEntry["phase"] => webHostPool()?.host(p.sid)?.phase() ?? p.phase;

/** PS 相位序（ps.ts PHASE_ORDER 同序复刻：web/* 不改既有件——T9 api-session 同款本地常量）。 */
const PHASE_ORDER: Record<string, number> = {
  "waiting-approval": 0,
  "waiting-input": 1,
  running: 2,
  error: 3,
  idle: 4,
};
const phaseRank = (p: { phase: string }): number => PHASE_ORDER[p.phase] ?? 99; // 未知相位殿后（死行同义）

/** panel 装配（缓存未命中时）：refreshPanel 复用 TUI 同一聚合（getActiveApp 缺省 undefined——
 *  纯数据面零 TUI 依赖）+ cwd 用会话自身 cwd（refreshPanel 读 process.cwd()——TUI 单进程口径，
 *  web 多项目池须按会话改写）+ E6 peers（走查五轮修订：同桶外部进程——全桶合并面废弃）。
 *  refreshPanel 写 modules-ui 模块级 panelCache 单例——并发多会话装配交错会把「读到别人的快照」，
 *  故全部装配经 panelSerial 串行（检查-装配-读取单线程原子；缓存命中路径不进串行链——零成本）。 */
let panelSerial: Promise<unknown> = Promise.resolve();
let panelComputes = 0;
const assemblePanel = (hs: HostedSession): Promise<WebPanelData> => {
  const run = panelSerial.then(async (): Promise<WebPanelData> => {
    const h = hs.core;
    if (h === undefined) throw new Error("会话装配失败");
    const deps: ModulesUiDeps = {
      getH: () => h,
      getActiveApp: () => undefined,
      refreshSkillMenu: () => {}, // TUI 技能菜单刷新钩子——web 无菜单面
      proxyStateText: async () => {
        systemProxyOnce ??= readWindowsSystemProxy();
        return proxyDisplayText(envProxyUrl(), await systemProxyOnce, detectTunProxy());
      },
      runStartedAt: new Date(hs.createdAt).toISOString(), // 运行时间行：托管装配时刻（elapsedMs 源）
      permCycle: () => ["ask-risky", "ask-always", "never"], // main.ts PERM_CYCLE 同序（permissionNext 不进 JSON）
    };
    await refreshPanel(deps);
    const pd = getPanelCache(); // 串行链内读取——与 refreshPanel 间无插入点
    if (pd === undefined) throw new Error("panel 快照未就绪");
    const pool = webHostPool();
    const snap = pool?.snapshot();
    const peers: WebPanelData["peers"] = snap === undefined ? undefined : {
      // self 置顶（E6）：host 会话 presence 在扫描集；viewer 无 presence 可缺（scanWithSelf 同语义）
      ...(snap.peers.has(hs.sid) ? { self: { ...snap.peers.get(hs.sid)!, phase: peerPhase(snap.peers.get(hs.sid)!) } } : {}),
      // 2026-10-12 走查五轮：协同卡只列「同桶外部进程」——本池托管会话出列（左栏可切，重复列出
      // 被用户否）+ 跨桶全并面废弃（回归 TUI /ps 同项目口径：sid→桶 以 rows 为准，无盘 peer 行剔）。
      list: [...snap.peers.values()]
        .filter((p) => p.sid !== hs.sid && pool!.host(p.sid) === undefined)
        .filter((p) => snap.rows.find((r) => r.sid === p.sid)?.bucket === hs.bucket)
        .map((p) => ({ ...p, phase: peerPhase(p) }))
        .toSorted((a, b) => phaseRank(a) - phaseRank(b) || b.lastEventAt - a.lastEventAt),
    };
    const pct = pd.contextWindow > 0 ? Math.min(100, Math.round((pd.tokens.input / pd.contextWindow) * 100)) : 0;
    // network.connections（T10 指针闭合——TUI main.ts:1467 渲染期另并 mcpConnRows 的 web 版）：
    // 装配期 await mcp.catalog 现读，行随 panel 缓存 1s TTL 走（§5 律三）；MCP ops 写盘 reload 后
    // 显式失效（invalidatePanelCache——api-settings 消费）。
    let network = pd.network;
    if (network !== undefined) {
      network = { ...network, connections: (await mcpCatalogRowsOf(h)).map(connRowOf) };
    }
    return {
      model: pd.model,
      session: pd.session,
      cwd: shortenPath(hs.cwd, 26),
      elapsedMs: Date.now() - hs.createdAt,
      tokens: pd.tokens,
      contextWindow: pd.contextWindow,
      ctx: { used: pd.tokens.input, window: pd.contextWindow, pct },
      modules: pd.modules,
      tasks: pd.tasks,
      ...(network !== undefined ? { network } : {}),
      ...(peers !== undefined ? { peers } : {}),
    };
  });
  panelSerial = run.then(
    () => undefined,
    () => undefined, // 失败不拦后续装配（串行链只防交错，不传播错误）
  );
  panelComputes++;
  return run;
};

// ---------- panel 缓存（§5 律三：1s TTL + 事件失效） ----------

interface PanelCacheEntry { at: number; data: WebPanelData }
const panelCache = new Map<string, PanelCacheEntry>();

/** 装配计数（⑥ 断言面：1s 窗内连续 GET 只装配一次；事件/插拔失效后下一 GET 重算）。 */
export const panelComputeCount = (): number => panelComputes;

const invalidatePanel = (sid: string): void => {
  panelCache.delete(sid);
};

/** panel 缓存显式失效（T11 导出——api-settings 的 MCP ops 消费：写盘 reload 后与 T10 模块插拔
 *  同口径即失效，下一 GET 重算出 connections/模块新态）。 */
export const invalidatePanelCache = (sid: string): void => {
  invalidatePanel(sid);
};

/** 事件驱动失效集（§5 律三「turn/todo/模块事件即刷」）：turn 边界（start/end——tokens 在轮末落定）、
 *  压缩（input 换投影估算）、todo 写。模块插拔无会话事件流（h.reload 不落盘）——toggle 端点显式
 *  失效；assistant/message 不失效而走 tokens 就地补丁（withLiveTokens——TUI「token 有变化就得更新」
 *  同款，轮进行中缓存命中也能给出新鲜 tokens）。 */
const PANEL_INVALIDATE_EVENTS = new Set(["turn/start", "turn/end", "turn/compaction", "tool-todo/write"]);

/** 失效挂钩注册表（每 HostedSession 至多一个订阅——WeakSet 随会话回收，LRU 逐出不滞留）。 */
const panelWatched = new WeakSet<HostedSession>();

/** panel GET 解析会话时挂失效钩子：HostedSession.onEvent 是扇出面（T2 唯一订阅泵之后），
 *  每会话一档，回调内只动本会话缓存条目（O(1)——扇出成本不随缓存会话数放大）。 */
const watchPanelEvents = (hs: HostedSession): void => {
  if (panelWatched.has(hs)) return;
  panelWatched.add(hs);
  hs.onEvent((e: SessionEvent) => {
    if (PANEL_INVALIDATE_EVENTS.has(e.type)) {
      invalidatePanel(hs.sid);
      return;
    }
    if (e.type === "assistant/message") {
      // tokens 就地补丁（withLiveTokens 同款单行语义：{...cache, tokens: lastUsageOf(events)}——
      // 该函数签名钉死 TUI PanelData 形（permission/permissionNext 必带），web 投影直用 lastUsageOf）
      const entry = panelCache.get(hs.sid);
      if (entry !== undefined) entry.data = { ...entry.data, tokens: lastUsageOf([e]) };
    }
  });
};

/** GET /api/sessions/:sid/panel → PanelData 同形 JSON（§3 :232 + ok 加法键）。缓存命中直回
 *  （§5 律三：2s 轮询 × N 标签不放大成 N 次 history 全量读）；未命中装配 + 挂失效钩子。 */
registerRoute("GET", "/api/sessions/:sid/panel", async (_req, res, params) => {
  const sid = params["sid"] ?? "";
  const cached = panelCache.get(sid);
  if (cached !== undefined && Date.now() - cached.at < PANEL_CACHE_MS) {
    sendJson(res, 200, { ok: true, ...cached.data });
    return;
  }
  const hs = await resolveSession(sid);
  if (hs === undefined || hs.core === undefined) {
    notFound(res);
    return;
  }
  watchPanelEvents(hs);
  try {
    const data = await assemblePanel(hs);
    panelCache.set(sid, { at: Date.now(), data });
    sendJson(res, 200, { ok: true, ...data });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------- 模块插拔（E4：closure → setModuleEnabledInConfig → h.reload → ReloadReport 摘要） ----------

/** POST /api/sessions/:sid/modules/:name/toggle {enabled?} → {ok,action,name,report,toast} | 409 {error}
 *  （§3 :233）。链路 = main.ts toggleModule 同款（m5 T4 联动闭包 + S1 撞锁定拒绝 + S10 连带写日志）：
 *  锁定模块 → 409 原因文案；busy 期 → 409（reload 走 quiesce，busy 插拔是 TUI 拒收面同款）；
 *  body.enabled 可显式定方向（§3 形状），缺省按当前挂载态翻转；未知模块 → 404。
 *  viewer 会话同受理（配置写盘是全局面，harness reload 合法——只读化身不锁图）。 */
registerRoute("POST", "/api/sessions/:sid/modules/:name/toggle", async (req, res, params) => {
  const sid = params["sid"] ?? "";
  const name = params["name"] ?? "";
  const hs = await resolveSession(sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const h = hs.core;
  if (h === undefined) {
    notFound(res);
    return;
  }
  // body 可空（翻转档）；带 enabled 须布尔（显式方向档）
  const raw = await readBody(req, PANEL_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { enabled?: unknown } = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw.toString("utf8")) as typeof body;
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid json" });
      return;
    }
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    sendJson(res, 400, { ok: false, error: "enabled 必须为布尔值" });
    return;
  }
  if (hs.busy()) {
    sendJson(res, 409, { ok: false, error: t("main.module.busyToggle") });
    return;
  }
  const audit = h.graph().audit();
  const entry = audit.find((a) => a.name === name);
  if (entry === undefined) {
    notFound(res);
    return;
  }
  const lockedReason = lockReasonFor(name);
  if (lockedReason !== undefined) {
    sendJson(res, 409, { ok: false, error: lockedReason }); // 锁定原因文案（②/④ 同源——lockReasonFor）
    return;
  }
  const target = typeof body.enabled === "boolean" ? body.enabled : entry.state !== "active";
  // 卸载 tool-subagent 守卫（main.ts 同款）：在跑/排队/挂审批的子代理在册不许卸
  if (!target && name === "tool-subagent") {
    const block = subagentUnloadBlock(h.subagents());
    if (block !== undefined) {
      sendJson(res, 409, { ok: false, error: block });
      return;
    }
  }
  // 联动闭包（m5 T4）：卸载带走硬依赖者、挂载自动补提供者；撞锁定拒绝整次（S1）
  const depRows = audit.map((a) => ({ name: a.name, provides: a.provides, dependsOn: a.dependsOn, state: a.state }));
  const lockedNames = audit.filter((a) => lockReasonFor(a.name) !== undefined).map((a) => a.name);
  const closure = target ? computeMountClosure([name], depRows, lockedNames) : computeUnmountClosure([name], depRows, lockedNames);
  if (!closure.ok) {
    sendJson(res, 409, { ok: false, error: closure.blocked });
    return;
  }
  // 写盘段（行级保注释；中途失败 = 漏写侧下次 reload 走 topo 降级——main.ts 同安全方向）
  let written = 0;
  for (const n of closure.write) {
    try {
      setModuleEnabledInConfig(n, target, moduleConfigFileFor(n, h));
      written++;
    } catch {
      sendJson(res, 500, { ok: false, error: t("main.writePartialFail", { n: `${written}/${closure.write.length}` }) });
      return;
    }
  }
  const cascaded = closure.write.filter((n) => n !== name);
  const modulesBefore = activeModuleNamesOf(h); // web-dialog 批 T6：reload 前拍活跃集——diff 出消失模块即关其窗
  let report: ReloadReport;
  try {
    report = await h.reload();
  } catch (err) {
    sendJson(res, 500, { ok: false, error: t("main.toggle.fail", { err: err instanceof Error ? err.message : String(err) }) });
    return;
  }
  closeGoneDialogs(hs, modulesBefore); // TUI closeGoneModuleUi 同口径：diff 激活集（不解析 report——报表口径不一）
  if (cascaded.length > 0) {
    h.log("host.module.cascade", `${t("main.cascade.verb")}${target ? t("modtoggle.verbMount") : t("modtoggle.verbUnmount")} ${name}${t("main.cascade.colon")}${target ? t("skills.action.enable") : t("mcp.action.disable")} ${cascaded.join("、")}`, { action: target ? "mount" : "unmount", target: name, cascaded }); // S10：toast 只报目标，连带写诊断日志
  }
  invalidatePanel(sid); // 模块面变化（§5 律三——reload 无会话事件流，插拔端点显式失效）
  sendJson(res, 200, {
    ok: true,
    action: target ? "mount" : "unmount",
    name,
    report, // ReloadReport 摘要（added/removed/reloaded/unchanged/failed——§3 :233）
    toast: toggleResultText(target ? "mount" : "unmount", name, report), // T15 toast 直显串（t() 服务端装配）
  });
});

/** GET /api/sessions/:sid/tasks → {ok, rows}（§3：rows = (SubagentRosterEntry & {historical?:boolean})[]）。
 *  口径（§1 G3 = CLI openTasks 同源，tasks-cmd.ts:420）：活名册（h.subagents——进行中全列 + 已结束
 *  保留 32）∪ 盘上历史（agents/ 目录重建，简述/后台/工种从主会话 spawn 调用回查），按 id 去重——
 *  活名册优先（状态新鲜带 pendingApproval/truncated 标注）；sortNewestFirst 最新在最上（孙代理亲缘
 *  经 parentId 标注，分组渲染归前端 T16）；历史重建行带 historical:true。 */
registerRoute("GET", "/api/sessions/:sid/tasks", async (_req, res, params) => {
  const sid = params["sid"] ?? "";
  const hs = await resolveSession(sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const live = hs.core?.subagents() ?? [];
  const liveIds = new Set(live.map((e) => e.id));
  const historical = loadHistoricalSubagents(hs.sessionsDir, hs.sid)
    .filter((e) => !liveIds.has(e.id))
    .map((e) => ({ ...e, historical: true }));
  const rows: Array<SubagentRosterEntry & { historical?: boolean }> = sortNewestFirst([...live, ...historical]);
  sendJson(res, 200, { ok: true, rows });
});

/** POST /api/sessions/:sid/subagents/:id/approval {allow:boolean} → {ok} | {ok,noop:true}（§3）。
 *  h.answerSubagentApproval(id,allow) 生效——allow 放行（子代理继续）/ false 拒绝；无挂起审批
 *  （未知 id/已答）→ noop 幂等形（answer 端点同口径——多端抢答先到先得）；缺 allow/非布尔 → 400。 */
registerRoute("POST", "/api/sessions/:sid/subagents/:id/approval", async (req, res, params) => {
  const sid = params["sid"] ?? "";
  const id = params["id"] ?? "";
  const hs = await resolveSession(sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const raw = await readBody(req, PANEL_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { allow?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  if (typeof body.allow !== "boolean") {
    sendJson(res, 400, { ok: false, error: "allow 必须为布尔值" });
    return;
  }
  const h = hs.core;
  const delivered = h?.answerSubagentApproval(id, body.allow) ?? false;
  sendJson(res, 200, { ok: true, ...(delivered ? {} : { noop: true }) });
});

/** GET /api/sessions/:sid/subagents/:id/events → {ok, events}（§3 transcript 回放——末 500，§5 自创值）。
 *  agentEventsFromFile 直读（tasks-cmd 同源单口：路径形状 <桶>/<sid>/agents/agents_<id>/agents/
 *  session.jsonl，slice(-500) 截断）；文件不存在/未知 id → 空 events（200——「没有可回放的」不是
 *  错误，与 CLI 查看窗空态同语义）。事件为子代理会话文件原始行（无 seq 游标——append-only 全量
 *  末窗，分页属主会话回放面 T3，此处 §3 形状即全量末窗）。 */
registerRoute("GET", "/api/sessions/:sid/subagents/:id/events", async (_req, res, params) => {
  const sid = params["sid"] ?? "";
  const id = params["id"] ?? "";
  if (!/^[0-9a-f]{8}$/.test(id)) {
    sendJson(res, 400, { ok: false, error: "id 必须为八位十六进制编号" }); // 形态校验（终审收口）：id 直拼 agents_<id> 路径——%2F 单段解码可携穿越形态，tasks-cmd 名册 [0-9a-f]{8} 同款口径
    return;
  }
  const hs = await resolveSession(sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const events = agentEventsFromFile(hs.sessionsDir, hs.sid, id);
  sendJson(res, 200, { ok: true, events });
});

// ---------- 子代理 todo 悬浮条（批次三 W4——问题 2，数据 = 子代理会话文件） ----------

/** 子代理 todo 缓存条目（§5 律三 panel 同款 TTL 口径——2s 轮询 × N 标签共享同一份文件读）。 */
interface AgTodoCacheEntry { at: number; tasks: { text: string; state: "done" | "active" | "pending" }[] }
const agTodoCache = new Map<string, AgTodoCacheEntry>();

/** GET /api/sessions/:sid/subagents/:id/todo → {ok, tasks:[{text,state}]}（W4 悬浮条数据面）。
 *  读子代理会话文件末条 tool-todo/write（agentEventsFromFile 末窗基建——events 端点同源读法），
 *  投影复用 panelTasksFromEvent（todo-panel 同源单口——主/子清单口径一致：content/status → text/state，
 *  元素级防御同承）；todo_write 是全量替换语义，末条即当前清单。无文件/无 todo 事件/载荷非数组 →
 *  空表（「没有清单」不是错误——events 端点空态同语义）；未知 sid → 404。
 *  1s 缓存复用 PANEL_CACHE_MS（panel 同款口径）；事件驱动失效后置——子代理事件落自己的
 *  session.jsonl，不经主会话 onEvent 泵，TTL 出窗即出新值（悬浮条 2s 轮询下新鲜度足够）。 */
registerRoute("GET", "/api/sessions/:sid/subagents/:id/todo", async (_req, res, params) => {
  const sid = params["sid"] ?? "";
  const id = params["id"] ?? "";
  if (!/^[0-9a-f]{8}$/.test(id)) {
    sendJson(res, 400, { ok: false, error: "id 必须为八位十六进制编号" }); // 形态校验（终审收口）：events 端点同款——id 直拼 agents_<id> 路径，先于缓存查拒
    return;
  }
  const key = `${sid}/${id}`;
  const cached = agTodoCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < PANEL_CACHE_MS) {
    sendJson(res, 200, { ok: true, tasks: cached.tasks });
    return;
  }
  const hs = await resolveSession(sid);
  if (hs === undefined) {
    notFound(res);
    return;
  }
  const lastTodo = agentEventsFromFile(hs.sessionsDir, hs.sid, id)
    .toReversed()
    .find((e) => e.type === "tool-todo/write");
  const tasks = (lastTodo !== undefined ? panelTasksFromEvent(lastTodo) : undefined) ?? [];
  agTodoCache.set(key, { at: Date.now(), tasks });
  sendJson(res, 200, { ok: true, tasks });
});

// ---------- 更多菜单四端点（T14：A7 ⋮ 菜单数据面——TUI Ctrl+E/P/H/O 的 web 化，打开即拉不缓存） ----------

/** 查询参数解析（api-model queryParams 同款本地件——web/* 小工具不跨文件共享的既有惯例）。 */
const queryParams = (req: IncomingMessage): URLSearchParams => {
  const url = req.url ?? "";
  const qi = url.indexOf("?");
  return new URLSearchParams(qi >= 0 ? url.slice(qi + 1) : "");
};

/** 读侧会话解析（api-model resolveForRead 同口径）：sid 缺省 = 池当前会话游标（⋮ 菜单作用于
 *  「本会话」——前端不传 sid 即当前选中）；显式 sid host 优先、盘上未托管走 viewer 只读化身；
 *  显式不可解析 = undefined（调用方 404——sid 打错不静默空态）；无 sid 且无当前游标 = undefined
 *  （调用方空态——读面不 404）。
 *  走查修（2026-10-15 用户报障「模块总览显示不出带界面模块」）：空 sid 原用 pool.current()——那只认
 *  host 会话，而 switchCurrent 明确允许游标指向 viewer 化身（侧栏点击未发消息的会话即 viewer）→
 *  current() undefined → 端点拿空 audit → 总览/诊断双面恒空。改用 cursorSid() 直读游标 + viewer
 *  兜底装配（switchCurrent 注释「viewer 化身同样可作游标」的兑现）。 */
const resolveGlobalRead = async (sid: string): Promise<HostedSession | undefined> => {
  const pool = webHostPool();
  if (pool === undefined) return undefined;
  const target = sid !== "" ? sid : pool.cursorSid();
  if (target === undefined) return undefined;
  const hosted = pool.host(target);
  if (hosted !== undefined) return hosted;
  return pool.viewer(target).then(
    (hs) => hs,
    () => undefined, // 不在盘/装配失败——按 sid 有无定 404/空态
  );
};

/** GET /api/diagnostics → {ok, rows, logDir}（§3 :271）。rows = graph().audit() **failed 行**
 *  （A7 口径——「本会话出过问题的模块」；active/discovered/pending-confirm 不进：待决不是失败，
 *  kernel types.ts ModuleState 注释同义）；行形 {name, failReason, state}（failReason 缺失兜底
 *  空串——§3 形状必带键）。logDir = 诊断日志目录（TUI Ctrl+E 详情尾行「诊断日志：<file>」同源，
 *  readDiagnostics 的目录段——前端指路用）。空会话（无当前游标）→ 空表 + logDir 仍有效。 */
registerRoute("GET", "/api/diagnostics", async (req, res) => {
  const sid = queryParams(req).get("sid") ?? "";
  const hs = await resolveGlobalRead(sid);
  if (hs === undefined && sid !== "") {
    notFound(res); // 显式 sid 不可解析（api-model 同口径）
    return;
  }
  const rows = (hs?.core?.graph().audit() ?? [])
    .filter((a) => a.state === "failed")
    .map((a) => ({ name: a.name, failReason: a.failReason ?? "", state: a.state }));
  sendJson(res, 200, { ok: true, rows, logDir: join(orosusHome(), "logs") });
});

/** GET /api/launchers → {ok, cards}（§3 :272）。cards = active 模块 launcher 登记投影
 *  {module, title, desc?}——collectLaunchers（module-launcher.ts：Ctrl+P 总览弹窗同一收集口，
 *  main.ts:1603 同源）+ title 经 t(labelKey, undefined, label) 翻译（launcherRows/fullapp-overlay
 *  同式——声明方自报键回落原文）；desc = 登记命令（Enter 执行面——T17 前端据此透传 h.prompt 或
 *  send）。方案 A7 单元格引 moduleCards()（modules-ui.ts）系笔误：那是 TUI 右栏模块卡的渲染面
 *  （widgets 含 getter 不可序列化、无 module/desc 键），与本端点形状无交集——以 §3 :272 端点名/
 *  形状 + 原型「模块总览 → 带界面模块的启动器（TUI Ctrl+P）」为准。 */
registerRoute("GET", "/api/launchers", async (req, res) => {
  const sid = queryParams(req).get("sid") ?? "";
  const hs = await resolveGlobalRead(sid);
  if (hs === undefined && sid !== "") {
    notFound(res);
    return;
  }
  const cards = collectLaunchers(hs?.core?.graph().audit() ?? []).map((e) => ({
    module: e.name,
    title: e.labelKey !== undefined ? t(e.labelKey, undefined, e.label) : e.label,
    ...(e.command !== undefined ? { desc: e.command } : {}),
  }));
  sendJson(res, 200, { ok: true, cards });
});

/** GET /api/sessions/:sid/hooks-activity → {ok, groups}（§3 :237）。分桶 = buildHookBuckets
 *  （hooks-ui.ts:111 同源单口：hooks/run 与 steering 注入归属最近一条 user/message、首条消息前
 *  的活动并入首桶、running 账按 runId 去重——TUI Ctrl+H 查看窗一字不差的语义复用）；
 *  groups 投影 {userText = 桶 label（消息首行截断 ≤40）, count = 运行账条数, injections = 注入
 *  文本数组}。无钩子活动 → 空表（「没有可看的」是空态不是错误）；viewer 只读化身同出数。 */
registerRoute("GET", "/api/sessions/:sid/hooks-activity", async (_req, res, params) => {
  const sid = params["sid"] ?? "";
  const hs = await resolveSession(sid);
  const h = hs?.core;
  if (h === undefined) {
    notFound(res);
    return;
  }
  const groups = buildHookBuckets(await h.history()).map((b) => ({
    userText: b.label,
    count: b.runs.length,
    injections: b.injections.map((m) => m.text),
  }));
  sendJson(res, 200, { ok: true, groups });
});

/** turn/compaction 载荷标量统计投影（v2-v4 并集里可进摘要面的数字/元字段；keptUsers 完整投影
 *  消息不内联——重载荷是回放面的事，摘要口只给 Ctrl+O 头行同级的统计）。 */
const compactionStatsOf = (e: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (typeof e["trigger"] === "string" && e["trigger"] !== "") out["trigger"] = e["trigger"];
  if (typeof e["keepUserHead"] === "number") out["keepUserHead"] = e["keepUserHead"];
  if (typeof e["elidedCount"] === "number") out["elidedCount"] = e["elidedCount"];
  if (typeof e["droppedCount"] === "number") out["droppedCount"] = e["droppedCount"];
  return out;
};

/** GET /api/sessions/:sid/compaction → {ok, at, summary, stats} | 404（§3 :238）。末条带 summary 的
 *  turn/compaction（compaction-view「全部列出最新在最上」的 web 单对象形——开窗即见最近一次）；
 *  at = 事件 ts（ISO）、summary = 载荷 summary、stats = 标量统计投影（trigger/保留头/省略数/压掉数）。
 *  无任何可用事件 → 404（Ctrl+O 无摘要走 toast 提示的 web 对应——缺资源不是空表）；viewer 同出数。 */
registerRoute("GET", "/api/sessions/:sid/compaction", async (_req, res, params) => {
  const sid = params["sid"] ?? "";
  const hs = await resolveSession(sid);
  const h = hs?.core;
  if (h === undefined) {
    notFound(res);
    return;
  }
  const events = await h.history();
  const last = events.toReversed().find((e): e is SessionEvent & { summary: string } =>
    e.type === "turn/compaction" && typeof (e as { summary?: unknown }).summary === "string");
  if (last === undefined) {
    notFound(res);
    return;
  }
  sendJson(res, 200, { ok: true, at: last.ts, summary: last.summary, stats: compactionStatsOf(last as unknown as Record<string, unknown>) });
});
