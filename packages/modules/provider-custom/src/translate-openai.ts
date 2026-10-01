import { readFileSync } from "node:fs";
import type { Chunk, ContentPart, ModelMessage, ToolSpec } from "@orosus/contracts/provider";

type ImagePart = Extract<ContentPart, { kind: "image" }>;

/** 单个 image part → 线缆部件（openai 形）：image_url data URL（请求期读文件）；文件缺失诚实降级
 *  text 占位（不发坏请求）——user 消息与工具结果图共用同一映射（单源）。 */
function imageToWire(p: ImagePart): Record<string, unknown> {
  try {
    const b64 = readFileSync(p.path).toString("base64");
    return { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${b64}` } };
  } catch {
    return { type: "text", text: `[图片文件缺失：${p.path}]` };
  }
}

/** 含图消息判定与 part 映射（M4-2.5 T5——openai 线缆五处同款）。
 *  纯文本消息保持字符串 join（端点兼容最稳）。 */
function imageAwareContent(parts: ContentPart[]): string | Array<Record<string, unknown>> {
  if (!parts.some((p) => p.kind === "image")) {
    return parts.filter((p) => p.kind === "text" && p.text !== "").map((p) => (p as { text: string }).text).join("");
  }
  return parts.map((p) => (p.kind === "text" ? { type: "text", text: p.text } : imageToWire(p)));
}

/** 工具结果带图三态（m5-media F3/D1；T0 spike 2026-10-01 三形态在 glm-5.3-flash @ coding 网关全 200 实证）：
 *  - inline：tool 消息 content 部件数组（text + image_url）——kimi keep_parts 私有扩展形态，确证支持的端点用；
 *  - bridge（默认）：tool 消息只发文本，图攒起来 flush 成紧跟的 user 消息（opencode lowerToolMessages/flushImages
 *    生产同款）——通用 OpenAI 形态 user 消息 image_url 是标准件；
 *  - placeholder：图不送、文字占位（kimi 通用 openai 端点 convertToolMessageMediaText 做法）。 */
export type ToolImagesMode = "inline" | "bridge" | "placeholder";

/** OpenAI 流式解析状态（每条流一份）：tool_calls 分片按 index 聚合的 callId 映射。 */
export interface OaiStreamState {
  calls: Map<number, { callId: string }>;
}

type ApiMessage = Record<string, unknown>;

/** ModelMessage → OpenAI messages（模块文档决策点 1）。空 system 省略 system 消息；连续 toolResult 不合并
 *  （协议无角色交替约束）。工具结果带图按 toolImages 三态落线缆（m5-media F3——见 ToolImagesMode 注）。 */
export function toOpenAIMessages(system: string, messages: ModelMessage[], toolImages: ToolImagesMode = "bridge"): ApiMessage[] {
  const out: ApiMessage[] = [];
  if (system !== "") out.push({ role: "system", content: system });
  // bridge 攒图区（opencode flushImages 形态）：连续 toolResult 的图聚成**一条**紧跟的 user 消息——
  // 图与其所属 tool 段的顺序关系不变，消息数最少；非工具消息到达或序列结束时冲刷。
  let pendingImages: Record<string, unknown>[] = [];
  const flushImages = (): void => {
    if (pendingImages.length === 0) return;
    out.push({ role: "user", content: pendingImages });
    pendingImages = [];
  };
  for (const m of messages) {
    if (m.role === "toolResult") {
      const images = (m.parts ?? []).filter((p): p is ImagePart => p.kind === "image");
      if (images.length === 0) {
        out.push({ role: "tool", tool_call_id: m.callId, content: m.output });
        continue;
      }
      if (toolImages === "inline") {
        const parts: Record<string, unknown>[] = m.output !== "" ? [{ type: "text", text: m.output }] : [];
        for (const p of images) parts.push(imageToWire(p));
        out.push({ role: "tool", tool_call_id: m.callId, content: parts });
      } else if (toolImages === "placeholder") {
        const notes = images.map((p) => `[图片 ${p.path} 未随请求发送——本端点工具消息不支持图片]`).join("\n");
        out.push({ role: "tool", tool_call_id: m.callId, content: m.output === "" ? notes : `${m.output}\n${notes}` });
      } else {
        for (const p of images) pendingImages.push(imageToWire(p)); // 缺失文件的降级占位也进 flush 消息（诚实可见）
        out.push({ role: "tool", tool_call_id: m.callId, content: m.output });
      }
      continue;
    }
    flushImages(); // 非工具消息前冲刷——bridge 消息必须紧跟其所属的 tool 消息段
    const content = imageAwareContent(m.content);
    const msg: ApiMessage = { role: m.role, ...(content !== "" ? { content } : {}) };
    if (m.role === "assistant" && m.toolCalls) {
      msg.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.callId,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }));
    }
    out.push(msg);
  }
  flushImages(); // 尾段 tool 结果的图也要发
  return out;
}

/** ToolSpec（JSON Schema 原样）→ OpenAI function 工具数组。 */
export function toOpenAITools(tools: ToolSpec[]): ApiMessage[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** 单个 SSE data 块（已 JSON.parse）→ Chunk[]（模块文档决策点 2–3）。
 *  usage 两种方言都接：OpenAI 官方空 choices 尾包（include_usage），以及 GLM/DeepSeek 与最后一个
 *  finish 帧同帧到达（不带 stream_options 也发）——只认空 choices 会把后者整帧丢掉，/usage 恒 0。 */
export function mapSseChunk(state: OaiStreamState, obj: Record<string, unknown>): Chunk[] {
  // MP-03：网关/兼容端点在已 200 的 SSE 流里推错误帧（data: {"error":{…}}——qwen-code 所称 gateway
  // error frame，既无 status 也无 socket code）。此前落入「无 choices 无 usage 返 []」被静默吞，流结束
  // 兜底 stop 把截断回复冒充完整。error 对象在场即带内错误终局；error:null 方言（include_usage 中间帧）不受扰。
  if (typeof obj.error === "object" && obj.error !== null) {
    const e = obj.error as { message?: unknown; code?: unknown; type?: unknown };
    const msg = typeof e.message === "string" && e.message !== "" ? e.message
      : typeof e.code === "string" || typeof e.code === "number" ? `code ${String(e.code)}`
        : typeof e.type === "string" && e.type !== "" ? e.type
          : "网关错误帧";
    return [{ type: "finish", kind: "error", errorMessage: `流错误：${msg}` }];
  }
  const usage = obj.usage as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
  const choices = obj.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  if (choice === undefined) {
    return usage ? [{ type: "usage", input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }] : [];
  }
  const delta = (choice.delta ?? {}) as Record<string, unknown>;
  const chunks: Chunk[] = [];

  if (typeof delta.content === "string" && delta.content !== "") {
    chunks.push({ type: "text/delta", text: delta.content });
  }
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
    chunks.push({ type: "reasoning/delta", text: delta.reasoning_content }); // DeepSeek/GLM 方言
  }
  const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
  if (toolCalls !== undefined) {
    for (const tc of toolCalls) {
      const fn = (tc.function ?? {}) as { name?: string; arguments?: string };
      const entry = state.calls.get(tc.index as number);
      if (entry === undefined && typeof tc.id === "string") {
        // 首片宣告（id+name）；同片 arguments 并入宣告（不丢载荷——执行期定案）
        state.calls.set(tc.index as number, { callId: tc.id });
        chunks.push({ type: "toolcall/argumentsDelta", callId: tc.id, name: fn.name ?? "", argumentsDelta: fn.arguments ?? "" });
      } else if (entry !== undefined && typeof fn.arguments === "string" && fn.arguments !== "") {
        chunks.push({ type: "toolcall/argumentsDelta", callId: entry.callId, name: "", argumentsDelta: fn.arguments });
      }
    }
  }
  const finish = choice.finish_reason as string | null | undefined;
  if (finish !== undefined && finish !== null) {
    chunks.push(
      finish === "length" ? { type: "finish", kind: "length" }
        : finish === "tool_calls" ? { type: "finish", kind: "toolUse" }
        : finish === "stop" ? { type: "finish", kind: "stop" }
        : { type: "finish", kind: "error", errorMessage: `finish_reason: ${finish}` }, // content_filter 及未知：带内错误不静默
    );
  }
  if (usage) chunks.push({ type: "usage", input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 });
  return chunks;
}
