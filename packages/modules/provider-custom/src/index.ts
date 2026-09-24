import { defineModule } from "@orosus/contracts/module";
import { providerSlotKey } from "@orosus/contracts/provider";
import type { CapabilityKey } from "@orosus/contracts/module";
import { configSchema, createAdapters, type SearchFaceFacts } from "./adapters.ts";
import { defaultMenuDeps } from "./cli-deps.ts";
import { runProviderMenu } from "./menu.ts";

/** 双边服务 key（tool-web 挂载、本模块消费——模块自有能力按内核规则 1 带 `tool-web.` 前缀，
 *  非 contracts 公共短名故不经主体登记；键与形状登记于 design-decisions 2026-09-24 服务倒挂条目）。 */
const WEBSEARCH_ENDPOINTS = "tool-web.search-faces" as CapabilityKey<SearchFaceFacts>;

export default defineModule({
  name: "provider-custom",
  version: "0.1.0",
  description: "自定义厂商适配器——配置声明任意多家（Anthropic/OpenAI 两协议族模板），零代码接入",
  api: 1,
  uses: ["network", "secrets"],
  mounts: ["provide", "contribute:command"], // 多次 provide + /provider 菜单命令（D37/D38）
  config: configSchema,
  activate(ctx) {
    // 搜索改道服务（服务倒挂，2026-09-24）：端点知识归 tool-web，本模块只做路由。惰性解析——
    // 激活期 committedServices 未必已含该 key（tool-web 激活序可能更晚），首用（首个 webSearch 请求，
    // 只可能来自 tool-web）时取并缓存；缺席 = chat 面原行为，日志一行留痕。reload 后旧实例闭包若被
    // 误触，get 抛 stale 也被 catch 回落，无副作用。
    let factsCache: Promise<SearchFaceFacts | undefined> | undefined;
    const facts = (): Promise<SearchFaceFacts | undefined> => {
      factsCache ??= ctx.services
        .getOptional<SearchFaceFacts>(WEBSEARCH_ENDPOINTS)
        .then((f) => {
          ctx.log.info("provider-custom.searchface", f === undefined ? "搜索改道服务缺席——webSearch 请求走 chat 面" : "搜索改道服务在（tool-web.search-faces）");
          return f;
        })
        .catch(() => undefined);
      return factsCache;
    };
    for (const [name, adapter] of createAdapters(ctx.config, undefined, undefined, facts)) {
      ctx.provide(providerSlotKey(name), adapter);
    }
    // /provider（内建别名，D38）：多级菜单（D37 中文规格）——副作用经宿主侧默认接线（config/secrets 真实读写）
    ctx.contribute.command("provider-custom__provider", (_args, ui) => runProviderMenu(ui, defaultMenuDeps()));
  },
});

// CLI（配置写器）与宿主复用的目录供给公开面——经根出口再导出，保持单出口纪律
export { getCatalog, getCatalogWithSource, defaultCatalogCacheFile, persistCatalogCache, resetCatalogCacheForTest, lookupModelVision, readCatalogDiskCache, type Catalog, type CatalogEntry, type CatalogModel, type CatalogSource } from "./catalog.ts";
export { resolveWire, adaptBaseUrl } from "./infer.ts";
export { runProviderMenu, type MenuUi, type MenuDeps, type ProviderEntry } from "./menu.ts";
export { defaultMenuDeps } from "./cli-deps.ts";
// M4-3 T1d 引导弹窗消费面：裁剪快照视图（SW-21）+ 按 provider 实拉模型清单的组合件（SW-24——引导期槽未激活，
// 用裸条目直组「目录优选 + live 兜底」，与槽内 listModels 同口径）
export { BUILTIN_SNAPSHOT, snapshotProviderView, type SnapshotProviderView } from "./builtin-snapshot.ts";
export { catalogPreferredListModels, diskFirstCatalogLoader, type CatalogLoader } from "./adapters.ts";
export { createListModels as openaiListModels } from "./stream-openai.ts";
export { createListModels as anthropicListModels } from "./stream-anthropic.ts";
export { usableCatalogModels } from "./catalog.ts";
