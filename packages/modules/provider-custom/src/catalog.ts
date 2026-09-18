import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_SNAPSHOT } from "./builtin-snapshot.ts";

export interface CatalogModel { id: string; name?: string; status?: string; modalities?: { output?: string[] }; limit?: { context?: number; output?: number } }
export interface CatalogEntry {
  name?: string; type?: string; npm?: string; id?: string;
  api?: string; env?: string[];
  models?: Record<string, CatalogModel>;
}
export type Catalog = Record<string, CatalogEntry>;
/** 数据从哪来：online = models.dev 真实目录（含 TTL 缓存命中）；disk = 本地持久缓存（曾成功拉取、当前网络失败）；
 *  builtin = 内置快照兜底（从未成功拉取过的离线首跑）。 */
export type CatalogSource = "online" | "disk" | "builtin";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 10 * 60 * 1000;
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** 磁盘缓存缺省落点（~/.orosus/cache/models-dev.json）——宿主接线用；测试注入 tmp 路径保密封离。 */
export function defaultCatalogCacheFile(): string {
  return join(homedir(), ".orosus", "cache", "models-dev.json");
}

interface CacheState { catalog: Catalog; at: number; source: CatalogSource; fetchedAt?: number }

let cache: CacheState | undefined;

/** 测试专用：清模块级缓存（模拟进程重启后的冷启动——磁盘持久化的跨进程场景）。 */
export function resetCatalogCacheForTest(): void {
  cache = undefined;
}

/** 盘上信封：{ fetchedAt, catalog }。坏 JSON/坏形状 → undefined（忽略不炸）。 */
function readDiskCache(path: string): { catalog: Catalog; fetchedAt: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { fetchedAt?: unknown; catalog?: unknown };
    if (typeof parsed.fetchedAt !== "number" || typeof parsed.catalog !== "object" || parsed.catalog === null || Array.isArray(parsed.catalog)) {
      return undefined;
    }
    return { catalog: parsed.catalog as Catalog, fetchedAt: parsed.fetchedAt };
  } catch {
    return undefined;
  }
}

function writeDiskCache(path: string, catalog: Catalog, fetchedAt: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fetchedAt, catalog }), "utf8");
  } catch {
    // 落盘失败（只读文件系统等）不阻断目录使用——本次会话仍有内存数据
  }
}

/** 目录拉取（D34 + 用户方案持久化）：10s 超时、10min 内存 TTL、payload 形状校验（非对象拒收）。
 *  供给链：内存 TTL → 网络（成功落盘）→ 失败供旧内存（stale-while-error）→ 磁盘缓存（曾拉取过的全量数据）→ 内置快照。
 *  builtin 兜底不落盘——盘上只存真实拉取数据，不让 7 家快照冒充本地缓存掩盖降级。 */
export async function getCatalogWithSource(opts: { registryUrl?: string; fetchImpl?: typeof fetch; now?: () => number; cacheFile?: string } = {}): Promise<{ catalog: Catalog; source: CatalogSource; fetchedAt?: number }> {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  if (cache !== undefined && now() - cache.at < CACHE_TTL_MS) {
    return { catalog: cache.catalog, source: cache.source, ...(cache.fetchedAt !== undefined ? { fetchedAt: cache.fetchedAt } : {}) };
  }
  const t = now();
  try {
    const res = await doFetch(opts.registryUrl ?? MODELS_DEV_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload: unknown = await res.json();
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("unexpected catalog payload shape"); // 目录数据当不受信输入（五轮审查定案）
    }
    cache = { catalog: payload as Catalog, at: t, source: "online", fetchedAt: t };
    if (opts.cacheFile !== undefined) writeDiskCache(opts.cacheFile, cache.catalog, t);
    return { catalog: cache.catalog, source: "online", fetchedAt: t };
  } catch {
    if (cache !== undefined) {
      return { catalog: cache.catalog, source: cache.source, ...(cache.fetchedAt !== undefined ? { fetchedAt: cache.fetchedAt } : {}) };
    }
    const disk = opts.cacheFile !== undefined ? readDiskCache(opts.cacheFile) : undefined;
    if (disk !== undefined) {
      cache = { catalog: disk.catalog, at: t, source: "disk", fetchedAt: disk.fetchedAt };
      return { catalog: disk.catalog, source: "disk", fetchedAt: disk.fetchedAt };
    }
    cache = { catalog: BUILTIN_SNAPSHOT as unknown as Catalog, at: t, source: "builtin" };
    return { catalog: cache.catalog, source: "builtin" };
  }
}

/** 兼容面：只取目录（来源无关的调用方沿用）。 */
export async function getCatalog(opts: { registryUrl?: string; fetchImpl?: typeof fetch; now?: () => number; cacheFile?: string } = {}): Promise<Catalog> {
  return (await getCatalogWithSource(opts)).catalog;
}
