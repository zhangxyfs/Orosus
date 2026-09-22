/** 块渲染 + 一次性渲染公共体（原 mdpipe.ts:120-201 零变化搬迁；renderLines = 原
 *  renderMarkdown/renderSeg 的重复合流——lex → 块渲染 → 逐逻辑行 wrapText）。 */
import type { Token, Tokens } from "marked";
import { truncateToWidth, visibleWidth, wrapText } from "../tui/width.ts";
import * as theme from "../theme.ts";
import { lex } from "./lex.ts";
import { inlineTokens } from "./inline.ts";
import { highlightLines } from "./highlight.ts";
import { renderTable } from "./table.ts";

/** 渲染期可选项（mdpipe 批 T1）：transient = 流式尾段形态——代码块跳过高亮（纯文本行）。 */
export interface RenderOpts {
	transient?: boolean;
}

export function renderBlock(t: Token, out: string[], depth: number, width: number, opts?: RenderOpts): void {
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
			// 悬挂缩进（mdpipe 批 T3，pi continuationPrefix 三件套）：条目内容先按 itemWidth
			// 折行、再逐物理行贴前缀——首行贴 marker（含任务 [x]），续行贴 marker 等宽空格，
			// 续行与首行内容列对齐；着色只上 marker，续行前缀纯空格（宽度口径干净）。
			const l = t as Tokens.List;
			const pad = "  ".repeat(depth);
			l.items.forEach((item, idx) => {
				const bullet = l.ordered ? `${(l.start || 1) + idx}. ` : "• ";
				const task = item.task ? `[${item.checked ? "x" : " "}] ` : "";
				const marker = bullet + task;
				const firstPrefix = `${pad}${theme.fg("accent", marker)}`;
				const continuationPrefix = `${pad}${" ".repeat(visibleWidth(marker))}`;
				const itemWidth = Math.max(1, width - visibleWidth(pad) - visibleWidth(marker));
				const sub: string[] = [];
				for (const tok of item.tokens) renderBlock(tok, sub, depth + 1, itemWidth);
				let first = true;
				for (const x of sub) {
					if (x === "") continue;
					for (const phys of wrapText(x, itemWidth)) {
						out.push(first ? `${firstPrefix}${phys}` : `${continuationPrefix}${phys}`);
						first = false;
					}
				}
				if (first) out.push(firstPrefix); // 空条目防丢
			});
			out.push("");
			break;
		}
		case "code": {
			const c = t as Tokens.Code;
			out.push(theme.dim(`  \`\`\`${c.lang ?? ""}`));
			for (const line of highlightLines(c.text, c.lang, opts)) {
				out.push(`  ${truncateToWidth(line, Math.max(8, width - 2))}`);
			}
			out.push(theme.dim("  ```"));
			out.push("");
			break;
		}
		case "blockquote": {
			// 悬挂缩进（mdpipe 批 T3）：子块按 width-2 渲染 → 逐行按 width-2 折行 → 每条物理行
			// 贴 ▎ 前缀（先折行后贴前缀——折行知晓前缀占用，续行不丢引用符）。
			const sub: string[] = [];
			for (const tok of (t as Tokens.Blockquote).tokens) renderBlock(tok, sub, depth, Math.max(1, width - 2));
			for (const line of sub.filter((x) => x !== "")) {
				for (const phys of wrapText(line, Math.max(1, width - 2))) {
					out.push(theme.fg("muted", `▎ ${phys}`));
				}
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

/** 一次性渲染（回显面）：token 流 → 折行后的物理行数组。opts.transient 供流式尾段
 *  跳高亮（公开签名 renderMarkdown 不透出，仅 streaming 内部使用）。 */
export function renderLines(src: string, width: number, opts?: RenderOpts): string[] {
	return renderTokens(lex(src), width, opts);
}

/** 对既有 token 数组渲染（流式尾段用——token 边界定稿与半截围栏修剪后直接渲，免二次 lex）。 */
export function renderTokens(tokens: Token[], width: number, opts?: RenderOpts): string[] {
	const logical: string[] = [];
	for (const t of tokens) renderBlock(t, logical, 0, width, opts);
	const out: string[] = [];
	for (const l of logical) out.push(...wrapText(l, width));
	return out;
}
