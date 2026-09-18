import { describe, it, expect } from "vitest";
import { classifyContextLimit, parseModelsResponse, providerSlotKey, type Chunk } from "./index.ts";

describe("providerSlotKey", () => {
  it("生成核心保留槽 key", () => {
    expect(providerSlotKey("anthropic")).toBe("provider:anthropic");
  });
});

describe("Chunk 词汇", () => {
  it("finish 带内错误是合法 chunk（不许 reject，§6.4）", () => {
    const err: Chunk = { type: "finish", kind: "error", errorMessage: "boom" };
    expect(err.kind).toBe("error");
  });
});

describe("finish.errorCode 与 classifyContextLimit（M3 补强 T1/D43）", () => {
  it("finish 带 errorCode 是合法 chunk——适配器归一化的可编程错误码（首枚 context_limit）", () => {
    const err: Chunk = { type: "finish", kind: "error", errorMessage: "HTTP 400：prompt is too long", errorCode: "context_limit" };
    expect(err.errorCode).toBe("context_limit");
  });

  it("parseModelsResponse：排序/anthropic 形/去重/sanitize（白名单外与超限丢弃）/空与坏形状 reject", () => {
    expect(parseModelsResponse({ data: [{ id: "b" }, { id: "a" }] })).toEqual(["a", "b"]);
    expect(parseModelsResponse({ data: [{ id: "x", display_name: "X" }] })).toEqual(["x"]);
    expect(parseModelsResponse({ data: [{ id: "a" }, { id: "a" }] })).toEqual(["a"]); // 去重
    expect(parseModelsResponse({ data: [{ id: "ok" }, { id: "bad id" }, { id: "x".repeat(200) }] })).toEqual(["ok"]); // sanitize
    expect(() => parseModelsResponse({ data: [] })).toThrow();
    expect(() => parseModelsResponse({})).toThrow();
    expect(() => parseModelsResponse("bad")).toThrow();
    expect(() => parseModelsResponse({ data: [{ id: "bad id" }] })).toThrow(); // 全滤空
  });

  it("ProviderAdapter 对象形带 listModels 是合法槽值（D32 修订——尽力能力，缺省则消费方回退）", () => {
    const adapter: import("./index.ts").ProviderAdapter = {
      stream: () => (async function* () { yield { type: "finish", kind: "stop" }; })(),
      defaultModel: "m0",
      listModels: async () => ["m0"],
    };
    expect(adapter).toMatchObject({ defaultModel: "m0" });
  });

  it("classifyContextLimit 判定表——命中四形状（Anthropic/OpenAI/Kimi/GLM 系）；非命中：鉴权错误与状态码不符", () => {
    expect(classifyContextLimit(400, "prompt is too long: 200000 tokens > 190000 maximum")).toBe(true);
    expect(classifyContextLimit(400, '{"error":{"code":"context_length_exceeded"}}')).toBe(true);
    expect(classifyContextLimit(400, "This model's maximum context length is 65536 tokens")).toBe(true);
    expect(classifyContextLimit(413, "request too large")).toBe(true);
    expect(classifyContextLimit(400, "invalid api key")).toBe(false);
    expect(classifyContextLimit(200, "maximum context length")).toBe(false); // 状态不符
    expect(classifyContextLimit(500, "maximum context length")).toBe(false);
  });
});
