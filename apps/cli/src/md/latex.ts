/** LaTeX → Unicode 线性化渲染器（mdpipe 批 T7）。
 *  移植自 pi 仓库 packages/tui/src/latex.ts :602-1506（MIT License——版权注记见文件尾），
 *  修法口径（方案 v3.1）：
 *  ① **竖排分式路径整支摘除**——pi 的 stackFractions 默认开（原文件 :844），display 模式
 *     \frac 会竖排堆叠；本仓拍板单行线性化是终端主流可读形态，display 也单行（连带
 *     parseRequiredArgument / renderNested 的 stackFractions 参数一并清理）。
 *     注意 pi 原文件 :1480 的「display 默认 false」注释只说 options 形参缺省，不改变
 *     stackFractions 字段默认开的事实。
 *  ② 失败返回 **undefined**（非 null）——调用方回退原文判空用 `??`，禁止 `=== null`。
 *  ③ 附带 marked tokenizer 扩展（pi markdown.ts:26-144 移植，独立成 latex-tokenizer.ts
 *     ——行数红线第三件）：块级 $$…$$ / \[…\]、行内 $…$ / \(…\)，含货币守卫等防误判启发式；
 *     **pending 支路不移植**（设计空白 #15：未闭合分隔符 tokenizer 直接不命中 → marked 按原文渲染，
 *     本仓流式尾段每帧重 lex，视觉效果与 pi 的 pending 等价且零额外状态）。
 *  配置开关（设计空白 #12）：`[tui] latex` 布尔、缺省开；宿主启动时调 setLatexEnabled()
 *  注入一次（tuicfg.resolveLatexFlag → main），关 = renderLatex 恒 undefined = 原样透传。 */
import { visibleWidth } from "../tui/width.ts";
import {
	SYMBOLS,
	NAMED_OPERATORS,
	LIMIT_OPERATORS,
	DISPLAY_LIMIT_SYMBOLS,
	RELATION_COMMANDS,
	NEGATED_SYMBOLS,
	BLACKBOARD,
	SUPERSCRIPTS,
	SUBSCRIPTS,
	SPACING_COMMANDS,
	NEGATIVE_SPACING_COMMANDS,
	NEGATIVE_SPACE,
	FONT_SWITCH_COMMANDS,
	IGNORED_COMMANDS,
	SIZE_COMMANDS,
	PLAIN_WRAPPERS,
	ACCENTS,
} from "./latex-maps.ts";

// ---------- 模块级开关（[tui] latex，缺省开——设计空白 #12/#13：启动读一次，改配置重启生效） ----------

let latexEnabled = true;

export function setLatexEnabled(flag: boolean): void {
	latexEnabled = flag;
}

// ---------- 基础格式化（pi :602-647 移植） ----------

function replaceCharacters(value: string, replacements: Readonly<Record<string, string>>): string | undefined {
	let result = "";
	for (const character of value) {
		const replacement = replacements[character];
		if (replacement === undefined) {
			return undefined;
		}
		result += replacement;
	}
	return result;
}

function normalizeScriptValue(value: string): string {
	return value.trim().replace(/\s*([=+-])\s*/g, "$1");
}

function formatUnicodeScript(value: string, kind: "sub" | "sup"): string | undefined {
	return replaceCharacters(normalizeScriptValue(value), kind === "sub" ? SUBSCRIPTS : SUPERSCRIPTS);
}

function formatScript(value: string, kind: "sub" | "sup"): string {
	value = normalizeScriptValue(value);
	const unicode = formatUnicodeScript(value, kind);
	if (unicode !== undefined) {
		return unicode;
	}

	const prefix = kind === "sub" ? "_" : "^";
	if (Array.from(value).length === 1 || (kind === "sub" && /^[A-Za-z]+$/.test(value))) {
		return `${prefix}${value}`;
	}
	return `${prefix}(${value})`;
}

