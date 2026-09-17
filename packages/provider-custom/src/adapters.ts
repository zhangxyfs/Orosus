import { z } from "zod";
import type { StreamFn } from "@orosus/contracts/provider";
import { createStream as anthropicStream } from "./stream-anthropic.ts";
import { createStream as openaiStream } from "./stream-openai.ts";

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
  ),
});

export type CustomProviderEntry = z.infer<typeof configSchema>["providers"][string];

/** 按厂商表构建槽值（type 选协议族 → 对应 vendored glue；D34 目录供给复用同一构建口）。 */
export function createAdapters(
  config: z.infer<typeof configSchema>,
  fetchImpl?: typeof fetch,
): Map<string, { stream: StreamFn; defaultModel?: string }> {
  const out = new Map<string, { stream: StreamFn; defaultModel?: string }>();
  for (const [name, p] of Object.entries(config.providers)) {
    const glue = { apiKey: p.apiKey, baseUrl: p.baseUrl, ...(fetchImpl !== undefined ? { fetchImpl } : {}) };
    const stream = p.type === "anthropic" ? anthropicStream(glue) : openaiStream(glue);
    out.set(name, { stream, ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}) });
  }
  return out;
}
