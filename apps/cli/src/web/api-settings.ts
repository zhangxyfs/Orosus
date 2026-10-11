/** 设置端点（web 批 T11 骨架 + MCP 页；T12 本任务面——常规/语言/更新检查/模型偏好四页数据面 +
 *  /api/update 更新内容链路；§2 清单其余页归 T13）：
 *  - GET /api/settings/mcp（§3 :254 → {servers:McpCatalogRow[]}）：mcp.catalog 服务行原样透传
 *    （五态/来源/指纹/failReason/connectMs 齐备——F6 详情页与 E5 审阅指纹的数据面）；
 *  - POST /api/settings/mcp/ops（§3 :255 {op,name?,spec?} → {ok,report?}）：op 透传 runMcpCommand
 *    （on/off/trust/remove/add）+ edit（结构化写——runMcpCommand 无 edit 子命令，TUI 添加窗 edit
 *    模式同款 writeNestedTable 写器）+ start（E5 失败重连/F6 启动同口——懒启动件触发 mcp.start）；
 *    wrote → h.reload() 直接 await（§4-12：自带 in-flight 互斥与失败旧图续跑，busy 期排队语义同
 *    core——与 T10 模块插拔的 busy 409 不同面，MCP 设置写盘不拒 busy）+ panel 缓存显式失效。
 *  - GET /api/settings/general（§3 :248，F1）：disk 五目录结构化（diskUsageText 同源名序）+ total 行、
 *    tokens（h.usage 同源——本会话 current + 项目累计 lifetime）、ctx（lastUsageOf 末条投影 +
 *    configFace 窗口）、runtime（托管装配时刻 elapsed——panel 同源）；
 *  - GET/POST /api/settings/locale（§3 :259-260，F8）：三语 + 语言包槽列表；POST 走 h.setLanguage
 *    （写 config 顶层 language + 内核地板对齐——新 harness 生效；页面自身不切语言，F8 边界）；
 *  - GET/POST /api/settings/update（§3 :261-262，F9）：[update] check 开关读写（writeUpdateCheckKey）；
 *  - POST /api/settings/prefs（§3 :263，F3）：模型偏好五键——visionModel（[tool-media] 三态）/
 *    search.backend（[tool-web] 四态）/ [tool-subagent] model|approvalMode|maxTurns（null=跟随删键，
 *    subagent-settings 写键族同款）——分别落 modules.d/tool-{media,web,subagent}.toml + reload 收口；
 *  - GET /api/update（§3 :264，A4）：{current,latest?,hasUpdate,notes?,skipped?}——registry 全量 doc
 *    自取（不动 update-check.ts 既有行为）：notes = readme 切「## 更新日志 → ### v<latest>」小节
 *    （sliceChangelogNotes——与 scripts/release.mts 发布门禁同一格式契约）、skipped = versions 键序
 *    中 current 与 latest 之间；懒取（弹窗打开才查）+ 1h 内存缓存 + 失败静默降级（回落启动检查缓存
 *    updateInfoNow——stale-while-error，update-check.ts D2 同口径）。
 *  数据面锚定当前会话 harness（设置弹窗全局、模块图随会话——catalog/lazyState 每会话一图）；
 *  无当前会话 = GET 空表 / start 409；on/off/trust/remove/add 走纯配置面（deps 不含 getH）照常写盘，
 *  reload 缺席如实省略（report 不带——后续会话装配自然读新配置）。
 *  边界留档（§4-1/§4-2——帮助页注记归 T18）：项目 .mcp.json 仅对 server 启动 cwd 生效
 *  （mcp/index.ts:379 读 process.cwd()）——deps.projectPath 即池 startCwd 与模块同口径；
 *  mcp-trust.json 模块侧硬编码 homedir()（知悉不修），web 侧注入 join(orosusHome(), "mcp-trust.json")
 *  ——生产（OROSUS_HOME 未设）与 mcpTrustFile() 同径，测试重定向隔离不落真 home。 */
