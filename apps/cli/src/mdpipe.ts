/** markdown 新管线（TUI 批阶段三 F1——marked 解析 + 自写连山渲染器 + 流式稳定前缀冻结）。
 *  形态 = markdown 调研 9/9 先验（解析外包 marked、渲染自写）+ spike 原型实证件扩全。
 *  五项决策清单（框架化方案书 F1 节）：① 解析器 = marked（D53 拍板 2026-09-21：「自写解析器
 *  可能产生大量不可控的问题，不值得」——只供 AST，渲染主权在自家渲染器）；② 渲染器 = 自写
 *  ANSI token→theme 映射；③ 表格 = 自写网格组件，单元格超宽/整表超宽降级 key-value（两家
 *  不约而同的逃生门）；④ 高亮 = 自写正则三形态（关键字/字符串/注释——cli-highlight 量化数据
 *  28 包/97ms 否决硬依赖地位，可选件形态另议）；⑤ LaTeX 可选件 = 需求触发器条款，只进清单不排期。
 *  九条挂账缺陷的验收面（TUI 批决策点⑧）：表格/嵌套列表/h3+/链接·斜体·引用·删除线·水平线/
 *  行内码内标记不误剥/CJK 标题下划线按显示宽/着色/嵌套上下文语义——测试逐项钉。
 *  流式 = 稳定前缀冻结（cc-haha 策略，spike 实证把帧成本从 20ms+ 压到 3–6ms）：空行（fence 外）
 *  与 fence 闭合行为冻结点，冻结段只解析折行一次、尾巴每帧重渲。 */

import { Marked, type Token, type Tokens } from "marked";
import { truncateToWidth, visibleWidth, wrapText } from "./tui/width.ts";
import * as theme from "./theme.ts";

const marked = new Marked();

// ---------- 行内标记（token 级映射——行级正则误剥行内码前案的根治路径） ----------

function inlineToken(t: Token): string {
	switch (t.type) {
		case "text":
			return (t as Tokens.Text).text;
		case "escape":
			return (t as Tokens.Escape).text;
		case "strong":
			return theme.bold(inlineTokens((t as Tokens.Strong).tokens ?? []));
		case "em":
			return `\x1b[3m${inlineTokens((t as Tokens.Em).tokens ?? [])}\x1b[23m`;
		case "del":
			return `\x1b[9m${inlineTokens((t as Tokens.Del).tokens ?? [])}\x1b[29m`;
		case "codespan":
			return theme.fg("warn", (t as Tokens.Codespan).text);
		case "link": {
			const lt = t as Tokens.Link;
			const label = inlineTokens(lt.tokens ?? []);
			return theme.fg("info", theme.underline(label)) + theme.dim(` (${lt.href})`);
		}
		case "br":
			return "\n";
		default:
			return "raw" in t && typeof (t as { raw?: string }).raw === "string"
				? (t as { raw: string }).raw
				: "";
	}
}

function inlineTokens(tokens: Token[]): string {
	let out = "";
	for (const t of tokens) out += inlineToken(t);
	return out;
}

// ---------- 高亮（正则三形态：关键字/字符串/注释——语言表外的按纯文本） ----------

const KEYWORDS: Record<string, string[]> = {
	ts: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "interface", "type", "import", "export", "from", "new", "async", "await", "of", "in", "instanceof", "typeof"],
	js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "import", "export", "from", "new", "async", "await", "of", "in", "instanceof", "typeof"],
	py: ["def", "return", "if", "elif", "else", "for", "while", "class", "import", "from", "as", "with", "lambda", "pass", "raise", "try", "except", "finally"],
	bash: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "in", "echo", "exit", "return", "local", "export"],
	sh: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "in", "echo", "exit", "return", "local", "export"],
};
const LANG_ALIAS: Record<string, string> = { typescript: "ts", javascript: "js", python: "py", shell: "bash", zsh: "bash" };

