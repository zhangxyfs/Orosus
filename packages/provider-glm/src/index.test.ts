import { describe, it, expect } from "vitest";
import def from "./index.ts";
import { mapEvent, type SseState } from "./translate.ts";
import { createStream } from "./stream.ts";

type Ctx = Parameters<typeof def.activate>[0];

function fakeCtx() {
  const services = new Map<string, unknown>();
  const ctx = {
    config: { apiKey: "zk-test", baseUrl: "https://open.bigmodel.cn/api/anthropic" },
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

describe("provider-glm（Anthropic 族模板实例，D31/D32）", () => {
  it("activate 注册 { stream, defaultModel: glm-5.3 } 到 provider:glm", async () => {
    const { ctx, services } = fakeCtx();
    await def.activate(ctx);
    const v = services.get("provider:glm") as { stream: unknown; defaultModel?: string };
    expect(typeof v.stream).toBe("function");
    expect(v.defaultModel).toBe("glm-5.3");
  });

  it("翻译层样本回归（vendored 自 provider-anthropic）：text_delta 与 tool_use 宣告", () => {
    const s: SseState = { inputTokens: 0, currentCall: null, pendingStop: null };
    expect(mapEvent(s, "content_block_delta", { delta: { type: "text_delta", text: "你" } })).toEqual([{ type: "text/delta", text: "你" }]);
    expect(mapEvent(s, "content_block_start", { content_block: { type: "tool_use", id: "toolu_1", name: "tool-fs__read" } }))
      .toEqual([{ type: "toolcall/argumentsDelta", callId: "toolu_1", name: "tool-fs__read", argumentsDelta: "" }]);
  });

  it("fetch 落点 https://open.bigmodel.cn/api/anthropic/v1/messages", async () => {
    const seen: string[] = [];
    const fetchImpl = ((url: string | URL | Request) => {
      seen.push(String(url));
      return Promise.resolve(new Response("{}", { status: 401 }));
    }) as typeof fetch;
    const stream = createStream({ apiKey: "zk", baseUrl: "https://open.bigmodel.cn/api/anthropic", fetchImpl });
    for await (const _ of stream({ model: "glm-5.3", system: "s", messages: [], tools: [], signal: new AbortController().signal })) void _;
    expect(seen[0]).toBe("https://open.bigmodel.cn/api/anthropic/v1/messages");
  });

  it("双头鉴权（D31）", async () => {
    const headersSeen: Record<string, string>[] = [];
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      headersSeen.push((init?.headers ?? {}) as Record<string, string>);
      return Promise.resolve(new Response("{}", { status: 401 }));
    }) as typeof fetch;
    const stream = createStream({ apiKey: "zk", baseUrl: "https://open.bigmodel.cn/api/anthropic", fetchImpl });
    for await (const _ of stream({ model: "glm-5.3", system: "s", messages: [], tools: [], signal: new AbortController().signal })) void _;
    expect(headersSeen[0]!["x-api-key"]).toBe("zk");
    expect(headersSeen[0]!["authorization"]).toBe("Bearer zk");
  });
});