/** 分式单行线性化：a/b，复杂分子分母加括号（竖排堆叠路径已摘除——文件头修法口径①）。 */
function formatFraction(numerator: string, denominator: string): string {
	numerator = numerator.trim();
	denominator = denominator.trim();
	const simpleNumerator = /^[\p{L}\p{N}.]+$/u.test(numerator);
	const simpleDenominator = /^[\p{N}.]+$/u.test(denominator) || Array.from(denominator).length === 1;
	return `${simpleNumerator ? numerator : `(${numerator})`}/${simpleDenominator ? denominator : `(${denominator})`}`;
}

function formatRoot(value: string, symbol = "√"): string {
	value = value.trim();
	return /^[\p{L}\p{N}.]+$/u.test(value) ? `${symbol}${value}` : `${symbol}(${value})`;
}

// ---------- 命名算符间距（pi :649-665 移植） ----------

const NAMED_OPERATOR_START = "\u{f0004}";
const NAMED_OPERATOR_END = "\u{f0005}";
const NAMED_OPERATOR_LEFT_SPACING_PATTERN = /(?<=[\p{L}\p{N})\]}\u{f0001}])\u{f0004}/gu;
const NAMED_OPERATOR_RIGHT_SPACING_PATTERN = /\u{f0005}(?=[\p{L}\p{N}√\u{f0000}])/gu;

function normalizeOutput(value: string): string {
	return value
		.replace(NAMED_OPERATOR_LEFT_SPACING_PATTERN, " ")
		.replaceAll(NAMED_OPERATOR_START, "")
		.replace(NAMED_OPERATOR_RIGHT_SPACING_PATTERN, " ")
		.replaceAll(NAMED_OPERATOR_END, "")
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
		.join("\n")
		.trim();
}

// ---------- 布局节点（display 模式算符上下标 / cases / 矩阵的多行机制——pi :667-836 移植） ----------

interface FractionNode {
	type: "fraction";
	numerator: string;
	denominator: string;
}

interface OperatorNode {
	type: "operator";
	operator: string;
	lower?: string | undefined;
	upper?: string | undefined;
}

interface ScriptNode {
	type: "script";
	lower?: string | undefined;
	upper?: string | undefined;
}

interface MatrixNode {
	type: "matrix";
	lines: string[];
	baseline: number;
}

type LayoutNode = FractionNode | OperatorNode | ScriptNode | MatrixNode;

interface Layout {
	lines: string[];
	width: number;
	baseline: number;
}

const LAYOUT_MARKER_START = "\u{f0000}";
const LAYOUT_MARKER_END = "\u{f0001}";
const LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}/gu;
const TRAILING_LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}$/u;
const PROTECTED_SPACE = "\u{f0002}";

function padLayoutLine(line: string, width: number, centered = false): string {
	const padding = Math.max(0, width - visibleWidth(line));
	const left = centered ? Math.floor(padding / 2) : 0;
	return `${" ".repeat(left)}${line}${" ".repeat(padding - left)}`;
}

function joinLayouts(layouts: readonly Layout[]): Layout {
	if (layouts.length === 0) {
		return { lines: [""], width: 0, baseline: 0 };
	}
	const baseline = Math.max(...layouts.map((layout) => layout.baseline));
	const below = Math.max(...layouts.map((layout) => layout.lines.length - layout.baseline - 1));
	const lines: string[] = [];
	for (let row = 0; row <= baseline + below; row++) {
		let line = "";
		for (const layout of layouts) {
			const sourceRow = row - baseline + layout.baseline;
			line +=
				sourceRow >= 0 && sourceRow < layout.lines.length
					? padLayoutLine(layout.lines[sourceRow] ?? "", layout.width)
					: " ".repeat(layout.width);
		}
		lines.push(line.trimEnd());
	}
	return {
		lines,
		width: layouts.reduce((width, layout) => width + layout.width, 0),
		baseline,
	};
}

