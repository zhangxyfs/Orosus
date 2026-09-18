import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { providerSlotKey } from "@orosus/contracts/provider";
import { createListModels, createStream } from "./stream.ts";

const configSchema = z.object({
  apiKey: z.string().optional(),   // 本地端点（Ollama/vLLM）无鉴权——缺省不发鉴权头（模块文档决策点 5）
  baseUrl: z.string().default("https://api.openai.com/v1"),
});

export default defineModule({
  name: "provider-openai",
  version: "0.1.0",
  description: "OpenAI Chat Completions 协议通用适配器（官方 + 全部兼容端点：DeepSeek/Ollama/vLLM/…）",
  api: 1,
  uses: ["network", "secrets"],
  mounts: ["provide"],
  config: configSchema,
  activate(ctx) {
    // 纯 StreamFn 槽值（无 defaultModel）——通用适配器背不动默认模型（模块文档决策点 6）
    ctx.provide(providerSlotKey("openai"), { stream: createStream(ctx.config), listModels: createListModels(ctx.config) });
  },
});
