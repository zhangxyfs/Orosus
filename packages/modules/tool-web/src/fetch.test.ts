import { describe, it, expect, afterEach } from "vitest";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import type { Chunk } from "@orosus/contracts/provider";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolWebModule, fetchTool, type FetchDeps } from "./index.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const noLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const PUBLIC_LOOKUP: FetchDeps["lookupImpl"] = async () => [{ address: "93.184.216.34" }];

interface FetchCall { url: string; ua: string | null }
/** 假 fetch：按队列依次返回 Response，记录每次调用的 url 与 UA。 */
const stubFetch = (queue: Response[], calls: FetchCall[]): typeof fetch =>
  (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), ua: new Headers(init?.headers).get("User-Agent") });
    const next = queue.shift();
    if (next === undefined) throw new Error("假 fetch 队列已空");
    return next;
  }) as typeof fetch;

const exec = async (deps: FetchDeps, url: string) => {
  const tool = fetchTool(deps);
  const plan = await tool.resolveExecution({ url });
  return { plan, result: await plan.execute({ callId: "c1", signal: new AbortController().signal, log: noLog }) };
};

describe("tool-web fetch 单元（M4-3 T0）", () => {
  it("① text/plain 与 application/json → 原文透传不转换", async () => {
    const calls: FetchCall[] = [];
    const { result: r1 } = await exec({ fetchImpl: stubFetch([new Response("plain body", { headers: { "content-type": "text/plain; charset=utf-8" } })], calls), lookupImpl: PUBLIC_LOOKUP }, "https://example.com/a.txt");
    expect(r1.isError).toBe(false);
    expect(r1.output).toBe("plain body");
    const { result: r2 } = await exec({ fetchImpl: stubFetch([new Response('{"a":1}', { headers: { "content-type": "application/json" } })], calls), lookupImpl: PUBLIC_LOOKUP }, "https://example.com/a.json");
    expect(r2.isError).toBe(false);
    expect(r2.output).toBe('{"a":1}');
  });

  it("② text/html → # 标题 + markdown；script/style/noscript 删除；gfm 表格转 pipe 表", async () => {
    const html = `<html><head><title>示例 &amp; 页</title><style>body{color:red}</style></head>
      <body><h1>Heading</h1><p>hello <b>world</b></p><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>
      <script>var secret=1;</script><noscript>enable js</noscript></body></html>`;
    const { result } = await exec({ fetchImpl: stubFetch([new Response(html, { headers: { "content-type": "text/html" } })], []), lookupImpl: PUBLIC_LOOKUP }, "https://example.com/");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("# 示例 & 页");
    expect(result.output).toContain("hello **world**");
    expect(result.output).toContain("| a | b |");
    expect(result.output).not.toContain("secret");
    expect(result.output).not.toContain("enable js");
    expect(result.output).not.toContain("color:red");
  });

  it("③ content-type 谎报 text/plain 但内容像 HTML → 仍走转换（Reasonix looksLikeHTML 兜底）", async () => {
    const { result } = await exec({ fetchImpl: stubFetch([new Response("<!DOCTYPE html><html><head><title>谎报</title></head><body><p>para</p></body></html>", { headers: { "content-type": "text/plain" } })], []), lookupImpl: PUBLIC_LOOKUP }, "https://example.com/lie");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("# 谎报");
    expect(result.output).toContain("para");
  });

  it("④ 输出超 100k 字符 → 截断并带「截断至 N 字符」提示", async () => {
    const big = "x".repeat(120_000);
    const { result } = await exec({ fetchImpl: stubFetch([new Response(big, { headers: { "content-type": "text/plain" } })], []), lookupImpl: PUBLIC_LOOKUP }, "https://example.com/big");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("已截断至 100000 字符，原文共 120000 字符");
    expect(result.output.length).toBeLessThan(120_000);
  });

  it("⑤ SSRF：私网 IP 字面量 / localhost / DNS 解析到私网 → 拒绝且不发请求", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = stubFetch([], calls);
    const { result: r1 } = await exec({ fetchImpl, lookupImpl: PUBLIC_LOOKUP }, "http://127.0.0.1:8080/admin");
    expect(r1.isError).toBe(true);
    expect(r1.output).toContain("私网");
    const { result: r2 } = await exec({ fetchImpl, lookupImpl: PUBLIC_LOOKUP }, "https://localhost/x");
    expect(r2.isError).toBe(true);
    expect(r2.output).toContain("localhost");
    const { result: r3 } = await exec({ fetchImpl, lookupImpl: async () => [{ address: "10.0.0.5" }] }, "https://internal.corp/x");
    expect(r3.isError).toBe(true);
    expect(r3.output).toContain("10.0.0.5");
    expect(calls.length).toBe(0);
  });

  it("⑥ http 公网自动升级 https；resolveExecution 按实参 host 声明 network access 与带参规则", async () => {
    const calls: FetchCall[] = [];
    const { plan, result } = await exec({ fetchImpl: stubFetch([new Response("ok", { headers: { "content-type": "text/plain" } })], calls), lookupImpl: PUBLIC_LOOKUP }, "http://example.com/a");
    expect(result.isError).toBe(false);
    expect(calls[0]?.url).toBe("https://example.com/a");
    expect(plan.accesses).toEqual([{ kind: "network", host: "example.com" }]);
    expect(plan.approvalRule).toBe("tool-web__fetch(example.com)");
    expect(plan.matchesRule?.("example.com")).toBe(true);
    expect(plan.matchesRule?.("exa*")).toBe(true);
    expect(plan.matchesRule?.("other.com")).toBe(false);
  });

  it("⑦ 重定向链 301→302→200 跟随：相对 Location 逐跳解析、每跳都过 SSRF 校验", async () => {
    const calls: FetchCall[] = [];
    const lookupHosts: string[] = [];
    const fetchImpl = stubFetch([
      new Response(null, { status: 301, headers: { location: "/next" } }),
      new Response(null, { status: 302, headers: { location: "https://cdn.example.com/final" } }),
      new Response("landed", { headers: { "content-type": "text/plain" } }),
    ], calls);
    const { result } = await exec({
      fetchImpl,
      lookupImpl: async (h) => { lookupHosts.push(h); return [{ address: "93.184.216.34" }]; },
    }, "https://example.com/start");
    expect(result.isError).toBe(false);
    expect(result.output).toBe("landed");
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/start", "https://example.com/next", "https://cdn.example.com/final"]);
    expect(lookupHosts).toEqual(["example.com", "example.com", "cdn.example.com"]);
  });

  it("⑧ 重定向超 10 跳上限 → 带内报错", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 302, headers: { location: "/loop" } })) as typeof fetch;
    const { result } = await exec({ fetchImpl, lookupImpl: PUBLIC_LOOKUP }, "https://example.com/loop");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("10 跳上限");
    void calls;
  });

  it("⑨ 超时（注入小 timeoutMs + 挂起 fetch）→ 带内「抓取超时」", async () => {
    const fetchImpl = ((input: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as typeof fetch;
    const { result } = await exec({ fetchImpl, lookupImpl: PUBLIC_LOOKUP, timeoutMs: 50 }, "https://example.com/slow");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("抓取超时");
  });

  it("⑩ HTML 转换抛错 → 降级原文并注明（D3）", async () => {
    const html = "<html><head><title>t</title></head><body><p>x</p></body></html>";
    const { result } = await exec({
      fetchImpl: stubFetch([new Response(html, { headers: { "content-type": "text/html" } })], []),
      lookupImpl: PUBLIC_LOOKUP,
      toMarkdown: async () => { throw new Error("dom 解析炸了"); },
    }, "https://example.com/");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("HTML 转 markdown 失败，已降级为原文");
    expect(result.output).toContain("<p>x</p>");
  });

  it("⑪ 403 + cf-mitigated: challenge → 换诚实 UA 重试一次（opencode 同款）；再 403 则带内 HTTP 报错", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = stubFetch([
      new Response("cf", { status: 403, headers: { "cf-mitigated": "challenge" } }),
      new Response("passed", { headers: { "content-type": "text/plain" } }),
    ], calls);
    const { result } = await exec({ fetchImpl, lookupImpl: PUBLIC_LOOKUP }, "https://example.com/cf");
    expect(result.isError).toBe(false);
    expect(result.output).toBe("passed");
    expect(calls.map((c) => c.ua)).toEqual([
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 (Orosus-WebFetch)",
      "Orosus-WebFetch",
    ]);
    const calls2: FetchCall[] = [];
    const fetchImpl2 = stubFetch([
      new Response("cf", { status: 403, headers: { "cf-mitigated": "challenge" } }),
      new Response("still no", { status: 403 }),
    ], calls2);
    const { result: r2 } = await exec({ fetchImpl: fetchImpl2, lookupImpl: PUBLIC_LOOKUP }, "https://example.com/cf");
    expect(r2.isError).toBe(true);
    expect(r2.output).toContain("HTTP 403");
  });
});

