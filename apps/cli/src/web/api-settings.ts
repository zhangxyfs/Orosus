/** 设置端点（web 批 T11 骨架 + MCP 页；T12——常规/语言/更新检查/模型偏好四页数据面；
 *  T13 本任务面——技能/钩子/记忆三页 + 提供商面独立模块 api-providers.ts；/api/update 更新内容链
 *  T13 拆出 update-notes.ts〔评审指针，行为不变〕）：
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
 *  - GET /api/settings/prefs（T17 增补〔§3 形状增量——方案文档已追认〕，F3 下拉初值读面）：五键当前值
 *    投影（visionModel/readVisionModel 同文件对、search.backend=loadConfig 有效视图、subagent 三键
 *    readSubagentConfig——缺省语义 visionModel="off" / search="auto" / subagent 全 null=跟随）；
 *  - GET/POST /api/settings/skills（§3 :249-250，F4）：skill.catalog 服务行（四轨 scope/file）+
 *    disabled 盘上现读覆盖（TUI skillCatalogRows 同口径——reload 前的 catalog 停用快照滞后，以盘
 *    为准）；POST toggle 写 [skill] disabled 数组（toggleSkillDisabled——modules.d/skill.toml）+
 *    reload 收口；
 *  - GET/POST /api/settings/hooks（§3 :251-253，F5）：hooksFace(cwd)（池 startCwd——模块 .orosus
 *    路径读点同口径）两层分节 + 项目信任态现算；POST toggle 行级改写（setHookDisabled——定位参
 *    (file,event,tableIdx,hookIdx) 须命中当前 face 的实际行，file 白名单 = face 两文件——任意路径
 *    写盘防线）；POST trust 写 hooks-trust.json（trustProjectHooks——sha256 digest 登记）+ reload；
 *  - GET/POST /api/settings/memory（§3 :256-258，F7）：readPeersConfig/writePeersConfigKey 双开关
 *    （[tool-peers] 键）+ 五源探测（detectSources——tool-peers 纯函数直用，main.ts:543 同源接线）；
 *    POST import = 一次性搬运（detect + readSourceNotes + importNotes——organize 关〔D20 缺省零
 *    token〕、mode=current 同 CLI）。
 *  数据面锚定当前会话 harness（设置弹窗全局、模块图随会话——catalog/lazyState 每会话一图）；
 *  无当前会话 = GET 空表 / start 409；on/off/trust/remove/add 走纯配置面（deps 不含 getH）照常写盘，
 *  reload 缺席如实省略（report 不带——后续会话装配自然读新配置）。
 *  边界留档（§4-1/§4-2——帮助页注记归 T18）：项目 .mcp.json 仅对 server 启动 cwd 生效
 *  （mcp/index.ts:379 读 process.cwd()）——deps.projectPath 即池 startCwd 与模块同口径；
 *  mcp-trust.json 模块侧硬编码 homedir()（知悉不修），web 侧注入 join(orosusHome(), "mcp-trust.json")
 *  ——生产（OROSUS_HOME 未设）与 mcpTrustFile() 同径，测试重定向隔离不落真 home。 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { loadConfig, sectionPath, writeSectionKey, writeNestedTable, type Harness, type NestedTableValue, type ReloadReport } from "@orosus/core";
import { orosusHome } from "@orosus/contracts/home";
import type { CapabilityKey } from "@orosus/contracts/module";
import { OROSUS_VERSION } from "@orosus/contracts/version";
import { persistVisionModel, readVisionModel } from "@orosus/tool-media";
import type { McpCatalogRow } from "@orosus/mcp";
import { detectSources, findGitRoot, importMirror, importNotesProgressive, memoryBucketKey, readSourceNotes, scanMirrorSources, type LlmStream, type PeerHomes } from "@orosus/tool-peers";
import { runMcpCommand, defaultMcpCmdDeps, configuredServers, type McpCmdDeps } from "../mcp-cmd.ts";
import { configFace, configFacePaths } from "../config-face.ts";
import { dirUsage } from "../tuicfg.ts";
import { lastUsageOf } from "../usage-text.ts";
import { BUILTIN_LOCALES, createLocaleStore } from "../i18n/store.ts";
import { readUpdateCheckEnabled, updateConfigFile, writeUpdateCheckKey } from "../update-settings.ts";
import { updateInfoNow } from "../update-check.ts";
import { readSubagentConfig, writeSubagentConfigKey } from "../subagent-settings.ts";
import { GUI_FONT_SCALES, readBtwModel, readGuiPreferences, writeGuiPreferences, type GuiPreferencePatch } from "./gui-settings.ts";
import { readSkillDisabled, toggleSkillDisabled } from "../skill-settings.ts";
import { hooksFace, setHookDisabled, trustProjectHooks } from "../hooks-ui.ts";
import { readPeersConfig, writePeersConfigKey } from "../peers-settings.ts";
import { registerRoute, readBody, sendJson } from "./server.ts";
import { webHostPool } from "./mod.ts";
import { mcpCatalogService, invalidatePanelCache } from "./api-panel.ts";
import { t } from "../i18n/app.ts";
import "./update-notes.ts"; // T12 更新内容链（T13 拆出独立模块——模块加载即注册 GET /api/update）
import "./api-providers.ts"; // T13 提供商面端点（/api/providers*——readiness 序经本文件链入 mod.ts）
// T12 测试注入面 re-export（settings-data.test 既有 import 路径兼容——拆分行为不变）
export { sliceChangelogNotes, setUpdateFetchForTest, resetUpdateCacheForTest, type UpdateDocFetch } from "./update-notes.ts";

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
  // 游标兜底 viewer 化身（2026-10-12 走查修——浏览态会话同样给设置页供数；reload 只重建内存图，
  //  viewer 安全）：current() 只认 hosts，游标指向 viewer 时需 lookup 兜底
  const pool = webHostPool();
  const cursor = pool?.cursorSid();
  const hs = pool?.current() ?? (cursor !== undefined ? pool?.lookup(cursor) : undefined);
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
 *  reload 抛错由 server.ts 通用 per-request catch 兜底回 400「bad request」（写盘已落、旧图续跑
 *  ——语义与 T10 toggle.fail 同档；各调用方不另设 try/catch，400 而非 500 是兜底壳的既定形态）。 */
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

