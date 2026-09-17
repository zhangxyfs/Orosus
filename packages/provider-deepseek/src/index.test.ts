import { describe, it, expect } from "vitest";
import def from "./index.ts";
import { mapSseChunk, type OaiStreamState } from "./translate.ts";
import { createStream } from "./stream.ts";

type Ctx = Parameters<typeof def.activate>[0];

function fakeCtx() {
  const services = new Map<string, unknown>();
  const ctx = {
    config: { apiKey: "dk-test", baseUrl: "https://api.deepseek.com/v1" },
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

describe("provider-deepseek（OpenAI 族品牌实例，D34 封顶第五件）", () => {
  it("activate 注册 { stream, defaultModel: deepseek-chat } 到 provider:deepseek", async () => {
    const { ctx, services } = fakeCtx();
    await def.activate(ctx);
    const v = services.get("provider:deepseek") as { stream: unknown; defaultModel?: string };
    expect(typeof v.stream).toBe("function");
    expect(v.defaultModel).toBe("deepseek-chat");
  });

  it("deepseek-reasoner 专项回归：reasoning_content 与 content 交错顺序保持", () => {
    const s: OaiStreamState = { calls: new Map() };
    expect(mapSseChunk(s, { choices: [{ delta: { reasoning_content: "先想" } }] })).toEqual([{ type: "reasoning/delta", text: "先想" }]);
    expect(mapSseChunk(s, { choices: [{ delta: { content: "后说" } }] })).toEqual([{ type: "text/delta", text: "后说" }]);
    expect(mapSseChunk(s, { choices: [{ delta: { reasoning_content: "再想", content: "再说" } }] }))
      .toEqual([{ type: "text/delta", text: "再说" }, { type: "reasoning/delta", text: "再想" }]); // 同片内 text 先出（vendor 同源顺序）
  });

  it("fetch 落点 https://api.deepseek.com/v1/chat/completions", async () => {
    const seen: string[] = [];
    const fetchImpl = ((url: string | URL | Request) => {
      seen.push(String(url));
      return Promise.resolve(new Response("{}", { status: 401 }));
    }) as typeof fetch;
    const stream = createStream({ apiKey: "dk", baseUrl: "https://api.deepseek.com/v1", fetchImpl });
    for await (const _ of stream({ model: "deepseek-chat", system: "s", messages: [], tools: [], signal: new AbortController().signal })) void _;
    expect(seen[0]).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("双头鉴权（D31）", async () => {
    const headersSeen: Record<string, string>[] = [];
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      headersSeen.push((init?.headers ?? {}) as Record<string, string>);
      return Promise.resolve(new Response("{}", { status: 401 }));
    }) as typeof fetch;
    const stream = createStream({ apiKey: "dk", baseUrl: "https://api.deepseek.com/v1", fetchImpl });
    for await (const _ of stream({ model: "deepseek-chat", system: "s", messages: [], tools: [], signal: new AbortController().signal })) void _;
    expect(headersSeen[0]!["x-api-key"]).toBe("dk");
    expect(headersSeen[0]!["authorization"]).toBe("Bearer dk");
  });
});
