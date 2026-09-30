import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import toolSearch from "@orosus/tool-search";
import { defineModule, type ModuleDefinition } from "@orosus/contracts/module";
import type { Chunk } from "@orosus/contracts/provider";
import { activateMcp, toBridgedTool, mcpDef } from "./index.ts";
import { applyLiveList } from "./bridge.ts";

let dir = "";
afterEach(() => { if (dir !== "") rmSync(dir, { recursive: true, force: true }); dir = ""; });
const tmp = () => (dir = mkdtempSync(join(tmpdir(), "orosus-mcp-def-")));

const fiveTools = Array.from({ length: 5 }, (_, i) => ({ name: `job${i}`, description: `作业工具 ${i} 号` }));

describe("mcp deferred 接线（M4-3 T5）", () => {
  it("T5-① schema：server 级 deferred:true 通过校验；非法类型被拒", () => {
    const schema = mcpDef.config!;
    const ok = schema.safeParse({ servers: { big: { command: "x", deferred: true } } });
    expect(ok.success).toBe(true);
    expect((ok as { data: { servers: { big: { deferred?: boolean } } } }).data.servers.big.deferred).toBe(true);
    expect(schema.safeParse({ servers: { big: { deferred: "yes" } } }).success).toBe(false);
  });

  it("T5-② 桥接透传：deferred server → 工具带 deferred:true；未标 → 无该字段", () => {
    const call = async () => ({ content: [] });
    const marked = toBridgedTool("big", { name: "t", description: "d" }, call, undefined, true);
    expect(marked.deferred).toBe(true);
    const plain = toBridgedTool("big", { name: "t", description: "d" }, call);
    expect(plain.deferred).toBeUndefined();
  });

  it("T5-③ activateMcp 级透传：deferred server 的全部桥接工具带标记（其余 server 不染）", async () => {
    const out = await activateMcp({
      servers: {
        big: { command: "x", deferred: true },
        small: { command: "y" },
      },
      connect: async (name) => ({
        listTools: async () => (name === "big" ? fiveTools : [{ name: "one", description: "d" }]),
        callTool: async () => ({ content: [] }),
      }),
      sessionAppend: () => {},
    });
    const bigTools = out.tools.filter((t) => t.name.startsWith("mcp__big__"));
    expect(bigTools).toHaveLength(5);
    expect(bigTools.every((t) => t.deferred === true)).toBe(true);
    expect(out.tools.find((t) => t.name === "mcp__small__one")?.deferred).toBeUndefined();
  });

  it("T5-④ 关态零差异（SW-26 联动钉）：tool-search 未启用时 deferred 标记不生效——点名照样执行不拦截", async () => {
    tmp();
    const fakeMcp = defineModule({
      name: "mcp", version: "0.1.0", description: "x", api: 1,
      async activate(ctx) {
        const out = await activateMcp({
          servers: { big: { command: "x", deferred: true } },
          connect: async () => ({
            listTools: async () => fiveTools,
            callTool: async (name) => ({ content: [{ type: "text", text: `ran:${name}` }] }),
          }),
          sessionAppend: () => {},
        });
        for (const t of out.tools) ctx.contribute.tool(t);
      },
    });
    // tool-search 在场但默认关（defaultEnabled:false）——机制整门不启，deferred 工具照常可调
    const script: Chunk[][] = [
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "mcp__big__job1", argumentsDelta: "{}" },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "好" }, { type: "finish", kind: "stop" }],
    ];
    const mem = new InMemorySessionStore();
    // 2026-09-30 默认翻开后关态须显式：[tool-search] enabled = false（机制整门不启，deferred 工具照常可调）
    writeFileSync(join(dir, "u.toml"), "[tool-search]\nenabled = false\n", "utf8");
    const h = await createHarness({
      store: mem,
      diagDir: dir, spillDir: join(dir, "spill"),
      modules: [fakeMcp, toolSearch, fakeProviderModule("fake", script)],
      config: { userFile: join(dir, "u.toml"), projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    await h.prompt("跑 job1");
    await h.close();
    const all = await mem.all();
    const r = all.find((e) => e.type === "tool/result" && e.callId === "c1");
    expect(String(r && JSON.stringify(r))).toContain("ran:job1"); // 关态：无「按需加载目录」拦截，直接执行
  });

  it("T5-⑤ 启用全链：目录只见名不见 schema → meta 搜出 reveal → 可调；未加载点名被拦截", async () => {
    tmp();
    // fake 模块：经 activateMcp 造 deferred 桥接工具并注册（等价 mcp 模块挂 deferred server 的产物）
    const fakeMcp = defineModule({
      name: "mcp", version: "0.1.0", description: "x", api: 1,
      async activate(ctx) {
        const out = await activateMcp({
          servers: { big: { command: "x", deferred: true } },
          connect: async () => ({
            listTools: async () => fiveTools,
            callTool: async (name) => ({ content: [{ type: "text", text: `ran:${name}` }] }),
          }),
          sessionAppend: () => {},
        });
        for (const t of out.tools) ctx.contribute.tool(t);
      },
    });
    const userFile = join(dir, "u.toml");
    writeFileSync(userFile, "[tool-search]\nenabled = true\n", "utf8");
    const script: Chunk[][] = [
      [
        { type: "toolcall/argumentsDelta", callId: "c0", name: "mcp__big__job0", argumentsDelta: "{}" }, // 未加载点名 → 应被拦截
        { type: "finish", kind: "toolUse" },
      ],
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "tool-search__search", argumentsDelta: JSON.stringify({ query: "作业" }) },
        { type: "finish", kind: "toolUse" },
      ],
      [
        { type: "toolcall/argumentsDelta", callId: "c2", name: "mcp__big__job0", argumentsDelta: "{}" }, // reveal 后 → 应放行执行
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "完成" }, { type: "finish", kind: "stop" }],
    ];
    const mem = new InMemorySessionStore();
    const h = await createHarness({
      store: mem,
      diagDir: dir, spillDir: join(dir, "spill"),
      modules: [fakeMcp, toolSearch, fakeProviderModule("fake", script)],
      config: { userFile, projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    await h.prompt("跑作业工具");
    await h.close();
    const all = await mem.all();
    const blocked = all.find((e) => e.type === "tool/result" && e.callId === "c0");
    expect(String(blocked && JSON.stringify(blocked))).toContain("这个工具可用但未加载"); // 未加载拦截生效（T19③ 新句式）
    const searchResult = all.find((e) => e.type === "tool/result" && e.callId === "c1");
    expect(String(searchResult && JSON.stringify(searchResult))).toContain("已加载：mcp__big__job0");
    const ran = all.find((e) => e.type === "tool/result" && e.callId === "c2");
    expect(String(ran && JSON.stringify(ran))).toContain("ran:job0"); // reveal 后调用放行
  });

  it("T5-⑥ 目录段：启用后 hidden 列表可见（只知名+截断描述），select: 直选后条目消失", async () => {
    tmp();
    const fakeMcp = defineModule({
      name: "mcp", version: "0.1.0", description: "x", api: 1,
      async activate(ctx) {
        const out = await activateMcp({
          servers: { big: { command: "x", deferred: true } },
          connect: async () => ({ listTools: async () => fiveTools, callTool: async (name) => ({ content: [{ type: "text", text: `ran:${name}` }] }) }),
          sessionAppend: () => {},
        });
        for (const t of out.tools) ctx.contribute.tool(t);
      },
    });
    const userFile = join(dir, "u.toml");
    writeFileSync(userFile, "[tool-search]\nenabled = true\n", "utf8");
    const script: Chunk[][] = [
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "tool-search__search", argumentsDelta: JSON.stringify({ query: "select:mcp__big__job2" }) },
        { type: "finish", kind: "toolUse" },
      ],
      [
        { type: "toolcall/argumentsDelta", callId: "c2", name: "mcp__big__job2", argumentsDelta: "{}" }, // 直选 reveal 后点名 → 放行
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "好" }, { type: "finish", kind: "stop" }],
    ];
    const mem = new InMemorySessionStore();
    const h = await createHarness({
      store: mem,
      diagDir: dir, spillDir: join(dir, "spill"),
      modules: [fakeMcp, toolSearch, fakeProviderModule("fake", script)],
      config: { userFile, projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    await h.prompt("加载 job2");
    await h.close();
    const all = await mem.all();
    const searchResult = all.find((e) => e.type === "tool/result" && e.callId === "c1");
    expect(String(searchResult && JSON.stringify(searchResult))).toContain("已加载：mcp__big__job2");
    const ran = all.find((e) => e.type === "tool/result" && e.callId === "c2");
    expect(String(ran && JSON.stringify(ran))).toContain("ran:job2"); // select 直选 reveal → 点名放行
  });

  it("T5-⑦ mcp 模块自身配置面：[mcp] servers.big.deferred 进 ctx.config（schema→activate 链路钉）", async () => {
    tmp();
    let seen: unknown;
    // 整体复用 mcpDef 只换 activate（exactOptionalPropertyTypes 下重传 schema 泛型摩擦的规避）
    const probe: ModuleDefinition = { ...mcpDef, activate(ctx) { seen = ctx.config; } };
    const userFile = join(dir, "u.toml");
    writeFileSync(userFile, "[mcp.servers.big]\ncommand = \"x\"\ndeferred = true\n", "utf8");
    const h = await createHarness({
      store: new InMemorySessionStore(),
      diagDir: dir, spillDir: join(dir, "spill"),
      modules: [probe, fakeProviderModule("fake", [])],
      config: { userFile, projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    await h.close();
    expect(seen).toEqual({ servers: { big: { command: "x", deferred: true } } });
  });
});

describe("懒启动实况 schema 补丁（2026-09-30 修「模型看不到参数面」——静态清单注册的工具无 inputSchema，首连后取实况 listTools 就地换 parameters）", () => {
  const runTool = async (tool: { resolveExecution(i: unknown): Promise<{ execute(ctx: unknown): Promise<{ output: string }> }> }, args: unknown): Promise<string> => {
    const plan = await tool.resolveExecution(args);
    return (await plan.execute({ callId: "t", signal: new AbortController().signal, log: { info: () => {}, warn: () => {}, error: () => {} } } as never)).output;
  };

  it("⑧ applyLiveList：实况 schema 就地补进（描述保留策展版）、漂移双向报告", () => {
    const call = async () => ({ content: [] });
    const tools = [
      toBridgedTool("ctx7", { name: "resolve-library-id", description: "解析库名" }, call),
      toBridgedTool("ctx7", { name: "legacy-tool", description: "静态钉版旧名" }, call),
    ];
    expect(JSON.stringify(z.toJSONSchema(tools[0]!.parameters))).not.toContain("libraryName"); // 补丁前：空参数面
    const r = applyLiveList(tools, "ctx7", [
      { name: "resolve-library-id", description: "live english desc", inputSchema: { type: "object", properties: { libraryName: { type: "string" }, query: { type: "string" } }, required: ["libraryName"] } },
      { name: "brand-new", description: "实况多出" },
    ]);
    expect(r.applied).toEqual(["resolve-library-id"]);
    expect(r.liveExtra).toEqual(["brand-new"]);
    expect(r.stale).toEqual(["mcp__ctx7__legacy-tool"]);
    const schema = z.toJSONSchema(tools[0]!.parameters) as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties !== undefined && "libraryName" in schema.properties && "query" in schema.properties).toBe(true);
    expect(schema.required).toEqual(["libraryName"]);
    expect(tools[0]!.description).toContain("解析库名"); // 描述保留静态策展版——不被实况英文覆盖
    // 补丁后的 parameters 仍宽松收参（server 侧校验才是权威——本地不误拒）
    expect(tools[0]!.parameters.safeParse({ extra: 1 }).success).toBe(true);
  });

  it("⑨ onLive 全链：首调触发一次（不阻塞调用）、实况清单到手换血即生效、二次调用不重触发", async () => {
    const live = [
      { name: "resolve-library-id", description: "d", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    ];
    const events: Array<{ name: string; list: typeof live; error?: string }> = [];
    let listCalls = 0;
    const out = await activateMcp({
      servers: { ctx7: { command: "x", lazy: true } },
      connect: async () => { throw new Error("不应走非惰性连接"); },
      sessionAppend: () => {},
      lazy: {
        manifestFor: () => [{ name: "resolve-library-id", description: "解析库名" }],
        connect: async () => ({
          listTools: async () => { listCalls++; return live; },
          callTool: async (name: string) => ({ content: [{ type: "text", text: `ran:${name}` }] }),
        }),
        onStarted: () => {},
        onLive: (name, list, error) => { events.push({ name, list: list as typeof live, ...(error !== undefined ? { error } : {}) }); },
      },
    });
    const tool = out.tools.find((t) => t.name === "mcp__ctx7__resolve-library-id")!;
    expect(await runTool(tool, {})).toContain("ran:resolve-library-id"); // 首调照常返回（listTools 旁路不阻塞）
    await new Promise((res) => setTimeout(res, 20));
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("ctx7");
    expect(events[0]!.list).toBe(live);
    applyLiveList(out.tools, "ctx7", events[0]!.list); // 宿主侧换血（镜像 mcpDef onLive 体）
    const schema = z.toJSONSchema(tool.parameters) as { properties?: Record<string, unknown> };
    expect(schema.properties !== undefined && "query" in schema.properties).toBe(true); // 下一轮 specs 即带参数面
    await runTool(tool, {});
    await new Promise((res) => setTimeout(res, 10));
    expect(events).toHaveLength(1); // 连接 memoized——onLive 不重触发
    expect(listCalls).toBe(1);
  });

  it("⑩ onLive 失败路径：listTools 拒绝 → error 回调空清单，静态清单维持不断（不升级为报错）", async () => {
    const events: Array<{ list: unknown[]; error?: string }> = [];
    const out = await activateMcp({
      servers: { ctx7: { command: "x", lazy: true } },
      connect: async () => { throw new Error("不应走非惰性连接"); },
      sessionAppend: () => {},
      lazy: {
        manifestFor: () => [{ name: "t", description: "d" }],
        connect: async () => ({
          listTools: async () => { throw new Error("boom"); },
          callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
        }),
        onStarted: () => {},
        onLive: (_name, list, error) => { events.push({ list, ...(error !== undefined ? { error } : {}) }); },
      },
    });
    expect(await runTool(out.tools[0]!, {})).toContain("ok"); // 调用不受 listTools 失败株连
    await new Promise((res) => setTimeout(res, 20));
    expect(events).toHaveLength(1);
    expect(events[0]!.error).toBe("boom");
    expect(events[0]!.list).toEqual([]);
  });
});
