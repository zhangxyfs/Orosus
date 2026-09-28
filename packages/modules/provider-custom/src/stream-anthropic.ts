import { classifyContextLimit, parseModelsResponse, type Chunk, type ProviderRequest, type StreamFn } from "@orosus/contracts/provider";
import { OROSUS_USER_AGENT } from "@orosus/contracts/version";
import { mapEvent, parseSseBlock, thinkingParamFor, toAnthropicMessages, type SseState } from "./translate-anthropic.ts";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 8192;
/** MP-02：官方约束 max_tokens 必须大于 thinking.budget_tokens——思考启用时 max_tokens 至少抬到预算 + 此输出余量 */
const THINKING_OUTPUT_MARGIN = 8192;

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

/** 流空闲超时缺省（毫秒）——两协议面同源共用，stream-openai 引用同值。
 *  2026-09-28 学 kimi 拍板 60s→300s：kimi 不自设超时、实际生效保护 = Node fetch（undici）底层
 *  bodyTimeout/headersTimeout 默认 300s（每字节复位，与本实现同构）；codex stream_idle_timeout /
 *  opencode chunkTimeout 显式同值。旧值 60s 误杀「输出完短文本后进入超长生成（不推增量字节）」的流
 *  （GLM 实锤一例：91k 上下文写 ARCHITECTURE.md，正文后 60s 零字节被杀）。
 *  kimi 另有 SDK 默认 600s 总超时——刻意不加：超 10 分钟连续长输出（整份文档生成）会被它误杀。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** fetch glue（D31）：Anthropic Messages 协议，双头鉴权，错误全带内。vendored 自 provider-anthropic。 */
export function createStream(opts: { apiKey?: string | undefined; baseUrl: string; fetchImpl?: typeof fetch; idleTimeoutMs?: number }): StreamFn {
  const doFetch = opts.fetchImpl ?? fetch;
  return async function* stream(request: ProviderRequest): AsyncIterable<Chunk> {
    const fail = (errorMessage: string, errorCode?: string): Chunk =>
    ({ type: "finish", kind: "error", errorMessage, ...(errorCode !== undefined ? { errorCode } : {}) });
    // MP-07 最小可靠性：请求级空闲超时——连接/响应头/块间任一阶段 idleTimeoutMs 内无进展字节即 abort 带
    // 内终局（此前端点保持连接但零字节时 reader.read() 无限等待，turn 挂死到用户手动中断）。重试/退避刻意
    // 不在本层做：流已产出正文后重发会重复投递（qwen-code 以专门 stream-transport-retry 模块处理该边界），
    // 429/5xx 的重试归调用方策略层（loop 现仅 context_limit 单次重试）——取舍注明而非静默。idleTimeoutMs 供测试注入。
    const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const idle = new AbortController();
    let idleFired = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleFired = true; idle.abort(); }, idleMs); idleTimer.unref?.(); // unref:不阻塞进程退出(超时保护照常触发)——c51e5f5 后 300s 无 unref 把测试收尾拖满 5 分钟
    };
    const wireSignal = AbortSignal.any([request.signal, idle.signal]);
    try {
      let res: Response;
      // /effort：档位 → thinking 开关/budget 映射（translate-anthropic.ts thinkingParamFor——MP-02 后 enabled 恒钉预算）。
      // MP-02：max_tokens 必须 > budget_tokens（缺省 8192 < 32000 恒 400）——思考启用时抬到预算 + 输出余量，用户值更大则保留
      const thinking = request.reasoningEffort !== undefined ? thinkingParamFor(request.reasoningEffort) : undefined;
      const maxTokens = thinking !== undefined && thinking.type === "enabled"
        ? Math.max(request.maxTokens ?? MAX_TOKENS, thinking.budget_tokens + THINKING_OUTPUT_MARGIN)
        : request.maxTokens ?? MAX_TOKENS;
      try {
        armIdle(); // 头阶段计入空闲——连接/响应头挂起同样超时（MP-07）
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
            max_tokens: maxTokens,
            system: request.system,
            messages: toAnthropicMessages(request.messages),
            tools: [
              ...request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
              // M4-3 T1b：webSearch=true → 追加 Anthropic 服务端搜索工具（文档形态 web_search_20250305；
              // 本仓无 anthropic 协议族端点可 spike——形态按官方文档钉，端点不支持时协议错误原样带内）
              ...(request.webSearch === true ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] : []),
            ],
            ...(thinking !== undefined ? { thinking } : {}),
            stream: true,
          }),
          signal: wireSignal,
        });
      } catch (err) {
        yield request.signal.aborted
          ? { type: "finish", kind: "aborted" }
          : idleFired
            ? fail(`空闲超时：${Math.round(idleMs / 1000)}s 无进展——已中止连接`)
            : fail(`网络错误：${err instanceof Error ? err.message : String(err)}`);
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
      // 单块解析与映射（MP-04：坏帧局部 try 跳过——对齐 openai 族口径；抽出成函数供 done 后残块冲刷〔MP-06〕复用）
      const chunksOf = function* (block: string): Generator<Chunk> {
        const parsed = parseSseBlock(block);
        if (!parsed) return;
        if (parsed.data.trim() === "[DONE]") return; // openai 式哨兵帧（兼容网关混发）——anthropic 协议无此事件，跳过
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(parsed.data) as Record<string, unknown>;
        } catch {
          return; // MP-04：坏帧（截断/网关插播文本）跳过——单帧不炸整流（此前异常逃逸外层 catch 被误标「流读取错误」终局，端点每轮在同一点失败）
        }
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
      };
      try {
        for (;;) {
          armIdle(); // 块间空闲计时——每块到达即复位（MP-07）
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/); // MP-06：SSE 规范行尾三态（CRLF 端点合法）——此前只认 \n\n，纯 CRLF 流整流零事件
          buffer = blocks.pop() ?? "";
          for (const block of blocks) yield* chunksOf(block);
        }
        buffer += decoder.decode(); // 多字节残尾冲刷（decode() 无 stream:true 即终结态）
        // MP-06：done 后残 buffer 冲刷——「最后一帧不带结尾空行」的端点此前静默丢尾帧（丢 message_stop 即静默按 stop 收场）
        if (!request.signal.aborted && buffer.trim() !== "") yield* chunksOf(buffer);
        if (request.signal.aborted) yield { type: "finish", kind: "aborted" };
      } catch (err) {
        yield request.signal.aborted
          ? { type: "finish", kind: "aborted" }
          : idleFired
            ? fail(`空闲超时：${Math.round(idleMs / 1000)}s 无进展——已中止连接`)
            : fail(`流读取错误：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer); // 计时器必清——挂起 timer 会拖住事件循环（提前 break/异常路径同样覆盖）
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
