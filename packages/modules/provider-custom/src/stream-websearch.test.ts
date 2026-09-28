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

// MP-03 回归（报告条目：两族流内错误帧被静默吞——anthropic error 事件落 default 返 [] 后零 finish、
// openai 错误帧返 [] 后 [DONE] 兜底补 stop，截断回复均冒充完整答复）。e2e 钉错误帧全链产出 finish error。
describe("流内错误帧带内终局（MP-03：半截回复不再冒充完整）", () => {
  it("① anthropic 族：正文 delta 后接 event:error（过载关流，无 message_stop）→ finish error 且无 stop 终局", async () => {
    const sse = [
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"半截\"}}\n\n",
      "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n",
    ].join("");
    const fetchImpl = (async () => sseResponse(sse)) as typeof fetch;
    const chunks = await collect(anthropicStream({ baseUrl: "https://x", fetchImpl })(baseReq()));
    expect(chunks.some((c) => c.type === "text/delta" && c.text === "半截")).toBe(true); // 已产出正文保留
    expect(chunks.filter((c) => c.type === "finish")).toEqual([{ type: "finish", kind: "error", errorMessage: "overloaded_error：Overloaded" }]); // 唯一终局 = error（无 stop 冒充）
  });

  it("② openai 族：正文 delta 后接 {\"error\":…} 帧再 [DONE] → 错误帧压过兜底 stop（sawFinish 语义）", async () => {
    const sse = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"半截\"}}]}\n\n",
      "data: {\"error\":{\"message\":\"upstream timeout\",\"code\":504}}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    const fetchImpl = (async () => sseResponse(sse)) as typeof fetch;
    const chunks = await collect(openaiStream({ baseUrl: "https://x/v1", fetchImpl })(baseReq()));
    expect(chunks.some((c) => c.type === "text/delta" && c.text === "半截")).toBe(true);
    expect(chunks.filter((c) => c.type === "finish")).toEqual([{ type: "finish", kind: "error", errorMessage: "流错误：upstream timeout" }]); // [DONE] 兜底 stop 不再触发
  });

  it("③ 无 event: 行方言（data.type=error）同判错误；error:null 中间帧不受扰（回归）", async () => {
    const sse = "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
    const fetchImpl = (async () => sseResponse(sse)) as typeof fetch;
    const chunks = await collect(anthropicStream({ baseUrl: "https://x", fetchImpl })(baseReq()));
    expect(chunks.at(-1)).toEqual({ type: "finish", kind: "error", errorMessage: "overloaded_error：Overloaded" });
    const sse2 = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"error\":null}\n\ndata: [DONE]\n\n";
    const ok = await collect(openaiStream({ baseUrl: "https://x/v1", fetchImpl: (async () => sseResponse(sse2)) as typeof fetch })(baseReq()));
    expect(ok.at(-1)).toEqual({ type: "finish", kind: "stop" }); // error:null 不误伤正常流
  });
});

