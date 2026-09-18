import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { providerSlotKey } from "@orosus/contracts/provider";
import { createListModels, createStream } from "./stream.ts";

const configSchema = z.object({
  // 密钥只经 "$ENV:MOONSHOT_API_KEY" 占位入配置（§6.6；官方文档命名）
  apiKey: z.string(),
  baseUrl: z.string().default("https://api.moonshot.cn/anthropic"),
});

export default defineModule({
  name: "provider-kimi",
  version: "0.1.0",
  description: "月之暗面 Kimi（Kimi for Coding）适配器——Anthropic Messages 协议兼容端点（官方 OpenAPI 明示 Bearer 鉴权）",
  api: 1,
  uses: ["network", "secrets"],
  mounts: ["provide"],
  config: configSchema,
  activate(ctx) {
    // D31 vendor：翻译层拷贝自 provider-anthropic（鉴权双头已覆盖 Bearer-only 事实）；D32 裸名 model = "kimi" 即用
    ctx.provide(providerSlotKey("kimi"), { stream: createStream(ctx.config), defaultModel: "kimi-k3", listModels: createListModels(ctx.config) });
  },
});
