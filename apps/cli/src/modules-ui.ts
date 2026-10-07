import type { Harness } from "@orosus/core";
import type { PanelData, FullApp } from "./tui/fullapp.ts";
import { msText } from "./tui/fullapp.ts";
import { computeModulePreset, planModulePreset, presetBaseline } from "./modpreset.ts";
import { computeUnmountClosure } from "./module-deps.ts";
import { setModuleEnabledInConfig } from "./module-toggle.ts";
import { moduleConfigFileFor, configFace } from "./config-face.ts";
import { realReadModel } from "./startup.ts";
import { registerToolLabels } from "./render.ts";
import { lastRequestMsOf, lastUsageOf, shortenPath } from "./usage-text.ts";
import { panelTasksFromEvent } from "./todo-panel.ts";
import { defaultMenuDeps, type ProviderEntry } from "@orosus/provider-custom";
import type { SessionEvent } from "@orosus/core";
import { t } from "./i18n/app.ts";

/** m5-split-main T9：模块面板/预设族自 main.ts 搬入。横切单例经本依赖对象注入（D2）：
 *  getH/getActiveApp——harness 与全屏实例访问器（activeApp 本体留守 main.ts 渲染装配段——方案
 *  doc-review 注记的「更自然分界」升格，T12 登记）；refreshSkillMenu——技能菜单刷新（skills-ui，
 *  main.ts 惰性闭包织入防环）；proxyStateText/runStartedAt/permCycle——refreshPanel 的三件留守常量。
 *  providersTtl/modelServiceOf 按设计空白 1 随本族（消费方 = refreshPanel 网络卡）。 */
export type ModulesUiDeps = {
  getH: () => Harness;
  getActiveApp: () => FullApp | undefined;
  refreshSkillMenu: () => void;
  proxyStateText: () => Promise<string>;
  runStartedAt: string;
  permCycle: () => string[];
};

/** 挂载模式现算三态（设计空白 17）：启用集 ⊆ 保底名单 → minimal；全启用 → full；其余 → custom。
 *  现算不靠记忆——用户切完极简又手动插拔，「上次切的档」会撒谎。保底名单 = lockReasonFor 三款同款（核心 + approval + 当前活跃 provider）。 */
export const modulePresetOf = (deps: ModulesUiDeps): "full" | "minimal" | "custom" => {
  const providerV = realReadModel(process.cwd())() ?? "";
  return computeModulePreset(deps.getH().graph().audit(), presetBaseline(providerV === "" ? "" : providerV.split("/")[0]!));
};

/** 挂载预设状态（m5 T10，设计空白 16）：极简模式自己关掉的模块名单（会话内存）——
 *  切回完整只恢复这批（用户手动关过的不会被误开）；undefined = 从未切过极简。 */
let minimalClosed: Set<string> | undefined;

/** applyModulePreset 实现（m5 T10）：算关闭集（纯计划器）→ 硬依赖级联闭包展开 →
 *  逐模块写盘（单节失败记日志继续，失败清单带内返回——决策点 21）→ 统一 reload 一次
 *  （关消失模块的挂起窗、面板刷新、标签表重喂——toggleModule 链同款收尾）。 */
