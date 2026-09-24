/** 内置目录快照（D34）：拉取失败/离线的兜底——models.dev/api.json 的裁剪版（provider 级字段 + 少量 text 模型）。
 *  语义：仅供离线导入兜底，不做时效承诺；升级随模块 minor 版本刷新。 */
export const BUILTIN_SNAPSHOT = {
  openai: { id: "openai", name: "OpenAI", type: "openai", api: "https://api.openai.com/v1", env: ["OPENAI_API_KEY"], models: { "gpt-4.1": { id: "gpt-4.1" }, "gpt-4.1-mini": { id: "gpt-4.1-mini" } } },
  anthropic: { id: "anthropic", name: "Anthropic", type: "anthropic", api: "https://api.anthropic.com", env: ["ANTHROPIC_API_KEY"], models: { "claude-sonnet-4-5": { id: "claude-sonnet-4-5" } } },
  deepseek: { id: "deepseek", name: "DeepSeek", type: "openai", api: "https://api.deepseek.com/v1", env: ["DEEPSEEK_API_KEY"], models: { "deepseek-chat": { id: "deepseek-chat" }, "deepseek-reasoner": { id: "deepseek-reasoner" } } },
  moonshot: { id: "moonshot", name: "Moonshot AI", type: "openai", api: "https://api.moonshot.cn/v1", env: ["MOONSHOT_API_KEY"], models: { "kimi-k2.7-code": { id: "kimi-k2.7-code" } } },
  "z-ai": { id: "z-ai", name: "Z.ai", type: "openai", api: "https://api.z.ai/v1", env: ["Z_AI_API_KEY"], models: { "glm-4.6": { id: "glm-4.6" } } },
  openrouter: { id: "openrouter", name: "OpenRouter", type: "openai", api: "https://openrouter.ai/api/v1", env: ["OPENROUTER_API_KEY"], models: {} },
  ollama: { id: "ollama", name: "Ollama", type: "openai", api: "http://localhost:11434/v1", env: [], models: {} },
} as const;

/** 引导第 2 页的 provider 级裁剪视图（M4-3 T1d/SW-21）：仅 id / 名称 / envKey / baseUrl / 本地标记——
 *  不嵌模型级清单（模型列表仍走既有目录管道）；快照 7 家 ≤ 20 家上限；不做在线刷新（顺延台账）。 */
export interface SnapshotProviderView {
  id: string;
  name: string;
  envKey?: string;
  baseUrl: string;
  type: "openai" | "anthropic";
  local: boolean;
}

export function snapshotProviderView(): SnapshotProviderView[] {
  return Object.values(BUILTIN_SNAPSHOT).map((p) => ({
    id: p.id,
    name: p.name,
    ...(p.env[0] !== undefined ? { envKey: p.env[0] } : {}),
    baseUrl: p.api,
    type: p.type,
    local: p.env.length === 0, // 无 env 声明 = 本地服务免 Key（ollama 现行唯一样本）
  }));
}
