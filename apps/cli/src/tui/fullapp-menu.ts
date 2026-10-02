/** fullapp-menu.ts（m5-split-fullapp T7）：斜杠菜单 overlay 键族——纯搬移自 fullapp.ts 类体
 *  （参数阶段/候选清单/技能区过滤/可选行夹取/overlay 键路由/技能注入）。
 *  normCmd/isSubseq 经 fullapp-types import（T2 已出仓）。非公开 API。 */

import { isSubseq, normCmd, OVERLAY_PAGE, type SlashItem } from "./fullapp-types.ts";
import { isPrintable } from "./keymatch.ts";
import type { FullApp } from "./fullapp.ts";

/** overlaySel 夹到可选行（sep 不可选——重置 0/滚窗后落 sep 时沿向下让位）。零 app 触达住模块级。 */
const selToSelectable = (rows: { kind: string }[], from: number): number => {
	let i = Math.max(0, Math.min(rows.length - 1, from));
	while (i < rows.length - 1 && rows[i] !== undefined && rows[i]!.kind === "sep") i++;
	return i;
};

export function createMenu(app: FullApp) {
	/** 参数阶段探测（m5 T15）：输入已是「/命令 参数」形态且该命令声明了补全 → 菜单切参数候选。
	 *  优先于二级列表（children 是菜单选定驱动，参数阶段是文本驱动）。 */
	const argPhase = (): { cmd: string; word: string; args: string; items: string[] } | undefined => {
		const typed = app.state.input; // 原始输入——normCmd 会裁尾空格，而尾空格正是参数阶段的触发形态
		if (!typed.startsWith("/")) return undefined;
		const sp = typed.indexOf(" ");
		if (sp <= 0) return undefined;
		const cmd = typed.slice(0, sp);
		const args = typed.slice(sp + 1);
		const word = args.split(/\s+/).pop() ?? "";
		const all = app.io.slashArgComplete?.(cmd, word, args);
		if (all === undefined || all.length === 0) return undefined;
		return { cmd, word, args, items: all.filter((x) => x.startsWith(word)) };
	};

	/** 斜杠菜单当前候选清单（onOverlayKey 与滚轮路由共用一源——两处过滤口径漂移即选中越界/Enter 错位）。
	 *  m4-7 T7：一级含技能区（sep 分隔行 + 技能条目殿后于命中命令）；key 一级命令 = 命令名、技能 = 真名。
	 *  （m4-3c T18 曾加 MCP 区，2026-09-30 用户打回「没有意义」整段退役——管理面唯一入口 /settings。） */
	const overlayItems = (): { key: string; kind: "cmd" | "skill" | "sep" }[] => {
		const s = app.state;
		const level2 = s.overlayCmd !== "";
		const ap = argPhase();
		if (ap !== undefined) return ap.items.map((c) => ({ key: c, kind: "cmd" as const }));
		if (level2) return (app.io.slashCommands().find((c) => c.name === s.overlayCmd)?.children ?? []).map((c) => ({ key: c, kind: "cmd" as const }));
		const cmds = app.input.filteredCommands().map((c) => ({ key: c.name, kind: "cmd" as const }));
		const skills = filteredSkills().map((c) => ({ key: c.skill ?? c.name, kind: "skill" as const }));
		const out: { key: string; kind: "cmd" | "skill" | "sep" }[] = [...cmds];
		if (skills.length > 0) out.push({ key: "", kind: "sep" as const }, ...skills);
		return out;
	};

	/** 技能区过滤（m4-7 T7，原型图 1）：技能名档位（前缀排前、含字居中、子序列殿后——2026-09-30
	 *  第三档拍板）殿后于全部命中命令；技能组整体不插进命令组（「追加在全部命中命令之后」）。q 为空 = 全显。
	 *  可搜文本 = 真名 + 显示标签「skill : 名」：只认真名则 /skas 筛不出 ask（skas 非 ask 子序列），认标签才成立。 */
	const filteredSkills = (): SlashItem[] => {
		const q = normCmd(app.state.input).slice(1).split(" ")[0]!.toLowerCase();
		const hits: SlashItem[] = [];
		const more: SlashItem[] = [];
		const fuzzy: SlashItem[] = [];
		for (const c of app.io.skillItems?.() ?? []) {
			const n = (c.skill ?? c.name).toLowerCase();
			const label = `skill : ${n}`;
			if (n.startsWith(q) || label.startsWith(q)) hits.push(c);
			else if (n.includes(q) || label.includes(q)) more.push(c);
			else if (isSubseq(q, n) || isSubseq(q, label)) fuzzy.push(c);
		}
		return [...hits, ...more, ...fuzzy];
	};

	const onOverlayKey = (key: string): void => {
		const s = app.state;
		const level2 = s.overlayCmd !== "";
		const ap = argPhase();
		const items = overlayItems();
		// 循环步进跳过 sep（m4-7 技能分隔行不可选——up/down 回绕也越不过它停上去）
		const step = (from: number, delta: number): number => {
			let i = from;
			do { i = (i + delta + items.length) % items.length; } while (items[i] !== undefined && items[i]!.kind === "sep");
			return i;
		};
		if (key === "escape") {
			if (level2) {
				s.overlayCmd = "";
				s.input = "/";
				s.cursor = 1;
				s.overlaySel = 0;
			} else s.overlayOpen = false; // 参数阶段也走这里：只关菜单不清输入（Esc 回命令名阶段 = 继续编辑参数）
		} else if (key === "up" && items.length > 0) {
			s.overlaySel = step(s.overlaySel, -1);
		} else if (key === "down" && items.length > 0) {
			s.overlaySel = step(s.overlaySel, 1);
		} else if (key === "pageUp" && items.length > 0) {
			s.overlaySel = selToSelectable(items, s.overlaySel - OVERLAY_PAGE);
		} else if (key === "pageDown" && items.length > 0) {
			s.overlaySel = selToSelectable(items, s.overlaySel + OVERLAY_PAGE);
		} else if (key === "tab" && ap !== undefined && items.length > 0) {
			// 参数阶段 Tab（m5 T15）：选中候选替换当前词 + 空格（可继续补下一词）
			const picked = items[s.overlaySel] ?? items[0]!;
			const head = ap.args.slice(0, ap.args.length - ap.word.length);
			s.input = `${ap.cmd} ${head}${picked.key} `;
			s.cursor = s.input.length;
			s.overlaySel = 0;
		} else if (key === "tab" && !level2 && items.length > 0) {
			// 技能 Tab 填可输入形态「/skill : 名」（2026-09-30 用户拍板：Tab ≠ Enter——回车直接执行技能，
			// Tab 落输入框可编辑，提交层 processReplLine 解析该格式再注入正文）；命令行 Tab 照旧补全命令名
			const sel = items[s.overlaySel];
			s.input = sel?.kind === "skill" ? `/skill : ${sel.key}` : sel?.key ?? s.input;
			s.cursor = s.input.length;
			s.overlayOpen = false;
		} else if (key === "enter") {
			// 「/skill : 名 [参数]」完整形态（Tab 填出或手敲，2026-09-30 拍板「我输入啥就显示啥」）：
			// 菜单开着也提交原话走提交层（processReplLine 解析：原话回显 + 参数随技能注入）——不在此处
			// fireSkill（只带名字会丢参数也不回显）；零命中空态同样放行（否则带参形态被空态卡死无法发）；
			// 纯过滤词（/pdf 之类无冒号形态）维持「回车直接执行技能」拍板不变
			if (/^\/skill\s*:\s*\S/i.test(normCmd(s.input))) {
				s.overlayOpen = false;
				s.overlayCmd = "";
				app.input.submitLine(normCmd(s.input));
				app.scheduler.requestImmediateRender();
				return;
			}
			if (items.length === 0) {
				app.scheduler.requestImmediateRender();
				return;
			}
			if (ap !== undefined) {
				// 参数阶段 Enter（m5 T15）：选中候选替换当前词后提交（未选中任何行 = 提交原文）
				const picked = items[s.overlaySel];
				const final = picked === undefined ? normCmd(s.input) : `${ap.cmd} ${ap.args.slice(0, ap.args.length - ap.word.length)}${picked.key}`;
				s.overlayOpen = false;
				s.overlayCmd = "";
				app.input.submitLine(final);
				app.scheduler.requestImmediateRender();
				return;
			}
			// CTU-01 修复（2026-09-28 code review P0）：粘贴收缩清单/技能清单 5s TTL 异步换数组后 overlaySel
			// 可越界（渲染侧只算不回写），消费侧就地钳制——selToSelectable 夹回 [0, len-1] 并避开 sep 行
			s.overlaySel = selToSelectable(items, s.overlaySel);
			const row = items[s.overlaySel]!;
			if (row.kind === "skill") {
				// 技能 Enter = 用户触发（m4-7 T7 / 原型图 1 验收点 4）
				fireSkill(row.key);
				app.scheduler.requestImmediateRender();
				return;
			}
			const picked = row.key;
			const slash = app.io.slashCommands().find((c) => c.name === picked);
			if (!level2 && slash?.children !== undefined) {
				s.overlayCmd = picked;
				s.input = picked;
				s.cursor = picked.length;
				s.overlaySel = Math.max(0, slash.children.indexOf(app.io.slashCurrent(picked)));
			} else {
				// 带参数输入（/title 新名字）提交原文——裸命令名会丢参数（2026-09-23 实测：/title 改名失效前案，
				// 菜单过滤只认命令词、Enter 只提交 picked）；无参数 = picked（别名转正名）
				const typed = normCmd(s.input);
				const cmd = level2 ? `${s.overlayCmd} ${picked}` : typed.includes(" ") ? typed : picked;
				s.overlayOpen = false;
				s.overlayCmd = "";
				app.input.submitLine(cmd);
			}
		} else if (!level2 && (key === "backspace" || isPrintable(key))) {
			if (key === "backspace") {
				if (s.cursor > 0) {
					s.input = s.input.slice(0, s.cursor - 1) + s.input.slice(s.cursor);
					s.cursor--;
				}
			} else app.input.inputInsert(key);
			// 重置选中须按敲键后的新清单算（2026-09-30 用户走查：/mc+/p 把命中命令筛光后 sep 占 0 位，
			// 旧实现用敲键前 items 重置 0 落 sep——渲染不跳 sep 焦点整屏隐身，Tab 还吃 sep 空串清空输入框）
			if (normCmd(s.input).startsWith("/")) s.overlaySel = selToSelectable(overlayItems(), 0);
			else s.overlayOpen = false;
		}
		app.scheduler.requestImmediateRender();
	};

	/** 技能条目 Enter 触发：正文以用户消息注入当前轮（m4-7 D3 拍板，pi/kimi 同款——走主输入口，
	 *  busy 期照排队语义，不打断 turn 机制）。读不到正文 = toast 提示留菜单。
	 *  Tab 不走此路（2026-09-30 拍板）：Tab 填「/skill : 名」可输入形态，提交层解析后殊途同归。 */
	const fireSkill = (name: string): void => {
		const text = app.io.skillInject?.(name);
		if (text === undefined) {
			app.showToast(`技能 "${name}" 正文读取失败——文件可能已被移动或删除（/reload 后重试）`);
			return;
		}
		app.state.overlayOpen = false;
		app.state.overlayCmd = "";
		app.input.submitLine(text);
	};

	return { argPhase, overlayItems, filteredSkills, selToSelectable, onOverlayKey, fireSkill };
}
