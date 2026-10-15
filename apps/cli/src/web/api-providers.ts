/** web 批 T13——提供商面端点（api-providers.ts）：
 *  - GET /api/providers（§3 :266，F2 品牌列表）→ {ok, providers:[{key,name,proto,baseUrl,modelCount,
 *    models,defaultModel?,hasApiKey?}]}：读配置（loadConfig 的 [provider-custom].providers 槽——读面
 *    为分层合并后的有效视图）；models = 槽值 listModels（声明模型表接管 > 目录优选 > live 兜底——
 *    provider-custom 槽内 models 键，2026-10-14 走查修⑭二期；锚定当前会话 harness 的图取槽值服务，
 *    无会话/死端点 → 空表降级）+ declaredModels（声明表原值透传——设置页「自定义接管中」态判据）。
 *    （五轮复核补：F2「模型表增删」一期降级只读展示 + defaultModel 选择——走查修⑭起模型表可增删）。
 *  - POST /api/providers（§3 :267，F2 自定义手填/编辑/删除）{op:"upsert"|"remove", slot, spec?,
 *    removeSecret?} → {ok}：web 侧 writeNestedTable 写用户 config.toml 的
 *    [provider-custom.providers.<slot>]——槽内键序 type/baseUrl/apiKey?/defaultModel?/models?
 *    （provider-cmd.ts:251-255 写形同款 + 走查修⑭ models 键）；表单不管的槽键（toolImages/
 *    acceptedImageMimes/槽级 contextWindow 等）保存时按原序回填——整表替换不再静默抹键（同修）。
 *    apiKey 槽内只写 $ENV: 引用、值经 upsertSecret 落
 *    secrets.env（tool-web settings.ts:49 原地更新件——CM-13/MV-05 纪律）；contextWindow 落顶层键
 *    （provider-cmd.ts:264 同形——读侧槽位级有兜底但写侧统一顶层）；remove = 删节键 +
 *    removeSecret 控制连删 secret 行。**写盘前形状校验**（T11 checkEditSpec 同款纪律——防带病落盘）。
 *  - POST /api/providers/cmd（§3 :269）{argv:string[]} → {ok, code, out}：runProviderSubcommand 透传
 *    （子命令仅 list/import——argv[0] 须 "provider"，防通用命令执行口）；import 成功（code 0）后
 *    reload 收口（目录缓存刷新走子命令自带供给链——红线修正段）。
 *  - GET /api/providers/catalog（§3 :270）→ {ok, vendors:[…], source}：**core 的 readModelsDevCatalog
 *    读盘上缓存**（红线修正段：providers 目录数据不用 provider-custom 的函数——可卸载模块 import
 *    禁令；缓存文件与模块 defaultCatalogCacheFile 同一）。web 侧永不在本端点拉网（source 恒
 *    "cache"），缓存缺省/超龄 → 空表，刷新经 POST /api/providers/cmd 的 import 自带路径。
 *  reload/锚点件为本文件私有小拷贝（api-settings 的同名件模块私有——api-settings 已 side-effect
 *  import 本文件，反向 import 成环；两件十行量级、注释互指，后续如需共用可上移共享模块）。 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { loadConfig, modelsDevCacheFile, readModelsDevCatalog, writeNestedTable, type Harness, type NestedTableValue, type ReloadReport } from "@orosus/core";
import { orosusHome } from "@orosus/contracts/home";
import { upsertSecret } from "@orosus/tool-web";
import { runProviderSubcommand, type ProviderCmdIo } from "../provider-cmd.ts";
import { configFacePaths } from "../config-face.ts";
import { registerRoute, readBody, sendJson } from "./server.ts";
import { webHostPool } from "./mod.ts";
import { invalidatePanelCache } from "./api-panel.ts";

/** 写侧 JSON 体上限（send/toggle 1MiB 同款自创值口径——apiKey/baseUrl 量级，防失控客户端）。 */
const PROVIDERS_BODY_MAX_BYTES = 1024 * 1024;

// ---------- 锚点 / reload（api-settings 同名件私有拷贝——互不反向 import，见文件头注） ----------

