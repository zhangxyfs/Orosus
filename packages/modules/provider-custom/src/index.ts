import { defineModule } from "@orosus/contracts/module";
import { providerSlotKey } from "@orosus/contracts/provider";
import { configSchema, createAdapters } from "./adapters.ts";
import { defaultMenuDeps } from "./cli-deps.ts";
import { runProviderMenu } from "./menu.ts";

export default defineModule({
  name: "provider-custom",
  version: "0.1.0",
  description: "自定义厂商适配器——配置声明任意多家（Anthropic/OpenAI 两协议族模板），零代码接入",
  api: 1,
  uses: ["network", "secrets"],
  mounts: ["provide", "contribute:command"], // 多次 provide + /provider 菜单命令（D37/D38）
  config: configSchema,
  activate(ctx) {
    for (const [name, adapter] of createAdapters(ctx.config)) {
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
