/** web 批 T8——模型/思考档位/权限/命令表 API（api-model.ts）：
 *  - GET /api/models（§3 形状 {current, providers:[{key,displayName,models:[{name,label,ctx,
 *    efforts?:string[],cur}]}]}）——D9：/model 的 choose 菜单内嵌在 core 命令里（§4-5），web 不走
 *    choose 桥，本端点是结构化两级菜单的数据面。数据源 = D9 点名的三服务调：graph().services
 *    .listProviders() + 槽值 listModels()（目录优选 + live 兜底；失败/无能力 → 空清单降级——「未配置」
 *    菜单态）+ listThinking()（D10 档位源）。cur 勾标 = core /model 同款推导（harness.ts:912-919：
 *    全名取首斜杠后段；裸槽名经 defaultModel 解析）。label/ctx：D9 只点名三服务调（无目录直读），
 *    label = name、ctx = 0（未知）——真目录 label/ctx 是 T13 提供商面（/api/providers/catalog）交付。
 *  - efforts 档位推导与 core /effort 菜单逐字同式（kimi segments：目录档位原文；offEffort/toggle
 *    在场 → off 前缀；纯 toggle → on/off）——**无 auto 伪档**（D10 用户 2026-10-10 口令）。芯片「未
 *    设置时显示目录默认档名」的数据面在 GET status 的 effort 键（core resolveStoredEffort 解析值，
 *    未设 = 目录默认档——harness 预热 memo），本端点不另出 auto。
 *  - POST /api/sessions/:sid/model {platform,model} → {ok}：h.setModel（harness.ts:1520——覆盖槽 +
 *    写盘顶层 provider 键 + 档位跟随重解析；busy 安全下一轮生效，D9）。
 *  - POST /api/sessions/:sid/effort {level} → {ok}：h.setEffort（:1527——写盘顶层 effort 键）。level =
 *    模型目录档位原文；格式闸与 core 同规（仅小写字母数字与 . _ -）；**auto 拒收**（D10：web 不提供
 *    auto/清档口——未设置即目录默认档）。
 *  - POST /api/sessions/:sid/permission {mode} → {ok}：h.prompt("/permission "+mode)（D8——core 命令
 *    路由在单并发守卫之前 harness.ts:1275，busy 安全；写生效层 + approval/policy 事件回流）。
 *  - GET /api/commands → {items:[{name,desc,long,aliases?[]}]}（§3）：web 命令表 15 条（含 /web——
 *    2026-10-12 走查口径）。G1：不含 /settings /sessions /provider /permission——走界面；/context
 *    键入放行但菜单不列；模块 __ 命令不投影入表（TUI slashItems 同款口径——键入经透传面仍可达，
 *    仅菜单不列）。desc/long 复用 slashItems 同族 t() 键（slashItems 是 main.ts:1339 模块私有、
 *    main.ts import 即执行不可 import——G1，web 表自写复用同键）。技能不在命令面（D13：技能清单
 *    走 /api/settings/skills〔T13〕，菜单技能区与命令区分家）。
 *  会话解析：写侧三端点 host-only（setModel/setEffort/h.prompt 落的是用户级 config.toml——viewer
 *  只读化身不写：盘上未托管 → 409 只读形，不在盘 → 404）；GET 两端点读侧 ?sid= → host 优先、
 *  viewer 兜底（api-session resolveSession 同口径；显式 sid 不可解析 → 404），sid 缺省 = 池当前会话
 *  游标（/web 交接指向——T9 起 POST /api/sessions 维护），无活会话 → 空态（models 空表 /
 *  commands 仅宿主表）。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { locateSessionFile } from "@orosus/core";
import { registerRoute, readBody, sendJson } from "./server.ts";
import { webHostPool } from "./mod.ts";
import type { HostedSession } from "./hosted.ts";
import type { HostPool } from "./hostpool.ts";
import { t } from "../i18n/app.ts";

/** 写侧 JSON 体上限（自创值登记——platform/model/mode/level 都是短串；防失控客户端撑内存）。 */
const MODEL_BODY_MAX_BYTES = 64 * 1024;

/** listThinking 结果形状（activate.ts ProviderAdapter 槽值契约——消费侧类型本地声明）。 */
interface ThinkingInfo { efforts: string[]; offEffort?: string; hasToggle: boolean }

/** 槽值归一形态（graph().services.provider 的返回面——消费侧类型本地声明，圈地纪律）。 */
interface ProviderSlot {
  listModels?: () => Promise<string[]>;
  listThinking?: (model: string) => Promise<ThinkingInfo | undefined>;
  defaultModel?: string;
}

