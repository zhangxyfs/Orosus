import { parseModelsResponse } from "@orosus/contracts/provider";
import { OROSUS_USER_AGENT } from "@orosus/contracts/version";
import { resolveWire, adaptBaseUrl } from "./infer.ts";
import { detectSameGate, usableCatalogModels, type Catalog, type CatalogEntry, type CatalogModel, type CatalogSource } from "./catalog.ts";

/** D35 CommandUi 的本地结构形态（T10 落 contracts 后结构兼容直通；无头环境由宿主注入拒绝式实现——fail-closed）。 */
export interface MenuUi {
  ask(question: string): Promise<string>;
  /** 密钥粘贴走静默询问（无回显——ssh/docker login 同款；明文上屏且进终端滚动历史，用户走查）。 */
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

/** 子菜单 Esc 判别（2026-09-28 用户拍板「Esc 返回上一级」）：宿主 choose/ask 面的取消 = 带内抛错，
 *  字面量「已取消（Esc）」由 apps/cli（menu.ts / picker.ts / pickFace）钉死——模块侧按文案鉴别，
 *  只认这一个字面量，其余异常原样穿透（CR-04 纪律：无差别映射会把真实故障伪装成用户取消）。 */
const isEscCancel = (err: unknown): boolean => err instanceof Error && err.message === "已取消（Esc）";

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
  /** 磁盘目录缓存直读（2026-09-28 用户拍板）：本地文件源先查 ~/.orosus/cache/models-dev.json——
   *  在场即直读不再问路径；缺省（未注入）= 视同无缓存，回落问路径。测试注入隔离 home（HERMETIC）。 */
  readCacheCatalog?(): Catalog | undefined;
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

/** 可导入的 text 模型清单（口径单源在 catalog.ts 的 usableCatalogModels——槽值 listModels 目录优选同用）。 */
const usableModels = usableCatalogModels;

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
      headers: {
        "user-agent": OROSUS_USER_AGENT,
        ...(actualKey !== undefined ? {
          "x-api-key": actualKey, authorization: `Bearer ${actualKey}`, // D31 双头
        } : {}),
      },
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

/** /provider 多级菜单主流程（D37 规格，语言约定：一级英文命令、二级起中文）。
 *  Esc 逐级返回（2026-09-28 用户拍板「子菜单 Esc 返回上一级」）：动作菜单/数据源 Esc → 平台列表；
 *  厂商列表 Esc → 数据源；厂商选定后的密钥/模型询问 Esc → 厂商列表。根列表（选择平台）的 Esc 仍整体取消
 *  ——不接，穿透回宿主 settleCommandError 静默。显式「取消」项语义不变（结束流程）。 */
export async function runProviderMenu(ui: MenuUi, deps: MenuDeps): Promise<string> {
  const current = await deps.loadProviders();
  for (;;) { // 根循环：动作菜单「返回」/Esc、数据源 Esc 的回退落点
    const names = Object.keys(current); // 槽 key 并行数组（MP-01 修复）：列表文案用 displayName 渲染，选中按下标反查回真名
    const items = [
      ...names.map((n) => `${displayName(n, { name: n })}\n（${current[n]!.baseUrl}）`),
      "[添加新平台]",
      "[取消]",
    ];
    const sel = await ui.choose("选择平台", items);
    if (sel === "[取消]") return "已取消";
    if (sel !== "[添加新平台]") {
      // MP-01：不得从显示文案反解——displayName 会把 deepseek/moonshot 等目录槽名译成中文显示名，
      // split("\n")[0] 拿回的是显示名，当槽 key 用则 setModel(显示名) 写坏配置、delete next[显示名] 假成功
      const name = names[items.indexOf(sel)];
      if (name === undefined) return "已取消"; // 选中项不在列表（宿主 ui 异常返回）——不猜
      let act: string;
      try {
        act = await ui.choose(displayName(name, { name }), ["设为当前默认", "更新密钥", "移除", "返回"]);
      } catch (err) {
        if (isEscCancel(err)) continue; // Esc = 返回上一级（与显式「返回」项同效）
        throw err;
      }
      if (act === "返回") continue;
      if (act === "设为当前默认") {
        await deps.setModel(name); // 裸槽名（F5 十轮）——真名（MP-01 前：显示名写入，provider 解析必失败）
        return `已设为当前默认（provider = "${name}"）`;
      }
      if (act === "更新密钥") {
        // MP-05：接通真实交互流（此前菜单数组提供该项但处理链无分支——选中直接落「已返回」，密钥不变，
        // 用户要到下一次 401 才发现更新没生效）。槽密钥经 $ENV: 引用 secrets.env——据此定位 env key；
        // 非 $ENV 槽（明文 key / 无密钥）如实告知，不猜目标 key、零副作用。
        const ref = current[name]!.apiKey;
        const envKey = ref !== undefined && ref.startsWith("$ENV:") ? ref.slice(5) : undefined;
        if (envKey === undefined) {
          return "未更新：该槽未使用 $ENV: 密钥引用（明文 key 或无密钥槽——请直接编辑 config.toml / secrets.env）";
        }
        let pasted: string;
        try {
          pasted = (await ui.askSecret(`请粘贴 ${envKey} 的新值（回车取消）`)).trim();
        } catch (err) {
          if (isEscCancel(err)) continue; // Esc → 回平台列表
          throw err;
        }
        if (pasted === "") return "已取消（密钥未变更）";
        await deps.appendSecret(envKey, pasted); // 后写覆盖语义（loadSecretsEnv 后者覆盖）——CLI 宿主写盘后重载即生效
        const v = await verify(deps, current[name]!, pasted); // 校验即确认（与添加流程同款，GET /models 零 token 消耗）
        if (v.kind === "ok") return `已更新 ${displayName(name, { name })} 的密钥并校验通过`;
        if (v.kind === "auth") return "已写入但新密钥校验未过（401/403）——可重选「更新密钥」再试";
        if (v.kind === "unsupported") return "已写入（端点不支持校验接口——新密钥已生效，下次对话即使用）";
        return "已写入但端点暂不可达（网络错误）——新密钥已生效，下次对话即使用";
      }
      if (act === "移除") {
        const next = { ...current };
        delete next[name]; // 真名删除（MP-01 前：delete next[显示名] 对槽表是 no-op，回报「已移除」假成功）
        await deps.saveProviders(next);
        return `已移除 ${displayName(name, { name })}（${name}）`;
      }
      continue; // 宿主 ui 异常返回未知项——回根列表不猜
    }

    // ---- 添加新平台 ----（源级循环：厂商列表 Esc /本源 ask Esc 的回退落点 = 重问数据源）
    for (;;) {
      let src: string;
      try {
        src = await ui.choose("数据源", ["在线目录（https://models.dev/api.json）", "本地文件（api.json）", "取消"]);
      } catch (err) {
        if (isEscCancel(err)) break; // Esc → 回平台列表（根循环继续）
        throw err;
      }
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
        if (r.source !== "online") {
          // 代理根因提示（M4-2 T3/B2 spike 降级）：undici 包不可 import（Node 不暴露内置 undici 模块面，
          // 新增依赖违反零新增约束）——实证 Node ≥24 启动期 NODE_USE_ENV_PROXY=1 使内置 fetch 走代理环境变量
          const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
          if (proxyUrl !== undefined) {
            degradedNote += `；检测到代理 ${proxyUrl}，但 Node 内置 fetch 不自动走代理环境变量——Node ≥24 以 NODE_USE_ENV_PROXY=1 启动即可启用，或改用本地文件源`;
          }
        }
      }
      else {
        // 缓存直读（2026-09-28 用户拍板）：~/.orosus/cache/models-dev.json 在场即直读——不再弹「api.json 路径」
        // 输入行（在线目录成功拉取/本地导入都喂过盘，缓存即最新一次目录）；缺缓存才问路径
        const cached = deps.readCacheCatalog?.();
        if (cached !== undefined) {
          catalog = cached;
          catalogFull = true; // 缓存信封里的都是真实拉取数据（builtin 从不落盘）
          degradedNote = "（数据源：本地缓存 ~/.orosus/cache/models-dev.json）";
        } else {
          // 空路径/文件不存在/坏 JSON → 可读文案而非裸异常崩溃（走查：空回车曾 ENOENT 直接炸栈）
          let p: string;
          try {
            p = (await ui.ask("api.json 路径")).trim();
          } catch (err) {
            if (isEscCancel(err)) continue; // Esc → 回数据源
            throw err;
          }
          if (p === "") return "已取消（未输入路径——本地文件源需给 api.json 路径）";
          try {
            catalog = await deps.loadLocalCatalog(p);
            catalogFull = true; // 本地 api.json 即完整目录（形状校验在加载口）
          } catch (err) {
            return `读取本地目录失败：${err instanceof Error ? err.message : String(err)}——请检查路径与 JSON 格式（或改用在线目录）`;
          }
        }
      }
      catalog = detectSameGate(catalog); // 同厂两门标注（M4-2 T2）：在线/本地两源统一后处理

      // 全量直列（F5 九轮用户拍板：不再先问关键字——全屏列表内输入即过滤，includes 口径）；
      // 字母序（用户要求 2026-09-18）——同前缀供应商相邻（zai/zhipuai/zhipuai-coding-plan）
      const entries = Object.entries(catalog);
      entries.sort((a, b) => a[0].localeCompare(b[0]));
      // 厂商级循环：选定厂商后的密钥/模型询问 Esc → 回厂商列表
      for (;;) {
        let picked: string;
        try {
          picked = await ui.choose(`选择厂商${degradedNote}`, [...entries.map(([id, e]) => `${id}（${displayName(id, e)}）`), "取消"]);
        } catch (err) {
          if (isEscCancel(err)) break; // Esc → 回数据源（源级循环重问）
          throw err;
        }
        if (picked === "取消") return "已取消";
        // 精确整串匹配（走查：startsWith 会命中字母序在前的同前缀条目——选 zhipuai-coding-plan 导入了普通 zhipuai 的 15 模型清单与错误端点）
        const [pickedId0, pickedEntry0] = entries.find(([id, e]) => picked === `${id}（${displayName(id, e)}）`) ?? [undefined, undefined];
        if (pickedEntry0 === undefined || pickedId0 === undefined) return "已取消";
        const entryId = pickedId0;
        const entry = pickedEntry0;
        // sameGate 子菜单退役（F5 九轮用户拍板）：列表两门相邻独立可选，选中即所得——
        // 「此厂商有 N 个入口」二跳与选中项标注错位（标准/套餐标签按 picked 假设硬编码）一并消失

        const wire = resolveWire(entry);
        if (wire.kind === "invalid") return `无法导入：${wire.reason}`;
        const baseUrl = adaptBaseUrl(String(entry.api ?? ""), wire.wire);

        // apiKey 最少输入流（D37）：目录声明 env_key 已在环境 → 零输入
        const envKey = entry.env?.[0];
        let actualKey = envKey !== undefined ? deps.env[envKey] : undefined;
        let apiKeyRef: string | undefined;
        if (envKey !== undefined) apiKeyRef = `$ENV:${envKey}`;
        if (actualKey === undefined && envKey !== undefined) {
          const pasted = (await ui.askSecret(`请粘贴 ${envKey} 的值（回车跳过；粘贴后将安全写入 secrets.env）`)).trim();
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
        try {
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
        } catch (err) {
          if (isEscCancel(err)) continue; // 模型选择 Esc → 回厂商列表（probe 重跑一次 GET /models，零 token）
          throw err;
        }

        const next = { ...current, [entryId]: { type: wire.wire, baseUrl, ...(apiKeyRef !== undefined ? { apiKey: apiKeyRef } : {}), ...(defaultModel !== undefined ? { defaultModel } : {}) } };
        await deps.saveProviders(next);
        if (defaultModel !== undefined) {
          await deps.setModel(entryId); // 裸槽名（F5 十轮用户拍板：provider = "<槽>"——模型落在条目 defaultModel）
        }
        const shown = [`  平台：${displayName(entryId, entry)}（${wire.wire} 协议${wire.guessed ? "，目录推断 guessed" : ""}）`, `  端点：${baseUrl}`, `  密钥：${apiKeyRef ?? "（未设置——本地/内网端点可留空）"}`, defaultModel !== undefined ? `  默认模型：${defaultModel}（provider = "${entryId}"，模型经条目 defaultModel 生效）` : ""].filter(Boolean).join("\n");
        const banner = v.kind === "unsupported" ? "success（警告：端点可达但无法校验密钥——/models 404/405）" : "success：已写入并完成校验";
        return `${banner}
${shown}${ctxNote}${modelNote}
（配置已全量重写，注释已移除；CLI 宿主写盘后自动重载模块图即生效）`;
      }
    }
  }
}
