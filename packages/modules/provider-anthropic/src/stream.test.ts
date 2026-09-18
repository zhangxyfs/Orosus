import { describe, it, expect } from "vitest";
import { createListModels, createStream } from "./stream.ts";

describe("provider-anthropic 流（M3 补强 T2/D43）", () => {
  const req = (maxTokens?: number) => ({
    model: "claude-x", system: "s", messages: [], tools: [], signal: new AbortController().signal,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });
  const last = async (stream: ReturnType<typeof createStream>, r: ReturnType<typeof req>): Promise<unknown> => {
    let out: unknown;
    for await (const c of stream(r)) out = c;
    return out;
  };

  it("HTTP 400 超限体 → finish{error, errorCode: context_limit}；鉴权错误体不带码（回归：仍带内不 reject）", async () => {
    const over = createStream({ apiKey: "ak", baseUrl: "http://x", fetchImpl: (async () => new Response("prompt is too long: 200000 tokens > 190000 maximum", { status: 400 })) as typeof fetch });
    expect(await last(over, req())).toMatchObject({ type: "finish", kind: "error", errorCode: "context_limit" });
    const auth = createStream({ apiKey: "ak", baseUrl: "http://x", fetchImpl: (async () => new Response("invalid api key", { status: 400 })) as typeof fetch });
    const fin = await last(auth, req());
    expect(fin).toMatchObject({ type: "finish", kind: "error" });
    expect((fin as { errorCode?: string }).errorCode).toBeUndefined();
  });

  it("maxTokens 覆盖缺省 MAX_TOKENS(8192) 进请求体 max_tokens（anthropic 线缆必填字段）", async () => {
    let captured: Record<string, unknown> | undefined;
    const s = createStream({ apiKey: "ak", baseUrl: "http://x", fetchImpl: (async (_u: unknown, init?: RequestInit) => { captured = JSON.parse(String(init!.body)); return new Response("", { status: 200 }); }) as typeof fetch });
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