const anchorHarness = (): { sid: string; h: Harness } | undefined => {
  // 游标兜底 viewer 化身（2026-10-12 走查修——与 api-settings.anchorHarness 同口径）
  const pool = webHostPool();
  const cursor = pool?.cursorSid();
  const hs = pool?.current() ?? (cursor !== undefined ? pool?.lookup(cursor) : undefined);
  const h = hs?.core;
  return hs !== undefined && h !== undefined ? { sid: hs.sid, h } : undefined;
};

/** wrote → reload 收口（§4-12 直接 await + panel 缓存失效——MCP ops / prefs 同口径）。 */
const reloadAfterWrite = async (anchor: { sid: string; h: Harness } | undefined): Promise<ReloadReport | undefined> => {
  if (anchor === undefined) return undefined;
  const report = await anchor.h.reload();
  invalidatePanelCache(anchor.sid);
  return report;
};

// ---------- 配置 / 密钥读写小件 ----------

const userConfigPath = (): string => join(orosusHome(), "config.toml");
const secretsEnvPath = (): string => join(orosusHome(), "secrets.env");

/** 读用户层 config.toml 的 [provider-custom].providers（写面专用——loadConfig 是分层合并视图，
 *  upsert 保留旧 apiKey / remove 判存在须以写盘目标文件为准；坏文件 = 空表）。 */
