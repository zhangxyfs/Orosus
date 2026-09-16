import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineModule, type ModuleDefinition } from "@orosus/contracts/module";
import { defineTool } from "@orosus/contracts/tool";
import { InMemorySessionStore } from "../session/memory.ts";
import { createEventBus } from "./bus.ts";
import { createToolRegistry } from "../tool/registry.ts";
import { resolveSections } from "../config/validate.ts";
import { activateModules, PROMPT_SECTION_LIMIT } from "./activate.ts";
import type { DiagSink, DiagRecord } from "../diag/logger.ts";

const sink = (): DiagSink & { records: DiagRecord[] } => {
  const records: DiagRecord[] = [];
  return { records, write: (r) => void records.push(r), flush: () => Promise.resolve(), close: () => Promise.resolve() };
};

const mod = (name: string, extra: Partial<ModuleDefinition>): ModuleDefinition =>
  defineModule({ name, version: "0.1.0", description: name, api: 1, activate() {}, ...extra });

const setup = (defs: ModuleDefinition[]) => {
  const s = sink();
  const bus = createEventBus(s);
  const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/orosus-test-spill" });
  const sectionResolution = resolveSections(new Map(), defs, {});
  const session = new InMemorySessionStore();
  return { s, bus, tools, session, input: { ordered: defs, sectionResolution, session, sink: s, bus, tools } };
};

