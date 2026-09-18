import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { providerSlotKey } from "@orosus/contracts/provider";
import { createListModels, createStream } from "./stream.ts";

const configSchema = z.object({
  // 密钥只经 "$ENV:ANTHROPIC_API_KEY" 占位入配置（§6.6）；占位未解析时原样传入，调用期 401 带内报错
  apiKey: z.string(),
  baseUrl: z.string().default("https://api.anthropic.com"),
});

export default defineModule({
  name: "provider-anthropic",
  version: "0.1.0",
  description: "Anthropic Messages API 适配器（fetch + 手写 SSE，无 SDK）",
  api: 1,
  uses: ["network", "secrets"],
  config: configSchema,
  activate(ctx) {
    // D32 槽值形状：带 defaultModel 的对象（裸名 model = "anthropic" 即用默认模型）
    ctx.provide(providerSlotKey("anthropic"), { stream: createStream(ctx.config), defaultModel: "claude-sonnet-4-5", listModels: createListModels(ctx.config) });
  },
});
