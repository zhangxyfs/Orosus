import { describe, it, expect } from "vitest";
import type { ModuleContext } from "@orosus/contracts/module";
import type { Tool } from "@orosus/contracts/tool";
import type { Fs } from "@orosus/contracts/fs";
import def from "./index.ts";

/** 最小 fake ctx：tool-shell 用到 services.get（消费 fs 能力）+ contribute.tool。 */
function fakeCtx(files: Map<string, string>): { ctx: ModuleContext; tools: Tool[] } {
  const tools: Tool[] = [];
  const fakeFs: Fs = {
    read: (p) => {
      const v = files.get(p);
      return v === undefined ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(v);
    },
    write: (p, c) => (files.set(p, c), Promise.resolve()),
  };
  const ctx = {
    config: undefined,
    configRead: () => Promise.resolve(undefined),
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    services: {
      get: (k: string) => (k === "fs" ? Promise.resolve(fakeFs) : Promise.reject(new Error(`无服务 ${k}`))),
      getOptional: () => Promise.resolve(undefined),
    },
    provide: () => {},
    contribute: {
      tool: (t: Tool) => (tools.push(t), () => {}),
      command: () => () => {},
      promptSection: () => () => {},
    },
    session: { append: () => {} },
    events: { on: () => () => {}, emit: () => Promise.resolve() },
  } as unknown as ModuleContext;
  return { ctx, tools };
}

const run = (tool: Tool, args: unknown) =>
  tool
    .resolveExecution(args)
    .then((exec) =>
      exec.execute({ callId: "c1", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } }),
    );

// 跨平台命令：node -e 在 cmd / sh 下行为一致
const OK_CMD = `node -e "process.stdout.write('ok')"`;
const FAIL_CMD = `node -e "process.stderr.write('boom'); process.exit(3)"`;

describe("tool-shell（能力消费者范例：dependsOn [fs]）", () => {
  it("声明依赖与 uses；bash 成功命令 → output", async () => {
    expect(def.dependsOn).toEqual(["fs"]);
    expect(def.uses).toContain("subprocess");
    const { ctx, tools } = fakeCtx(new Map());
    await def.activate(ctx);
    expect(tools.map((t) => t.name)).toEqual(["tool-shell__bash"]);
    const exec = await tools[0]!.resolveExecution({ command: OK_CMD });
    expect(exec.approvalRule).toBe(`tool-shell__bash(${OK_CMD})`);
    const r = await run(tools[0]!, { command: OK_CMD });
    expect(r.isError).toBe(false);
    expect(r.output).toBe("ok");
  });

  it("退出码非 0 → isError + [退出码 N]，stderr 并入输出", async () => {
    const { ctx, tools } = fakeCtx(new Map());
    await def.activate(ctx);
    const r = await run(tools[0]!, { command: FAIL_CMD });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("[退出码 3]");
    expect(r.output).toContain("boom");
  });

  it("writeOutputTo 经 fs 能力落盘（消费方实证）", async () => {
    const files = new Map<string, string>();
    const { ctx, tools } = fakeCtx(files);
    await def.activate(ctx);
    const r = await run(tools[0]!, { command: OK_CMD, writeOutputTo: "out.txt" });
    expect(r.isError).toBe(false);
    expect(files.get("out.txt")).toBe("ok");
  });

  it("matchesRule 迷你 glob：后缀 * 前缀匹配，否则全等", async () => {
    const { ctx, tools } = fakeCtx(new Map());
    await def.activate(ctx);
    const exec = await tools[0]!.resolveExecution({ command: "git status" });
    expect(exec.matchesRule!("git *")).toBe(true);
    expect(exec.matchesRule!("git *")).toBe(true);
    expect(exec.matchesRule!("git status")).toBe(true);
    expect(exec.matchesRule!("git")).toBe(false);
    expect(exec.matchesRule!("rm *")).toBe(false);
  });
});
