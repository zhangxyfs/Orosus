import { describe, it, expect } from "vitest";
import { providerSlotKey, type Chunk } from "./index.ts";

describe("providerSlotKey", () => {
  it("生成核心保留槽 key", () => {
    expect(providerSlotKey("anthropic")).toBe("provider:anthropic");
  });
});

describe("Chunk 词汇", () => {
  it("finish 带内错误是合法 chunk（不许 reject，§6.4）", () => {
    const err: Chunk = { type: "finish", kind: "error", errorMessage: "boom" };
    expect(err.kind).toBe("error");
  });
});