export const applyModulePresetImpl = async (deps: ModulesUiDeps, preset: "full" | "minimal"): Promise<{ failed: string[] }> => {
  const h = deps.getH();
  const audit = h.graph().audit();
  const providerV = realReadModel(process.cwd())() ?? "";
  const baseline = presetBaseline(providerV === "" ? "" : providerV.split("/")[0]!);
  const plan = planModulePreset({
    preset,
    activeNames: audit.filter((a) => a.state === "active").map((a) => a.name),
    baseline,
    minimalClosed,
  });
  if (plan.writes.length === 0) return { failed: plan.failed };
  let writeList: string[];
  if (preset === "minimal") {
    // 级联：卸载带走依赖者（computeUnmountClosure——toggleModule 同款）；撞锁定（保底成了被拔者的依赖）拒绝整次带拒因
    const depRows = audit.map((a) => ({ name: a.name, provides: a.provides, dependsOn: a.dependsOn, state: a.state }));
    const lockedNames = audit.filter((a) => lockReasonFor(a.name) !== undefined).map((a) => a.name);
    const closure = computeUnmountClosure(plan.writes.map((w) => w.name), depRows, lockedNames);
    if (!closure.ok) return { failed: [closure.blocked] };
    writeList = closure.write;
  } else {
    writeList = plan.writes.map((w) => w.name);
  }
  const failed: string[] = [];
  for (const name of writeList) {
    try {
      setModuleEnabledInConfig(name, preset === "minimal" ? false : true, moduleConfigFileFor(name, h));
    } catch (err) {
      h.log("host.preset.write-failed", `预设写盘失败：${name}`, { preset, error: String(err instanceof Error ? err.message : err) }); // i18n:diag 诊断面不翻
      failed.push(name);
    }
  }
  if (preset === "minimal") {
    minimalClosed = new Set(writeList); // 幂等：空关闭集不到这里（早退）——不覆盖原记录
  } else {
    minimalClosed = undefined; // 恢复完清记录（再切 minimal 重新记）
  }
  const namesBefore = activeModuleNames(deps); // m5 T7：关消失模块的挂起窗
  try {
    await h.reload();
  } catch (err) {
    h.log("host.preset.reload-failed", `预设 reload 失败（已写盘——可 /reload 或重启对齐）`, { preset, error: String(err instanceof Error ? err.message : err) }); // i18n:diag 诊断面不翻
    return { failed: [...failed, "(reload)"] };
  }
  closeGoneModuleUi(deps, namesBefore);
  registerToolLabels(h.graph().tools.toolInfos());
  await refreshPanel(deps);
  return { failed };
};

/** 写模块配置后的收尾（共用件——Alt+K 技能启停 T9 / F14 视觉模型两处）：空闲走 /reload 同链
 *  （清单即刻生效——reload 链自带标签表/技能菜单/面板重喂；失败 toast 三要素）；busy 不 reload 只 toast。
 *  busy 判定 = 全屏 stateRef.busy 现读（inflight 是 runFullScreen 局部，模块级取不到）；行模式
 *  /settings 在 busy 期排队到 turn 结束才执行——走到这里必然空闲，直接 reload 安全。 */
export const reloadModulesIdle = (deps: ModulesUiDeps, app: FullApp | undefined, busyToast: string): string => {
	if (app === undefined || !app.stateRef.busy) {
		void (async () => {
			try {
				const namesBefore = activeModuleNames(deps);
				await deps.getH().reload();
				closeGoneModuleUi(deps, namesBefore);
				registerToolLabels(deps.getH().graph().tools.toolInfos());
				deps.refreshSkillMenu();
				await refreshPanel(deps);
			} catch (err) {
				(app ?? deps.getActiveApp())?.showToast(t("toast.reloadFailed", { err: err instanceof Error ? err.message : String(err) }));
			}
		})();
		return "";
	}
	return busyToast;
};

/** provider 条目表 TTL 缓存（skillMenu 5s 同款惯例——/provider 菜单改端点后最迟 5s 反映到卡）。 */
let providersCache: { at: number; providers: Record<string, ProviderEntry> } | undefined;
const providersTtl = async (): Promise<Record<string, ProviderEntry>> => {
	const now = Date.now();
	if (providersCache === undefined || now - providersCache.at > 5000) {
		providersCache = { at: now, providers: await defaultMenuDeps().loadProviders() };
	}
	return providersCache.providers;
};

/** 模型服务信息行（2026-10-01 拍板②按倾向留——纯信息行不主张连接状态）：端点域名 + 末次请求耗时
 *  （assistant/message.durationMs 投影，老会话无字段则只显端点）。refreshPanel 异步预取进 panelCache。 */
