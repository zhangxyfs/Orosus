import { classifyContextLimit, parseModelsResponse, type Chunk, type ProviderRequest, type StreamFn } from "@orosus/contracts/provider";
import { OROSUS_USER_AGENT } from "@orosus/contracts/version";
import { mapEvent, parseSseBlock, toAnthropicMessages, type SseState } from "./translate-anthropic.ts";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 8192;

/** GLM anthropic 面 tool_result 变体 → 搜索命中（2026-09-24 spike）：content 为 JSON 字符串体
 *  [[{title,link,content,refer}]]；防御式递归走查，认 (title+link) 或 (title+url) 键对，其余忽略。 */
function parseSearchHitsFromToolResult(content: unknown): { title: string; url: string }[] {
  if (typeof content !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const out: { title: string; url: string }[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const url = typeof o["link"] === "string" ? o["link"] : typeof o["url"] === "string" ? o["url"] : undefined;
    const title = typeof o["title"] === "string" ? o["title"] : undefined;
    if (url !== undefined && title !== undefined) {
      out.push({ title, url });
      return;
    }
    for (const item of Object.values(o)) walk(item);
  };
  walk(parsed);
  return out;
}

/** fetch glue（D31）：Anthropic Messages 协议，双头鉴权，错误全带内。vendored 自 provider-anthropic。 */
export function createStream(opts: { apiKey?: string | undefined; baseUrl: string; fetchImpl?: typeof fetch }): StreamFn {
  const doFetch = opts.fetchImpl ?? fetch;
  return async function* stream(request: ProviderRequest): AsyncIterable<Chunk> {
    const fail = (errorMessage: string, errorCode?: string): Chunk =>
    ({ type: "finish", kind: "error", errorMessage, ...(errorCode !== undefined ? { errorCode } : {}) });
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": OROSUS_USER_AGENT,
          // D31 双头：官方 Anthropic 只认 x-api-key（多余头被忽略），Bearer-only 兼容端点（Kimi）与任一可接受端点（GLM）成立
          ...(opts.apiKey !== undefined ? { "x-api-key": opts.apiKey, authorization: `Bearer ${opts.apiKey}` } : {}),
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxTokens ?? MAX_TOKENS,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          tools: [
            ...request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
            // M4-3 T1b：webSearch=true → 追加 Anthropic 服务端搜索工具（文档形态 web_search_20250305；
            // 本仓无 anthropic 协议族端点可 spike——形态按官方文档钉，端点不支持时协议错误原样带内）
            ...(request.webSearch === true ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] : []),
          ],
          stream: true,
        }),
        signal: request.signal,
      });
    } catch (err) {
      yield request.signal.aborted ? { type: "finish", kind: "aborted" } : fail(`网络错误：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      // 分类以响应全文判定（D43）——slice(0,500) 只用于 errorMessage 文案；网络/流读取错误不打码
      yield fail(`HTTP ${res.status}：${body.slice(0, 500)}`, classifyContextLimit(res.status, body) ? "context_limit" : undefined);
      return;
    }
    const state: SseState = { inputTokens: 0, currentCall: null, pendingStop: null };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed) continue;
          const data = JSON.parse(parsed.data) as Record<string, unknown>;
          // M4-3 T1b：服务端搜索块归一（web_search_tool_result 的 content = [{title,url,…}]——文档形态）
          if (parsed.event === "content_block_start") {
            const cb = data["content_block"] as { type?: unknown; content?: unknown } | undefined;
            if (cb?.type === "web_search_tool_result") {
              const hits = (Array.isArray(cb.content) ? cb.content : []).flatMap((it) => {
                const o = it as { title?: unknown; url?: unknown } | null;
                return typeof o?.url === "string" ? [{ title: typeof o.title === "string" ? o.title : o.url, url: o.url }] : [];
              });
              yield { type: "server-search", hits };
            } else if (request.webSearch === true && cb?.type === "tool_result") {
              // GLM anthropic 面变体（2026-09-24 spike 实钉）：结果块 type=tool_result、content = JSON
              // 字符串体 [[{title,link,content,refer}]]（非标准 web_search_tool_result 数组）。仅在
              // webSearch 请求（搜索辅助调用，客户端 tools 恒空）解析——主回路的 tool_result 是客户端
              // 工具结果语义，不得误收。解析失败静默零 hits（:147 门按无原生结果处理，不炸流）。
              const hits = parseSearchHitsFromToolResult(cb.content);
              if (hits.length > 0) yield { type: "server-search", hits };
            }
          }
          yield* mapEvent(state, parsed.event, data);
        }
      }
      if (request.signal.aborted) yield { type: "finish", kind: "aborted" };
    } catch (err) {
      yield request.signal.aborted ? { type: "finish", kind: "aborted" } : fail(`流读取错误：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}


/** 端点真实模型清单（模型发现 T2/D32 修订）：GET {baseUrl}/models，双头鉴权、5s 超时、失败 reject——消费方（/model 菜单、向导）catch 回退。 */
export function createListModels(opts: { apiKey?: string | undefined; baseUrl: string; fetchImpl?: typeof fetch }): () => Promise<string[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  return async () => {
    const res = await doFetch(`${opts.baseUrl}/v1/models`, {
      headers: { "user-agent": OROSUS_USER_AGENT, ...(opts.apiKey !== undefined ? { "x-api-key": opts.apiKey, authorization: `Bearer ${opts.apiKey}` } : {}) },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseModelsResponse(await res.json());
  };
}