function renderLayout(source: string, nodes: readonly LayoutNode[]): Layout {
	const renderedLines: string[] = [];
	let firstBaseline = 0;
	for (const sourceLine of source.split("\n")) {
		const layouts: Layout[] = [];
		let position = 0;
		let previousNode: LayoutNode | undefined;
		for (const match of sourceLine.matchAll(LAYOUT_MARKER_PATTERN)) {
			const index = match.index;
			const node = nodes[Number(match[1])];
			if (!node) {
				continue;
			}
			if (index > position) {
				const sliced = sourceLine.slice(position, index);
				const trimmed = (previousNode ? sliced.trimStart() : sliced).trimEnd();
				const preserveLeadingSpace = previousNode?.type === "matrix" && /^\s/.test(sliced);
				const preserveTrailingSpace = node.type === "matrix" && /\s$/.test(sliced);
				const text = trimmed
					? `${preserveLeadingSpace ? " " : ""}${trimmed}${preserveTrailingSpace ? " " : ""}`
					: preserveLeadingSpace || preserveTrailingSpace
						? " "
						: "";
				layouts.push({ lines: [text], width: visibleWidth(text), baseline: 0 });
			}
			if (node.type === "fraction") {
				const numerator = renderLayout(node.numerator, nodes);
				const denominator = renderLayout(node.denominator, nodes);
				const contentWidth = Math.max(numerator.width, denominator.width, 1);
				const width = contentWidth + 2;
				layouts.push({
					lines: [
						...numerator.lines.map((line) => padLayoutLine(line, width, true)),
						` ${"─".repeat(contentWidth)} `,
						...denominator.lines.map((line) => padLayoutLine(line, width, true)),
					],
					width,
					baseline: numerator.lines.length,
				});
			} else if (node.type === "operator") {
				const contentWidth = Math.max(
					visibleWidth(node.operator),
					node.lower === undefined ? 0 : visibleWidth(node.lower),
					node.upper === undefined ? 0 : visibleWidth(node.upper),
				);
				const lines: string[] = [];
				if (node.upper !== undefined) {
					lines.push(`${padLayoutLine(node.upper, contentWidth, true)} `);
				}
				lines.push(`${padLayoutLine(node.operator, contentWidth, true)} `);
				if (node.lower !== undefined) {
					lines.push(`${padLayoutLine(node.lower, contentWidth, true)} `);
				}
				layouts.push({
					lines,
					width: contentWidth + 1,
					baseline: node.upper === undefined ? 0 : 1,
				});
			} else if (node.type === "script") {
				const upper = node.upper === undefined ? undefined : renderLayout(node.upper, nodes);
				const lower = node.lower === undefined ? undefined : renderLayout(node.lower, nodes);
				const width = Math.max(upper?.width ?? 0, lower?.width ?? 0);
				layouts.push({
					lines: [
						...(upper?.lines.map((line) => padLayoutLine(line, width)) ?? []),
						" ".repeat(width),
						...(lower?.lines.map((line) => padLayoutLine(line, width)) ?? []),
					],
					width,
					baseline: upper?.lines.length ?? 0,
				});
			} else {
				const width = Math.max(0, ...node.lines.map((line) => visibleWidth(line)));
				layouts.push({
					lines: node.lines.map((line) => padLayoutLine(line, width)),
					width,
					baseline: node.baseline,
				});
			}
			position = index + match[0].length;
			previousNode = node;
		}
		if (position < sourceLine.length) {
			const sliced = sourceLine.slice(position);
			const trimmed = previousNode ? sliced.trimStart() : sliced;
			const text = previousNode?.type === "matrix" && /^\s/.test(sliced) ? ` ${trimmed}` : trimmed;
			layouts.push({ lines: [text], width: visibleWidth(text), baseline: 0 });
		}
		const lineLayout = joinLayouts(layouts);
		if (renderedLines.length === 0) {
			firstBaseline = lineLayout.baseline;
		}
		renderedLines.push(...lineLayout.lines);
	}
	return {
		lines: renderedLines,
		width: Math.max(0, ...renderedLines.map((line) => visibleWidth(line))),
		baseline: firstBaseline,
	};
}

// ---------- 解析器（pi :838-1477 移植；stackFractions 路径摘除——文件头修法口径①） ----------

class LatexParser {
	private readonly source: string;
	private readonly layoutNodes: LayoutNode[];
	private readonly display: boolean;
	private position = 0;
	private supported = true;
	private scriptDepth = 0;

	constructor(source: string, layoutNodes: LayoutNode[], display: boolean) {
		this.source = source;
		this.layoutNodes = layoutNodes;
		this.display = display;
	}