describe("激活管线（§4.2 第 6 步）", () => {
  it("提供者在拓扑序先激活：消费者 ctx.services.get 拿到实现", async () => {
    const provider = mod("p", { provides: ["fs"], activate(ctx) { ctx.provide("fs", { read: async () => "内容" }); } });
    const consumer = mod("c", {
      dependsOn: ["fs"],
      activate(ctx) {
        ctx.contribute.tool(defineTool({
          name: "c__t", description: "t", parameters: z.object({}),
          resolveExecution: async () => ({
            execute: async () => {
              const fs = await ctx.services.get<{ read(): Promise<string> }>("fs" as never);
              return { output: await fs.read(), isError: false };
            },
          }),
        }));
      },
    });
    const { input, tools } = setup([provider, consumer]);
    const out = await activateModules(input);
    expect(out.records.every((r) => r.state === "active")).toBe(true);
    const r = await tools.run({ id: "c1", name: "c__t", args: {} }, { signal: new AbortController().signal });
    expect(r.output).toBe("内容");
  });

  it("provide 越界（key 不在 provides 声明）→ 激活失败降级", async () => {
    const bad = mod("bad", { provides: ["fs"], activate(ctx) { ctx.provide("shell", {}); } });
    const { input } = setup([bad]);
    const out = await activateModules(input);
    expect(out.records[0]!.state).toBe("failed");
    expect(out.records[0]!.failReason).toContain("越界");
  });

  it("激活期抛错 → staged 注册全部 discard，硬依赖消费者级联降级且不激活", async () => {
    let consumerActivated = false;
    const boom = mod("boom", {
      provides: ["fs"],
      activate(ctx) {
        ctx.contribute.tool(defineTool({ name: "boom__t", description: "t", parameters: z.object({}), resolveExecution: async () => ({ execute: async () => ({ output: "x", isError: false }) }) }));
        throw new Error("activate 炸了");
      },
    });
    const consumer = mod("c", { dependsOn: ["fs"], activate() { consumerActivated = true; } });
    const { input, tools } = setup([boom, consumer]);
    const out = await activateModules(input);
    expect(out.records.find((r) => r.name === "boom")!.state).toBe("failed");
    expect(out.records.find((r) => r.name === "c")!.state).toBe("failed");
    expect(out.records.find((r) => r.name === "c")!.failReason).toContain("级联");
    expect(consumerActivated).toBe(false);
    expect(tools.list()).toHaveLength(0); // staged 未提交
  });

  it("session.append 白名单：type 未在 logEvents 声明即拒绝", async () => {
    const m = mod("m", { logEvents: ["m/ok"], activate(ctx) { ctx.session.append("m/not-declared", {}); } });
    const { input } = setup([m]);
    const out = await activateModules(input);
    expect(out.records[0]!.state).toBe("failed");
    expect(out.records[0]!.failReason).toContain("logEvents");
  });

  it("events.emit 命名空间：核心类型拒绝（抛错传出 activate → 降级），自有 <module>/ 放行", async () => {
    const m = mod("m", {
      async activate(ctx) {
        await ctx.events.emit("m/happened", { x: 1 }); // 合法
        await ctx.events.emit("tool/pre-execute", {}); // 核心类型 → 抛错（不捕获，传播出 activate）
      },
    });
    const { input, s } = setup([m]);
    const out = await activateModules(input);
    expect(out.records[0]!.state).toBe("failed"); // emit 核心类型抛错 → activate 失败
    expect(s.records.some((r) => r.code === "kernel.emit.rejected")).toBe(true);
  });

  it("promptSection 单段超 32KB → 激活期降级（§6.5 预算）", async () => {
    const m = mod("m", { activate(ctx) { ctx.contribute.promptSection({ order: 0, text: "x".repeat(PROMPT_SECTION_LIMIT + 1) }); } });
    const { input } = setup([m]);
    const out = await activateModules(input);
    expect(out.records[0]!.state).toBe("failed");
    expect(out.records[0]!.failReason).toContain("预算");
  });

  it("promptSection order 侵入核心保留区（≤ -100）→ 激活期降级（§6.5）", async () => {
    const m = mod("m", { activate(ctx) { ctx.contribute.promptSection({ order: -100, text: "hi" }); } });
    const { input } = setup([m]);
    const out = await activateModules(input);
    expect(out.records[0]!.state).toBe("failed");
    expect(out.records[0]!.failReason).toContain("保留区");
  });

  it("mounts 校验：注册超出声明 → 激活失败降级（§5.1）", async () => {
    const m = mod("m", {
      mounts: ["contribute:tool"],
      activate(ctx) { ctx.contribute.promptSection({ order: 0, text: "hi" }); },
    });
    const { input } = setup([m]);
    const out = await activateModules(input);
    expect(out.records[0]!.state).toBe("failed");
    expect(out.records[0]!.failReason).toContain("mounts");
  });

  it("保留槽冲突：第二个 provide 同名 provider:x → 冲突双方降级、先注册者停用回滚（§7.2）", async () => {
    let disposed = false;
    const first = mod("first", {
      activate(ctx) {
        ctx.provide("provider:x", async function* () {});
        return { dispose() { disposed = true; } };
      },
    });
    const second = mod("second", { activate(ctx) { ctx.provide("provider:x", async function* () {}); } });
    const { input } = setup([first, second]);
    const out = await activateModules(input);
    expect(out.records.every((r) => r.state === "failed")).toBe(true); // 双方降级
    expect(disposed).toBe(true); // 先注册者被回滚
    expect(out.services.provider("x")).toBeUndefined(); // 槽位清空，不给静默赢家
  });

  it("commit 失败：已 push 的 command 一并拔除，模块 dispose 被调用（staged commit 语义，§8.4）", async () => {
    let disposed = false;
    const m = mod("m", {
      activate(ctx) {
        ctx.contribute.command("m__ok", () => "ok");
        ctx.contribute.command("bad-prefix", () => "x"); // 未带 m__ 前缀 → commit 期抛错（规则 4）
        return { dispose() { disposed = true; } };
      },
    });
    const { input } = setup([m]);
    const out = await activateModules(input);
    expect(out.records[0]!.state).toBe("failed");
    expect(out.commands.map((c) => c.name)).not.toContain("m__ok"); // 已提交的残留拔除
    expect(disposed).toBe(true); // activate 已返回的 dispose 不泄漏（规则 3）
  });

  it("回滚顺序：先模块 dispose()，再逆序 disposer（规则 3）——dispose 里 emit 仍能触达自家监听者", async () => {
    const seen: string[] = [];
    const first = mod("first", {
      activate(ctx) {
        ctx.events.on("first/ping", () => { seen.push("listener"); return undefined; });
        ctx.provide("provider:x", async function* () {});
        return {
          dispose() {
            seen.push("dispose");
            void ctx.events.emit("first/ping", {}); // disposer 尚未跑 → 监听者仍在，emit 应触达
          },
        };
      },
    });
    const second = mod("second", { activate(ctx) { ctx.provide("provider:x", async function* () {}); } });
    const { input } = setup([first, second]);
    const out = await activateModules(input);
    expect(out.records.every((r) => r.state === "failed")).toBe(true); // 保留槽冲突双方降级
    await new Promise((r) => setTimeout(r, 0)); // emit 异步触达
    expect(seen).toContain("dispose");
    expect(seen).toContain("listener"); // 若顺序反了（先 disposer 后 dispose），监听者已被摘除，此项失败
  });
});