const notFound = (res: ServerResponse): void => {
  sendJson(res, 404, { ok: false, error: "not found" });
};

const queryParams = (req: IncomingMessage): URLSearchParams => {
  const url = req.url ?? "";
  const qi = url.indexOf("?");
  return new URLSearchParams(qi >= 0 ? url.slice(qi + 1) : "");
};

/** 读侧会话解析（api-session resolveSession 同口径 + 当前游标兜底）：sid 缺省 = 池当前会话；
 *  显式 sid host 优先、盘上未托管走 viewer 只读化身；不可解析 = undefined（调用方 404——显式
 *  sid 打错不该静默空态）。无 sid 且无当前游标 → undefined（调用方空态——读面不 404）。 */
const resolveForRead = async (pool: HostPool | undefined, sid: string | undefined): Promise<HostedSession | undefined> => {
  if (pool === undefined) return undefined;
  const target = sid !== undefined && sid !== "" ? sid : pool.current()?.sid;
  if (target === undefined) return undefined;
  const hosted = pool.host(target);
  if (hosted !== undefined) return hosted;
  if (sid === undefined || sid === "") return undefined; // 游标失效（会话已关）——空态而非 404
  return pool.viewer(target).then(
    (hs) => hs,
    () => undefined, // 不在盘/装配失败——调用方 404
  );
};

/** 写侧会话解析：host 优先，viewer/盘上未托管 → ensureHost 换轨升级（2026-10-12 走查修——此前
 *  viewer 409 只读形，浏览态会话切模型/权限全拦；升级面锁检在 runText/装配层定形）。
 *  返回 undefined = 响应已回（404——不在盘/装配失败）。 */
const writeTarget = async (pool: HostPool | undefined, sid: string, res: ServerResponse): Promise<HostedSession | undefined> => {
  if (pool === undefined) {
    notFound(res);
    return undefined;
  }
  const hosted = pool.host(sid);
  if (hosted !== undefined) return hosted;
  if (locateSessionFile(pool.root, sid) === undefined) {
    notFound(res);
    return undefined;
  }
  return pool.ensureHost(sid).then(
    (hs) => hs,
    () => {
      sendJson(res, 409, { ok: false, error: "会话装配失败（重试或检查会话文件）" });
      return undefined;
    },
  );
};

/** 写侧请求体解析（三端点同口径）：JSON parse + 字段收形（string 化——坏形交调用方 400）。 */
type FieldsResult = { failed: true; status: number; msg: string } | { failed: false; fields: Record<string, unknown> };

const readFields = async (req: IncomingMessage): Promise<FieldsResult> => {
  const raw = await readBody(req, MODEL_BODY_MAX_BYTES);
  if (raw === "too-large") return { failed: true, status: 413, msg: "body too large" };
  try {
    return { failed: false, fields: JSON.parse(raw.toString("utf8")) as Record<string, unknown> };
  } catch {
    return { failed: true, status: 400, msg: "invalid json" };
  }
};

// ---------- GET /api/models（D9/D10 数据面） ----------

/** listThinking 结果 memo（(槽,模型) 键，cap 1024 防无界——§5 律三「扫描解析有缓存」的 web 侧
 *  对应物：core 的 thinkingInfoOf 是 harness 闭包 memo〔harness.ts:1059〕，而 provider-custom 的
 *  listThinking 每调重读 1.6MB 目录缓存——不 memo 则每次开菜单全清单重解析。目录档位集演进罕见，
 *  memo 跨 harness reload 存活（core 的 memo 亦跨 turn 存活，同代位——新鲜度归 /provider 在线链路）。 */
const THINKING_MEMO_CAP = 1024;
const thinkingMemo = new Map<string, ThinkingInfo | undefined>();

const thinkingOf = async (slot: ProviderSlot, slotName: string, model: string): Promise<ThinkingInfo | undefined> => {
  const key = `${slotName}/${model}`;
  if (thinkingMemo.has(key)) return thinkingMemo.get(key);
  let info: ThinkingInfo | undefined;
  try {
    info = (await slot.listThinking?.(model)) ?? undefined;
  } catch {
    info = undefined; // 目录读失败 = 无信息（lenient 面——core thinkingInfoOf 同款）
  }
  if (thinkingMemo.size > THINKING_MEMO_CAP) thinkingMemo.clear();
  thinkingMemo.set(key, info);
  return info;
};

/** 菜单档位推导（kimi segments——harness.ts:1081 segmentsOf 逐字同式，D10：无 auto 伪档）：
 *  目录档位原文；offEffort/toggle 声明在场 → off 前缀；纯 toggle 型 → on/off 两项。 */