	render(): string | undefined {
		const rendered = this.parseSequence();
		if (!this.supported || this.position !== this.source.length) {
			return undefined;
		}
		return normalizeOutput(rendered);
	}

	private parseSequence(endCharacter?: string): string {
		let result = "";
		while (this.position < this.source.length) {
			const character = this.source[this.position];
			if (endCharacter && character === endCharacter) {
				this.position++;
				return result;
			}

			if (character === "}") {
				this.supported = false;
				return result;
			}

			if (character === "{") {
				this.position++;
				result += this.parseSequence("}");
				continue;
			}

			if (character === "\\") {
				const command = this.parseCommand();
				if (command === NEGATIVE_SPACE) {
					result = result.trimEnd();
					if (result.endsWith(NAMED_OPERATOR_END)) {
						result = result.slice(0, -NAMED_OPERATOR_END.length);
					}
				} else {
					result += command;
				}
				continue;
			}

			if (character === "^" || character === "_") {
				this.position++;
				result = result.trimEnd();
				const script = this.parseScripts(character);
				if (result.endsWith(NAMED_OPERATOR_END)) {
					result = `${result.slice(0, -NAMED_OPERATOR_END.length)}${script}${NAMED_OPERATOR_END}`;
				} else {
					result += script;
				}
				continue;
			}

			if (/\s/.test(character ?? "")) {
				result += this.parseWhitespace();
				continue;
			}

			if (character === "=" || character === "<" || character === ">") {
				result = `${result.trimEnd()} ${character} `;
				this.position++;
				continue;
			}

			if (character === "&") {
				this.position++;
				continue;
			}

			if (character === "~") {
				this.position++;
				result += " ";
				continue;
			}

			if (character === ".") {
				const marker = TRAILING_LAYOUT_MARKER_PATTERN.exec(result);
				const node = marker ? this.layoutNodes[Number(marker[1])] : undefined;
				if (node?.type === "matrix") {
					const lastLine = node.lines.length - 1;
					node.lines[lastLine] = `${node.lines[lastLine] ?? ""}${character}`;
					this.position++;
					continue;
				}
			}

			result += character;
			this.position++;
		}

		if (endCharacter) {
			this.supported = false;
		}
		return result;
	}

	private parseScripts(initialMarker: "^" | "_"): string {
		const scripts: { sub?: string; sup?: string } = {};
		const order: Array<"sub" | "sup"> = [];
		const parse = (marker: "^" | "_"): void => {
			const kind = marker === "_" ? "sub" : "sup";
			this.scriptDepth++;
			try {
				scripts[kind] = this.parseRequiredArgument();
			} finally {
				this.scriptDepth--;
			}
			order.push(kind);
		};

		parse(initialMarker);
		let nextPosition = this.position;
		while (nextPosition < this.source.length && /\s/.test(this.source[nextPosition] ?? "")) {
			nextPosition++;
		}
		const nextMarker = this.source[nextPosition];
		if ((nextMarker === "^" || nextMarker === "_") && nextMarker !== initialMarker) {
			this.position = nextPosition + 1;
			parse(nextMarker);
		}

		const subUnicode = scripts.sub === undefined ? undefined : formatUnicodeScript(scripts.sub, "sub");
		const supUnicode = scripts.sup === undefined ? undefined : formatUnicodeScript(scripts.sup, "sup");
		const canUseLayout = ![scripts.sub, scripts.sup].some(
			(value) =>
				value !== undefined &&
				(value.includes("/") ||
					(!value.includes(LAYOUT_MARKER_START) && Array.from(value).length > 1 && !/[A-Z*∗]/.test(value))),
		);
		const needsLayout =
			this.display &&
			canUseLayout &&
			(this.scriptDepth > 0 ||
				(scripts.sub !== undefined && subUnicode === undefined) ||
				(scripts.sup !== undefined && supUnicode === undefined));
		if (!needsLayout) {
			return order
				.map((kind) =>
					kind === "sub"
						? (subUnicode ?? formatScript(scripts.sub ?? "", kind))
						: (supUnicode ?? formatScript(scripts.sup ?? "", kind)),
				)
				.join("");
		}

		const index =
			this.layoutNodes.push({
				type: "script",
				lower: scripts.sub === undefined ? undefined : normalizeOutput(scripts.sub),
				upper: scripts.sup === undefined ? undefined : normalizeOutput(scripts.sup),
			}) - 1;
		return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
	}

