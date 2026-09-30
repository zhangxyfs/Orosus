// T20（m4-3c）：预装五件按需启动——惰性机制（activate 零连接/首调才起/memo 复用/失败可重试）+
// 工具注册门控（tool-search 显式启用才注册——关态 deferred 不生效防灌爆）+ 合并优先级。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateMcp, type ActivateMcpOpts } from "./index.ts";
import { MCP_PRELOADS, shouldRegisterPreloadTools, isPreloadName } from "./preload.ts";

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

  it("⑥ 门控 shouldRegisterPreloadTools：默认 false；modules.d/tool-search.toml enabled=true 开；config.toml 同款；显式 false 关", () => {
    const home = tmp("gate");
    expect(shouldRegisterPreloadTools(home)).toBe(false); // 无配置 = tool-search 默认关
    mkdirSync(join(home, "modules.d"), { recursive: true });
    writeFileSync(join(home, "modules.d", "tool-search.toml"), "[tool-search]\nenabled = true\n", "utf8");
    expect(shouldRegisterPreloadTools(home)).toBe(true);
    writeFileSync(join(home, "modules.d", "tool-search.toml"), "[tool-search]\nenabled = false\n", "utf8");
    expect(shouldRegisterPreloadTools(home)).toBe(false);
    rmSync(join(home, "modules.d", "tool-search.toml"));
    writeFileSync(join(home, "config.toml"), "[tool-search]\nenabled = true\n", "utf8");
    expect(shouldRegisterPreloadTools(home)).toBe(true); // 老 config.toml 同款认
    // 坏文件当未配置
    const home2 = tmp("gate2");
    writeFileSync(join(home2, "config.toml"), "坏 TOML", "utf8");
    expect(shouldRegisterPreloadTools(home2)).toBe(false);
  });
});
