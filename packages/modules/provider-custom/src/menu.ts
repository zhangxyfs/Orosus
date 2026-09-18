import { parseModelsResponse } from "@orosus/contracts/provider";
import { resolveWire, adaptBaseUrl } from "./infer.ts";
import type { Catalog, CatalogEntry, CatalogModel, CatalogSource } from "./catalog.ts";

/** D35 CommandUi 的本地结构形态（T10 落 contracts 后结构兼容直通；无头环境由宿主注入拒绝式实现——fail-closed）。 */
export interface MenuUi {
  ask(question: string): Promise<string>;
  /** 密钥粘贴走掩码询问（回显 *——用户走查：明文上屏且进终端滚动历史）。 */
  askSecret(question: string): Promise<string>;
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
  /** 目录元数据带来的窗口写入（顶层 contextWindow，与 provider import --model 同落点）。 */
  setContextWindow(n: number): Promise<void>;
  appendSecret(key: string, value: string): Promise<void>;
  env: Record<string, string | undefined>;
  getCatalog(): Promise<{ catalog: Catalog; source: CatalogSource; fetchedAt?: number }>;
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

/** 相对时间（目录缓存来源标注）：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
function relTime(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 可导入的 text 模型（deprecated/alpha/embedding/非文本输出/非工具调用排除——D34 过滤 + 走查补）。
 *  真正解析 api.json 元数据：按 release_date 新→旧排（无日期殿后），返回模型对象（标签/窗口/日期要用）。 */
function usableModels(entry: CatalogEntry): CatalogModel[] {
  return Object.values(entry.models ?? {})
    .filter((m) => (m.modalities?.output === undefined || m.modalities.output.includes("text")) && m.status !== "deprecated" && m.status !== "alpha")
    .filter((m) => m.tool_call !== false && !/embed/i.test(m.id))
    .toSorted((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? "") || a.id.localeCompare(b.id));
}

/** 目录模型菜单标签：id（名称 · 上下文 NK · 发布日期）——元数据缺省的条目退化为裸 id。 */
function modelLabel(m: CatalogModel): string {
  const parts = [
    ...(m.name !== undefined && m.name !== m.id ? [m.name] : []),
    ...(typeof m.limit?.context === "number" && m.limit.context > 0 ? [`${Math.round(m.limit.context / 1000)}K`] : []),
    ...(m.release_date !== undefined ? [m.release_date] : []),
  ];
  return parts.length === 0 ? m.id : `${m.id}（${parts.join(" · ")}）`;
}

/** 连通性校验（D37 修订：校验即确认）——GET 模型列表，零 token 消耗。 */
async function verify(
  deps: MenuDeps,
  entry: ProviderEntry,
  actualKey: string | undefined,
): Promise<{ kind: "ok"; body: unknown } | { kind: "auth" } | { kind: "network" } | { kind: "unsupported" }> {
  const url = entry.type === "anthropic" ? `${entry.baseUrl}/v1/models` : `${entry.baseUrl}/models`;
  try {
    const res = await deps.fetchImpl(url, {
      headers: actualKey !== undefined ? {
        "x-api-key": actualKey, authorization: `Bearer ${actualKey}`, // D31 双头
      } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return { kind: "auth" };
    if (res.status === 404 || res.status === 405) return { kind: "unsupported" };
    if (!res.ok) return { kind: "network" };
    return { kind: "ok", body: await res.json().catch(() => undefined) }; // 模型发现 T4：响应体随行（live 清单）
  } catch {
    return { kind: "network" };
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
  let degradedNote = ""; // 降级可见（走查修复）：静默回退 7 家快照让用户以为目录被改小；磁盘缓存兜底如实标注来源与时间
  let catalogFull = false; // 全量目录（online/disk/本地文件）＝models.dev 策展数据可信；builtin 快照是裁剪版
  if (src.startsWith("在线目录")) {
    const r = await deps.getCatalog();
    catalog = r.catalog;
    catalogFull = r.source !== "builtin";
    if (r.source === "builtin") degradedNote = "（⚠ 在线目录拉取失败——已回退内置快照（常用 7 家）；检查网络稍后重试，或改用本地文件源）";
    else if (r.source === "disk") degradedNote = `（在线拉取失败——已使用本地缓存目录，上次成功拉取 ${relTime(Date.now() - (r.fetchedAt ?? Date.now()))}）`;
  }
  else {
    // 空路径/文件不存在/坏 JSON → 可读文案而非裸异常崩溃（走查：空回车曾 ENOENT 直接炸栈）
    const p = (await ui.ask("api.json 路径")).trim();
    if (p === "") return "已取消（未输入路径——本地文件源需给 api.json 路径）";
    try {
      catalog = await deps.loadLocalCatalog(p);
      catalogFull = true; // 本地 api.json 即完整目录（形状校验在加载口）
    } catch (err) {
      return `读取本地目录失败：${err instanceof Error ? err.message : String(err)}——请检查路径与 JSON 格式（或改用在线目录）`;
    }
  }

  const keyword = (await ui.ask("厂商关键字（回车全列）")).trim().toLowerCase();
  const entries = Object.entries(catalog).filter(([id, e]) => {
    const hay = `${id} ${e.name ?? ""} ${displayName(id, e)}`.toLowerCase();
    return keyword === "" || hay.includes(keyword);
  });
  if (entries.length === 0) return "目录中没有匹配的厂商";
  entries.sort((a, b) => a[0].localeCompare(b[0])); // 字母序（用户要求 2026-09-18）——同前缀供应商相邻（zai/zhipuai/zhipuai-coding-plan）
  const picked = await ui.choose(`选择厂商${degradedNote}`, [...entries.map(([id, e]) => `${id}（${displayName(id, e)}）`), "取消"]);
  if (picked === "取消") return "已取消";
  // 精确整串匹配（走查：startsWith 会命中字母序在前的同前缀条目——选 zhipuai-coding-plan 导入了普通 zhipuai 的 15 模型清单与错误端点）
  const [entryId, entry] = entries.find(([id, e]) => picked === `${id}（${displayName(id, e)}）`) ?? [undefined, undefined];
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
    const pasted = (await ui.askSecret(`粘贴 ${envKey} 的值（已安全写入 secrets.env；回车跳过，稍后自行设置）`)).trim();
    if (pasted !== "") {
      await deps.appendSecret(envKey, pasted);
      actualKey = pasted;
    }
  }

  const models = usableModels(entry); // 目录清单（live 失败/空时的兜底池，含 ctx/日期元数据）
  const modelById = new Map(models.map((m) => [m.id, m]));

  // 校验即确认（D37 修订）：2xx 自动写入 / 401 重输 / 网络错回端点 / 404 警告后确认
  const probe: ProviderEntry = { type: wire.wire, baseUrl, ...(apiKeyRef !== undefined ? { apiKey: apiKeyRef } : {}) };
  let v = await verify(deps, probe, actualKey);
  if (v.kind === "auth") {
    const retry = (await ui.askSecret("密钥无效——重新粘贴（回车放弃）")).trim();
    if (retry !== "" && envKey !== undefined) {
      await deps.appendSecret(envKey, retry);
      actualKey = retry;
      v = await verify(deps, probe, actualKey);
    } else {
      return "未写入：密钥无效（未产生任何配置变更）";
    }
  }
  if (v.kind === "network") return "未写入：端点不可达（请检查 baseUrl 后重试）";
  if (v.kind === "unsupported") {
    const go = await ui.confirm("端点可达但不支持校验接口（/models 404/405），无法校验密钥——仍写入？");
    if (!go) return "已取消";
  }

  // 模型发现 T4 修订（走查：coding-plan 条目选 2 却列出端点全部 11 个按量模型）：
  // 全量目录在手 → 目录池优先——models.dev 的策展清单就是覆盖口径（coding-plan 条目只含套餐内模型，
  // live /models 会把按量模型一并列出，选了就 1113）。目录降级（builtin）或条目无模型 → live 清单兜底。
  // 必选无跳过（四轮 P2②：跳过=不写会让 onboarding 复检死循环回归）；不取 models[0]（走查缺陷①）
  const live = v.kind === "ok" ? (() => { try { return parseModelsResponse(v.body); } catch { return []; } })() : [];
  const useCatalog = catalogFull && models.length > 0;
  const useLive = !useCatalog && live.length > 0;
  const pool: string[] = useCatalog ? models.map(modelLabel) : useLive ? live : [];
  let defaultModel: string | undefined;
  let modelNote = "";
  let ctxNote = "";
  if (pool.length > 0) {
    const pickedModel = await ui.choose(
      useCatalog ? "选择默认模型（目录策展清单——即该条目的覆盖口径）" : "选择默认模型（来自端点实时清单）",
      pool,
    );
    defaultModel = useLive ? pickedModel : (pickedModel.split("（")[0] ?? pickedModel);
    // 目录元数据链：选中模型带 limit.context → 写顶层 contextWindow（与 provider import --model 同落点）
    const ctx = modelById.get(defaultModel)?.limit?.context;
    if (typeof ctx === "number" && Number.isInteger(ctx) && ctx >= 1024) {
      await deps.setContextWindow(ctx);
      ctxNote = `
  目录窗口：contextWindow = ${ctx}（来自 ${defaultModel} 的 limit.context——更换 model 时请自行更新）`;
    }
  } else {
    modelNote = `
  ⚠ 未找到模型清单——已写入平台，请用 /model 手输全名 "${entryId}/<model>"`;
  }

  const next = { ...current, [entryId]: { type: wire.wire, baseUrl, ...(apiKeyRef !== undefined ? { apiKey: apiKeyRef } : {}), ...(defaultModel !== undefined ? { defaultModel } : {}) } };
  await deps.saveProviders(next);
  if (defaultModel !== undefined) {
    await deps.setModel(entryId); // 裸名（三轮 P2①：与"设为当前默认"同语义——defaultModel 随条目落盘经 D32 路由；onboarding 复检闭环（二轮 P1①））
  }
  const shown = [`  平台：${displayName(entryId, entry)}（${wire.wire} 协议${wire.guessed ? "，目录推断 guessed" : ""}）`, `  端点：${baseUrl}`, `  密钥：${apiKeyRef ?? "（未设置——本地/内网端点可留空）"}`, defaultModel !== undefined ? `  默认模型：${defaultModel}（model = "${entryId}" 裸名即用）` : ""].filter(Boolean).join("\n");
  const banner = v.kind === "unsupported" ? "success（警告：端点可达但无法校验密钥——/models 404/405）" : "success：已写入并完成校验";
  return `${banner}
${shown}${ctxNote}${modelNote}
（重启或 /reload 生效；配置已全量重写，注释已移除）`;
}
