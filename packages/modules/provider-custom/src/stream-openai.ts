import { classifyContextLimit, parseModelsResponse, type Chunk, type ProviderRequest, type StreamFn } from "@orosus/contracts/provider";
import { OROSUS_USER_AGENT } from "@orosus/contracts/version";
import { mapSseChunk, toOpenAIMessages, toOpenAITools, type OaiStreamState } from "./translate-openai.ts";

/** 响应里的服务端搜索标记抽取（M4-3 T1b——2026-09-24 spike 无真样本，按各家已公开形态宽进：
 *  ① zhipu 文档字段 choices[].message/delta.web_search 数组（{title,url,content?} 项）；
 *  ② OpenAI Responses 风格事件 {type:"web_search_call",status:"completed"}（Reasonix :192 完成校验同形）。
 *  取到 {title,url} 对即归一 hits；完成事件无条目时给空 hits 数组（「搜过」信号本身就是信息）。 */
function extractServerSearch(obj: Record<string, unknown>): Chunk | undefined {
  const toHits = (arr: unknown): { title: string; url: string }[] =>
    (Array.isArray(arr) ? arr : []).flatMap((it) => {
      const o = it as { title?: unknown; url?: unknown; link?: unknown } | null;
      const url = typeof o?.url === "string" ? o.url : typeof o?.link === "string" ? o.link : undefined;
      return url !== undefined ? [{ title: typeof o?.title === "string" ? o.title : url, url }] : [];
    });
  if (obj["type"] === "web_search_call" && obj["status"] === "completed") return { type: "server-search", hits: [] };
  const choices = obj["choices"];
  if (!Array.isArray(choices)) return undefined;
  for (const ch of choices) {
    const c = ch as { message?: Record<string, unknown>; delta?: Record<string, unknown> } | null;
    for (const bag of [c?.message, c?.delta]) {
      if (bag === undefined || bag === null) continue;
      const hits = toHits(bag["web_search"] ?? bag["search_results"]);
      if (hits.length > 0) return { type: "server-search", hits };
    }
  }
  return undefined;
}

/** fetch glue（D31）：双头鉴权（无 key 零头）、SSE data: 行解析、[DONE] 兜底 stop、错误全带内。 */
export function createStream(opts: { apiKey?: string | undefined; baseUrl: string; fetchImpl?: typeof fetch }): StreamFn {
  const doFetch = opts.fetchImpl ?? fetch;
  return async function* stream(request: ProviderRequest): AsyncIterable<Chunk> {
    const fail = (errorMessage: string, errorCode?: string): Chunk =>
    ({ type: "finish", kind: "error", errorMessage, ...(errorCode !== undefined ? { errorCode } : {}) });
    let res: Response;
    try {
      // M4-3 T1b：webSearch=true → 线缆 tools 追加服务端搜索声明（zhipu 接受形态——2026-09-24 spike 实钉：
      // 裸 {type:"web_search"} 被 400「tools[0].web_search 不能为空」拒；带 web_search 参数对象放行）。
      // 与客户端 tools 正交合发；端点不支持时协议错误原样带内（kimi 端点 400 实录在案）。
      const clientTools = request.tools.length > 0 ? toOpenAITools(request.tools) : [];
      const tools = request.webSearch === true
        ? [...clientTools, { type: "web_search", web_search: { enable: true } }]
        : clientTools;
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
          ...(tools.length > 0 ? { tools } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          // /effort（kimi resolveThinkingEffort 同款）：具体档位原样透传 reasoning_effort——不在端点清单
          // 也照发（lenient，端点 400 自证）；'on'/'off' 语义档 = silent（不发字段：on = 端点默认开思考，
          // off = 无 offEffort 声明时的关思考形态；有声明时 core 已换发 "none" 等具体值）
          ...(request.reasoningEffort !== undefined && request.reasoningEffort !== "on" && request.reasoningEffort !== "off" ? { reasoning_effort: request.reasoningEffort } : {}),
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
      const serverSearch = extractServerSearch(obj); // 服务端搜索块先于常规映射上报（webSearch 请求才可能出现，无则 undefined）
      if (serverSearch !== undefined) yield serverSearch;
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
