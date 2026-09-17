import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleContext } from "@orosus/contracts/module";
import type { Tool } from "@orosus/contracts/tool";
import type { Fs } from "@orosus/contracts/fs";
import def from "./index.ts";

/** 最小 fake ctx：只实现 tool-fs 用到的口（provide + contribute.tool）。 */
function fakeCtx(): { ctx: ModuleContext; services: Map<string, unknown>; tools: Tool[] } {
  const services = new Map<string, unknown>();
  const tools: Tool[] = [];
  const ctx = {
    config: undefined,
    configRead: () => Promise.resolve(undefined),
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    services: {
      get: () => Promise.reject(new Error("no services")),
      getOptional: () => Promise.resolve(undefined),
    },
    provide: (k: string, impl: unknown) => void services.set(k, impl),
    contribute: {
      tool: (t: Tool) => { tools.push(t); return () => {}; },
      command: () => () => {},
      promptSection: () => () => {},
    },
    session: { append: () => {} },
    events: { on: () => () => {}, emit: () => Promise.resolve() },
  } as unknown as ModuleContext;
  return { ctx, services, tools };
}

let dir: string;
let savedCwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orosus-toolfs-"));
  savedCwd = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(savedCwd);
  rmSync(dir, { recursive: true, force: true });
});

const run = async (tool: Tool, args: unknown) => {
  const exec = await tool.resolveExecution(args);
  return exec.execute({ callId: "c1", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
};

describe("tool-fs（规则 1 提供者 + 规则 5 同路径实证）", () => {
  it("提供 fs 服务与三个工具；read/write/edit 全链路", async () => {
    const { ctx, services, tools } = fakeCtx();
    await def.activate(ctx);
    expect(services.has("fs")).toBe(true);
    expect(tools.map((t) => t.name)).toEqual(["tool-fs__read", "tool-fs__write", "tool-fs__edit", "tool-fs__glob", "tool-fs__grep"]); // T16 起五件
    const [read, write, edit] = tools as [Tool, Tool, Tool];
    expect((await run(write, { path: "a.txt", content: "hello world" })).isError).toBe(false);
    expect((await run(read, { path: "a.txt" })).output).toBe("hello world");
    expect((await run(edit, { path: "a.txt", oldText: "world", newText: "orosus" })).isError).toBe(false);
    expect((await run(read, { path: "a.txt" })).output).toBe("hello orosus");
    const fs = services.get("fs") as Fs;
    expect(await fs.read("a.txt")).toBe("hello orosus");
  });

  it("read 不存在的文件 → 带内 isError", async () => {
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const r = await run(tools[0]!, { path: "ghost.txt" });
    expect(r.isError).toBe(true);
  });

  it("edit：oldText 未找到或多处匹配 → isError", async () => {
    writeFileSync(join(dir, "b.txt"), "aa aa");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    expect((await run(tools[2]!, { path: "b.txt", oldText: "zz", newText: "x" })).isError).toBe(true);
    expect((await run(tools[2]!, { path: "b.txt", oldText: "aa", newText: "x" })).isError).toBe(true); // 多处匹配
  });

  it("路径越出根目录 → isError（安全沙箱边界）", async () => {
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const r = await run(tools[0]!, { path: "../../../../etc/passwd" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("越出");
  });
});

describe("glob/grep（T16，§12 M2）", () => {
  it("① tool-fs__glob：**/*.ts 模式匹配（Node 22 原生 fs.glob）", async () => {
    writeFileSync(join(dir, "a.ts"), "x");
    writeFileSync(join(dir, "b.js"), "x");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const r = await run(tools.find((t) => t.name === "tool-fs__glob")!, { pattern: "**/*.ts" });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("a.ts");
    expect(r.output).not.toContain("b.js");
  });

  it("② tool-fs__grep：内容正则搜索，输出 path:line:text", async () => {
    writeFileSync(join(dir, "g1.ts"), "line1\nTARGET here\nline3\n");
    writeFileSync(join(dir, "g2.ts"), "nope\n");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const r = await run(tools.find((t) => t.name === "tool-fs__grep")!, { pattern: "TARGET" });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("g1.ts:2:TARGET here");
    expect(r.output).not.toContain("g2.ts");
  });

  it("③ accesses 声明 fs.read + 沙箱边界（越出 → isError，同 read）", async () => {
    writeFileSync(join(dir, "in.txt"), "x");
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    const glob = tools.find((t) => t.name === "tool-fs__glob")!;
    const exec = await glob.resolveExecution({ pattern: "**/*.ts" });
    expect(exec.accesses).toEqual([{ kind: "fs.read", path: "**/*.ts" }]); // fs.read 声明（路径以 pattern 近似——M1 同款口径）
    const r = await run(glob, { pattern: "../../etc/**/*.conf" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("越出");
  });
});
