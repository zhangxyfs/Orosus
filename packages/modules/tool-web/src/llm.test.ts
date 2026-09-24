import { describe, it, expect } from "vitest";
import type { LlmPort } from "@orosus/contracts/module";
import type { Chunk } from "@orosus/contracts/provider";
import { llmBackend, LlmSearchError, createLlmSticky, type LlmBackendDeps } from "./backends/llm.ts";

/** 假 LlmPort：脚本化 chunk 序列 + 请求捕获。 */
const fakeLlm = (script: Chunk[][]): { llm: LlmPort; requests: { model?: string; webSearch?: boolean; maxTokens?: number; text: string }[] } => {
  const requests: { model?: string; webSearch?: boolean; maxTokens?: number; text: string }[] = [];
  let i = 0;
  return {
    requests,
    llm: {
      stream: (req) => {
        requests.push({
          ...(req.model !== undefined ? { model: req.model } : {}),
          ...(req.webSearch !== undefined ? { webSearch: req.webSearch } : {}),
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
          text: req.messages.map((m) => (m.role === "toolResult" ? "" : m.content.map((p) => (p.kind === "text" ? p.text : "")).join(""))).join("\n"),
        });
        const chunks = script[Math.min(i++, script.length - 1)]!;
        return (async function* () { for (const c of chunks) yield c; })();
      },
    },
  };
};

const mkBackend = (llm: LlmPort, over: Partial<LlmBackendDeps> = {}) =>
  llmBackend({ llm, cfg: () => ({}), sticky: createLlmSticky(), ...over });

