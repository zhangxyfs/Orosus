import { describe, it, expect, afterEach } from "vitest";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import type { Chunk } from "@orosus/contracts/provider";
import type { ModuleContext } from "@orosus/contracts/module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolWebModule, searchTool, createSearchState } from "./index.ts";
import type { SearchConfig, WebSearchBackend } from "./search.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const noLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

const fakeBackend = (kind: WebSearchBackend["kind"], over: Partial<WebSearchBackend> = {}): WebSearchBackend => ({
  kind,
  available: () => true,
  search: async () => [{ title: `${kind}-t`, url: `https://${kind}.example/1`, snippet: `${kind}-s` }],
  ...over,
});

const execSearch = async (stateCfg: SearchConfig, backends: WebSearchBackend[], query = "q", timeoutMs?: number) => {
  const tool = searchTool({
    state: createSearchState(stateCfg),
    backends: () => backends,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  const plan = await tool.resolveExecution({ query });
  return { plan, result: await plan.execute({ callId: "c1", signal: new AbortController().signal, log: noLog }) };
};

describe("tool-web search 链（M4-3 T1a）", () => {
  it("① auto 链序：tavily/brave 齐配 → 取 tavily（POST 体 max_results=8/search_depth=basic + Bearer 逐字）", async () => {
    const calls: { url: string; auth: string | null; body: string }[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization"), body: String(init?.body) });
      return new Response(JSON.stringify({ results: [{ title: "T", url: "https://a/1", content: "S" }] }));
    }) as typeof fetch;
    const tool = searchTool({
      state: createSearchState({ tavilyApiKey: "tv-key", braveApiKey: "br-key" }),
      fetchImpl,
    });
    const plan = await tool.resolveExecution({ query: "turndown gfm" });
    const result = await plan.execute({ callId: "c1", signal: new AbortController().signal, log: noLog });
    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.tavily.com/search");
    expect(calls[0]?.auth).toBe("Bearer tv-key");
    const sent = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent["max_results"]).toBe(8);
    expect(sent["search_depth"]).toBe("basic");
    // auto 链候选全声明（tavily 失败会真实落 brave——两档都可能发请求）
    expect(plan.accesses).toEqual([{ kind: "network", host: "api.tavily.com" }, { kind: "network", host: "api.search.brave.com" }]);
  });

  it("② auto 降级：tavily 缺 key、brave 有 key → 落 brave（GET q/count=8 + X-Subscription-Token 逐字）", async () => {
    const calls: { url: string; token: string | null }[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), token: new Headers(init?.headers).get("X-Subscription-Token") });
      return new Response(JSON.stringify({ web: { results: [{ title: "B", url: "https://b/1", description: "D" }] } }));
    }) as typeof fetch;
    const tool = searchTool({ state: createSearchState({ braveApiKey: "br-key" }), fetchImpl });
    const plan = await tool.resolveExecution({ query: "hello world" });
    const result = await plan.execute({ callId: "c1", signal: new AbortController().signal, log: noLog });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Title: B");
    expect(result.output).toContain("Snippet: D");
    expect(calls[0]?.url).toContain("https://api.search.brave.com/res/v1/web/search");
    expect(calls[0]?.url).toContain("q=hello+world");
    expect(calls[0]?.url).toContain("count=8");
    expect(calls[0]?.token).toBe("br-key");
  });

  it("③ 显式钉死 brave：tavily 有 key 也走 brave；brave 失败 → 带内报错不降级（SW-15）", async () => {
    const order: string[] = [];
    const brave = fakeBackend("brave", { search: async () => { order.push("brave"); throw new Error("brave 500"); } });
    const tavily = fakeBackend("tavily", { search: async () => { order.push("tavily"); return []; } });
    const { result } = await execSearch({ backend: "brave", tavilyApiKey: "k", braveApiKey: "k" }, [tavily, brave]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("已钉死不降级");
    expect(order).toEqual(["brave"]); // tavily 完全未被触碰
  });

  it("④ 钉死 tavily 但 key 缺 → 带内「已钉死但未配置」", async () => {
    const { result } = await execSearch({ backend: "tavily" }, []);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("已钉死但未配置");
  });

  it("⑤ auto 皆无 key → 带内引导话术；未解析 $ENV: 占位符视同未配置", async () => {
    const { result } = await execSearch({}, []);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("未配置可用的搜索后端");
    const { result: r2 } = await execSearch({ tavilyApiKey: "$ENV:TAVILY_API_KEY" }, []);
    expect(r2.isError).toBe(true);
    expect(r2.output).toContain("未配置可用的搜索后端");
  });

  it("⑥ 拼装：逐条 Title/URL/Snippet + --- 分隔 + 末尾引用指令；超 8 条截 8（SW-4）", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `https://x/${i}`, snippet: `s${i}` }));
    const backend = fakeBackend("tavily", { search: async () => many });
    const { result } = await execSearch({ tavilyApiKey: "k" }, [backend]);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Title: t0\nURL: https://x/0\nSnippet: s0");
    expect(result.output).toContain("\n---\n");
    expect(result.output).toContain("引用搜索结果时必须用 markdown 链接");
    expect(result.output).not.toContain("t8"); // 第 9、10 条被截
  });

  it("⑦ 空结果 → 明确空话（带后端名）", async () => {
    const { result } = await execSearch({ tavilyApiKey: "k" }, [fakeBackend("tavily", { search: async () => [] })], "火星房产价格");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("没有找到与 \"火星房产价格\" 相关的结果");
    expect(result.output).toContain("tavily");
  });

  it("⑧ 超时（注入小 timeoutMs + 挂起后端）→ 带内「搜索超时」", async () => {
    const hanging = fakeBackend("tavily", {
      search: async (_q, signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
    });
    const { result } = await execSearch({ tavilyApiKey: "k" }, [hanging], "q", 50);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("搜索超时");
  });

  it("⑨ auto 运行时降级（D4/SW-19）：llm 抛错落 tavily 成功 → 降级前缀透明化 + sticky 置位；第二次调用 llm 直接跳过", async () => {
    const calls: string[] = [];
    const llm = fakeBackend("llm", { search: async () => { calls.push("llm"); throw new Error("provider returned no native search results"); } });
    const tavily = fakeBackend("tavily", { search: async () => { calls.push("tavily"); return [{ title: "T", url: "https://t/1", snippet: "S" }]; } });
    const sticky = { llmDowngraded: false };
    const tool = searchTool({ state: createSearchState({}), sticky, backends: () => [llm, tavily] });
    const run = async () => {
      const plan = await tool.resolveExecution({ query: "q" });
      return { plan, result: await plan.execute({ callId: "c1", signal: new AbortController().signal, log: noLog }) };
    };
    const first = await run();
    expect(first.result.isError).toBe(false);
    expect(first.result.output).toContain("[已降级到 tavily——llm 失败：provider returned no native search results]");
    expect(first.result.output).toContain("Title: T");
    expect(sticky.llmDowngraded).toBe(true);
    expect(calls).toEqual(["llm", "tavily"]);
    const second = await run();
    expect(second.result.isError).toBe(false);
    expect(calls).toEqual(["llm", "tavily", "tavily"]); // sticky 后 llm 不再被触（不重复支付注定失败的调用）
    expect(second.result.output).not.toContain("已降级"); // llm 根本没进候选，无降级前缀
    expect(second.plan.accesses).toEqual([{ kind: "network", host: "api.tavily.com" }]); // 候选收缩如实反映
  });

  it("⑩ auto 全档失败 → 合并报错逐档列原因", async () => {
    const llm = fakeBackend("llm", { search: async () => { throw new Error("no native results"); } });
    const tavily = fakeBackend("tavily", { search: async () => { throw new Error("HTTP 401"); } });
    const { result } = await execSearch({}, [llm, tavily]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("llm 失败：no native results");
    expect(result.output).toContain("tavily 失败：HTTP 401");
  });

  it("⑪ search 恒注册（SW-15/T1b 收口）：llm 槽恒可用——有无 key 都注册 fetch+search", async () => {
    const capture = (cfg: object) => {
      const tools: string[] = [];
      const fakeCtx = {
        config: cfg, log: noLog,
        llm: { stream: () => (async function* () { yield* []; })() },
        contribute: {
          tool: (t: { name: string }) => { tools.push(t.name); return () => {}; },
          command: () => () => {},
        },
      } as unknown as ModuleContext<object>;
      createToolWebModule().activate(fakeCtx as ModuleContext<never>);
      return tools;
    };
    expect(await capture({})).toEqual(["tool-web__fetch", "tool-web__search"]);
    expect(await capture({ search: { tavilyApiKey: "k" } })).toEqual(["tool-web__fetch", "tool-web__search"]);
    expect(await capture({ search: { braveApiKey: "$ENV:BRAVE_API_KEY" } })).toEqual(["tool-web__fetch", "tool-web__search"]); // 未解析占位符不挡恒注册（llm 槽在）
  });
});