const segmentsOf = (info: ThinkingInfo): string[] =>
  info.efforts.length > 0
    ? (info.offEffort === undefined && !info.hasToggle ? [...info.efforts] : ["off", ...info.efforts])
    : ["on", "off"];

/** h.status().model 的「（未配置）」哨兵归一（harness.ts:1473——未配置时 status 返回显示串而非空；
 *  web 协议面用空串，前端按空态渲染「未配置」提示——D9）。 */
const unconfiguredToEmpty = (raw: string): string => (raw === "（未配置）" ? "" : raw);

registerRoute("GET", "/api/models", async (req, res) => {
  const sid = queryParams(req).get("sid") ?? "";
  const hs = await resolveForRead(webHostPool(), sid === "" ? undefined : sid);
  const h = hs?.core;
  if (h === undefined && sid !== "") {
    notFound(res); // 显式 sid 不可解析——与 api-session 404 口径一致
    return;
  }
  if (h === undefined) {
    sendJson(res, 200, { current: "", providers: [] }); // 无活会话——空态（D9 未配置提示的数据面）
    return;
  }
  const graph = h.graph();
  const current = unconfiguredToEmpty(h.status().model);
  const providers: { key: string; displayName: string; models: { name: string; label: string; ctx: number; efforts?: string[]; cur: boolean }[] }[] = [];
  for (const slot of graph.services.listProviders()) {
    const adapter: ProviderSlot | undefined = graph.services.provider(slot.name);
    let models: string[] = [];
    if (adapter?.listModels !== undefined) {
      try {
        models = await adapter.listModels();
      } catch {
        models = []; // live 兜底失败（死端口/网络断）——空清单降级，菜单出「未配置」态
      }
    }
    // cur 勾标推导（core /model 同式 harness.ts:912-919：全名取首斜杠后段；裸槽名经 defaultModel）
    const curBare = current.includes("/")
      ? current.slice(current.indexOf("/") + 1)
      : current === slot.name ? slot.defaultModel : current;
    const rows: { name: string; label: string; ctx: number; efforts?: string[]; cur: boolean }[] = [];
    for (const m of models) {
      const info = adapter === undefined ? undefined : await thinkingOf(adapter, slot.name, m);
      const segs = info === undefined ? undefined : segmentsOf(info);
      rows.push({ name: m, label: m, ctx: 0, ...(segs !== undefined ? { efforts: segs } : {}), cur: m === curBare });
    }
    providers.push({ key: slot.name, displayName: slot.name, models: rows });
  }
  sendJson(res, 200, { current, providers });
});

// ---------- POST model / effort / permission（写侧三端点——host-only） ----------

/** POST /api/sessions/:sid/model {platform,model} → {ok}（§3）。h.setModel 走 core 单一写者口
 *  （命令与设置服务同源——覆盖槽 + 写盘顶层 provider 键 + contextWindow/档位跟随重解析在 core
 *  闭环）；busy 安全下一轮生效（D9）。platform 须在图内（防手误写脏 config）。 */
