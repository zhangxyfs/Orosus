/** fullapp-at.ts（m5-at-menu T1 纯函数层 + T2 键族）：@ 文件选择菜单。
 *  词判定（D1/D15）：原串扫描全部 @ 词（负向后顾边界——@ 在行首或前一字符非路径合法字符即词起点，
 *  中文紧贴 `看下@sr` 命中、邮箱 `foo@bar` 不命中），光标落在词区间 [start, start+词长]（含两端）即命中，
 *  串尾词是光标在串尾时的特例；斜杠命令形态整条排除（与斜杠菜单互斥的判定地基）。
 *  键族结构照抄 fullapp-menu.ts createMenu——两族代码长得一样、读一处懂两处。非公开 API。 */

import { isSubseq, normCmd, OVERLAY_PAGE } from "./fullapp-types.ts";
import { isPrintable } from "./keymatch.ts";
import type { FullApp } from "./fullapp.ts";

/** @ 文件菜单条目（宿主经 io.atMenuEntries 供给——tui 家族无 fs 纪律，渲染与键族只消费）。 */
export interface AtEntry {
	name: string;
	dir: boolean;
}

/** @ 边界字符集（单一事实源，设计空白 6）：@ 前一字符属于此集 = @ 不算引用起点（邮箱 foo@bar 的
 *  @ 前是 o）。T4 发送侧 atfile.ts 的边界放宽改 import 此源——菜单触发与发送解析两侧永不漂移；
 *  要动这个集合 = 两侧同动 + atfile 全测重跑。放本件（而非 atfile.ts）导出的理由：tui 家族
 *  保持无 fs（atfile.ts 顶部 import node:fs，tui 件 import 它会把 fs 拉进模块图——方向反转，
 *  atfile → tui 单向依赖，apps 层内跨目录 import 有先例）。 */
export const AT_PATH_BOUNDARY_SRC = "A-Za-z0-9_\\-./\\\\~";

/** 光标处 @ 词解析：命中返回词起点（含 @、原串原生坐标——词区间替换直接可用，不吃正文中段同串）、
 *  path（词内最后一个 / 之前的部分，无 / = 空串即根目录）、filter（最后一个 / 之后的部分）。
 *  不命中（光标不在任何词区间 / 所在词 @ 前是路径合法字符 / 斜杠命令形态）返回 undefined——
 *  光标在词后空格之后天然不命中（词区间只到词尾含端点）。cursor 按调用点传实（state.cursor 原串偏移；
 *  召回三分支的光标落位各不相同——队列/下翻串尾、历史上翻串首）。 */
export function atWordAt(input: string, cursor: number): { start: number; path: string; filter: string } | undefined {
	if (normCmd(input).startsWith("/")) return undefined; // 斜杠命令形态整条排除（互斥地基）
	for (const m of input.matchAll(new RegExp(`(?<![${AT_PATH_BOUNDARY_SRC}])@([^#\\s]*)`, "g"))) {
		const start = m.index!;
		if (cursor >= start && cursor <= start + m[0].length) {
			const word = m[0].slice(1); // 去 @
			const slash = word.lastIndexOf("/");
			return { start, path: slash === -1 ? "" : word.slice(0, slash), filter: slash === -1 ? word : word.slice(slash + 1) };
		}
	}
	return undefined;
}

/** 条目过滤 + 排序成型：三档命中（前缀排前、含字居中、子序列殿后——isSubseq 与斜杠菜单三档同口径、
 *  忽略大小写）组内维持传入序；目录组整体排在文件组前（D6）。空过滤全显（D5——含点文件与
 *  node_modules，按字面全显）。 */
export function filterEntries(entries: AtEntry[], filter: string): AtEntry[] {
	if (filter === "") return [...entries.filter((e) => e.dir), ...entries.filter((e) => !e.dir)];
	const q = filter.toLowerCase();
	const byTier = (dir: boolean): AtEntry[] => {
		const hits: AtEntry[] = [];
		const more: AtEntry[] = [];
		const fuzzy: AtEntry[] = [];
		for (const e of entries) {
			if (e.dir !== dir) continue;
			const n = e.name.toLowerCase();
			if (n.startsWith(q)) hits.push(e);
			else if (n.includes(q)) more.push(e);
			else if (isSubseq(q, n)) fuzzy.push(e);
		}
		return [...hits, ...more, ...fuzzy];
	};
	return [...byTier(true), ...byTier(false)];
}

/** @ 菜单键族（T2——结构照抄 fullapp-menu createMenu 的 onOverlayKey）。
 *  词替换一律用 atWordAt 返回的 start 做区间替换、不用字符串 replace（CR-03 教训：replace 吃
 *  首次出现会啃错位——正文中段同串场景致命）。 */
