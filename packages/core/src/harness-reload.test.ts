import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
});
