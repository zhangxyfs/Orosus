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

  it("parseModel 解析 <provider>/<model>；格式错抛错", () => {
    expect(parseModel("anthropic/claude-sonnet-4")).toEqual({ provider: "anthropic", model: "claude-sonnet-4" });
    expect(() => parseModel("没有斜杠")).toThrow(/<provider>\/<model>/);
  });
});
