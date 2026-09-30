import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** T14（m4-3c）：MCP 官方注册表（registry.modelcontextprotocol.io）查询与安装。
 *  API 形状（2026-09-30 实测）：GET /v0/servers?search=关键词&limit=N →
 *  { servers: [{ server: { name, description, repository: { url, source }, version,
 *    remotes: [{ type, url, headers: [{ name, value, description, isRequired, isSecret }] }],
 *    installations: [{ type: "stdio", command, args, env: [{ name, description, isRequired }] }] } }],
 *    metadata: { nextCursor, count } }
 *  缓存纪律（设计空白拍板）：30 天 TTL、断网用缓存（不看龄）、启动时绝不自动联网——只有显式
 *  /mcp browse 才发请求。 */

export interface RegistryEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
}

export interface RegistryEntry {
  /** 注册表全名（io.github/github-mcp-server 形） */
  name: string;
  /** 短名（尾段——作配置键用） */
  shortName: string;
  description: string;
  version: string;
  repositoryUrl?: string;
  /** 本地 stdio 安装形态（可多个——取第一个可用的） */
  stdio?: { command: string; args: string[]; requiredEnv: string[] };
  /** 远程形态 */
  remote?: { url: string; requiredHeaders: string[] };
}

export interface RegistryCache {
  fetchedAt: string;
  entries: RegistryEntry[];
}

export const REGISTRY_TTL_MS = 30 * 24 * 3600 * 1000;
export const REGISTRY_SEARCH_LIMIT = 50;
export const REGISTRY_SHOW_LIMIT = 20;

export const defaultRegistryCacheFile = (orosusHomeCache: string): string => `${orosusHomeCache.replace(/[\\/]+$/, "")}/mcp-registry.json`;

type RawRegistryDoc = {
  servers?: Array<{
    server?: {
      name?: unknown;
      description?: unknown;
      version?: unknown;
      repository?: { url?: unknown } | null;
      remotes?: Array<{ type?: unknown; url?: unknown; headers?: Array<{ name?: unknown; isRequired?: unknown }> | null }> | null;
      installations?: Array<{ type?: unknown; command?: unknown; args?: unknown; env?: Array<{ name?: unknown; isRequired?: unknown }> | null }> | null;
    } | null;
  }> | null;
};

/** 注册表条目归一化（纯函数——不可信输入最小形状校验，坏条目丢弃）。 */
export function normalizeRegistry(doc: unknown): RegistryEntry[] {
  const raw = doc as RawRegistryDoc;
  const out: RegistryEntry[] = [];
  for (const w of raw?.servers ?? []) {
    const s = w?.server;
    if (s === null || s === undefined || typeof s.name !== "string" || s.name === "") continue;
    const shortName = s.name.includes("/") ? s.name.split("/").pop()! : s.name;
    const stdioCandidates = (s.installations ?? []).filter(
      (i): i is { type?: unknown; command?: unknown; args?: unknown; env?: Array<{ name?: unknown; isRequired?: unknown }> | null } =>
        i !== null && typeof i === "object" && i.type === "stdio" && typeof i.command === "string" && i.command !== "",
    );
    const stdio = stdioCandidates.length > 0
      ? {
          command: stdioCandidates[0]!.command as string,
          args: Array.isArray(stdioCandidates[0]!.args) ? (stdioCandidates[0]!.args as unknown[]).filter((a): a is string => typeof a === "string") : [],
          requiredEnv: ((stdioCandidates[0]!.env ?? []) as Array<{ name?: unknown; isRequired?: unknown }>)
            .filter((e) => e !== null && typeof e === "object" && typeof e.name === "string" && e.isRequired === true)
            .map((e) => e.name as string),
        }
      : undefined;
    const remoteCandidate = (s.remotes ?? []).find(
      (r) => r !== null && typeof r === "object" && typeof r.url === "string" && (r.type === undefined || r.type === "streamable-http" || r.type === "http"),
    );
    const remote = remoteCandidate !== undefined && typeof remoteCandidate.url === "string"
      ? {
          url: remoteCandidate.url,
          requiredHeaders: ((remoteCandidate.headers ?? []) as Array<{ name?: unknown; isRequired?: unknown }>)
            .filter((h) => h !== null && typeof h === "object" && typeof h.name === "string" && h.isRequired === true)
            .map((h) => h.name as string),
        }
      : undefined;
    out.push({
      name: s.name,
      shortName,
      description: typeof s.description === "string" ? s.description : "",
      version: typeof s.version === "string" ? s.version : "",
      ...(typeof s.repository?.url === "string" ? { repositoryUrl: s.repository.url } : {}),
      ...(stdio !== undefined ? { stdio } : {}),
      ...(remote !== undefined ? { remote } : {}),
    });
  }
  return out;
}

