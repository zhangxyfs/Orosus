import { readFileSync } from "node:fs";
import type { Harness } from "@orosus/core";
import type { CommandUi } from "@orosus/contracts/module";
import type { SlashItem, FullApp } from "./tui/fullapp.ts";
import { readSkillDisabled, skillDetailText, skillListRow, toggleSkillDisabled, type SkillCatalogRow } from "./skill-settings.ts";
import { subagentConfigFile } from "./config-face.ts";
import { ESC_CANCELLED } from "./i18n/protocol-strings.ts";

/** m5-split-main T7：技能菜单族自 main.ts 搬入。横切单例经本依赖对象注入（D2）：
 *  getH——harness 单例；commandUi——行模式菜单口；reloadModulesIdle——/reload 收尾共用件（T9 留守件）。 */
export type SkillUiDeps = {
  getH: () => Harness;
  commandUi: CommandUi;
  reloadModulesIdle: (app: FullApp | undefined, busyToast: string) => string;
};

/** /settings → 技能（m4-7 T8/T9，原型图 2/3/4）：列表页（全收口径——含停用与仅手动者）→ 详情页
 *  （五字段 + Alt + K 启停）。数据源 = skill.catalog 服务现取（与 T7 菜单同链）+ disabled 现读盘覆盖
 *  （busy 期 reload 缓挂、catalog 停用快照滞后——盘是 Alt + K 即时写的，以盘为准）。 */
const skillCatalogRows = async (deps: SkillUiDeps): Promise<SkillCatalogRow[]> => {
	const catalog = await deps.getH().graph().services.getOptional("skill.catalog");
	const rows = typeof catalog === "function" ? (catalog as () => SkillCatalogRow[])() : [];
	const disabledNow = new Set(readSkillDisabled(subagentConfigFile()));
	for (const r of rows) r.disabled = disabledNow.has(r.name);
	return rows;
};

/** Alt + K 写配置后的收尾（T9）：共用件之上拼技能启停文案（图 4 三要素：动作 · 原因 · 出路）。 */
const afterSkillToggle = (deps: SkillUiDeps, app: FullApp | undefined, name: string, nowDisabled: boolean): string =>
	deps.reloadModulesIdle(app, `${nowDisabled ? "已停用" : "已启用"} ${name} · 有任务在执行，稍后请输入 /reload 重新加载`);
export const openSkillsPanel = async (app: FullApp, deps: SkillUiDeps): Promise<void> => {
	let selAt = 0; // 详情 Esc 回列表——选中行回到该技能（原型图 3 要点；pickOverlay selAt 参数）
	for (;;) {
		const rows = await skillCatalogRows(deps);
		if (rows.length === 0) {
			app.showToast("没有可用技能（扫描 ~/.agents/skills 等四轨目录，每目录下 <名>/SKILL.md）");
			return;
		}
		// 行宽与 pick 渲染同源（m4-7 走查修 2026-09-27：原按全终端列数拼行——侧栏在场时超宽把右框 │ 推错位）
		const w = app.pickRowWidth();
		// items 数组长期持有（2026-09-27 用户走查拍板「改变状态后要更新上一级列表」）：详情 Alt + K 后
		// 原地重拼该行——Esc 回列表顶上的正是这个排队的 pickOverlay（持同数组引用），状态列即时新
		const items = rows.map((r) => skillListRow(w, r));
		const picked = await app.pickOverlay("技能（回车查看详情）", items, selAt);
		if (picked === undefined || picked < 0 || picked >= rows.length) return; // Esc 返回设置
		selAt = picked;
		const row = rows[picked]!;
		const detail = (): string => skillDetailText(w, row); // dock 窗（贴输入框上缘、左栏同宽）行预算
		// dock（2026-09-27 用户拍板：原 center80 居中弹窗位置/宽度都不对——贴输入框上边缘 + 与输入框同宽）
		app.viewText("技能详情", detail(), { layout: "dock", keys: {
				"alt+k": {
					label: "Alt + K 启用或停用",
					run: (): string => {
						const nowDisabled = toggleSkillDisabled(row.name, subagentConfigFile());
						row.disabled = nowDisabled;
						items[picked] = skillListRow(w, row); // 上一级列表行原地更新（回列表即见新状态）
						const toast = afterSkillToggle(deps, app, row.name, nowDisabled);
						if (toast !== "") app.showToast(toast); // busy 缓后（图 4）
						return detail(); // 状态行即时翻转（内容替换）
					},
				},
			},
		});
		// viewText 入队不 await——Esc 关详情后循环重入的 pickOverlay 排队顶上（回列表；openTasks 同款结构）
	}
};
/** 行模式对等件（m4-7 T8/T9）：列表 choose → 详情文本直出 → 动作菜单（停用/启用 · 返回列表）。 */
export const openSkillsLine = async (out: (s: string) => void, deps: SkillUiDeps): Promise<void> => {
	for (;;) {
		const rows = await skillCatalogRows(deps);
		if (rows.length === 0) { out("没有可用技能（扫描 ~/.agents/skills 等四轨目录，每目录下 <名>/SKILL.md）"); return; }
		const names = rows.map((r) => skillListRow(76, r));
		const picked = await deps.commandUi.choose("技能（回车查看详情）", names);
		const i = names.indexOf(picked);
		if (i < 0) return;
		const row = rows[i]!;
		out(skillDetailText(76, row));
		try {
			const action = await deps.commandUi.choose(row.name, [row.disabled ? "启用" : "停用（Alt + K 同款）", "返回列表"]);
			if (action === "启用" || action === "停用（Alt + K 同款）") {
				const nowDisabled = toggleSkillDisabled(row.name, subagentConfigFile());
				const toast = afterSkillToggle(deps, undefined, row.name, nowDisabled);
				out(toast !== "" ? toast : `已${nowDisabled ? "停用" : "启用"} ${row.name}（模块已重载，清单即刻生效）`);
			}
		} catch (err) {
			if (err instanceof Error && err.message === ESC_CANCELLED) continue; // Esc → 回技能列表（2026-09-28 拍板）
			throw err;
		}
	}
};

