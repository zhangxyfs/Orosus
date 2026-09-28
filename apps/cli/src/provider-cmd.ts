import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import { defaultCatalogCacheFile, getCatalogWithSource, type Catalog, type CatalogSource } from "@orosus/provider-custom";
import { resolveWire, adaptBaseUrl } from "@orosus/provider-custom";
import { upsertSecret } from "@orosus/tool-web";
import { OROSUS_USER_AGENT } from "@orosus/contracts/version";

/** CLI provider 子命令（D34/D37 配置写器）：import（校验即确认）与 list。 */
export interface ProviderCmdIo {
  configPath: string;
  secretsPath: string;
  env: Record<string, string | undefined>;
  getCatalog?: (opts: { registryUrl?: string; fetchImpl?: typeof fetch }) => Promise<{ catalog: Catalog; source: CatalogSource; fetchedAt?: number }>;
  fetchImpl?: typeof fetch;
  out(line: string): void;
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>; // BOM 剥离（v17 平台注记同源）
}

/** CM-13（2026-09-28 code review）：secrets.env 落盘迁 @orosus/tool-web 的 upsertSecret（与 /settings
 *  配置流、引导 appendSecret 接线同一件）——旧本地 appendSecret 是 append-only：重复 import 同名 key
 *  逐行累积（历代旧密钥明文永久滞留）、既存文件无尾换行时首行被吞并、0644 宽权限既存文件不校正
 *  （upsertSecret 内 MV-05 已补无条件 chmod 0o600）。键/值形态前置校验见 import 分支（发网与写盘前拒绝）。 */

/** TOML 基本串：JSON.stringify 的转义集（\" \\ \n \r \t \uXXXX）恰为 TOML 基本串合法字面——
 *  行级写绕过 smol-toml stringify 的同时也绕过了它的转义，须自带（CM-11 同族防线）。 */
const tomlBasic = (v: string): string => JSON.stringify(v);

/** 值 → TOML 右值字面（字符串走基本串转义，数字原样）。 */
const tomlValue = (v: string | number): string => (typeof v === "string" ? tomlBasic(v) : String(v));

/** CM-14（2026-09-28 code review）：import 写盘从「parse → 改 → stringify 全量重写」改行级节区感知
 *  （module-toggle.ts 同款手法——全量重写洗掉用户注释与键序，与仓内「行级写 TOML 必须节区感知」铁律
 *  两口径）。落点三处：[provider-custom.providers.<id>] 节整体重写（节 = 机器管理面，与旧 stringify 的
 *  整条目替换语义一致）+ 顶层 provider / contextWindow 键 upsert（首节头之前）。
 *  只认节头形态：inline table（provider-custom = { … }）、点键、引号节名等异形匹配不到 → 会产出重复
 *  定义 → 写后 parse 验证失败 → 回退旧全量重写路径（返回 "rewrite"，输出文案明示注释已移除）——
 *  任何输入都不产出坏配置。id 非 bare-key 形态（含点/引号/空格等）同样直走回退（旧路径能正确引号化）。 */
