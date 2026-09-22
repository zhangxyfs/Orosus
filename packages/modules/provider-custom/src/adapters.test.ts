import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import def from "./index.ts";
import { configSchema, createAdapters, diskFirstCatalogLoader } from "./adapters.ts";

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
/** 目录密封件（测试不打网络）：加载即失败 → 槽值 listModels 走 live 兜底。 */
const catalogOff = async (): Promise<never> => { throw new Error("catalog off（test）"); };
/** 目录命中件：zhipuai-coding-plan 条目两可用模型（日期新→旧）+ 一枚 deprecated 应被滤除。 */
const catalogWithCodingPlan = async () => ({
  source: "online" as const,
  catalog: {
    "zhipuai-coding-plan": {
      models: {
        "glm-5.3": { id: "glm-5.3", release_date: "2026-08-01" },
        "glm-5.3-flash": { id: "glm-5.3-flash", release_date: "2026-09-01" }, // 日期新 → 排前
        "glm-old": { id: "glm-old", status: "deprecated" },                  // 应被滤除
      },
    },
  },
});

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

describe("listModels（模型发现 T2/D32 修订——createAdapters 随槽装配）", () => {
  it("两族各自的 /models 落点与双头鉴权；404 → reject", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    let n = 0;
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      n++;
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return Promise.resolve(n <= 2
        ? new Response(JSON.stringify({ data: [{ id: "m-1" }, { id: "m-0" }] }), { status: 200 })
        : new Response("nope", { status: 404 }));
    }) as typeof fetch;
    const adapters = createAdapters({ providers: { i: { ...entry, apiKey: "k" }, a: withDm } }, fetchImpl, catalogOff);
    expect(await adapters.get("i")!.listModels!()).toEqual(["m-1", "m-0"]); // openai 族 {baseUrl}/models
    expect(seen[0]!.url).toBe("http://a/v1/models");
    expect(await adapters.get("a")!.listModels!()).toEqual(["m-1", "m-0"]); // anthropic 族 {baseUrl}/v1/models
    expect(seen[1]!.url).toBe("http://b/v1/models");
    expect(seen[1]!.headers["authorization"]).toBe("Bearer $ENV:X"); // $ENV 占位原样作为 key 传递（解析在 env 层）
    await expect(adapters.get("i")!.listModels!()).rejects.toThrow("HTTP 404");
  });

  it("目录优选：全量目录（online）含本槽条目 → 策展清单为覆盖口径且不发端点请求（2026-09-22 /model 清单修复——live 按量池混入套餐外模型，选了就 1113；deprecated/非 tool_call 过滤随目录口径）", async () => {
    let liveCalls = 0;
    const fetchImpl = (async () => { liveCalls++; return new Response(JSON.stringify({ data: [{ id: "glm-4.7" }, { id: "glm-5.2" }] }), { status: 200 }); }) as typeof fetch;
    const adapters = createAdapters({ providers: { "zhipuai-coding-plan": entry } }, fetchImpl, catalogWithCodingPlan);
    expect(await adapters.get("zhipuai-coding-plan")!.listModels!()).toEqual(["glm-5.3-flash", "glm-5.3"]);
    expect(liveCalls).toBe(0); // 目录命中即覆盖口径——live 不被调用
  });

  it("目录兜底四态：builtin 裁剪快照 / 无本槽条目 / 条目模型全滤空 / 目录加载失败 → 一律回 live 清单", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: "m-1" }] }), { status: 200 })) as typeof fetch;
    const liveOf = async (loadCatalog: Parameters<typeof createAdapters>[2]) =>
      createAdapters({ providers: { x: entry } }, fetchImpl, loadCatalog).get("x")!.listModels!();
    expect(await liveOf(async () => ({ source: "builtin" as const, catalog: { x: { models: { "m-cat": { id: "m-cat" } } } } }))).toEqual(["m-1"]);
    expect(await liveOf(async () => ({ source: "online" as const, catalog: {} }))).toEqual(["m-1"]);
    expect(await liveOf(async () => ({ source: "disk" as const, catalog: { x: { models: { "m-old": { id: "m-old", status: "deprecated" } } } } }))).toEqual(["m-1"]);
    expect(await liveOf(catalogOff)).toEqual(["m-1"]);
  });

  it("diskFirstCatalogLoader：盘上缓存命中 → 直读返回 disk 源（不为 /model 列表走在线供给链——2026-09-22 用户拍板）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-cat-"));
    const file = join(dir, "models-dev.json");
    writeFileSync(file, JSON.stringify({ fetchedAt: 1, catalog: { x: { models: { m: { id: "m" } } } } }), "utf8");
    const out = await diskFirstCatalogLoader(file)();
    expect(out.source).toBe("disk");
    expect(Object.keys(out.catalog)).toEqual(["x"]);
  });
});