interface SkillMenuRow {
	name: string;
	description: string;
	whenToUse?: string;
	disabled: boolean;
	file: string;
}
let skillMenu: SlashItem[] = [];
const skillFiles = new Map<string, string>(); // 技能真名 → SKILL.md 实路径（Enter 注入读正文用）
let skillMenuAt = 0;
/** 菜单缓存刷新：catalog 是 Promise 口而菜单渲染同步——TTL 惰性（skillItems 被调时隔 5s 触发一次）
 *  + 显式点（/reload 收尾、模块插拔 reload 后、启动）。disabled 不进菜单（D7：停用双摘；
 *  disable-model-invocation 照显——用户手动路径不受限）。 */
export const refreshSkillMenu = async (deps: SkillUiDeps): Promise<void> => {
	// CM-12②（2026-09-28 code review）：catalog 是模块代码——同步抛错使本 Promise reject，而五个调用点全是
	// void 调用 = unhandledRejection 直崩进程（Node 22 起缺省 throw）；与 moduleCards「模块卡读取抛错当帧剔除」
	// 同政策：失败 = 菜单清空 + host 日志，技能面降级不带走宿主
	try {
		const catalog = await deps.getH().graph().services.getOptional("skill.catalog");
		if (typeof catalog !== "function") {
			skillMenu = [];
			skillFiles.clear();
			return;
		}
		const rows = (catalog as () => SkillMenuRow[])();
		skillFiles.clear();
		for (const r of rows) skillFiles.set(r.name, r.file);
		skillMenu = rows.filter((r) => !r.disabled).map((r) => ({
			name: `skill : ${r.name}`,
			desc: r.description,
			long: r.description, // 详释行 1-2 = description 折行截断（原型图 1）
			...(r.whenToUse !== undefined ? { usage: r.whenToUse } : {}),
			skill: r.name,
		}));
	} catch (err) {
		skillMenu = [];
		skillFiles.clear();
		deps.getH().log("host.skillmenu.error", `技能菜单刷新抛错，当帧清空：${err instanceof Error ? err.message : String(err)}`);
	}
};

/** 技能区 TTL 访问器（m4-7 T7 原在 fullapp 接线内的 skillItems 闭包，随族搬入）：
 *  被调时隔 5s 后台刷一次缓存并返回当前菜单；/reload 收尾与模块插拔后另有显式刷新点。 */
export const skillMenuTtl = (deps: SkillUiDeps): SlashItem[] => {
	const now = Date.now();
	if (now - skillMenuAt > 5000) {
		skillMenuAt = now;
		void refreshSkillMenu(deps);
	}
	return skillMenu;
};

/** 技能注入标记行前缀（本件构造、多方按形态匹配——单源常量防漂移）：防重入判定（main 提交层
 *  includes）/ 输入召回还原（session-io 老会话合成体拆原话）。docmodel ● 行识别与 core 树标题
 *  各持同款正则（core 禁反向 import apps，跨包不共享——形态由测试钉住）。 */
export const SKILL_MARK_PREFIX = "（用户通过菜单手动加载技能";
/** 完整标记行（含技能名捕获）——session-io 老会话合成体还原原话行用；与 docmodel/core 同形不同源。 */
export const SKILL_MARK_RE = /(?:^|\n)（用户通过菜单手动加载技能 "([^"]+)"——请按该技能正文行事）/;

/** 技能条目 Enter 注入（D3 拍板）：正文剥 frontmatter 后包 <skill> 块，以用户消息提交——
 *  pi/kimi 同款形态，走主输入口零新机制（busy 期照排队语义，不打断 turn）。读不到 = undefined（菜单提示）。 */
export const skillInjectText = (name: string, args?: string): string | undefined => {
	const file = skillFiles.get(name);
	if (file === undefined) return undefined;
	try {
		const body = readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, ""); // 剥 frontmatter
			// 参数挂 <skill> 块属性（kimi renderSkillLoadedBlock 的 args="..." 同款，引号转义防早闭）；
			// 标记行保持首位原样——docmodel 的 ● 行识别按该行前缀，菜单 Enter 路不传 args 形态不变
			const attrs = args !== undefined ? ` args="${args.replace(/"/g, "&quot;")}"` : "";
			// 2026-10-01 诊断批：file 属性给模型提供相对路径解析基准（正文引用 references/… 不再按项目
			// cwd 落空——与 skill__load 输出首行带路径同因）；首行协议串不动（docmodel ● 行识别 + 防重入
			// 标记都按精确形态匹配它）；skill 块正文不进对话流，属性追加对用户可见面零影响
			return `${SKILL_MARK_PREFIX} "${name}"——请按该技能正文行事）\n<skill name="${name}"${attrs} file="${file.replace(/"/g, "&quot;")}">\n${body}\n</skill>`;
	} catch {
		return undefined;
	}
};

/** /skill : 名 提交解析的真名归位（2026-09-30）：目录真名精确命中优先，落空整表小写比对
 *  （命令词忽略大小写同口径——手输大小写不齐也能筛到）。 */
export const skillTypedName = (typed: string): string | undefined => {
	if (skillFiles.has(typed)) return typed;
	const lower = typed.toLowerCase();
	return [...skillFiles.keys()].find((k) => k.toLowerCase() === lower);
};
