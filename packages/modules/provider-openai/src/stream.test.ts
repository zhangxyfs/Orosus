import { describe, it, expect } from "vitest";
import { createListModels, createStream } from "./stream.ts";

const sseResponse = (lines: string[]): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const l of lines) c.enqueue(enc.encode(l));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const collect = async (iter: AsyncIterable<unknown>) => {
  const out: unknown[] = [];
  for await (const c of iter) out.push(c);
  return out;
};

describe("provider-openai stream glue", () => {
  it("落点/双头/无 key 零头/[DONE] 兜底/4xx 带内", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    let respond: () => Response = () => sseResponse([`data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`, `data: [DONE]\n\n`]);
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
      return Promise.resolve(respond());
    }) as typeof fetch;
    const base = { model: "gpt-x", system: "s", messages: [], tools: [], signal: new AbortController().signal };

    // 无 key：零鉴权头 + SSE 正常 + [DONE] 兜底（无 finish_reason → stop）
    const s1 = createStream({ baseUrl: "https://api.openai.com/v1", fetchImpl });
    const r1 = await collect(s1(base));
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    expect(String(calls[0]!.body)).toContain("\"stream\":true");
    expect(String(calls[0]!.body)).toContain("include_usage");
    expect(r1).toEqual([{ type: "text/delta", text: "hi" }, { type: "finish", kind: "stop" }]);

    // 有 key：双头同值（D31）
    const s2 = createStream({ apiKey: "sk-x", baseUrl: "https://api.openai.com/v1", fetchImpl });
    await collect(s2(base));
    expect(calls[1]!.headers["x-api-key"]).toBe("sk-x");
    expect(calls[1]!.headers["authorization"]).toBe("Bearer sk-x");

    // 4xx → 带内 finish/error
    respond = () => new Response("{\"error\":{\"message\":\"bad key\"}}", { status: 401 });
    const s3 = createStream({ apiKey: "sk-x", baseUrl: "https://api.openai.com/v1", fetchImpl });
    const r3 = await collect(s3(base));
    expect(r3[0]).toMatchObject({ type: "finish", kind: "error" });
    expect((r3[0] as { errorMessage: string }).errorMessage).toContain("401");
  });
});

describe("errorCode 与 maxTokens（M3 补强 T2/D43）", () => {
  const req = (maxTokens?: number) => ({
    model: "gpt-x", system: "s", messages: [], tools: [], signal: new AbortController().signal,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });

  it("HTTP 400 超限体 → finish{error, errorCode: context_limit}；鉴权错误体不带码（回归：仍带内不 reject）", async () => {
    const over = createStream({ baseUrl: "http://x", fetchImpl: (async () => new Response("This model's maximum context length is 65536 tokens", { status: 400 })) as typeof fetch });
    expect((await collect(over(req()))).at(-1)).toMatchObject({ type: "finish", kind: "error", errorCode: "context_limit" });
    const auth = createStream({ baseUrl: "http://x", fetchImpl: (async () => new Response("invalid api key", { status: 400 })) as typeof fetch });
    const fin = (await collect(auth(req()))).at(-1);
    expect(fin).toMatchObject({ type: "finish", kind: "error" });
    expect((fin as { errorCode?: string }).errorCode).toBeUndefined();
  });

  it("maxTokens 透传进请求体 max_tokens；缺省不发送（openai 线缆现行为不变）", async () => {
    let captured: Record<string, unknown> | undefined;
    const s = createStream({ baseUrl: "http://x", fetchImpl: (async (_u: unknown, init?: RequestInit) => { captured = JSON.parse(String(init!.body)); return sseResponse([`data: [DONE]\n\n`]); }) as typeof fetch });
    await collect(s(req(1234)));
    expect(captured!.max_tokens).toBe(1234);
    await collect(s(req()));
    expect("max_tokens" in captured!).toBe(false);
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
    const lm = createListModels({ apiKey: "sk-1", baseUrl: "http://x/v1", fetchImpl });
    expect(await lm()).toEqual(["m-1", "m-2"]); // 排序 + sanitize 滤非法 id
    expect(seen[0]!.url).toBe("http://x/v1/models");
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-1");
    expect(seen[0]!.headers["authorization"]).toBe("Bearer sk-1");
    await expect(lm()).rejects.toThrow("HTTP 404");
  });
});
