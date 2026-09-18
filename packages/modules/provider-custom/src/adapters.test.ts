import { describe, it, expect } from "vitest";
import def from "./index.ts";
import { configSchema, createAdapters } from "./adapters.ts";

type Ctx = Parameters<typeof def.activate>[0];

function fakeCtx(config: unknown) {
  const provides: Array<[string, unknown]> = [];
  const commands: string[] = [];
  const ctx = {
    config,
    configRead: () => Promise.resolve(undefined),
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    services: { get: () => Promise.reject(new Error("no")), getOptional: () => Promise.resolve(undefined) },
    provide: (k: string, impl: unknown) => void provides.push([k, impl]),
    contribute: {
      tool: () => () => {},
      command: (name: string) => { commands.push(name); return () => {}; },
      promptSection: () => () => {},
    },
    session: { append: () => {} },
    events: { on: () => () => {}, emit: () => Promise.resolve() },
  } as unknown as Ctx;
  return { ctx, provides, commands };
}

const entry = { type: "openai" as const, baseUrl: "http://a/v1" };
const withDm = { type: "anthropic" as const, baseUrl: "http://b", apiKey: "$ENV:X", defaultModel: "pro-32b" };

describe("provider-custom（D33 多槽注册与区内厂商表）", () => {
  it("两厂商（两族各一）注册两槽，defaultModel 有值时随槽携带", () => {
    const adapters = createAdapters({ providers: { inhouse: entry, aigc: withDm } });
    expect(adapters.size).toBe(2);
    expect(adapters.get("inhouse")!.defaultModel).toBeUndefined();
    expect(typeof adapters.get("inhouse")!.stream).toBe("function");
    expect(adapters.get("aigc")!.defaultModel).toBe("pro-32b");
  });

  it("无 defaultModel 的条目槽值为 { stream }（D32 union 的另一分支）", () => {
    const a = createAdapters({ providers: { x: entry } }).get("x")!;
    expect(typeof a).toBe("object");
    expect(a.defaultModel).toBeUndefined();
  });

  it("config 校验：非法 type / 缺 baseUrl / 非 kebab-case 槽名 → zod 报错路径", () => {
    expect(configSchema.safeParse({ providers: { x: { type: "gemini", baseUrl: "http://a" } } }).success).toBe(false);
    expect(configSchema.safeParse({ providers: { x: { type: "openai" } } }).success).toBe(false);
    const bad = configSchema.safeParse({ providers: { Bad_Name: entry } });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues.some((i) => i.path.join(".").includes("Bad_Name"))).toBe(true);
  });

  it("空 providers 表 → activate 成功零槽（空转合法）", async () => {
    const { ctx, provides } = fakeCtx({ providers: {} });
    await def.activate(ctx);
    expect(provides).toHaveLength(0);
  });

  it("M2 补账：schema 缺省路径——section 整体缺失（全新安装）providers 默认空表", () => {
    const parsed = configSchema.parse({}); // 不传 providers 键，走 default 分支
    expect(parsed.providers).toEqual({});
  });

  it("M2 补账：activate 注册 provider-custom__provider 命令（/provider 别名的真实目标）", async () => {
    const { ctx, provides, commands } = fakeCtx({ providers: {} });
    await def.activate(ctx);
    expect(provides).toHaveLength(0);
    expect(commands).toEqual(["provider-custom__provider"]); // T7 计划明文要求、原实现漏做
  });

  it("槽名 glm 与内置撞名时 provide 照常调用（冲突降级归 kernel 既有机制）", async () => {
    const { ctx, provides } = fakeCtx({ providers: { glm: { type: "anthropic", baseUrl: "http://g" } } });
    await def.activate(ctx);
    expect(provides[0]![0]).toBe("provider:glm");
  });

  it("anthropic 族流走 {baseUrl}/v1/messages（fetch 落点）", async () => {
    const seen: string[] = [];
    const fetchImpl = ((url: string | URL | Request) => {
      seen.push(String(url));
      return Promise.resolve(new Response("{}", { status: 401 }));
    }) as typeof fetch;
    const a = createAdapters({ providers: { a: withDm } }, fetchImpl).get("a")!;
    for await (const _ of a.stream({ model: "m", system: "s", messages: [], tools: [], signal: new AbortController().signal })) void _;
    expect(seen[0]).toBe("http://b/v1/messages");
  });

  it("openai 族流走 {baseUrl}/chat/completions（fetch 落点）", async () => {
    const seen: string[] = [];
    const fetchImpl = ((url: string | URL | Request) => {
      seen.push(String(url));
      return Promise.resolve(new Response("{}", { status: 401 }));
    }) as typeof fetch;
    const a = createAdapters({ providers: { i: { ...entry, apiKey: "k" } } }, fetchImpl).get("i")!;
    for await (const _ of a.stream({ model: "m", system: "s", messages: [], tools: [], signal: new AbortController().signal })) void _;
    expect(seen[0]).toBe("http://a/v1/chat/completions");
  });
});

describe("errorCode 与 maxTokens（M3 补强 T2/D43）", () => {
  const req = (maxTokens?: number) => ({
    model: "m", system: "s", messages: [], tools: [], signal: new AbortController().signal,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });
  const last = async (stream: (r: ReturnType<typeof req>) => AsyncIterable<unknown>, r: ReturnType<typeof req>): Promise<unknown> => {
    let out: unknown;
    for await (const c of stream(r)) out = c;
    return out;
  };

  it("openai 族：HTTP 400 超限体 → errorCode context_limit；鉴权体不带码", async () => {
    const over = createAdapters({ providers: { i: { ...entry, apiKey: "k" } } }, (async () => new Response("This model's maximum context length is 65536 tokens", { status: 400 })) as typeof fetch).get("i")!;
    expect(await last(over.stream, req())).toMatchObject({ type: "finish", kind: "error", errorCode: "context_limit" });
    const auth = createAdapters({ providers: { i: { ...entry, apiKey: "k" } } }, (async () => new Response("invalid api key", { status: 400 })) as typeof fetch).get("i")!;
    const fin = await last(auth.stream, req());
    expect(fin).toMatchObject({ type: "finish", kind: "error" });
    expect((fin as { errorCode?: string }).errorCode).toBeUndefined();
  });

  it("两族 maxTokens 语义并例：anthropic 覆盖缺省 8192、openai 缺省不发送", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => { captured = JSON.parse(String(init!.body)); return new Response("", { status: 200 }); }) as typeof fetch;
    const adapters = createAdapters({ providers: { a: withDm, i: { ...entry, apiKey: "k" } } }, fetchImpl);
    await last(adapters.get("a")!.stream, req(1234));
    expect(captured!.max_tokens).toBe(1234);
    await last(adapters.get("a")!.stream, req());
    expect(captured!.max_tokens).toBe(8192);
    await last(adapters.get("i")!.stream, req(555));
    expect(captured!.max_tokens).toBe(555);
    await last(adapters.get("i")!.stream, req());
    expect("max_tokens" in captured!).toBe(false);
  });
});
