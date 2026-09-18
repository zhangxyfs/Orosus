import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { providerSlotKey } from "@orosus/contracts/provider";
import { createListModels, createStream } from "./stream.ts";

const configSchema = z.object({
  // 密钥只经 "$ENV:DEEPSEEK_API_KEY" 占位入配置（§6.6；官方 env 示例命名）
  apiKey: z.string(),
  baseUrl: z.string().default("https://api.deepseek.com/v1"), // 官方两种皆可，取与族 glue 拼接习惯一致的 /v1 形态（模块文档决策点 4）
});

export default defineModule({
  name: "provider-deepseek",
  version: "0.1.0",
  description: "DeepSeek 官方 API 适配器——OpenAI Chat Completions 协议（deepseek-chat / deepseek-reasoner）",
  api: 1,
  uses: ["network", "secrets"],
  mounts: ["provide"],
  config: configSchema,
  activate(ctx) {
    // D31 vendor：翻译层拷贝自 provider-openai（reasoning_content 已在模板内）；裸名 model = "deepseek" 即用
    ctx.provide(providerSlotKey("deepseek"), { stream: createStream(ctx.config), defaultModel: "deepseek-chat", listModels: createListModels(ctx.config) });
  },
});
