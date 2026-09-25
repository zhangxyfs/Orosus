/** 只读控件渲染器 v1（m5 T6，口子二/三共用）：WidgetSpec 清单 → 面板内容行（不含外框——外框归
 *  panelBox / 控件窗窗体）。画法全部是现成段的提纯：text/kv 照状态卡行配色、sep 照面板分隔线、
 *  list 照工具行灰点、progress 照上下文占用条（█░ + 分数块）。
 *  铁律：模块给数据不给画面——文字不许夹终端控制码，宿主按看得见的宽度折行/截断（全局约束 1）。
 *  活值字段（text/value 为函数）渲染期现读；抛错由调用方（卡片 = 当帧占位/剔除）兜底。 */

import type { WidgetSpec } from "@orosus/contracts/module";
import * as theme from "../theme.ts";
import { padToWidth, truncateToWidth, wrapText } from "./width.ts";

const resolveText = (v: string | (() => string)): string => (typeof v === "function" ? v() : v);
const resolveNum = (v: number | (() => number)): number => (typeof v === "function" ? v() : v);

const FRACS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** 控件窗的交互态（m5 T7/T8）：每个 interactive list 的选中 index、
 *  每个 input 的文本/光标 + 当前焦点控件 id。 */
export interface WidgetRenderState {
	selById?: Record<string, number>;
	inputById?: Record<string, { text: string; cursor: number }>;
	focusedId?: string;
}

/** 交互列表的行位（选中项跟随滚动用）：第 i 项在第 baseLine + i 行。 */
export interface WidgetListPos {
	id: string;
	baseLine: number;
	count: number;
}

/** 控件清单 → 行 + 交互列表行位（窗体滚动跟随选中项）。w = 可用内容宽（不含边框）。 */
export function renderWidgetLines(
	widgets: readonly WidgetSpec[],
	w: number,
	st?: WidgetRenderState,
): { lines: string[]; lists: WidgetListPos[] } {
	const lines: string[] = [];
	const lists: WidgetListPos[] = [];
	for (const wd of widgets) {
		switch (wd.kind) {
			case "list": {
				if (wd.interactive === true && wd.items.length > 0) {
					const focused = st?.focusedId === wd.id;
					const sel = st?.selById?.[wd.id] ?? 0;
					lists.push({ id: wd.id, baseLine: lines.length, count: wd.items.length });
					for (let i = 0; i < wd.items.length; i++) {
						const mark = i === sel ? (focused ? theme.fg("accent", "❯") : theme.dim("❯")) : theme.dim(" ");
						const text = i === sel ? theme.fg("accent", wd.items[i]!) : wd.items[i]!;
						lines.push(` ${mark} ${truncateToWidth(text, Math.max(1, w - 3))}`);
					}
					break;
				}
				if (wd.items.length === 0) {
					lines.push(theme.dim(" （空）"));
					break;
				}
				for (const item of wd.items) lines.push(` ${theme.dim("·")} ${truncateToWidth(item, Math.max(1, w - 3))}`);
				break;
			}
			case "input": {
				const st0 = st?.inputById?.[wd.id];
				const focused = st?.focusedId === wd.id;
				lines.push(...renderInputWidget(wd, w, st0, focused));
				break;
			}
			case "columns":
				renderColumns(wd.cols, wd.widths, w, st, lines, lists);
				break;
			case "table":
				renderTableWidget(wd.head, wd.rows, w, lines);
				break;
			default:
				lines.push(...renderPlainWidget(wd, w, lines.length));
				break;
		}
	}
	return { lines, lists };
}

