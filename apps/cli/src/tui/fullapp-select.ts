/** fullapp-select.ts（m5-split-fullapp T5）：鼠标选区与剪贴板/链接——纯搬移自 fullapp.ts 类体。
 *  与滚动族（fullapp-mouse.ts）在原类体交错，成员级锚定摘取；selectionGuard/clearStreamSelection
 *  触达 stopAutoScroll（滚动族）经 app.stopAutoScroll（T6 搬出后改经 mouse 子系统）。非公开 API。 */

import { sliceByColumn, stripAnsi, visibleWidth } from "./width.ts";
import { DOUBLE_CLICK_INTERVAL_MS, wordRangeAt } from "./fullapp-types.ts";
import { writeClipboardText, openUrl } from "../paste.ts";
import * as theme from "../theme.ts";
import type { FullApp } from "./fullapp.ts";

export function createSelect(app: FullApp) {
	/** 扩选到指针点（T9 提取——drag 分支与自动滚脉冲共用）：越界按 scope 钳边界（clampedSelPoint）
	 *  + 粒度感知（T6 逻辑原样：词/行粒度 focus 对齐区间、反侧锚点切换）。 */
	const extendSelection = (x: number, y: number): void => {
		const s = app.state;
		const p = clampedSelPoint(x, y);
		if (p === undefined) return;
		const initial = s.selInitialRange;
		if (s.selGranularity !== "character" && initial !== undefined) {
			const before = p.docIdx < initial.start.docIdx || (p.docIdx === initial.start.docIdx && p.col < initial.start.col);
			const anchor = { scope: p.scope, docIdx: before ? initial.end.docIdx : initial.start.docIdx, col: before ? initial.end.col : initial.start.col };
			if (s.selGranularity === "word") {
				const plain = stripAnsi(selLineText(p.scope, p.docIdx));
				const r = wordRangeAt(plain, p.col) ?? { start: p.col, end: p.col };
				s.mselAnchor = anchor;
				s.mselFocus = { scope: p.scope, docIdx: p.docIdx, col: before ? r.start : r.end };
			} else {
				const lineEnd = visibleWidth(stripAnsi(selLineText(p.scope, p.docIdx)));
				s.mselAnchor = anchor;
				s.mselFocus = { scope: p.scope, docIdx: p.docIdx, col: before ? 0 : lineEnd };
			}
		} else {
			s.mselFocus = p;
		}
	};

	/** 拖动点钳制（T8）：按当前选区 scope 钳在对应窗口边界——view 钳查看窗盒、main 钳主流区。 */
	const clampedSelPoint = (x: number, y: number): { scope: "main" | "view"; docIdx: number; col: number } | undefined => {
		if (app.state.mselAnchor?.scope === "view") {
			const pu = app.pendingUi;
			if (pu?.kind !== "view") return undefined;
			const geo = app.dialogs.viewGeo(pu.layout);
			const cx = Math.max(geo.col, Math.min(geo.col + geo.width - 1, x));
			const cy = Math.max(geo.row + 1, Math.min(geo.row + geo.height - 1, y)); // 顶框让位
			return (() => { const p = pointToView(cx, cy); return p === undefined ? undefined : { scope: "view" as const, ...p }; })();
		}
		const { streamH, leftW } = app.layoutFrame();
		const p = pointToDoc(Math.min(x, leftW - 1), Math.max(0, Math.min(streamH - 1, y)));
		return p === undefined ? undefined : { scope: "main", ...p };
	};

	/** 选区行文本（T8 scope 感知）：main → doc（含 tailLine）；view → pu.lines。
	 *  窗口化（T5）：doc 是窗口局部数组——全局下标 − start 取局部（窗口外回退空串）。 */
	const selLineText = (scope: "main" | "view", idx: number): string => {
		if (scope === "view") {
			const pu = app.pendingUi;
			return pu?.kind === "view" ? (pu.lines[idx] ?? "") : "";
		}
		const { start, doc } = app.layoutFrame();
		return doc[idx - start] ?? "";
	};

	/** 指针 → 查看窗内容行列（T8）：viewGeo 盒内才命中；行索引随渲染 sc 同源（滚动平移天然稳定）；
	 *  盒内衬 = │ + 空格共 2 列。 */
	const pointToView = (x: number, y: number): { docIdx: number; col: number } | undefined => {
		const pu = app.pendingUi;
		if (pu?.kind !== "view") return undefined;
		const geo = app.dialogs.viewGeo(pu.layout);
		if (y < geo.row || y >= geo.row + geo.height || x < geo.col || x >= geo.col + geo.width) return undefined;
		const page = Math.max(3, geo.height - 3);
		pu.viewPage = page; // 渲染期回写——翻页/滚轮页大小与窗几何同源（dock 不走 viewGeo，m4-7 走查修）
		const maxScroll = Math.max(0, pu.lines.length - page);
		const sc = pu.pinned === true ? maxScroll : Math.max(0, Math.min(maxScroll, pu.scroll));
		const row = y - geo.row - 1; // 顶框占 1 行
		if (row < 0 || row >= page) return undefined;
		const idx = sc + row;
		if (idx >= pu.lines.length) return undefined;
		return { docIdx: idx, col: Math.max(0, x - geo.col - 2) };
	};

	/** 连击计数（T6——kimi getClickCount :1233-1257）：500ms 窗口内 + 同行 + 同词边界才 +1
	 *  （1→2→3 循环）；点到空白/流区外连击不记。 */
	const clickCount = (point: { docIdx: number; col: number } | undefined, word: { start: number; end: number } | undefined): number => {
		const s = app.state;
		const lc = s.lastClick;
		const now = Date.now();
		if (point !== undefined && word !== undefined && lc !== undefined
			&& now - lc.at <= DOUBLE_CLICK_INTERVAL_MS
			&& lc.docIdx === point.docIdx
			&& lc.wordStart === word.start && lc.wordEnd === word.end) {
			const count = (lc.count % 3) + 1;
			s.lastClick = { at: now, count, docIdx: point.docIdx, wordStart: word.start, wordEnd: word.end };
			return count;
		}
		s.lastClick = point !== undefined && word !== undefined
			? { at: now, count: 1, docIdx: point.docIdx, wordStart: word.start, wordEnd: word.end }
			: undefined; // 空白/流区外——连击状态清空
		return 1;
	};

	/** 指针屏坐标 → doc 行列（T5——与 renderFrame 同源几何 layoutFrame；左内衬 2 列）。 */
	const pointToDoc = (x: number, y: number): { docIdx: number; col: number } | undefined => {
		const { streamH, start, dmTotal, leftW } = app.layoutFrame();
		if (y < 0 || y >= streamH) return undefined; // 流区外（输入框/队列区）→ 不选
		if (x >= leftW) return undefined; // 右侧面板与流区同 y 段，按 x 排除（侧栏按下 = 清选区不建幻影锚点）
		const idx = start + y;
		if (idx >= dmTotal) return undefined;
		return { docIdx: idx, col: Math.max(0, x - 2) };
	};

	/** 选区端点排序（anchor/focus → lo/hi）。 */
	const mselRange = (): { lo: { scope: "main" | "view"; docIdx: number; col: number }; hi: { scope: "main" | "view"; docIdx: number; col: number } } | undefined => {
		const { mselAnchor: a, mselFocus: f } = app.state;
		if (a === undefined || f === undefined) return undefined;
		if (a.docIdx < f.docIdx || (a.docIdx === f.docIdx && a.col <= f.col)) return { lo: a, hi: f };
		return { lo: f, hi: a };
	};

	/** 选区纯文本提取（kimi getActiveSelectionText :1432-1454 同构）：逐行 sliceByColumn（ANSI 感知）
	 *  + stripAnsi + trimEnd；行源按 scope（T8：view → pu.lines、main → doc）；空选区/全空白 → undefined。 */
	const selectionText = (): string | undefined => {
		const r = mselRange();
		if (r === undefined) return undefined;
		const lines: string[] = [];
		for (let i = r.lo.docIdx; i <= r.hi.docIdx; i++) {
			const line = selLineText(r.lo.scope, i);
			const startCol = i === r.lo.docIdx ? r.lo.col : 0;
			const endCol = i === r.hi.docIdx ? r.hi.col : visibleWidth(line);
			lines.push(stripAnsi(sliceByColumn(line, startCol, Math.max(0, endCol - startCol))).trimEnd());
		}
		const text = lines.join("\n");
		return text.trim() === "" ? undefined : text;
	};

	/** 渲染行按选区反白（T5——theme.inverse 与输入框选区 styleWithSelection 同手法；
	 *  入参是已带内衬的渲染行，列区间 +2 对齐；scope 匹配才作用〔T8——主窗/查看窗各自渲染〕）。 */
	const styleDocSelection = (scope: "main" | "view", docIdx: number, renderedLine: string): string => {
		const r = mselRange();
		if (r === undefined || r.lo.scope !== scope) return renderedLine;
		if (docIdx < r.lo.docIdx || docIdx > r.hi.docIdx) return renderedLine;
		const lineStart = docIdx === r.lo.docIdx ? r.lo.col + 2 : 0;
		const lineEnd = docIdx === r.hi.docIdx ? r.hi.col + 2 : visibleWidth(renderedLine);
		if (lineEnd <= lineStart) return renderedLine;
		const left = sliceByColumn(renderedLine, 0, lineStart);
		const mid = sliceByColumn(renderedLine, lineStart, lineEnd - lineStart);
		const right = sliceByColumn(renderedLine, lineEnd, Math.max(0, visibleWidth(renderedLine) - lineEnd));
		return left + theme.inverse(mid) + right;
	};

	/** 选区一致性守卫（T8）：scope=view 的选区只在查看窗在位时有效——窗关闭首帧即整组清空
	 *  （防行索引残留误映射下一窗内容）；并同步停自动滚（T9——否则拖着选区关窗后 50ms 脉冲
	 *  继续跑、按主窗几何对空气重映射）。 */
	const selectionGuard = (): void => {
		const s = app.state;
		if ((s.mselAnchor?.scope ?? s.mselFocus?.scope) === "view" && app.pendingUi?.kind !== "view") {
			s.mselAnchor = undefined;
			s.mselFocus = undefined;
			app.mouse.stopAutoScroll();
		}
	};

	/** 选区复制结算（决策点 8）：真剪贴板优先（paste.ts 三平台），失败落 OSC 52 逃生口再提示。 */
	const copySelection = (text: string): Promise<void> => {
		return writeClipboardSettle(text, `已复制 ${text.split("\n").length} 行`);
	};

	/** 剪贴板写入结算（真剪贴板优先，失败落 OSC 52 逃生口再提示）——拖选松开（m5 T5）与
	 *  输入框 Ctrl+C（2026-09-30）共用同一条降级路。 */
	const writeClipboardSettle = async (text: string, okMsg: string): Promise<void> => {
		const write = app.io.writeClipboard ?? writeClipboardText;
		const ok = await write(text);
		if (ok) {
			app.showToast(okMsg);
		} else {
			app.term.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
			app.showToast("已发终端复制口令（系统剪贴板未确认）");
		}
	};

	/** 键盘选区与拖选选区互斥（2026-09-30 拍板：任一时刻屏幕最多一块高亮）：输入框键盘选区诞生
	 *  （Ctrl+A / Shift+←→ 首拍）即清对话流拖选残留高亮——Ctrl+C 复制的永远是「看到的那块」。 */
	const clearStreamSelection = (): void => {
		const s = app.state;
		if (s.mselAnchor === undefined && s.mselFocus === undefined) return;
		s.mselAnchor = undefined;
		s.mselFocus = undefined;
		app.mouse.stopAutoScroll();
	};

	/** 打开链接（T7 决策点 17）：只开 http/https——链接文本来自模型输出，file:// 等方案
	 *  拒开是注入面防线；toast 文案族（设计空白 6）。 */
	const openLink = async (url: string): Promise<void> => {
		if (!/^https?:\/\//i.test(url)) {
			app.showToast("仅支持打开 http/https 链接");
			return;
		}
		const open = app.io.openUrl ?? openUrl;
		const ok = await open(url);
		app.showToast(ok ? "已打开链接" : "打开链接失败");
	};

	return { extendSelection, clampedSelPoint, selLineText, pointToView, clickCount, pointToDoc, mselRange, selectionText, styleDocSelection, selectionGuard, copySelection, writeClipboardSettle, clearStreamSelection, openLink };
}
