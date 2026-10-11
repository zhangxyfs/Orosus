/** 设置端点（web 批 T11 建骨架 + MCP 页——§2 api-settings.ts 清单其余页归 T12/T13）：
 *  - GET /api/settings/mcp（§3 :254 → {servers:McpCatalogRow[]}）：mcp.catalog 服务行原样透传
 *    （五态/来源/指纹/failReason/connectMs 齐备——F6 详情页与 E5 审阅指纹的数据面）；
 *  - POST /api/settings/mcp/ops（§3 :255 {op,name?,spec?} → {ok,report?}）：op 透传 runMcpCommand
 *    （on/off/trust/remove/add）+ edit（结构化写——runMcpCommand 无 edit 子命令，TUI 添加窗 edit
 *    模式同款 writeNestedTable 写器）+ start（E5 失败重连/F6 启动同口——懒启动件触发 mcp.start）；
 *    wrote → h.reload() 直接 await（§4-12：自带 in-flight 互斥与失败旧图续跑，busy 期排队语义同
 *    core——与 T10 模块插拔的 busy 409 不同面，MCP 设置写盘不拒 busy）+ panel 缓存显式失效。
 *  数据面锚定当前会话 harness（设置弹窗全局、模块图随会话——catalog/lazyState 每会话一图）；
 *  无当前会话 = GET 空表 / start 409；on/off/trust/remove/add 走纯配置面（deps 不含 getH）照常写盘，
 *  reload 缺席如实省略（report 不带——后续会话装配自然读新配置）。
 *  边界留档（§4-1/§4-2——帮助页注记归 T18）：项目 .mcp.json 仅对 server 启动 cwd 生效
 *  （mcp/index.ts:379 读 process.cwd()）——deps.projectPath 即池 startCwd 与模块同口径；
 *  mcp-trust.json 模块侧硬编码 homedir()（知悉不修），web 侧注入 join(orosusHome(), "mcp-trust.json")
 *  ——生产（OROSUS_HOME 未设）与 mcpTrustFile() 同径，测试重定向隔离不落真 home。 */
import { join } from "node:path";
import { writeNestedTable, type Harness, type NestedTableValue, type ReloadReport } from "@orosus/core";
import { orosusHome } from "@orosus/contracts/home";
import type { McpCatalogRow } from "@orosus/mcp";
import { runMcpCommand, defaultMcpCmdDeps, type McpCmdDeps } from "../mcp-cmd.ts";
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
