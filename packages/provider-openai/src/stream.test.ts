import { describe, it, expect } from "vitest";
import { createStream } from "./stream.ts";

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
