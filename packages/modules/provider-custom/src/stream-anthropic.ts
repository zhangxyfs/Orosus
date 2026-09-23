import { classifyContextLimit, parseModelsResponse, type Chunk, type ProviderRequest, type StreamFn } from "@orosus/contracts/provider";
import { OROSUS_USER_AGENT } from "@orosus/contracts/version";
import { mapEvent, parseSseBlock, toAnthropicMessages, type SseState } from "./translate-anthropic.ts";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 8192;

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
          tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
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
          yield* mapEvent(state, parsed.event, JSON.parse(parsed.data));
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
