import { BUILTIN_SNAPSHOT } from "./builtin-snapshot.ts";

export interface CatalogModel { id: string; name?: string; status?: string; modalities?: { output?: string[] }; limit?: { context?: number; output?: number } }
export interface CatalogEntry {
  name?: string; type?: string; npm?: string; id?: string;
  api?: string; env?: string[];
  models?: Record<string, CatalogModel>;
}
export type Catalog = Record<string, CatalogEntry>;
/** 数据从哪来：online = models.dev 真实目录（含 TTL 缓存命中）；builtin = 内置快照兜底（拉取失败的降级态）。 */
export type CatalogSource = "online" | "builtin";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 10 * 60 * 1000;
export const UPSTREAM_TIMEOUT_MS = 10_000;

let cache: { catalog: Catalog; at: number; source: CatalogSource } | undefined;

/** 目录拉取（D34）：10s 超时、10min 缓存、payload 形状校验（非对象拒收）、失败回退内置快照（离线可导入）。
 *  source 供宿主展示降级态（走查修复：静默回退 7 家快照让用户以为目录被改小）。 */
export async function getCatalogWithSource(opts: { registryUrl?: string; fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<{ catalog: Catalog; source: CatalogSource }> {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  if (cache !== undefined && now() - cache.at < CACHE_TTL_MS) return { catalog: cache.catalog, source: cache.source };
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
    cache = { catalog: payload as Catalog, at: now(), source: "online" };
    return { catalog: cache.catalog, source: "online" };
  } catch {
    if (cache !== undefined) return { catalog: cache.catalog, source: cache.source };
    cache = { catalog: BUILTIN_SNAPSHOT as unknown as Catalog, at: now(), source: "builtin" };
    return { catalog: cache.catalog, source: "builtin" };
  }
}

/** 兼容面：只取目录（来源无关的调用方沿用）。 */
export async function getCatalog(opts: { registryUrl?: string; fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<Catalog> {
  return (await getCatalogWithSource(opts)).catalog;
}
