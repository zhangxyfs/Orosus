/** 表格（mdpipe 批 T4——P1-④ 完整化）：主形态 = pi 全边框网格（┌─┬─┐ 顶框 / ├─┼─┤ 行间分隔 /
 *  └─┴─┘ 底框）+ 等比列宽算法（自然宽放得下用自然宽；放不下从最小词宽按 grow 潜力等比涨、
 *  词宽也放不下则全 1 起步按词宽权重再分 + 轮转补舍入）；单元格按列宽折行（wrapText ANSI
 *  感知），折行片段间插样式归零序列防串色。
 *  降级 key-value 两条线（cc-haha renderVerticalFormat 补全）：① 结构线——连每列 1 格都
 *  放不下（pi :859）；② 可读性线——列宽 squeeze 后最高行超 4 行（cc-haha MAX_ROW_LINES=4，
 *  竖排比高瘦网格可读）。降级形态：记录间 ─ 分隔线（宽 min(width-1, 40)）+ 值续行 2 空格
 *  缩进 + 单元格内换行归一空格计宽。TABLE_MAX_CELL_W = 24 cap 退役（设计空白 #6——列内
 *  折行取代判死刑式降级；降级线从「词宽放不下」实测修正为「行高超 4」——方案拍板值落地
 *  期修订，宽 24 双列 squeeze 场景仍须网格，词宽线会误杀）。 */
import type { Tokens } from "marked";
import { visibleWidth, wrapText } from "../tui/width.ts";
import * as theme from "../theme.ts";
import { inlineTokens, type InlineStyleContext } from "./inline.ts";

/** 单词最小列宽 cap（设计空白 #7——pi 同值 30）。 */
const MAX_UNBROKEN_WORD_W = 30;
/** 网格行高上限：超此行高走 key-value 降级（cc-haha 同值 4）。 */
const MAX_ROW_LINES = 4;
/** 折行片段间样式归零序列（pi wrapCellText 同款：bold/dim/italic/underline/blink/inverse/
 *  hidden/strike/前景 全复位——防列间串色）。 */
const STYLE_RESET = "\x1b[22;23;24;25;27;28;29;39m";

/** 最长词显示宽（\s+ 分词，cap 30）。 */
function longestWordWidth(text: string): number {
	let longest = 0;
	for (const word of text.split(/\s+/)) {
		if (word.length === 0) continue;
		longest = Math.max(longest, visibleWidth(word));
	}
	return Math.min(Math.max(1, longest), MAX_UNBROKEN_WORD_W);
}

/** 单元格按列宽折行；非末行片段以样式归零序列收尾（续行/边框不带内层色）。 */
function wrapCellText(text: string, maxWidth: number): string[] {
	const lines = wrapText(text, Math.max(1, maxWidth));
	return lines.map((line, i) => (i < lines.length - 1 ? line + STYLE_RESET : line));
}

/** 降级 key-value（极窄逃生门——两家不约而同的形态，cc-haha 补全分隔与缩进）。 */
function renderKeyValueFallback(head: string[], rows: string[][], out: string[], width: number): void {
	const separator = theme.fg("border", "─".repeat(Math.max(1, Math.min(width - 1, 40))));
	rows.forEach((r, ri) => {
		if (ri > 0) out.push(separator); // 记录间分隔线（设计空白 #8）
		r.forEach((cell, c) => {
			const key = head[c] ?? "";
			// 单元格内换行归一为空格后再计宽（P3 计宽偏差）
			const value = cell.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
			// 单遍按首行宽折行（cc-haha 两遍重包会在 CJK 断字处凭空插空格——内容零失真优先，
			// 续行宽度效率让位）
			const firstLineWidth = Math.max(1, width - visibleWidth(key) - 5); // " · key: " 前缀
			const wrapped = wrapText(value, firstLineWidth);
			out.push(` ${theme.fg("accent", "·")} ${theme.fg("muted", key)}: ${wrapped[0] ?? ""}`);
			for (let i = 1; i < wrapped.length; i++) out.push(`  ${wrapped[i]}`);
		});
	});
	out.push("");
}

