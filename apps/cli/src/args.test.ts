import { describe, it, expect } from "vitest";
import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
  it("多次 --enable-module/--disable-module 累积；布尔 flag；--model", () => {
    expect(
      parseArgs([
        "--enable-module", "a", "--enable-module", "b",
        "--disable-module", "c",
        "--model", "anthropic/claude-sonnet-4-5",
      ]),
    ).toEqual({ enable: ["a", "b"], disable: ["c"], module: [], noModules: false, dumpModules: false, model: "anthropic/claude-sonnet-4-5" });
    expect(parseArgs(["--no-modules", "--module", "tool-fs", "--dump-modules"])).toEqual({
      enable: [], disable: [], module: ["tool-fs"], noModules: true, dumpModules: true, model: undefined,
    });
  });

  it("未知 flag / 缺值 → 抛出带用法的错误", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/用法/);
    expect(() => parseArgs(["--model"])).toThrow(/用法/);
  });
});
