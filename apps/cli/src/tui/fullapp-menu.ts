/** fullapp-menu.ts（m5-split-fullapp T7）：斜杠菜单 overlay 键族——纯搬移自 fullapp.ts 类体
 *  （参数阶段/候选清单/技能区过滤/可选行夹取/overlay 键路由/技能注入）。
 *  normCmd/isSubseq 经 fullapp-types import（T2 已出仓）。非公开 API。 */

import { inlineSlashWord, isSubseq, normCmd, OVERLAY_PAGE, slashFilterQ, slashMenuActive, type SlashItem } from "./fullapp-types.ts";
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
		const q = slashFilterQ(app.state.input);
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
		// 中行形态（2026-10-03「消息内容 空格 /」也开菜单）：非行首时取串尾 / 词（trimEnd 与
		// slashMenuActive 的 normCmd 裁尾空白同口径）。行首形态恒 undefined → 下方各路径零改动走旧逻辑
		const inline = normCmd(s.input).startsWith("/") ? undefined : inlineSlashWord(s.input.trimEnd());
		// 循环步进跳过 sep（m4-7 技能分隔行不可选——up/down 回绕也越不过它停上去）
		const step = (from: number, delta: number): number => {
			let i = from;
			do { i = (i + delta + items.length) % items.length; } while (items[i] !== undefined && items[i]!.kind === "sep");
			return i;
		};
		if (key === "escape") {
			if (level2) {
				s.overlayCmd = "";
				// 中行形态退级回串尾 /（前缀保留）；行首形态回裸 /
				s.input = inline !== undefined ? s.input.slice(0, inline.start) + "/" : "/";
				s.cursor = s.input.length;
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
			// Tab 落输入框可编辑，提交层 processReplLine 解析该格式再注入正文）；命令行 Tab 照旧补全命令名。
			// 中行形态 Tab 原地补全（2026-10-03）：前缀保留——「消息 /he」Tab →「消息 /help」
			const sel = items[s.overlaySel];
			if (sel !== undefined) {
				const fill = sel.kind === "skill" ? `/skill : ${sel.key}` : sel.key;
				s.input = inline !== undefined ? s.input.slice(0, inline.start) + fill : fill;
			}
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
				// 技能 Enter = 用户触发（m4-7 T7 / 原型图 1 验收点 4；2026-10-03 起提交「/skill : 名」
				// 等价命令走解析管线）。中行形态（2026-10-03）：提交清了输入 → 消息前缀保留回输入框
				// （submitGate 拦下不清输入则原样不动）
				const draft = inline !== undefined ? s.input.slice(0, inline.start) : undefined;
				fireSkill(row.key);
				if (draft !== undefined && s.input === "") {
					s.input = draft;
					s.cursor = draft.length;
				}
				app.scheduler.requestImmediateRender();
				return;
			}
			const picked = row.key;
			const slash = app.io.slashCommands().find((c) => c.name === picked);
			if (!level2 && slash?.children !== undefined) {
				s.overlayCmd = picked;
				// 中行形态入二级：前缀保留（「消息 /permission」而非裸 /permission——消息草稿不丢）
				s.input = inline !== undefined ? s.input.slice(0, inline.start) + picked : picked;
				s.cursor = s.input.length;
				s.overlaySel = Math.max(0, slash.children.indexOf(app.io.slashCurrent(picked)));
			} else {
				// 带参数输入（/title 新名字）提交原文——裸命令名会丢参数（2026-09-23 实测：/title 改名失效前案，
				// 菜单过滤只认命令词、Enter 只提交 picked）；无参数 = picked（别名转正名）。
				// 中行形态（2026-10-03）：词是串尾、无参数可带（打空格进参数菜单就关）——恒提交 picked
				const typed = normCmd(s.input);
				// 二级组合最先（菜单态驱动）；中行形态次之（串尾词无参数可带，恒 picked）；
				// 行首带参照旧提交原文、裸命令 picked 别名转正
				const cmd = level2 ? `${s.overlayCmd} ${picked}` : inline !== undefined ? picked : typed.includes(" ") ? typed : picked;
				// 提交后消息前缀保留回输入框当草稿（submitGate 拦下时 submitLine 不清输入，
				// 原文「消息 /词」整体保留——判空即闸门是否放行）
				const draft = inline !== undefined ? s.input.slice(0, inline.start) : undefined;
				s.overlayOpen = false;
				s.overlayCmd = "";
				app.input.submitLine(cmd);
				if (draft !== undefined && s.input === "") {
					s.input = draft;
					s.cursor = draft.length;
				}
			}
		} else if (!level2 && (key === "backspace" || (key.length === 1 && isPrintable(key)))) {
				// 长度守卫（keys.ts:243/:296 同款）：键名串（ctrl+a/shift+left 等）首字符可打印，无守卫会
				// 把键名当文本插进输入框（2026-10-03 实测：菜单开着按 Ctrl+A 输入框长出「ctrl+a」六字）
			if (key === "backspace") {
				if (s.cursor > 0) {
					s.input = s.input.slice(0, s.cursor - 1) + s.input.slice(s.cursor);
					s.cursor--;
				}
			} else app.input.inputInsert(key);
			// 重置选中须按敲键后的新清单算（2026-09-30 用户走查：/mc+/p 把命中命令筛光后 sep 占 0 位，
			// 旧实现用敲键前 items 重置 0 落 sep——渲染不跳 sep 焦点整屏隐身，Tab 还吃 sep 空串清空输入框）
			// 2026-10-03 零命中关窗（拍板「写错命令就不该显示菜单」，推翻 2026-09-30 空过滤占位旧纪律）：
			// 敲键后清单空即关——三档过滤单调收窄，往前打只会在空处停住，退格回命中重开，无闪跳。
			// 同日「有空格就关窗」拍板：slashMenuActive 含空白即不成立（空格 = 出了命令词，命令列表不
			// 赖着）；argPhase 例外——声明 completeArg 的命令空格后切参数候选，菜单转参数态不关
			const after = overlayItems();
			if ((slashMenuActive(s.input) || argPhase() !== undefined) && after.length > 0) s.overlaySel = selToSelectable(after, 0);
			else s.overlayOpen = false;
		}
		app.scheduler.requestImmediateRender();
	};

	/** 技能条目 Enter 触发：提交等价命令「/skill : 名」，正文注入/原话行回显/召回旁注全走 processReplLine
	 *  的 /skill 解析管线（m4-7 D3 拍板注入语义不变——走主输入口，busy 期照排队语义）。2026-10-03 用户
	 *  拍板方案 2：旧实现直接 submitLine(skillInject 合成体) → 标记行+<skill> 正文整条进 ↑ 内存历史
	 *  （实测按上键翻出标记行）；改提交命令形态后 ↑ 历史记「/skill : 名」，与 Tab 填形态回车、手敲
	 *  完整形态三路归一。正文读取失败预检退役——解析层同款 notify 兜底。 */
	const fireSkill = (name: string): void => {
		app.state.overlayOpen = false;
		app.state.overlayCmd = "";
		app.input.submitLine(`/skill : ${name}`);
	};

	return { argPhase, overlayItems, filteredSkills, selToSelectable, onOverlayKey };
}
