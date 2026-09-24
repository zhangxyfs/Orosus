import { describe, it, expect } from "vitest";
import type { LlmPort } from "@orosus/contracts/module";
import type { Chunk } from "@orosus/contracts/provider";
import { llmBackend, LlmSearchError, type LlmBackendDeps } from "./backends/llm.ts";

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
  llmBackend({ llm, cfg: () => ({}), sticky: { llmDowngraded: false }, ...over });

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
    const sticky = { llmDowngraded: false };
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
