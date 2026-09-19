import { readFileSync } from "node:fs";
import type { Chunk, ModelMessage } from "@orosus/contracts/provider";

/** 跨事件的可变解析状态（每条流一份）。 */
export interface SseState {
  inputTokens: number;
  currentCall: { callId: string } | null;
  pendingStop: string | null;
}

/** 解析一个 SSE 块（"event: x\ndata: y"）；无 data → null（注释/心跳忽略）。 */
export function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  return dataLines.length === 0 ? null : { event, data: dataLines.join("\n") };
}

export function mapStopReason(reason: string | null): "stop" | "length" | "toolUse" {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "toolUse";
  return "stop"; // end_turn / null / 未知
}

/* eslint-disable @typescript-eslint/no-explicit-any -- 线缆格式按运行时形状窄化 */
export function mapEvent(state: SseState, event: string, raw: unknown): Chunk[] {
  const data = raw as any;
  switch (event) {
    case "message_start":
      state.inputTokens = data?.message?.usage?.input_tokens ?? 0;
      return [];
    case "content_block_start":
      if (data?.content_block?.type === "tool_use") {
        state.currentCall = { callId: String(data.content_block.id) };
        return [{
          type: "toolcall/argumentsDelta",
          callId: state.currentCall.callId,
          name: String(data.content_block.name),
          argumentsDelta: "",
        }];
      }
      return [];
    case "content_block_delta": {
      const delta = data?.delta;
      if (delta?.type === "text_delta") return [{ type: "text/delta", text: String(delta.text) }];
      if (delta?.type === "thinking_delta") return [{ type: "reasoning/delta", text: String(delta.thinking) }];
      if (delta?.type === "input_json_delta" && state.currentCall) {
        return [{ type: "toolcall/argumentsDelta", callId: state.currentCall.callId, argumentsDelta: String(delta.partial_json) }];
      }
      return [];
    }
    case "content_block_stop":
      state.currentCall = null;
      return [];
    case "message_delta":
      state.pendingStop = data?.delta?.stop_reason ?? state.pendingStop;
      return [{ type: "usage", input: state.inputTokens, output: data?.usage?.output_tokens ?? 0 }];
    case "message_stop":
      return [{ type: "finish", kind: mapStopReason(state.pendingStop) }];
    default:
      return []; // ping 等忽略
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type ApiBlock = Record<string, unknown>;
interface ApiMessage { role: "user" | "assistant"; content: ApiBlock[] }

/** ModelMessage → Anthropic messages。连续 toolResult 合并进同一条 user 消息（API 要求角色交替）。 */
export function toAnthropicMessages(messages: ModelMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const m of messages) {
    if (m.role === "toolResult") {
      const block: ApiBlock = { type: "tool_result", tool_use_id: m.callId, content: m.output, is_error: m.isError };
      const last = out[out.length - 1];
      if (last && last.role === "user" && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    // 空 text block 会被 Anthropic API 拒绝（纯工具调用 turn 会物化 text 为 "" 的 assistant/message）——在此过滤
    // M4-2.5 T5：image part → base64 source block（请求期读文件；缺失诚实降级 text 占位——不发坏请求）
    const content: ApiBlock[] = m.content.flatMap((p): ApiBlock[] => {
      if (p.kind === "text") return p.text !== "" ? [{ type: "text", text: p.text }] : [];
      try {
        return [{ type: "image", source: { type: "base64", media_type: p.mimeType, data: readFileSync(p.path).toString("base64") } }];
      } catch {
        return [{ type: "text", text: `[图片文件缺失：${p.path}]` }];
      }
    });
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) content.push({ type: "tool_use", id: tc.callId, name: tc.name, input: tc.args });
    }
    out.push({ role: m.role, content });
  }
  return out;
}
