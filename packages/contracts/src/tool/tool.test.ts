import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
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

describe("Access 路径语义契约（CT-04）", () => {
  it("CT-04 契约钉：fs 形态 path 的语义约定不被静默删改（字面路径/建议绝对/不支持 glob——契约是纯 JSDoc，以源文本锚定）", async () => {
    const src = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    expect(src).toContain("不支持 glob"); // glob/搜索类工具不得把 pattern 当 path 声明
    expect(src).toContain("目录边界前缀比较"); // 调度器按 resolve 后的目录边界判读写冲突
    expect(src).toContain("resolve 到自身"); // 相对路径归一责任在工具侧
  });
});

describe("ToolResult.images 契约钉（m5-media F1）", () => {
  it("路径引用制契约不被静默删改（不存 base64 / mime 四值白名单 / 媒资库落盘归宿）", async () => {
    const src = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    expect(src).toContain("不存 base64"); // 日志与 ModelMessage 永远只见路径
    expect(src).toContain("<sid>/media/"); // 落盘归宿 = 会话媒资库（F8，core 归一化写入）
    expect(src).toContain('export type ToolImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif"'); // mime 白名单四值
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
