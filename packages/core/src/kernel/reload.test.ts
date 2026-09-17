import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineModule, type ModuleDefinition } from "@orosus/contracts/module";
import { defineTool } from "@orosus/contracts/tool";
import { InMemorySessionStore } from "../session/memory.ts";
import { createEventBus } from "./bus.ts";
import { createToolRegistry } from "../tool/registry.ts";
import { resolveSections } from "../config/validate.ts";
import { activateModules, type ActivateOutput } from "./activate.ts";
import { diffGraphs, type GraphDef } from "./reload.ts";
import type { DiagSink } from "../diag/logger.ts";

const sink = (): DiagSink => ({ write: () => {}, flush: () => Promise.resolve(), close: () => Promise.resolve() });
const mod = (name: string, extra: Partial<ModuleDefinition> = {}): ModuleDefinition =>
  defineModule({ name, version: "0.1.0", description: name, api: 1, activate() {}, ...extra });

const gd = (name: string, over: Partial<GraphDef> = {}): GraphDef => ({ def: mod(name), source: "inline", configValue: {}, ...over });

describe("diffGraphs（§5.5 判定规则）", () => {
  it("① Unchanged：def 引用相等 + 配置 deepEqual", () => {
    const a = gd("a");
    const r = diffGraphs([a], [gd("a", { def: a.def })]);
    expect(r.unchanged).toEqual(["a"]);
  });
  it("② Reloaded：配置自有 key 变化", () => {
    const a = gd("a");
    const r = diffGraphs([a], [gd("a", { def: a.def, configValue: { k: 2 } })]);
    expect(r.reloaded).toEqual(["a"]);
  });
  it("③ Reloaded：entryHash 变化（目录模块）", () => {
    const a = gd("a", { entryHash: "h1" });
    const r = diffGraphs([a], [gd("a", { def: a.def, entryHash: "h2" })]);
    expect(r.reloaded).toEqual(["a"]);
  });
  it("④ enabled 变化走 Added/Removed 不走 Reloaded", () => {
    const a = gd("a");
    expect(diffGraphs([a], []).removed).toEqual(["a"]);
    expect(diffGraphs([], [a]).added).toEqual(["a"]);
  });
  it("⑤ 受影响子图判定归 planReload（kernel 内部）——此处验证 diff 不扩散 optional（数据面）", () => {
    const x = gd("x");
    const r = diffGraphs([x], [gd("y"), { def: x.def, source: "inline", configValue: {} }]);
    expect(r.added).toEqual(["y"]);
    expect(r.unchanged).toEqual(["x"]);
  });
});

// ---- activate 级：preserved / generation / stale / tombstone / 复用注册表 ----

const tool = (name: string) =>
  defineTool({ name, description: name, parameters: z.object({}), resolveExecution: async () => ({ execute: async () => ({ output: `out:${name}`, isError: false }) }) });

interface Round {
  out: ActivateOutput;
  activateCount: () => number;
  ctxOf: (name: string) => { services: { get(key: string): Promise<unknown> } } | undefined;
}

async function round(defs: ModuleDefinition[], opts: { preserved?: Parameters<typeof activateModules>[0]["preserved"]; generations?: Map<string, number>; reuse?: { bus: ReturnType<typeof createEventBus>; tools: ReturnType<typeof createToolRegistry> } } = {}): Promise<Round> {
  const s = sink();
  const bus = opts.reuse?.bus ?? createEventBus(s);
  const tools = opts.reuse?.tools ?? createToolRegistry({ bus, sink: s, spillDir: "/tmp/s" });
  let count = 0;
  const ctxs = new Map<string, { services: { get(key: string): Promise<unknown> } }>();
  const wrapped = defs.map((d) => {
    if (opts.preserved?.has(d.name)) return d; // preserved 的 def 不包装——保持引用同一性（Unchanged 判定依据）
    return mod(d.name, {
      ...d,
      activate(ctx) {
        count++;
        ctxs.set(d.name, ctx);
        return d.activate(ctx);
      },
    } as Partial<ModuleDefinition>);
  });
  const sectionResolution = resolveSections(new Map(), wrapped, {});
  const out = await activateModules({
    ordered: wrapped, sectionResolution, session: new InMemorySessionStore(), sink: s, bus, tools,
    ...(opts.preserved !== undefined ? { preserved: opts.preserved } : {}),
    ...(opts.generations !== undefined ? { generations: opts.generations } : {}),
  });
  return { out, activateCount: () => count, ctxOf: (n) => ctxs.get(n) };
}

