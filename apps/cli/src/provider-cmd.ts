import { appendFileSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, chmodSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import { getCatalog, type Catalog } from "@orosus/provider-custom";
import { resolveWire, adaptBaseUrl } from "@orosus/provider-custom";

/** CLI provider 子命令（D34/D37 配置写器）：import（校验即确认）与 list。 */
export interface ProviderCmdIo {
  configPath: string;
  secretsPath: string;
  env: Record<string, string | undefined>;
  getCatalog?: (opts: { registryUrl?: string; fetchImpl?: typeof fetch }) => Promise<Catalog>;
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

async function verify(baseUrl: string, actualKey: string | undefined, fetchImpl: typeof fetch): Promise<"ok" | "auth" | "network" | "unsupported"> {
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      headers: actualKey !== undefined ? { "x-api-key": actualKey, authorization: `Bearer ${actualKey}` } : {},
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
  const getCat = io.getCatalog ?? getCatalog;
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
    const names = Object.keys(providers);
    if (names.length === 0) io.out("  （无）");
    for (const n of names) io.out(`  ${n}（${providers[n]!.baseUrl ?? "?"}）`);
    io.out("目录厂商（models.dev）：");
    const catalog = await getCat({ fetchImpl: doFetch });
    for (const id of Object.keys(catalog)) io.out(`  ${id}${catalog[id]!.name !== undefined ? `（${catalog[id]!.name}）` : ""}`);
    return 0;
  }

  if (cmd === "import") {
    const id = rest[0];
    if (id === undefined || id.startsWith("--")) {
      io.out("用法: orosus provider import <id> [--baseUrl <url>] [--registry <url>] [--model <id>] [--key <value>]");
      return 1;
    }
    const registry = flag("--registry");
    const catalog = await getCat({ ...(registry !== undefined ? { registryUrl: registry } : {}), fetchImpl: doFetch });
    const entry = catalog[id];
    if (entry === undefined) {
      io.out(`目录中没有厂商 "${id}"（可用 orosus provider list 查看）`);
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
    const actualKey = (envKey !== undefined ? io.env[envKey] : undefined) ?? flagKey;

    // 校验即确认（D37 修订）：2xx 自动写入 / 401 报错不写 / 网络错报错 / 404 警告后写入
    const v = await verify(finalBaseUrl, actualKey, doFetch);
    if (v === "auth") {
      io.out("密钥无效（401/403）——未产生任何配置变更");
      return 1;
    }
    if (v === "network") {
      io.out("端点不可达——请检查 baseUrl 后重试");
      return 1;
    }
    if (v === "unsupported") io.out("警告：端点可达但不支持校验接口（/models 404/405），密钥未验证，仍写入");

    if (flagKey !== undefined && envKey !== undefined) appendSecret(io.secretsPath, envKey, flagKey);

    const config = readConfig(io.configPath);
    const pc = (config["provider-custom"] as Record<string, unknown> | undefined) ?? {};
    const providers = (pc["providers"] as Record<string, unknown> | undefined) ?? {};
    providers[id] = {
      type: wire.wire,
      baseUrl: finalBaseUrl,
      ...(envKey !== undefined ? { apiKey: `$ENV:${envKey}` } : {}),
    };
    pc["providers"] = providers;
    config["provider-custom"] = pc;
    const modelFlag = flag("--model");
    if (modelFlag !== undefined) {
      config["model"] = `${id}/${modelFlag}`;
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
