import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineModule, type ModuleDefinition } from "@orosus/contracts/module";
import { defineTool } from "@orosus/contracts/tool";
import { InMemorySessionStore } from "../session/memory.ts";
import { createEventBus } from "./bus.ts";
import { createToolRegistry } from "../tool/registry.ts";
import { resolveSections } from "../config/validate.ts";
import { activateModules, type ActivateOutput, type OverlayEntry, type PreservedInstance } from "./activate.ts";
import { loadModules } from "./kernel.ts";
import { diffGraphs, stableStringify, type GraphDef } from "./reload.ts";
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
  it("⑤b CK-08 回归钉：stableStringify 导出——key 序不敏感（z.record/passthrough 类 schema 保留输入 key 序，重排配置不判变）；嵌套与 undefined 语义钉死", () => {
    expect(stableStringify({ a: 1, b: { x: 2, y: 3 } })).toBe(stableStringify({ b: { y: 3, x: 2 }, a: 1 })); // JSON.stringify 两份会不等——harness 粗判复用本函数（CK-08）
    expect(JSON.stringify({ a: 1, b: 2 }) === JSON.stringify({ b: 2, a: 1 })).toBe(false); // 前提展示：原生 stringify key 序敏感
    expect(stableStringify(undefined)).toBe("undefined"); // undefined 基线（configValue 无效化为 undefined 时的比较语义）
    expect(stableStringify([{ b: 1, a: 2 }, 3])).toBe(stableStringify([{ a: 2, b: 1 }, 3]));
  });
  it("⑤b CH-05 连带回归钉：local 模块 def 引用逐次新对象（jiti moduleCache:false）不再误判 Reloaded——entryHash 相等 + 来源层相等 = Unchanged；来源层翻转（local↔inline）才判变", () => {
    const h1 = "same-hash";
    const oldLocal = gd("m", { source: "local", entryHash: h1 });
    const newLocal = gd("m", { source: "local", entryHash: h1, def: mod("m") }); // 全新 def 对象（模拟二次发现）
    expect(diffGraphs([oldLocal], [newLocal]).unchanged).toEqual(["m"]); // 旧实现：def 引用恒不等 → 每次全量误重载
    expect(diffGraphs([gd("m", { source: "local", entryHash: h1 })], [gd("m", { source: "local", entryHash: "h2" })]).reloaded).toEqual(["m"]); // 代码变了（hash 变）照判 Reloaded
    expect(diffGraphs([gd("m", { source: "local", entryHash: h1 })], [gd("m", { source: "inline", entryHash: h1 })]).reloaded).toEqual(["m"]); // 换源（local→inline）判变
    // 引用判据对 inline/builtin 语义不变：同引用 Unchanged、新对象判变
    const sameInline = gd("m");
    expect(diffGraphs([sameInline], [{ ...sameInline, def: sameInline.def }]).unchanged).toEqual(["m"]);
    expect(diffGraphs([gd("m")], [gd("m", { def: mod("m") })]).reloaded).toEqual(["m"]);
  });
});

// ---- activate 级：preserved / generation / stale / tombstone / 复用注册表 ----

const tool = (name: string) =>
  defineTool({ name, description: name, parameters: z.object({}), resolveExecution: async () => ({ execute: async () => ({ output: `out:${name}`, isError: false }) }) });

interface Round {
  out: ActivateOutput;
  activateCount: () => number;
  ctxOf: (name: string) => { services: { get(key: string): Promise<unknown>; getOptional(key: string): Promise<unknown> } } | undefined;
}

