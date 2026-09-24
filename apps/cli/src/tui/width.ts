/** 显示宽与折行（TUI 批阶段三 F0——pi-tui utils.ts 精简移植，spike 验证件）。
 *  蓝本：pi `utils.ts` visibleWidth(:248)/wrapTextWithAnsi(:851)——差异三处（零依赖约束）：
 *  ① pi 引 npm 包 get-east-asian-width 查 EAW，本件用内置区间表（与 ansi.ts 同口径扩 VS16）；
 *  ② grapheme 切分走 node 内置 Intl.Segmenter；③ emoji 保守宽 2、ambiguous=1（Orosus 已定政策）。
 *  折行口径：ANSI 状态跨行延续（AnsiTracker——换行处把激活的 SGR 前缀带入下一行，防色漏防串色）。 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 提取 pos 处的 ANSI/OSC/APC 转义序列（pi extractAnsiCode 同构）。 */
export function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
	if (pos >= str.length || str[pos] !== "\x1b") return null;
	const next = str[pos + 1];
	if (next === "[" || next === "]" || next === "_") {
		const isCsi = next === "[";
		let j = pos + 2;
		while (j < str.length) {
			const ch = str[j]!;
			if (isCsi) {
				const c = ch.charCodeAt(0);
				if (c >= 0x40 && c <= 0x7e) return { code: str.substring(pos, j + 1), length: j + 1 - pos };
			} else if (ch === "\x07") {
				return { code: str.substring(pos, j + 1), length: j + 1 - pos };
			} else if (ch === "\x1b" && str[j + 1] === "\\") {
				return { code: str.substring(pos, j + 2), length: j + 2 - pos };
			}
			j++;
		}
		return null;
	}
	return null;
}

/** 剥除全部终端序列（CSI/OSC/APC），保可见文本。 */
export function stripAnsi(str: string): string {
	if (!str.includes("\x1b")) return str;
	let out = "";
	let i = 0;
	while (i < str.length) {
		const a = extractAnsiCode(str, i);
		if (a) i += a.length;
		else out += str[i++];
	}
	return out;
}

/** 单码点 EAW 判定：全角区间 = 2（Orosus ansi.ts 区间表同口径）。 */
function eawWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f000 && cp <= 0x1faff) || // emoji 平面（U+1F300–U+1FAFF 在 U+20000 之下！F0 测试实锤）
		cp >= 0x20000 // CJK 扩展 B+
	);
}

/** 单 grapheme 显示宽：tab=3；组合符/ZW 零宽；全角/emoji=2（ambiguous=1 政策，VS16 升 2）。 */
function graphemeWidth(g: string): number {
	if (g === "\t") return 3;
	const cp = g.codePointAt(0);
	if (cp === undefined) return 0;
	if (eawWide(cp)) return 2;
	let w = 1;
	for (const ch of [...g].slice(1)) {
		const c = ch.codePointAt(0)!;
		if (c === 0xfe0f) w = 2; // VS16 emoji 呈现 → 宽 2
		else if ((c >= 0x0300 && c <= 0x036f) || (c >= 0x200b && c <= 0x200f) || c === 0x20e3) w += 0; // 组合符/ZW
		else if (eawWide(c)) w += 2;
	}
	return w;
}

const isAsciiPrintable = (s: string): boolean => {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x20 || c > 0x7e) return false;
	}
	return true;
};

/** 可见宽（剥转义、grapheme 计宽）。 */
export function visibleWidth(str: string): number {
	if (str.length === 0) return 0;
	const clean = str.includes("\x1b") ? stripAnsi(str) : str;
	if (isAsciiPrintable(clean)) return clean.length;
	let w = 0;
	for (const { segment } of segmenter.segment(clean)) w += graphemeWidth(segment);
	return w;
}

/** ANSI 状态跟踪：折行/截断时把激活的 SGR 状态带入下一行（pi AnsiCodeTracker 同构精简）。
 *  只认 SGR（…m）：\x1b[0m 清空，fg 39m/bg 49m 各自独立复位（与 theme.ts 的新收尾口径配套）。 */