/** GET /api/settings/mcp/entry?name= → {ok, values}（2026-10-12 走查：修改窗预填的原始配置值——
 *  catalog 行不含 env/timeout 等高级字段，TUI 编辑窗读原始表同源；仅 config 来源条目（预装/项目
 *  不可改，无预填面）；不在配置 = 404）。 */
registerRoute("GET", "/api/settings/mcp/entry", (req, res) => {
  const url = req.url ?? "";
  const qi = url.indexOf("?");
  const name = new URLSearchParams(qi >= 0 ? url.slice(qi + 1) : "").get("name") ?? "";
  if (name === "") {
    sendJson(res, 400, { ok: false, error: "name 必填" });
    return;
  }
  const values = configuredServers(defaultMcpCmdDeps().configPath())[name];
  if (values === undefined) {
    notFound(res);
    return;
  }
  sendJson(res, 200, { ok: true, values });
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

  // add 结构化形态（2026-10-12 走查：TUI 添加窗 Alt+N 同款值对象——手动表单/JSON 粘贴两入口共用；
  // 串形 spec（命令行/URL）走下方 mcp-cmd add 透传不变）。重名守卫 + checkEditSpec 全量校验 + 直写
  // writeNestedTable（TUI mcp-add-window save 同款写器）。
  if (op === "add" && typeof body.spec === "object" && body.spec !== null && !Array.isArray(body.spec)) {
    const configPath = deps.configPath();
    if (name in configuredServers(configPath)) {
      sendJson(res, 400, { ok: false, error: t("mcp.add.dup", { name }) });
      return;
    }
    const checked = checkEditSpec(body.spec as Record<string, unknown>);
    if (!checked.ok) {
      sendJson(res, 400, { ok: false, error: checked.error });
      return;
    }
    writeNestedTable(configPath, `mcp.servers.${name}`, checked.values);
    const report = await reloadAfterWrite(anchor);
    sendJson(res, 200, { ok: true, text: t("mcp.add.written", { name, path: configPath }), ...(report !== undefined ? { report } : {}) });
    return;
  }

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

  // 游标兜底 viewer 化身（同 anchorHarness——常规页 tokens/ctx 在浏览态会话下也要出数）
  const pool0 = webHostPool();
  const cursor0 = pool0?.cursorSid();
  const hs = pool0?.current() ?? (cursor0 !== undefined ? pool0?.lookup(cursor0) : undefined);
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

/** GUI 外观与侧问偏好统一读写：~/.orosus/gui/gui.toml。GET 的 exists 供前端决定是否迁移 localStorage。 */
const guiResponse = () => {
  const p = readGuiPreferences();
  return { ok: true as const, exists: p.exists, appearanceConfigured: p.appearanceConfigured, theme: p.theme, mode: p.mode, fontScale: p.fontScale, btwModel: p.btwModel ?? null };
};

const guiPatchError = (body: Record<string, unknown>): string | undefined => {
  const allowed = new Set(["theme", "mode", "fontScale", "btwModel"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) return `未知 GUI 配置键：${key}`;
  if (body["theme"] !== undefined && (typeof body["theme"] !== "string" || body["theme"].trim() === "")) return "theme 须为非空字符串";
  if (body["mode"] !== undefined && body["mode"] !== "dark" && body["mode"] !== "light") return "mode 取值须为 dark / light";
  if (body["fontScale"] !== undefined && (typeof body["fontScale"] !== "number" || !GUI_FONT_SCALES.some((s) => s === body["fontScale"]))) {
    return `fontScale 取值须为 ${GUI_FONT_SCALES.join(" / ")}`;
  }
  if (body["btwModel"] !== undefined && body["btwModel"] !== null && (typeof body["btwModel"] !== "string" || body["btwModel"].trim() === "")) {
    return "btwModel 取值须为模型名或 null（跟随）";
  }
  return undefined;
};

registerRoute("GET", "/api/settings/gui", async (_req, res) => {
  sendJson(res, 200, guiResponse());
});

registerRoute("POST", "/api/settings/gui", async (req, res) => {
  const parsed = await readSettingsBody(req);
  if (parsed.failed) {
    sendJson(res, parsed.status, { ok: false, error: parsed.msg });
    return;
  }
  const error = guiPatchError(parsed.body);
  if (error !== undefined) {
    sendJson(res, 400, { ok: false, error });
    return;
  }
  try {
    writeGuiPreferences(orosusHome(), parsed.body as GuiPreferencePatch);
    sendJson(res, 200, guiResponse());
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** GET /api/settings/prefs → {ok, visionModel, search, subagent:{model,approvalMode,maxTurns}}（T17
 *  增补——§3 形状增量已方案追认；F3 下拉初值读面）。读口与 POST 写面同文件对：
 *  - visionModel：readVisionModel(prefsModuleFile("tool-media"))——modules.d/tool-media.toml（缺省 "off"）；
 *  - search：loadConfig 有效视图 [tool-web.search].backend（分层合并后读值——缺省 "auto"）；
 *  - subagent：readSubagentConfig（loadConfig + modules.d 同读——键缺席 = null 跟随态）。 */
registerRoute("GET", "/api/settings/prefs", async (_req, res) => {
  let visionModel = "off";
  try {
    visionModel = readVisionModel(prefsModuleFile("tool-media"));
  } catch { /* 读失败按缺省 */
  }
  let search = "auto";
  try {
    // [tool-web.search] 在 TOML 解析面是嵌套对象（sections 键 = "tool-web"——CH-07 深合并后照旧嵌套）
    const sec = loadConfig(configFacePaths()).sections.get("tool-web") as { search?: { backend?: unknown } } | undefined;
    const b = sec?.search?.backend;
    if (typeof b === "string" && b !== "") search = b;
  } catch { /* 同上 */
  }
  const sub = readSubagentConfig(join(orosusHome(), "config.toml"));
  const btwModel = readBtwModel(); /* 侧问模型偏好（gui/gui.toml [sideQuestion].model；缺省 null = 跟随会话当前） */
  sendJson(res, 200, {
    ok: true,
    visionModel,
    search,
    subagent: { model: sub.model ?? null, approvalMode: sub.approvalMode ?? null, maxTurns: sub.maxTurns ?? null },
    btwModel: btwModel ?? null,
  });
});

/** POST /api/settings/prefs {key, value} → {ok, report?}（§3 :263，F3 模型偏好五键）：
 *  - visionModel → [tool-media]（persistVisionModel——TUI runVisionSetting 同一写器；三态
 *    off|auto|<槽/模型>）落 modules.d/tool-media.toml；
 *  - search.backend → [tool-web.search]（writeSectionKey——四态 auto|llm|tavily|brave，
 *    tool-web config schema 枚举同源）落 modules.d/tool-web.toml；
 *  - model|approvalMode|maxTurns → [tool-subagent]（writeSubagentConfigKey——写法同
 *    subagent-settings.ts:43-44：sectionPath 路由 + writeSectionKey，maxTurns 转 Number、
 *    null=跟随删键）落 modules.d/tool-subagent.toml。
 *  写盘 → reload 收口（§4-12 直接 await + panel 缓存失效——MCP ops 同口径；模块配置 reload 后生效）。
 *  当前值读面 = GET /api/settings/prefs（T17 增补，§3 形状增量已方案追认）。 */
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
      case "btwModel": {
        /* 侧问模型偏好（gui/gui.toml [sideQuestion].model；null/空串 = 删键回跟随会话当前）。 */
        if (value !== null && (typeof value !== "string" || value.trim() === "")) {
          sendJson(res, 400, { ok: false, error: "btwModel 取值须为 模型名（可槽/模型限定形）或 null（跟随）" });
          return;
        }
        writeGuiPreferences(orosusHome(), { btwModel: value === null ? null : value.trim() });
        break;
      }
      default:
        sendJson(res, 400, { ok: false, error: "未知 key（合法键：visionModel / search.backend / model / approvalMode / maxTurns / btwModel）" });
        return;
    }
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const report = await reloadAfterWrite(anchor);
  sendJson(res, 200, { ok: true, ...(report !== undefined ? { report } : {}) });
});

// ---------- T13：技能 / 钩子 / 记忆（F4 / F5 / F7 数据面） ----------

/** POST 体解析小件（本节各端点同口径：上限 + JSON parse；failed = status/msg 已定，调用方直发）。 */
type BodyResult = { failed: true; status: number; msg: string } | { failed: false; body: Record<string, unknown> };
const readSettingsBody = async (req: IncomingMessage): Promise<BodyResult> => {
  const raw = await readBody(req, SETTINGS_BODY_MAX_BYTES);
  if (raw === "too-large") return { failed: true, status: 413, msg: "body too large" };
  try {
    return { failed: false, body: JSON.parse(raw.toString("utf8")) as Record<string, unknown> };
  } catch {
    return { failed: true, status: 400, msg: "invalid json" };
  }
};

/** web 侧项目根（钩子/记忆的项目层读点）：池 startCwd（server 启动 cwd 定格——§4-1 模块 process.cwd()
 *  读点同口径；无池 = process.cwd() 兜底）。 */
const webCwd = (): string => webHostPool()?.startCwd ?? process.cwd();

/** skill.catalog 行（消费面类型本地声明——圈地纪律；字段与 skill 模块 catalogRow 对齐）。
 *  服务键正型访问（T6 遗留 Minor 的本任务侧收口：CapabilityKey 品牌类型替代 cmdrouter 的
 *  "skill.catalog" as never 逃生口——cmdrouter.ts 属 T6 文件不动，两处消费暂各自持键，取舍见报告）。 */
interface SkillRow {
  name: string;
  description: string;
  whenToUse?: string;
  layer: string;
  source: string;
  file: string;
  disabled: boolean;
  modelInvocable: boolean;
}
const SKILL_CATALOG: CapabilityKey<() => SkillRow[]> = "skill.catalog";

/** GET /api/settings/skills → {ok, skills:[{name,desc,usage?,scope,file,disabled}]}（§3 :249，F4）。
 *  数据源 = 锚定 harness 的 skill.catalog 服务（目录现读——每次调用重扫磁盘，UI 面活数据）+ disabled
 *  盘上现读覆盖（TUI skillCatalogRows 同口径：写盘与 reload 之间的快照滞后以盘为准）。无当前会话 /
 *  模块未启用 → 空表（管理面缺席，前端指路文案自理）。 */
registerRoute("GET", "/api/settings/skills", async (_req, res) => {
  const anchor = anchorHarness();
  let rows: SkillRow[] = [];
  if (anchor !== undefined) {
    try {
      const catalog = await anchor.h.graph().services.getOptional(SKILL_CATALOG);
      rows = typeof catalog === "function" ? catalog() : [];
    } catch {
      rows = []; // 服务面异常按空目录（cmdrouter skillSubmitOf 同口径）
    }
  }
  const disabledNow = new Set(readSkillDisabled());
  sendJson(res, 200, {
    ok: true,
    skills: rows.map((r) => ({
      name: r.name,
      desc: r.description,
      ...(r.whenToUse !== undefined && r.whenToUse !== "" ? { usage: r.whenToUse } : {}),
      scope: r.layer,
      file: r.file,
      disabled: disabledNow.has(r.name),
    })),
  });
});

/** POST /api/settings/skills/toggle {name, disabled} → {ok}（§3 :250，F4）：toggleSkillDisabled 写
 *  [skill] disabled 数组（路由内建 → modules.d/skill.toml——空表删键回缺省态）+ reload 收口。
 *  目标态与现态一致 → noop:true 不写盘（locale POST 同语义）；写盘 → h.reload()（§4-12 直接 await）。 */
registerRoute("POST", "/api/settings/skills/toggle", async (req, res) => {
  const b = await readSettingsBody(req);
  if (b.failed) {
    sendJson(res, b.status, { ok: false, error: b.msg });
    return;
  }
  const name = typeof b.body["name"] === "string" ? b.body["name"].trim() : "";
  if (typeof b.body["name"] !== "string" || name === "" || /\s/.test(name)) {
    sendJson(res, 400, { ok: false, error: "name 必填（技能名，不含空白）" });
    return;
  }
  if (typeof b.body["disabled"] !== "boolean") {
    sendJson(res, 400, { ok: false, error: "disabled 必须为布尔值" });
    return;
  }
  const anchor = anchorHarness();
  const nowDisabled = readSkillDisabled().includes(name);
  if (nowDisabled === b.body["disabled"]) {
    sendJson(res, 200, { ok: true, noop: true }); // 同态无操作（不写盘不 reload）
    return;
  }
  try {
    toggleSkillDisabled(name);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const report = await reloadAfterWrite(anchor);
  sendJson(res, 200, { ok: true, ...(report !== undefined ? { report } : {}) });
});

/** GET /api/settings/hooks → {ok, user, project, projectTrusted}（§3 :251，F5）：hooksFace(webCwd())
 *  两层分节（user = <home>/modules.d/hooks.toml、project = <webCwd>/.orosus/modules.d/hooks.toml）+
 *  项目信任态现算（evaluateProjectTrust 同源——面板与执行门同一判据）。行原样透传（event/command/
 *  name?/product?/matcher?/timeout?/disabled/file/tableIdx/hookIdx——toggle 定位四元组随行自带）。 */
registerRoute("GET", "/api/settings/hooks", async (_req, res) => {
  const face = hooksFace(webCwd());
  sendJson(res, 200, {
    ok: true,
    user: face.rows.filter((r) => r.origin === "user"),
    project: face.rows.filter((r) => r.origin === "project"),
    projectTrusted: face.projectTrusted,
  });
});

/** POST /api/settings/hooks/toggle {file,event,tableIdx,hookIdx,disabled} → {ok}（§3 :252，F5）：
 *  setHookDisabled 行级改写（保注释保键序——TUI e 键同款写器）。**写盘前双重防线**（checkEditSpec
 *  同族纪律）：① file 白名单 = 当前 face 的 userFile/projectFile（setHookDisabled 收任意路径——
 *  不设防即任意文件写盘口）；② 定位四元组须命中 face 的实际行（结构已变/陈旧索引 → 400 而非
 *  写错行）。过验后写盘 + reload 收口（TUI 的 reloadModulesIdle 缓挂在 web 侧统一为 §4-12 直等）。 */
registerRoute("POST", "/api/settings/hooks/toggle", async (req, res) => {
  const b = await readSettingsBody(req);
  if (b.failed) {
    sendJson(res, b.status, { ok: false, error: b.msg });
    return;
  }
  const file = typeof b.body["file"] === "string" ? b.body["file"] : "";
  const event = typeof b.body["event"] === "string" ? b.body["event"] : "";
  const tableIdx = b.body["tableIdx"];
  const hookIdx = b.body["hookIdx"];
  const disabled = b.body["disabled"];
  if (typeof tableIdx !== "number" || !Number.isInteger(tableIdx) || tableIdx < 0
    || typeof hookIdx !== "number" || !Number.isInteger(hookIdx) || hookIdx < 0) {
    sendJson(res, 400, { ok: false, error: "tableIdx/hookIdx 必须为非负整数（行定位——GET 行自带）" });
    return;
  }
  if (typeof disabled !== "boolean") {
    sendJson(res, 400, { ok: false, error: "disabled 必须为布尔值" });
    return;
  }
  const face = hooksFace(webCwd());
  if (file !== face.userFile && file !== face.projectFile) {
    sendJson(res, 400, { ok: false, error: "file 须为当前钩子面的用户级/项目级文件（GET 行自带）" });
    return;
  }
  const hit = face.rows.find((r) => r.file === file && r.event === event && r.tableIdx === tableIdx && r.hookIdx === hookIdx);
  if (hit === undefined) {
    sendJson(res, 400, { ok: false, error: "未定位到该钩子行（结构已变——刷新列表后重试）" });
    return;
  }
  const anchor = anchorHarness();
  try {
    setHookDisabled(file, hit.event, tableIdx, hookIdx, disabled);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const report = await reloadAfterWrite(anchor);
  sendJson(res, 200, { ok: true, ...(report !== undefined ? { report } : {}) });
});

/** POST /api/settings/hooks/trust {} → {ok}（§3 :253，F5）：trustProjectHooks 写
 *  <home>/hooks/hooks-trust.json（项目层 hooks.toml 当前内容 sha256 登记——审查即信任，即时生效）
 *  + reload 收口（§1 F5 web 行：信任审查写盘 + reload）。项目层不适用/不可读 → 400（模块同款语义）。 */
registerRoute("POST", "/api/settings/hooks/trust", async (req, res) => {
  const b = await readSettingsBody(req);
  if (b.failed) {
    sendJson(res, b.status, { ok: false, error: b.msg });
    return;
  }
  const anchor = anchorHarness();
  try {
    trustProjectHooks(webCwd());
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const report = await reloadAfterWrite(anchor);
  sendJson(res, 200, { ok: true, ...(report !== undefined ? { report } : {}) });
});

/** 五源家目录（main.ts:501 memorySourceHomes 同源——homedir 锚定，探测纯读；web 侧复刻接线，
 *  detectSources/importNotes 为 tool-peers 模块包纯函数直用——brief Interfaces 明文允许）。 */
const memorySourceHomes = (): PeerHomes => {
  const home = homedir();
  return {
    claude: join(home, ".claude"),
    zcode: join(home, ".zcode"),
    qwen: join(home, ".qwen"),
    codex: join(home, ".codex"),
    reasonix: join(home, ".reasonix"),
  };
};

/** 当前项目记忆桶（main.ts:515 currentMemoryDir 同源——memoryBucketKey 键目录下的 memory/）。 */
const currentMemoryDir = (): string => join(orosusHome(), "memories", "projects", memoryBucketKey(webCwd()), "memory");

/** GET /api/settings/memory → {ok, workspaceMemory, sessionPeers, sources}（§3 :256，F7——2026-10-12
 *  原型 v2 记忆导入卡：sources 富形行）：双开关读 [tool-peers] 两键（缺键 = 关）+ 五源探测（有货才列
 *  ——runMemoryImportChoose 同口径 count>0；destDir 传当前项目桶 → newCount = 已导差集〔D7〕+
 *  codex global 标注〔G2〕；dir 缩 ~ 前缀显示——行 path 位直投）。id 集 = claude-code/zcode/qwen/
 *  codex/reasonix。 */
registerRoute("GET", "/api/settings/memory", async (_req, res) => {
  const cfg = readPeersConfig();
  const cwd = webCwd();
  const home = join(homedir()); // join 归一化分隔符——env 形态（正/反斜杠）不扰 startsWith 比对
  const sources = detectSources(memorySourceHomes(), findGitRoot(cwd), cwd, currentMemoryDir())
    .filter((s) => s.count > 0)
    .map((s) => ({
      id: s.id,
      label: s.label,
      dir: s.dir === undefined ? "" : s.dir.startsWith(home) ? "~" + s.dir.slice(home.length) : s.dir,
      count: s.count,
      ...(s.newCount !== undefined ? { newCount: s.newCount } : {}),
      ...(s.global === true ? { global: true } : {}),
    }));
  sendJson(res, 200, { ok: true, workspaceMemory: cfg.workspaceMemory, sessionPeers: cfg.sessionPeers, sources });
});

/** POST /api/settings/memory {key, value} → {ok}（§3 :257，F7）：writePeersConfigKey 写 [tool-peers]
 *  单键（布尔裸值，路由内建 → modules.d/tool-peers.toml）+ reload 收口（D15 写键后重载）。 */
registerRoute("POST", "/api/settings/memory", async (req, res) => {
  const b = await readSettingsBody(req);
  if (b.failed) {
    sendJson(res, b.status, { ok: false, error: b.msg });
    return;
  }
  const key = b.body["key"];
  if (key !== "workspaceMemory" && key !== "sessionPeers") {
    sendJson(res, 400, { ok: false, error: "key 必须为 workspaceMemory / sessionPeers" });
    return;
  }
  if (typeof b.body["value"] !== "boolean") {
    sendJson(res, 400, { ok: false, error: "value 必须为布尔值" });
    return;
  }
  writePeersConfigKey(key, b.body["value"]);
  const report = await reloadAfterWrite(anchorHarness());
  sendJson(res, 200, { ok: true, ...(report !== undefined ? { report } : {}) });
});

/** POST /api/settings/memory/import {ids?, organize?, mode?} → {ok, imported, updated, skipped, merged,
 *  mirror?}（§3 :258，F7——2026-10-12 原型 v2 记忆导入卡升级：单源/勾选集/全部 + 范围档 + 模型整理）。
 *  链路 = main.ts importWithOrganize 同源接线（TUI runMemoryImportChoose 执行段同口径）：current 档
 *  readSourceNotes 汇总 → importNotesProgressive 落当前项目桶（标题判重、重复覆盖更新）；all 档四家
 *  走镜像各归各桶（scanMirrorSources + importMirror）、codex 仍导当前桶（G12 projects 不 +1）。
 *  organize = true 逐条模型整理（llm 取锚会话 h.llm()——无活会话 400；D20 web 闸门随原型 v2 开）。
 *  body 可空（{} = 全部源 · current · 不整理——旧消费方兼容档）。无源 → 全零零落盘。 */
registerRoute("POST", "/api/settings/memory/import", async (req, res) => {
  const b = await readSettingsBody(req);
  if (b.failed) {
    sendJson(res, b.status, { ok: false, error: b.msg });
    return;
  }
  const cwd = webCwd();
  const homes = memorySourceHomes();
  const srcs = detectSources(homes, findGitRoot(cwd), cwd).filter((s) => s.count > 0);
  const validIds = new Set<string>(srcs.map((s) => s.id)); /* 键型放宽对齐 string——has(id) 编译面通，含源校验语义原样 */
  let ids: string[] = srcs.map((s) => s.id); /* 放宽声明（元素五源 union → string）：下方请求体分支整体重赋——validIds 含源校验兜底，语义不变 */
  let organize = false;
  let mode: "current" | "all" = "current";
  if (b.body["ids"] !== undefined) {
    if (!Array.isArray(b.body["ids"]) || !b.body["ids"].every((x) => typeof x === "string")) {
      sendJson(res, 400, { ok: false, error: "ids 必须为字符串数组" });
      return;
    }
    ids = b.body["ids"] as string[];
    if (!ids.every((id) => validIds.has(id))) {
      sendJson(res, 400, { ok: false, error: "ids 含未知或无货的记忆源" });
      return;
    }
  }
  if (b.body["organize"] !== undefined) {
    if (typeof b.body["organize"] !== "boolean") {
      sendJson(res, 400, { ok: false, error: "organize 必须为布尔值" });
      return;
    }
    organize = b.body["organize"];
  }
  if (b.body["mode"] !== undefined) {
    if (b.body["mode"] !== "current" && b.body["mode"] !== "all") {
      sendJson(res, 400, { ok: false, error: "mode 必须为 current / all" });
      return;
    }
    mode = b.body["mode"];
  }
  const anchor = anchorHarness();
  const llm: LlmStream | undefined = anchor === undefined ? undefined : (rq) => anchor.h.llm().stream(rq);
  if (organize && llm === undefined) {
    sendJson(res, 400, { ok: false, error: "用模型整理需要活会话承载（先新建或选择一个会话）" });
    return;
  }
  if (mode === "all") {
    const mirrorIds = ids.filter((id) => id !== "codex");
    let imported = 0, updated = 0, skipped = 0, merged = 0;
    let mirror: { projects: number; unresolved: number } | undefined;
    if (mirrorIds.length > 0) {
      const buckets = scanMirrorSources(homes).filter((bk) => mirrorIds.includes(bk.sourceId));
      const r = await importMirror(join(orosusHome(), "memories", "projects"), buckets, {
        organize,
        ...(llm !== undefined ? { llm } : {}),
      });
      imported += r.imported;
      updated += r.updated;
      skipped += r.skipped;
      mirror = { projects: r.projects, unresolved: r.unresolved };
    }
    if (ids.includes("codex")) {
      const all = readSourceNotes(srcs.find((s) => s.id === "codex")?.dir);
      const r = await importNotesProgressive(currentMemoryDir(), all, {
        organize,
        ...(llm !== undefined ? { llm } : {}),
      });
      imported += r.imported;
      updated += r.updated;
      skipped += r.skipped;
      merged += r.merged;
    }
    sendJson(res, 200, { ok: true, imported, updated, skipped, merged, ...(mirror !== undefined ? { mirror } : {}) });
    return;
  }
  const all = ids.flatMap((id) => readSourceNotes(srcs.find((s) => s.id === id)?.dir));
  const r = await importNotesProgressive(currentMemoryDir(), all, {
    organize,
    ...(llm !== undefined ? { llm } : {}),
  });
  sendJson(res, 200, { ok: true, ...r });
});
