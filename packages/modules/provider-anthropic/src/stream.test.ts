import { describe, it, expect } from "vitest";
import { createStream } from "./stream.ts";

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
