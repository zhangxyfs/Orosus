import { readFileSync } from "node:fs";
import type { Chunk, ContentPart, ModelMessage, ToolSpec } from "@orosus/contracts/provider";

/** 含图消息判定与 part 映射（M4-2.5 T5——openai 线缆五处同款）：image → image_url data URL（请求期读文件），
 *  文件缺失诚实降级 text 占位（不发坏请求）。纯文本消息保持字符串 join（端点兼容最稳）。 */
function imageAwareContent(parts: ContentPart[]): string | Array<Record<string, unknown>> {
  if (!parts.some((p) => p.kind === "image")) {
    return parts.filter((p) => p.kind === "text" && p.text !== "").map((p) => (p as { text: string }).text).join("");
  }
  return parts.map((p) => {
    if (p.kind === "text") return { type: "text", text: p.text };
    try {
      const b64 = readFileSync(p.path).toString("base64");
      return { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${b64}` } };
    } catch {
      return { type: "text", text: `[图片文件缺失：${p.path}]` };
    }
  });
}

/** OpenAI 流式解析状态（每条流一份）：tool_calls 分片按 index 聚合的 callId 映射。 */
export interface OaiStreamState {
  calls: Map<number, { callId: string }>;
}

type ApiMessage = Record<string, unknown>;

/** ModelMessage → OpenAI messages（模块文档决策点 1）。空 system 省略 system 消息；连续 toolResult 不合并（协议无角色交替约束）。 */
export function toOpenAIMessages(system: string, messages: ModelMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  if (system !== "") out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "toolResult") {
      out.push({ role: "tool", tool_call_id: m.callId, content: m.output });
      continue;
    }
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
