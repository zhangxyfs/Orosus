/** 表格（网格组件 + 降级 key-value——决策③；原 mdpipe.ts:84-118 零变化搬迁）。
 *  mdpipe 批 T4 将升级为 pi 全边框网格 + 等比列宽，本件形态仅为 T0 搬迁过渡。 */
import type { Tokens } from "marked";
import { visibleWidth } from "../tui/width.ts";
import * as theme from "../theme.ts";
import { inlineTokens } from "./inline.ts";

const TABLE_MAX_CELL_W = 24;

export function renderTable(t: Tokens.Table, out: string[], width: number): void {
	const cols = t.header.length;
	const cellText = (cell: Tokens.TableCell): string => inlineTokens(cell.tokens ?? []);
	const head = t.header.map(cellText);
	const rows = t.rows.map((r) => r.map(cellText));
	// 自然列宽（cap TABLE_MAX_CELL_W）；单元格超 cap 或整表超宽 → 降级 key-value
	const natural = head.map((h, c) =>
		Math.min(TABLE_MAX_CELL_W, Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[c] ?? "")))),
	);
	const anyOverflow =
		head.some((h, c) => visibleWidth(h) > natural[c]!) ||
		rows.some((r) => r.some((cell, c) => visibleWidth(cell) > natural[c]!)) ||
		natural.reduce((a, b) => a + b, 0) + cols + 1 > width;
	if (anyOverflow) {
		// 降级 key-value（两家不约而同的逃生门——框架化方案书设计空白「表格降级线」）
		for (const r of rows) {
			r.forEach((cell, c) => {
				const key = theme.fg("muted", head[c] ?? "");
				out.push(` ${theme.fg("accent", "·")} ${key}: ${cell}`);
			});
		}
		out.push("");
		return;
	}
	const line = (cells: string[]): string =>
		cells.map((c, i) => ` ${c}${" ".repeat(Math.max(0, natural[i]! - visibleWidth(c)))}`).join(theme.fg("border", "│"));
	out.push(theme.bold(line(head)));
	out.push(natural.map((w) => "─".repeat(w + 1)).join(theme.fg("border", "─┼─")));
	for (const r of rows) out.push(line(r));
	out.push("");
}