function writeProviderImport(
  configPath: string,
  id: string,
  providerEntry: Record<string, string>,
  topLevel: Record<string, string | number>,
): "line" | "rewrite" {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return "rewrite";
  let raw = "";
  try {
    raw = readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""); // BOM 剥离（readConfig 同源）
  } catch {
    /* 缺文件从空起 */
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw === "" ? [] : raw.split(/\r?\n/);
  const sectionRe = /^\s*\[\s*([^\]#]+?)\s*\]/; // module-toggle.ts 同款
  const headerPath = `provider-custom.providers.${id}`;
  // ① 目标节整体重写（节尾空行回缩保留——不被 splice 吞掉与下节的分隔）
  let secStart = -1;
  let secEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(sectionRe);
    if (m === null) continue;
    if (secStart !== -1) { secEnd = i; break; }
    if (m[1] === headerPath) secStart = i;
  }
  const entryLines = Object.entries(providerEntry).map(([k, v]) => `${k} = ${tomlValue(v)}`);
  if (secStart !== -1) {
    if (secEnd === -1) secEnd = lines.length;
    while (secEnd > secStart + 1 && lines[secEnd - 1]!.trim() === "") secEnd--; // 节尾空行留在原地
    lines.splice(secStart, secEnd - secStart, `[${headerPath}]`, ...entryLines);
  } else {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push(""); // 与既有内容空行隔开
    lines.push(`[${headerPath}]`, ...entryLines);
  }
  // ② 顶层键 upsert（TOML 顶层键不得落节内——只在首节头之前找/插）
  let topEnd = lines.findIndex((l) => sectionRe.test(l));
  if (topEnd === -1) topEnd = lines.length;
  for (const [k, v] of Object.entries(topLevel)) {
    const re = new RegExp(`^\\s*${k}\\s*=`); // k 为受控字面量（provider / contextWindow），无需转义
    const hit = lines.slice(0, topEnd).findIndex((l) => re.test(l));
    if (hit >= 0) lines[hit] = `${k} = ${tomlValue(v)}`;
    else {
      lines.splice(topEnd, 0, `${k} = ${tomlValue(v)}`);
      topEnd++;
    }
  }
  const next = lines.join(eol);
  // ③ 写后验证（先验后写）：行级产物的 parse 语义必须与旧全量重写等价（条目键值齐、顶层键生效、可解析）
  try {
    const doc = parse(next) as Record<string, unknown>;
    const got = ((doc["provider-custom"] as Record<string, unknown> | undefined)?.["providers"] as Record<string, unknown> | undefined)?.[id];
    if (got === undefined || typeof got !== "object" || got === null) throw new Error("entry missing");
    const gotRec = got as Record<string, unknown>;
    if (Object.keys(gotRec).length !== Object.keys(providerEntry).length) throw new Error("entry key set");
    for (const [k, v] of Object.entries(providerEntry)) if (gotRec[k] !== v) throw new Error("entry value");
    for (const [k, v] of Object.entries(topLevel)) if (doc[k] !== v) throw new Error("top-level value");
    writeFileSync(configPath, next, "utf8");
    return "line";
  } catch {
    // 回退 = 旧路径原样（parse → 改 → stringify 全量重写，注释与键序移除——输出文案明示）。
    // raw 本身坏 TOML 时 parse 在此抛出——与旧 readConfig 行为一致（分发层兜底属 main.ts 域，CM-06）
    const doc = raw === "" ? {} : parse(raw) as Record<string, unknown>;
    const pc = (doc["provider-custom"] as Record<string, unknown> | undefined) ?? {};
    const providers = (pc["providers"] as Record<string, unknown> | undefined) ?? {};
    providers[id] = { ...providerEntry };
    pc["providers"] = providers;
    doc["provider-custom"] = pc;
    for (const [k, v] of Object.entries(topLevel)) doc[k] = v;
    writeFileSync(configPath, stringify(doc), "utf8");
    return "rewrite";
  }
}

const hostOf = (u: string): string | undefined => {
  try { return new URL(u).host; } catch { return undefined; }
};

/** CM-08（2026-09-28 code review）：目录条目无 env 字段（自架/keyless 厂商常见）而用户显式传 --key 时，
 *  旧实现的两个落盘分支（appendSecret / apiKey $ENV:）都只沿 envKey 走——密钥被静默丢弃、输出仍 success，
 *  运行时 401。修法（落盘口径）：派生 OROSUS_<ID>_KEY 键名落 secrets.env + config 写 $ENV: 引用——
 *  仓内铁律 config 不落明文（provider-cmd.test 回归钉），success 输出必须等于密钥已持久。 */
const deriveEnvKey = (id: string): string => {
  const norm = id.toUpperCase().replaceAll(/[^A-Z0-9_]/g, "_");
  return `OROSUS_${norm === "" ? "CUSTOM" : norm}_KEY`;
};

async function verify(baseUrl: string, actualKey: string | undefined, fetchImpl: typeof fetch): Promise<"ok" | "auth" | "network" | "unsupported"> {
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      headers: { "user-agent": OROSUS_USER_AGENT, ...(actualKey !== undefined ? { "x-api-key": actualKey, authorization: `Bearer ${actualKey}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return "auth";
    if (res.status === 404 || res.status === 405) return "unsupported";
    if (!res.ok) return "network";
    return "ok";
  } catch {
    return "network";
  }
}

export function isProviderSubcommand(argv: string[]): boolean {
  return argv[0] === "provider";
}

export async function runProviderSubcommand(argv: string[], io: ProviderCmdIo): Promise<number> {
  const doFetch = io.fetchImpl ?? fetch;
  const getCat = io.getCatalog ?? ((o: { registryUrl?: string; fetchImpl?: typeof fetch }) => getCatalogWithSource({ ...o, cacheFile: defaultCatalogCacheFile() })); // 磁盘持久化：离线也有全量目录；带 source——降级提示要判（M4-2 T1）
  const cmd = argv[1];
  const rest = argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined;
  };

  if (cmd === "list") {
    const config = readConfig(io.configPath);
    const providers = ((config["provider-custom"] as Record<string, unknown> | undefined)?.["providers"] ?? {}) as Record<string, { baseUrl?: string }>;
    io.out("本地已配置厂商：");
    const names = Object.keys(providers).sort((a, b) => a.localeCompare(b)); // 字母序（2026-09-18）——Object.keys 已是新数组，spread 冗余
    if (names.length === 0) io.out("  （无）");
    for (const n of names) io.out(`  ${n}（${providers[n]!.baseUrl ?? "?"}）`);
    io.out("目录厂商（models.dev）：");
    const { catalog } = await getCat({ fetchImpl: doFetch });
    for (const id of Object.keys(catalog).sort((a, b) => a.localeCompare(b))) io.out(`  ${id}${catalog[id]!.name !== undefined ? `（${catalog[id]!.name}）` : ""}`); // 字母序
    return 0;
  }

  if (cmd === "import") {
    const id = rest[0];
    if (id === undefined || id.startsWith("--")) {
      io.out("用法: orosus provider import <id> [--baseUrl <url>] [--registry <url>] [--model <id>] [--key <value>]");
      return 1;
    }
    const registry = flag("--registry");
    const { catalog, source } = await getCat({ ...(registry !== undefined ? { registryUrl: registry } : {}), fetchImpl: doFetch });
    const entry = catalog[id];
    if (entry === undefined) {
      io.out(`目录中没有厂商 "${id}"（可用 orosus provider list 查看）`);
      if (source !== "online") {
        io.out(`[提示] 当前使用${source === "disk" ? "本地缓存目录" : "内置快照"}（在线拉取失败）——厂商可能存在于在线目录，检查网络或代理后重试 /provider（在线源）`);
      }
      return 1;
    }
    const wire = resolveWire(entry);
    if (wire.kind === "invalid") {
      io.out(`无法导入：${wire.reason}`);
      return 1;
    }
    const baseUrl = flag("--baseUrl") ?? entry.api;
    if (baseUrl === undefined || baseUrl === "") {
      io.out(`目录条目缺端点——请用 --baseUrl 指定（厂商 ${id} 的 api 字段为空）`);
      return 1;
    }
    const finalBaseUrl = adaptBaseUrl(baseUrl, wire.wire);
    const modelFlag = flag("--model"); // 提前读取——providers 条目（defaultModel）与顶层 provider/contextWindow 三处消费（M4-2 T1）
    const envKey = entry.env?.[0];
    const flagKey = flag("--key");
    const envValue = envKey !== undefined ? io.env[envKey] : undefined;
    // CM-07 修复（2026-09-28 code review P1）：环境密钥只外发到默认目录声明的官方端点（host 一致）。
    // 自定义 --registry 的目录数据与 --baseUrl 指定的第三方端点都不可信——旧实现 verify 先行把真实
    // 环境密钥（x-api-key + Bearer 双头）发往任意 baseUrl，零确认即泄。非官方端点要验证须 --key 显式提供
    //（用户亲手输入的密钥发给用户亲手指定的端点 = 显式意图）。
    const targetHost = hostOf(finalBaseUrl);
    const officialEndpoint = registry === undefined && envValue !== undefined
      && targetHost !== undefined && targetHost === hostOf(entry.api ?? "");
    const actualKey = flagKey ?? (officialEndpoint ? envValue : undefined);
    if (envValue !== undefined && actualKey === undefined) {
      io.out(`[安全] 环境密钥 ${envKey} 未外发——目标端点非目录官方端点（${finalBaseUrl}${registry !== undefined ? "，自定义 registry" : ""}）；如需验证请用 --key 显式提供`);
    }

    // CM-13 配套防线（落盘键/值形态前置校验——在发网与写盘之前拒绝）：
    // ① --key 值含换行 = 多行粘贴/注入（会把额外行落进 secrets.env，被 loadSecretsEnv 静默生效成
    //    额外变量）——与 provider-custom cli-deps 的 appendSecret 同款拒绝口径；
    // ② 键名来自目录 entry.env[0]（不受信输入，CM-07 同源）——非常规环境变量名无法行级匹配且可
    //    注入额外行，拒绝并明示。派生键（deriveEnvKey）构造上恒过本校验。
    if (flagKey !== undefined && /[\r\n]/.test(flagKey)) {
      io.out("--key 的值含换行——疑似多行粘贴，请整行重新提供（未写入任何配置）");
      return 1;
    }
    if (flagKey !== undefined && envKey !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
      io.out(`目录条目声明的密钥环境变量名 ${JSON.stringify(envKey)} 非常规形态（须 [A-Za-z_][A-Za-z0-9_]*）——疑似目录数据异常，拒绝落盘（未写入任何配置）`);
      return 1;
    }

    // 校验即确认（D37 修订）：2xx 自动写入 / 401 报错不写 / 网络错报错 / 404 警告后写入
    const v = await verify(finalBaseUrl, actualKey, doFetch);
    if (v === "auth") {
      io.out(actualKey !== undefined
        ? "密钥无效（401/403）——未产生任何配置变更"
        : "端点要求鉴权但密钥未外发/未提供——未产生任何配置变更（如需验证可用 --key 显式提供）");
      return 1;
    }
    if (v === "network") {
      io.out("端点不可达——请检查 baseUrl 后重试");
      return 1;
    }
    if (v === "unsupported") io.out("警告：端点可达但不支持校验接口（/models 404/405），密钥未验证，仍写入");

    // CM-08：落盘键名 = 目录声明的 env 名；无声明且带 --key → 派生键（不静默吞密钥，见 deriveEnvKey 注释）
    const envKeyForWrite = envKey ?? (flagKey !== undefined ? deriveEnvKey(id) : undefined);
    if (flagKey !== undefined && envKeyForWrite !== undefined) {
      upsertSecret(io.secretsPath, envKeyForWrite, flagKey); // CM-13：原位更新（重复 import 不累积旧行）+ 0o600 收紧（MV-05）
      if (envKey === undefined) io.out(`该目录条目未声明密钥环境变量名——--key 已按派生键 ${envKeyForWrite} 落 secrets.env`);
    }

    // CM-14：行级节区感知落盘（writeProviderImport）——条目键序 type/baseUrl/apiKey?/defaultModel?
    const providerEntry: Record<string, string> = {
      type: wire.wire,
      baseUrl: finalBaseUrl,
      ...(envKeyForWrite !== undefined ? { apiKey: `$ENV:${envKeyForWrite}` } : {}),
      ...(modelFlag !== undefined ? { defaultModel: modelFlag } : {}), // D32 裸名路由锚——与向导 setModel 同口径（M4-2 T1）
    };
    const topLevel: Record<string, string | number> = {};
    if (modelFlag !== undefined) {
      topLevel["provider"] = `${id}/${modelFlag}`; // F5 十轮：键名 provider（读侧 model 旧名兼容）
      // 目录窗口链（M3 补强 T7）：models.dev 的 limit.context 写入核心顶层 contextWindow——
      // 目录数据当不受信输入（五轮定案）：整数且 ≥1024 才写，否则跳过 + 提示
      const limit = entry.models?.[modelFlag]?.limit?.context;
      if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1024) {
        topLevel["contextWindow"] = limit;
        io.out(`目录窗口：已按 ${modelFlag} 写入 contextWindow = ${limit}——更换 model 时请自行更新此值`);
      } else if (limit !== undefined) {
        io.out(`目录窗口字段无效（${String(limit)}，须为 ≥1024 的整数）——未写入 contextWindow`);
      }
    }
    const how = writeProviderImport(io.configPath, id, providerEntry, topLevel);
    io.out(`success：已写入 ${id}（${wire.wire} 协议${wire.guessed ? "，目录推断 guessed" : ""}，${finalBaseUrl}）`);
    io.out(how === "line"
      ? "（重启或 /reload 生效；行级写——注释与键序保留）"
      : "（重启或 /reload 生效；配置已全量重写，注释已移除）");
    return 0;
  }

  io.out("用法: orosus provider import <id> | list");
  return 1;
}
