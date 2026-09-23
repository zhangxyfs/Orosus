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

  // GBK 字节「你好」——cmd 系工具（中文 Windows ANSI 代码页）的输出形态
  const GBK_CMD = `node -e "process.stdout.write(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))"`;
  it.skipIf(process.platform !== "win32")("Windows ANSI 代码页输出回退 GB18030 解码（2026-09-23 走查批图3 乱码前案）", async () => {
    const { ctx, tools } = fakeCtx(new Map());
    await def.activate(ctx);
    const r = await run(tools[0]!, { command: GBK_CMD });
    expect(r.output).toBe("你好"); // 不再是 U+FFFD 问号
    const ok = await run(tools[0]!, { command: OK_CMD });
    expect(ok.output).toBe("ok"); // UTF-8 输出不受影响
  });

  // 混合流（2026-09-23 走查再现实锤）：UTF-8 行（含合法 U+FFFD）+ GBK 行同流——按行各自择优，
  // 整段二选一必坏一边（旧实现计票被合法 U+FFFD 污染）
  const MIX_CMD = `node -e "process.stdout.write(Buffer.concat([Buffer.from('中文 UTF-8 行', 'utf8'), Buffer.from([0xef, 0xbf, 0xbd, 0x0a]), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), Buffer.from([0x0a])]))"`;
  it.skipIf(process.platform !== "win32")("UTF-8/GBK 混合流按行择优——UTF-8 行不毁、GBK 行可读", async () => {
    const { ctx, tools } = fakeCtx(new Map());
    await def.activate(ctx);
    const r = await run(tools[0]!, { command: MIX_CMD });
    expect(r.output).toContain("中文 UTF-8 行"); // UTF-8 行保持
    expect(r.output).toContain("你好"); // GBK 行回退解码
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
