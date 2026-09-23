import { classifyContextLimit, parseModelsResponse, type Chunk, type ProviderRequest, type StreamFn } from "@orosus/contracts/provider";
import { OROSUS_USER_AGENT } from "@orosus/contracts/version";
import { mapSseChunk, toOpenAIMessages, toOpenAITools, type OaiStreamState } from "./translate-openai.ts";

/** fetch glue（D31）：双头鉴权（无 key 零头）、SSE data: 行解析、[DONE] 兜底 stop、错误全带内。 */
export function createStream(opts: { apiKey?: string | undefined; baseUrl: string; fetchImpl?: typeof fetch }): StreamFn {
  const doFetch = opts.fetchImpl ?? fetch;
  return async function* stream(request: ProviderRequest): AsyncIterable<Chunk> {
    const fail = (errorMessage: string, errorCode?: string): Chunk =>
    ({ type: "finish", kind: "error", errorMessage, ...(errorCode !== undefined ? { errorCode } : {}) });
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": OROSUS_USER_AGENT,
          // D31 双头：官方 OpenAI 认 Bearer，兼容端点认其一；无 key（本地/内网端点）零鉴权头
          ...(opts.apiKey !== undefined ? { "x-api-key": opts.apiKey, authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: toOpenAIMessages(request.system, request.messages),
          ...(request.tools.length > 0 ? { tools: toOpenAITools(request.tools) } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          stream: true,
          stream_options: { include_usage: true },
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
    const state: OaiStreamState = { calls: new Map() };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawFinish = false;
    const handle = function* (obj: Record<string, unknown>): Generator<Chunk> {
      for (const c of mapSseChunk(state, obj)) {
        if (c.type === "finish") sawFinish = true;
        yield c;
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          for (const line of block.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "" || data === "[DONE]") continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue; // 坏行跳过
            }
            yield* handle(parsed as Record<string, unknown>);
          }
        }
      }
      if (!sawFinish) {
        yield request.signal.aborted ? { type: "finish", kind: "aborted" } : { type: "finish", kind: "stop" }; // [DONE] 前无 finish_reason → stop 兜底
      }
    } catch (err) {
      yield request.signal.aborted ? { type: "finish", kind: "aborted" } : fail(`流读取错误：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}


/** 端点真实模型清单（模型发现 T2/D32 修订）：GET {baseUrl}/models，双头鉴权、5s 超时、失败 reject——消费方（/model 菜单、向导）catch 回退。 */
export function createListModels(opts: { apiKey?: string | undefined; baseUrl: string; fetchImpl?: typeof fetch }): () => Promise<string[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  return async () => {
    const res = await doFetch(`${opts.baseUrl}/models`, {
      headers: { "user-agent": OROSUS_USER_AGENT, ...(opts.apiKey !== undefined ? { "x-api-key": opts.apiKey, authorization: `Bearer ${opts.apiKey}` } : {}) },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseModelsResponse(await res.json());
  };
}
