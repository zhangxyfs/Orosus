import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { orosusHome } from "@orosus/contracts/home";
import { dirname, join } from "node:path";
import { BUILTIN_SNAPSHOT } from "./builtin-snapshot.ts";

export interface CatalogModel {
  id: string; name?: string; status?: string;
  modalities?: { input?: string[]; output?: string[] }; // input 供 vision 判定（F5 二轮⑭）
  attachment?: boolean;  // models.dev：支持附件（图片/文件输入）
  limit?: { context?: number; output?: number };
  release_date?: string; // models.dev 元数据：新→旧排序与菜单标签用
  tool_call?: boolean;   // false = 纯生成模型（视频/图像），agent harness 不该给选
}
export interface CatalogEntry {
  name?: string; type?: string; npm?: string; id?: string;
  api?: string; env?: string[];
  models?: Record<string, CatalogModel>;
  sameGate?: string[]; // 同厂异门条目 id 列表（互指——M4-2 T2 选门子菜单数据源）
}
export type Catalog = Record<string, CatalogEntry>;
/** 数据从哪来：online = models.dev 真实目录（含 TTL 缓存命中）；disk = 本地持久缓存（曾成功拉取、当前网络失败）；
 *  builtin = 内置快照兜底（从未成功拉取过的离线首跑）。 */
export type CatalogSource = "online" | "disk" | "builtin";

/** 模型视觉能力查表（F5 二轮⑭——含图消息发送前拦截：不支持图的模型收到 image part 会被端点
 *  400 拒，且坏消息落进会话日志后每一轮都重发 = 会话永久报废，用户实测痛点）。
 *  口径：命中条目 → modalities.input 含 image 或 attachment=true 视为支持；
 *  未命中（自架/自定义提供商模型）→ undefined（不知道，放行但调用方可警示）。
 *  model 形参接受 "<slot>/<model>" 全名或裸模型 id——按 models 记录键/尾段/name 三口径匹配。 */
export function lookupModelVision(catalog: Catalog, model: string): boolean | undefined {
  const bare = model.includes("/") ? model.split("/").pop()! : model;
  for (const entry of Object.values(catalog)) {
    for (const [key, m] of Object.entries(entry.models ?? {})) {
      if (key === model || key === bare || key.endsWith(`/${bare}`) || m.id === model || m.id === bare || m.name === bare) {
        if (m.modalities?.input !== undefined) return m.modalities.input.includes("image");
        if (m.attachment !== undefined) return m.attachment;
        return undefined; // 命中条目但无能力字段——不知道
      }
    }
  }
  return undefined;
}

/** 磁盘缓存直读（发送路径用——不走网络、不走 TTL：读不到 = undefined 放行）。 */
export function readCatalogDiskCache(cacheFile: string): Catalog | undefined {
  try {
    const doc = JSON.parse(readFileSync(cacheFile, "utf8")) as { catalog?: Catalog };
    return doc.catalog;
  } catch {
    return undefined;
  }
}

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 10 * 60 * 1000;
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** 磁盘缓存缺省落点（~/.orosus/cache/models-dev.json）——宿主接线用；测试注入 tmp 路径保密封离。 */
export function defaultCatalogCacheFile(): string {
  return join(orosusHome(), "cache", "models-dev.json");
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

/** 本地文件源喂盘（用户方案）：下载的 api.json 解析成功后持久化——此后「在线目录」离线也有全量数据。
 *  与在线拉取共用盘上信封格式；写失败静默（喂盘是增强，不是前提）。 */
export function persistCatalogCache(catalog: Catalog, cacheFile: string, fetchedAt: number = Date.now()): void {
  writeDiskCache(cacheFile, catalog, fetchedAt);
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

/** 同厂两门检测（M4-2 T2/B1）：id_A.startsWith(id_B + "-") → sameGate 互指（带 "-" 防 zhipu/zhipuai 误连）。
 *  纯函数：条目浅拷贝后标注，入参不被污染。调用点 = 菜单侧 getCatalog 后处理（注入路径无关）。 */
export function detectSameGate(catalog: Catalog): Catalog {
  const result: Catalog = {};
  for (const [k, v] of Object.entries(catalog)) result[k] = { ...v };
  const ids = Object.keys(catalog);
  for (const a of ids) {
    for (const b of ids) {
      if (a !== b && a.startsWith(b + "-")) {
        result[a]!.sameGate = [...(result[a]!.sameGate ?? []), b];
        result[b]!.sameGate = [...(result[b]!.sameGate ?? []), a];
      }
    }
  }
  return result;
}
