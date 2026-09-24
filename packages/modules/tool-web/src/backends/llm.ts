import type { LlmPort } from "@orosus/contracts/module";
import type { SearchConfig, SearchResult, WebSearchBackend } from "../search.ts";

/** SW-14 常量区（Reasonix search.go:18-25 六值逐字平移）。 */
const MAX_QUERY_BYTES = 4096;
const MAX_SUMMARY_CHARS = 12_000; // Reasonix 按字节帽；本件按字符帽（CJK 不劈半——超帽场景差异可忽略，登记）
const MAX_SOURCES = 8;
const MAX_SOURCE_SNIPPET_CHARS = 2048;
const MAX_OUTPUT_TOKENS = 8192;
const SEARCH_TIMEOUT_MS = 90_000;

/** 指令模板原文（Reasonix search.go:86-88 逐字）+ query——一次性辅助调用，绝不进会话历史。 */
const instruction = (query: string): string =>
  `Search the web for the following query. Use web search, summarize the relevant findings, and cite the sources.\n\n${query}`;

/** llm 搜索失败的原因袋——链降级判定与话术拼装都靠它（search.ts 链据此决定落下一档）。 */
export class LlmSearchError extends Error {
  readonly kind: "endpoint-error" | "no-native-results" | "client-tool-requested" | "interrupted" | "timeout";
  constructor(kind: LlmSearchError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface LlmBackendDeps {
  llm: LlmPort;
  /** 钉住的搜索模型（[tool-web] search.model——provider/model 限定形或裸模型名）；缺省 undefined = 当前模型承载（v4 拍板）。 */
  cfg: () => SearchConfig;
  /** SW-19 会话粘性：本会话 llm 槽已判定不可用——后续 auto 链直接从 tavily 起步（/settings 重选后由模块侧清除）。 */
  sticky: { llmDowngraded: boolean };
  timeoutMs?: number; // 默认 90s（SW-14）；测试注入小值
}

/** LLM 原生联网后端（Reasonix 方式）：一次性独立 LLM 调用复用已配模型账号，零新 key。
 *  available() 恒真（SW-15——model 未配 = 当前模型承载，零配置即有搜索）；端点不支持在调用点探测
 *  （无原生搜索结果 → :147 话术失败）并按 SW-19 会话粘性降级。 */
export function llmBackend(deps: LlmBackendDeps): WebSearchBackend {
  return {
    kind: "llm",
    available: () => true,
    search: async (query, signal): Promise<SearchResult[]> => {
      const queryBytes = Buffer.byteLength(query, "utf8");
      if (queryBytes < 1 || queryBytes > MAX_QUERY_BYTES) {
        throw new LlmSearchError("endpoint-error", `query 长度 ${queryBytes} 字节超出 1..${MAX_QUERY_BYTES} 界（SW-14）`);
      }
      const timeoutMs = deps.timeoutMs ?? SEARCH_TIMEOUT_MS;
      const timeoutSig = AbortSignal.timeout(timeoutMs);
      const combined = AbortSignal.any([signal, timeoutSig]);
      const cfg = deps.cfg();
      let summary = "";
      const sources: SearchResult[] = [];
      const seen = new Set<string>();
      let searched = false;
      let streamError: string | undefined;
      let clientToolRequested = false;
      try {
        for await (const c of deps.llm.stream({
          messages: [{ role: "user", content: [{ kind: "text", text: instruction(query) }] }],
          maxTokens: MAX_OUTPUT_TOKENS,
          ...(cfg.model !== undefined && cfg.model.trim() !== "" ? { model: cfg.model.trim() } : {}),
          webSearch: true,
          signal: combined,
        })) {
          if (c.type === "text/delta") summary += c.text;
          else if (c.type === "server-search") {
            searched = true; // 协议层搜索活动在场 = 「真搜过」判据（Reasonix web_search_call completed 同款思想）
            for (const h of c.hits) {
              if (seen.has(h.url) || sources.length >= MAX_SOURCES) continue; // 按 URL 去重（Reasonix seen 同款）
              seen.add(h.url);
              sources.push({ title: h.title, url: h.url, snippet: "" });
            }
          } else if (c.type === "toolcall/argumentsDelta") {
            clientToolRequested = true; // 服务端反过来要客户端工具（Reasonix :128——搜索必须留在服务端）
          } else if (c.type === "finish") {
            if (c.kind === "error") streamError = c.errorMessage ?? "流以 error 结束（无详情）";
            if (c.kind === "aborted") streamError = "aborted";
            break;
          }
          if (summary.length > MAX_SUMMARY_CHARS) summary = `${summary.slice(0, MAX_SUMMARY_CHARS)}…`; // boundedText 截断
        }
      } catch (err) {
        if (timeoutSig.aborted && !signal.aborted) throw new LlmSearchError("timeout", `llm 搜索超时（${timeoutMs}ms）`);
        throw new LlmSearchError("endpoint-error", `llm 搜索调用失败：${err instanceof Error ? err.message : String(err)}`);
      }
      if (signal.aborted) throw new LlmSearchError("interrupted", "搜索已中止");
      if (timeoutSig.aborted) throw new LlmSearchError("timeout", `llm 搜索超时（${timeoutMs}ms）`);
      if (clientToolRequested) {
        // Reasonix :128 话术照抄：端点要求客户端工具 = 搜索没留在服务端
        throw new LlmSearchError("client-tool-requested", "search provider requested an unsupported client tool");
      }
      if (streamError !== undefined) {
        if (streamError === "aborted") throw new LlmSearchError("interrupted", "搜索已中止");
        throw new LlmSearchError("endpoint-error", `llm 搜索端点报错：${streamError}`);
      }
      if (!searched) {
        // Reasonix :147 话术照抄——端点没返回原生搜索结果（2026-09-24 spike：zhipu coding 端点接受声明
        // 但按训练知识作答、无协议层搜索块，正落此门）；SW-19：置会话粘性，后续 auto 链跳过本槽
        deps.sticky.llmDowngraded = true;
        throw new LlmSearchError("no-native-results", "provider returned no native search results; verify that this endpoint and model support web search");
      }
      const out: SearchResult[] = [];
      // 摘要 = 无 URL 的裸文本条目（Reasonix Result.Summary 对应物），拼装层渲染为自然段；sources 随后为带链接条目
      if (summary.trim() !== "") out.push({ title: "", url: "", snippet: summary.trim() });
      out.push(...sources.map((s) => ({ ...s, snippet: s.snippet.slice(0, MAX_SOURCE_SNIPPET_CHARS) })));
      return out;
    },
  };
}
