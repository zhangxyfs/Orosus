/** LaTeX marked tokenizer 扩展（mdpipe 批 T7，从 latex.ts 拆出第三件——行数红线 ≤1000）。
 *  pi markdown.ts:26-144 移植：块级 $…$/[…]、行内 $…$/(…)，含货币守卫等防误判启发式；
 *  pending 支路不移植（设计空白 #15：未闭合不命中 → marked 按原文渲染）。 */
import type { TokenizerExtension, Tokens } from "marked";

interface LatexToken extends Tokens.Generic {
	type: "latex" | "latexBlock";
}

function isEscaped(source: string, index: number): boolean {
	let backslashes = 0;
	for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
		backslashes++;
	}
	return backslashes % 2 === 1;
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
	let index = source.indexOf(closing, start);
	while (index >= 0 && isEscaped(source, index)) {
		index = source.indexOf(closing, index + closing.length);
	}
	return index;
}

function tokenizeInlineLatex(source: string): LatexToken | undefined {
	let opening = "";
	let closing = "";
	if (source.startsWith("$$")) {
		opening = "$$";
		closing = "$$";
	} else if (source.startsWith("\\(")) {
		opening = "\\(";
		closing = "\\)";
	} else if (source.startsWith("\\[")) {
		opening = "\\[";
		closing = "\\]";
	} else if (source.startsWith("$") && !/^\$\s/.test(source)) {
		opening = "$";
		closing = "$";
	} else {
		return undefined;
	}

	const closingIndex = findClosingDelimiter(source, closing, opening.length);
	// 货币守卫等防误判启发式（pi tokenizeInlineLatex 同式）：闭合符后跟数字（$5）、
	// 内容空格结尾、全大写变量名后跟标识符、内容含反引号 → 不当数学
	if (
		closingIndex >= 0 &&
		opening === "$" &&
		(/\s$/.test(source.slice(opening.length, closingIndex)) ||
			/^\d/.test(source.slice(closingIndex + 1)) ||
			(/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(source.slice(opening.length, closingIndex)) &&
				/^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(closingIndex + 1))) ||
			source.slice(opening.length, closingIndex).includes("`"))
	) {
		return undefined;
	}

	// 未闭合：不命中（pending 支路不移植——marked 按原文渲染，设计空白 #15）
	if (closingIndex < 0) {
		return undefined;
	}

	const text = source.slice(opening.length, closingIndex);
	if (!text || text.includes("\n")) {
		return undefined;
	}

	const raw = source.slice(0, closingIndex + closing.length);
	return { type: "latex", raw, text };
}

function tokenizeBlockLatex(source: string): LatexToken | undefined {
	const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
	if (dollarMatch?.[1]) {
		return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
	}

	const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
	if (bracketMatch?.[1]) {
		return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
	}

	// 未闭合（pendingBracket / pendingDollar）：不命中——同设计空白 #15
	return undefined;
}

export const LATEX_MARKDOWN_EXTENSIONS: readonly TokenizerExtension[] = [
	{
		name: "latexBlock",
		level: "block",
		start(source) {
			const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
			return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
		},
		tokenizer: tokenizeBlockLatex,
	},
	{
		name: "latex",
		level: "inline",
		start(source) {
			const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(
				(index) => index >= 0,
			);
			return indices.length > 0 ? Math.min(...indices) : undefined;
		},
		tokenizer: tokenizeInlineLatex,
	},
];

