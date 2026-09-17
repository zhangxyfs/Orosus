import { describe, it, expect } from "vitest";
import def from "./index.ts";
import { mapEvent, type SseState } from "./translate.ts";
import { createStream } from "./stream.ts";

type Ctx = Parameters<typeof def.activate>[0];

function fakeCtx() {
  const services = new Map<string, unknown>();
  const ctx = {
    config: { apiKey: "mk-test", baseUrl: "https://api.moonshot.cn/anthropic" },
    configRead: () => Promise.resolve(undefined),
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    services: { get: () => Promise.reject(new Error("no")), getOptional: () => Promise.resolve(undefined) },
    provide: (k: string, impl: unknown) => void services.set(k, impl),
    contribute: { tool: () => () => {}, command: () => () => {}, promptSection: () => () => {} },
    session: { append: () => {} },
    events: { on: () => () => {}, emit: () => Promise.resolve() },
  } as unknown as Ctx;
  return { ctx, services };
}

const sse = (events: string[]): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const e of events) c.enqueue(enc.encode(e));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

describe("provider-kimi（Anthropic 族模板实例，D31/D32）", () => {
  it("activate 注册 { stream, defaultModel: kimi-k3 } 到 provider:kimi", async () => {
    const { ctx, services } = fakeCtx();
    await def.activate(ctx);
    const v = services.get("provider:kimi") as { stream: unknown; defaultModel?: string };
    expect(typeof v.stream).toBe("function");
    expect(v.defaultModel).toBe("kimi-k3");
  });

  it("翻译层样本回归（vendored）：text_delta 与 thinking_delta", () => {
    const s: SseState = { inputTokens: 0, currentCall: null, pendingStop: null };
    expect(mapEvent(s, "content_block_delta", { delta: { type: "text_delta", text: "好" } })).toEqual([{ type: "text/delta", text: "好" }]);
    expect(mapEvent(s, "content_block_delta", { delta: { type: "thinking_delta", thinking: "想" } })).toEqual([{ type: "reasoning/delta", text: "想" }]);
  });

  it("fetch 落点 https://api.moonshot.cn/anthropic/v1/messages", async () => {
    const seen: string[] = [];
    const fetchImpl = ((url: string | URL | Request) => {
      seen.push(String(url));
      return Promise.resolve(new Response("{}", { status: 401 }));
    }) as typeof fetch;
    const stream = createStream({ apiKey: "mk", baseUrl: "https://api.moonshot.cn/anthropic", fetchImpl });
    for await (const _ of stream({ model: "kimi-k3", system: "s", messages: [], tools: [], signal: new AbortController().signal })) void _;
    expect(seen[0]).toBe("https://api.moonshot.cn/anthropic/v1/messages");
  });

  it("鉴权回归专测：mock 端点只认 Authorization Bearer（官方 OpenAPI 行为）仍通", async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (h["authorization"] !== "Bearer mk") return Promise.resolve(new Response("{\"error\":\"no auth\"}", { status: 401 }));
      return Promise.resolve(sse([
        `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"通"}}\n\n`,
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
      ]));
    }) as typeof fetch;
    const stream = createStream({ apiKey: "mk", baseUrl: "https://api.moonshot.cn/anthropic", fetchImpl });
    const out: unknown[] = [];
    for await (const c of stream({ model: "kimi-k3", system: "s", messages: [], tools: [], signal: new AbortController().signal })) out.push(c);
    expect(out[0]).toEqual({ type: "text/delta", text: "通" }); // Bearer 被接受 → 流正常
    expect(out.at(-1)).toMatchObject({ type: "finish", kind: "stop" });
  });
});