	private parseWhitespace(): string {
		while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		return " ";
	}

	private parseCommand(): string {
		this.position++;
		if (this.position >= this.source.length) {
			this.supported = false;
			return "";
		}

		let command = "";
		const first = this.source[this.position] ?? "";
		if (first === "\n" || first === "\r") {
			this.position++;
			if (first === "\r" && this.source[this.position] === "\n") {
				this.position++;
			}
			return " ";
		}
		if (/[A-Za-z]/.test(first)) {
			const start = this.position;
			while (this.position < this.source.length && /[A-Za-z]/.test(this.source[this.position] ?? "")) {
				this.position++;
			}
			command = this.source.slice(start, this.position);
		} else {
			command = first;
			this.position++;
		}

		if (command === "\\") {
			return "\n";
		}
		if (SPACING_COMMANDS.has(command)) {
			return " ";
		}
		if (NEGATIVE_SPACING_COMMANDS.has(command)) {
			return NEGATIVE_SPACE;
		}
		if (FONT_SWITCH_COMMANDS.has(command)) {
			while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
				this.position++;
			}
			return "";
		}
		if (IGNORED_COMMANDS.has(command)) {
			return "";
		}
		if (
			command === "{" ||
			command === "}" ||
			command === "$" ||
			command === "%" ||
			command === "#" ||
			command === "_" ||
			command === "&"
		) {
			return command;
		}
		if (command === "|") {
			return "‖";
		}
		if (command === "not") {
			const value = this.parseRequiredArgument().trim();
			const negated = NEGATED_SYMBOLS[value];
			if (negated !== undefined) {
				return ` ${negated} `;
			}
			const characters = Array.from(value);
			if (characters.length === 0) {
				this.supported = false;
				return "";
			}
			return ` ${characters[0]}\u0338${characters.slice(1).join("")} `;
		}
		if (LIMIT_OPERATORS.has(command)) {
			return this.parseOperator(command, "bracket", true, true);
		}

		const symbol = SYMBOLS[command];
		if (symbol !== undefined) {
			if (DISPLAY_LIMIT_SYMBOLS.has(command)) {
				return this.parseOperator(symbol, "script", true);
			}
			return command === "cdot" || command === "times" || RELATION_COMMANDS.has(command) ? ` ${symbol} ` : symbol;
		}
		if (NAMED_OPERATORS.has(command)) {
			return `${NAMED_OPERATOR_START}${command}${NAMED_OPERATOR_END}`;
		}
		if (SIZE_COMMANDS.has(command)) {
			return "";
		}
		if (command === "left" || command === "middle" || command === "right") {
			if (this.source[this.position] === ".") {
				this.position++;
			}
			return "";
		}
		if (command === "frac" || command === "dfrac" || command === "tfrac") {
			// 单行线性化（pi 的 shouldStack 竖排堆叠路径整支摘除——display 也单行，T7 测试 2 钉）
			const numerator = this.parseRequiredArgument();
			const denominator = this.parseRequiredArgument();
			return formatFraction(numerator, denominator);
		}
		if (command === "sqrt") {
			const degree = this.parseOptionalArgument()?.trim();
			const value = this.parseRequiredArgument();
			if (degree === undefined || degree === "2") {
				return formatRoot(value);
			}
			if (degree === "3") {
				return formatRoot(value, "∛");
			}
			if (degree === "4") {
				return formatRoot(value, "∜");
			}
			return `${formatScript(degree, "sup")}${formatRoot(value)}`;
		}
		if (command === "boxed" || command === "fbox") {
			return `[${this.parseRequiredArgument().trim()}]`;
		}
		if (command === "binom" || command === "dbinom" || command === "tbinom") {
			return `(${this.parseRequiredArgument()} choose ${this.parseRequiredArgument()})`;
		}
		const accent = ACCENTS[command];
		if (accent !== undefined) {
			const value = this.parseRequiredArgument();
			return Array.from(value).length === 1 ? `${value}${accent}` : `${command}(${value})`;
		}
		if (command === "mathbb") {
			const value = this.parseRequiredArgument();
			return Array.from(value, (character) => BLACKBOARD[character] ?? character).join("");
		}
		if (command === "operatorname") {
			const starred = this.source[this.position] === "*";
			if (starred) {
				this.position++;
			}
			const operator = normalizeOutput(this.parseRequiredArgument()).trim();
			return this.parseOperator(operator, "bracket", starred, true);
		}
		if (command === "mod" || command === "bmod") {
			return " mod ";
		}
		if (command === "pmod" || command === "pod") {
			const value = this.parseRequiredArgument().trim();
			return command === "pmod" ? ` (mod ${value})` : ` (${value})`;
		}
		if (command === "overset" || command === "stackrel") {
			const upper = this.parseRequiredArgument();
			const value = this.parseRequiredArgument().trim();
			return `${value}${formatScript(upper, "sup")}`;
		}
		if (command === "underset") {
			const lower = this.parseRequiredArgument();
			const value = this.parseRequiredArgument().trim();
			return `${value}${formatScript(lower, "sub")}`;
		}
		if (PLAIN_WRAPPERS.has(command)) {
			const value = this.parseRequiredArgument();
			return command.startsWith("text") || command === "mbox" ? value : value.trim();
		}
		if (command === "begin") {
			return this.parseEnvironment();
		}
		if (command === "end") {
			this.supported = false;
			return "";
		}

