import { resolveWire, adaptBaseUrl } from "./infer.ts";
import type { Catalog, CatalogEntry } from "./catalog.ts";

/** D35 CommandUi 的本地结构形态（T10 落 contracts 后结构兼容直通；无头环境由宿主注入拒绝式实现——fail-closed）。 */
export interface MenuUi {
  ask(question: string): Promise<string>;
  choose(title: string, items: string[]): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

export interface ProviderEntry {
  type: "anthropic" | "openai";
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
}

/** 菜单副作用口（D37）：测试注入 fake，宿主接 config/secrets 的真实读写。 */
export interface MenuDeps {
  loadProviders(): Promise<Record<string, ProviderEntry>>;
  saveProviders(next: Record<string, ProviderEntry>): Promise<void>;
  setModel(providerName: string): Promise<void>;
  appendSecret(key: string, value: string): Promise<void>;
  env: Record<string, string | undefined>;
  getCatalog(): Promise<Catalog>;
  loadLocalCatalog(path: string): Promise<Catalog>;
  fetchImpl: typeof fetch;
}

/** 中文显示名映射（D37）：目录厂商 + 内置五家；缺失回退目录原名。 */
const DISPLAY_NAMES: Record<string, string> = {
  deepseek: "深度求索", "z-ai": "智谱", "z.ai": "智谱", zhipu: "智谱", moonshot: "月之暗面", kimi: "月之暗面",
  openai: "OpenAI", anthropic: "Anthropic", "01-ai": "零一万物", minimax: "MiniMax", qwen: "阿里云百炼",
  baichuan: "百川", openrouter: "OpenRouter", ollama: "Ollama", groq: "Groq", together: "Together",
};

const displayName = (id: string, entry: CatalogEntry): string => DISPLAY_NAMES[id] ?? entry.name ?? id;

/** 可导入的 text 模型（deprecated/alpha/embedding/非文本输出排除——D34 模型过滤）。 */
function usableModels(entry: CatalogEntry): string[] {
  return Object.values(entry.models ?? {})
    .filter((m) => (m.modalities?.output === undefined || m.modalities.output.includes("text")) && m.status !== "deprecated" && m.status !== "alpha")
    .filter((m) => !/embed/i.test(m.id))
    .map((m) => m.id);
}

/** 连通性校验（D37 修订：校验即确认）——GET 模型列表，零 token 消耗。 */
async function verify(
  deps: MenuDeps,
  entry: ProviderEntry,
  actualKey: string | undefined,
): Promise<"ok" | "auth" | "network" | "unsupported"> {
  const url = entry.type === "anthropic" ? `${entry.baseUrl}/v1/models` : `${entry.baseUrl}/models`;
  try {
    const res = await deps.fetchImpl(url, {
      headers: actualKey !== undefined ? {
        "x-api-key": actualKey, authorization: `Bearer ${actualKey}`, // D31 双头
      } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return "auth";
    if (res.status === 404 || res.status === 405) return "unsupported";
    if (!res.ok) return "network";
    return "ok";
  } catch {
    return "network";
  }
}

/** /provider 多级菜单主流程（D37 规格，语言约定：一级英文命令、二级起中文）。 */
export async function runProviderMenu(ui: MenuUi, deps: MenuDeps): Promise<string> {
  const current = await deps.loadProviders();
  const items = [
    ...Object.entries(current).map(([n, p]) => `${displayName(n, { name: n })}\n（${p.baseUrl}）`),
    "[添加新平台]",
    "[取消]",
  ];
  const sel = await ui.choose("选择平台", items);
  if (sel === "[取消]") return "已取消";
  if (sel !== "[添加新平台]") {
    const name = sel.split("\n")[0]!;
    const act = await ui.choose(`${name}`, ["设为当前默认", "更新密钥", "移除", "返回"]);
    if (act === "设为当前默认") {
      await deps.setModel(name);
      return `已设为当前默认（model = "${name}"），下个 turn 生效`;
    }
    if (act === "移除") {
      const next = { ...current };
      delete next[name];
      await deps.saveProviders(next);
      return `已移除 ${name}（重启或 /reload 生效）`;
    }
    return "已返回";
  }

  // ---- 添加新平台 ----
  const src = await ui.choose("数据源", ["在线目录（https://models.dev/api.json）", "本地文件（api.json）", "取消"]);
  if (src === "取消") return "已取消";
  let catalog: Catalog;
  if (src.startsWith("在线目录")) catalog = await deps.getCatalog();
  else catalog = await deps.loadLocalCatalog((await ui.ask("api.json 路径")).trim());

  const keyword = (await ui.ask("厂商关键字（回车全列）")).trim().toLowerCase();
  const entries = Object.entries(catalog).filter(([id, e]) => {
    const hay = `${id} ${e.name ?? ""} ${displayName(id, e)}`.toLowerCase();
    return keyword === "" || hay.includes(keyword);
  });
  if (entries.length === 0) return "目录中没有匹配的厂商";
  entries.sort((a, b) => a[0].localeCompare(b[0])); // 字母序（用户要求 2026-09-18）——同前缀供应商相邻（zai/zhipuai/zhipuai-coding-plan）
  const picked = await ui.choose("选择厂商", [...entries.map(([id, e]) => `${id}（${displayName(id, e)}）`), "取消"]);
  if (picked === "取消") return "已取消";
  const [entryId, entry] = entries.find(([id]) => picked.startsWith(id)) ?? [undefined, undefined];
  if (entry === undefined || entryId === undefined) return "已取消";

  const wire = resolveWire(entry);
  if (wire.kind === "invalid") return `无法导入：${wire.reason}`;
  const baseUrl = adaptBaseUrl(String(entry.api ?? ""), wire.wire);

  // apiKey 最少输入流（D37）：目录声明 env_key 已在环境 → 零输入
  const envKey = entry.env?.[0];
  let actualKey = envKey !== undefined ? deps.env[envKey] : undefined;
  let apiKeyRef: string | undefined;
  if (envKey !== undefined) apiKeyRef = `$ENV:${envKey}`;
  if (actualKey === undefined && envKey !== undefined) {
    const pasted = (await ui.ask(`粘贴 ${envKey} 的值（已安全写入 secrets.env；回车跳过，稍后自行设置）`)).trim();
    if (pasted !== "") {
      await deps.appendSecret(envKey, pasted);
      actualKey = pasted;
    }
  }

  const models = usableModels(entry);
  const defaultModel = models[0];

  // 校验即确认（D37 修订）：2xx 自动写入 / 401 重输 / 网络错回端点 / 404 警告后确认
  const probe: ProviderEntry = { type: wire.wire, baseUrl, ...(apiKeyRef !== undefined ? { apiKey: apiKeyRef } : {}) };
  let v = await verify(deps, probe, actualKey);
  if (v === "auth") {
    const retry = (await ui.ask("密钥无效——重新粘贴（回车放弃）")).trim();
    if (retry !== "" && envKey !== undefined) {
      await deps.appendSecret(envKey, retry);
      actualKey = retry;
      v = await verify(deps, probe, actualKey);
    } else {
      return "未写入：密钥无效（未产生任何配置变更）";
    }
  }
  if (v === "network") return "未写入：端点不可达（请检查 baseUrl 后重试）";
  if (v === "unsupported") {
    const go = await ui.confirm("端点可达但不支持校验接口（/models 404/405），无法校验密钥——仍写入？");
    if (!go) return "已取消";
  }

  const next = { ...current, [entryId]: { type: wire.wire, baseUrl, ...(apiKeyRef !== undefined ? { apiKey: apiKeyRef } : {}), ...(defaultModel !== undefined ? { defaultModel } : {}) } };
  await deps.saveProviders(next);
  const shown = [`  平台：${displayName(entryId, entry)}（${wire.wire} 协议${wire.guessed ? "，目录推断 guessed" : ""}）`, `  端点：${baseUrl}`, `  密钥：${apiKeyRef ?? "（未设置——本地/内网端点可留空）"}`, defaultModel !== undefined ? `  默认模型：${defaultModel}` : ""].filter(Boolean).join("\n");
  const banner = v === "unsupported" ? "success（警告：端点可达但无法校验密钥——/models 404/405）" : "success：已写入并完成校验";
  return `${banner}\n${shown}\n（重启或 /reload 生效；配置已全量重写，注释已移除）`;
}