import { join } from "node:path";
import { loadConfig, sectionPath, writeSectionKey, writeNestedTable, type Harness, type NestedTableValue, type ReloadReport } from "@orosus/core";
import { orosusHome } from "@orosus/contracts/home";
import { OROSUS_USER_AGENT, OROSUS_VERSION } from "@orosus/contracts/version";
import { persistVisionModel } from "@orosus/tool-media";
import type { McpCatalogRow } from "@orosus/mcp";
import { runMcpCommand, defaultMcpCmdDeps, type McpCmdDeps } from "../mcp-cmd.ts";
import { configFace, configFacePaths } from "../config-face.ts";
import { dirUsage } from "../tuicfg.ts";
import { lastUsageOf } from "../usage-text.ts";
import { BUILTIN_LOCALES, createLocaleStore } from "../i18n/store.ts";
import { readUpdateCheckEnabled, updateConfigFile, writeUpdateCheckKey } from "../update-settings.ts";
import { isNewerVersion, UPDATE_CHECK_TIMEOUT_MS, updateInfoNow } from "../update-check.ts";
import { writeSubagentConfigKey } from "../subagent-settings.ts";
import { registerRoute, readBody, sendJson } from "./server.ts";
import { webHostPool } from "./mod.ts";
import { mcpCatalogService, invalidatePanelCache } from "./api-panel.ts";
import { t } from "../i18n/app.ts";

/** 会话解析后的 JSON 体上限（send/toggle 1MiB 同款自创值口径——edit spec/env 表量级，防失控客户端）。 */
const SETTINGS_BODY_MAX_BYTES = 1024 * 1024;

const notFound = (res: Parameters<typeof sendJson>[0]): void => {
  sendJson(res, 404, { ok: false, error: "not found" });
};

// ---------- MCP 面（F6 / E5） ----------

/** edit spec 白名单键 → 值形状校验（审查修复件）：键族 = mcp 模块 config schema（mcp/index.ts
 *  zod：command/args/env/url/enabled/deferred/timeoutMs/headers/cwd/transport/lazy——accesses
 *  不在册：NestedTableValue 无其形，TUI 添加窗同款不写）；值形状 = NestedTableValue 合法形
 *  （write.ts:107——string/number/boolean/string[]/单层平坦 string map）。**写盘前全量校验**：
 *  writeNestedTable 无输出校验，null 值会写出非法 TOML、深层对象序列化成 [object Object]——
 *  带病落盘砖化 mcp.toml 后 CM-01（write.ts:165-170）令后续一切写入静默 no-op 仍报成功。
 *  TUI 自家 JSON 摄入口（mcp-add-window.ts parseJsonPaste）白名单 + 形状校验后才到同一写器——
 *  web 端点对齐同口径。另要求 command/url 至少一项非空（parseJsonPaste noStartup 同判据——
 *  防空壳覆写砖化条目）。 */
const isFlatStringMap = (v: unknown): boolean =>
  v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");

