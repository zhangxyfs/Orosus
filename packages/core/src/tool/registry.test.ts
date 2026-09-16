import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "@orosus/contracts/tool";
import { createEventBus, CORE_POINTS } from "../kernel/bus.ts";
import { createToolRegistry, OUTPUT_LIMIT } from "./registry.ts";
import type { DiagSink, DiagRecord } from "../diag/logger.ts";

const sink = (): DiagSink & { records: DiagRecord[] } => {
  const records: DiagRecord[] = [];
  return { records, write: (r) => void records.push(r), flush: () => Promise.resolve(), close: () => Promise.resolve() };
};

const echo = (name: string, out = "ok") =>
  defineTool({
    name,
    description: name,
    parameters: z.object({}),
    resolveExecution: async () => ({ execute: async () => ({ output: out, isError: false }) }),
  });

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const setup = () => {
  dir = mkdtempSync(join(tmpdir(), "orosus-spill-"));
  const s = sink();
  const bus = createEventBus(s);
  return { bus, reg: createToolRegistry({ bus, sink: s, spillDir: dir }), s };
};

describe("工具注册表（§6.3）", () => {
  it("注册名校验：必须 <owner>__ 前缀；重名拒绝（规则 4）", () => {
    const { reg } = setup();
    expect(() => reg.register(echo("other__x"), "tool-a")).toThrow(/前缀/);
    reg.register(echo("tool-a__x"), "tool-a");
    expect(() => reg.register(echo("tool-a__x"), "tool-a")).toThrow(/重名/);
  });

  it("specs() 产出 JSON Schema 且按注册序冻结", () => {
    const { reg } = setup();
    reg.register(echo("b__t"), "b");
    reg.register(echo("a__t"), "a");
    const specs = reg.specs();
    expect(specs.map((s) => s.name)).toEqual(["b__t", "a__t"]); // 注册序 = 激活拓扑序
    expect(specs[0]!.parameters.type).toBe("object");
  });

  it("run：参数校验失败 → isError；未知工具 → isError", async () => {
    const { reg } = setup();
    reg.register(
      defineTool({
        name: "m__t",
        description: "t",
        parameters: z.object({ n: z.number() }),
        resolveExecution: async () => ({ execute: async () => ({ output: "ok", isError: false }) }),
      }),
      "m",
    );
    const bad = await reg.run({ id: "c1", name: "m__t", args: { n: "不是数字" } }, { signal: new AbortController().signal });
    expect(bad.isError).toBe(true);
    const missing = await reg.run({ id: "c2", name: "m__ghost", args: {} }, { signal: new AbortController().signal });
    expect(missing.isError).toBe(true);
  });

  it("waterfall 否决 → denied + isError，execute 未被调用（fail-closed）", async () => {
    const { reg, bus } = setup();
    let executed = false;
    bus.on(CORE_POINTS.toolPreExecute, () => ({ deny: true, reason: "审批拒绝" }), "approval");
    reg.register(
      defineTool({
        name: "m__t",
        description: "t",
        parameters: z.object({}),
        resolveExecution: async () => ({ execute: async () => { executed = true; return { output: "x", isError: false }; } }),
      }),
      "m",
    );
    const r = await reg.run({ id: "c1", name: "m__t", args: {} }, { signal: new AbortController().signal });
    expect(r).toEqual({ output: "审批拒绝", isError: true, denied: true });
    expect(executed).toBe(false);
  });

  it("execute 抛错 → 带内 isError（§10 工具执行失败行）", async () => {
    const { reg } = setup();
    reg.register(
      defineTool({
        name: "m__boom",
        description: "t",
        parameters: z.object({}),
        resolveExecution: async () => ({ execute: async () => { throw new Error("炸了"); } }),
      }),
      "m",
    );
    const r = await reg.run({ id: "c1", name: "m__boom", args: {} }, { signal: new AbortController().signal });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("炸了");
  });

  it("超长输出截断 + 溢写 spill 文件（0o600）", async () => {
    const { reg } = setup();
    reg.register(echo("m__big", "y".repeat(OUTPUT_LIMIT + 5000)), "m");
    const r = await reg.run({ id: "c1", name: "m__big", args: {} }, { signal: new AbortController().signal });
    expect(r.truncated).toBe(true);
    expect(r.spill).toBeDefined();
    expect(r.spill!.bytes).toBe(OUTPUT_LIMIT + 5000);
    expect(readFileSync(r.spill!.path, "utf8")).toBe("y".repeat(OUTPUT_LIMIT + 5000));
    expect(r.output.length).toBeLessThan(OUTPUT_LIMIT + 5000);
  });

  it("register 返回 disposer：注销后工具消失（规则 3）", () => {
    const { reg } = setup();
    const off = reg.register(echo("m__t"), "m");
    expect(reg.list()).toHaveLength(1);
    off();
    expect(reg.list()).toHaveLength(0);
  });
});
