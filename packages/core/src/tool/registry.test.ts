import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, Access } from "@orosus/contracts/tool";
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

  it("plan/execute（D40）：plan 产出声明；execute 走 waterfall 后执行（matchesRule 透传断言归 T2）", async () => {
    const { reg, bus } = setup();
    reg.register(
      defineTool({
        name: "m__t",
        description: "t",
        parameters: z.object({}),
        resolveExecution: async () => ({
          accesses: [Access.fsWrite("/w")],
          approvalRule: "m__t(git *)",
          execute: async () => ({ output: "done", isError: false }),
        }),
      }),
      "m",
    );
    const planned = await reg.plan({ id: "c1", name: "m__t", args: {} });
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.accesses).toEqual([Access.fsWrite("/w")]);
      expect(planned.approvalRule).toBe("m__t(git *)");
    }
    const vetoes: unknown[] = [];
    bus.on(CORE_POINTS.toolPreExecute, (p) => { vetoes.push(p); }, "approval");
    const result = await reg.execute(planned, { signal: new AbortController().signal });
    expect(result).toMatchObject({ output: "done", isError: false });
    expect(vetoes).toHaveLength(1);
  });

  it("plan/execute（D40）：墓碑/未知/校验失败 → ok:false，execute 直落结果不触发 waterfall", async () => {
    const { reg, bus } = setup();
    reg.register(
      defineTool({
        name: "m__t",
        description: "t",
        parameters: z.object({ n: z.number() }),
        resolveExecution: async () => ({ execute: async () => ({ output: "ok", isError: false }) }),
      }),
      "m",
    );
    const vetoes: unknown[] = [];
    bus.on(CORE_POINTS.toolPreExecute, (p) => { vetoes.push(p); }, "approval");
    const bad = await reg.plan({ id: "c1", name: "m__t", args: { n: "x" } }); // 校验失败
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.result.isError).toBe(true);
    expect((await reg.execute(bad, { signal: new AbortController().signal })).isError).toBe(true);
    const unknown = await reg.plan({ id: "c2", name: "m__nope", args: {} });
    expect(unknown.ok).toBe(false);
    expect(vetoes).toHaveLength(0); // 三类短路都不触发 waterfall
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

describe("工具输出截断头尾双保留 3:1（M4-2.5 T1——日志调研 P3）", () => {
  const runBig = async (out: string) => {
    const { reg } = setup();
    reg.register(echo("m__big", out), "m");
    return reg.run({ id: "c1", name: "m__big", args: {} }, { signal: new AbortController().signal });
  };

  it("① 超限输出 → 头部与尾部都在、中缝有溢写提示（报错尾不被截掉）", async () => {
    const mid = "y".repeat(40_000 - "HEADMARK".length - "TAILMARK".length);
    const r = await runBig(`HEADMARK${mid}TAILMARK`);
    expect(r.truncated).toBe(true);
    expect(r.spill).toBeDefined();
    expect(r.spill!.bytes).toBe(40_000);
    expect(readFileSync(r.spill!.path, "utf8")).toBe(`HEADMARK${mid}TAILMARK`); // spill 含全文
    expect(r.output.startsWith("HEADMARK")).toBe(true); // 头部保留
    expect(r.output.endsWith("TAILMARK")).toBe(true); // 尾部保留（修复前被截掉）
    expect(r.output).toContain("中间截断"); // 中缝提示
    expect(r.output).toContain(r.spill!.path);
  });

  it("② 未超限输出 → 原样（零改动路径回归）", async () => {
    const r = await runBig("x".repeat(1024));
    expect(r.truncated).toBeUndefined();
    expect(r.spill).toBeUndefined();
    expect(r.output).toBe("x".repeat(1024));
  });

  it("③ 头 24576 + 尾 8192——两段相加不超信封（32768+提示行）", async () => {
    const r = await runBig("z".repeat(OUTPUT_LIMIT + 1)); // 恰好超限 1 字符
    expect(r.output).toContain("中间截断 1 字符");
    expect(r.output.length).toBeLessThanOrEqual(OUTPUT_LIMIT + 100); // 头+尾+提示行不超信封
  });
});

// M4-3 T4：ToolSearch 机制层（deferred 过滤 / reveal / 未加载拦截 / SW-26 关态整门不启）
describe("ToolSearch 机制层（M4-3 T4）", () => {
  const deferredEcho = (name: string, hint?: string) =>
    defineTool({
      name,
      description: `${name} 的描述`,
      ...(hint !== undefined ? { searchHint: hint } : {}),
      deferred: true,
      parameters: z.object({}),
      resolveExecution: async () => ({ execute: async () => ({ output: "ok", isError: false }) }),
    });

  it("T4-① 零差异基线：关态（机制未启用）下 deferred 标记不生效——specs 全出逐字节不变", () => {
    const { reg } = setup();
    reg.register(echo("a__plain"), "a");
    reg.register(deferredEcho("m__hidden"), "m");
    const names = reg.specs().map((s) => s.name);
    expect(names).toEqual(["a__plain", "m__hidden"]); // 关态 = specs 零过滤（SW-26——标记形同虚设）
  });

  it("T4-② 启用后藏 deferred 未 reveal；reveal 下一轮 specs 带出（SW-11 当轮不生效、下一轮生效语义）", () => {
    const { reg } = setup();
    reg.register(echo("a__plain"), "a");
    reg.register(deferredEcho("m__one"), "m");
    reg.register(deferredEcho("m__two"), "m");
    reg.setDeferredEnabled(true);
    expect(reg.specs().map((s) => s.name)).toEqual(["a__plain"]);
    reg.revealTools(["m__one", "m__ghost"]); // 未知名静默跳过（契约口径）
    expect(reg.specs().map((s) => s.name)).toEqual(["a__plain", "m__one"]);
    expect(reg.specs().map((s) => s.name)).toEqual(["a__plain", "m__one"]); // 集合保持（二次读取不清）
  });

  it("T4-③ plan 拦截：deferred 未 reveal → 带内指路 meta 工具；reveal 后放行；关态拦截不生效", async () => {
    const { reg } = setup();
    reg.register(deferredEcho("m__lazy"), "m");
    // 关态：标记不生效——plan 照常（SW-26 联动）
    const off = await reg.plan({ id: "c1", name: "m__lazy", args: {} });
    expect(off.ok).toBe(true);
    reg.setDeferredEnabled(true);
    const blocked = await reg.plan({ id: "c2", name: "m__lazy", args: {} });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.result.isError).toBe(true);
      expect(blocked.result.output).toContain("按需加载目录");
      expect(blocked.result.output).toContain("tool-search__search");
    }
    reg.revealTools(["m__lazy"]);
    const ok = await reg.plan({ id: "c3", name: "m__lazy", args: {} });
    expect(ok.ok).toBe(true);
  });

  it("T4-④ 墓碑位不动：deferred + tombstoned 的工具仍留 specs（§5.5 字节稳定优先于隐藏）", () => {
    const { reg } = setup();
    reg.register(deferredEcho("m__dead"), "m");
    reg.setDeferredEnabled(true);
    reg.tombstone("m__dead");
    expect(reg.specs().map((s) => s.name)).toEqual(["m__dead"]); // 墓碑不藏
  });

  it("T4-⑤ toolInfos：目录条目（不给 schema）+ deferredOnly 过滤 + revealed 态 + 墓碑剔除", () => {
    const { reg } = setup();
    reg.register(echo("a__plain"), "a");
    reg.register(deferredEcho("m__x", "备选关键词"), "m");
    reg.register(deferredEcho("m__y"), "m");
    reg.setDeferredEnabled(true);
    reg.revealTools(["m__x"]);
    const all = reg.toolInfos();
    expect(all.find((t) => t.name === "m__x")).toMatchObject({ deferred: true, revealed: true, owner: "m", searchHint: "备选关键词" });
    expect(all.find((t) => t.name === "a__plain")).toMatchObject({ deferred: false, revealed: false });
    const deferredOnly = reg.toolInfos({ deferredOnly: true });
    expect(deferredOnly.map((t) => t.name).sort()).toEqual(["m__x", "m__y"]);
    reg.tombstone("m__y");
    expect(reg.toolInfos({ deferredOnly: true }).map((t) => t.name)).toEqual(["m__x"]); // 墓碑剔除出目录
    expect(all[0]).not.toHaveProperty("parameters");
  });

  it("label 透传（2026-09-24 用户拍板——工具行显示名）：设了进 ToolInfo，没设字段缺席（宿主回落剥前缀）", () => {
    const { reg } = setup();
    reg.register(defineTool({
      name: "tool-web__search", description: "s", label: "Web Search",
      parameters: z.object({}),
      resolveExecution: async () => ({ execute: async () => ({ output: "ok", isError: false }) }),
    }), "tool-web");
    reg.register(echo("tool-fs__read"), "tool-fs");
    const infos = reg.toolInfos();
    expect(infos.find((t) => t.name === "tool-web__search")!.label).toBe("Web Search");
    expect(infos.find((t) => t.name === "tool-fs__read")).not.toHaveProperty("label"); // 缺省 = 无键（exactOptionalPropertyTypes 口径）
  });
});
