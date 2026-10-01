import { readFileSync } from "node:fs";
import type { Chunk, ContentPart, ModelMessage } from "@orosus/contracts/provider";

/** 跨事件的可变解析状态（每条流一份）。 */
export interface SseState {
  inputTokens: number;
  currentCall: { callId: string } | null;
  pendingStop: string | null;
}

/** 解析一个 SSE 块（"event: x\ndata: y"）；无 data → null（注释/心跳忽略）。行分隔容忍 CRLF（MP-06——块内 \r 不残留在 data 值里）。 */
export function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
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

/** /effort 档位 → anthropic 面 thinking 线缆参数（MP-02 修复后口径）：
 *  官方 Messages API 约束——thinking.type="enabled" 时 budget_tokens 必填（≥1024）且 max_tokens 必须
 *  大于 budget_tokens，裸 {type:"enabled"} 即 400 invalid_request_error。因此 enabled 恒钉预算：
 *  "off"/"none" = 关档（thinking disabled——语义档与 offEffort 值两形都收）；low/medium/high = 开思考并钉
 *  budget_tokens（1024/4096/32000，kimi-code budgetTokensForEffort 原值）；"on" 与其余档名（max/xhigh/
 *  minimal…）对齐 kimi-code 'on' 档钉 32000（思考开 + 端点档深未知 → 取高档安全预算，不再裸 enabled）。
 *  max_tokens > budget 由 stream-anthropic 构造点保证（预算 + 8192 输出余量）。大小写不敏感。 */
export function thinkingParamFor(effort: string): { type: "enabled"; budget_tokens: number } | { type: "disabled" } {
  const e = effort.toLowerCase();
  if (e === "off" || e === "none") return { type: "disabled" };
  if (e === "low") return { type: "enabled", budget_tokens: 1024 };
  if (e === "medium") return { type: "enabled", budget_tokens: 4096 };
  return { type: "enabled", budget_tokens: 32_000 }; // high / on / 未知档（MP-02：官方必填约束——enabled 不裸发）
}

/** MP-03：流内 error 事件（官方 SSE 终局事件——过载/限流时服务端发出后关流，message_stop 不到达）→ 带内
 *  错误终局。此前落 default 返 [] 被静默吞，半截回复经 loop 缺省 stop 冒充完整答复。 */
function errorFinishChunks(err: unknown): Chunk[] {
  const e = err as { type?: unknown; message?: unknown } | null | undefined;
  const t = typeof e?.type === "string" && e.type !== "" ? e.type : "error";
  const m = typeof e?.message === "string" && e.message !== "" ? e.message : "服务端流内错误";
  return [{ type: "finish", kind: "error", errorMessage: `${t}：${m}` }];
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
    case "error":
      return errorFinishChunks(data?.error);
    default:
      if (data?.type === "error") return errorFinishChunks(data?.error); // 无 event: 行的方言（parseSseBlock 默认 message）
      return []; // ping 等忽略
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type ApiBlock = Record<string, unknown>;
interface ApiMessage { role: "user" | "assistant"; content: ApiBlock[] }

type ImagePart = Extract<ContentPart, { kind: "image" }>;

/** image part → base64 source block（请求期读文件；缺失诚实降级 text 占位——不发坏请求）。
 *  user 消息与 tool_result 图块共用同一映射（m5-media F3 单源——kimi anthropic/lower.ts 同构）。 */
function imageBlockOrPlaceholder(p: ImagePart): ApiBlock {
  try {
    return { type: "image", source: { type: "base64", media_type: p.mimeType, data: readFileSync(p.path).toString("base64") } };
  } catch {
    return { type: "text", text: `[图片文件缺失：${p.path}]` };
  }
}

/** ModelMessage → Anthropic messages。连续 toolResult 合并进同一条 user 消息（API 要求角色交替）。
 *  工具结果带图（m5-media F3）：tool_result.content 从纯文本升级为 content blocks（text + image
 *  base64 source——Anthropic 形态原生支持，kimi lower.ts:104-122 同构）；无 parts 时保持字符串（零差异）。 */
export function toAnthropicMessages(messages: ModelMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const m of messages) {
    if (m.role === "toolResult") {
      const images = (m.parts ?? []).filter((p): p is ImagePart => p.kind === "image");
      let content: string | ApiBlock[] = m.output;
      if (images.length > 0) {
        const blocks: ApiBlock[] = m.output !== "" ? [{ type: "text", text: m.output }] : [];
        for (const p of images) blocks.push(imageBlockOrPlaceholder(p));
        content = blocks;
      }
      const block: ApiBlock = { type: "tool_result", tool_use_id: m.callId, content, is_error: m.isError };
      const last = out[out.length - 1];
      if (last && last.role === "user" && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    // 空 text block 会被 Anthropic API 拒绝（纯工具调用 turn 会物化 text 为 "" 的 assistant/message）——在此过滤
    // M4-2.5 T5：image part → base64 source block（imageBlockOrPlaceholder 单源）
    const content: ApiBlock[] = m.content.flatMap((p): ApiBlock[] => {
      if (p.kind === "text") return p.text !== "" ? [{ type: "text", text: p.text }] : [];
      return [imageBlockOrPlaceholder(p)];
    });
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) content.push({ type: "tool_use", id: tc.callId, name: tc.name, input: tc.args });
    }
    out.push({ role: m.role, content });
  }
  return out;
}