export function renderTable(t: Tokens.Table, out: string[], width: number, ctx?: InlineStyleContext): void {
	const cols = t.header.length;
	if (cols === 0) return;
	const cellText = (cell: Tokens.TableCell): string => inlineTokens(cell.tokens ?? [], ctx);
	const head = t.header.map(cellText);
	const rows = t.rows.map((r) => r.map(cellText));

	// 边框开销："│ " + (n-1)·" │ " + " │" = 3n + 1（pi :857）
	const borderOverhead = 3 * cols + 1;
	const availableForCells = width - borderOverhead;

	const natural = head.map((h, c) => Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[c] ?? ""))));
	const minWord = head.map((h, c) => Math.max(1, longestWordWidth(h), ...rows.map((r) => longestWordWidth(r[c] ?? ""))));
	const minCellsWidth = minWord.reduce((a, b) => a + b, 0);

	// 降级线① 结构线（pi :859）：连每列 1 格都放不下
	if (availableForCells < cols) {
		renderKeyValueFallback(head, rows, out, width);
		return;
	}

	// 等比列宽（pi :897-933）：自然宽放得下 → 自然宽；放不下 → 最小词宽起等比涨；
	// 词宽也放不下 → 全 1 起步按词宽权重再分（pi :886-911，CJK 逐字断行下窄列仍可读）
	const totalNatural = natural.reduce((a, b) => a + b, 0) + borderOverhead;
	let columnWidths: number[];
	if (totalNatural <= width) {
		columnWidths = natural.map((w, i) => Math.max(w, minWord[i]!));
	} else {
		let basis = minWord;
		let basisWidth = minCellsWidth;
		if (minCellsWidth > availableForCells) {
			basis = minWord.map(() => 1);
			const remaining = availableForCells - cols;
			const totalWeight = minWord.reduce((acc, w) => acc + Math.max(0, w - 1), 0);
			const growth = minWord.map((w) => {
				const weight = Math.max(0, w - 1);
				return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
			});
			basis = basis.map((one, i) => one + growth[i]!);
			const allocated = growth.reduce((a, b) => a + b, 0);
			let leftover = remaining - allocated;
			for (let i = 0; leftover > 0 && i < cols; i++) {
				basis[i]!++;
				leftover--;
			}
			basisWidth = basis.reduce((a, b) => a + b, 0);
		}
		const totalGrowPotential = natural.reduce((acc, w, i) => acc + Math.max(0, w - basis[i]!), 0);
		const extraWidth = availableForCells - basisWidth;
		columnWidths = basis.map((base, i) => {
			const delta = Math.max(0, natural[i]! - base);
			return base + (totalGrowPotential > 0 ? Math.floor((delta / totalGrowPotential) * extraWidth) : 0);
		});
		let remaining = availableForCells - columnWidths.reduce((a, b) => a + b, 0);
		while (remaining > 0) {
			let grew = false;
			for (let i = 0; i < cols && remaining > 0; i++) {
				if (columnWidths[i]! < natural[i]!) {
					columnWidths[i]!++;
					remaining--;
					grew = true;
				}
			}
			if (!grew) break;
		}
	}

	// 单元格折行（先算好——降级线②要用行高）
	const headerCells = head.map((h, i) => wrapCellText(theme.bold(h), columnWidths[i]!));
	const rowCells = rows.map((r) => r.map((cell, i) => wrapCellText(cell, columnWidths[i]!)));
	// 降级线② 可读性线：行高超 4 行（cc-haha MAX_ROW_LINES=4）或列宽 squeeze 到 1 列以下
	// （1 字符宽网格失去意义——一个全角字都放不下）→ 竖排 key-value 更可读
	const maxRowLines = Math.max(1, ...headerCells.map((c) => c.length), ...rowCells.flat().map((c) => c.length));
	if (maxRowLines > MAX_ROW_LINES || columnWidths.some((w) => w < 2)) {
		renderKeyValueFallback(head, rows, out, width);
		return;
	}

	const b = (s: string): string => theme.fg("border", s);
	const rule = (l: string, m: string, r: string): string =>
		b(`${l}─${columnWidths.map((w) => "─".repeat(w)).join(`─${m}─`)}─${r}`);
	const contentLine = (cells: string[][]): void => {
		const lineCount = Math.max(...cells.map((c) => c.length));
		for (let li = 0; li < lineCount; li++) {
			const parts = cells.map((cellLines, c) => {
				const text = cellLines[li] ?? "";
				return text + " ".repeat(Math.max(0, columnWidths[c]! - visibleWidth(text)));
			});
			out.push(`${b("│ ")}${parts.join(b(" │ "))}${b(" │")}`);
		}
	};

	out.push(rule("┌", "┬", "┐"));
	contentLine(headerCells);
	const separatorLine = rule("├", "┼", "┤");
	out.push(separatorLine);
	rowCells.forEach((r, ri) => {
		contentLine(r);
		if (ri < rowCells.length - 1) out.push(separatorLine); // 数据行间分隔线
	});
	out.push(rule("└", "┴", "┘"));
	out.push("");
}
