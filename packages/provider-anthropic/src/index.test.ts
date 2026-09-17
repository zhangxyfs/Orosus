import { describe, it, expect } from "vitest";
import def from "./index.ts";

type Ctx = Parameters<typeof def.activate>[0];

/** 最小 fake ctx：provider-anthropic 只用到 provide 口。 */
function fakeCtx() {
  const services = new Map<string, unknown>();
  const ctx = {
    config: { apiKey: "sk-test", baseUrl: "https://example.invalid" },
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

describe("provider-anthropic 槽值（D32）", () => {
  it("activate 注册 { stream, defaultModel } 对象到 provider:anthropic", async () => {
    const { ctx, services } = fakeCtx();
    await def.activate(ctx);
    const v = services.get("provider:anthropic") as { stream: unknown; defaultModel?: string };
    expect(typeof v).toBe("object");
    expect(typeof v.stream).toBe("function");
    expect(v.defaultModel).toBe("claude-sonnet-4-5");
  });
});

describe("provider-anthropic 双头鉴权（D31 回归）", () => {
  it("请求同时携带 x-api-key 与 Authorization Bearer 同值", async () => {
    const { ctx, services } = fakeCtx();
    await def.activate(ctx);
    void services.get("provider:anthropic");
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return Promise.resolve(new Response("{\"type\":\"error\"}", { status: 401 }));
    }) as typeof fetch;
    const stream = (await import("./stream.ts")).createStream({ apiKey: "sk-a", baseUrl: "https://api.anthropic.com", fetchImpl });
    for await (const _ of stream({ model: "m", system: "s", messages: [], tools: [], signal: new AbortController().signal } as never)) void _;
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-a");
    expect(seen[0]!.headers["authorization"]).toBe("Bearer sk-a");
  });
});
