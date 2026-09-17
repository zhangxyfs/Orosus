import { BUILTIN_SNAPSHOT } from "./builtin-snapshot.ts";

export interface CatalogModel { id: string; name?: string; status?: string; modalities?: { output?: string[] } }
export interface CatalogEntry {
  name?: string; type?: string; npm?: string; id?: string;
  api?: string; env?: string[];
  models?: Record<string, CatalogModel>;
}
export type Catalog = Record<string, CatalogEntry>;

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 10 * 60 * 1000;
export const UPSTREAM_TIMEOUT_MS = 10_000;

let cache: { catalog: Catalog; at: number } | undefined;

/** 目录拉取（D34）：10s 超时、10min 缓存、payload 形状校验（非对象拒收）、失败回退内置快照（离线可导入）。 */
export async function getCatalog(opts: { registryUrl?: string; fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<Catalog> {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  if (cache !== undefined && now() - cache.at < CACHE_TTL_MS) return cache.catalog;
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
    cache = { catalog: payload as Catalog, at: now() };
    return cache.catalog;
  } catch {
    if (cache !== undefined) return cache.catalog;
    cache = { catalog: BUILTIN_SNAPSHOT as unknown as Catalog, at: now() };
    return cache.catalog;
  }
}
