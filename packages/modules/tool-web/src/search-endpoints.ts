/** 已知可原生搜索端点表（2026-09-24 用户拍板对齐 Reasonix）。
 *
 *  背景：openai 档（chat completions）协议只有 zhipu 形 web_search 声明位，deepseek/kimi/glm 的
 *  chat 面一律拒收或不出原生结果（T1b spike 三连 422/400/空）。但同一家几乎都另开一个
 *  Anthropic 兼容面（/anthropic 或 /coding 根），该面收 web_search_20250305 且服务端真执行——
 *  Reasonix 的 SupportsServerWebSearch 只认 anthropic/responses 档（config/web_search.go:11-21，
 *  注释原话 "chat-completions tool contract only supports functions"），官方 chat 账号的搜索请求
 *  整体改写 anthropic 档发同 key 的 /anthropic 面（independent_web_search.go:59-65）。
 *
 *  用法：tool-web 在 activate 把本表挂为服务 `tool-web.search-faces`（{ match }）；provider-custom
 *  在 webSearch 请求时经 ctx.services.getOptional 惰性消费，命中即把该次搜索请求改道 anthropicRoot
 *  （stream-anthropic 拼 {root}/v1/messages，双头鉴权同 key）。表只服务路由；可搜与否最终仍由
 *  运行期 :147 门（真出原生结果才算数）判定——未验证条目失败即降级 tavily/brave，零额外风险。
 *
 *  落位（2026-09-24 服务倒挂拍板）：搜索端点知识归搜索模块 tool-web 所有，provider-custom 只做
 *  路由行为、经服务运行时消费——**模块互不 import（check:boundaries），主体代码零改动**。
 *  服务键与返回形状是双边契约（非 core 路由的公共短名，故不进 contracts；不随主体版本演进）。
 *
 *  2026-09-24 真机 spike（流式、用户在配 key）：deepseek/kimi/glm 三家 anthropic 面均真出原生
 *  搜索结果；模型名直接透传（deepseek-chat→服务端 v4-flash、k3-256k、glm-5.3 均可搜）。 */
export interface NativeSearchFace {
  /** openai 档 baseUrl 匹配前缀（origin+path；归一化后整段或「前缀+/' 下一段」命中） */
  chatBase: string;
  /** 搜索改道面 = Anthropic 协议根（stream-anthropic 拼 {root}/v1/messages；同 key） */
  anthropicRoot: string;
  /** Orosus 真机流式验证过真出原生搜索结果；false = 文档/Reasonix 在案但未验（:147 门兜底） */
  verified: boolean;
  note: string;
}

export const NATIVE_SEARCH_FACES: NativeSearchFace[] = [
  {
    chatBase: "https://api.deepseek.com",
    anthropicRoot: "https://api.deepseek.com/anthropic",
    verified: true,
    note: "官方 deepseek（含 /v1 与裸 origin chat 面）→ /anthropic；spike 实录 web_search_tool_result×10、模型 deepseek-chat 服务端映射 v4-flash",
  },
  {
    chatBase: "https://api.kimi.com/coding",
    anthropicRoot: "https://api.kimi.com/coding",
    verified: true,
    note: "kimi coding plan——chat（/coding/v1/chat/completions）与 anthropic（/coding/v1/messages）同根；spike 15 结果/轮，模型 kimi-for-coding 与 k3-256k 均透传可搜",
  },
  {
    chatBase: "https://open.bigmodel.cn/api/coding",
    anthropicRoot: "https://open.bigmodel.cn/api/anthropic",
    verified: true,
    note: "GLM coding plan CN——anthropic 面结果块为 tool_result 变体（content = JSON 字符串体、link 字段），stream-anthropic 变体提取覆盖；spike 真结果（中国气象局等）",
  },
  {
    chatBase: "https://api.z.ai/api/coding",
    anthropicRoot: "https://api.z.ai/api/anthropic",
    verified: false,
    note: "Z.AI coding plan global——Reasonix 预设对位（zai-coding-plan-global-anthropic），未实机验证",
  },
  {
    chatBase: "https://opencode.ai/zen",
    anthropicRoot: "https://opencode.ai/zen/go",
    verified: false,
    note: "OpenCode Zen——Reasonix 后台验证仅 deepseek-v4-flash 模型真搜（模型域白名单 web_search.go:51-73），未实机验证",
  },
  {
    chatBase: "https://coding.dashscope.aliyuncs.com",
    anthropicRoot: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    verified: false,
    note: "Qwen coding plan CN——Reasonix 预设对位（qwen-coding-plan-cn-anthropic），未实机验证",
  },
  {
    chatBase: "https://coding-intl.dashscope.aliyuncs.com",
    anthropicRoot: "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic",
    verified: false,
    note: "Qwen coding plan international——Reasonix 预设对位，未实机验证",
  },
  {
    chatBase: "https://api.longcat.chat/openai",
    anthropicRoot: "https://api.longcat.chat/anthropic",
    verified: false,
    note: "LongCat platform——Reasonix 预设对位（longcat-anthropic，Bearer 鉴权），未实机验证",
  },
  {
    chatBase: "https://api.minimax.io",
    anthropicRoot: "https://api.minimax.io/anthropic",
    verified: false,
    note: "MiniMax global——Reasonix 预设对位（minimax-global-anthropic，Bearer 鉴权），未实机验证",
  },
  {
    chatBase: "https://api.xiaomimimo.com",
    anthropicRoot: "https://api.xiaomimimo.com/anthropic",
    verified: false,
    note: "MiMo API——Reasonix 预设对位（mimo-anthropic），未实机验证；token-plan 区域子域未配对",
  },
];

/** openai 档 baseUrl → 已知可搜改道面；无匹配 = undefined（维持 chat 面 zhipu 形探测原行为）。
 *  归一：URL 解析取 origin+path（防 「api.deepseek.com.evil.io」 域名前缀伪装）、小写、剥尾斜杠。 */
export function matchNativeSearchFace(baseUrl: string): NativeSearchFace | undefined {
  let normalized: string;
  try {
    const u = new URL(baseUrl.trim());
    normalized = (u.origin + u.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return undefined;
  }
  return NATIVE_SEARCH_FACES.find((f) => normalized === f.chatBase || normalized.startsWith(`${f.chatBase}/`));
}
