import { describe, it, expect } from "vitest";
import def from "./index.ts";
import { mapSseChunk, type OaiStreamState } from "./translate.ts";
import { createListModels, createStream } from "./stream.ts";

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

  it("DeepSeek 方言：usage 与 finish 帧同帧 → 不丢、追加在 finish 之后（/usage 走查）", () => {
    const s: OaiStreamState = { calls: new Map() };
    expect(mapSseChunk(s, { choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 34 } }))
      .toEqual([{ type: "finish", kind: "stop" }, { type: "usage", input: 12, output: 34 }]);
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

describe("errorCode 与 maxTokens（M3 补强 T2/D43）", () => {
  const req = (maxTokens?: number) => ({
    model: "deepseek-chat", system: "s", messages: [], tools: [], signal: new AbortController().signal,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });
  const last = async (stream: ReturnType<typeof createStream>, r: ReturnType<typeof req>): Promise<unknown> => {
    let out: unknown;
    for await (const c of stream(r)) out = c;
    return out;
  };

  it("HTTP 400 超限体 → finish{error, errorCode: context_limit}；鉴权错误体不带码", async () => {
    const over = createStream({ apiKey: "dk", baseUrl: "http://x", fetchImpl: (async () => new Response("This model's maximum context length is 65536 tokens", { status: 400 })) as typeof fetch });
    expect(await last(over, req())).toMatchObject({ type: "finish", kind: "error", errorCode: "context_limit" });
    const auth = createStream({ apiKey: "dk", baseUrl: "http://x", fetchImpl: (async () => new Response("invalid api key", { status: 400 })) as typeof fetch });
    const fin = await last(auth, req());
    expect(fin).toMatchObject({ type: "finish", kind: "error" });
    expect((fin as { errorCode?: string }).errorCode).toBeUndefined();
  });

  it("maxTokens 透传进 max_tokens；缺省不发送（openai 线缆现行为不变）", async () => {
    let captured: Record<string, unknown> | undefined;
    const s = createStream({ apiKey: "dk", baseUrl: "http://x", fetchImpl: (async (_u: unknown, init?: RequestInit) => { captured = JSON.parse(String(init!.body)); return new Response("data: [DONE]\n\n", { status: 200 }); }) as typeof fetch });
    await last(s, req(1234));
    expect(captured!.max_tokens).toBe(1234);
    await last(s, req());
    expect("max_tokens" in captured!).toBe(false);
  });
});


describe("listModels（模型发现 T2/D32 修订）", () => {
  it("GET https://api.deepseek.com/v1/models 双头鉴权 → sanitize/排序清单；404 → reject（回退由消费方 catch）", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    let n = 0;
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      n++;
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return Promise.resolve(n === 1
        ? new Response(JSON.stringify({ data: [{ id: "m-2" }, { id: "bad id" }, { id: "m-1" }] }), { status: 200 })
        : new Response("nope", { status: 404 }));
    }) as typeof fetch;
    const lm = createListModels({ apiKey: "sk-1", baseUrl: "https://api.deepseek.com/v1", fetchImpl });
    expect(await lm()).toEqual(["m-2", "m-1"]); // 倒序 + sanitize 滤非法 id（走查缺陷②）
    expect(seen[0]!.url).toBe("https://api.deepseek.com/v1/models");
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-1");
    expect(seen[0]!.headers["authorization"]).toBe("Bearer sk-1");
    await expect(lm()).rejects.toThrow("HTTP 404");
  });
});
