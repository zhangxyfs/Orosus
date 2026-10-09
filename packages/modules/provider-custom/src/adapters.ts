import { z } from "zod";
import type { StreamFn } from "@orosus/contracts/provider";
import { createStream as anthropicStream, createListModels as anthropicListModels } from "./stream-anthropic.ts";
import { createStream as openaiStream, createListModels as openaiListModels } from "./stream-openai.ts";
import { defaultCatalogCacheFile, getCatalogWithSource, lookupModelThinking, readCatalogDiskCache, usableCatalogModels, type Catalog, type CatalogSource } from "./catalog.ts";

/** 媒体策略服务（tool-media.policy，m5-media F9 服务倒挂）的消费侧形状——本地结构声明（模块互不 import；
 *  键与形状双边契约，登记在 tool-media/src/index.ts MEDIA_POLICY_KEY）。 */
export interface MediaPolicyFace { current(): { maxEdge: number; tokenTier: number; singleCapBytes: number; budgetBytes: number; safeBytes: number; maxImages: number; visionModel: string } }

/** 搜索改道服务（tool-web.search-faces）的消费侧形状——tool-web 所有并挂载，此处按结构类型本地声明
 *  （模块互不 import；key 与形状为双边契约，登记于 design-decisions 2026-09-24 服务倒挂条目）。 */
export interface SearchFaceFacts {
  match(baseUrl: string): { anthropicRoot: string } | undefined;
}

