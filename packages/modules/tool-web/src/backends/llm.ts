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

/** SW-19 会话粘性（自动档遍历版——2026-09-24 用户拍板学 Reasonix 自动语义）：
 *  llmDowngraded = llm 槽整槽判定不可用（探测全灭）；workingModel = 遍历找到的真能搜的 provider/model
 * （此后直达不重复探测）；probed = 本会话已探测过的 provider/model（不重复支付注定失败的调用）。 */
export interface LlmSticky {
  llmDowngraded: boolean;
  workingModel?: string | undefined;
  probed: string[];
}

export const createLlmSticky = (): LlmSticky => ({ llmDowngraded: false, probed: [] });

export interface LlmBackendDeps {
  llm: LlmPort;
  /** 钉住的搜索模型（[tool-web] search.model——provider/model 限定形或裸模型名）；缺省 undefined = 自动档（当前模型承载 + 遍历）。 */
  cfg: () => SearchConfig;
  sticky: LlmSticky;
  timeoutMs?: number; // 默认 90s（SW-14）；测试注入小值
}

/** LLM 原生联网后端（Reasonix 方式）：一次性独立 LLM 调用复用已配模型账号，零新 key。
 *  available() 恒真（SW-15——model 未配 = 当前模型承载，零配置即有搜索）。
 *  自动档（2026-09-24 拍板，Reasonix「自动：优先会话账号，否则选已开启搜索的可用账号」同思想）：
 *  当前模型探测失败 → 遍历其余已配置提供商（每商取目录首模型各探一次）→ 首个出原生搜索结果的即
 *  粘性直达；全灭 → 粘性降级（链落 tavily/brave）。钉住模型 = 单发不遍历（SW-15 钉死语义）。 */
export function llmBackend(deps: LlmBackendDeps): WebSearchBackend {
  const timeoutMs = deps.timeoutMs ?? SEARCH_TIMEOUT_MS;

  /** 单次探测调用：出原生搜索结果 → hits；否则抛 LlmSearchError。 */
  const attempt = async (query: string, model: string | undefined, signal: AbortSignal): Promise<SearchResult[]> => {
    const queryBytes = Buffer.byteLength(query, "utf8");
    if (queryBytes < 1 || queryBytes > MAX_QUERY_BYTES) {
      throw new LlmSearchError("endpoint-error", `query 长度 ${queryBytes} 字节超出 1..${MAX_QUERY_BYTES} 界（SW-14）`);
    }
    const timeoutSig = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeoutSig]);
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
        ...(model !== undefined ? { model } : {}),
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
      // Reasonix :147 话术照抄——端点没返回原生搜索结果（spike 实钉：zhipu/kimi/deepseek 端点全落此门）
      throw new LlmSearchError("no-native-results", "provider returned no native search results; verify that this endpoint and model support web search");
    }
    const out: SearchResult[] = [];
    // 摘要 = 无 URL 的裸文本条目（Reasonix Result.Summary 对应物），拼装层渲染为自然段；sources 随后为带链接条目
    if (summary.trim() !== "") out.push({ title: "", url: "", snippet: summary.trim() });
    out.push(...sources.map((s) => ({ ...s, snippet: s.snippet.slice(0, MAX_SOURCE_SNIPPET_CHARS) })));
    return out;
  };

  return {
    kind: "llm",
    available: () => true,
    search: async (query, signal): Promise<SearchResult[]> => {
      const cfg = deps.cfg();
      const pinned = cfg.model !== undefined && cfg.model.trim() !== "" ? cfg.model.trim() : undefined;
      // 钉住 = 单发不遍历（SW-15 钉死语义——用户显式选的模型失败即带内报错，不降级不遍历）
      if (pinned !== undefined) return attempt(query, pinned, signal);
      // 粘性直达：遍历已找到过真能搜的模型 → 不重复支付探测
      if (deps.sticky.workingModel !== undefined) {
        const wm = deps.sticky.workingModel;
        try {
          return await attempt(query, wm, signal);
        } catch {
          deps.sticky.workingModel = undefined; // 粘性模型失能（端点变了）→ 清粘性重走遍历
        }
      }
      // 自动档：当前模型先（Reasonix「优先会话账号」）
      try {
        return await attempt(query, undefined, signal);
      } catch (firstErr) {
        if (signal.aborted) throw firstErr; // 用户中止不遍历
        // 遍历其余已配置提供商（「否则选已开启搜索的可用账号」）：目录不可枚举 → 无候选直降
        const catalog = (await deps.llm.listModels?.().catch(() => undefined)) ?? [];
        const byProvider = new Map<string, string>(); // 每商取目录首模型各探一次（endpoint 级能力是探测对象）
        for (const q of catalog) {
          const prov = q.split("/")[0]!;
          if (!byProvider.has(prov)) byProvider.set(prov, q);
        }
        for (const qualified of byProvider.values()) {
          if (deps.sticky.probed.includes(qualified)) continue; // 本会话已探过不重复支付
          deps.sticky.probed.push(qualified);
          try {
            const hits = await attempt(query, qualified, signal);
            deps.sticky.workingModel = qualified; // 找到真能搜的 → 粘性直达
            // 透明化：实际承载模型并入结果头（模型与用户都该知道这次是谁搜的）
            return [{ title: "", url: "", snippet: `（LLM 搜索实际由 ${qualified} 承载——当前模型不支持联网）` }, ...hits];
          } catch (err) {
            if (signal.aborted) throw err;
            continue; // 该商不行 → 下一个
          }
        }
        // 全灭 → 粘性降级（链落 tavily/brave——search.ts 链层消费）
        deps.sticky.llmDowngraded = true;
        throw firstErr;
      }
    },
  };
}
