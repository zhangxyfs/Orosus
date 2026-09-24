import { z } from "zod";
import type { StreamFn } from "@orosus/contracts/provider";
import { createStream as anthropicStream, createListModels as anthropicListModels } from "./stream-anthropic.ts";
import { createStream as openaiStream, createListModels as openaiListModels } from "./stream-openai.ts";
import { defaultCatalogCacheFile, getCatalogWithSource, readCatalogDiskCache, usableCatalogModels, type Catalog, type CatalogSource } from "./catalog.ts";

/** 厂商表 config schema（D33：区内子结构归模块 schema 自由——§6.6 单区制管 section 命名）。 */
export const configSchema = z.object({
  providers: z.record(
    z.string().regex(/^[a-z][a-z0-9-]*$/, "槽名须 kebab-case（成为 provider:<name> 的 <name>）"),
    z.object({
      type: z.enum(["anthropic", "openai"]), // 协议族两值（D31）；新族 = 模块版本演进
      baseUrl: z.string(),                   // 必填——自定义厂商无"官方默认端点"，端点就是定义的一部分
      apiKey: z.string().optional(),         // $ENV: 占位；省略不发鉴权头（本地/内网端点）
      defaultModel: z.string().optional(),   // D32：有值则 model = "<name>" 裸名可用
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

/** 按厂商表构建槽值（type 选协议族 → 对应 vendored glue；D34 目录供给复用同一构建口）。 */
export function createAdapters(
  config: z.infer<typeof configSchema>,
  fetchImpl?: typeof fetch,
  loadCatalog: CatalogLoader = diskFirstCatalogLoader(),
): Map<string, { stream: StreamFn; defaultModel?: string; listModels?: () => Promise<string[]> }> {
  const out = new Map<string, { stream: StreamFn; defaultModel?: string; listModels?: () => Promise<string[]> }>();
  for (const [name, p] of Object.entries(config.providers)) {
    const glue = { apiKey: p.apiKey, baseUrl: p.baseUrl, ...(fetchImpl !== undefined ? { fetchImpl } : {}) };
    const isAnthropic = p.type === "anthropic";
    const live = isAnthropic ? anthropicListModels(glue) : openaiListModels(glue); // 模型发现 T2：端点真实清单（尽力能力）
    out.set(name, {
      stream: isAnthropic ? anthropicStream(glue) : openaiStream(glue),
      listModels: catalogPreferredListModels(name, live, loadCatalog), // 目录优选——策展覆盖口径优先，live 兜底
      ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
    });
  }
  return out;
}