export function createAt(app: FullApp) {
	/** 词长（从 atWordAt 重组——word = path + "/" + filter 无损）：start + 词长 = 词区间右端。 */
	const wordLen = (w: { path: string; filter: string }): number => 1 + (w.path === "" ? 0 : w.path.length + 1) + w.filter.length;

	/** 词区间替换：[w.start, w.start+词长) 换 replacement，光标落替换尾。 */
	const replaceWord = (w: { start: number; path: string; filter: string }, replacement: string): void => {
		const s = app.state;
		s.input = s.input.slice(0, w.start) + replacement + s.input.slice(w.start + wordLen(w));
		s.cursor = w.start + replacement.length;
	};

	/** 导航点现读（目录变了才读）：宿主未供/读失败 → 空 entries（miss 标志透传——渲染层分
	 *  「目录不存在」与「（空目录）」两则空态文案）。 */
	const readDir = (dir: string): { entries: AtEntry[]; miss?: boolean } => app.io.atMenuEntries?.(dir) ?? { entries: [] };

	/** 编辑落定重判（自编辑后/开菜单共用）：现算光标处词 → 命中则目录变了才现读 + sel 夹回 + 更新
	 *  词快照；失中关菜单。返回是否命中。 */
	const refreshFromWord = (): boolean => {
		const s = app.state;
		const am = s.atMenu;
		const w = atWordAt(s.input, s.cursor);
		if (w === undefined || am === undefined) {
			s.atMenu = undefined;
			return false;
		}
		if (w.path !== am.dir) {
			const d = readDir(w.path);
			s.atMenu = { dir: w.path, entries: d.entries, sel: 0, start: w.start, filter: w.filter, ...(d.miss ? { miss: true } : {}) };
		} else {
			const n = filterEntries(am.entries, w.filter).length;
			am.start = w.start;
			am.filter = w.filter;
			am.sel = Math.max(0, Math.min(n - 1, am.sel));
		}
		return true;
	};

	const onAtKey = (key: string): void => {
		const s = app.state;
		const am = s.atMenu;
		if (am === undefined) return;
		// 纯光标移动穿透（D15/kimi moveCursor 同款）：不触发不关、内容静止（词快照不追光标）——
		// onEditKey 内 afterEdit 已请求渲染；下次编辑动作落定时经 refreshFromWord 重判刷新或关
		if (key === "left" || key === "right" || key === "home" || key === "end") {
			app.input.onEditKey(key);
			return;
		}
		const items = filterEntries(am.entries, am.filter);
		if (key === "escape") {
			const w = atWordAt(s.input, s.cursor);
			if (w !== undefined && w.path.includes("/")) {
				// 词内有多级：截到上一级（@src/tui/ → @src/）+ 目录跟着回退
				const up = w.path.slice(0, w.path.lastIndexOf("/"));
				replaceWord(w, `@${up}/`);
				const d = readDir(up);
				s.atMenu = { dir: up, entries: d.entries, sel: 0, start: w.start, filter: "", ...(d.miss ? { miss: true } : {}) };
			} else {
				s.atMenu = undefined; // 根上（词内无 /）或光标处词失中——输入框文本与光标保留
			}
		} else if (key === "up" && items.length > 0) {
			am.sel = (am.sel - 1 + items.length) % items.length;
		} else if (key === "down" && items.length > 0) {
			am.sel = (am.sel + 1) % items.length;
		} else if (key === "pageUp" && items.length > 0) {
			am.sel = Math.max(0, am.sel - OVERLAY_PAGE);
		} else if (key === "pageDown" && items.length > 0) {
			am.sel = Math.min(items.length - 1, am.sel + OVERLAY_PAGE);
		} else if (key === "enter" || key === "tab") {
			// Tab 与 Enter 两分支同款（D9：Tab = 补全链 / Enter = 选定——v1 不分化，实现共用）
			// 按键当刻现算活词（kimi applyCompletion 防 stale 前缀同款）：失中无动作不误替换
			const w = atWordAt(s.input, s.cursor);
			const picked = w === undefined ? undefined : items[Math.max(0, Math.min(items.length - 1, am.sel))];
			if (w === undefined || picked === undefined) {
				app.scheduler.requestImmediateRender();
				return;
			}
			const joined = w.path === "" ? picked.name : `${w.path}/${picked.name}`;
			if (picked.dir) {
				replaceWord(w, `@${joined}/`); // 目录：补全即钻入 + 现读续显（可连按逐级补到文件）
				const d = readDir(joined);
				s.atMenu = { dir: joined, entries: d.entries, sel: 0, start: w.start, filter: "", ...(d.miss ? { miss: true } : {}) };
			} else {
				replaceWord(w, `@${joined} `); // 文件：路径 + 空格（显式词边界，设计空白 5）+ 关（光标在空格后已不在词上）
				s.atMenu = undefined;
			}
		} else if (key === "backspace" || (key.length === 1 && isPrintable(key))) {
			// 键族内自编辑（照 fullapp-menu onOverlayKey 同款；长度守卫防键名串插字）
			if (key === "backspace") {
				if (s.cursor > 0) {
					s.input = s.input.slice(0, s.cursor - 1) + s.input.slice(s.cursor);
					s.cursor--;
				}
			} else app.input.inputInsert(key);
			// 编辑落定以新光标位重判：命中 → 目录变了才现读 + sel 夹回 + 更新快照；失中 → 关
			refreshFromWord();
		}
		app.scheduler.requestImmediateRender();
	};

	return { onAtKey };
}
