/** provider 中立流式词汇（§6.4）。错误带内编码：失败产出 finish{kind:"error"}，不许 reject。 */
export type Chunk =
  | { type: "text/delta"; text: string }
  | { type: "reasoning/delta"; text: string }
  | { type: "toolcall/argumentsDelta"; callId: string; name?: string; argumentsDelta: string }
  | { type: "usage"; input: number; output: number }
  | { type: "finish"; kind: "stop" | "length" | "toolUse" | "error" | "aborted"; errorMessage?: string };

export type ContentPart = { kind: "text"; text: string };

/** convertToLlm 投影产出的模型消息（日志投影 → 模型消息，§6.1 铁律）。 */
export type ModelMessage =
  | { role: "user"; content: ContentPart[] }
  | { role: "assistant"; content: ContentPart[]; toolCalls?: { callId: string; name: string; args: unknown }[] }
  | { role: "toolResult"; callId: string; output: string; isError: boolean };

/** 发给 provider 的工具描述（parameters 为 JSON Schema）。 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

/** Provider SPI 唯一方法（§6.4）。 */
export type StreamFn = (request: ProviderRequest) => AsyncIterable<Chunk>;

/** 核心保留槽 key（§7.2）：provider 适配器经 provide(providerSlotKey(name), fn) 注册。 */
export function providerSlotKey(name: string): string {
  return `provider:${name}`;
}
