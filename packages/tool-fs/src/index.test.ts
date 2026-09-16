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
    expect(tools.map((t) => t.name)).toEqual(["tool-fs__read", "tool-fs__write", "tool-fs__edit"]);
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
