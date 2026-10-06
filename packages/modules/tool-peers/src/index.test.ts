import { describe, expect, it } from "vitest";
import mod from "./index.ts";

describe("tool-peers module", () => {
  it("registers with expected identity", () => {
    const def = mod as unknown as { name: string; version: string; api: number };
    expect(def.name).toBe("tool-peers");
    expect(def.api).toBe(1);
  });

  // v2 增补：默认卸载断言（缺省 true 的反向——validate.ts:27）
  it("defaults to disabled", () => {
    const def = mod as unknown as { defaultEnabled?: boolean };
    expect(def.defaultEnabled).toBe(false);
  });

  it("T4 activate registers the three occupancy tools", () => {
    const tools: { name: string }[] = [];
    const ctx = {
      llm: undefined,
      contribute: {
        tool: (t: { name: string }) => { tools.push(t); },
        promptSection: () => {},
        command: () => {},
      },
    };
    (mod as { activate?: (ctx: unknown) => void }).activate?.(ctx);
    expect(tools.map(t => t.name)).toEqual(["tool-peers__peers", "tool-peers__claim", "tool-peers__release"]);
  });
});