/** 单个非交互控件 → 行（renderWidgetLines 的分派体内复用）。 */
function renderPlainWidget(wd: WidgetSpec, w: number, _base: number): string[] {
	const out: string[] = [];
	switch (wd.kind) {
		case "text": {
			const raw = resolveText(wd.text);
			const styled =
				wd.style === "muted" ? theme.dim(raw)
				: wd.style === "accent" ? theme.fg("accent", raw)
				: wd.style === "warn" ? theme.fg("warn", raw)
				: raw;
			if (wd.wrap === "none") {
				out.push(` ${truncateToWidth(styled, Math.max(1, w - 1))}`);
			} else {
				for (const l of wrapText(styled, Math.max(4, w - 1))) out.push(` ${l}`);
			}
			break;
		}
		case "kv": {
			const label = theme.fg("muted", padToWidth(wd.label, 8));
			out.push(` ${label} ${truncateToWidth(resolveText(wd.value), Math.max(1, w - 11))}`);
			break;
		}
		case "sep":
			out.push(theme.fg("border", " " + "┄".repeat(Math.max(1, w - 2))));
			break;
		case "progress": {
			const value = resolveNum(wd.value);
			const max = wd.max <= 0 ? 1 : wd.max;
			const ratio = Math.max(0, Math.min(1, value / max));
			const pctText = `${Math.round(value)}/${Math.round(wd.max)}`;
			const barW = Math.max(6, w - 4 - pctText.length - 1);
			const total = Math.max(0, Math.min(barW, Math.round(ratio * barW * 8) / 8));
			const full = Math.floor(total);
			const frac = total - full;
			const fracCh = frac > 0 ? FRACS[Math.min(7, Math.ceil(frac * 8) - 1)] : ratio > 0 ? "▏" : "";
			out.push(
				` ${theme.fg("accent", "█".repeat(full) + fracCh)}${theme.fg("muted", "░".repeat(Math.max(0, barW - full - (fracCh === "" ? 0 : 1))))} ${theme.fg("muted", pctText)}`,
			);
			break;
		}
		default:
			// input/columns/table 是控件窗（口子三②/T8）的控件——只读面诚实降级提示
			out.push(theme.dim(" （该控件待 T8 渲染器）"));
			break;
	}
	return out;
}

/** 卡片侧入口（m5 T6）：只要行、不要交互行位。 */
export function renderWidgets(widgets: readonly WidgetSpec[], w: number): string[] {
	return renderWidgetLines(widgets, w).lines;
}

/** 输入框控件（m5 T8）：框形 [ 文本 ]——聚焦带光标块 ▏、未聚焦灰显占位（placeholder）。
 *  多行按 lines 高度开窗、窗口跟随光标行（超出滚动）；文本按看得见的宽度截到内容宽。 */
function renderInputWidget(
	wd: Extract<WidgetSpec, { kind: "input" }>,
	w: number,
	st: { text: string; cursor: number } | undefined,
	focused: boolean,
): string[] {
	const inner = Math.max(4, w - 4);
	const text = st?.text ?? "";
	const cursor = Math.min(st?.cursor ?? 0, text.length);
	const logical = text.split("\n");
	// 光标所在逻辑行（按 \n 计数——码元级简单口径，中文宽字符由渲染截断兜底）
	let row = 0;
	let seen = 0;
	for (let i = 0; i < logical.length; i++) {
		if (cursor <= seen + logical[i]!.length) {
			row = i;
			break;
		}
		seen += logical[i]!.length + 1;
		row = i + 1 === logical.length ? i : row;
	}
	if (cursor >= text.length) row = logical.length - 1;
	const show = wd.multiline === true ? Math.max(1, wd.lines ?? 3) : 1;
	const start = Math.max(0, Math.min(row, logical.length - show));
	const win = logical.slice(start, start + show);
	const boxLine = (line: string, cursorHere: boolean): string => {
		if (st === undefined && text === "" && wd.placeholder !== undefined) {
			return ` ${theme.dim(`[${truncateToWidth(wd.placeholder, inner)}]`)}`; // 未动过笔才显占位
		}
		if (!focused) return ` ${theme.dim(`[${truncateToWidth(line, inner)}]`)}`;
		if (!cursorHere) return ` [${truncateToWidth(line, inner)}]`;
		// 光标块插在光标位（码元口径）——超宽时显示窗滑到光标附近
		const head = line.slice(0, cursor);
		const tail = line.slice(cursor);
		const headFit = head.length > inner - 1 ? head.slice(head.length - (inner - 1)) : head;
		const tailFit = tail.slice(0, Math.max(0, inner - headFit.length));
		return ` [${headFit}${theme.fg("accent", "▏")}${tailFit}]`;
	};
	const out: string[] = [];
	for (let i = 0; i < win.length; i++) out.push(boxLine(win[i]!, start + i === row));
	return out;
}

/** 多列控件（m5 T8，设计空白 5）：每列最小宽 8——不够逐层减列、减到 1 列塌纵向（建议最多嵌套两层）。
 *  widths = 百分比数组（缺省均分）；列间 " │ " 分隔。嵌套 = 递归（内层 columns 吃列宽）。 */