const modelServiceOf = async (events: SessionEvent[]): Promise<string> => {
	const v = realReadModel(process.cwd())() ?? "";
	if (v === "") return t("panel.unconfigured");
	const providerName = v.includes("/") ? v.split("/")[0]! : v;
	const entry = (await providersTtl())[providerName];
	let host = providerName;
	if (entry !== undefined) {
		try {
			host = new URL(entry.baseUrl).host;
		} catch {
			host = entry.baseUrl; // 无 scheme 形态原样显示（kvRow 行内截断兜底）
		}
	}
	const lastMs = lastRequestMsOf(events);
	return lastMs === undefined ? host : t("net.modelServiceLast", { host, ms: msText(lastMs) });
};

/** 面板快照（渲染同步路径的数据源）：get/set 访问器（可变单例——m5-split-main T9，D2）。 */
let panelCache: PanelData | undefined;
export const getPanelCache = (): PanelData | undefined => panelCache;
export const setPanelCache = (v: PanelData | undefined): void => { panelCache = v; };

/** 面板锁定规则（2026-09-23 用户拍板 + T4 联动闭包复用）：① orosus-core = 核心本体（伪模块）；
 *  ② approval = 安全护栏（出厂 required=true，想松绑走 /permission never 正道）；
 *  ③ 当前活跃 provider 模块 = 拔了当场断模型（换 provider 后旧的自动解锁）。 */
export const lockReasonFor = (name: string): string | undefined => {
	const activeProviderModule = (() => {
		const v = realReadModel(process.cwd())() ?? "";
		return v === "" ? "" : v.split("/")[0]!;
	})();
	return name === "orosus-core" ? t("mod.lock.core")
		: name === "approval" ? t("mod.lock.approval")
		: name === activeProviderModule ? t("mod.lock.provider")
		: undefined;
};

/** reload 后关消失模块的挂起窗（m5 T7——/reload、toggleModule、applyModulePreset 三处 reload 调用点共用）：
 *  拆卡不需要通知（panelData 每秒现读自然消失），窗是持久态必须主动关。
 *  比对 reload 前后的活跃集（报表解析在各调用点口径不一，直接 diff 激活集更稳）。 */
export const activeModuleNames = (deps: ModulesUiDeps): Set<string> => new Set(deps.getH().graph().audit().filter((a) => a.state === "active").map((a) => a.name));
export const closeGoneModuleUi = (deps: ModulesUiDeps, before: Set<string>): void => {
  if (deps.getActiveApp() === undefined) return;
  const after = activeModuleNames(deps);
  for (const n of before) if (!after.has(n)) deps.getActiveApp()!.closeModuleUi(n);
};

/** 权限投影（m5 T9 从 refreshPanel 提纯共用——host.current() 同源）：末条 approval/policy 事件 ?? 配置档。 */
export const permissionOf = (events: { type: string; mode?: unknown }[], fallback: string): string => {
	const lastPolicy = events.filter((e) => e.type === "approval/policy").at(-1) as { mode?: string } | undefined;
	return lastPolicy?.mode ?? fallback;
};

/** m5-i18n：name → def.description 查找（模块描述上屏的原文兜底源）。 */
const defNameMap = (h: Harness): Map<string, { description: string }> => {
	const m = new Map<string, { description: string }>();
	for (const g of h.graph().defs()) m.set(g.def.name, g.def);
	return m;
};

/** 会话名投影（同款提纯）：末条 session/label 事件；未命名 = undefined（显示侧自定「新会话」）。 */
export const sessionLabelOf = (events: { type: string; label?: unknown }[]): string | undefined => {
	const lastLabel = events.filter((e) => e.type === "session/label").at(-1) as { label?: string } | undefined;
	return lastLabel?.label;
};

/** 面板数据异步刷新（渲染是同步路径——历史/审计读取只能预取）：会话顶/turn 结束/命令提交与插拔；
 *  tokens 字段另有事件级就地刷新（assistant/message·turn/compaction → withLiveTokens，2026-10-04）。
 *  无定时驱动——全屏 1 秒 tick 只重绘（重读快照）不重算。 */