const EDIT_SPEC_KEYS: Record<string, (v: unknown) => boolean> = {
  command: (v) => typeof v === "string" && v !== "",
  url: (v) => typeof v === "string" && v !== "",
  args: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  env: isFlatStringMap,
  headers: isFlatStringMap,
  cwd: (v) => typeof v === "string",
  timeoutMs: (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  enabled: (v) => typeof v === "boolean",
  deferred: (v) => typeof v === "boolean",
  lazy: (v) => typeof v === "boolean",
  transport: (v) => v === "http" || v === "sse",
};

/** edit spec 校验（unknown 进、合法 values 出——非法一律拒，绝不带病落盘）。 */
function checkEditSpec(spec: Record<string, unknown>): { ok: true; values: Record<string, NestedTableValue> } | { ok: false; error: string } {
  const values: Record<string, NestedTableValue> = {};
  for (const [k, v] of Object.entries(spec)) {
    const shape = EDIT_SPEC_KEYS[k];
    if (shape === undefined) return { ok: false, error: `spec 有未知键「${k}」（合法键：${Object.keys(EDIT_SPEC_KEYS).join("/")}）` };
    if (!shape(v)) return { ok: false, error: `spec 键「${k}」的值形状非法` };
    values[k] = v as NestedTableValue;
  }
  if (values["command"] === undefined && values["url"] === undefined) {
    return { ok: false, error: t("mcp.json.noStartup") };
  }
  return { ok: true, values };
}

/** 设置页数据面锚点：当前会话 harness（bootstrap /web 交接与 POST /api/sessions 打开即切换）。
 *  catalog 与 lazy live 态随会话模块图——MCP 面读写都从这里取；无当前会话 = undefined（GET 空表、
 *  start 409；写族 op 不依赖 harness，纯配置面照常）。 */
const anchorHarness = (): { sid: string; h: Harness } | undefined => {
  const hs = webHostPool()?.current();
  const h = hs?.core;
  return hs !== undefined && h !== undefined ? { sid: hs.sid, h } : undefined;
};

/** web 版命令依赖（brief：McpCmdDeps 路径全函数形——web 侧按 cwd 解析结果包成函数注入，无 getH）：
 *  configPath 沿用 defaultMcpCmdDeps（<orosusHome>/modules.d/mcp.toml——env 感知与池同 home）；
 *  projectPath = 池 startCwd（模块 .mcp.json 读点 process.cwd() 的启动期定格值——§4-1 同口径）；
 *  trustFile = <orosusHome>/mcp-trust.json（生产 ≡ mcpTrustFile()，见文件头注）；catalogRows =
 *  锚定 harness 的 mcp.catalog 服务行（live 灰度——on/off/remove 的来源守卫用；服务缺席缺省，
 *  runMcpCommand 回落 fallbackRows 配置面）。 */
const webMcpDeps = async (h: Harness | undefined): Promise<McpCmdDeps> => {
  const catalog = h === undefined ? undefined : await mcpCatalogService(h);
  return {
    ...defaultMcpCmdDeps(),
    projectPath: () => webHostPool()?.startCwd ?? process.cwd(),
    trustFile: () => join(orosusHome(), "mcp-trust.json"),
    ...(catalog !== undefined ? { catalogRows: catalog } : {}),
  };
};

/** wrote → reload 收口（§4-12 直接 await；成功即失效该会话 panel 缓存——T10 toggle 同口径）。
 *  reload 抛错由调用方 catch 回 500（写盘已落、旧图续跑——语义与 T10 toggle.fail 同档）。 */
const reloadAfterWrite = async (anchor: { sid: string; h: Harness } | undefined): Promise<ReloadReport | undefined> => {
  if (anchor === undefined) return undefined;
  const report = await anchor.h.reload();
  invalidatePanelCache(anchor.sid);
  return report;
};

/** GET /api/settings/mcp → {ok, servers:McpCatalogRow[]}（§3 :254——行原样透传；模块未启用 = 空表）。 */
registerRoute("GET", "/api/settings/mcp", async (_req, res) => {
  const anchor = anchorHarness();
  const servers: McpCatalogRow[] = anchor === undefined ? [] : (await mcpCatalogService(anchor.h))?.() ?? [];
  sendJson(res, 200, { ok: true, servers });
});

/** op 全集（§3 :255 枚举 + start——E5 失败重连/F6「启动」按钮同口，方案 §3 表成文在先）。 */
const MCP_OPS = new Set(["on", "off", "trust", "remove", "add", "edit", "start"]);

/** POST /api/settings/mcp/ops {op, name?, spec?} → {ok, text, report?} | 202 {ok, starting} | 4xx {error}。
 *  - on/off/trust/remove/add：rawArgs 拼装透传 runMcpCommand（wrote:false → 400 + mcp-cmd 文案——
 *    用法/未找到/来源守卫等；wrote:true → reload 收口 + 200）；
 *  - edit：spec 为 server 值对象，**写盘前白名单键 + 值形状全量校验**（checkEditSpec——非法 400 不
 *    落盘，TUI JSON 摄入口 parseJsonPaste 同口径），过验后 writeNestedTable 覆写整表值（TUI 添加窗
 *    edit 模式同款写器）；仅 config 来源（预装/项目行同 TUI 拒改文案）；
 *  - start：懒启动件（deferred 且 idle/failed）→ 202 排队（连接最长 60s——npx 下载，后台触发，
 *    前端轮询 catalog 观察翻转）；已连接 → 409；非懒启动/停用件 → 409（mcp.start.unknownLazy 文案）。 */
registerRoute("POST", "/api/settings/mcp/ops", async (req, res) => {
  const raw = await readBody(req, SETTINGS_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { op?: unknown; name?: unknown; spec?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  if (typeof body.op !== "string" || !MCP_OPS.has(body.op)) {
    sendJson(res, 400, { ok: false, error: "op 必须为 on/off/trust/remove/add/edit/start 之一" });
    return;
  }
  const op = body.op as "on" | "off" | "trust" | "remove" | "add" | "edit" | "start";
  const name = typeof body.name === "string" ? body.name : "";
  const anchor = anchorHarness();

  // start：懒启动（E5 失败点击重连 / F6「启动」——mcp-ui.runMcpToggle 的 deferred 分支同判据）
  if (op === "start") {
    if (name === "") {
      sendJson(res, 400, { ok: false, error: "name 必填" });
      return;
    }
    if (anchor === undefined) {
      sendJson(res, 409, { ok: false, error: "无当前会话" });
      return;
    }
    const rows = (await mcpCatalogService(anchor.h))?.() ?? [];
    const row = rows.find((r) => r.name === name);
    if (row === undefined) {
      notFound(res);
      return;
    }
    if (row.state === "connected") {
      sendJson(res, 409, { ok: false, error: t("mcp.state.connected") });
      return;
    }
    if (row.deferred !== true || (row.state !== "idle" && row.state !== "failed")) {
      sendJson(res, 409, { ok: false, error: t("mcp.start.unknownLazy", { name }) });
      return;
    }
    // 202 排队语义：连接可能长达 60s（npx 下载）——不占 HTTP 请求；失败静默（lazyState 记 failed，
    // catalog 下轮可见——TUI toast 三段〔starting/started/failed〕的 web 等价是前端轮询态翻转）
    void (async () => {
      const start = await anchor.h.graph().services.getOptional("mcp.start");
      if (typeof start === "function") await (start as (name: string) => Promise<void>)(name);
    })().catch(() => undefined);
    sendJson(res, 202, { ok: true, starting: true, name });
    return;
  }

  const deps = await webMcpDeps(anchor?.h);

  if (op === "edit") {
    if (name === "") {
      sendJson(res, 400, { ok: false, error: "name 必填" });
      return;
    }
    if (typeof body.spec !== "object" || body.spec === null || Array.isArray(body.spec)) {
      sendJson(res, 400, { ok: false, error: "spec 必须为 server 值对象" });
      return;
    }
    const rows = deps.catalogRows?.() ?? [];
    const row = rows.find((r) => r.name === name);
    if (row === undefined) {
      notFound(res);
      return;
    }
    if (row.source !== "config") { // 仅手写条目可改（TUI alt+n 同守卫同文案）
      sendJson(res, 400, { ok: false, error: row.source === "project" ? t("mcp.projectSource") : t("mcp.preloadNoEdit") });
      return;
    }
    const checked = checkEditSpec(body.spec as Record<string, unknown>); // 写盘前全量校验（见 EDIT_SPEC_KEYS 注）
    if (!checked.ok) {
      sendJson(res, 400, { ok: false, error: checked.error });
      return;
    }
    writeNestedTable(deps.configPath(), `mcp.servers.${name}`, checked.values);
    const report = await reloadAfterWrite(anchor);
    sendJson(res, 200, { ok: true, text: t("mcp.modified", { name }), ...(report !== undefined ? { report } : {}) });
    return;
  }

  // 透传族：name 无空白（rawArgs 空白分词——防拆词歧义）；add 的 spec 为命令行或 URL 串（mcp-cmd add 语义）
  if (name === "" || /\s/.test(name)) {
    sendJson(res, 400, { ok: false, error: "name 必填（不含空白）" });
    return;
  }
  if (op === "add" && (typeof body.spec !== "string" || body.spec.trim() === "")) {
    sendJson(res, 400, { ok: false, error: "add 需要 spec（命令行或 URL）" });
    return;
  }
  const rawArgs = op === "add" ? `add ${name} ${String(body.spec)}` : `${op} ${name}`;
  const r = await runMcpCommand(rawArgs, deps);
  if (!r.wrote) {
    sendJson(res, 400, { ok: false, error: r.text }); // 用法/未找到/来源守卫——mcp-cmd 文案直出
    return;
  }
  const report = await reloadAfterWrite(anchor);
  sendJson(res, 200, { ok: true, text: r.text, ...(report !== undefined ? { report } : {}) });
});

// ---------- T12：常规 / 语言 / 更新检查 / 模型偏好（F1 / F8 / F9 / F3 数据面） ----------

/** ctx 末条 usage 投影的事件末窗（lastUsageOf 只看末条 usage/compaction——50 条窗足够且成本有界，
 *  §5 律三：设置弹窗打开才查，不随客户端数放大）。 */
const GENERAL_CTX_EVENTS = 50;

/** GET /api/settings/general → {ok, disk, tokens, ctx, runtime}（§3 :248，F1 常规页）。
 *  disk：diskUsageText 同源五目录（cache/sessions/logs/tmp/modules——dirUsage 逐目录结构化）+
 *  total 行（F1 磁盘条总计）；tokens：h.usage 同源（本会话 current + 项目累计 lifetime，四键恒在、
 *  lifetime 缺席=0）；ctx：lastUsageOf 末条输入 + configFace 窗口链（pct = panel 同式）；runtime：
 *  托管装配时刻 elapsed（Date.now()-createdAt——panel elapsedMs 同源，resume 不显历史年龄）。
 *  无当前会话：disk 照常（home 面）、tokens/ctx.used 归零、elapsedMs=0——键形恒稳（前端渲染不掉键）。 */
registerRoute("GET", "/api/settings/general", async (_req, res) => {
  const home = orosusHome();
  const names = ["cache", "sessions", "logs", "tmp", "modules"]; // diskUsageText 同源名序（usage-text.ts:76）
  let totalBytes = 0;
  let totalFiles = 0;
  const disk: { name: string; mb: number; files: number }[] = [];
  for (const name of names) {
    const u = dirUsage(join(home, name));
    totalBytes += u.bytes;
    totalFiles += u.files;
    disk.push({ name, mb: Math.round((u.bytes / 1024 / 1024) * 10) / 10, files: u.files });
  }
  disk.push({ name: "total", mb: Math.round((totalBytes / 1024 / 1024) * 10) / 10, files: totalFiles });

  const hs = webHostPool()?.current();
  const h = hs?.core;
  let tokens = { input: 0, output: 0, lifetimeInput: 0, lifetimeOutput: 0 };
  let used = 0;
  if (h !== undefined && hs !== undefined) {
    try {
      const u = await h.usage(); // tokenUsageText 同一读口（本会话/项目累计双口径）
      tokens = {
        input: u.current.input,
        output: u.current.output,
        lifetimeInput: u.lifetime?.input ?? 0,
        lifetimeOutput: u.lifetime?.output ?? 0,
      };
    } catch { /* usage 读失败——零值兜底（tokenUsageText 尽力面同款） */ }
    try {
      used = lastUsageOf(await hs.eventsPage(Number.MAX_SAFE_INTEGER, GENERAL_CTX_EVENTS)).input;
    } catch { /* 尽力面同上 */ }
  }
  const window = configFace().contextWindow; // 解析链（config 显式 > models-dev > 200k 缺省）
  const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
  sendJson(res, 200, {
    ok: true,
    disk,
    tokens,
    ctx: { used, window, pct },
    runtime: { elapsedMs: hs !== undefined ? Date.now() - hs.createdAt : 0 },
  });
});

/** GET /api/settings/locale → {ok, current, locales:[{tag,label,module?}]}（§3 :259，F8）。
 *  current = 分层配置顶层 language（未配置 = ""——前端按「随系统」渲染；harness 读口同源 loadConfig）；
 *  locales = 内置三语原生名（BUILTIN_LOCALES）+ 语言包槽动态追加（createLocaleStore.availableLocales
 *  ——main.ts:441 同一 store 构造式，module:true 标 multilang 扩展档；锚定 harness 的图换代窗 =
 *  只出内置三语，降级不炸）。 */
registerRoute("GET", "/api/settings/locale", async (_req, res) => {
  const lang = loadConfig(configFacePaths()).core.language;
  const current = typeof lang === "string" && lang !== "" ? lang : "";
  const locales: { tag: string; label: string; module?: true }[] = BUILTIN_LOCALES.map((b) => ({ tag: b.tag, label: b.native }));
  const anchor = anchorHarness();
  if (anchor !== undefined) {
    try {
      const store = createLocaleStore({ getGraph: () => anchor.h.graph() });
      await store.init(current === "" ? "en-US" : current); // setTag + rebuild（枚举 i18n.* 槽）
      for (const e of store.availableLocales()) {
        if (e.fromPack) locales.push({ tag: e.tag, label: e.native, module: true });
      }
    } catch { /* 图换代窗（CK-12）——内置三语兜底 */ }
  }
  sendJson(res, 200, { ok: true, current, locales });
});

/** POST /api/settings/locale {tag} → {ok}（§3 :260，F8）：h.setLanguage（core 单一写者口——写 config
 *  顶层 language + setKernelLocale 内核地板对齐）。生效面 = 会话侧 t() 与新会话（F8 边界：web 页面
 *  文案一期中文直写，语言切换不切页面自身）。合法档 = 内置三语 ∪ 语言包槽（图内 multilang）；
 *  选当前语 = 无操作 noop（runLocaleSetting 同语义）。无当前会话 → 409（setLanguage 需 harness）。 */
registerRoute("POST", "/api/settings/locale", async (req, res) => {
  const raw = await readBody(req, SETTINGS_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { tag?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (tag === "") {
    sendJson(res, 400, { ok: false, error: "tag 必填" });
    return;
  }
  const anchor = anchorHarness();
  if (anchor === undefined) {
    sendJson(res, 409, { ok: false, error: "无当前会话" });
    return;
  }
  let valid = BUILTIN_LOCALES.some((b) => b.tag === tag);
  if (!valid) {
    try {
      const store = createLocaleStore({ getGraph: () => anchor.h.graph() });
      await store.init("en-US");
      valid = store.availableLocales().some((e) => e.tag === tag);
    } catch { /* 图换代窗——只剩内置三语判定 */ }
  }
  if (!valid) {
    sendJson(res, 400, { ok: false, error: `未知语言 "${tag}"（须为内置三语或已装语言包档）` });
    return;
  }
  if (anchor.h.configuredLanguage() === tag) {
    sendJson(res, 200, { ok: true, noop: true }); // 选当前语 = 无操作（不写盘——runLocaleSetting 同语义）
    return;
  }
  try {
    await anchor.h.setLanguage(tag);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** GET /api/settings/update → {ok, enabled, current, latest?}（§3 :261，F9）：enabled = [update] check
 *  开关（readUpdateCheckEnabled 用户层——设置流展示同口径，缺省开）；latest = 启动检查缓存直读
 *  （updateInfoNow——server 无后台轮检，web server 进程由 main.ts 启动点火供值；未查过缺省）。 */
registerRoute("GET", "/api/settings/update", async (_req, res) => {
  const info = updateInfoNow();
  sendJson(res, 200, {
    ok: true,
    enabled: readUpdateCheckEnabled(updateConfigFile()),
    current: OROSUS_VERSION,
    ...(info !== undefined ? { latest: info.latest } : {}),
  });
});

/** POST /api/settings/update {enabled} → {ok}（§3 :262，F9）：writeUpdateCheckKey 写 [update] check
 *  （留守节住 config.toml——行级节区感知保注释）；下次启动生效（自动口点火在 main.ts 启动期读开关）。 */
registerRoute("POST", "/api/settings/update", async (req, res) => {
  const raw = await readBody(req, SETTINGS_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { enabled?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  if (typeof body.enabled !== "boolean") {
    sendJson(res, 400, { ok: false, error: "enabled 必须为布尔值" });
    return;
  }
  writeUpdateCheckKey(body.enabled);
  sendJson(res, 200, { ok: true });
});

/** prefs 写键的模块节路由（subagent-settings.ts:43 同款——五键全为内置模块节，路由恒 modules.d/
 *  <名>.toml；sectionPath 负责建目录与带节头文件）。 */
const prefsModuleFile = (name: string): string =>
  sectionPath(name, { userConfig: join(orosusHome(), "config.toml"), modulesDir: join(orosusHome(), "modules.d"), isModule: () => true });

/** POST /api/settings/prefs {key, value} → {ok, report?}（§3 :263，F3 模型偏好五键）：
 *  - visionModel → [tool-media]（persistVisionModel——TUI runVisionSetting 同一写器；三态
 *    off|auto|<槽/模型>）落 modules.d/tool-media.toml；
 *  - search.backend → [tool-web.search]（writeSectionKey——四态 auto|llm|tavily|brave，
 *    tool-web config schema 枚举同源）落 modules.d/tool-web.toml；
 *  - model|approvalMode|maxTurns → [tool-subagent]（writeSubagentConfigKey——写法同
 *    subagent-settings.ts:43-44：sectionPath 路由 + writeSectionKey，maxTurns 转 Number、
 *    null=跟随删键）落 modules.d/tool-subagent.toml。
 *  写盘 → reload 收口（§4-12 直接 await + panel 缓存失效——MCP ops 同口径；模块配置 reload 后生效）。
 *  当前值读面不在 §3（T17 前端下拉的初值 = 各键缺省语义 + GET status/model 族——见 T12 报告接口确认）。 */
registerRoute("POST", "/api/settings/prefs", async (req, res) => {
  const raw = await readBody(req, SETTINGS_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { key?: unknown; value?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  const key = typeof body.key === "string" ? body.key : "";
  const value = body.value;
  const anchor = anchorHarness();
  try {
    switch (key) {
      case "visionModel": {
        if (typeof value !== "string" || value.trim() === "") {
          sendJson(res, 400, { ok: false, error: "visionModel 取值须为 off / auto / 模型全名（槽/模型）" });
          return;
        }
        persistVisionModel(prefsModuleFile("tool-media"), value);
        break;
      }
      case "search.backend": {
        if (value !== "auto" && value !== "llm" && value !== "tavily" && value !== "brave") {
          sendJson(res, 400, { ok: false, error: "search.backend 取值须为 auto / llm / tavily / brave" });
          return;
        }
        writeSectionKey(prefsModuleFile("tool-web"), "tool-web.search", "backend", value);
        break;
      }
      case "model": {
        if (value !== null && (typeof value !== "string" || value.trim() === "")) {
          sendJson(res, 400, { ok: false, error: "model 取值须为模型全名（槽/模型）或 null（跟随）" });
          return;
        }
        writeSubagentConfigKey("model", value as string | null, join(orosusHome(), "config.toml"));
        break;
      }
      case "approvalMode": {
        if (value !== null && value !== "auto" && value !== "ask") {
          sendJson(res, 400, { ok: false, error: "approvalMode 取值须为 auto / ask 或 null（跟随）" });
          return;
        }
        writeSubagentConfigKey("approvalMode", value as string | null, join(orosusHome(), "config.toml"));
        break;
      }
      case "maxTurns": {
        if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || (value !== -1 && (value < 1 || value > 200)))) {
          sendJson(res, 400, { ok: false, error: "maxTurns 取值须为 -1（不限）/ 1-200 整数或 null（跟随默认 100）" });
          return;
        }
        writeSubagentConfigKey("maxTurns", value === null ? null : String(value), join(orosusHome(), "config.toml"));
        break;
      }
      default:
        sendJson(res, 400, { ok: false, error: "未知 key（合法键：visionModel / search.backend / model / approvalMode / maxTurns）" });
        return;
    }
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const report = await reloadAfterWrite(anchor);
  sendJson(res, 200, { ok: true, ...(report !== undefined ? { report } : {}) });
});

// ---------- T12：/api/update 更新内容链路（A4 胶囊 → 更新弹窗数据面） ----------

/** registry 全量 doc URL（A4 选型：npm 是更新检查已验证可达的通道，registry doc 的 readme/versions
 *  字段白送更新内容与落后清单——不引入 GitHub/Gitea Release 习惯与网络依赖）。 */
const UPDATE_DOC_URL = "https://registry.npmjs.org/orosus";

/** 更新内容内存缓存 TTL（§5 自创值登记表 :345「更新 notes 内存缓存 1h」——弹窗重复打开不重打
 *  registry；版本内容演进以发布为界，1h 足新鲜）。 */
const UPDATE_NOTES_CACHE_MS = 60 * 60 * 1000;

/** registry 全量 doc 的消费面切片（形状校验后的窄视图）。 */
interface RegistryDoc {
  latest: string;
  versions: Record<string, unknown>;
  readme?: string | undefined;
}

/** 注入面 fetch（测试注假 registry——零真网络；缺省 global fetch）。最小结构面：url + headers/signal
 *  init、{ok, status?, json()} 返回（typeof fetch 的窄形——免测试件 cast 全套 Response 面）。 */
export type UpdateDocFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

let updateFetchImpl: UpdateDocFetch | undefined;
let updateDocCache: { at: number; doc: RegistryDoc } | undefined;

/** 测试注入：假 registry fetch（undefined = 复位回 global fetch）。 */
export const setUpdateFetchForTest = (f: UpdateDocFetch | undefined): void => {
  updateFetchImpl = f;
};

/** 测试复位：清 notes/doc 内存缓存（每用例独立懒取）。 */
export const resetUpdateCacheForTest = (): void => {
  updateDocCache = undefined;
};

/** registry 全量 doc 取数（fetchLatestUpdate 同款纪律：10s 超时手控句柄 + 形状校验；失败抛错由
 *  调用方静默降级——不动 update-check.ts 既有行为，web 侧自取）。 */
const fetchRegistryDoc = async (): Promise<RegistryDoc> => {
  const doFetch: UpdateDocFetch = updateFetchImpl ?? ((url, init) => fetch(url, init));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const res = await doFetch(UPDATE_DOC_URL, {
      headers: { accept: "application/json", "user-agent": OROSUS_USER_AGENT },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = (await res.json()) as { "dist-tags"?: { latest?: unknown }; versions?: unknown; readme?: unknown };
    if (typeof doc["dist-tags"]?.latest !== "string") throw new Error("unexpected registry payload shape");
    return {
      latest: doc["dist-tags"].latest,
      versions: typeof doc.versions === "object" && doc.versions !== null && !Array.isArray(doc.versions) ? (doc.versions as Record<string, unknown>) : {},
      ...(typeof doc.readme === "string" ? { readme: doc.readme } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
};

/** npm registry readme「## 更新日志」段 → `### v<latest>` 小节切片（A4 更新内容数据源——纯函数，
 *  测试直调两形）。段界：段头 ^##\s+更新日志\s*$ 起、下一个 ^## 止；小节头 ^###\s+v<版本>\s*$
 *  严格形（scripts/release.mts readmeChangelogGate 发布门禁同一格式契约——两端一枚钉）。
 *  返回小节全文（含 `### v<latest>` 头行——前端 marked 直渲）、尾空行剪净；无段/无该版小节 →
 *  undefined（前端降级形态：版本号 + 落后列表 + 指引）。 */
export function sliceChangelogNotes(readme: string | undefined, latest: string): string | undefined {
  if (typeof readme !== "string" || readme === "") return undefined;
  const target = `### v${latest}`;
  const lines = readme.split(/\r?\n/);
  const sectionRe = /^##\s+更新日志\s*$/;
  let phase: "seek" | "section" = "seek";
  let inSub = false;
  const out: string[] = [];
  for (const line of lines) {
    if (phase === "seek") {
      if (sectionRe.test(line)) phase = "section";
      continue;
    }
    if (/^##\s/.test(line)) break; // 下一个 h2——更新日志段止
    if (/^###\s/.test(line)) {
      inSub = line.trim() === target; // 小节头严格形（尾随空白容忍）
      if (inSub) out.push(line.trim());
      continue;
    }
    if (inSub) out.push(line);
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out.length > 0 ? out.join("\n") : undefined;
}

/** skipped 推导：registry `versions` 键序（npm 按发布序插入）中 current 与 latest 之间的版本号
 *  （不含两端——current 是在跑版、latest 是目标版；任一不在键序 = []，如实不猜）。 */
const skippedVersions = (versions: Record<string, unknown>, current: string, latest: string): string[] => {
  const keys = Object.keys(versions);
  const i = keys.indexOf(current);
  const j = keys.indexOf(latest);
  return i >= 0 && j > i + 1 ? keys.slice(i + 1, j) : [];
};

/** GET /api/update → {current, latest?, hasUpdate, notes?, skipped?}（§3 :264，A4 更新弹窗数据面）。
 *  - 懒取：弹窗打开才查（server 不后台轮检）；1h 内存缓存命中不重打 registry；
 *  - 失败静默降级：doc 取数失败/坏形状 → 回落启动检查缓存 updateInfoNow（stale-while-error——
 *    update-check.ts D2 同口径），仍无 → {current, hasUpdate:false}（latest 缺省）；
 *  - latest 已知即随包回（即使 hasUpdate:false——「已是最新」也要能显示到什么版）；
 *    notes/skipped 仅 hasUpdate 且 doc 在手时出（降级形不走这两个键——前端按缺席判降级）。 */
registerRoute("GET", "/api/update", async (_req, res) => {
  const current = OROSUS_VERSION;
  let doc = updateDocCache !== undefined && Date.now() - updateDocCache.at < UPDATE_NOTES_CACHE_MS ? updateDocCache.doc : undefined;
  if (doc === undefined) {
    try {
      doc = await fetchRegistryDoc();
      updateDocCache = { at: Date.now(), doc };
    } catch {
      doc = undefined; // 静默降级——回落启动检查缓存（横幅同源值）
    }
  }
  if (doc === undefined) {
    const info = updateInfoNow();
    if (info === undefined) {
      sendJson(res, 200, { current, hasUpdate: false });
      return;
    }
    sendJson(res, 200, { current, latest: info.latest, hasUpdate: isNewerVersion(info.latest, current) });
    return;
  }
  const latest = doc.latest;
  const hasUpdate = isNewerVersion(latest, current);
  if (!hasUpdate) {
    sendJson(res, 200, { current, latest, hasUpdate: false });
    return;
  }
  const notes = sliceChangelogNotes(doc.readme, latest);
  sendJson(res, 200, {
    current,
    latest,
    hasUpdate: true,
    ...(notes !== undefined ? { notes } : {}),
    skipped: skippedVersions(doc.versions, current, latest),
  });
});