		this.supported = false;
		return `\\${command}`;
	}

	private parseOperator(
		operator: string,
		inlineLowerStyle: "bracket" | "script",
		displayLimits: boolean,
		spaced = false,
	): string {
		let useDisplayLimits = displayLimits;
		let modifierPosition = this.position;
		while (modifierPosition < this.source.length && /[ \t]/.test(this.source[modifierPosition] ?? "")) {
			modifierPosition++;
		}
		const modifier = /^\\(limits|nolimits)(?![A-Za-z])/.exec(this.source.slice(modifierPosition));
		if (modifier) {
			useDisplayLimits = modifier[1] === "limits";
			this.position = modifierPosition + modifier[0].length;
		}

		let lower: string | undefined;
		let upper: string | undefined;
		while (true) {
			let scriptPosition = this.position;
			while (scriptPosition < this.source.length && /[ \t]/.test(this.source[scriptPosition] ?? "")) {
				scriptPosition++;
			}
			const kind = this.source[scriptPosition];
			if (kind !== "_" && kind !== "^") {
				break;
			}
			this.position = scriptPosition + 1;
			const value = normalizeOutput(this.parseRequiredArgument()).replaceAll(" ", "");
			if (kind === "_") {
				if (lower !== undefined) {
					this.supported = false;
				}
				lower = value;
			} else {
				if (upper !== undefined) {
					this.supported = false;
				}
				upper = value;
			}
		}

		if (this.display && useDisplayLimits && (lower !== undefined || upper !== undefined)) {
			const index = this.layoutNodes.push({ type: "operator", operator, lower, upper }) - 1;
			return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
		}

		let rendered = operator;
		if (lower !== undefined) {
			rendered += inlineLowerStyle === "bracket" ? `[${lower}]` : formatScript(lower, "sub");
		}
		if (upper !== undefined) {
			rendered += formatScript(upper, "sup");
		}
		return spaced ? ` ${rendered} ` : rendered;
	}

	private parseRequiredArgument(): string {
		return this.parseRequiredArgumentValue();
	}

	private parseRequiredArgumentValue(): string {
		while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		if (this.position >= this.source.length) {
			this.supported = false;
			return "";
		}
		if (this.source[this.position] === "{") {
			this.position++;
			return this.parseSequence("}");
		}
		if (this.source[this.position] === "\\") {
			return this.parseCommand();
		}
		const value = this.source[this.position] ?? "";
		this.position++;
		return value;
	}

	private parseOptionalArgument(): string | undefined {
		while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		if (this.source[this.position] !== "[") {
			return undefined;
		}
		const end = this.source.indexOf("]", this.position + 1);
		if (end < 0) {
			this.supported = false;
			return undefined;
		}
		const value = this.source.slice(this.position + 1, end);
		this.position = end + 1;
		return this.renderNested(value);
	}

	private readRawGroup(): string | undefined {
		while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
			this.position++;
		}
		if (this.source[this.position] !== "{") {
			this.supported = false;
			return undefined;
		}

		const start = ++this.position;
		let depth = 1;
		while (this.position < this.source.length) {
			const character = this.source[this.position];
			if (character === "\\") {
				this.position += 2;
				continue;
			}
			if (character === "{") depth++;
			if (character === "}") depth--;
			if (depth === 0) {
				const value = this.source.slice(start, this.position);
				this.position++;
				return value;
			}
			this.position++;
		}
		this.supported = false;
		return undefined;
	}

	private splitEnvironmentRows(body: string): string[] {
		return body.split(/\\\\(?:\[[^\]\n]*\])?/);
	}

	private parseEnvironment(): string {
		const environment = this.readRawGroup();
		if (!environment) {
			return "";
		}
		const endMarker = `\\end{${environment}}`;
		const end = this.source.indexOf(endMarker, this.position);
		if (end < 0) {
			this.supported = false;
			return "";
		}
		const body = this.source.slice(this.position, end);
		this.position = end + endMarker.length;

		if (environment === "equation" || environment === "equation*" || environment === "displaymath") {
			return this.renderNested(body).trim();
		}

		if (
			environment === "aligned" ||
			environment === "align" ||
			environment === "align*" ||
			environment === "alignedat" ||
			environment === "alignat" ||
			environment === "alignat*" ||
			environment === "gather" ||
			environment === "gathered" ||
			environment === "multline" ||
			environment === "multline*" ||
			environment === "split"
		) {
			const alignedAt = ["alignedat", "alignat", "alignat*"].includes(environment);
			const alignedBody = alignedAt ? body.replace(/^\s*\{[^}]*\}/, "") : body;
			return this.splitEnvironmentRows(alignedBody)
				.map((row) => {
					const cells = row.split("&");
					const source = alignedAt
						? Array.from({ length: Math.ceil(cells.length / 2) }, (_, index) =>
								cells.slice(index * 2, index * 2 + 2).join(""),
							).join(" ")
						: cells.join("");
					return this.renderNested(source).trim();
				})
				.filter(Boolean)
				.join("\n");
		}

		if (environment === "cases" || environment === "cases*") {
			return this.renderCases(body);
		}

		if (
			["array", "matrix", "smallmatrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix"].includes(environment)
		) {
			const matrixBody = environment === "array" ? body.replace(/^\s*\{[^}]*\}/, "") : body;
			return this.renderMatrix(environment, matrixBody);
		}

		this.supported = false;
		return body;
	}

	private renderCases(body: string): string {
		const rows = this.splitEnvironmentRows(body)
			.map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim()))
			.filter((row) => row.some(Boolean));
		const valueWidth = Math.max(0, ...rows.map((row) => visibleWidth((row[0] ?? "").replace(/,\s*$/, ""))));
		const contents = rows.map((row) => {
			const value = (row[0] ?? "").replace(/,\s*$/, "");
			const condition = row[1] ?? "";
			if (!condition) {
				return value;
			}
			const conditionPrefix = /^(?:if|when|for|otherwise)\b/i.test(condition) ? " " : " if ";
			return `${value}${PROTECTED_SPACE.repeat(valueWidth - visibleWidth(value))}${conditionPrefix}${condition}`;
		});
		if (contents.length <= 1) {
			return contents.length === 0 ? "" : `⎧ ${contents[0]}`;
		}

		const middle = Math.floor(contents.length / 2);
		const visualRows: Array<string | undefined> = [...contents];
		if (contents.length % 2 === 0) {
			visualRows.splice(middle, 0, undefined);
		}
		const lines = visualRows.map((content, index) => {
			const delimiter = index === 0 ? "⎧" : index === visualRows.length - 1 ? "⎩" : "⎨";
			return content === undefined ? delimiter : `${delimiter} ${content}`;
		});
		const index = this.layoutNodes.push({ type: "matrix", lines, baseline: middle }) - 1;
		return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
	}

	private renderMatrix(environment: string, body: string): string {
		const matrix = this.splitEnvironmentRows(body)
			.map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim()))
			.filter((row) => row.some(Boolean));
		const columnCount = Math.max(0, ...matrix.map((row) => row.length));
		const columnWidths = Array.from({ length: columnCount }, (_, column) =>
			Math.max(0, ...matrix.map((row) => visibleWidth(row[column] ?? ""))),
		);
		const rows = matrix.map((row) =>
			Array.from({ length: columnCount }, (_, column) => {
				const cell = row[column] ?? "";
				return `${cell}${PROTECTED_SPACE.repeat(Math.max(0, (columnWidths[column] ?? 0) - visibleWidth(cell)))}`;
			}).join(" │ "),
		);

		let lines: string[];
		if (environment === "array" || environment === "matrix" || environment === "smallmatrix") {
			lines = rows;
		} else {
			const delimiters: Readonly<Record<string, readonly [string, string, string, string, string, string]>> = {
				pmatrix: ["⎛", "⎞", "⎜", "⎟", "⎝", "⎠"],
				bmatrix: ["⎡", "⎤", "⎢", "⎥", "⎣", "⎦"],
				Bmatrix: ["⎧", "⎫", "⎨", "⎬", "⎩", "⎭"],
				vmatrix: ["│", "│", "│", "│", "│", "│"],
				Vmatrix: ["║", "║", "║", "║", "║", "║"],
			};
			const delimiter = delimiters[environment];
			if (!delimiter) {
				this.supported = false;
				return rows.join("\n");
			}
			lines = rows.map((row, index) => {
				const left = index === 0 ? delimiter[0] : index === rows.length - 1 ? delimiter[4] : delimiter[2];
				const right = index === 0 ? delimiter[1] : index === rows.length - 1 ? delimiter[5] : delimiter[3];
				return `${left} ${row} ${right}`;
			});
		}

		if (lines.length <= 1) {
			return lines[0] ?? "";
		}
		const index = this.layoutNodes.push({ type: "matrix", lines, baseline: 0 }) - 1;
		return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
	}

	private renderNested(source: string, display = this.display): string {
		const rendered = new LatexParser(source, this.layoutNodes, display).render();
		if (rendered === undefined) {
			this.supported = false;
			return source;
		}
		return rendered;
	}
}

