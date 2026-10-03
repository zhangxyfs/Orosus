/** fullapp-input.ts（m5-split-fullapp T8）：输入框编辑/历史/提交——纯搬移自 fullapp.ts 类体。
 *  公开三件（insertAtCursor/restoreInput/seedHistory）壳留薄委托；lastEscCancel 字段留守壳
 *  （唯一消费者是 onKey 键路 T9，经降级字段触达）。非公开 API。 */

import { indexAtRowCol, INPUT_MAX_ROWS, isSubseq, layoutInputRows, locateCursor, normCmd, slashFilterQ, slashMenuActive, type SlashItem } from "./fullapp-types.ts";
import { isPrintable } from "./keymatch.ts";
import type { FullApp } from "./fullapp.ts";

export function createInput(app: FullApp) {
	/** 文本插入输入框光标位（2026-09-23 走查拍板——图片 chip [image #N (宽×高)] 从独立 chip 行
	 *  改为文内 token：光标处插入、删除键可删 = 撤销挂图）。 */
	const insertAtCursor = (text: string): void => {
		const s = app.state;
		exitHistoryBrowse(); // 贴图 = 编辑（kimi exitHistoryBrowsing 同语义）
		s.input = s.input.slice(0, s.cursor) + text + s.input.slice(s.cursor);
		s.cursor += text.length; // chip 为 ASCII+×（BMP）——码元步进安全
		s.selAnchor = -1;
		afterEdit();
	};

	/** 提交被拒（如非 vision 模型拦截）时恢复输入原文（含图片 chip token——挂图不丢）。 */
	const restoreInput = (text: string): void => {
		const s = app.state;
		s.input = text;
		s.cursor = text.length;
		s.selAnchor = -1;
		afterEdit();
	};

	/** 输入历史播种（2026-09-23 实测：/sessions 恢复后 FullApp 随会话重建、输入历史清零——
	 *  ↑ 无历史可召回前案）：宿主从会话事件取用户消息文本灌入（kimi 按 cwd 持久化历史的同族口径），
	 *  帽 100 条（kimi 同值）。 */
	const seedHistory = (items: string[]): void => {
		const s = app.state;
		s.history = items.slice(-100);
		s.historyIdx = s.history.length;
		s.historyDraft = undefined;
	};

	const selRange = (): { lo: number; hi: number } | undefined => {
		const s = app.state;
		if (s.selAnchor < 0 || s.selAnchor === s.cursor) return undefined;
		return { lo: Math.min(s.selAnchor, s.cursor), hi: Math.max(s.selAnchor, s.cursor) };
	};

	const deleteSelection = (): boolean => {
		const s = app.state;
		const r = selRange();
		if (!r) return false;
		s.input = s.input.slice(0, r.lo) + s.input.slice(r.hi);
		s.cursor = r.lo;
		s.selAnchor = -1;
		return true;
	};

	/** 编辑即退出历史浏览（kimi exitHistoryBrowsing——浏览中改动的是召回条目本身，草稿快照作废）。 */
	const exitHistoryBrowse = (): void => {
		const s = app.state;
		s.historyIdx = s.history.length;
		s.historyDraft = undefined;
	};

	const inputInsert = (text: string): void => {
		const s = app.state;
		exitHistoryBrowse(); // 编辑即退出历史浏览、丢弃草稿快照（kimi exitHistoryBrowsing 同语义）
		const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		deleteSelection();
		s.input = s.input.slice(0, s.cursor) + norm + s.input.slice(s.cursor);
		s.cursor += norm.length;
	};

	const moveCursor = (dir: -1 | 1, extend: boolean): void => {
		const s = app.state;
		if (extend && s.selAnchor < 0) {
			s.selAnchor = s.cursor;
			app.select.clearStreamSelection(); // 键盘选区诞生清拖选高亮（2026-09-30 拍板，与 Ctrl+A 同规则）
		}
		if (!extend) {
			const r = selRange();
			if (r) {
				s.cursor = dir === -1 ? r.lo : r.hi;
				s.selAnchor = -1;
				return;
			}
		}
		if (dir === -1 && s.cursor > 0) {
			const prev = s.input.codePointAt(s.cursor - 1)!;
			s.cursor -= prev >= 0xdc00 && prev <= 0xdfff && s.cursor > 1 ? 2 : 1;
		} else if (dir === 1 && s.cursor < s.input.length) {
			const cp = s.input.codePointAt(s.cursor)!;
			s.cursor += cp > 0xffff ? 2 : 1;
		}
	};

	const afterEdit = (): void => {
		const s = app.state;
		const rows = layoutInputRows(s.input, app.panels.inputInnerW());
		const cur = locateCursor(rows, s.cursor);
		if (cur.row < s.inputScroll) s.inputScroll = cur.row;
		if (cur.row >= s.inputScroll + INPUT_MAX_ROWS) s.inputScroll = cur.row - INPUT_MAX_ROWS + 1;
		app.scheduler.requestImmediateRender();
	};

	/** 输入框键盘选区复制（2026-09-30 用户拍板）：Ctrl+C 只在「输入框有高亮选区」时消费——
	 *  WT 自有鼠标选区时会先截走 Ctrl+C、\x03 不到达应用，两层天然互斥、不抢 WT 原生复制；
	 *  无选区维持吞键现状（退出走 /quit、停生成双击 Esc 的 2026-09-23 拍板不动）。 */
	const copyInputSelection = async (): Promise<void> => {
		const r = selRange();
		if (r === undefined) return;
		const text = app.state.input.slice(r.lo, r.hi);
		await app.select.writeClipboardSettle(text, `已复制输入框 ${[...text].length} 字`);
	};

	/** 菜单（重）开闸（F5 十五轮② + 2026-10-03 两扩展）：Esc 关掉后继续编辑命令词要能重开；
	 *  中行「消息内容 空格 /」串尾词同开（slashMenuActive 统一口径）；零命中（写错命令）不开——
	 *  开 ⇔ 形态成立且清单非空，与 menu 敲键侧同一条规矩两端口。只挂内容变更键（打印字符/
	 *  退格/前删），光标移动不挂——Esc 关闭后左右移动不得擅自重开。2026-10-03 空格关窗拍板后
	 *  行首/中行含空白都不算形态成立；argPhase 例外同挂——声明 completeArg 的命令打空格即进参数候选。 */
	const menuReopenCheck = (): void => {
		const s = app.state;
		if (!s.overlayOpen && (slashMenuActive(s.input) || app.menu.argPhase() !== undefined) && app.menu.overlayItems().length > 0) {
			s.overlayOpen = true;
			s.overlaySel = 0;
			s.overlayCmd = "";
		}
	};

	const onEditKey = (key: string): void => {
		const s = app.state;
		switch (key) {
			case "enter":
				if (normCmd(s.input) !== "") submitLine(normCmd(s.input));
				break;
			case "alt+enter":
			case "shift+enter": // Shift+Enter = 换行（2026-09-27 用户拍板；keymatch 两形态：裸 LF / CSI-u）
				inputInsert("\n");
				break;
			case "ctrl+c": // 2026-09-30 用户拍板：输入框键盘选区复制；无选区吞键维持现状（WT 原生复制让位不动）
				void copyInputSelection();
				break;
			case "ctrl+a":
				s.selAnchor = 0;
				s.cursor = s.input.length;
				app.select.clearStreamSelection(); // 键盘选区诞生清拖选高亮（2026-09-30 拍板：屏幕最多一块高亮）
				break;
			case "shift+left":
				moveCursor(-1, true);
				break;
			case "shift+right":
				moveCursor(1, true);
				break;
			case "backspace":
				exitHistoryBrowse();
				if (!deleteSelection() && s.cursor > 0) {
					// CTU-02 修复（2026-09-28 code review）：光标前一位（cursor-1）落在代理对的低代理
					// （0xdc00–0xdfff）且再前一位是高代理 → 整对删除。原判定区间写反（按高代理
					// 0xd800–0xdbff 判），emoji 退格一次只删低代理、残留孤立高代理——对齐 moveCursor 的写法
					const cp = s.input.codePointAt(s.cursor - 1)!;
					const prev2 = s.input.charCodeAt(s.cursor - 2);
					const w = cp >= 0xdc00 && cp <= 0xdfff && prev2 >= 0xd800 && prev2 <= 0xdbff ? 2 : 1;
					s.input = s.input.slice(0, s.cursor - w) + s.input.slice(s.cursor);
					s.cursor -= w;
				}
				menuReopenCheck(); // 退格回命中要重开（零命中关窗后改错的主路径——只认打印字符会漏）
				break;
			case "delete":
				exitHistoryBrowse();
				if (!deleteSelection() && s.cursor < s.input.length) {
					const cp = s.input.codePointAt(s.cursor)!;
					s.input = s.input.slice(0, s.cursor) + s.input.slice(s.cursor + (cp > 0xffff ? 2 : 1));
				}
				menuReopenCheck();
				break;
			case "left":
				moveCursor(-1, false);
				break;
			case "right":
				moveCursor(1, false);
				break;
			case "home":
				s.selAnchor = -1;
				s.cursor = 0;
				break;
			case "end":
				s.selAnchor = -1;
				s.cursor = s.input.length;
				break;
			case "up":
			case "down": {
				// ↑/↓ 历史导航（2026-09-23 走查拍板，照抄 kimi pi-tui editor.ts:1027-1052 语义）：
				// 非首/末视觉行 → 行内移动；首行非起始点 → 先回行首；起始点再 ↑ 才召回历史；
				// 进入浏览快照草稿，↓ 翻回最新位草稿原样恢复；上翻光标置首（可连按续翻）、下翻置末
				s.selAnchor = -1;
				const rows = layoutInputRows(s.input, app.panels.inputInnerW());
				const cur = locateCursor(rows, s.cursor);
				const browsing = s.historyIdx < s.history.length;
				if (key === "up") {
					if (cur.row > 0) {
						s.cursor = indexAtRowCol(rows, cur.row - 1, cur.col);
					} else if (s.cursor !== 0) {
						s.cursor = 0; // 首行非起始 → 先回起始点（kimi moveToLineStart）
					} else if (s.input === "" && app.io.queueItems().length > 0) {
						// 空输入 + 队列非空 → 召回队尾（LIFO，kimi onUpArrowEmpty 优先于历史导航同口径）
						const q = app.io.recallQueued();
						if (q !== undefined) {
							s.input = q;
							s.cursor = q.length;
						}
					} else if (s.historyIdx > 0) {
						if (!browsing) s.historyDraft = s.input; // 进入浏览那一刻快照草稿
						s.historyIdx--;
						s.input = s.history[s.historyIdx]!;
						s.cursor = 0; // 上翻光标放开头——多行历史条目上连按 ↑ 即续翻（kimi setTextInternal "start"）
						s.inputScroll = 0;
					}
				} else if (browsing && cur.row === rows.length - 1) {
					s.historyIdx++;
					if (s.historyIdx === s.history.length) {
						s.input = s.historyDraft ?? ""; // 回到草稿位——草稿原样恢复
						s.historyDraft = undefined;
					} else {
						s.input = s.history[s.historyIdx]!;
					}
					s.cursor = s.input.length; // 下翻/回草稿光标放末尾（kimi "end"）
					s.inputScroll = 0;
				} else if (cur.row < rows.length - 1) {
					s.cursor = indexAtRowCol(rows, cur.row + 1, cur.col);
				} else {
					s.cursor = s.input.length; // 末行非浏览 → 跳行尾（kimi moveToLineEnd）
				}
				break;
			}
			default:
				if (isPrintable(key)) {
					inputInsert(key);
					menuReopenCheck();
				}
		}
		afterEdit();
	};

	const submitLine = (text: string): void => {
		const s = app.state;
		// 提交闸门（批④——busy 期拒收档拦在回车前）：拦下则输入框原文保留、不进历史、不写流区、不提交，
		// 拒因尾行瞬显自消；回答结束后原文还在，直接再按回车即发
		const gated = app.io.submitGate?.(text);
		if (gated !== undefined) {
			app.showToast(gated); // 拒因走浮动 toast（输入框上边缘黄字 3s 自消——原尾行位退役）
			return;
		}
		s.scrollBack = 0; // 回看历史时提交 → 跳到底部（F5 五轮②：一次性置底，非粘底）
		s.history.push(text);
		s.historyIdx = s.history.length;
		s.historyDraft = undefined;
		s.input = "";
		s.cursor = 0;
		s.inputScroll = 0;
		s.selAnchor = -1;
		app.io.submit(text);
	};

	const filteredCommands = (): SlashItem[] => {
		// 命令词忽略大小写（2026-09-27 用户走查拍板）：/He /HELP 都能筛出 /help——q 与命令名/别名
		// 统一小写比较；Enter 提交菜单真名（picked），不带过滤串的大小写进输入。
		// q 取词 2026-10-03 换 slashFilterQ：行首首词（旧口径）+ 中行串尾 / 词两形态一源
		const q = slashFilterQ(app.state.input);
		// 别名可筛（F5 十六轮①：/exit /q /rename /resume 都能过滤出真实命令——Enter 提交真名）
		// 前缀命中排前、含字命中居中、子序列命中殿后（2026-09-24 拍板两档 + 2026-09-30 第三档：
		// /ol 先列 ol 开头，再列含 ol 的 /yolo，末列字符按序散见的）——组内保持注册序
		const hits: SlashItem[] = [];
		const more: SlashItem[] = [];
		const fuzzy: SlashItem[] = [];
		for (const c of app.io.slashCommands()) {
			const lowerName = c.name.toLowerCase();
			const aliases = (c.aliases ?? []).map((a) => a.toLowerCase());
			if (lowerName.startsWith("/" + q) || aliases.some((a) => a.startsWith(q))) hits.push(c);
			else if (lowerName.slice(1).includes(q) || aliases.some((a) => a.includes(q))) more.push(c);
			else if (isSubseq(q, lowerName.slice(1)) || aliases.some((a) => isSubseq(q, a))) fuzzy.push(c);
		}
		return [...hits, ...more, ...fuzzy];
	};

	return { insertAtCursor, restoreInput, seedHistory, selRange, deleteSelection, exitHistoryBrowse, inputInsert, moveCursor, afterEdit, copyInputSelection, onEditKey, submitLine, filteredCommands };
}
