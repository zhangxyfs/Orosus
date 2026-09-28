import { describe, it, expect } from "vitest";
import { parseModel } from "./resolve.ts";

describe("parseModel（D32：裸 provider 名）", () => {
  it("两段照旧；裸名 → model undefined", () => {
    expect(parseModel("anthropic/claude-sonnet-4-5")).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(parseModel("glm")).toEqual({ provider: "glm", model: undefined });
  });

  it("空 provider / 空 model 段仍抛错", () => {
    expect(() => parseModel("/x")).toThrow(/provider/);
    expect(() => parseModel("anthropic/")).toThrow(/provider/);
  });

  it("CL-06：空白垫层 trim——\" glm\" 类前缀不再带白进槽名（旧实现原样透传，槽名比对永误——「不可见」错误）", () => {
    expect(parseModel(" glm ")).toEqual({ provider: "glm", model: undefined });
    expect(parseModel("\tglm/ claude \n")).toEqual({ provider: "glm", model: "claude" });
  });

  it("CL-06：trim 后空段仍抛（\" /x\"、\"x/ \" 不漏网；纯空白裸名照抛）", () => {
    expect(() => parseModel(" /x")).toThrow(/provider/);
    expect(() => parseModel("x/ ")).toThrow(/provider/);
    expect(() => parseModel("   ")).toThrow(/provider/);
  });
});
