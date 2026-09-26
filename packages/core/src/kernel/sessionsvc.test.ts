import { describe, it, expect } from "vitest";
import { defineModule, type ModuleDefinition, type SessionTreeNode } from "@orosus/contracts/module";
import { InMemorySessionStore } from "../session/memory.ts";
import { loadModules } from "./kernel.ts";
import type { DiagSink } from "../diag/logger.ts";

/** 会话树批 T10：ctx.session 三缝装配——fork/switchTo 包 allows 门（"session.fork"/"session.switch"）、
 *  tree 只读无门直通（决策点 7）；三项未注入 = undefined 判空降级（老宿主/无头）。 */

const sink = (): DiagSink => ({ write: () => {}, flush: () => Promise.resolve(), close: () => Promise.resolve() });

type ForkOut = (opts?: { atEntryId?: string }) => Promise<{ sessionId: string }>;

const load = async (over: {
  sessionForkOut?: ForkOut;
  treeOut?: () => Promise<SessionTreeNode[]>;
  sessionSwitch?: (sessionId: string) => Promise<boolean>;
  modules?: ModuleDefinition[];
} = {}) =>
  loadModules({
    defs: (over.modules ?? []).map((def) => ({ def, source: "builtin" as const })),
    cli: {},
    sections: new Map(),
    session: new InMemorySessionStore(),
    sink: sink(),
    spillDir: "/tmp/s",
    ...(over.sessionForkOut !== undefined ? { sessionForkOut: over.sessionForkOut } : {}),
    ...(over.treeOut !== undefined ? { treeOut: over.treeOut } : {}),
    ...(over.sessionSwitch !== undefined ? { sessionSwitch: over.sessionSwitch } : {}),
  });

describe("ctx.session 三缝装配（会话树批 T10）", () => {
  it("① mounts 门：声明了 mounts 未列 \"session.fork\" → 调 fork 即抛（模块降级）；未声明 mounts 或列了 → 透传", async () => {
    const calls: string[] = [];
    const forkOut: ForkOut = async (opts) => { calls.push(`fork:${opts?.atEntryId ?? "尾"}`); return { sessionId: "s_new" }; };
    const g = await load({
      sessionForkOut: forkOut,
      modules: [
        defineModule({ name: "t-gated", version: "0.0.1", description: "x", api: 1, mounts: ["contribute:tool"], activate(ctx) { void ctx.session.fork?.({ atEntryId: "e1" }); } }),
      ],
    });
    expect(g.audit().find((a) => a.name === "t-gated")!.state).toBe("failed");
    expect(g.audit().find((a) => a.name === "t-gated")!.failReason).toContain("session.fork");
    await g.dispose();

    const g2 = await load({
      sessionForkOut: forkOut,
      modules: [
        defineModule({ name: "t-free", version: "0.0.1", description: "x", api: 1, async activate(ctx) { await ctx.session.fork?.(); } }), // 未声明 mounts = 不限制
        defineModule({ name: "t-listed", version: "0.0.1", description: "x", api: 1, mounts: ["session.fork"], async activate(ctx) { await ctx.session.fork?.({ atEntryId: "e1" }); } }),
      ],
    });
    expect(g2.audit().every((a) => a.state === "active")).toBe(true);
    expect(calls).toEqual(["fork:尾", "fork:e1"]);
    await g2.dispose();
  });

  it("② switchTo 门同款（\"session.switch\"）；tree 只读无门——声明了 mounts 不列 session 位也读得（决策点 7）", async () => {
    const nodes: SessionTreeNode[] = [{ sessionId: "s1", parentSession: null, sourceEntryId: null, createdAtMs: 1, updatedAtMs: 2, ownEvents: 3 }];
    let treeGot: number | undefined;
    let switchGot: boolean | undefined;
    const g = await load({
      treeOut: async () => nodes,
      sessionSwitch: async () => true,
      modules: [
        defineModule({
          name: "t-mixed", version: "0.0.1", description: "x", api: 1, mounts: ["session.switch"],
          async activate(ctx) {
            treeGot = (await ctx.session.tree?.())?.length; // tree 无门——mounts 未列也通
            switchGot = await ctx.session.switchTo?.("s1"); // switch 列了 → 通
          },
        }),
        defineModule({
          name: "t-switch-gated", version: "0.0.1", description: "x", api: 1, mounts: ["session.fork"],
          async activate(ctx) { await ctx.session.switchTo?.("s1"); }, // 未列 session.switch → 抛
        }),
      ],
    });
    expect(treeGot).toBe(1);
    expect(switchGot).toBe(true);
    expect(g.audit().find((a) => a.name === "t-switch-gated")!.state).toBe("failed");
    expect(g.audit().find((a) => a.name === "t-switch-gated")!.failReason).toContain("session.switch");
    expect(g.audit().find((a) => a.name === "t-mixed")!.state).toBe("active");
    await g.dispose();
  });

  it("③ 老宿主（三项都不注入）：ctx.session.fork/tree/switchTo 全 undefined——判空降级", async () => {
    const seen: Record<string, unknown> = {};
    const g = await load({
      modules: [
        defineModule({ name: "t-bare", version: "0.0.1", description: "x", api: 1, activate(ctx) { seen.fork = ctx.session.fork; seen.tree = ctx.session.tree; seen.switchTo = ctx.session.switchTo; } }),
      ],
    });
    expect(seen.fork).toBeUndefined();
    expect(seen.tree).toBeUndefined();
    expect(seen.switchTo).toBeUndefined();
    expect(g.audit().every((a) => a.state === "active")).toBe(true);
    await g.dispose();
  });

  it("④ harness 端到端注入：sessionSwitch 传入 → 模块经 ctx.session.switchTo 调到（mounts 列位）；未注入 = undefined", async () => {
    const { createHarness } = await import("../index.ts");
    const mk = (mod: ModuleDefinition, over: Parameters<typeof createHarness>[0]) =>
      createHarness({
        cwd: "/tmp/x", diagDir: "/tmp/x", spillDir: "/tmp/x/s", // 密封路径不真写（模块只读 switchTo 存在性）
        modules: [mod], config: { env: {}, cliOverrides: { model: "fake/x" } }, ...over,
      });
    let got: boolean | undefined;
    const calls: string[] = [];
    const h = await mk(
      defineModule({
        name: "t-sw", version: "0.0.1", description: "x", api: 1, mounts: ["session.switch"],
        async activate(ctx) { got = await ctx.session.switchTo?.("s_target"); },
      }),
      { sessionSwitch: async (sid) => { calls.push(sid); return true; } },
    );
    expect(got).toBe(true);
    expect(calls).toEqual(["s_target"]);
    await h.close();
    let bare: unknown = "unset";
    const h2 = await mk(
      defineModule({ name: "t-sw2", version: "0.0.1", description: "x", api: 1, activate(ctx) { bare = ctx.session.switchTo; } }),
      {},
    );
    expect(bare).toBeUndefined(); // 未注入（无头/老宿主）
    await h2.close();
  });
});
