import { classifyContextLimit, parseModelsResponse, type Chunk, type ProviderRequest, type StreamFn } from "@orosus/contracts/provider";
import { OROSUS_USER_AGENT } from "@orosus/contracts/version";
import { mapSseChunk, toOpenAIMessages, toOpenAITools, type OaiStreamState, type ToolImagesMode } from "./translate-openai.ts";
import { DEFAULT_IDLE_TIMEOUT_MS } from "./stream-anthropic.ts";
import { netErrorDetail } from "./neterr.ts";
import { gateImagesByVision } from "./visiongate.ts";
import { prepareImagesForWire } from "./mediapipe.ts";

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
export function createStream(opts: { apiKey?: string | undefined; baseUrl: string; fetchImpl?: typeof fetch; idleTimeoutMs?: number; /** m5-media F3/D1：工具结果带图三态（缺省 bridge——见 ToolImagesMode 注） */ toolImages?: ToolImagesMode; /** m5-media F4：目录缓存路径（缺省 ~/.orosus/cache/models-dev.json；测试注入密封） */ catalogFile?: string }): StreamFn {
  const doFetch = opts.fetchImpl ?? fetch;
  return async function* stream(request: ProviderRequest): AsyncIterable<Chunk> {
    const fail = (errorMessage: string, errorCode?: string): Chunk =>
    ({ type: "finish", kind: "error", errorMessage, ...(errorCode !== undefined ? { errorCode } : {}) });
    // MP-07 最小可靠性（与 stream-anthropic 同款）：请求级空闲超时——连接/响应头/块间任一阶段无进展字节即
    // abort 带内终局（此前挂起网关下 reader.read() 无限等待）。重试/退避刻意不在本层做：流已产出正文后重发
    // 会重复投递。传输层失败（fetch/读流抛错）打 errorCode "network"（2026-09-30 拍板 a）——loop 据码零产出
    // 重发；空闲超时不打码（理由见 stream-anthropic.ts 同段）。
    // 缺省 300s（2026-09-28 学 kimi 拍板，依据与不加总超时的理由见 stream-anthropic.ts DEFAULT_IDLE_TIMEOUT_MS 注释）。
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
      try {
        armIdle(); // 头阶段计入空闲——连接/响应头挂起同样超时（MP-07）
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
            messages: toOpenAIMessages(request.system, await prepareImagesForWire(gateImagesByVision(request.model, request.messages, opts.catalogFile)), opts.toolImages ?? "bridge"), // m5-media F4+F5：门控（非图模型剥图占位）→ 发送副本（超尺寸降采样，worker）
            ...(tools.length > 0 ? { tools } : {}),
            ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
            // /effort（kimi resolveThinkingEffort 同款）：具体档位原样透传 reasoning_effort——不在端点清单
            // 也照发（lenient，端点 400 自证）；'on'/'off' 语义档 = silent（不发字段：on = 端点默认开思考，
            // off = 无 offEffort 声明时的关思考形态；有声明时 core 已换发 "none" 等具体值）
            ...(request.reasoningEffort !== undefined && request.reasoningEffort !== "on" && request.reasoningEffort !== "off" ? { reasoning_effort: request.reasoningEffort } : {}),
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: wireSignal,
        });
      } catch (err) {
        yield request.signal.aborted
          ? { type: "finish", kind: "aborted" }
          : idleFired
            ? fail(`空闲超时：${Math.round(idleMs / 1000)}s 无进展——已中止连接`)
            : fail(`网络错误：${netErrorDetail(err)}`, "network");
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
      // 单块帧解析（抽出成函数供 done 后残块冲刷〔MP-06〕复用；行分隔容忍 CRLF）
      const handleBlock = function* (block: string): Generator<Chunk> {
        // MP-08：SSE 规范——同一事件内多条 data: 行以 \n 拼接后才是完整载荷（anthropic 族 parseSseBlock
        // 一直是对的口径，translate-anthropic.ts:14-19）。此前对块内每行独立 JSON.parse：端点把一个 JSON
        // 拆成多行 data（规范合法，载荷内空白处拆分）时每行 parse 都失败走坏帧跳过——帧静默丢、零正文。
        const dataLines: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          dataLines.push(trimmed.slice(5).trim());
        }
        if (dataLines.length === 0) return; // 无 data 行（注释/心跳）忽略
        const data = dataLines.join("\n");
        if (data === "" || data === "[DONE]") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return; // 坏帧跳过（MP-04 口径——不炸流）
        }
        yield* handle(parsed as Record<string, unknown>);
      };
      try {
        for (;;) {
          armIdle(); // 块间空闲计时——每块到达即复位（MP-07）
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/); // MP-06：SSE 规范行尾三态（CRLF 端点合法）——此前只认 \n\n，纯 CRLF 流整流零事件
          buffer = blocks.pop() ?? "";
          for (const block of blocks) yield* handleBlock(block);
        }
        buffer += decoder.decode(); // 多字节残尾冲刷（decode() 无 stream:true 即终结态）
        // MP-06：done 后残 buffer 冲刷——「最后一帧不带结尾空行」的端点此前静默丢尾帧；残块 finish 计入 sawFinish（不重复兜底）
        if (!request.signal.aborted && buffer.trim() !== "") yield* handleBlock(buffer);
        if (!sawFinish) {
          yield request.signal.aborted ? { type: "finish", kind: "aborted" } : { type: "finish", kind: "stop" }; // [DONE] 前无 finish_reason → stop 兜底
        }
      } catch (err) {
        yield request.signal.aborted
          ? { type: "finish", kind: "aborted" }
          : idleFired
            ? fail(`空闲超时：${Math.round(idleMs / 1000)}s 无进展——已中止连接`)
            : fail(`流读取错误：${netErrorDetail(err)}`, "network");
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
    const res = await doFetch(`${opts.baseUrl}/models`, {
      headers: { "user-agent": OROSUS_USER_AGENT, ...(opts.apiKey !== undefined ? { "x-api-key": opts.apiKey, authorization: `Bearer ${opts.apiKey}` } : {}) },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseModelsResponse(await res.json());
  };
}