// MP-04 回归（报告条目：anthropic 族 JSON.parse(parsed.data) 无局部 try——兼容端点发一帧非 JSON data
// （截断帧/[DONE] 式哨兵/网关插播文本）异常即逃逸外层 catch，整条流被误标「流读取错误」终局；openai 族
// 同位置是局部 try + 坏行跳过，两族口径不一。修复：块级 try 跳过 + [DONE] 哨兵检查（对齐 openai 族）
describe("anthropic 族坏帧容忍（MP-04：坏帧跳过不炸流——对齐 openai 族口径）", () => {
  it("① 截断 JSON 帧与 [DONE] 哨兵帧混在正常帧之间 → 坏帧跳过，前后正文完好、终局仍是 message_stop 的 stop", async () => {
    const sse = [
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"前\"}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_de", // 截断帧（无结尾）
      "\n\n",
      "data: [DONE]\n\n", // openai 式哨兵（兼容网关混发——anthropic 协议无此事件）
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"后\"}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ].join("");
    const fetchImpl = (async () => sseResponse(sse)) as typeof fetch;
    const chunks = await collect(anthropicStream({ baseUrl: "https://x", fetchImpl })(baseReq()));
    expect(chunks.some((c) => c.type === "text/delta" && c.text === "前")).toBe(true);
    expect(chunks.some((c) => c.type === "text/delta" && c.text === "后")).toBe(true); // MP-04 前：坏帧杀流，「后」永不到达
    expect(chunks.filter((c) => c.type === "finish")).toEqual([{ type: "finish", kind: "stop" }]); // 终局 = message_stop 正常 stop（非「流读取错误」）
  });
});

// MP-06 回归（报告条目：两族 SSE 切块只认 \n\n——CRLF 端点（规范合法）整流零事件静默空答复；done 后残
// buffer 不冲刷，「最后一帧不带结尾空行」的端点丢尾帧）。假流按字节拼块（分块边界切在帧中间）钉分块组装
describe("SSE 行尾三态与残块冲刷（MP-06）", () => {
  const chunkedResponse = (parts: string[]): Response => new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

  it("① anthropic 族纯 CRLF 流 + 帧边界切半投递 → 全事件产出；尾帧无结尾空行经残块冲刷（message_stop 不丢）", async () => {
    const whole = [
      "event: content_block_delta\r\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"CRLF\"}}\r\n\r\n",
      "event: message_stop\r\ndata: {\"type\":\"message_stop\"}", // 无结尾空行——靠 done 后残块冲刷
    ].join("");
    const fetchImpl = (async () => chunkedResponse([whole.slice(0, 80), whole.slice(80)])) as typeof fetch; // 边界切在帧中间
    const chunks = await collect(anthropicStream({ baseUrl: "https://x", fetchImpl })(baseReq()));
    expect(chunks.filter((c) => c.type === "text/delta").map((c) => (c as { text: string }).text)).toEqual(["CRLF"]); // MP-06 前：纯 CRLF 整流零事件
    expect(chunks.at(-1)).toEqual({ type: "finish", kind: "stop" }); // 尾帧冲刷——message_stop 到达（此前静默丢、loop 缺省 stop 冒充）
  });

  it("② openai 族纯 CRLF 流：finish_reason 帧是残块（无结尾空行）→ 冲刷产出唯一 stop（sawFinish 计入，无重复兜底）", async () => {
    const whole = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\r\n\r\n", // 首块在循环内正常分块
      "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}", // 残块——done 后冲刷
    ].join("");
    const fetchImpl = (async () => chunkedResponse([whole.slice(0, 40), whole.slice(40)])) as typeof fetch;
    const chunks = await collect(openaiStream({ baseUrl: "https://x/v1", fetchImpl })(baseReq()));
    expect(chunks.filter((c) => c.type === "text/delta")).toEqual([{ type: "text/delta", text: "OK" }]); // MP-06 前：纯 CRLF 整流零事件
    expect(chunks.filter((c) => c.type === "finish")).toEqual([{ type: "finish", kind: "stop" }]); // 残块 finish 冲刷 + 不重复兜底 stop
  });

  it("③ 残块是撕裂 JSON（截断流尾）→ 静默跳过不炸流（无错误终局冒出）", async () => {
    const torn = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_de";
    const chunks = await collect(anthropicStream({ baseUrl: "https://x", fetchImpl: (async () => chunkedResponse([torn])) as typeof fetch })(baseReq()));
    expect(chunks).toEqual([]); // 坏残块跳过：无正文也无「流读取错误」（对齐 MP-04 坏帧口径）
  });
});

// MP-07 回归（报告条目：chat 面零重试零退避零空闲超时——端点保持连接但零字节时 reader.read() 无限等待，
// turn 挂死到用户手动中断。最小实现：请求级空闲超时（连接/响应头/块间任一阶段无进展即 abort 带内终局）；
// 重试/退避刻意不在本层做——流已产出正文后重发会重复投递，归调用方策略层（取舍在 stream-*.ts 注明））
describe("空闲读超时（MP-07 最小实现）", () => {
  it("① openai 族：首块后断流（零字节挂起）→ 空闲超时 abort；已产出正文保留、终局为带内错误（非挂死）", async () => {
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const signal = init!.signal!;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"前半\"}}]}\n\n"));
          // 挂起不再产出——read() 悬置到 abort
          signal.addEventListener("abort", () => c.error(signal.reason), { once: true }); // undici 同款：fetch signal abort → body 流 error
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const chunks = await collect(openaiStream({ baseUrl: "https://x/v1", fetchImpl, idleTimeoutMs: 30 })(baseReq()));
    expect(chunks.some((c) => c.type === "text/delta" && c.text === "前半")).toBe(true); // 超时前已产出正文保留
    const last = chunks.at(-1) as { type: string; kind: string; errorMessage?: string };
    expect(last).toMatchObject({ type: "finish", kind: "error" });
    expect(last.errorMessage).toContain("空闲超时"); // MP-07 前：read() 永久挂起，无任何终局
  });

  it("② anthropic 族：连接建立后零字节（挂起网关）→ 同超时终局", async () => {
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const signal = init!.signal!;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          // 零字节挂起——read() 悬置到 abort
          signal.addEventListener("abort", () => c.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const chunks = await collect(anthropicStream({ baseUrl: "https://x", fetchImpl, idleTimeoutMs: 30 })(baseReq()));
    expect(chunks.at(-1)).toMatchObject({ type: "finish", kind: "error" });
    expect((chunks.at(-1) as { errorMessage?: string }).errorMessage).toContain("空闲超时");
  });

  it("③ 头阶段挂起（fetch 永不返回响应）→ 超时同样覆盖连接/响应头阶段", async () => {
    const fetchImpl = (async (_u: unknown, init?: RequestInit): Promise<Response> => {
      await new Promise<never>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
      throw new Error("unreachable"); // await never 悬置——abort 前永不走到（类型收尾）
    }) as typeof fetch;
    const chunks = await collect(openaiStream({ baseUrl: "https://x/v1", fetchImpl, idleTimeoutMs: 30 })(baseReq()));
    const last = chunks.at(-1) as { kind: string; errorMessage?: string };
    expect(last.kind).toBe("error");
    expect(last.errorMessage).toContain("空闲超时"); // 不是「网络错误」——超时语义单独可辨
  });
});
