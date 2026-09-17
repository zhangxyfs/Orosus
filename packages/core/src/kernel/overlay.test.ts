import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineModule, type ModuleContext, type ModuleDefinition } from "@orosus/contracts/module";
import { InMemorySessionStore } from "../session/memory.ts";
import { createEventBus } from "./bus.ts";
import { createToolRegistry } from "../tool/registry.ts";
import { resolveSections } from "../config/validate.ts";
import { activateModules } from "./activate.ts";
import type { DiagSink } from "../diag/logger.ts";

const sink = (): DiagSink => ({ write: () => {}, flush: () => Promise.resolve(), close: () => Promise.resolve() });
const mod = (name: string, extra: Partial<ModuleDefinition>): ModuleDefinition =>
  defineModule({ name, version: "0.1.0", description: name, api: 1, activate() {}, ...extra });

interface Harness { ctx: ModuleContext<{ k?: string }> | null; disposer: (() => void) | null }
const setup = (defs: ModuleDefinition[], sections: Map<string, Record<string, unknown>>) => {
  const s = sink();
  const bus = createEventBus(s);
  const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/s" });
  const captured: Record<string, Harness> = {};
  for (const d of defs) captured[d.name] = { ctx: null, disposer: null };
  const wrapped = defs.map((d) => mod(d.name, {
    ...d,
    activate(ctx) {
      captured[d.name]!.ctx = ctx as ModuleContext<{ k?: string }>;
      return d.activate(ctx);
    },
  }));
  const sectionResolution = resolveSections(sections, wrapped, {});
  const out = activateModules({ ordered: wrapped, sectionResolution, session: new InMemorySessionStore(), sink: s, bus, tools });
  return { out, captured };
};

describe("配置 overlay（§6.6 四边界，D2/v13）", () => {
  it("注册口返回真 disposer：注销后不再生效", async () => {
    const sections = new Map([["m", { k: "base" }]]);
    const m = mod("m", {
      config: z.object({ k: z.string() }).passthrough(),
      activate(ctx) {
        const off = ctx.contribute.configOverlay({ read: (v) => ({ ...(v as object), k: "overlay" }) });
        (globalThis as Record<string, unknown>)["__off"] = off;
      },
    });
    const { out, captured } = setup([m], sections);
    await out;
    const c = captured.m!;
    expect(await c.ctx!.configRead()).toMatchObject({ k: "overlay" });
    ((globalThis as Record<string, unknown>)["__off"] as () => void)();
    expect(await c.ctx!.configRead()).toMatchObject({ k: "base" });
  });

  it("读序按注册序复合（同模块两次注册，调用序即链序）", async () => {
    const sections = new Map([["m", { k: "" }]]);
    const m = mod("m", {
      config: z.object({ k: z.string() }).passthrough(),
      activate(ctx) {
        ctx.contribute.configOverlay({ read: (v) => ({ ...(v as object), k: (v as { k: string }).k + "一" }) });
        ctx.contribute.configOverlay({ read: (v) => ({ ...(v as object), k: (v as { k: string }).k + "二" }) });
      },
    });
    const { captured } = setup([m], sections);
    await Promise.resolve();
    expect(await captured.m!.ctx!.configRead()).toMatchObject({ k: "一二" });
  });

  it("overlay 只作用于 configRead，不作用于 ctx.config 快照", async () => {
    const sections = new Map([["m", { k: "base" }]]);
    const m = mod("m", {
      config: z.object({ k: z.string() }).passthrough(),
      activate(ctx) {
        ctx.contribute.configOverlay({ read: (v) => ({ ...(v as object), k: "overlay" }) });
      },
    });
    const { captured } = setup([m], sections);
    await Promise.resolve();
    expect(captured.m!.ctx!.config).toMatchObject({ k: "base" });
    expect(await captured.m!.ctx!.configRead()).toMatchObject({ k: "overlay" });
  });

  it("改写值须过模块自身 schema 复检：不过则该次读取 reject，不影响图", async () => {
    const sections = new Map([["m", { k: "base" }]]);
    const m = mod("m", {
      config: z.object({ k: z.string() }),  // strict：数字不过
      activate(ctx) {
        ctx.contribute.configOverlay({ read: () => ({ k: 123 }) });
      },
    });
    const { out, captured } = setup([m], sections);
    const r = await out;
    expect(r.records.every((x) => x.state === "active")).toBe(true); // 图不受影响
    await expect(captured.m!.ctx!.configRead()).rejects.toThrow(/复检|schema|invalid/i);
  });

  it("默认 section = 自家（不带 section 字段只改自己的读取）", async () => {
    const sections = new Map([["a", { k: "a" }], ["b", { k: "b" }]]);
    const a = mod("a", { config: z.object({ k: z.string() }).passthrough(), activate(ctx) { ctx.contribute.configOverlay({ read: (v) => ({ ...(v as object), k: "改a" }) }); } });
    const b = mod("b", { config: z.object({ k: z.string() }).passthrough() });
    const { captured } = setup([a, b], sections);
    await Promise.resolve();
    expect(await captured.a!.ctx!.configRead()).toMatchObject({ k: "改a" });
    expect(await captured.b!.ctx!.configRead()).toMatchObject({ k: "b" }); // 不受 a 的 overlay 影响
  });

  it("声明他人 section 且 uses 含 config.foreign → 放行并生效", async () => {
    const sections = new Map([["a", { k: "a" }], ["b", { k: "b" }]]);
    const a = mod("a", { config: z.object({ k: z.string() }).passthrough() });
    const b = mod("b", {
      config: z.object({ k: z.string() }).passthrough(),
      uses: ["config.foreign"],
      activate(ctx) { ctx.contribute.configOverlay({ section: "a", read: (v) => ({ ...(v as object), k: "b改a" }) }); },
    });
    const { out, captured } = setup([a, b], sections);
    const r = await out;
    expect(r.records.every((x) => x.state === "active")).toBe(true);
    expect(await captured.a!.ctx!.configRead()).toMatchObject({ k: "b改a" });
  });

  it("声明他人 section 无 uses → 注册即抛，激活失败降级", async () => {
    const sections = new Map([["a", { k: "a" }], ["b", { k: "b" }]]);
    const a = mod("a", { config: z.object({ k: z.string() }).passthrough() });
    const b = mod("b", {
      config: z.object({ k: z.string() }).passthrough(),
      activate(ctx) { ctx.contribute.configOverlay({ section: "a", read: (v) => v }); },
    });
    const { out } = setup([a, b], sections);
    const r = await out;
    expect(r.records.find((x) => x.name === "b")!.state).toBe("failed");
    expect(r.records.find((x) => x.name === "b")!.failReason).toContain("config.foreign");
  });
});
