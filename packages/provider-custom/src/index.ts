import { defineModule } from "@orosus/contracts/module";
import { providerSlotKey } from "@orosus/contracts/provider";
import { configSchema, createAdapters } from "./adapters.ts";

export default defineModule({
  name: "provider-custom",
  version: "0.1.0",
  description: "自定义厂商适配器——配置声明任意多家（Anthropic/OpenAI 两协议族模板），零代码接入",
  api: 1,
  uses: ["network", "secrets"],
  mounts: ["provide"], // 多次 provide——每厂商一槽，最小挂点白名单（§5.1）
  config: configSchema,
  activate(ctx) {
    for (const [name, adapter] of createAdapters(ctx.config)) {
      ctx.provide(providerSlotKey(name), adapter);
    }
  },
});
