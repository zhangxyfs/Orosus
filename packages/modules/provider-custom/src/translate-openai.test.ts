import { describe, it, expect } from "vitest";
import { mapSseChunk, type OaiStreamState } from "./translate-openai.ts";

const state = (): OaiStreamState => ({ calls: new Map() });

describe("mapSseChunk usage 提取（/usage 走查：GLM 方言 usage 与 finish 同帧，此前被丢）", () => {
  it("① GLM/DeepSeek 方言：最后一帧 choices(finish) + usage 同帧 → usage 不丢、追加在 finish 之后", () => {
    const out = mapSseChunk(state(), {
      choices: [{ finish_reason: "stop", delta: {} }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    });
    expect(out).toEqual([
      { type: "finish", kind: "stop" },
      { type: "usage", input: 12, output: 34 },
    ]);
  });

  it("② OpenAI 官方方言：空 choices 尾包 usage → 仅 usage chunk（回归）", () => {
    expect(mapSseChunk(state(), { choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } }))
      .toEqual([{ type: "usage", input: 3, output: 5 }]);
  });

  it("③ include_usage 中间帧 usage:null + 正常 choices → 不产 usage chunk、正文不受扰", () => {
    const out = mapSseChunk(state(), {
      choices: [{ delta: { content: "hi" } }],
      usage: null,
    });
    expect(out).toEqual([{ type: "text/delta", text: "hi" }]);
  });

  it("④ 正文与 usage 同帧：text/delta 在前、usage 收尾", () => {
    const out = mapSseChunk(state(), {
      choices: [{ delta: { content: "答" }, finish_reason: null }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    expect(out).toEqual([
      { type: "text/delta", text: "答" },
      { type: "usage", input: 1, output: 2 },
    ]);
  });
});
