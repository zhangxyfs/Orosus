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

  // CL-04 回归钉（2026-09-28 code review）：--fork 死旗标移除——解析出的 args.fork 全仓零消费
  //（main.ts 只透传 extra.fork = 交互 /fork 指令路径，启动旗标从未接线 createHarness）。移除后走
  // default 分支按未知参数响亮报错——不再静默吞掉「--fork 启动分叉」的意图（此前解析成功但不生效）。
  it("CL-04：--fork 已移除（死旗标）——按未知参数报错，不再静默解析成功", () => {
    expect(() => parseArgs(["--fork"])).toThrow(/未知参数/);
    expect(() => parseArgs(["--fork", "s_1"])).toThrow(/未知参数/);
    expect(() => parseArgs(["--fork", "s_1:e_9"])).toThrow(/未知参数/);
  });
});
