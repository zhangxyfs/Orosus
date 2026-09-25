import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore, type Harness } from "./index.ts";
import { fakeModule, fakeProviderModule } from "@orosus/testing";
import type { Chunk, ProviderRequest, StreamFn } from "@orosus/contracts/provider";
import { defineTool } from "@orosus/contracts/tool";
import type { ModuleDefinition } from "@orosus/contracts/module";

let dir: string;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const hermetic = (d: string) => ({ userFile: join(d, "no-user.toml"), projectFile: join(d, "no-proj.toml"), env: {} });
const script: Chunk[][] = [[{ type: "text/delta", text: "x" }, { type: "finish", kind: "stop" }]];

const boot = async (extra: { modules?: ModuleDefinition[]; commandUi?: Harness extends never ? never : never } = {} as never) => {
  dir = mkdtempSync(join(tmpdir(), "orosus-reload-"));
  dirs.push(dir);
  const h = await createHarness({
    store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
    modules: [fakeProviderModule("fake", script), ...(extra.modules ?? [])],
    config: { ...hermetic(dir), cliOverrides: { model: "fake/m" } },
  });
  return h;
};

const tool = (name: string) =>
  defineTool({ name, description: name, parameters: z.object({}), resolveExecution: async () => ({ execute: async () => ({ output: `out:${name}`, isError: false }) }) });

describe("harness.reload 与 /reload（§5.5/T15）", () => {
  it("① reload 空闲时立即执行、报告 Unchanged 全量（def 引用不变的 builtin/inline）", async () => {
    const extra = fakeModule("m", { activate() {} });
    const h = await boot({ modules: [extra] });
    const report = await h.reload();
    expect(report.unchanged).toContain("provider-fake");
    expect(report.unchanged).toContain("m");
    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
    await h.close();
  });

  it("② turn 进行中 reload 排队至 turn 边界（gate 释放后完成；cancel 中止同样触发边界）", async () => {
    // 挂起流的 provider：直到 gate 打开才产出 finish
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const hanging: StreamFn = async function* (_req: ProviderRequest): AsyncIterable<Chunk> {
      await gate;
      yield { type: "finish", kind: "stop" };
    };
    const hangingProvider = fakeModule("provider-hang", { activate(ctx) { ctx.provide("provider:hang", hanging); } });
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir = mkdtempSync(join(tmpdir(), "orosus-reload-")), spillDir: join(dir, "spill"),
      modules: [hangingProvider],
      config: { ...hermetic(dir), cliOverrides: { model: "hang/h-1" } },
    });
    dirs.push(dir);
    const turnP = h.prompt("hi"); // 占坑（进行中）
    let settled = false;
    const reloadP = h.reload().then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // turn 未到边界，reload 排队
    release();
    await turnP;
    const report = await reloadP;
    expect(report.unchanged).toContain("provider-hang");
    await h.close();
  });

  it("③ 会话连续性：被换下模块的工具调用 → 带内 isError 文案（§5.5 专用，soft 墓碑）", async () => {
    const v1 = fakeModule("swapped", { mounts: ["contribute:tool"], activate(ctx) { ctx.contribute.tool(tool("swapped__t")); } });
    const h = await boot({ modules: [v1] });
    // 模拟"换下"：reload 时模块消失（inline modules 列表变化——同一 harness 无法变列表；用 registry 直测墓碑语义）
    const names = h.graph().tools.namesByOwner("swapped");
    expect(names).toEqual(["swapped__t"]);
    for (const n of names) h.graph().tools.tombstone(n);
    const res = await h.graph().tools.run({ id: "c1", name: "swapped__t", args: {} }, { signal: new AbortController().signal });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("已在 reload 中变更");
    expect(h.graph().tools.specs().map((t) => t.name)).toContain("swapped__t"); // 字节稳定：specs 仍含名
    await h.close();
  });

  it("④ /reload 经命令路由触发（内建命令表，D38）", async () => {
    const h = await boot({});
    const out = await h.prompt("/reload");
    expect(out).toContain("unchanged");
    await h.close();
  });

  it("⑤ 卸载半圈：enabled 翻 false → reload → removed 含该模块、工具出清单、调用带内被拒、audit 态 discovered", async () => {
    const extra = fakeModule("m", { mounts: ["contribute:tool"], activate(ctx) { ctx.contribute.tool(tool("m__t")); } });
    const h = await boot({ modules: [extra] });
    expect(h.graph().tools.specs().map((t) => t.name)).toContain("m__t"); // 前置：启动时在
    writeFileSync(join(dir, "no-user.toml"), "[m]\nenabled = false\n");
    const report = await h.reload();
    expect(report.removed).toContain("m"); // 修复口径：diff 两侧按启停过滤后 removed 才含翻转模块
    expect(h.graph().tools.specs().map((t) => t.name)).not.toContain("m__t");
    const res = await h.graph().tools.run({ id: "c1", name: "m__t", args: {} }, { signal: new AbortController().signal });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("未知工具");
    expect(h.graph().audit().find((a) => a.name === "m")?.state).toBe("discovered"); // 禁用 ≠ 降级（§5.4）
    await h.close();
  });

  it("⑥ 重挂半圈：接⑤再翻 true → reload → added 含该模块、failed 空、工具恢复可执行", async () => {
    const extra = fakeModule("m", { mounts: ["contribute:tool"], activate(ctx) { ctx.contribute.tool(tool("m__t")); } });
    const h = await boot({ modules: [extra] });
    writeFileSync(join(dir, "no-user.toml"), "[m]\nenabled = false\n");
    const first = await h.reload();
    expect(first.removed).toContain("m");
    writeFileSync(join(dir, "no-user.toml"), "[m]\nenabled = true\n");
    const second = await h.reload();
    expect(second.added).toContain("m");
    expect(second.failed).toEqual([]); // 干净重挂：不撞旧实例同名（假挂载修复的核心断言）
    const res = await h.graph().tools.run({ id: "c2", name: "m__t", args: {} }, { signal: new AbortController().signal });
    expect(res.isError).toBe(false);
    expect(res.output).toBe("out:m__t");
    await h.close();
  });

  it("⑦ 启动即停用的模块运行期挂载（回归钉：现状即好，修完不许变坏）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-reload-"));
    dirs.push(dir);
    writeFileSync(join(dir, "no-user.toml"), "[m]\nenabled = false\n");
    const extra = fakeModule("m", { mounts: ["contribute:tool"], activate(ctx) { ctx.contribute.tool(tool("m__t")); } });
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
      modules: [fakeProviderModule("fake", script), extra],
      config: { ...hermetic(dir), cliOverrides: { model: "fake/m" } },
    });
    expect(h.graph().audit().find((a) => a.name === "m")?.state).toBe("discovered"); // 启动即停用
    writeFileSync(join(dir, "no-user.toml"), "");
    const report = await h.reload();
    expect(report.added).toContain("m");
    expect(report.failed).toEqual([]);
    const res = await h.graph().tools.run({ id: "c3", name: "m__t", args: {} }, { signal: new AbortController().signal });
    expect(res.isError).toBe(false);
    expect(res.output).toBe("out:m__t");
    await h.close();
  });
});