registerRoute("POST", "/api/sessions/:sid/model", async (req, res, params) => {
  const hs = await writeTarget(webHostPool(), params["sid"] ?? "", res);
  if (hs === undefined) return;
  const fields = await readFields(req);
  if (fields.failed) {
    sendJson(res, fields.status, { ok: false, error: fields.msg });
    return;
  }
  const platform = typeof fields.fields["platform"] === "string" ? fields.fields["platform"].trim() : "";
  const model = typeof fields.fields["model"] === "string" ? fields.fields["model"].trim() : "";
  if (platform === "" || model === "") {
    sendJson(res, 400, { ok: false, error: "platform 与 model 不能为空" });
    return;
  }
  const h = hs.core;
  if (h === undefined) {
    sendJson(res, 409, { ok: false, error: "会话装配失败" });
    return;
  }
  if (h.graph().services.provider(platform) === undefined) {
    sendJson(res, 400, { ok: false, error: `未知平台 "${platform}"` });
    return;
  }
  try {
    await h.setModel(`${platform}/${model}`); // 模型 id 可含斜杠（嵌套 id——parseModel 首斜杠切槽名）
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /api/sessions/:sid/effort {level} → {ok}（§3）。level = 模型目录档位原文（D10——无 auto
 *  伪档：auto 拒收，未设置态本就解析为目录默认档）；格式闸与 core applyEffortOverride 同规。
 *  目录外手设档 core 亦 lenient 收（自定义端点模型可不在目录）——本端点同口径放行。 */
registerRoute("POST", "/api/sessions/:sid/effort", async (req, res, params) => {
  const hs = await writeTarget(webHostPool(), params["sid"] ?? "", res);
  if (hs === undefined) return;
  const fields = await readFields(req);
  if (fields.failed) {
    sendJson(res, fields.status, { ok: false, error: fields.msg });
    return;
  }
  const level = typeof fields.fields["level"] === "string" ? fields.fields["level"].trim() : "";
  if (level === "") {
    sendJson(res, 400, { ok: false, error: "level 不能为空" });
    return;
  }
  if (level === "auto") {
    sendJson(res, 400, { ok: false, error: "web 无 auto 伪档（未设置即目录默认档——D10）" });
    return;
  }
  if (!/^[a-z0-9._-]+$/.test(level)) {
    sendJson(res, 400, { ok: false, error: `档位名 "${level}" 不合法（仅限小写字母数字与 . _ -）` });
    return;
  }
  const h = hs.core;
  if (h === undefined) {
    sendJson(res, 409, { ok: false, error: "会话装配失败" });
    return;
  }
  try {
    h.setEffort(level); // 写盘顶层 effort 键 + 会话内存覆盖（core 单一写者口）
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /api/sessions/:sid/permission {mode} → {ok}（§3 D8）。等价 /permission <mode>：透传 core
 *  别名表路由 approval__permission（写生效层 + approval/policy 事件 + 运行期 override 即时可见）；
 *  busy 安全（core 命令路由在单并发守卫之前 harness.ts:1275——不经 send 分流，无排队）。 */
registerRoute("POST", "/api/sessions/:sid/permission", async (req, res, params) => {
  const hs = await writeTarget(webHostPool(), params["sid"] ?? "", res);
  if (hs === undefined) return;
  const fields = await readFields(req);
  if (fields.failed) {
    sendJson(res, fields.status, { ok: false, error: fields.msg });
    return;
  }
  const mode = fields.fields["mode"];
  if (mode !== "ask-always" && mode !== "ask-risky" && mode !== "never") {
    sendJson(res, 400, { ok: false, error: 'mode 须为 "ask-always" | "ask-risky" | "never"' });
    return;
  }
  const h = hs.core;
  if (h === undefined) {
    sendJson(res, 409, { ok: false, error: "会话装配失败" });
    return;
  }
  try {
    await h.prompt(`/permission ${mode}`); // 静默命令——反馈走 status.permission/policy 事件
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------- GET /api/commands（G1/D13 命令表） ----------

/** web 命令表 12 条（原型 CMDS 序 + /web 入表——2026-10-12 走查口径：/model 去〔模型切换走 composer
 *  芯片两级菜单，键入 /model 仍可达，cmdrouter mark:menu:model 面不变〕+ 走查五轮 /ps /quit 出表
 *  〔运行状态右侧卡片已覆盖其功能——键入仍可达，cmdrouter 执行面不变，仅菜单不列〕；
 *  G1：不含 /settings /sessions /provider /permission——走界面；/context 键入放行但菜单不列）。
 *  模块命令（<module>__<command>）**不投影入表**——TUI 菜单同款口径
 *  （slashItems 不列模块命令；走查前曾投影全量 __ 原名被用户否了——键入仍经 cmdrouter 透传面可达，
 *  仅菜单不列）。key = slashItems 同族 t() 键段（三语齐备）。 */
const WEB_CMDS: readonly { name: string; key: string; aliases?: readonly string[] }[] = [
  { name: "/yolo", key: "yolo" },
  { name: "/auto", key: "auto" },
  { name: "/help", key: "help" },
  { name: "/effort", key: "effort" },
  { name: "/compact", key: "compact" },
  { name: "/tasks", key: "tasks", aliases: ["task"] },
  { name: "/btw", key: "btw" },
  { name: "/web", key: "web" },
  { name: "/new", key: "new" },
  { name: "/fork", key: "fork" },
  { name: "/title", key: "title", aliases: ["rename"] },
  { name: "/reload", key: "reload" },
];

registerRoute("GET", "/api/commands", async (req, res) => {
  const sid = queryParams(req).get("sid") ?? "";
  const hs = await resolveForRead(webHostPool(), sid === "" ? undefined : sid);
  if (hs === undefined && sid !== "") {
    notFound(res);
    return;
  }
  const items: { name: string; desc: string; long: string; aliases?: string[]; module?: boolean }[] = WEB_CMDS.map((c) => ({
    name: c.name,
    desc: t(`slash.items.${c.key}.desc`),
    long: t(`slash.items.${c.key}.long`),
    ...(c.aliases !== undefined ? { aliases: [...c.aliases] } : {}),
  }));
  sendJson(res, 200, { items });
});