function renderColumns(
	cols: readonly (readonly WidgetSpec[])[],
	widths: readonly number[] | undefined,
	w: number,
	st: WidgetRenderState | undefined,
	lines: string[],
	lists: WidgetListPos[],
): void {
	const n = cols.length;
	if (n === 0) return;
	// 分块：每行最多 k 列（每列 ≥ 最小宽 8 + 分隔 3）；k 算不下就减，k=1 纵向堆叠
	const minCol = 8;
	const sep = 3;
	let k = n;
	while (k > 1 && w < k * minCol + (k - 1) * sep) k--;
	// 列 = 控件清单；组 = 一行并列的若干列（分块产物）
	type WidgetColumn = readonly WidgetSpec[];
	type ColumnGroup = readonly WidgetColumn[];
	const chunk = (arr: readonly WidgetColumn[]): ColumnGroup[] => {
		const out: ColumnGroup[] = [];
		for (let i = 0; i < arr.length; i += k) out.push(arr.slice(i, i + k));
		return out;
	};
	for (const group of chunk(cols)) {
		const g = group.length;
		if (g === 1) {
			// 单列（或塌纵向）：整宽渲染
			const wl = renderWidgetLines(group[0]!, w, st);
			lines.push(...wl.lines);
			lists.push(...wl.lists.map((x) => ({ ...x, baseLine: x.baseLine + lines.length - wl.lines.length })));
			continue;
		}
		const budget = w - (g - 1) * sep;
		const colW: number[] = [];
		if (widths !== undefined && g === n) {
			const total = widths.slice(0, g).reduce((a, b) => a + b, 0) || 1;
			for (let i = 0; i < g; i++) colW.push(Math.max(minCol, Math.floor((widths[i]! / total) * budget)));
		} else {
			for (let i = 0; i < g; i++) colW.push(Math.max(minCol, Math.floor(budget / g)));
		}
		const rendered = group.map((c, i) => renderWidgetLines(c, colW[i]!, st));
		const rows = Math.max(...rendered.map((r) => r.lines.length));
		const base = lines.length;
		for (let r = 0; r < rows; r++) {
			const segs = rendered.map((ren, i) => padToWidth(ren.lines[r] ?? "", colW[i]!));
			lines.push(segs.join(theme.dim("│")));
		}
		rendered.forEach((ren, i) => {
			void i;
			for (const li of ren.lists) lists.push({ ...li, baseLine: base + li.baseLine });
		});
	}
}

/** 表格控件（m5 T8）：网格形态与 md 表格同款（┌─┬─┐ / ├─┼─┤ / └─┴─┘），输入是纯字符串格——
 *  md 渲染器吃 marked token + 行内样式上下文，形状不合（不硬搬，画法语言一致）。
 *  降级（超宽）：连每列 2 格都放不下 → key-value 竖排（md 表格降级同族）。 */
function renderTableWidget(head: readonly string[], rows: readonly (readonly string[])[], w: number, lines: string[]): void {
	const n = head.length;
	if (n === 0) return;
	const colW = Math.floor((w - (n + 1)) / n);
	if (colW < 2) {
		// 超宽降级：key-value 竖排
		for (const row of rows) {
			const seg = head.map((h, i) => `${theme.fg("muted", h)}: ${row[i] ?? ""}`).join(theme.dim(" · "));
			lines.push(` ${truncateToWidth(seg, Math.max(1, w - 2))}`);
		}
		return;
	}
	const cell = (t: string): string => truncateToWidth(t, colW);
	const top = theme.dim("┌" + head.map(() => "─".repeat(colW)).join("┬") + "┐");
	const mid = theme.dim("├" + head.map(() => "─".repeat(colW)).join("┼") + "┤");
	const bot = theme.dim("└" + head.map(() => "─".repeat(colW)).join("┴") + "┘");
	lines.push(top);
	lines.push(theme.dim("│") + head.map((h) => theme.fg("muted", padToWidth(cell(h), colW))).join(theme.dim("│")) + theme.dim("│"));
	lines.push(mid);
	for (const row of rows) {
		lines.push(theme.dim("│") + row.map((c) => padToWidth(cell(c ?? ""), colW)).join(theme.dim("│")) + theme.dim("│"));
	}
	lines.push(bot);
}