export const refreshPanel = async (deps: ModulesUiDeps): Promise<void> => {
	const h = deps.getH();
	const events0 = await h.history();
	// T10（m5-resume-perf D4）：窗口装载的 label 兜底——预算外 label（头部 16KB 种子未覆盖且在压缩点
	// 之前）会让标题误显「新会话」；缺 label 才升级（热路径零成本），全量后端 noop
	let events = events0;
	if (sessionLabelOf(events0) === undefined) {
		await h.ensureHistoryFull();
		events = await h.history();
	}
	const cfg = configFace();
	const permission = permissionOf(events, cfg.approvalMode); // m5 T9：提纯投影（host.current() 共用）
	const lastTodo = events.filter((e) => e.type === "tool-todo/write").at(-1) as
		| { type: string; todos?: unknown }
		| undefined;
	const cycle = deps.permCycle();
	const next = cycle[(cycle.indexOf(permission) + 1 + cycle.length) % cycle.length]!;
	panelCache = {
		model: (() => {
			// F5 十三轮② 用户实测：裸 provider 值不能直接当模型名显示——解析槽的 defaultModel
			const v = realReadModel(process.cwd())() ?? "";
			if (v === "") return t("panel.unconfigured");
			if (v.includes("/")) return v.split("/").pop()!;
			const slot = h.graph().services.provider(v) as { defaultModel?: string } | undefined;
			return slot?.defaultModel ?? v;
		})(),
    session: (() => {
      // 会话项显示标题（2026-09-23 用户拍板——sid 不可读）；未命名显示「新会话」直到 /title 或 fork 命名
      return sessionLabelOf(events) ?? t("panel.newSession");
    })(),
		cwd: shortenPath(process.cwd(), 26),
		tokens: lastUsageOf(events),
		startedAt: deps.runStartedAt, // 本次进程启动（F5 九轮⑤：resume 旧会话不再显示历史年龄）
		contextWindow: cfg.contextWindow,
		modules: h
			.graph()
			.audit()
			.map((a) => {
				const defByName = defNameMap(h);
				const lockedReason = lockReasonFor(a.name);
				const def = defByName.get(a.name);
				return {
					name: a.name,
					// m5-i18n：模块描述上屏（此前除 orosus-core 外恒空串）——mod.desc.<name> 键优先、def.description 原文兜底
					desc: t(`mod.desc.${a.name}`, undefined, def?.description ?? ""),
					state: a.state === "active" ? ("mounted" as const) : a.state === "pending-confirm" ? ("pendingConfirm" as const) : ("off" as const), // m5 T17 第四态
					...(lockedReason !== undefined ? { locked: true, lockedReason } : {}),
				};
			}),
		tasks: (lastTodo !== undefined ? panelTasksFromEvent(lastTodo) : undefined) ?? [],
		permission,
		permissionNext: () => `/permission ${next}`,
		// 「网络 · MCP」卡预取面（2026-10-01）：代理态静态、模型服务行要读 provider 条目（异步预取）；
		// 连接行走 mcp.catalog 现读不进快照——panelData() 装配期合并
		network: { proxy: await deps.proxyStateText(), modelService: await modelServiceOf(events), connections: [] },
	};
};

/** 模块卡现读（m5 T6 口子二）：不走 panelCache 快照——panelData() 每次现调 getter（FullApp 1 秒 tick
 *  驱动重渲，现问现答）；getter 抛错 = 该卡当帧剔除 + host 日志 warn（设计空白 15——不记黑名单，
 *  下帧恢复即回）。卸载拆卡不需要通知：卡注册表随 reload 变化，此处每秒现读自然消失。 */
export const moduleCards = (deps: ModulesUiDeps): PanelData["cards"] => {
	const out: NonNullable<PanelData["cards"]> = [];
	for (const c of deps.getH().graph().cards) {
		try {
			out.push({ area: c.spec.area, order: c.spec.order, title: c.spec.title, widgets: c.spec.widgets });
		} catch (err) {
			deps.getH().log("host.card.read-error", `模块卡读取抛错，当帧剔除：${c.owner}/${c.spec.title}`, { owner: c.owner, title: c.spec.title, error: String(err instanceof Error ? err.message : err) }); // i18n:diag 诊断面不翻
		}
	}
	return out.sort((a, b) => a.order - b.order);
};
