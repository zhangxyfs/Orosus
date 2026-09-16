import { describe, it, expect } from "vitest";
import type { Chunk, ModelMessage } from "@orosus/contracts/provider";
import { mapEvent, mapStopReason, parseSseBlock, toAnthropicMessages, type SseState } from "./translate.ts";

const state = (): SseState => ({ inputTokens: 0, currentCall: null, pendingStop: null });

describe("parseSseBlock", () => {
  it("解析 event+data；多行 data 拼接；空块 → null", () => {
    expect(parseSseBlock("event: message_start\ndata: {\"a\":1}")).toEqual({ event: "message_start", data: "{\"a\":1}" });
    expect(parseSseBlock("data: 第一行\ndata: 第二行")).toEqual({ event: "message", data: "第一行\n第二行" });
    expect(parseSseBlock("")).toBeNull();
    expect(parseSseBlock(": 注释行")).toBeNull();
  });
});

describe("mapEvent（SSE → Chunk）", () => {
  it("text_delta / thinking_delta / tool_use 全序列", () => {
    const s = state();
    const chunks: Chunk[] = [];
    const feed = (event: string, data: unknown) => chunks.push(...mapEvent(s, event, data));
    feed("content_block_start", { type: "content_block_start", content_block: { type: "text" } });
    feed("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "你" } });
    feed("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "好" } });
    feed("content_block_start", { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "tool-fs__read" } });
    feed("content_block_delta", { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"path\":" } });
    feed("content_block_delta", { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "\"a.txt\"}" } });
    feed("content_block_start", { type: "content_block_start", content_block: { type: "thinking" } });
    feed("content_block_delta", { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "嗯" } });
    expect(chunks).toEqual([
      { type: "text/delta", text: "你" },
      { type: "text/delta", text: "好" },
      { type: "toolcall/argumentsDelta", callId: "toolu_1", name: "tool-fs__read", argumentsDelta: "" },
      { type: "toolcall/argumentsDelta", callId: "toolu_1", argumentsDelta: "{\"path\":" },
      { type: "toolcall/argumentsDelta", callId: "toolu_1", argumentsDelta: "\"a.txt\"}" },
      { type: "reasoning/delta", text: "嗯" },
    ]);
  });

  it("message_start/delta/stop → usage + finish；stop_reason 映射", () => {
    const s = state();
    expect(mapEvent(s, "message_start", { message: { usage: { input_tokens: 42 } } })).toEqual([]);
    expect(mapEvent(s, "message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } })).toEqual([
      { type: "usage", input: 42, output: 7 },
    ]);
    expect(mapEvent(s, "message_stop", {})).toEqual([{ type: "finish", kind: "stop" }]);
  });

  it("mapStopReason：end_turn→stop / max_tokens→length / tool_use→toolUse / 未知→stop", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("tool_use")).toBe("toolUse");
    expect(mapStopReason(null)).toBe("stop");
    expect(mapStopReason("refusal")).toBe("stop");
  });
});

describe("toAnthropicMessages（ModelMessage → API 消息）", () => {
  it("assistant 的 toolCalls → tool_use blocks；连续 toolResult 合并进一条 user 消息", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: [{ kind: "text", text: "读文件" }] },
      {
        role: "assistant",
        content: [{ kind: "text", text: "好的" }],
        toolCalls: [{ callId: "c1", name: "tool-fs__read", args: { path: "a" } }],
      },
      { role: "toolResult", callId: "c1", output: "内容", isError: false },
      { role: "toolResult", callId: "c2", output: "拒绝", isError: true },
    ];
    expect(toAnthropicMessages(msgs)).toEqual([
      { role: "user", content: [{ type: "text", text: "读文件" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "好的" },
          { type: "tool_use", id: "c1", name: "tool-fs__read", input: { path: "a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "内容", is_error: false },
          { type: "tool_result", tool_use_id: "c2", content: "拒绝", is_error: true },
        ],
      },
    ]);
  });
});
