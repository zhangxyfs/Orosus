import { describe, it, expect } from "vitest";
import { defineModule, type ModuleDefinition } from "@orosus/contracts/module";
import { defineTool } from "@orosus/contracts/tool";
import { z } from "zod";
import { InMemorySessionStore } from "../session/memory.ts";
import { loadModules } from "./kernel.ts";
import { parseModel } from "../provider/resolve.ts";
import type { DiagSink, DiagRecord } from "../diag/logger.ts";

const sink = (): DiagSink & { records: DiagRecord[] } => {
  const records: DiagRecord[] = [];
  return { records, write: (r) => void records.push(r), flush: () => Promise.resolve(), close: () => Promise.resolve() };
};

const mod = (name: string, extra: Partial<ModuleDefinition>): ModuleDefinition =>
  defineModule({ name, version: "0.1.0", description: name, api: 1, activate() {}, ...extra });

const tool = (name: string) =>
  defineTool({ name, description: name, parameters: z.object({}), resolveExecution: async () => ({ execute: async () => ({ output: "ok", isError: false }) }) });

describe("kernel 门面（§4.2 第 4–7 步串接）", () => {
  it("端到端：校验 → 拓扑 → 激活；graph.tools 可用；audit 含贡献摘要", async () => {
    const fs = mod("tool-fs", { provides: ["fs"], activate(ctx) { ctx.provide("fs", {}); ctx.contribute.tool(tool("tool-fs__read")); } });
    const shell = mod("tool-shell", { dependsOn: ["fs"], activate(ctx) { ctx.contribute.tool(tool("tool-shell__bash")); } });
    const g = await loadModules({
      defs: [{ def: shell, source: "builtin" }, { def: fs, source: "builtin" }],
      cli: {}, sections: new Map(), session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s",
    });
    expect(g.tools.list().map((t) => t.name)).toEqual(["tool-fs__read", "tool-shell__bash"]); // 拓扑序
    const audit = g.audit();
    expect(audit.every((a) => a.state === "active")).toBe(true);
    expect(audit.find((a) => a.name === "tool-fs")!.contributes.join(" ")).toContain("tool-fs__read");
    await g.dispose();
  });

  it("required = true 模块失败 → 阻断启动（§10 安全护栏）", async () => {
    const bad = mod("approval", { activate() { throw new Error("起不来"); } });
    await expect(
      loadModules({
        defs: [{ def: bad, source: "builtin" }],
        cli: {}, sections: new Map([["approval", { required: true }]]),
        session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s",
      }),
    ).rejects.toThrow(/required/);
  });

  it("catalog() 输出模块表（--dump-modules，§6.5）", async () => {
    const m = mod("m", { provides: ["m.x"], activate(ctx) { ctx.provide("m.x", {}); } });
    const g = await loadModules({
      defs: [{ def: m, source: "builtin" }], cli: {}, sections: new Map(),
      session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s",
    });
    const table = g.catalog();
    expect(table).toContain("name");
    expect(table).toContain("m");
    expect(table).toContain("active");
    expect(table).toContain("m.x");
    await g.dispose();
  });

  it("dispose 逆拓扑序：先停消费者（§5.2 规则 2 机制 5）", async () => {
    const order: string[] = [];
    const mk = (name: string, extra: Partial<ModuleDefinition>) =>
      mod(name, {
        ...extra,
        activate(ctx) {
          for (const key of extra.provides ?? []) ctx.provide(key, {}); // 声明了 provides 就真的 provide——级联判定按注册册诚实回溯
          return { dispose() { order.push(name); } };
        },
      });
    const g = await loadModules({
      defs: [
        { def: mk("tool-fs", { provides: ["fs"] }), source: "builtin" },
        { def: mk("tool-shell", { dependsOn: ["fs"] }), source: "builtin" },
      ],
      cli: {}, sections: new Map(), session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s",
    });
    await g.dispose();
    expect(order).toEqual(["tool-shell", "tool-fs"]);
    expect(g.records.filter((r) => r.state === "disposed").map((r) => r.name)).toEqual(["tool-fs", "tool-shell"]); // 审计可信：停用后不谎报 active
  });

  it("parseModel 解析 <provider>/<model>；裸名合法；空段抛错（D32）", () => {
    expect(parseModel("anthropic/claude-sonnet-4")).toEqual({ provider: "anthropic", model: "claude-sonnet-4" });
    expect(parseModel("没有斜杠")).toEqual({ provider: "没有斜杠", model: undefined });
    expect(() => parseModel("/x")).toThrow(/<provider>/);
    expect(() => parseModel("x/")).toThrow(/<provider>/);
  });
});

