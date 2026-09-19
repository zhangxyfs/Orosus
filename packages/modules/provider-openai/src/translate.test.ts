import { describe, it, expect } from "vitest";
import { toOpenAIMessages, toOpenAITools, mapSseChunk, type OaiStreamState } from "./translate.ts";
import type { ModelMessage } from "@orosus/contracts/provider";

const state = (): OaiStreamState => ({ calls: new Map() });

describe("请求构造（模块文档决策点 1）", () => {
  it("三角色全组合：text 拼接 / toolCalls→tool_calls / toolResult→role:tool（不合并）/ system 前置", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: [{ kind: "text", text: "a" }, { kind: "text", text: "b" }] },
      { role: "assistant", content: [{ kind: "text", text: "好的" }], toolCalls: [{ callId: "c1", name: "t__x", args: { p: 1 } }] },
      { role: "toolResult", callId: "c1", output: "r1", isError: false },
      { role: "toolResult", callId: "c2", output: "r2", isError: true },
    ];
    expect(toOpenAIMessages("SYS", msgs)).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "ab" },
      { role: "assistant", content: "好的", tool_calls: [{ id: "c1", type: "function", function: { name: "t__x", arguments: "{\"p\":1}" } }] },
      { role: "tool", tool_call_id: "c1", content: "r1" },
      { role: "tool", tool_call_id: "c2", content: "r2" },
    ]);
  });

  it("空 text 段的 assistant（纯工具 turn）不产出空 content 字符串；空 system 省略 system 消息", () => {
    const msgs: ModelMessage[] = [{ role: "assistant", content: [], toolCalls: [{ callId: "c", name: "n", args: {} }] }];
    expect(toOpenAIMessages("S", msgs)).toHaveLength(2);                 // [system, assistant]
    expect(toOpenAIMessages("S", msgs)[1]!).toMatchObject({ tool_calls: expect.any(Array) });
    expect(toOpenAIMessages("", [{ role: "user", content: [{ kind: "text", text: "hi" }] }])).toHaveLength(1); // 空 system 不发空消息
  });

  it("tools → function 数组（parameters JSON Schema 原样）", () => {
    expect(toOpenAITools([{ name: "t", description: "d", parameters: { type: "object" } }]))
      .toEqual([{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }]);
  });
});

describe("SSE 事件映射（决策点 2）", () => {
  it("delta.content → text/delta；reasoning_content → reasoning/delta", () => {
    const s = state();
    expect(mapSseChunk(s, { choices: [{ delta: { content: "你" } }] })).toEqual([{ type: "text/delta", text: "你" }]);
    expect(mapSseChunk(s, { choices: [{ delta: { reasoning_content: "嗯" } }] })).toEqual([{ type: "reasoning/delta", text: "嗯" }]);
  });

  it("tool_calls 分片按 index 聚合：首片宣告（id+name），后续 arguments 逐片转发", () => {
    const s = state();
    expect(mapSseChunk(s, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "t__x", arguments: "" } }] } }] }))
      .toEqual([{ type: "toolcall/argumentsDelta", callId: "call_1", name: "t__x", argumentsDelta: "" }]);
    expect(mapSseChunk(s, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"p\":" } }] } }] }))
      .toEqual([{ type: "toolcall/argumentsDelta", callId: "call_1", name: "", argumentsDelta: "{\"p\":" }]);
    // 第二个工具交错到达：index 1 宣告不受 index 0 干扰；宣告片吸收同片 arguments（不丢载荷——执行期定案）
    expect(mapSseChunk(s, { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_2", function: { name: "t__y", arguments: "{}" } }] } }] }))
      .toEqual([{ type: "toolcall/argumentsDelta", callId: "call_2", name: "t__y", argumentsDelta: "{}" }]);
  });

  it("usage（stream_options.include_usage 的尾包）→ usage chunk", () => {
    expect(mapSseChunk(state(), { choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } }))
      .toEqual([{ type: "usage", input: 3, output: 5 }]);
  });

  it("GLM/DeepSeek 方言：usage 与 finish 帧同帧 → 不丢、追加在 finish 之后（/usage 走查）", () => {
    expect(mapSseChunk(state(), { choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 34 } }))
      .toEqual([{ type: "finish", kind: "stop" }, { type: "usage", input: 12, output: 34 }]);
  });

  it("include_usage 中间帧 usage:null → 不产 usage chunk", () => {
    expect(mapSseChunk(state(), { choices: [{ delta: { content: "hi" } }], usage: null }))
      .toEqual([{ type: "text/delta", text: "hi" }]);
  });
});

describe("finish_reason 映射（决策点 3）", () => {
  it("stop/length/tool_calls/content_filter 四路", () => {
    const s = state();
    expect(mapSseChunk(s, { choices: [{ delta: {}, finish_reason: "stop" }] })).toEqual([{ type: "finish", kind: "stop" }]);
    expect(mapSseChunk(s, { choices: [{ delta: {}, finish_reason: "length" }] })).toEqual([{ type: "finish", kind: "length" }]);
    expect(mapSseChunk(s, { choices: [{ delta: {}, finish_reason: "tool_calls" }] })).toEqual([{ type: "finish", kind: "toolUse" }]);
    const cf = mapSseChunk(s, { choices: [{ delta: {}, finish_reason: "content_filter" }] })[0]!;
    expect(cf).toMatchObject({ type: "finish", kind: "error" });
  });
});

// M4-2.5 T5：五家内置 provider 同款图片映射钉（openai 线缆）
const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
type MP5 = import("@orosus/contracts/provider").ModelMessage;
describe("toOpenAIMessages 图片映射（M4-2.5 T5 五家同款）", () => {
  it("image part → content 数组 + image_url data URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-t5g-"));
    const p = join(dir, "shot.png");
    writeFileSync(p, Buffer.from([3, 3]));
    const msg: MP5 = { role: "user", content: [{ kind: "image", path: p, mimeType: "image/png" }] };
    const out = toOpenAIMessages("", [msg]) as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    expect(Array.isArray(out[0]!.content)).toBe(true);
    expect(out[0]!.content[0]!.type).toBe("image_url");
    expect(out[0]!.content[0]!.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