describe("preserved / 代际 / stale / 墓碑 / 注册表复用", () => {
  it("⑥ reload 后 Unchanged 模块 activate 不重跑、generation 不变", async () => {
    const m1 = mod("m", { provides: ["m.x"], activate(ctx) { ctx.provide("m.x", 1); } });
    const r1 = await round([m1]);
    expect(r1.activateCount()).toBe(1);
    const preserved = r1.out.preservable();
    const m1Again = mod("m", { activate(ctx) { ctx.provide("m.x", 1); } });
    // preserved 携带原 def —— 复用第一轮的 def 对象模拟 Unchanged（引用相等）
    const r2 = await round([preserved.get("m")!.def], { preserved, reuse: { bus: createEventBus(sink()), tools: createToolRegistry({ bus: createEventBus(sink()), sink: sink(), spillDir: "/tmp" }) } });
    void m1Again;
    expect(r2.activateCount()).toBe(0); // 不重跑
    expect(r2.out.records.find((x) => x.name === "m")!.generation).toBe(1); // 不变
    expect(await r2.out.services.get("m.x")).toBe(1); // 句柄沿用
  });

  it("⑦ Reloaded 模块 generation +1（generations 基线传入）", async () => {
    const m = mod("m2", {});
    const r1 = await round([m]);
    const gens = new Map(r1.out.records.map((r) => [r.name, r.generation]));
    const r2 = await round([mod("m2", {})], { generations: gens });
    expect(r2.out.records.find((x) => x.name === "m2")!.generation).toBe(2);
  });

  it("⑧ 事务性：reuse 注册表上 required 失败（loadModules 层）→ 新激活回滚、旧图句柄仍可用", async () => {
    // kernel 层模拟：第一轮建图；第二轮共用 bus/tools，激活一个必炸模块 + rollback 后旧工具可调
    const s = sink();
    const bus = createEventBus(s);
    const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/s" });
    const good = mod("good", { activate(ctx) { ctx.contribute.tool(tool("good__t")); } });
    const r1 = await round([good], { reuse: { bus, tools } });
    const preserved = r1.out.preservable();
    // 第二轮：good 为 Unchanged（preserved），bad 激活到一半炸（贡献了工具后抛错）
    const bad = mod("bad", {
      activate(ctx) { ctx.contribute.tool(tool("bad__t")); throw new Error("炸了"); },
    });
    const r2 = await round([preserved.get("good")!.def, bad], { preserved, reuse: { bus, tools } });
    expect(r2.out.records.find((x) => x.name === "bad")!.state).toBe("failed");
    expect(tools.list().map((t) => t.name)).not.toContain("bad__t"); // 新激活的贡献被回滚
    const res = await tools.run({ id: "c9", name: "good__t", args: {} }, { signal: new AbortController().signal });
    expect(res.output).toBe("out:good__t"); // 旧图（preserved）句柄仍可用
  });

  it("⑨ 模块级失败 → 新图内降级，reload 不废除（⑧已覆盖语义，此处验证 preserved 不受株连）", async () => {
    const s = sink();
    const bus = createEventBus(s);
    const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/s" });
    const keep = mod("keep", { provides: ["keep.x"], activate(ctx) { ctx.provide("keep.x", 7); } });
    const r1 = await round([keep], { reuse: { bus, tools } });
    const preserved = r1.out.preservable();
    const boom = mod("boom", { activate() { throw new Error("x"); } });
    const r2 = await round([preserved.get("keep")!.def, boom], { preserved, reuse: { bus, tools } });
    expect(r2.out.records.find((x) => x.name === "keep")!.state).toBe("active");
    expect(r2.out.records.find((x) => x.name === "boom")!.state).toBe("failed");
  });

  it("⑩ 换下实例的 ctx.services.get → stale 错误（§5.5）", async () => {
    const provider = mod("p10", { provides: ["p10.x"], activate(ctx) { ctx.provide("p10.x", 1); } });
    const consumer = mod("c10", { dependsOn: ["p10.x"] });
    const r = await round([provider, consumer]);
    const pctx = r.ctxOf("p10");
    await r.out.rollbackModule("p10");
    await expect((async () => pctx!.services.get("p10.x"))()).rejects.toThrow(/stale|过期/);
  });

  it("⑪ 端到端：Unchanged 模块的工具在 reload（共用注册表 + preserved）后仍可调用", async () => {
    const s = sink();
    const bus = createEventBus(s);
    const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/s" });
    const m = mod("m11", { activate(ctx) { ctx.contribute.tool(tool("m11__t")); } });
    const r1 = await round([m], { reuse: { bus, tools } });
    void r1;
    const preserved = r1.out.preservable();
    await round([preserved.get("m11")!.def], { preserved, reuse: { bus, tools } });
    const res = await tools.run({ id: "c10", name: "m11__t", args: {} }, { signal: new AbortController().signal });
    expect(res.output).toBe("out:m11__t");
  });
});