// 集成：harness 装配 + [tool-web] 配置节 + 假 provider 脚本驱动 search 回合
describe("tool-web search 模块集成（M4-3 T1a）", () => {
  it("⑩ 配 [tool-web] tavily key → 脚本驱动 tool-web__search → 拼装结果落会话", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-search-"));
    const userFile = join(dir, "config.toml");
    writeFileSync(userFile, "[tool-web.search]\ntavilyApiKey = \"it-key\"\n", "utf8");
    const script: Chunk[][] = [
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "tool-web__search",
          argumentsDelta: JSON.stringify({ query: "turndown gfm plugin" }) },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "搜到 1 条" }, { type: "finish", kind: "stop" }],
    ];
    const fetchImpl = (async () => new Response(JSON.stringify({
      results: [{ title: "turndown-plugin-gfm", url: "https://github.com/x/gfm", content: "GFM 插件" }],
    }))) as typeof fetch;
    const mem = new InMemorySessionStore();
    const h = await createHarness({
      store: mem,
      diagDir: dir, spillDir: join(dir, "spill"),
      modules: [createToolWebModule({ fetchImpl }), fakeProviderModule("fake", script)],
      config: { userFile, projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    await h.prompt("搜一下 turndown gfm plugin");
    await h.close();
    const all = await mem.all();
    const toolResult = all.find((e) => e.type === "tool/result" && e.callId === "c1");
    expect(toolResult).toBeDefined();
    const payload = String(toolResult && JSON.stringify(toolResult));
    expect(payload).toContain("Title: turndown-plugin-gfm");
    expect(payload).toContain("URL: https://github.com/x/gfm");
    expect(payload).toContain("引用搜索结果时必须用 markdown 链接");
    expect(all.some((e) => e.type === "assistant/message" && String(JSON.stringify(e)).includes("搜到 1 条"))).toBe(true);
  });
});
