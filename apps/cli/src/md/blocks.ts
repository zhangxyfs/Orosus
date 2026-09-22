/** 块渲染 + 一次性渲染公共体（原 mdpipe.ts:120-201 零变化搬迁；renderLines = 原
 *  renderMarkdown/renderSeg 的重复合流——lex → 块渲染 → 逐逻辑行 wrapText）。 */
import type { Token, Tokens } from "marked";
import { truncateToWidth, visibleWidth, wrapText } from "../tui/width.ts";
import * as theme from "../theme.ts";
import { lex } from "./lex.ts";
import { inlineTokens } from "./inline.ts";
import { highlightLine } from "./highlight.ts";
import { renderTable } from "./table.ts";

export function renderBlock(t: Token, out: string[], depth: number, width: number): void {
	switch (t.type) {
		case "heading": {
			const h = t as Tokens.Heading;
			const text = inlineTokens(h.tokens ?? []);
			if (h.depth <= 2) {
				out.push(theme.bold(theme.fg("accent", text)));
				// CJK 下划线按显示宽（缺陷⑥修复点——repeat 用可见宽非 UTF-16 长）
				out.push(theme.dim((h.depth === 1 ? "═" : "─").repeat(Math.max(1, visibleWidth(text)))));
			} else {
				// h3+：加粗 info、不带字面 ###（缺陷③修复点）
				out.push(theme.bold(theme.fg("info", text)));
			}
			out.push("");
			break;
		}
		case "paragraph":
			out.push(inlineTokens((t as Tokens.Paragraph).tokens ?? []));
			out.push("");
			break;
		case "list": {
			const l = t as Tokens.List;
			l.items.forEach((item, idx) => {
				const bullet = l.ordered ? `${(l.start || 1) + idx}. ` : "• ";
				const pad = "  ".repeat(depth);
				const sub: string[] = [];
				for (const tok of item.tokens) renderBlock(tok, sub, depth + 1, width - pad.length - bullet.length);
				const flat = sub.filter((x) => x !== "");
				flat.forEach((x, i) => {
					out.push(i === 0 ? `${pad}${theme.fg("accent", bullet)}${x}` : `${pad}${" ".repeat(bullet.length)}${x}`);
				});
			});
			out.push("");
			break;
		}
		case "code": {
			const c = t as Tokens.Code;
			out.push(theme.dim(`  \`\`\`${c.lang ?? ""}`));
			for (const line of c.text.split("\n")) {
				out.push(`  ${truncateToWidth(highlightLine(line, c.lang ?? ""), Math.max(8, width - 2))}`);
			}
			out.push(theme.dim("  ```"));
			out.push("");
			break;
		}
		case "blockquote": {
			const sub: string[] = [];
			for (const tok of (t as Tokens.Blockquote).tokens) renderBlock(tok, sub, depth, width - 2);
			for (const line of sub.filter((x) => x !== "")) {
				out.push(theme.fg("muted", `▎ ${line}`));
			}
			out.push("");
			break;
		}
		case "hr":
			out.push(theme.dim("─".repeat(Math.min(20, width))));
			out.push("");
			break;
		case "table":
			renderTable(t as Tokens.Table, out, width);
			break;
		case "space":
			break;
		default:
			if ("text" in t && typeof (t as { text?: string }).text === "string") {
				out.push((t as { text: string }).text);
				out.push("");
			}
	}
}

/** 一次性渲染（回显面）：token 流 → 折行后的物理行数组。 */
export function renderLines(src: string, width: number): string[] {
	const tokens = lex(src);
	const logical: string[] = [];
	for (const t of tokens) renderBlock(t, logical, 0, width);
	const out: string[] = [];
	for (const l of logical) out.push(...wrapText(l, width));
	return out;
}
