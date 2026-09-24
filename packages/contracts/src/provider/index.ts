/** provider 中立流式词汇（§6.4）。错误带内编码：失败产出 finish{kind:"error"}，不许 reject。
 *  errorCode 是适配器归一化的可编程错误码（M3 补强 D43，首枚 "context_limit" 上下文超限）——
 *  只承载 loop/模块可编程消费的类别，不追求覆盖全部 API 错误（鉴权/限流等继续走 errorMessage 文本）。 */
export type Chunk =
  | { type: "text/delta"; text: string }
  | { type: "reasoning/delta"; text: string }
  | { type: "toolcall/argumentsDelta"; callId: string; name?: string; argumentsDelta: string }
  /** 服务端搜索活动（M4-3 T1b）：适配器把协议层原生搜索块（Anthropic web_search_tool_result /
   *  OpenAI 系 web_search 字段·web_search_call 事件）归一上报——llm 搜索后端的「真搜过」判据（Reasonix
   *  web_search_call completed 校验同款思想）。只在请求带 webSearch 时出现；loop 与渲染面默认忽略。 */
  | { type: "server-search"; hits: { title: string; url: string }[] }
  | { type: "usage"; input: number; output: number }
  | { type: "finish"; kind: "stop" | "length" | "toolUse" | "error" | "aborted"; errorMessage?: string; errorCode?: string };

/** 消费 stream 的标准形态（错误带内，不许 reject——§6.4）：
 *
 * @example
 * ```ts
 * for await (const c of stream(req)) {
 *   if (c.type === "text/delta") text += c.text;
 *   if (c.type === "finish") {
 *     if (c.kind === "error") throw new Error(c.errorMessage);   // 消费侧此刻才升级为异常
 *     break;
 *   }
 * }
 * ```
 */

/** 内容块（M4-2.5 T5 扩 image 引用形态）：text 直存；image 只存路径——日志不吃 base64 4/3 膨胀，
 *  请求期由 provider 翻译层读文件转 base64（pi 两段式同款）；文件缺失诚实降级为文本占位。 */
export type ContentPart =
  | { kind: "text"; text: string }
  | { kind: "image"; path: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };

/** 用户消息出处标记（v3 compaction 设计空白 1，kimi 式元数据）：用户直敲的消息不带 origin；
 *  steering 注入带 kind + 来源模块（sourceModule === "host" = 宿主 busy 期插队话）；压缩摘要消息带
 *  compaction-summary。只在内部流转——provider 适配器拼线缆消息只取 role/content/toolCalls，不发给模型厂商。 */
export type MessageOrigin =
  | { kind: "steering"; sourceModule: string }
  | { kind: "compaction-summary" };

/** convertToLlm 投影产出的模型消息（日志投影 → 模型消息，§6.1 铁律）。 */
export type ModelMessage =
  | { role: "user"; content: ContentPart[]; origin?: MessageOrigin }
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
  /** 输出 token 上限（M3 补强 D39 修订）：缺省 = 适配器现行为（openai 线缆不发送、anthropic 线缆用 MAX_TOKENS）。 */
  maxTokens?: number;
  /** 声明服务端原生搜索（M4-3 T1b，SW-17）：适配器按协议映射为服务端搜索声明（openai 族 =
   *  tools 追加 {type:"web_search",web_search:{enable:true}}〔2026-09-24 zhipu 端点 spike 实钉的接受形态〕；
   *  anthropic 族 = web_search_20250305 server tool）。与 tools 的客户端工具正交——二级调用（D39）tools 恒空，
   *  服务端声明不进会话、模型不可见。 */
  webSearch?: boolean;
}

/** Provider SPI 唯一方法（§6.4）。 */
export type StreamFn = (request: ProviderRequest) => AsyncIterable<Chunk>;

/** 上下文超限分类器（M3 补强 D43，Chunk 词汇属主随行的共享纯函数——模块间无共享代码，contracts 是唯一合法公共位）。
 *  以响应全文判定（截断只属于 errorMessage 文案），大小写不敏感；status 限 400/413。
 *  命中清单集中在函数内常量数组，单元测试锚定——误报最坏后果是 loop 多重试一次（有界无害）。 */
const CONTEXT_LIMIT_PATTERNS = [
  "prompt is too long",      // Anthropic
  "prompt_too_long",         // Anthropic error.type
  "context_length_exceeded", // OpenAI 系 code
  "maximum context length",  // OpenAI/Kimi/DeepSeek message
  "prompt tokens exceed",    // GLM
  "input length exceeds",    // 兼容端点
  "request too large",       // 兼容端点/网关 413
] as const;

export function classifyContextLimit(status: number, body: string): boolean {
  if (status !== 400 && status !== 413) return false;
  const lower = body.toLowerCase();
  return CONTEXT_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

/** Provider 适配器槽值（D32；模型发现修订）：裸函数或带默认模型/模型清单能力的对象——核心按形状归一化。 */
export type ProviderAdapter =
  | StreamFn
  | { stream: StreamFn; defaultModel?: string; listModels?: () => Promise<string[]> };

/** 模型 id 白名单（模型发现 T1）：端点是不可信数据源——白名单外字符/超限（>128）的 id 丢弃（dsh 密钥格式校验同思路）。 */
const MODEL_ID_OK = /^[A-Za-z0-9._:/-]{1,128}$/;

/** 解析 GET /models 响应（openai 族 {baseUrl}/models 与 anthropic 族 {baseUrl}/v1/models 同为 `{data:[{id},…]}` 形）。
 *  sanitize（白名单+限长，三轮 P2②）→ 去重 → 排序（菜单稳定序）；非数组 / 全被滤空 → throw（调用方 catch 回退）。 */
export function parseModelsResponse(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("models 响应形状不符（缺 data 数组）");
  const ids = Array.from(new Set(
    data
      .map((m) => (m as { id?: unknown } | null)?.id)
      .filter((id): id is string => typeof id === "string" && MODEL_ID_OK.test(id)),
  )).sort((a, b) => b.localeCompare(a)); // 倒序（走查缺陷②）：版本号大的（新模型）排前——glm-5.3 在 glm-4.7 前
  if (ids.length === 0) throw new Error("models 响应无合法 id");
  return ids;
}

/** 核心保留槽 key（§7.2）：provider 适配器经 provide(providerSlotKey(name), fn) 注册。 */
export function providerSlotKey(name: string): string {
  return `provider:${name}`;
}
