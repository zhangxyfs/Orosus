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
});