// ---------- 导出面（pi :1479-1506 移植） ----------

export interface RenderLatexOptions {
	/** display 数学（块级）：算符上下标走多行布局。分式恒单行（竖排路径已摘除）。 */
	display?: boolean;
}

/** 把基础 LaTeX 数学式渲染为终端友好的 Unicode 文本。
 *  含不支持或畸形语法时返回 undefined（调用方回退原文，判空用 `??`——不是 `=== null`）。
 *  开关关闭（setLatexEnabled(false)）时恒 undefined = 原样透传。 */
export function renderLatex(source: string, options: RenderLatexOptions = {}): string | undefined {
	if (!latexEnabled) return undefined;
	const layoutNodes: LayoutNode[] = [];
	const rendered = new LatexParser(source, layoutNodes, options.display === true).render();
	if (rendered === undefined) {
		return undefined;
	}
	if (layoutNodes.length === 0) {
		return rendered.replaceAll(PROTECTED_SPACE, " ");
	}
	const lines = renderLayout(rendered, layoutNodes).lines;
	const indentation = Math.min(
		...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
	);
	return lines
		.map((line) => line.slice(indentation).trimEnd())
		.join("\n")
		.trimEnd()
		.replaceAll(PROTECTED_SPACE, " ");
}

/* 原件版权注记（pi 仓库 packages/tui/src/latex.ts 与 packages/tui/src/components/markdown.ts，MIT License）：
 *   Copyright (c) the pi authors. MIT License.
 *   Ported for Orosus mdpipe (task T7, 2026-09-22) with the stacked-fraction
 *   path removed (single-line fractions only) and the pending-token mechanism
 *   omitted (unclosed delimiters simply do not match). */
