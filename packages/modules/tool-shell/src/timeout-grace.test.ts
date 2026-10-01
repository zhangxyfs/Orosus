import { describe, it, expect, afterEach, vi } from "vitest";
import type { ModuleContext } from "@orosus/contracts/module";
import type { Tool } from "@orosus/contracts/tool";
import type { Fs } from "@orosus/contracts/fs";

// 复现 2026-10-01 挂死形态（doc-review 全量 vitest）：杀树只杀掉一部分、漏杀进程持有管道写端
// → close 永不到来。这里把 killTree mock 成空操作（等价于「一个都没杀掉」的极端漏杀），
// child 活满自身寿命 → close 在宽限内到不了 → 验证宽限兜底强制返回，promise 不永挂。
vi.mock("./jobs.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./jobs.ts")>();
  return { ...mod, killTree: vi.fn() };
});

import def from "./index.ts";
import { KILL_GRACE } from "./index.ts";

/** 最小 fake ctx（同 index.test.ts 口径）。 */
function fakeCtx(): { ctx: ModuleContext; tools: Tool[] } {
  const tools: Tool[] = [];
  const fakeFs: Fs = {
    read: () => Promise.reject(new Error("unused")),
    write: () => Promise.resolve(),
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

describe("tool-shell 杀树宽限兜底（2026-10-01 挂死实锤批）", () => {
  afterEach(() => {
    KILL_GRACE.ms = 5_000; // 测试注入位用完复原
  });

  it("① 超时杀树后 close 永不来 → KILL_GRACE 后强制返回，带超时与强制标注（不再永挂）", async () => {
    KILL_GRACE.ms = 300;
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    // killTree 已 mock 为空操作：node 活满 2 秒，close 在宽限（300ms）内到不了
    const r = await run(tools[0]!, { command: `node -e "setTimeout(()=>{},2000)"`, timeoutMs: 150 });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("超时 150ms，已杀进程树");
    expect(r.output).toContain("强制返回");
    expect(r.output).toContain("漏杀残留");
  });

  it("② 宽限期内 close 到来 → 走正常超时收尾，无「强制返回」字样（真实杀树路径由 index.test ⑨ 钉）", async () => {
    KILL_GRACE.ms = 5_000;
    const { ctx, tools } = fakeCtx();
    await def.activate(ctx);
    // killTree mock 下 child 于 600ms 自然退出 → close 在宽限内到达 → 正常超时文案
    const r = await run(tools[0]!, { command: `node -e "setTimeout(()=>{},600)"`, timeoutMs: 150 });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("[超时 150ms，已杀进程树]");
    expect(r.output).not.toContain("强制返回");
  });
});