class AnsiTracker {
	private active = "";
	feed(text: string): void {
		let i = 0;
		while (i < text.length) {
			const a = extractAnsiCode(text, i);
			if (!a) {
				i++;
				continue;
			}
			i += a.length;
			// 终端代码合法形态：SGR 判定正则必须含 ESC 控制符（lint 基线批定点豁免）
			// oxlint-disable-next-line no-control-regex
			if (/^\x1b\[[0-9;]*m$/.test(a.code)) {
				if (a.code === "\x1b[0m") this.active = "";
				else this.active += a.code;
			}
		}
	}
	prefix(): string {
		return this.active;
	}
	resetSuffix(): string {
		return this.active ? "\x1b[0m" : "";
	}
}

/** 词字符连跑（ASCII 词原子：URL/标识符/路径整体为一个断行单元——F5 六轮用户实测
 *  「c|heck:boundaries」「生成物|diff」被劈半即此）。 */
const WORD_RUN = /[A-Za-z0-9_./:@#$%&+=~^!?*"-]+/y;

/** CJK 禁则字表（2026-09-24 用户拍板——「名字（长URL）」段落行尾孤「（」+ URL 整词掉行乱象）。
 *  行尾禁则 = 开括号类不许收尾（断点回退到括号之前，括号随下文下移）；行首禁则 = 闭排印类不许开头
 *  （把上一断行单元带下去）。参照仓调研（kimi/cc-haha/qwen/opencode/Reasonix/pi/dsh）无一实现——
 *  cc-haha/qwen 用 wrap-ansi 硬切（URL 劈半）、Reasonix 用 ansi.Hardwrap 同病；此为标准中文排版
 *  禁则，自研补齐、不抄硬切。 */
const OPEN_NO_END = /[（［｛「『《【([{]/;
const CLOSE_NO_START = /[）］｝】〕」』》】，。、；：！？…—·~)\]},;:.!?]/;
/** ANSI 序列收尾（链接/样式边界）——回拉会切破坏样式配对，保守跳过禁则。
 *  终端代码合法形态：匹配 ANSI 必须含 ESC 控制符（lint 基线批定点豁免，同 extractAnsiCode）。 */
// oxlint-disable-next-line no-control-regex
const ANSI_TAIL = /(?:\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

/** 折行：按显示宽折，ANSI 状态跨行延续。断行单元 = ASCII 词连跑（原子）或单 grapheme
 *  （CJK/宽标点/emoji）——词不劈半、CJK 逐字可断（标准中西文混排口径，F5 六轮重写）；
 *  叠加 CJK 禁则回拉（开括号不收尾、闭排印不开头，2026-09-24）。 */
export function wrapText(text: string, width: number): string[] {
	const w = Math.max(1, width);
	const out: string[] = [];
	for (const logical of text.split("\n")) {
		if (visibleWidth(logical) <= w) {
			out.push(logical);
			continue;
		}
		const tracker = new AnsiTracker();
		let cur = "";
		let curW = 0;
		let i = 0;
		const lineUnits: { text: string; w: number }[] = []; // 当前行已装填单元（禁则回拉用）
		const emit = (): void => {
			out.push(cur.replace(/ +$/, "") + tracker.resetSuffix());
			cur = tracker.prefix();
			curW = 0;
			lineUnits.length = 0;
		};
		const popUnit = (): { text: string; w: number } | undefined => {
			if (ANSI_TAIL.test(cur)) return undefined; // ANSI 收尾——不回拉
			const last = lineUnits[lineUnits.length - 1];
			if (last === undefined || last.text === "" || !cur.endsWith(last.text)) return undefined;
			cur = cur.slice(0, cur.length - last.text.length);
			curW -= last.w;
			lineUnits.pop();
			return last;
		};
		while (i < logical.length) {
			const a = extractAnsiCode(logical, i);
			if (a) {
				cur += a.code;
				tracker.feed(a.code);
				i += a.length;
				continue;
			}
			// 单元：ASCII 词连跑优先，否则单 grapheme
			WORD_RUN.lastIndex = i;
			const wr = WORD_RUN.exec(logical);
			let gEnd = i + 1;
			let isWordRun = false;
			if (wr !== null && wr[0].length > 1) {
				gEnd = i + wr[0].length;
				isWordRun = true;
			} else {
				const rest = logical.slice(i);
				for (const { segment } of segmenter.segment(rest)) {
					gEnd = i + segment.length;
					break;
				}
			}
			const g = logical.slice(i, gEnd);
			const gw = visibleWidth(g);
			if (gw > w && g.length > 1) {
				// 单词自身超行宽（超长 URL）——退化为逐 grapheme 折，不再整词溢出
				if (curW > 0) emit();
				for (const { segment } of segmenter.segment(g)) {
					const sw = visibleWidth(segment);
					if (curW + sw > w && curW > 0) emit();
					cur += segment;
					curW += sw;
					lineUnits.push({ text: segment, w: sw });
				}
				i = gEnd;
				continue;
			}
			if (curW + gw > w && curW > 0) {
				// 禁则回拉（2026-09-24）：行尾开括号随下文下移；行首闭排印带上前一个单元下移。
				const carry: { text: string; w: number }[] = [];
				while (lineUnits.length > 0 && OPEN_NO_END.test(lineUnits[lineUnits.length - 1]!.text)) {
					const u = popUnit();
					if (u === undefined) break;
					carry.unshift(u);
				}
				if (carry.length === 0 && !isWordRun && lineUnits.length > 0 && CLOSE_NO_START.test(g)) {
					const u = popUnit();
					if (u !== undefined) carry.push(u);
				}
				emit();
				for (const cu of carry) {
					cur += cu.text;
					curW += cu.w;
					lineUnits.push(cu);
				}
				if (g === " ") {
					// 断点正好落在空格——行首吞掉
					i = gEnd;
					continue;
				}
				if (curW + gw > w && curW > 0) emit(); // carry 后仍装不下（URL 近满宽的罕见边界）——g 独占下行
			}
			cur += g;
			curW += gw;
			lineUnits.push({ text: g, w: gw });
			i = gEnd;
		}
		if (cur !== "" || out.length === 0) out.push(cur);
	}
	return out.length > 0 ? out : [""];
}

/** 截断到显示宽（末尾补 reset 防色漏）。 */
export function truncateToWidth(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	let out = "";
	let w = 0;
	let i = 0;
	let leaked = "";
	while (i < text.length) {
		const a = extractAnsiCode(text, i);
			if (a) {
				out += a.code;
				if (a.code.endsWith("m")) leaked = a.code === "\x1b[0m" ? "" : "\x1b[0m";
				i += a.length;
				continue;
			}
			const rest = text.slice(i);
		let g = rest[0]!;
		for (const { segment } of segmenter.segment(rest)) {
			g = segment;
			break;
		}
		const gw = graphemeWidth(g);
		if (w + gw > maxWidth) break;
		out += g;
		w += gw;
		i += g.length;
	}
	return out + leaked;
}

/** 右填充空格到目标宽（面板排版用；超宽转截断）。 */
export function padToWidth(text: string, width: number): string {
	const w = visibleWidth(text);
	return w >= width ? truncateToWidth(text, width) : text + " ".repeat(width - w);
}

/** 抽取显示列区间 [startCol, startCol+len)（overlay 合成用——pi sliceByColumn 同构精简）。 */
export function sliceByColumn(line: string, startCol: number, len: number): string {
	let out = "";
	let col = 0;
	let i = 0;
	let leaked = "";
	while (i < line.length) {
		const a = extractAnsiCode(line, i);
			if (a) {
				if (col >= startCol) out += a.code;
				if (a.code.endsWith("m")) leaked = a.code === "\x1b[0m" ? "" : "\x1b[0m";
			i += a.length;
			continue;
		}
		const rest = line.slice(i);
		let g = rest[0]!;
		for (const { segment } of segmenter.segment(rest)) {
			g = segment;
			break;
		}
		const gw = graphemeWidth(g);
		if (col + gw > startCol && col < startCol + len) out += g;
		col += gw;
		if (col >= startCol + len) break;
		i += g.length;
	}
	return out + leaked;
}

/** 多行总视觉行数（滚动流活动区记账用）。 */
export function dispLines(text: string, columns: number): number {
	const c = Math.max(1, columns);
	return text
		.split("\n")
		.reduce((n, l) => n + Math.max(1, Math.ceil(visibleWidth(l) / c)), 0);
}
