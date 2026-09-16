import type { Chunk, StreamFn } from "@orosus/contracts/provider";
import { mapEvent, parseSseBlock, toAnthropicMessages, type SseState } from "./translate.ts";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 8192;

export function createStream(opts: { apiKey: string; baseUrl: string }): StreamFn {
  return async function* stream(request): AsyncIterable<Chunk> {
    const fail = (errorMessage: string): Chunk => ({ type: "finish", kind: "error", errorMessage });
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: MAX_TOKENS,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
          stream: true,
        }),
        signal: request.signal,
      });
    } catch (err) {
      yield request.signal.aborted
        ? { type: "finish", kind: "aborted" }
        : fail(`网络错误：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      yield fail(`HTTP ${res.status}：${body.slice(0, 500)}`);
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
        // 按 "\n\n" 切块：Anthropic SSE 用 LF 分隔；CRLF 服务端（"\r\n\r\n"）留联调期验证（M1 已知风险）
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
      yield request.signal.aborted
        ? { type: "finish", kind: "aborted" }
        : fail(`流读取错误：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