describe("catalogJson（T19，§6.5 机器可读导出）", () => {
  it("可解析且含全部 records 字段；两次导出字节稳定（§11.3 确定性）", async () => {
    const m = mod("m", { provides: ["m.x"], activate(ctx) { ctx.provide("m.x", {}); } });
    const g = await loadModules({
      defs: [{ def: m, source: "builtin" }], cli: {}, sections: new Map(),
      session: new InMemorySessionStore(), sink: sink(), spillDir: "/tmp/s",
    });
    const j1 = g.catalogJson();
    const j2 = g.catalogJson();
    expect(j1).toBe(j2); // 字节稳定
    const parsed = JSON.parse(j1) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ name: "m", source: "builtin", state: "active", generation: 1, provides: ["m.x"] });
    await g.dispose();
  });
});

describe("诊断日志增强（T7：failed 事件带堆栈/来源；级联与 staticFailed 补发射）", () => {
  it("① 激活抛错 → kernel.module.failed 的 data 含 stack（≤800）与 sourcePath（local·layer）", async () => {
    const s = sink();
    const bad = mod("bad-mod", { activate() { throw new Error("激活炸了"); } });
    const g = await loadModules({
      defs: [{ def: bad, source: "local", root: "/tmp/orosus/modules/bad-mod", layer: "user" }],
      cli: {}, sections: new Map(), session: new InMemorySessionStore(), sink: s, spillDir: "/tmp/s",
    });
    const failed = s.records.filter((r) => r.code === "kernel.module.failed");
    expect(failed).toHaveLength(1);
    const data = failed[0]!.data as Record<string, unknown>;
    expect(data["module"]).toBe("bad-mod");
    expect(String(data["sourcePath"])).toContain("local·user");
    expect(String(data["sourcePath"])).toContain("bad-mod");
    const stack = String(data["stack"]);
    expect(stack).toContain("Error"); // 栈顶可定位（不进 UI 只进日志，S12 截 800）
    expect(stack.length).toBeLessThanOrEqual(800);
    await g.dispose();
  });

  it("② topo 级联：提供者被禁用、B 硬依赖 → B 也有一条 kernel.module.failed（topo 层原本零发射）", async () => {
    const s = sink();
    const a = mod("prov-a", { provides: ["prov-a.cap"], activate() {} });
    const b = mod("cons-b", { dependsOn: ["prov-a.cap"], activate() {} });
    const g = await loadModules({
      defs: [{ def: b, source: "builtin" }, { def: a, source: "builtin" }],
      cli: {}, sections: new Map([["prov-a", { enabled: false }]]),
      session: new InMemorySessionStore(), sink: s, spillDir: "/tmp/s",
    });
    const failed = s.records.filter((r) => r.code === "kernel.module.failed");
    expect(failed).toHaveLength(1); // 只有 B（A 是禁用 discovered 非失败）
    const bRec = failed.find((r) => (r.data as Record<string, unknown>)["module"] === "cons-b");
    expect(bRec).toBeDefined();
    expect(bRec!.msg).toContain("无可用提供者"); // topo 降级文案（S4 级联判据第三形态的来源）
    await g.dispose();
  });

  it("③ 静态校验违规（provides key 非公共且缺模块名前缀）→ 也有一条 kernel.module.failed", async () => {
    const s = sink();
    const bad = mod("weird-mod", { provides: ["noprefix-key"] }); // 非公共能力、无 "weird-mod." 前缀 → 违规
    const g = await loadModules({
      defs: [{ def: bad, source: "builtin" }],
      cli: {}, sections: new Map(), session: new InMemorySessionStore(), sink: s, spillDir: "/tmp/s",
    });
    const hit = s.records.find((r) => r.code === "kernel.module.failed" && (r.data as Record<string, unknown>)["module"] === "weird-mod");
    expect(hit).toBeDefined(); // staticFailed 原本零日志发射（弹窗盲区）
    expect(hit!.msg).toContain("noprefix-key");
    await g.dispose();
  });
});
