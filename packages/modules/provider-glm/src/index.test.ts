import { describe, it, expect } from "vitest";
import def from "./index.ts";
import { mapEvent, type SseState } from "./translate.ts";
import { createListModels, createStream } from "./stream.ts";

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

describe("errorCode 与 maxTokens（M3 补强 T2/D43）", () => {
  const req = (maxTokens?: number) => ({
    model: "glm-5.3", system: "s", messages: [], tools: [], signal: new AbortController().signal,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });
  const last = async (stream: ReturnType<typeof createStream>, r: ReturnType<typeof req>): Promise<unknown> => {
    let out: unknown;
    for await (const c of stream(r)) out = c;
    return out;
  };

  it("HTTP 400 超限体 → finish{error, errorCode: context_limit}；鉴权错误体不带码", async () => {
    const over = createStream({ apiKey: "zk", baseUrl: "http://x", fetchImpl: (async () => new Response("This model's maximum context length is 65536 tokens", { status: 400 })) as typeof fetch });
    expect(await last(over, req())).toMatchObject({ type: "finish", kind: "error", errorCode: "context_limit" });
    const auth = createStream({ apiKey: "zk", baseUrl: "http://x", fetchImpl: (async () => new Response("invalid api key", { status: 400 })) as typeof fetch });
    const fin = await last(auth, req());
    expect(fin).toMatchObject({ type: "finish", kind: "error" });
    expect((fin as { errorCode?: string }).errorCode).toBeUndefined();
  });

  it("maxTokens 覆盖缺省 MAX_TOKENS(8192) 进请求体 max_tokens（anthropic 线缆）", async () => {
    let captured: Record<string, unknown> | undefined;
    const s = createStream({ apiKey: "zk", baseUrl: "http://x", fetchImpl: (async (_u: unknown, init?: RequestInit) => { captured = JSON.parse(String(init!.body)); return new Response("", { status: 200 }); }) as typeof fetch });
    await last(s, req(1234));
    expect(captured!.max_tokens).toBe(1234);
    await last(s, req());
    expect(captured!.max_tokens).toBe(8192);
  });
});


describe("listModels（模型发现 T2/D32 修订）", () => {
  it("GET http://x/v1/models 双头鉴权 → sanitize/排序清单；404 → reject（回退由消费方 catch）", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    let n = 0;
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      n++;
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return Promise.resolve(n === 1
        ? new Response(JSON.stringify({ data: [{ id: "m-2" }, { id: "bad id" }, { id: "m-1" }] }), { status: 200 })
        : new Response("nope", { status: 404 }));
    }) as typeof fetch;
    const lm = createListModels({ apiKey: "sk-1", baseUrl: "http://x", fetchImpl });
    expect(await lm()).toEqual(["m-2", "m-1"]); // 倒序 + sanitize 滤非法 id（走查缺陷②）
    expect(seen[0]!.url).toBe("http://x/v1/models");
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-1");
    expect(seen[0]!.headers["authorization"]).toBe("Bearer sk-1");
    await expect(lm()).rejects.toThrow("HTTP 404");
  });
});
