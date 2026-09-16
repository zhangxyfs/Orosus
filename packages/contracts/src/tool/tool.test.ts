import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Access, defineTool } from "./index.ts";

describe("Access 工厂", () => {
  it("fsRead/fsWrite 带 path；network 带 host", () => {
    expect(Access.fsRead("/a")).toEqual({ kind: "fs.read", path: "/a" });
    expect(Access.fsWrite("/a")).toEqual({ kind: "fs.write", path: "/a" });
    expect(Access.network("api.github.com")).toEqual({ kind: "network", host: "api.github.com" });
    expect(Access.subprocess()).toEqual({ kind: "subprocess" });
    expect(Access.all()).toEqual({ kind: "all" });
  });
});

describe("defineTool", () => {
  it("原样返回工具定义", () => {
    const tool = defineTool({
      name: "tool-x__ping",
      description: "ping",
      parameters: z.object({}),
      resolveExecution: async () => ({
        execute: async () => ({ output: "pong", isError: false }),
      }),
    });
    expect(tool.name).toBe("tool-x__ping");
  });
});