/** 单行高亮：字符串 → warn、注释 → muted、关键字 → accent、其余 → fg。 */
function highlightLine(line: string, lang: string): string {
	const l = LANG_ALIAS[lang] ?? lang;
	if (l === "json") {
		// json：字符串键值 warn、数字 info
		return line.replace(/("(?:[^"\\]|\\.)*")/g, (_m, g: string) => theme.fg("warn", g)).replace(/\b(\d+(?:\.\d+)?)\b/g, (_m, g: string) => theme.fg("info", g));
	}
	const kws = KEYWORDS[l];
	if (!kws) return theme.fg("fg", line);
	const kw = kws.join("|");
	const re = new RegExp(`("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`|\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/|#.*$|\\b(?:${kw})\\b)`, "g");
	return line.replace(re, (m) => {
		if (m.startsWith("//") || m.startsWith("/*") || m.startsWith("#")) return theme.fg("muted", m);
		if (m.startsWith('"') || m.startsWith("'") || m.startsWith("`")) return theme.fg("warn", m);
		return theme.fg("accent", m);
	});
}

// ---------- 表格（网格组件 + 降级 key-value——决策③） ----------

const TABLE_MAX_CELL_W = 24;

function renderTable(t: Tokens.Table, out: string[], width: number): void {
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

// ---------- 块渲染 ----------

function renderBlock(t: Token, out: string[], depth: number, width: number): void {
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
export function renderMarkdown(src: string, width: number): string[] {
	const tokens = marked.lexer(src, { gfm: true });
	const logical: string[] = [];
	for (const t of tokens) renderBlock(t, logical, 0, width);
	const out: string[] = [];
	for (const l of logical) out.push(...wrapText(l, width));
	return out;
}

/** 流式渲染（稳定前缀冻结）：冻结点只落在 fence 外 → frozenUpto 处 fence 态恒为「外」，
 *  扫描从 frozenUpto 起步即可（O(尾长) 非 O(n)）；行判定走 charCodeAt 不切片（spike 实测热点）。 */
export interface StreamingMarkdown {
	render(full: string): string[]; // 返回已按 width 折行的物理行
}

export function createStreamingMarkdown(width: number): StreamingMarkdown {
	let frozenUpto = 0; // 已冻结的文本前缀长度
	let frozenLines: string[] = []; // 已冻结的折行后物理行（冻结时折行一次，永不重折）
	const BACKTICK = 0x60;
	const stableCut = (src: string, from: number): number => {
		let cut = from;
		let inFence = false;
		let i = from;
		const n = src.length;
		while (i < n) {
			const nl = src.indexOf("\n", i);
			const lineEnd = nl === -1 ? n : nl;
			const isFence =
				src.charCodeAt(i) === BACKTICK && src.charCodeAt(i + 1) === BACKTICK && src.charCodeAt(i + 2) === BACKTICK;
			if (isFence) {
				if (!inFence) cut = Math.max(cut, i); // fence 开启前的内容可冻结
				inFence = !inFence;
				if (!inFence && nl !== -1) cut = nl + 1; // fence 刚闭合——整块冻结
			} else if (!inFence && lineEnd === i && nl !== -1) {
				cut = nl + 1; // 空行（fence 外）= 冻结点
			}
			if (nl === -1) break;
			i = nl + 1;
		}
		return cut;
	};

	const renderSeg = (seg: string): string[] => {
		const tokens = marked.lexer(seg, { gfm: true });
		const logical: string[] = [];
		for (const t of tokens) renderBlock(t, logical, 0, width);
		const out: string[] = [];
		for (const l of logical) out.push(...wrapText(l, width));
		return out;
	};

	return {
		render(full: string): string[] {
			if (full.length < frozenUpto) {
				// 文本被重置（防御）
				frozenUpto = 0;
				frozenLines = [];
			}
			const cut = stableCut(full, frozenUpto);
			if (cut > frozenUpto) {
				frozenLines.push(...renderSeg(full.slice(frozenUpto, cut)));
				frozenUpto = cut;
			}
			const tail = full.slice(frozenUpto);
			if (tail === "") return frozenLines;
			return [...frozenLines, ...renderSeg(tail)];
		},
	};
}
