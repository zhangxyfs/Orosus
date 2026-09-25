import { describe, it, expect } from "vitest";
import { defineModule, type CardSpec, type ModuleDefinition, type WidgetSpec } from "@orosus/contracts/module";
import { InMemorySessionStore } from "../session/memory.ts";
import { activateModules, type ActivateOutput, type PreservedInstance } from "./activate.ts";
import { loadModules } from "./kernel.ts";
import { createEventBus } from "./bus.ts";
import { createToolRegistry } from "../tool/registry.ts";
import { resolveSections } from "../config/validate.ts";
import type { DiagSink } from "../diag/logger.ts";

/** m5 T5：contribute.card 内核注册口——staged commit / mounts 门 / 按引用存（getter 活）/ reload 沿用 / 卸载拆卡。 */

const sink = (): DiagSink => ({ write: () => {}, flush: () => Promise.resolve(), close: () => Promise.resolve() });
const mod = (name: string, extra: Partial<ModuleDefinition> = {}): ModuleDefinition =>
  defineModule({ name, version: "0.1.0", description: name, api: 1, activate() {}, ...extra });

const card = (over: Partial<CardSpec> = {}): CardSpec => ({
  area: "bottom",
  order: 50,
  title: "便签",
  widgets: [],
  ...over,
});

describe("contribute.card 注册口（m5 T5——口子二接线层）", () => {
  it("① 注册：mounts 已声明 → 卡进注册表（top/bottom 各一）、audit 贡献行带卡名与区域", async () => {
    const m = mod("card-mod", {
      mounts: ["contribute:card"],
      activate(ctx) {
        ctx.contribute.card?.(card({ area: "top", title: "上卡", order: 60 }));
        ctx.contribute.card?.(card({ area: "bottom", title: "下卡", order: 50 }));
      },
    });
    const g = await loadModules({
      defs: [{ def: m, source: "builtin" }], cli: {}, sections: new Map(),
      session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s",
    });
    expect(g.cards).toHaveLength(2);
    expect(g.cards.map((c) => `${c.owner}:${c.spec.area}:${c.spec.title}`).sort()).toEqual(["card-mod:bottom:下卡", "card-mod:top:上卡"]);
    const contribs = g.audit().find((a) => a.name === "card-mod")!.contributes.join(" ");
    expect(contribs).toContain("card: 上卡 (top)");
    expect(contribs).toContain("card: 下卡 (bottom)");
    await g.dispose();
  });

  it("② mounts 门：声明了 mounts 但未列 contribute:card → 注册即抛、模块降级", async () => {
    const m = mod("card-gated", {
      mounts: ["contribute:tool"],
      activate(ctx) {
        ctx.contribute.card?.(card());
      },
    });
    const g = await loadModules({
      defs: [{ def: m, source: "builtin" }], cli: {}, sections: new Map(),
      session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s",
    });
    expect(g.cards).toHaveLength(0);
    expect(g.audit().find((a) => a.name === "card-gated")!.state).toBe("failed");
    expect(g.audit().find((a) => a.name === "card-gated")!.failReason).toContain("contribute:card");
    await g.dispose();
  });

  it("③ 按引用存（禁止展开拷贝）：widgets getter 现问现答——注册后模块侧变量变、注册表读数跟着变", async () => {
    let live = 1;
    // 不经 card() 夹具构造——夹具的 ...over 展开会把 getter 拍平（本测试第一版就是这么自杀的）
    const spec: CardSpec = {
      area: "bottom",
      order: 50,
      title: "活卡",
      get widgets(): WidgetSpec[] {
        return [{ id: "n", kind: "kv", label: "读数", value: String(live) }];
      },
    };
    const m = mod("card-live", {
      mounts: ["contribute:card"],
      activate(ctx) {
        ctx.contribute.card?.(spec);
      },
    });
    const g = await loadModules({
      defs: [{ def: m, source: "builtin" }], cli: {}, sections: new Map(),
      session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s",
    });
    expect(g.cards[0]!.spec).toBe(spec); // 同一引用——不是快照拷贝
    expect(g.cards[0]!.spec.widgets[0]).toMatchObject({ kind: "kv", value: "1" });
    live = 2;
    expect(g.cards[0]!.spec.widgets[0]).toMatchObject({ value: "2" }); // getter 活着（展开拷贝在此必挂）
    await g.dispose();
  });

  it("④ 卸载拆卡：disposeOwners 后卡注册表清空", async () => {
    const m = mod("card-off", {
      mounts: ["contribute:card"],
      activate(ctx) {
        ctx.contribute.card?.(card());
      },
    });
    const g = await loadModules({
      defs: [{ def: m, source: "builtin" }], cli: {}, sections: new Map(),
      session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s",
    });
    expect(g.cards).toHaveLength(1);
    await g.disposeOwners(["card-off"]);
    expect(g.cards).toHaveLength(0);
    await g.dispose();
  });
});

// ---- activate 级：reload 沿用（Unchanged 模块的卡注册物进沿用清单）----

async function round(defs: ModuleDefinition[], preserved?: Map<string, PreservedInstance>): Promise<{ out: ActivateOutput; activateCount: () => number }> {
  const s = sink();
  const bus = createEventBus(s);
  const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/s" });
  let count = 0;
  const wrapped = defs.map((d) => {
    if (preserved?.has(d.name)) return d;
    return mod(d.name, {
      ...d,
      activate(ctx) {
        count++;
        return d.activate(ctx);
      },
    } as Partial<ModuleDefinition>);
  });
  const out = await activateModules({
    ordered: wrapped,
    sectionResolution: resolveSections(new Map(), wrapped, {}),
    session: new InMemorySessionStore(),
    sink: s,
    bus,
    tools,
    ...(preserved !== undefined ? { preserved } : {}),
  });
  return { out, activateCount: () => count };
}

describe("card reload 沿用（m5 T5——不进沿用清单 = /reload 后保留模块的卡全丢）", () => {
  it("⑤ Unchanged 模块 activate 不重跑、卡注册物沿用到新图（同一 spec 引用）", async () => {
    const spec = card({ title: "留卡" });
    const m = mod("card-keep", {
      mounts: ["contribute:card"],
      activate(ctx) {
        ctx.contribute.card?.(spec);
      },
    });
    const r1 = await round([m]);
    expect(r1.out.cards).toHaveLength(1);
    const preserved = r1.out.preservable();
    const r2 = await round([preserved.get("card-keep")!.def], preserved);
    expect(r2.activateCount()).toBe(0); // Unchanged 不重跑
    expect(r2.out.cards).toHaveLength(1);
    expect(r2.out.cards[0]!.spec).toBe(spec); // 沿用同一引用
    expect(r2.out.cards[0]!.owner).toBe("card-keep");
  });
});
