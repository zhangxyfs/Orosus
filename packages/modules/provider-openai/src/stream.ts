import type { Chunk, ProviderRequest, StreamFn } from "@orosus/contracts/provider";
import { mapSseChunk, toOpenAIMessages, toOpenAITools, type OaiStreamState } from "./translate.ts";

/** fetch glue（D31）：双头鉴权（无 key 零头）、SSE data: 行解析、[DONE] 兜底 stop、错误全带内。 */
export function createStream(opts: { apiKey?: string | undefined; baseUrl: string; fetchImpl?: typeof fetch }): StreamFn {
  const doFetch = opts.fetchImpl ?? fetch;
  return async function* stream(request: ProviderRequest): AsyncIterable<Chunk> {
    const fail = (errorMessage: string): Chunk => ({ type: "finish", kind: "error", errorMessage });
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // D31 双头：官方 OpenAI 认 Bearer，兼容端点认其一；无 key（本地/内网端点）零鉴权头
          ...(opts.apiKey !== undefined ? { "x-api-key": opts.apiKey, authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: toOpenAIMessages(request.system, request.messages),
          ...(request.tools.length > 0 ? { tools: toOpenAITools(request.tools) } : {}),
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
      yield fail(`HTTP ${res.status}：${body.slice(0, 500)}`);
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