describe("tool-web llm 后端（M4-3 T1b）", () => {
  it("① available 恒真（SW-15 零配置即有搜索）；成功路径 = 摘要裸文本条目 + sources 按 URL 去重", async () => {
    const { llm, requests } = fakeLlm([[
      { type: "server-search", hits: [{ title: "A", url: "https://a/1" }, { title: "A2", url: "https://a/1" }, { title: "B", url: "https://b/2" }] },
      { type: "text/delta", text: "turndown 是 HTML→markdown 库。" },
      { type: "finish", kind: "stop" },
    ]]);
    const b = mkBackend(llm);
    expect(b.available()).toBe(true);
    const hits = await b.search("turndown", new AbortController().signal);
    expect(hits[0]).toEqual({ title: "", url: "", snippet: "turndown 是 HTML→markdown 库。" });
    expect(hits.slice(1)).toEqual([
      { title: "A", url: "https://a/1", snippet: "" },
      { title: "B", url: "https://b/2", snippet: "" },
    ]); // 同 URL 去重
    // 指令模板逐字（Reasonix :86-88）+ 常量（SW-14：maxTokens 8192）+ webSearch 声明
    expect(requests[0]!.text).toBe("Search the web for the following query. Use web search, summarize the relevant findings, and cite the sources.\n\nturndown");
    expect(requests[0]).toMatchObject({ maxTokens: 8192, webSearch: true });
    expect(requests[0]).not.toHaveProperty("model"); // 未钉模型 = 当前模型承载
  });

  it("② 钉模型配置 → stream req.model 透传（provider/model 限定形原样）", async () => {
    const { llm, requests } = fakeLlm([[{ type: "server-search", hits: [{ title: "A", url: "https://a/1" }] }, { type: "text/delta", text: "s" }, { type: "finish", kind: "stop" }]]);
    const b = mkBackend(llm, { cfg: () => ({ model: "kimi-code-plan-cn/k3-256k" }) });
    await b.search("q", new AbortController().signal);
    expect(requests[0]).toMatchObject({ model: "kimi-code-plan-cn/k3-256k" });
  });

  it("③ 门：无 server-search 块 → no-native-results（:147 话术逐字）+ 会话粘性置位", async () => {
    const { llm } = fakeLlm([[{ type: "text/delta", text: "我没有联网能力，但按训练知识答……" }, { type: "finish", kind: "stop" }]]);
    const sticky = createLlmSticky();
    const b = mkBackend(llm, { sticky });
    await expect(b.search("q", new AbortController().signal)).rejects.toThrow("provider returned no native search results; verify that this endpoint and model support web search");
    expect(sticky.llmDowngraded).toBe(true);
  });

  it("④ 端点带内报错 → endpoint-error 带详情；客户端工具请求 → :128 话术", async () => {
    const { llm: llm1 } = fakeLlm([[{ type: "finish", kind: "error", errorMessage: "HTTP 400：unknown tool type" }]]);
    await expect(mkBackend(llm1).search("q", new AbortController().signal)).rejects.toThrow("HTTP 400：unknown tool type");
    const { llm: llm2 } = fakeLlm([[{ type: "toolcall/argumentsDelta", callId: "c1", name: "$web_search", argumentsDelta: "{}" }, { type: "finish", kind: "toolUse" }]]);
    const err = await mkBackend(llm2).search("q", new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmSearchError);
    expect((err as LlmSearchError).kind).toBe("client-tool-requested");
    expect(String(err)).toContain("search provider requested an unsupported client tool");
  });

  it("⑤ 超时（timeoutMs 小值 + 挂起 stream）→ timeout 错误", async () => {
    const hanging: LlmPort = {
      stream: (req) => (async function* (): AsyncGenerator<Chunk> {
        await new Promise((_res, rej) => req.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
        yield* []; // require-yield 满足件（永不到达）
      })(),
    };
    await expect(mkBackend(hanging, { timeoutMs: 50 }).search("q", new AbortController().signal)).rejects.toThrow("llm 搜索超时");
  });

  it("⑥ query 超 4096 字节 → 直接拒（SW-14 界）", async () => {
    const { llm } = fakeLlm([[]]);
    await expect(mkBackend(llm).search("x".repeat(4097), new AbortController().signal)).rejects.toThrow("4096");
  });
});

// 2026-09-24 用户拍板：自动档学 Reasonix「优先会话账号，否则选已开启搜索的可用账号」
describe("tool-web llm 后端自动档遍历（M4-3 走查拍板）", () => {
  /** 按模型名分剧本的假 LlmPort：calls 记录每次 stream 的 model；scriptFor(undefined) = 当前模型。 */
  const fakeLlmByModel = (scriptFor: (model: string | undefined) => Chunk[], catalog?: string[]) => {
    const calls: (string | undefined)[] = [];
    const llm: LlmPort = {
      stream: (req) => {
        const m = req.model;
        calls.push(m);
        const chunks = scriptFor(m);
        return (async function* () { for (const c of chunks) yield c; })();
      },
      ...(catalog !== undefined ? { listModels: async () => catalog } : {}),
    };
    return { llm, calls };
  };
  const noSearch: Chunk[] = [{ type: "text/delta", text: "按训练知识答" }, { type: "finish", kind: "stop" }];
  const withSearch = (url: string): Chunk[] => [
    { type: "server-search", hits: [{ title: "命中", url }] },
    { type: "text/delta", text: "搜索摘要" },
    { type: "finish", kind: "stop" },
  ];

  it("⑦ 遍历成功：当前模型无原生结果 → 逐商探测 → 首个出 server-search 的承载 + 粘性直达 + 透明条", async () => {
    const { llm, calls } = fakeLlmByModel(
      (m) => (m === "openai/gpt-5.4" ? withSearch("https://hit/1") : noSearch),
      ["zhipuai-coding-plan/glm-5.3", "openai/gpt-5.4", "openai/gpt-5.4-mini"],
    );
    const sticky = createLlmSticky();
    const b = llmBackend({ llm, cfg: () => ({}), sticky });
    const hits = await b.search("q", new AbortController().signal);
    // 调用序：当前模型（undefined）→ zhipu 首模型 → openai 首模型（中）——openai 第二模型不探（每商一次）
    expect(calls).toEqual([undefined, "zhipuai-coding-plan/glm-5.3", "openai/gpt-5.4"]);
    expect(sticky.workingModel).toBe("openai/gpt-5.4");
    expect(hits[0]!.snippet).toContain("LLM 搜索实际由 openai/gpt-5.4 承载");
    expect(hits.some((h) => h.url === "https://hit/1")).toBe(true);
    // 第二次搜索直达 workingModel——当前模型与已探商不再重复支付
    calls.length = 0;
    await b.search("q2", new AbortController().signal);
    expect(calls).toEqual(["openai/gpt-5.4"]);
  });

  it("⑧ 遍历全灭 → llmDowngraded 置位 + 抛首错（:147 话术——链层落 tavily/brave）", async () => {
    const { llm, calls } = fakeLlmByModel(() => noSearch, ["a/m1", "b/m2"]);
    const sticky = createLlmSticky();
    const b = llmBackend({ llm, cfg: () => ({}), sticky });
    await expect(b.search("q", new AbortController().signal)).rejects.toThrow("provider returned no native search results");
    expect(calls).toEqual([undefined, "a/m1", "b/m2"]);
    expect(sticky.llmDowngraded).toBe(true);
    expect(sticky.workingModel).toBeUndefined();
  });

  it("⑨ 钉住模型不遍历（SW-15 钉死语义）：目录有别家也零探测，失败直抛", async () => {
    const { llm, calls } = fakeLlmByModel(() => noSearch, ["other/x"]);
    const sticky = createLlmSticky();
    const b = llmBackend({ llm, cfg: () => ({ model: "zhipuai-coding-plan/glm-5.3" }), sticky });
    await expect(b.search("q", new AbortController().signal)).rejects.toThrow("no native search results");
    expect(calls).toEqual(["zhipuai-coding-plan/glm-5.3"]); // 只打钉住的那家
    expect(sticky.llmDowngraded).toBe(false); // 钉死失败不污染自动档粘性（链层 pinned 路径本就不读它）
  });

  it("⑩ workingModel 失能 → 清粘性重走遍历（新商接续承载）", async () => {
    let broken = false;
    const { llm, calls } = fakeLlmByModel((m) => {
      if (m === "openai/gpt-5.4" && !broken) return withSearch("https://hit/1");
      if (m === "xai/grok-5") return withSearch("https://hit/2");
      return noSearch;
    }, ["openai/gpt-5.4", "xai/grok-5"]);
    const sticky = createLlmSticky();
    const b = llmBackend({ llm, cfg: () => ({}), sticky });
    await b.search("q", new AbortController().signal);
    expect(sticky.workingModel).toBe("openai/gpt-5.4");
    broken = true; // openai 失能
    calls.length = 0;
    const hits = await b.search("q3", new AbortController().signal);
    // 粘性模型失败后：直达失败 → 当前模型（不重探已探的 openai）→ xai 接续
    expect(calls).toEqual(["openai/gpt-5.4", undefined, "xai/grok-5"]);
    expect(sticky.workingModel).toBe("xai/grok-5");
    expect(hits.some((h) => h.url === "https://hit/2")).toBe(true);
  });
});
