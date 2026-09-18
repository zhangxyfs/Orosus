import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { providerSlotKey } from "@orosus/contracts/provider";
import { createListModels, createStream } from "./stream.ts";

const configSchema = z.object({
  // 密钥只经 "$ENV:ZHIPU_API_KEY" 占位入配置（§6.6）
  apiKey: z.string(),
  baseUrl: z.string().default("https://open.bigmodel.cn/api/anthropic"),
});

export default defineModule({
  name: "provider-glm",
  version: "0.1.0",
  description: "智谱 GLM（GLM Coding Plan）适配器——Anthropic Messages 协议兼容端点",
  api: 1,
  uses: ["network", "secrets"],
  mounts: ["provide"],
  config: configSchema,
  activate(ctx) {
    // D31 vendor：翻译层拷贝自 provider-anthropic；D32 槽值带 defaultModel（裸名 model = "glm" 即用）
    ctx.provide(providerSlotKey("glm"), { stream: createStream(ctx.config), defaultModel: "glm-5.3", listModels: createListModels(ctx.config) });
  },
});