/** 读缓存（缺文件/坏 JSON = 无缓存）。 */
export function readRegistryCache(file: string): RegistryCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as RegistryCache;
    if (parsed !== null && typeof parsed === "object" && typeof parsed.fetchedAt === "string" && Array.isArray(parsed.entries)) return parsed;
  } catch { /* 无缓存 */ }
  return undefined;
}

export function writeRegistryCache(file: string, cache: RegistryCache): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cache, null, 2), "utf8");
}

export interface RegistryFetchResult {
  entries: RegistryEntry[];
  /** true = 本次真发了网络请求（false = 走的缓存） */
  fetched: boolean;
  offline: boolean;
}

/** 搜索（缓存优先纪律的实现口）：缓存 30 天内直接用；过期先试网、断网回落过期缓存（不看龄）。 */
export async function searchRegistry(opts: {
  query: string;
  cacheFile: string;
  fetchImpl?: typeof fetch;
}): Promise<RegistryFetchResult> {
  const cached = readRegistryCache(opts.cacheFile);
  const fresh = cached !== undefined && Date.now() - Date.parse(cached.fetchedAt) < REGISTRY_TTL_MS && !Number.isNaN(Date.parse(cached.fetchedAt));
  if (cached !== undefined && fresh) {
    return { entries: filterEntries(cached.entries, opts.query), fetched: false, offline: false };
  }
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(
      `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(opts.query)}&limit=${REGISTRY_SEARCH_LIMIT}`,
      { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`注册表返回 ${res.status}`);
    const entries = normalizeRegistry(await res.json());
    writeRegistryCache(opts.cacheFile, { fetchedAt: new Date().toISOString(), entries });
    return { entries: filterEntries(entries, opts.query), fetched: true, offline: false };
  } catch {
    if (cached !== undefined) return { entries: filterEntries(cached.entries, opts.query), fetched: false, offline: true }; // 断网用缓存（不看龄）
    return { entries: [], fetched: false, offline: true };
  }
}

const filterEntries = (entries: RegistryEntry[], query: string): RegistryEntry[] => {
  const q = query.toLowerCase();
  return entries.filter((e) => e.name.toLowerCase().includes(q) || e.shortName.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
};

/** 安装决策（纯函数）：优先 stdio（win32 启动器包装已备）、退远程；需要必填 env/头 = 拒绝半自动
 *  （Reasonix 同款「缺密钥转手动」）——返回手填模板。 */
export type InstallDecision =
  | { kind: "stdio"; values: { command: string; args: string[] }; entry: RegistryEntry }
  | { kind: "remote"; values: { url: string }; entry: RegistryEntry }
  | { kind: "needs-secrets"; template: string; missing: string[]; entry: RegistryEntry }
  | { kind: "not-found" }
  | { kind: "ambiguous"; candidates: RegistryEntry[] };

export function decideInstall(entries: RegistryEntry[], name: string): InstallDecision {
  const matches = entries.filter((e) => e.name === name || e.shortName === name);
  if (matches.length === 0) return { kind: "not-found" };
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
  const e = matches[0]!;
  if (e.stdio !== undefined) {
    if (e.stdio.requiredEnv.length > 0) {
      return { kind: "needs-secrets", missing: e.stdio.requiredEnv, entry: e, template: stdioTemplate(e) };
    }
    return { kind: "stdio", values: { command: e.stdio.command, args: e.stdio.args }, entry: e };
  }
  if (e.remote !== undefined) {
    if (e.remote.requiredHeaders.length > 0) {
      return { kind: "needs-secrets", missing: e.remote.requiredHeaders, entry: e, template: remoteTemplate(e) };
    }
    return { kind: "remote", values: { url: e.remote.url }, entry: e };
  }
  return { kind: "not-found" };
}

const stdioTemplate = (e: RegistryEntry): string => {
  const envLines = (e.stdio?.requiredEnv ?? []).map((k) => `${k} = "$ENV:${k}"`).join("\n");
  return [
    "```toml",
    `[mcp.servers.${e.shortName}]`,
    `command = "${e.stdio?.command ?? ""}"`,
    e.stdio !== undefined && e.stdio.args.length > 0 ? `args = [${e.stdio.args.map((a) => `"${a}"`).join(", ")}]` : "",
    envLines !== "" ? `\n[mcp.servers.${e.shortName}.env]\n${envLines}` : "",
    "```",
  ].filter((l) => l !== "").join("\n");
};

const remoteTemplate = (e: RegistryEntry): string => {
  const headerLines = (e.remote?.requiredHeaders ?? []).map((h) => `${h} = "填入你的值"  # 或 $ENV:变量名`).join("\n");
  return ["```toml", `[mcp.servers.${e.shortName}]`, `url = "${e.remote?.url ?? ""}"`, "", `[mcp.servers.${e.shortName}.headers]`, headerLines, "```"].join("\n");
};