const readUserProviders = (): Record<string, Record<string, unknown>> => {
  try {
    const doc = parse(readFileSync(userConfigPath(), "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const providers = (doc["provider-custom"] as Record<string, unknown> | undefined)?.["providers"];
    if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return {};
    return providers as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
};

/** API Key 派生环境变量名（provider-cmd.ts deriveEnvKey 同式——目录无 env 声明的自定义槽用同一
 *  构造：OROSUS_<规范化槽名>_KEY；模块私有件，web 侧复刻接线）。 */
const deriveEnvKey = (slot: string): string => {
  const norm = slot.toUpperCase().replaceAll(/[^A-Z0-9_]/g, "_");
  return `OROSUS_${norm === "" ? "CUSTOM" : norm}_KEY`;
};

/** secrets.env 单行删除（upsertSecret 的对称件——tool-web 未导出删除面，本文件自带；同款纪律：
 *  0600 落盘 + 无条件 chmod 收紧、尾行收拢恒一 eol、坏文件不炸）。文件缺省/行不在场 = no-op。 */
const removeSecretLine = (secretsFile: string, name: string): void => {
  if (!existsSync(secretsFile)) return;
  const lines = readFileSync(secretsFile, "utf8").split("\n");
  const kept = lines.filter((l) => !(l.trim().startsWith(`${name}=`) || l.trim() === name));
  if (kept.length === lines.length) return; // 行不在场——不动文件
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  mkdirSync(dirname(secretsFile), { recursive: true });
  writeFileSync(secretsFile, `${kept.join("\n")}\n`, { mode: 0o600 });
  try { chmodSync(secretsFile, 0o600); } catch { /* 平台不支持——mode 尽力（upsertSecret 同款） */ }
};

/** TOML 顶层键行级 upsert（provider-cmd.ts writeProviderImport ② 段同款——顶层键不得落节内，只在
 *  首节头之前找/插；CM-01 拒写纪律：坏 TOML 不动）。core 的 writeSectionKey 只收节内键，顶层键
 *  （provider/contextWindow）在 web 侧自带同款行级写。 */
const writeTopLevelKey = (configPath: string, key: string, value: string | number): void => {
  let raw = "";
  try {
    raw = readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    /* 缺文件从空起 */
  }
  if (raw !== "") {
    try {
      parse(raw);
    } catch {
      return; // CM-01：读不懂的盘不动
    }
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw === "" ? [] : raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && raw !== "") lines.pop();
  const sectionRe = /^\s*\[\s*[^\]#]+?\s*\]/;
  let topEnd = lines.findIndex((l) => sectionRe.test(l));
  if (topEnd === -1) topEnd = lines.length;
  const hitRe = new RegExp(`^\\s*${key}\\s*=`); // key 为受控字面量（contextWindow），无需转义
  const hit = lines.slice(0, topEnd).findIndex((l) => hitRe.test(l));
  const literal = typeof value === "string" ? JSON.stringify(value) : String(value);
  if (hit >= 0) lines[hit] = `${key} = ${literal}`;
  else lines.splice(topEnd, 0, `${key} = ${literal}`);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, lines.join(eol) + eol, "utf8");
};

// ---------- GET /api/providers（F2 品牌列表——读配置 + 槽值模型发现） ----------

/** 槽值归一形态（graph().services.provider 的返回面——api-model.ts 同款消费侧本地声明，圈地纪律）。 */
interface ProviderSlot {
  listModels?: () => Promise<string[]>;
  defaultModel?: string;
}

registerRoute("GET", "/api/providers", async (_req, res) => {
  const providers = loadConfig(configFacePaths()).sections.get("provider-custom")?.providers;
  const table = typeof providers === "object" && providers !== null && !Array.isArray(providers)
    ? (providers as Record<string, Record<string, unknown>>)
    : {};
  const anchor = anchorHarness();
  const graph = anchor?.h.graph();
  const rows: { key: string; name: string; proto: string; baseUrl: string; modelCount: number; models: string[]; defaultModel?: string; hasApiKey?: true }[] = [];
  for (const slot of Object.keys(table).toSorted((a, b) => a.localeCompare(b))) {
    const entry = table[slot]!;
    if (typeof entry !== "object" || entry === null) continue;
    // 模型表 = live 发现（目录优选 + live 兜底——adapter 槽值服务；无会话/失败 → 空表降级）
    let models: string[] = [];
    if (graph !== undefined) {
      const adapter: ProviderSlot | undefined = graph.services.provider(slot);
      if (adapter?.listModels !== undefined) {
        try {
          models = await adapter.listModels();
        } catch {
          models = []; // 死端点/网络断——空清单（/api/models 同口径）
        }
      }
    }
    const rec = entry as { type?: unknown; baseUrl?: unknown; defaultModel?: unknown; apiKey?: unknown; models?: unknown };
    const declared = Array.isArray(rec.models) ? rec.models.filter((m): m is string => typeof m === "string" && m !== "") : [];
    if (declared.length > 0) models = declared; /* 声明表即生效表（接管语义）——无会话/重载窗口期也如实返回，不借发现链空表降级 */
    rows.push({
      key: slot,
      name: slot, // 自定义槽无显示名——name = slot（目录厂商名在 /api/providers/catalog）
      proto: typeof rec.type === "string" ? rec.type : "",
      baseUrl: typeof rec.baseUrl === "string" ? rec.baseUrl : "",
      modelCount: models.length,
      models,
      /* 走查修⑭：declaredModels = 槽内声明模型表（config 原值）——设置页据此显示「自定义接管中」
       *  态与「恢复自动发现」出口；缺省/空 = 自动发现（models 字段即发现链结果） */
      ...(declared.length > 0 ? { declaredModels: declared } : {}),
      ...(typeof rec.defaultModel === "string" && rec.defaultModel !== "" ? { defaultModel: rec.defaultModel } : {}),
      ...(typeof rec.apiKey === "string" && rec.apiKey !== "" ? { hasApiKey: true } : {}), // 引用在（值不回显）
    });
  }
  sendJson(res, 200, { ok: true, providers: rows });
});

// ---------- POST /api/providers（F2 自定义 upsert/remove——写形钉） ----------

/** upsert spec 白名单键 → 值形状校验（T11 checkEditSpec 同款纪律：写盘前全量校验，非法一律拒）。
 *  键族与值域 = provider-cmd import 落盘面同源：type（协议 id）/ baseUrl（http(s) URL）/
 *  defaultModel?（裸模型 id）/ contextWindow?（顶层键——整数 ≥1024，provider-cmd.ts:262 同闸）/
 *  apiKey?（明文只进 secrets.env——换行注入拒绝，CM-13 同款）/
 *  models?（2026-10-14 走查修「模型表增删」二期：声明模型表——字符串数组，条目 1..128 字符零空白，
 *  ≤64 条去重；空数组 = 摘键回自动发现）。 */
const SPEC_KEYS: Record<string, (v: unknown) => boolean> = {
  type: (v) => typeof v === "string" && v.trim() !== "" && !/\s/.test(v),
  baseUrl: (v) => {
    if (typeof v !== "string" || v === "") return false;
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  },
  defaultModel: (v) => typeof v === "string" && v.trim() !== "",
  contextWindow: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1024,
  apiKey: (v) => typeof v === "string" && v !== "" && !/[\r\n]/.test(v),
  models: (v) => Array.isArray(v) && v.length <= 64 && v.every((m) => typeof m === "string" && m.trim() !== "" && m.length <= 128 && !/\s/.test(m)), /* 模型 id 零空白（UI 同闸） */
};

interface CheckedSpec {
  type: string;
  baseUrl: string;
  defaultModel?: string;
  contextWindow?: number;
  apiKey?: string;
  models?: string[];
}

function checkProviderSpec(spec: Record<string, unknown>): { ok: true; spec: CheckedSpec } | { ok: false; error: string } {
  const out: CheckedSpec = { type: "", baseUrl: "" };
  for (const [k, v] of Object.entries(spec)) {
    const shape = SPEC_KEYS[k];
    if (shape === undefined) return { ok: false, error: `spec 有未知键「${k}」（合法键：${Object.keys(SPEC_KEYS).join("/")}）` };
    if (!shape(v)) return { ok: false, error: `spec 键「${k}」的值形状非法` };
    if (k === "type") out.type = v as string;
    if (k === "baseUrl") out.baseUrl = v as string;
    if (k === "defaultModel") out.defaultModel = v as string;
    if (k === "contextWindow") out.contextWindow = v as number;
    if (k === "apiKey") out.apiKey = v as string;
    if (k === "models") out.models = [...new Set((v as string[]).map((m) => m.trim()))]; // 去重（去空白后）——写面前归一
  }
  if (out.type === "" || out.baseUrl === "") {
    return { ok: false, error: "spec 必须含 type 与 baseUrl（http/https URL）" };
  }
  return { ok: true, spec: out };
}

registerRoute("POST", "/api/providers", async (req, res) => {
  const raw = await readBody(req, PROVIDERS_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { op?: unknown; slot?: unknown; spec?: unknown; removeSecret?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  const op = body.op;
  const slot = typeof body.slot === "string" ? body.slot.trim() : "";
  if (op !== "upsert" && op !== "remove") {
    sendJson(res, 400, { ok: false, error: "op 必须为 upsert / remove" });
    return;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(slot)) {
    sendJson(res, 400, { ok: false, error: "slot 必填（TOML bare-key 形：字母数字下划线连字符）" });
    return;
  }
  const anchor = anchorHarness();

  if (op === "remove") {
    const existing = readUserProviders()[slot];
    if (existing === undefined) {
      sendJson(res, 404, { ok: false, error: `自定义槽 "${slot}" 不存在（写面 = 用户层 config.toml）` });
      return;
    }
    // 连删 secret 行的键名 = 槽内 $ENV: 引用（先读后删——节键删除后引用即失）
    const ref = typeof existing["apiKey"] === "string" ? existing["apiKey"] : "";
    const envName = ref.startsWith("$ENV:") ? ref.slice(5) : "";
    writeNestedTable(userConfigPath(), `provider-custom.providers.${slot}`, null);
    if (body.removeSecret === true && envName !== "") removeSecretLine(secretsEnvPath(), envName);
    const report = await reloadAfterWrite(anchor);
    sendJson(res, 200, { ok: true, ...(report !== undefined ? { report } : {}) });
    return;
  }

  // upsert
  if (typeof body.spec !== "object" || body.spec === null || Array.isArray(body.spec)) {
    sendJson(res, 400, { ok: false, error: "spec 必须为槽值对象" });
    return;
  }
  const checked = checkProviderSpec(body.spec as Record<string, unknown>);
  if (!checked.ok) {
    sendJson(res, 400, { ok: false, error: checked.error });
    return;
  }
  const values: Record<string, NestedTableValue> = { type: checked.spec.type, baseUrl: checked.spec.baseUrl };
  // apiKey：掩码表单不重发即保留旧 $ENV: 引用（凭据语义——值不回显、编辑不清空）；重发即换新
  const oldSlot = readUserProviders()[slot];
  if (checked.spec.apiKey !== undefined) {
    const envName = deriveEnvKey(slot);
    upsertSecret(secretsEnvPath(), envName, checked.spec.apiKey); // 明文只落 secrets.env（0600 + 原地更新）
    values["apiKey"] = `$ENV:${envName}`;
  } else {
    const oldRef = typeof oldSlot?.["apiKey"] === "string" ? oldSlot["apiKey"] : "";
    if (oldRef.startsWith("$ENV:")) values["apiKey"] = oldRef;
  }
  // defaultModel：普通字段——缺省即清除（整表替换语义；F2「defaultModel 选择」的清选路径）
  if (checked.spec.defaultModel !== undefined) values["defaultModel"] = checked.spec.defaultModel;
  // 声明模型表（走查修⑭二期）：非空数组落键（接管发现链）；空数组 = 不写键（回自动发现——
  //  整表替换语义下缺键即摘键，「恢复自动发现」路径）
  if (checked.spec.models !== undefined && checked.spec.models.length > 0) values["models"] = checked.spec.models;
  /* 走查修⑭：整表替换前回填表单不管的槽键（toolImages/acceptedImageMimes/槽级 contextWindow 等——
   *  旧面一保存就被静默抹掉）。托管键集 = type/baseUrl/apiKey/defaultModel/models；保留键按原序殿后。 */
  const MANAGED = new Set(["type", "baseUrl", "apiKey", "defaultModel", "models"]);
  if (oldSlot !== undefined) {
    for (const [k, v] of Object.entries(oldSlot)) {
      if (MANAGED.has(k)) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") values[k] = v;
      else if (Array.isArray(v) && v.every((x) => typeof x === "string")) values[k] = v as string[];
    }
  }
  writeNestedTable(userConfigPath(), `provider-custom.providers.${slot}`, values);
  if (checked.spec.contextWindow !== undefined) writeTopLevelKey(userConfigPath(), "contextWindow", checked.spec.contextWindow);
  const report = await reloadAfterWrite(anchor);
  sendJson(res, 200, { ok: true, ...(report !== undefined ? { report } : {}) });
});

// ---------- POST /api/providers/cmd（子命令透传） ----------

type ProviderCatalogGetter = NonNullable<ProviderCmdIo["getCatalog"]>;

let providerCmdCatalogForTest: ProviderCatalogGetter | undefined;

/** 测试注入：provider 子命令的目录取数面（undefined = 复位回模块自带供给链——生产恒缺省，
 *  目录拉取/落盘/降级链全在 runProviderSubcommand 侧，web 不经手）。 */
export const setProviderCmdCatalogForTest = (f: ProviderCatalogGetter | undefined): void => {
  providerCmdCatalogForTest = f;
};

/** POST /api/providers/cmd {argv:string[]} → {ok, code, out}（§3 :269）：runProviderSubcommand 透传
 *  （argv[0] 须 "provider" + 子命令词——闸门防本端点被当通用命令执行口；未知子命令不在此拦，CLI 侧
 *  用法文案 + code:1 原样透传）。io = 用户层 config/secrets + process.env（envKey 外发判据同 CLI）。
 *  import 成功（code 0）→ reload 收口（写盘生效 + 目录缓存刷新都在子命令侧闭环）。 */
registerRoute("POST", "/api/providers/cmd", async (req, res) => {
  const raw = await readBody(req, PROVIDERS_BODY_MAX_BYTES);
  if (raw === "too-large") {
    sendJson(res, 413, { ok: false, error: "body too large" });
    return;
  }
  let body: { argv?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  const argv = body.argv;
  if (!Array.isArray(argv) || argv.length < 2 || !argv.every((a) => typeof a === "string")) {
    sendJson(res, 400, { ok: false, error: "argv 必须为字符串数组（首词 provider + 子命令）" });
    return;
  }
  if (argv[0] !== "provider") {
    sendJson(res, 400, { ok: false, error: "argv[0] 须为 provider（子命令仅 list/import——目录添加形：provider import <目录id> --baseUrl <url> --key <k> --model <id>）" });
    return;
  }
  const lines: string[] = [];
  const io: ProviderCmdIo = {
    configPath: userConfigPath(),
    secretsPath: secretsEnvPath(),
    env: process.env,
    out: (line) => {
      lines.push(line);
    },
    ...(providerCmdCatalogForTest !== undefined ? { getCatalog: providerCmdCatalogForTest } : {}),
  };
  let code: number;
  try {
    code = await runProviderSubcommand(argv as string[], io);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (code === 0 && argv[1] === "import") {
    const report = await reloadAfterWrite(anchorHarness());
    sendJson(res, 200, { ok: true, code, out: lines.join("\n"), ...(report !== undefined ? { report } : {}) });
    return;
  }
  sendJson(res, 200, { ok: true, code, out: lines.join("\n") });
});

// ---------- GET /api/providers/catalog（models-dev 目录缓存读面） ----------

/** 目录条目投影（不受信输入——宽形状逐字段守卫；模型行按记录键/id 双口径取 id）。
 *  label = 目录 name（真值——/api/models 弱字段的交付面在此）、ctx = limit.context（正整数才收，
 *  缺省 0）；不过滤 deprecated/embedding（F2 搜索框前端自筛——usableCatalogModels 是模块面禁 import，
 *  原样投影不复制模块过滤逻辑）。 */
const projectVendor = (key: string, entry: unknown): { key: string; name: string; proto: string; baseUrl: string; models: { id: string; label: string; ctx: number }[] } => {
  const rec = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
  const models: { id: string; label: string; ctx: number }[] = [];
  const modelsTable = rec["models"];
  if (typeof modelsTable === "object" && modelsTable !== null && !Array.isArray(modelsTable)) {
    for (const [k, m] of Object.entries(modelsTable as Record<string, unknown>)) {
      if (typeof m !== "object" || m === null) continue;
      const mr = m as Record<string, unknown>;
      const id = typeof mr["id"] === "string" && mr["id"] !== "" ? mr["id"] : k;
      const name = typeof mr["name"] === "string" && mr["name"] !== "" ? mr["name"] : id;
      const limit = typeof mr["limit"] === "object" && mr["limit"] !== null && !Array.isArray(mr["limit"]) ? (mr["limit"] as Record<string, unknown>) : undefined;
      const ctx = typeof limit?.["context"] === "number" && Number.isInteger(limit["context"]) && limit["context"] > 0 ? limit["context"] : 0;
      models.push({ id, label: name, ctx });
    }
  }
  return {
    key,
    name: typeof rec["name"] === "string" && rec["name"] !== "" ? rec["name"] : key,
    proto: typeof rec["type"] === "string" ? rec["type"] : "",
    baseUrl: typeof rec["api"] === "string" ? rec["api"] : "",
    models,
  };
};

/** GET /api/providers/catalog → {ok, vendors, source:"cache"}（§3 :270，F2 添加·目录搜索数据面）。
 *  红线修正段：目录数据走 core 的 readModelsDevCatalog（盘上缓存 <home>/cache/models-dev.json——
 *  与 provider-custom defaultCatalogCacheFile 同一文件；mtime 记忆化免反复 parse 大 JSON）。web 不拉网
 *  （source 恒 "cache"、缺缓存 → 空表）——缓存刷新经 POST /api/providers/cmd 的 import 自带路径
 *  （runProviderSubcommand → 模块供给链在线拉取 + 落盘），刷新后本端点自然见新。 */
registerRoute("GET", "/api/providers/catalog", async (_req, res) => {
  const catalog = readModelsDevCatalog(modelsDevCacheFile(orosusHome()));
  const vendors = catalog === undefined
    ? []
    : Object.entries(catalog).map(([key, entry]) => projectVendor(key, entry));
  sendJson(res, 200, { ok: true, vendors, source: "cache" });
});
