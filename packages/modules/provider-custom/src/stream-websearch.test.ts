import { describe, it, expect } from "vitest";
import type { Chunk, ProviderRequest } from "@orosus/contracts/provider";
import { createStream as openaiStream } from "./stream-openai.ts";
import { createStream as anthropicStream } from "./stream-anthropic.ts";

const baseReq = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: "m", system: "", messages: [{ role: "user", content: [{ kind: "text", text: "q" }] }],
  tools: [], signal: new AbortController().signal, ...over,
});

const collect = async (s: AsyncIterable<Chunk>): Promise<Chunk[]> => {
  const out: Chunk[] = [];
  for await (const c of s) out.push(c);
  return out;
};

const sseResponse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

describe("provider-custom webSearch 线缆映射（M4-3 T1b）", () => {
  it("① openai 族：webSearch=true → tools 追加 zhipu 接受形声明（spike 实钉）；缺省不追加", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return sseResponse("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");
    }) as typeof fetch;
    await collect(openaiStream({ baseUrl: "https://x/v1", fetchImpl })(baseReq({ webSearch: true })));
    const withSearch = JSON.parse(bodies[0]!) as { tools?: { type: string; web_search?: { enable: boolean } }[] };
    expect(withSearch.tools).toEqual([{ type: "web_search", web_search: { enable: true } }]);
    await collect(openaiStream({ baseUrl: "https://x/v1", fetchImpl })(baseReq()));
    expect(JSON.parse(bodies[1]!) as Record<string, unknown>).not.toHaveProperty("tools");
  });

  it("② openai 族：message.web_search 数组 / web_search_call completed 事件 → server-search chunk", async () => {
    const sse = [
      "data: {\"choices\":[{\"message\":{\"web_search\":[{\"title\":\"T1\",\"url\":\"https://a/1\"},{\"title\":\"T2\",\"url\":\"https://a/2\"}]}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"摘要\"},\"finish_reason\":\"stop\"}]}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    const fetchImpl = (async () => sseResponse(sse)) as typeof fetch;
    const chunks = await collect(openaiStream({ baseUrl: "https://x/v1", fetchImpl })(baseReq({ webSearch: true })));
    const ss = chunks.find((c) => c.type === "server-search");
    expect(ss).toEqual({ type: "server-search", hits: [{ title: "T1", url: "https://a/1" }, { title: "T2", url: "https://a/2" }] });
    const sse2 = "data: {\"type\":\"web_search_call\",\"status\":\"completed\"}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"s\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    const chunks2 = await collect(openaiStream({ baseUrl: "https://x/v1", fetchImpl: (async () => sseResponse(sse2)) as typeof fetch })(baseReq({ webSearch: true })));
    expect(chunks2.find((c) => c.type === "server-search")).toEqual({ type: "server-search", hits: [] });
  });

  it("③ anthropic 族：webSearch=true → tools 追加 web_search_20250305；web_search_tool_result 块 → server-search", async () => {
    const bodies: string[] = [];
    const sse = [
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"web_search_tool_result\",\"content\":[{\"type\":\"web_search_result\",\"title\":\"AT\",\"url\":\"https://a/1\"}]}}\n\n",
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"答\"}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ].join("");
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return sseResponse(sse);
    }) as typeof fetch;
    const chunks = await collect(anthropicStream({ baseUrl: "https://x", fetchImpl })(baseReq({ webSearch: true })));
    const sent = JSON.parse(bodies[0]!) as { tools: { type?: string; name?: string; max_uses?: number }[] };
    expect(sent.tools).toContainEqual({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
    expect(chunks.find((c) => c.type === "server-search")).toEqual({ type: "server-search", hits: [{ title: "AT", url: "https://a/1" }] });
    expect(chunks.some((c) => c.type === "text/delta" && c.text === "答")).toBe(true); // 常规块映射不受扰
  });

  it("④ GLM anthropic 面 tool_result 变体（2026-09-24 spike 实钉）：content = JSON 字符串体 title+link → server-search", async () => {
    // 真机流式实录形态：tool_result 块 content 为字符串 "[[{\"title\":…,\"link\":…,\"refer\":…}]]"
    const content = JSON.stringify([[{ title: "中国气象局- 北京", link: "http://weather.cma.cn", content: "气温 19.6℃", refer: "ref_1" }]]);
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_result", tool_use_id: "c1", content } })}\n\n`,
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ].join("");
    const chunks = await collect(anthropicStream({ baseUrl: "https://x", fetchImpl: (async () => sseResponse(sse)) as typeof fetch })(baseReq({ webSearch: true })));
    expect(chunks.find((c) => c.type === "server-search")).toEqual({ type: "server-search", hits: [{ title: "中国气象局- 北京", url: "http://weather.cma.cn" }] });
  });

  it("⑤ tool_result 变体只在 webSearch 请求解析（主回路客户端工具结果不误收）；坏 JSON/非字符串体静默零 hits", async () => {
    const sseFor = (content: unknown) => [
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_result", tool_use_id: "c1", content } })}\n\n`,
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ].join("");
    const streamWith = (body: string, webSearch?: boolean) => {
      const fetchImpl = (async () => sseResponse(body)) as typeof fetch;
      return anthropicStream({ baseUrl: "https://x", fetchImpl })(baseReq(webSearch === true ? { webSearch: true } : {}));
    };
    // 主回路（无 webSearch）：tool_result 是客户端工具结果语义——不产 server-search
    const main = await collect(streamWith(sseFor("[[{\"title\":\"T\",\"link\":\"https://a/1\"}]]")));
    expect(main.find((c) => c.type === "server-search")).toBeUndefined();
    // webSearch 请求 + 非 JSON 字符串体 → 零 hits 静默（:147 门按无原生结果处理）
    const bad = await collect(streamWith(sseFor("不是 JSON"), true));
    expect(bad.find((c) => c.type === "server-search")).toBeUndefined();
  });
});