/** 厂商表 config schema（D33：区内子结构归模块 schema 自由——§6.6 单区制管 section 命名）。 */
export const configSchema = z.object({
  providers: z.record(
    z.string().regex(/^[a-z][a-z0-9-]*$/, "槽名须 kebab-case（成为 provider:<name> 的 <name>）"),
    z.object({
      type: z.enum(["anthropic", "openai"]), // 协议族两值（D31）；新族 = 模块版本演进
      baseUrl: z.string(),                   // 必填——自定义厂商无"官方默认端点"，端点就是定义的一部分
      apiKey: z.string().optional(),         // $ENV: 占位；省略不发鉴权头（本地/内网端点）
      defaultModel: z.string().optional(),   // D32：有值则 model = "<name>" 裸名可用
      // 2026-10-09 用户拍板③：条目级默认上下文窗口——私有端点/网关自定义模型不在 models-dev 目录时的
      // 配置面兜底；解析优先级 = 顶层显式 contextWindow > 本键 > 目录兜底（core load.ts 同链）。
      // 模块本体不消费（窗口是 harness/显示/压缩阈值口径）——登记在这里只为配置形状入册不漂移。
      contextWindow: z.number().int().positive().optional(),
      // m5-media F3/D1：openai 族工具结果带图三态（bridge=桥接 user 消息默认——opencode 生产同款、
      // T0 spike 2026-10-01 实证；inline=kimi keep_parts 私有扩展形态，确证端点用；placeholder=图不送文字占位）。
      // anthropic 族原生 tool_result 图块，本键无效。
      toolImages: z.enum(["inline", "bridge", "placeholder"]).default("bridge"),
      // m5-media F6：端点认的图片 mime（缺省四白名单全收——png/jpeg/webp/gif 在两协议族都是标准件；
      // 端点确不认某格式时收紧，不认的格式换文字标签不发送）
      acceptedImageMimes: z.array(z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"])).optional(),
    }),
  ).default({}), // 空表合法（模块文档 §2）——section 整体缺失（全新安装）也激活零槽，/provider 配置入口在任何配置状态下可用
});

export type CustomProviderEntry = z.infer<typeof configSchema>["providers"][string];

/** 目录加载面（测试注入密封；缺省 = diskFirstCatalogLoader）。 */
export type CatalogLoader = () => Promise<{ catalog: Catalog; source: CatalogSource }>;

/** 槽值清单的目录装载（2026-09-22 用户拍板）：盘上缓存优先——models-dev.json 下载过就直接读（毫秒级），
 *  不为 /model 列表每次走在线拉取（内存 TTL 过期后网络 fetch 长达数秒，busy spinner 空转——用户实测）。
 *  盘上无缓存才走完整供给链（网络 → 落盘 → builtin）；新鲜度由 /provider 菜单的在线链路负责刷新。 */
export function diskFirstCatalogLoader(cacheFile: string = defaultCatalogCacheFile()): CatalogLoader {
  return async () => {
    const disk = readCatalogDiskCache(cacheFile);
    if (disk !== undefined) return { catalog: disk, source: "disk" };
    return getCatalogWithSource({ cacheFile });
  };
}

/** 槽内清单的目录优选（2026-09-22 /model 清单修复，与 onboarding「目录池优先」同口径——menu.ts）：
 *  全量目录（online/disk）含本槽条目且有可用模型 → 策展清单即覆盖口径（coding-plan 条目只含套餐内模型；
 *  live /models 会把按量模型一并列出，选了就 1113——用户实测）。builtin 裁剪快照 / 条目缺失 /
 *  可用模型滤空 / 目录加载失败 → 回 live 清单（原行为）。匹配键 = 槽名即目录条目 id（目录导入的安装方式天然满足）。
 *  M4-3 T1d 导出：引导期（槽未激活）按裸条目直组同口径清单（SW-24）。 */
export function catalogPreferredListModels(slot: string, live: () => Promise<string[]>, loadCatalog: CatalogLoader): () => Promise<string[]> {
  return async () => {
    try {
      const { catalog, source } = await loadCatalog();
      if (source !== "builtin") {
        const ids = usableCatalogModels(catalog[slot] ?? {}).map((m) => m.id);
        if (ids.length > 0) return ids;
      }
    } catch { /* 目录不可用 → live 兜底 */ }
    return live();
  };
}

/** 按厂商表构建槽值（type 选协议族 → 对应 vendored glue；D34 目录供给复用同一构建口）。
 *  facts = 搜索改道服务（tool-web.search-faces）的惰性解析口（index.ts 注入 ctx.services 消费闭包）；
 *  缺省无服务 = 表外/服务缺席一律 chat 面原行为。 */
export function createAdapters(
  config: z.input<typeof configSchema>, // 输入形态（toolImages 可缺省——.default 在 parse 后才有值；宿主 ctx.config 是已 parse 的输出型，结构兼容可直传）
  fetchImpl?: typeof fetch,
  loadCatalog: CatalogLoader = diskFirstCatalogLoader(),
  facts?: () => Promise<SearchFaceFacts | undefined>,
  policy?: () => Promise<MediaPolicyFace | undefined>, // m5-media F9：媒体策略惰性解析（index.ts 注入，缺席 = 内置默认同值）
): Map<string, { stream: StreamFn; defaultModel?: string; listModels?: () => Promise<string[]>; listThinking?: (model: string) => Promise<{ efforts: string[]; offEffort?: string; hasToggle: boolean } | undefined> }> {
  const out = new Map<string, { stream: StreamFn; defaultModel?: string; listModels?: () => Promise<string[]>; listThinking?: (model: string) => Promise<{ efforts: string[]; offEffort?: string; hasToggle: boolean } | undefined> }>();
  for (const [name, p] of Object.entries(config.providers ?? {})) { // z.input 形态：providers 可缺省（宿主已 parse 的输出型恒有值）
    const glue = { apiKey: p.apiKey, baseUrl: p.baseUrl, ...(fetchImpl !== undefined ? { fetchImpl } : {}) };
    const isAnthropic = p.type === "anthropic";
    const live = isAnthropic ? anthropicListModels(glue) : openaiListModels(glue); // 模型发现 T2：端点真实清单（尽力能力）
    // m5-media F9：媒体策略快照盒——tool-media.policy 惰性解析一次（激活序无关），此后请求期同步读。
    // 策略缺席/解析失败 = undefined → 流内 mediaOpts 空 → 全走内置默认（与策略默认同值，行为零差）。
    let policySnap: import("./stream-openai.ts").MediaRuntimeOpts | undefined;
    const mediaOpts = policy === undefined ? undefined : (): import("./stream-openai.ts").MediaRuntimeOpts | undefined => policySnap;
    const mediaOf = mediaOpts === undefined ? {} : { mediaOpts };
    let stream = isAnthropic ? anthropicStream({ ...glue, ...(p.acceptedImageMimes !== undefined ? { acceptedImageMimes: p.acceptedImageMimes } : {}), ...mediaOf }) : openaiStream({ ...glue, toolImages: p.toolImages ?? "bridge", ...(p.acceptedImageMimes !== undefined ? { acceptedImageMimes: p.acceptedImageMimes } : {}), ...mediaOf }); // m5-media F3/F6/F9：openai 三态 + 两族 mime 白名单 + 策略服务
    if (policy !== undefined) {
      const base = stream;
      stream = (request) => (async function* () { // 首请求前确保策略快照就绪（memo promise——此后零开销）
        try {
          const face = await policy();
          if (face !== undefined) {
            const f = face.current();
            policySnap = { maxEdge: f.maxEdge, tokenTier: f.tokenTier, budgetBytes: f.budgetBytes, safeBytes: f.safeBytes, singleCapBytes: f.singleCapBytes, maxImages: f.maxImages };
          }
        } catch { /* 服务缺席/坏形状——默认值 */ }
        yield* base(request);
      })();
    }
    // 已知可搜端点改道（2026-09-24 用户拍板对齐 Reasonix）：openai 档槽的 webSearch 请求（tool-web 搜索
    // 辅助调用）命中改道服务 → 改发 {anthropicRoot}/v1/messages（同 key 双头），chat 请求零变化；
    // anthropic 档槽天然走 web_search_20250305 无需服务。路由 = 本模块行为，端点知识 = tool-web 服务
    // （服务倒挂——消费在调用时刻惰性解析，激活序先后无关；webSearch 请求只可能来自 tool-web，
    // 服务缺席时本分支根本不会到达请求）。Reasonix 对应机制 = 搜索路由 kind=anthropic + BaseURL 改写
    // （independent_web_search.go:59-65）。模型名经 spike 验证可直透。
    if (!isAnthropic && facts !== undefined) {
      const chatStream = stream;
      const factsOf = facts;
      stream = (request) => {
        if (request.webSearch !== true) return chatStream(request);
        return (async function* () {
          const face = (await factsOf().catch(() => undefined))?.match(p.baseUrl);
          if (face === undefined) {
            yield* chatStream(request);
            return;
          }
          yield* anthropicStream({ ...glue, baseUrl: face.anthropicRoot })(request);
        })();
      };
    }
    out.set(name, {
      stream,
      listModels: catalogPreferredListModels(name, live, loadCatalog), // 目录优选——策展覆盖口径优先，live 兜底
      listThinking: async (model: string): Promise<{ efforts: string[]; offEffort?: string; hasToggle: boolean } | undefined> => { // /effort 数据源：目录三级匹配（catalog.ts），读不到/不认识 → undefined（核心走 lenient 指引）
        try {
          const { catalog } = await loadCatalog();
          return lookupModelThinking(catalog, name, model, p.baseUrl);
        } catch {
          return undefined;
        }
      },
      ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
    });
  }
  return out;
}
