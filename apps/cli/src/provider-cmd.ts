import { appendFileSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, chmodSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import { defaultCatalogCacheFile, getCatalogWithSource, type Catalog, type CatalogSource } from "@orosus/provider-custom";
import { resolveWire, adaptBaseUrl } from "@orosus/provider-custom";
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

function appendSecret(path: string, key: string, value: string): void {
  if (!existsSync(path)) {
    const fd = openSync(path, "a", 0o600);
    closeSync(fd);
    if (process.platform !== "win32") chmodSync(path, 0o600); // Windows 无 0o600 等价——降级不静默由调用方提示
  }
  appendFileSync(path, `${key}=${value}\n`);
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
      appendSecret(io.secretsPath, envKeyForWrite, flagKey);
      if (envKey === undefined) io.out(`该目录条目未声明密钥环境变量名——--key 已按派生键 ${envKeyForWrite} 落 secrets.env`);
    }

    const config = readConfig(io.configPath);
    const pc = (config["provider-custom"] as Record<string, unknown> | undefined) ?? {};
    const providers = (pc["providers"] as Record<string, unknown> | undefined) ?? {};
    const modelFlag = flag("--model"); // 提前读取——providers 条目与顶层 model 两处消费（M4-2 T1）
    providers[id] = {
      type: wire.wire,
      baseUrl: finalBaseUrl,
      ...(envKeyForWrite !== undefined ? { apiKey: `$ENV:${envKeyForWrite}` } : {}),
      ...(modelFlag !== undefined ? { defaultModel: modelFlag } : {}), // D32 裸名路由锚——与向导 setModel 同口径（M4-2 T1）
    };
    pc["providers"] = providers;
    config["provider-custom"] = pc;
    if (modelFlag !== undefined) {
      config["provider"] = `${id}/${modelFlag}`; // F5 十轮：键名 provider（读侧 model 旧名兼容）
      // 目录窗口链（M3 补强 T7）：models.dev 的 limit.context 写入核心顶层 contextWindow——
      // 目录数据当不受信输入（五轮定案）：整数且 ≥1024 才写，否则跳过 + 提示
      const limit = entry.models?.[modelFlag]?.limit?.context;
      if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1024) {
        config["contextWindow"] = limit;
        io.out(`目录窗口：已按 ${modelFlag} 写入 contextWindow = ${limit}——更换 model 时请自行更新此值`);
      } else if (limit !== undefined) {
        io.out(`目录窗口字段无效（${String(limit)}，须为 ≥1024 的整数）——未写入 contextWindow`);
      }
    }
    writeFileSync(io.configPath, stringify(config), "utf8");
    io.out(`success：已写入 ${id}（${wire.wire} 协议${wire.guessed ? "，目录推断 guessed" : ""}，${finalBaseUrl}）`);
    io.out("（重启或 /reload 生效；配置已全量重写，注释已移除）");
    return 0;
  }

  io.out("用法: orosus provider import <id> | list");
  return 1;
}