// 集成：模块装配（经工厂注假 fetch，hermetic）+ 假 provider 脚本驱动工具回合
describe("tool-web 模块集成（M4-3 T0）", () => {
  it("⑫ 脚本驱动 tool-web__fetch → 转换后的 markdown 落会话 tool/result", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-web-"));
    const script: Chunk[][] = [
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "tool-web__fetch",
          argumentsDelta: JSON.stringify({ url: "https://example.com/page" }) },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "读完了" }, { type: "finish", kind: "stop" }],
    ];
    const html = "<html><head><title>集成页</title></head><body><p>集成正文</p><script>var x=1;</script></body></html>";
    const moduleUnderTest = createToolWebModule({
      fetchImpl: (async () => new Response(html, { headers: { "content-type": "text/html" } })) as typeof fetch,
      lookupImpl: PUBLIC_LOOKUP,
    });
    const mem = new InMemorySessionStore();
    const h = await createHarness({
      store: mem,
      diagDir: dir, spillDir: join(dir, "spill"),
      modules: [moduleUnderTest, fakeProviderModule("fake", script)],
      config: { userFile: join(dir, "n.toml"), projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    await h.prompt("读一下这个页面");
    await h.close();
    const all = await mem.all();
    const toolResult = all.find((e) => e.type === "tool/result" && e.callId === "c1");
    expect(toolResult).toBeDefined();
    expect(String(toolResult && JSON.stringify(toolResult))).toContain("集成正文");
    expect(String(toolResult && JSON.stringify(toolResult))).not.toContain("var x");
    expect(all.some((e) => e.type === "assistant/message" && String(JSON.stringify(e)).includes("读完了"))).toBe(true);
  });
});
