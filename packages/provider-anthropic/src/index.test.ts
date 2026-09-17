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
