// T20（m4-3c）：预装五件按需启动——惰性机制（activate 零连接/首调才起/memo 复用/失败可重试）+
// 工具注册门控（tool-search 显式启用才注册——关态 deferred 不生效防灌爆）+ 合并优先级。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import { activateMcp, mcpDef, type ActivateMcpOpts, type McpCatalogRow } from "./index.ts";
import { MCP_PRELOADS, shouldRegisterPreloadTools, isPreloadName, readPreloadSchemaCache, writePreloadSchemaCache, withCachedSchemas, preloadSchemaCacheFile } from "./preload.ts";
import { BUNDLED_PRELOAD_SCHEMAS } from "./preload-schemas.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `orosus-mcp-t20-${tag}-`));
  dirs.push(d);
  return d;
};

const manifest = [{ name: "remember", description: "记住" }, { name: "recall", description: "回忆" }];

describe("T20 惰性机制（activate 零连接、首调才起、memo 复用、失败可重试、dispose 只关已起）", () => {
  const started: string[] = [];
  const lazyDeps = (failFirst = false): Pick<ActivateMcpOpts, "lazy"> => {
    let calls = 0;
    return {
      lazy: {
        manifestFor: (name) => (name === "mem" ? manifest : undefined),
        connect: async (name) => {
          calls += 1;
          started.push(`${name}:${calls}`);
          if (failFirst && calls === 1) throw new Error("npx 下载失败");
          return {
            listTools: async () => manifest as never,
            callTool: async (t: string) => ({ content: [{ type: "text", text: `ran:${t}:${calls}` }] }),
            close: async () => { started.push(`closed:${name}`); },
          };
        },
        onStarted: () => {},
      },
    };
  };

  it("① activate 零连接：lazy server 不触发 connect（急连 server 正常连），工具来自静态清单且带 deferred", async () => {
    const eagerConn = { listTools: async () => [{ name: "e", description: "d" }], callTool: async () => ({ content: [] }), close: async () => {} };
    const out = await activateMcp({
      servers: {
        eager: { command: "x" },
        mem: { command: "y", lazy: true, deferred: true },
      },
      connect: async (name) => { if (name === "eager") return eagerConn; throw new Error("lazy 不该走急连口"); },
      sessionAppend: () => {},
      ...lazyDeps(),
    });
    expect(started).toEqual([]); // 零连接
    const memTools = out.tools.filter((t) => t.name.startsWith("mcp__mem__"));
    expect(memTools.map((t) => t.name).sort()).toEqual(["mcp__mem__recall", "mcp__mem__remember"]);
    expect(memTools.every((t) => t.deferred === true)).toBe(true);
    expect(out.tools.some((t) => t.name === "mcp__eager__e")).toBe(true);
    expect(out.connected.find((c) => c.name === "mem")?.tools).toEqual(["remember", "recall"]); // 清单行可见（T11③）
    await out.close();
    expect(started).toEqual([]); // 未起过——dispose 零操作
  });

  it("② 首调才起 + memo 复用：两次调用只 connect 一次；第三次调用走同一连接", async () => {
    const out = await activateMcp({
      servers: { mem: { command: "y", lazy: true } },
      connect: async () => { throw new Error("不该走急连"); },
      sessionAppend: () => {},
      ...lazyDeps(),
    });
    const remember = out.tools.find((t) => t.name === "mcp__mem__remember")!;
    const r1 = await (await remember.resolveExecution({})).execute({ callId: "c", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
    expect(r1.output).toBe("ran:remember:1");
    const r2 = await (await remember.resolveExecution({})).execute({ callId: "c", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
    expect(r2.output).toBe("ran:remember:1"); // 同一连接（calls 只在 connect 时递增——两次调用同后缀 = 复用）
    expect(started.filter((s) => s.startsWith("mem:"))).toEqual(["mem:1"]); // 只起过一次
    await out.close();
    expect(started).toContain("closed:mem"); // 起过的被 dispose 收尾
  });

  it("③ 首启失败：报错带因、memo 清空（下次调用重试）；onStarted 收到 failed", async () => {
    const states: Array<[string, string]> = [];
    const deps = lazyDeps(true);
    deps.lazy!.onStarted = (name, state) => { states.push([name, state]); };
    const out = await activateMcp({
      servers: { mem: { command: "y", lazy: true } },
      connect: async () => { throw new Error("不该走急连"); },
      sessionAppend: () => {},
      ...deps,
    });
    const remember = out.tools.find((t) => t.name === "mcp__mem__remember")!;
    const exec = async (): Promise<{ output: string; isError: boolean }> =>
      (await remember.resolveExecution({})).execute({ callId: "c", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
    const r1 = await exec();
    expect(r1.isError).toBe(true);
    expect(r1.output).toContain("npx 下载失败");
    const r2 = await exec(); // 重试成功
    expect(r2.isError).toBe(false);
    expect(states).toEqual([["mem", "failed"], ["mem", "connected"]]);
    await out.close();
  });

  it("④ 无静态清单的 lazy server 记失败（人话原因）", async () => {
    const out = await activateMcp({
      servers: { ghost: { command: "y", lazy: true } },
      connect: async () => { throw new Error("不该走急连"); },
      sessionAppend: () => {},
      ...lazyDeps(),
    });
    expect(out.failedServers).toEqual([{ name: "ghost", reason: expect.stringContaining("静态清单") }]);
  });

  it("④b 手动启动口 startLazy（2026-09-30「待启动态按启停=被停用」陷阱修）：触发连接且 memoized（两次启动一次连接）、未知名拒绝、非懒已连即答", async () => {
    const out = await activateMcp({
      servers: { mem: { command: "x", lazy: true }, api: { command: "y" } },
      connect: async () => ({ listTools: async () => [{ name: "ping", description: "d" }], callTool: async () => ({ content: [] }) }),
      sessionAppend: () => {},
      ...lazyDeps(),
    });
    const before = started.length;
    await out.startLazy("mem");
    await out.startLazy("mem"); // memoized——与首调共用同一连接 promise
    expect(started.length - before).toBe(1);
    await expect(out.startLazy("ghost")).rejects.toThrow("懒启动");
    await out.startLazy("api"); // 非懒 activate 已连——即答不炸
    await out.close();
  });
});

describe("T20 预装清单与门控", () => {
  it("⑤ 五件齐：memory/context7/github/everything/puppeteer；github 描述含 GITHUB_TOKEN 引导、puppeteer 含截图占位说明", () => {
    expect(MCP_PRELOADS.map((p) => p.name).sort()).toEqual(["context7", "everything", "github", "memory", "puppeteer"]);
    expect(MCP_PRELOADS.find((p) => p.name === "github")!.desc).toContain("GITHUB_TOKEN");
    expect(MCP_PRELOADS.find((p) => p.name === "puppeteer")!.desc).toContain("占位");
    expect(MCP_PRELOADS.every((p) => p.command === "npx" && p.args.length > 0)).toBe(true);
    expect(MCP_PRELOADS.every((p) => p.manifest.length > 0)).toBe(true);
    expect(isPreloadName("memory")).toBe(true);
    expect(isPreloadName("mine")).toBe(false);
  });

  it("⑤b 出厂默认参数结构（2026-09-30 实况抓取烤码 + 清单名对齐实况）：四件可抓 server 的每个清单工具都有 bundled schema 且带 properties（github 无令牌豁免——首连落盘补）；清单名与 bundled 键互相对齐", () => {
    for (const pl of MCP_PRELOADS) {
      const bundled = BUNDLED_PRELOAD_SCHEMAS[pl.name];
      if (pl.name === "github") {
        expect(bundled === undefined || Object.keys(bundled).length === 0).toBe(true); // 无令牌未捕获——空是事实不是回归
        continue;
      }
      expect(bundled !== undefined).toBe(true);
      for (const m of pl.manifest) {
        const schema = bundled![m.name];
        if (schema === undefined) throw new Error(`${pl.name}.${m.name} 缺出厂 schema（新机器冷进程会盲发）`);
        // type:object + properties 键在场（空 properties 合法 = 真·无参工具——「无参数」本身就是正确信息）
        expect(schema.type === "object" && typeof schema.properties === "object").toBe(true);
      }
      const extra = Object.keys(bundled!).filter((k) => !pl.manifest.some((m) => m.name === k));
      expect(extra).toEqual([]); // bundled 不夹带清单外名字（烤码时按清单过滤）
    }
  });

  it("⑥ 门控 shouldRegisterPreloadTools：默认 true（2026-09-30 翻转）；显式 false 关（modules.d 优先于 config.toml）；老 config.toml 同款认", () => {
    const home = tmp("gate");
    expect(shouldRegisterPreloadTools(home)).toBe(true); // 无配置 = 默认开——预装开箱即用
    mkdirSync(join(home, "modules.d"), { recursive: true });
    writeFileSync(join(home, "modules.d", "tool-search.toml"), "[tool-search]\nenabled = false\n", "utf8");
    expect(shouldRegisterPreloadTools(home)).toBe(false); // 显式关 = 逃生口（预装不注册工具防灌爆）
    writeFileSync(join(home, "config.toml"), "[tool-search]\nenabled = true\n", "utf8");
    expect(shouldRegisterPreloadTools(home)).toBe(false); // modules.d 显式值优先（m4-8 新家 > 老家）
    rmSync(join(home, "modules.d", "tool-search.toml"));
    expect(shouldRegisterPreloadTools(home)).toBe(true); // 老家 true 生效
    writeFileSync(join(home, "config.toml"), "[tool-search]\nenabled = false\n", "utf8");
    expect(shouldRegisterPreloadTools(home)).toBe(false); // 老家显式关同款认
    // 坏文件当未配置（回落默认开）
    const home2 = tmp("gate2");
    writeFileSync(join(home2, "config.toml"), "坏 TOML", "utf8");
    expect(shouldRegisterPreloadTools(home2)).toBe(true);
  });

  it("⑦ 同名空壳覆盖自愈（2026-09-30 实机 memory 弄残事故）：用户层 enabled:true 空壳不再顶掉预装——工具照注册、catalog 报 preload/待启动；enabled:false 空壳维持停用", async () => {
    const home = tmp("heal-home");
    const prevHome = process.env.OROSUS_HOME;
    process.env.OROSUS_HOME = home; // mcpDef 的 shouldRegisterPreloadTools/orosusHome 走隔离家（默认开）
    try {
      const d = tmp("heal");
      const userFile = join(d, "u.toml");
      writeFileSync(userFile, "[mcp.servers.memory]\nenabled = true\n", "utf8"); // 旧 on-bug 弄残的壳：无 command
      const h = await createHarness({
        store: new InMemorySessionStore(),
        diagDir: d, spillDir: join(d, "spill"),
        modules: [mcpDef, fakeProviderModule("fake", [])],
        config: { userFile, projectFile: join(d, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
      });
      const names = h.graph().tools.toolInfos().map((t) => t.name);
      expect(names).toContain("mcp__memory__search_nodes"); // 空壳没顶掉预装——工具在（自愈）
      const cat = await h.graph().services.getOptional("mcp.catalog");
      expect(typeof cat).toBe("function");
      // mcp.start 服务挂载钉（2026-09-30 启动口）：在座且可调——未知名拒绝（真启动会拉 npx 进程，不在单测里做）
      const start = await h.graph().services.getOptional("mcp.start");
      expect(typeof start).toBe("function");
      await expect((start as (name: string) => Promise<void>)("no-such-server")).rejects.toThrow("懒启动");
      const rows = (cat as () => McpCatalogRow[])();
      const mem = rows.find((r) => r.name === "memory");
      expect(mem?.source).toBe("preload"); // 定源预装（不再被用户层同名误标 config）
      expect(mem?.state).toBe("idle"); // 待启动——不是「失败」
      await h.close();
      // enabled:false 空壳 = 停用覆盖——语义不变（预装配置照供但不启用）
      writeFileSync(userFile, "[mcp.servers.memory]\nenabled = false\n", "utf8");
      const h2 = await createHarness({
        store: new InMemorySessionStore(),
        diagDir: d, spillDir: join(d, "spill2"),
        modules: [mcpDef, fakeProviderModule("fake", [])],
        config: { userFile, projectFile: join(d, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
      });
      const names2 = h2.graph().tools.toolInfos().map((t) => t.name);
      expect(names2).not.toContain("mcp__memory__search_nodes"); // 停用 = 工具不注册
      const rows2 = (await h2.graph().services.getOptional("mcp.catalog") as () => McpCatalogRow[])();
      expect(rows2.find((r) => r.name === "memory")?.state).toBe("disabled");
      await h2.close();
    } finally {
      if (prevHome === undefined) delete process.env.OROSUS_HOME;
      else process.env.OROSUS_HOME = prevHome;
    }
  });

  it("⑧ schema 本地缓存（2026-09-30 拍板「参数结构本地记录、连接后可更新」）：读写回环 + 坏 JSON 当空 + 叠加只补 inputSchema 不动描述 + 冷进程注册即带参数面", async () => {
    const home = tmp("schema-cache");
    expect(readPreloadSchemaCache(home)).toEqual({}); // 不存在 = 空
    writePreloadSchemaCache(home, { memory: { search_nodes: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } });
    expect(readPreloadSchemaCache(home).memory?.search_nodes?.required).toEqual(["query"]); // 回环
    writeFileSync(preloadSchemaCacheFile(home), "{ 坏 JSON", "utf8");
    expect(readPreloadSchemaCache(home)).toEqual({}); // 坏文件当空（缓存非事实源）
    // 叠加：缓存里有的补 inputSchema、没有的照旧；描述保留清单原样
    const overlay = withCachedSchemas(
      [{ name: "search_nodes", description: "按查询搜索节点" }, { name: "read_graph", description: "读图" }],
      { search_nodes: { type: "object", properties: { query: { type: "string" } } } },
    );
    expect(overlay[0]!.inputSchema).toEqual({ type: "object", properties: { query: { type: "string" } } });
    expect(overlay[0]!.description).toBe("按查询搜索节点"); // 描述不动
    expect(overlay[1]!.inputSchema).toBeUndefined(); // 缓存没有的照旧
    // 冷进程全链：缓存预热后 activateMcp 经 manifestFor 叠加——注册即带参数面（盲发消除的目标形态）
    const home2 = tmp("schema-cache2");
    writePreloadSchemaCache(home2, { mem: { remember: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } });
    const out = await activateMcp({
      servers: { mem: { command: "x", lazy: true } },
      connect: async () => { throw new Error("不应走非惰性连接"); },
      sessionAppend: () => {},
      lazy: {
        manifestFor: (name) => (name === "mem" ? withCachedSchemas(manifest, readPreloadSchemaCache(home2).mem) : undefined),
        connect: async () => ({ listTools: async () => manifest, callTool: async () => ({ content: [] }) }),
        onStarted: () => {},
      },
    });
    const schema = z.toJSONSchema(out.tools.find((t) => t.name === "mcp__mem__remember")!.parameters) as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties !== undefined && "text" in schema.properties).toBe(true); // 零连接已带参数面
    expect(schema.required).toEqual(["text"]);
  });
});