async function round(defs: ModuleDefinition[], opts: { preserved?: Parameters<typeof activateModules>[0]["preserved"]; generations?: Map<string, number>; reuse?: { bus: ReturnType<typeof createEventBus>; tools: ReturnType<typeof createToolRegistry> } } = {}): Promise<Round> {
  const s = sink();
  const bus = opts.reuse?.bus ?? createEventBus(s);
  const tools = opts.reuse?.tools ?? createToolRegistry({ bus, sink: s, spillDir: "/tmp/s" });
  let count = 0;
  const ctxs = new Map<string, { services: { get(key: string): Promise<unknown>; getOptional(key: string): Promise<unknown> } }>();
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

  it("⑩ 换下实例的 ctx.services.get → stale 错误（§5.5）；CK-12：getOptional 同款守卫", async () => {
    const provider = mod("p10", { provides: ["p10.x"], activate(ctx) { ctx.provide("p10.x", 1); } });
    const consumer = mod("c10", { dependsOn: ["p10.x"] });
    const r = await round([provider, consumer]);
    const pctx = r.ctxOf("p10");
    await r.out.rollbackModule("p10");
    await expect((async () => pctx!.services.get("p10.x"))()).rejects.toThrow(/stale|过期/);
    await expect((async () => pctx!.services.getOptional("p10.x"))()).rejects.toThrow(/stale|过期/); // CK-12：旧实现静默读当代册——换下实例经 getOptional 绕过 stale 语义
    await expect((async () => pctx!.services.getOptional("no.such-key"))()).rejects.toThrow(/stale|过期/); // 守卫在查册之前——无该能力也先撞 stale（与 get 判定序一致）
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

// ---- loadModules 层：reuse 接线（走查实证：/reload 后 toolsCount 0、拦截器静默失效——kernel 无视 reuse） ----

describe("loadModules reuse 接线（/reload 工具与监听器存活）", () => {
  const gd2 = (def: ModuleDefinition) => ({ def, source: "inline" as const });

  it("⑫ reuse.bus/tools 真被复用：preserved 模块的工具在新图可用、bus 监听器跨 reload 存活", async () => {
    const s = sink();
    const seen: string[] = [];
    const m = mod("m12", {
      activate(ctx) {
        ctx.contribute.tool(tool("m12__t"));
        ctx.events.on("test/hello", () => { seen.push("hit"); });
      },
    });
    const r1 = await loadModules({ defs: [gd2(m)], cli: {}, sections: new Map(), session: new InMemorySessionStore(), sink: s, spillDir: "/tmp/s" });
    r1.bus.emit("test/hello", {});
    expect(seen).toEqual(["hit"]);
    const preserved = r1.preservable();
    const r2 = await loadModules({
      defs: [gd2(preserved.get("m12")!.def)], cli: {}, sections: new Map(), session: new InMemorySessionStore(), sink: s, spillDir: "/tmp/s",
      reuse: { bus: r1.bus, tools: r1.tools }, preserved,
    });
    expect(r2.tools.list().map((t) => t.name)).toContain("m12__t"); // 走查缺陷：曾为空——新图新注册表丢了 preserved 工具
    expect(r2.bus).toBe(r1.bus); // 复用同一 bus——preserved 监听器不孤儿化
    r2.bus.emit("test/hello", {});
    expect(seen).toEqual(["hit", "hit"]); // 监听器仍活着（走查缺陷：曾静默失效）
  });

  it("⑬ Reloaded 模块：重激活复活工具槽 + disposeOwners 拆旧实例（共享 bus 上旧监听器恰好摘除一次）", async () => {
    const s = sink();
    const seen: string[] = [];
    const make = () => mod("m13", {
      activate(ctx) {
        ctx.contribute.tool(tool("m13__t"));
        ctx.events.on("test/hello", () => { seen.push("hit"); });
      },
    });
    const r1 = await loadModules({ defs: [gd2(make())], cli: {}, sections: new Map(), session: new InMemorySessionStore(), sink: s, spillDir: "/tmp/s" });
    // 配置变化 → Reloaded：不进 preserved，重激活——harness 时序：先墓碑（重注册原位复活，否则撞名激活失败）
    for (const tn of r1.tools.namesByOwner("m13")) r1.tools.tombstone(tn);
    const r2 = await loadModules({
      defs: [gd2(make())], cli: {}, sections: new Map(), session: new InMemorySessionStore(), sink: s, spillDir: "/tmp/s",
      reuse: { bus: r1.bus, tools: r1.tools },
      generations: new Map(r1.records.map((r) => [r.name, r.generation])),
    });
    await r1.disposeOwners(["m13"]); // 换下旧实例选择性拆除（新图方法）
    r2.bus.emit("test/hello", {});
    expect(seen).toEqual(["hit"]); // 恰好一次（仅新实例监听）——不 dispose 会是两次（旧监听器泄漏在共享 bus 上）
    const res = await r2.tools.run({ id: "c13", name: "m13__t", args: {} }, { signal: new AbortController().signal });
    expect(res.output).toBe("out:m13__t"); // 工具槽复活可用
  });
});

// ---- CK-02/03/04：reload 换代三件（跨代资源管理——required 失败事务性 / 监听器与 stale 跨代 / overlay 换代共享）----

/** 共用 bus/tools 的多轮建图（harness.reload 的 kernel 侧形态）：overlays 自第二轮起透传旧图（跨代共享）。 */
const loader = (s: DiagSink, bus: ReturnType<typeof createEventBus>, tools: ReturnType<typeof createToolRegistry>) =>
  (defs: ModuleDefinition[], opts: { preserved?: Map<string, PreservedInstance>; overlays?: OverlayEntry[]; sections?: Map<string, Record<string, unknown>> } = {}) =>
    loadModules({
      defs: defs.map((d) => ({ def: d, source: "inline" as const })), cli: {}, sections: opts.sections ?? new Map(),
      session: new InMemorySessionStore(), sink: s, spillDir: "/tmp/s",
      reuse: { bus, tools, ...(opts.overlays !== undefined ? { overlays: opts.overlays } : {}) },
      ...(opts.preserved !== undefined ? { preserved: opts.preserved } : {}),
    });

describe("reload 换代跨代资源（CK-02/03/04）", () => {
  it("⑭ CK-02 回归钉：required 失败 → 不拆 preserved（borrowed）实例——旧图 dispose 未被误调、工具/监听器仍活；旧图自身停用时恰好一次", async () => {
    const s = sink();
    const bus = createEventBus(s);
    const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/s" });
    const seen: string[] = [];
    let disposed = 0;
    const good = mod("good", {
      activate(ctx) {
        ctx.contribute.tool(tool("good__t"));
        ctx.events.on("good/ping", () => { seen.push("hit"); });
        return { dispose() { disposed++; } };
      },
    });
    const load = loader(s, bus, tools);
    const r1 = await load([good]);
    const preserved = r1.preservable();
    // 第二轮：good 为 Unchanged（preserved 借入），新 required 模块激活炸 → loadModules 抛（required 护栏）
    const bad = mod("approval", { activate() { throw new Error("起不来"); } });
    await expect(load([preserved.get("good")!.def, bad], { preserved, sections: new Map([["approval", { required: true }]]) }))
      .rejects.toThrow(/required/);
    expect(disposed).toBe(0); // 旧实现：disposeAll 误调 preserved 的旧 disposeFn——「旧图继续运行」名存实亡
    const res = await tools.run({ id: "ck02", name: "good__t", args: {} }, { signal: new AbortController().signal });
    expect(res.output).toBe("out:good__t"); // 旧图工具仍可用
    await bus.emit("good/ping", {});
    expect(seen).toEqual(["hit"]); // 旧图监听器仍活（恰好一份）
    await r1.dispose(); // 借用物归旧图——旧图自身停用时 dispose 恰好一次（过户语义的另一侧）
    expect(disposed).toBe(1);
  });

  it("⑮ CK-03 回归钉（两代序列）：M reload#1 Unchanged → reload#2 Reloaded——共享 bus 监听器恰好一份（无泄漏双触发）、旧 ctx.services.get 抛 stale", async () => {
    const s = sink();
    const bus = createEventBus(s);
    const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/s" });
    const seen: string[] = [];
    const ctxs = new Map<string, { services: { get(key: string): Promise<unknown> } }>();
    const wrap = (d: ModuleDefinition): ModuleDefinition => mod(d.name, { ...d, activate(ctx) { ctxs.set(d.name, ctx); return d.activate(ctx); } });
    const prov = mod("prov15", { provides: ["prov15.x"], activate(ctx) { ctx.provide("prov15.x", { v: 1 }); } });
    const mkM = () => mod("m15", {
      dependsOn: ["prov15.x"],
      activate(ctx) { ctx.events.on("test/hello", () => { seen.push("hit"); }); },
    });
    const load = loader(s, bus, tools);
    const g1 = await load([prov, wrap(mkM())]); // gen1：M 注册监听 L1（disposer 落 gen1 ownerContribs）
    const m1Def = g1.preservable().get("m15")!.def;
    await bus.emit("test/hello", {});
    expect(seen).toHaveLength(1); // 基线：恰好一份
    const preserved1 = g1.preservable();
    const g2 = await load([prov, m1Def], { preserved: preserved1 }); // reload#1：双双 Unchanged
    const oldMCtx = ctxs.get("m15")!; // gen1 的 M ctx（preserved 换代不重激活——后续 stale 断言的主角）
    await bus.emit("test/hello", {});
    expect(seen).toHaveLength(2); // 仍恰好一份（L1 存活）
    // reload#2：M Reloaded（新 def 引用）——harness 时序：墓碑（M 无工具，空操作）→ 新图 → 换下旧实例
    const g3 = await load([prov, wrap(mkM())], { preserved: new Map([...g2.preservable()].filter(([n]) => n !== "m15")) });
    await g2.disposeOwners(["m15"]); // 换下 gen2（= gen1 沿用的）旧实例——经 carried disposer 摘 L1
    await bus.emit("test/hello", {});
    expect(seen).toHaveLength(3); // 恰好一份（仅新实例监听）——旧实现：gen2 disposers 为空数组，L1 永久泄漏 → 此处会是 4（双触发）
    await expect((async () => oldMCtx.services.get("prov15.x"))()).rejects.toThrow(/stale|过期/); // gen1 旧 ctx 的 stale 守卫跨代生效（旧实现：名字 keyed Set 打错代 → 读僵尸句柄不抛）
    await g3.dispose();
  });

  it("⑯ CK-04 回归钉（overlay 换代）：P 贡献 overlay + Q 消费——reload#1 双 Unchanged；reload#2 Q Reloaded 后新 ctx 仍被改写；P 换下后所有代 ctx 不再被改写（无僵尸）", async () => {
    const s = sink();
    const bus = createEventBus(s);
    const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/s" });
    const qReads: { configRead(): Promise<unknown> }[] = [];
    const pDef = mod("p16", {
      mounts: ["contribute:configOverlay"],
      uses: ["config.foreign"],
      activate(ctx) { ctx.contribute.configOverlay({ section: "q16", read: (v) => ({ ...(v as Record<string, unknown>), tagged: true }) }); },
    });
    const mkQ = () => mod("q16", {
      config: z.object({ tagged: z.boolean().optional() }),
      activate(ctx) { qReads.push(ctx); },
    });
    const load = loader(s, bus, tools);
    const g1 = await load([pDef, mkQ()]);
    const q1Def = g1.preservable().get("q16")!.def;
    expect(await qReads[0]!.configRead()).toEqual({ tagged: true }); // 前置：gen1 overlay 生效
    const g2 = await load([pDef, q1Def], { preserved: g1.preservable(), overlays: g1.overlays }); // reload#1：双双 Unchanged
    expect(await qReads[0]!.configRead()).toEqual({ tagged: true }); // preserved 的 Q 仍是 gen1 ctx——overlay 继续生效
    // reload#2：Q Reloaded（新 def 引用）、P 沿用——Q 的新 ctx 必须仍被 P 的 overlay 改写
    const g3 = await load([pDef, mkQ()], { preserved: new Map([...g2.preservable()].filter(([n]) => n !== "q16")), overlays: g2.overlays });
    await g2.disposeOwners(["q16"]); // 换下旧 Q 实例（harness 时序：新图激活后）
    expect(qReads).toHaveLength(2); // Q 重激活（新 ctx）
    expect(await qReads[1]!.configRead()).toEqual({ tagged: true }); // CK-04①：新代 ctx 仍被改写——旧实现：per-代数组，P 的条目静默丢失
    // reload#3：P 换下（从 defs 消失）——Q（q2 def 沿用）不再被已卸载模块的 overlay 改写
    const q2Def = g3.preservable().get("q16")!.def;
    const g4 = await load([q2Def], { preserved: new Map([...g3.preservable()].filter(([n]) => n !== "p16")), overlays: g3.overlays });
    await g3.disposeOwners(["p16"]); // 摘 P 的 overlay（disposer 闭包引用跨代共享数组——对所有代 ctx 同时生效）
    expect(await qReads[1]!.configRead()).toEqual({}); // CK-04②：无僵尸——旧实现：gen3 ctx 迭代出生代私有数组，P 的僵尸条目永生
    expect(await qReads[0]!.configRead()).toEqual({}); // gen1 老 ctx 同数组——同样不再被改写
    await g4.dispose();
  });
});
