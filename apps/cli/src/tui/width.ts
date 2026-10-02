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

/** RGI emoji 序列（ES2024 v 模式属性——pi rgiEmojiRegex 同款）：ZWJ 家族/旗帜对/键帽/肤色/
 *  彩虹旗 tag 全按「一个序列 2 列」计。多码点 cluster 终端合成一格半（2 列），逐码点累加会
 *  虚报 6~8 列。单码点 basic emoji（✅❌⭐ 一族）同属 RGI 集——2026-10-01 滚动条顶飞事故根因：
 *  U+2705 等 BMP 散点 emoji 呈现字符不在 eawWide 区间表（表只盖 CJK/全角/1F000+ 平面）被记
 *  1 列、终端实画 2 列，一行 N 个账面少 N 列把行尾滚动条顶出 N 列（八仓调研：pi/cc-haha 用
 *  get-east-asian-width+emoji-regex、Reasonix/dsh 用 \p{Emoji_Presentation}，唯自建表漏此段）。
 *  构造式而非字面量：v flag 的属性序列类要 tsconfig target ES2024，base 是 ES2023（为一枚
 *  正则升全仓 target 越圈地纪律）；TS 不静态检查构造式 flag，Node 20+ 运行时原生支持。 */
const RGI_EMOJI_RE = new RegExp("^\\p{RGI_Emoji}$", "v");
/** RGI 预筛（pi couldBeEmoji 同构）：纯区间/长度判定，避免对每个 grapheme 跑昂贵正则。
 *  段宽进严出（盖未来 Unicode 增补）；CJK 大头不在段内 → 常规文本零正则开销。 */
function couldBeEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0)!;
	return (
		(cp >= 0x2300 && cp <= 0x23ff) || // Misc technical（⏰⏳ 族）
		(cp >= 0x25a0 && cp <= 0x27bf) || // 几何图形 + Misc symbols/dingbats（✅❌⭐ 族）
		(cp >= 0x2b00 && cp <= 0x2bff) || // 箭头星族（⭐⭕）
		(cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji and Pictograph
		segment.includes("\uFE0F") || // 含 VS16（emoji 呈现选择符）
		segment.length > 2 // 多码点 cluster（ZWJ/肤色/键帽等序列）
	);
}

/** 零宽/记号属性集（2026-10-01 属性化——旧手工表只盖希腊组合段 0300-036F+ZW+20E3，泰/老挝/
 *  天城文/阿拉伯组合记号、SHY、BOM、WJ 全漏判 1 列；对齐 pi zeroWidthRegex（\p{Mark}|
 *  \p{Control}|\p{Cf}|\p{Cs}）与 Reasonix ZERO_WIDTH（\p{Mn}\p{Me}\p{Cf}）并集语义。VS 区
 *  FE00-FE0F/Mongolian FVS/VS 补充平面 E0100+ 本身是 \p{Mn}，属性自带；孤立代理（流式
 *  chunk 劈开 UTF-16 对的坏数据）按零宽计不占格。取舍：pi 对 \p{Spacing_Mark} 例外 +1 格
 *  （legacy wcwidth 表占格的那几个），cc-haha/Bun/wcwidth 派全 0——终端实画按 wcwidth，
 *  账本从终端，天城文 गि/泰文ที่ 全按 1 格计。 */
const ZERO_WIDTH_RE = /[\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Cs}]/u;

/** 单 grapheme 显示宽：tab=3；RGI emoji 序列整体 2；全角 2；组合符/ZW/控制符 0；
 *  ambiguous=1 政策，VS16 升 2。 */
function graphemeWidth(g: string): number {
	if (g === "\t") return 3;
	if (couldBeEmoji(g) && RGI_EMOJI_RE.test(g)) return 2;
	const cp = g.codePointAt(0);
	if (cp === undefined) return 0;
	if (eawWide(cp)) return 2;
	let w = ZERO_WIDTH_RE.test(g[0]!) ? 0 : 1;
	for (const ch of [...g].slice(1)) {
		const c = ch.codePointAt(0)!;
		if (c === 0xfe0f) w = 2; // VS16 emoji 呈现 → 宽 2（非 RGI 的 ✓️ 一族也升 2——政策保留）
		else if (!ZERO_WIDTH_RE.test(ch) && eawWide(c)) w += 2; // 尾部残余宽字符兜底（合法 cluster 罕见）
	}
	return w;
}

/** 逐 grapheme 段（text + 显示宽）——输入区折行/光标定位的累计口径（CTU-04 2026-09-28：
 *  与 visibleWidth 同一 grapheme/EAW 权威；fullapp 原私有 cpw 按首码点区间计宽，两口径在
 *  VS16 emoji（❤️ 3/2）/谚文 Jamo（1/2）/ZWJ 家族（8/2）/tab（1/3）四类分歧 → 折行点与
 *  硬件光标列错位——本出口即唯一计宽权威的逐段形态）。 */
export function graphemeSpans(str: string): { text: string; w: number }[] {
	const spans: { text: string; w: number }[] = [];
	for (const { segment } of segmenter.segment(str)) spans.push({ text: segment, w: graphemeWidth(segment) });
	return spans;
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
		// CTW-07（2026-09-28）：按可见内容判定收尾（与 emit() 收尾口径一致——补 resetSuffix 防裸色串色）。
		// 旧 `cur !== ""` 字符串判定：断点空格被吞后 cur 只剩 SGR 前缀（零可见宽）→ 推出幽灵空行；
		// 输入非自闭合（裸色码）时该行无 reset 收尾还会把颜色漏到下一逻辑行
		if (stripAnsi(cur) !== "" || out.length === 0) out.push(cur + tracker.resetSuffix());
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

/** 右填充空格到目标宽（面板排版用；超宽转截断）。
 *  截断后回填（2026-10-02 引导窗框线错位走查）：截点落宽字中间时整字让位会短 1~2 格——
 *  box 行右框线随内容长短左右漂移（账面 95 ≠ 96 实锤）；契约是「恒等于目标宽」，短多少补多少。 */
export function padToWidth(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) {
		const cut = truncateToWidth(text, width);
		const short = width - visibleWidth(cut);
		return short > 0 ? cut + " ".repeat(short) : cut;
	}
	return text + " ".repeat(width - w);
}

/** 抽取显示列区间 [startCol, startCol+len)（overlay 合成/选区切分用——pi sliceByColumn 同构）。
 *  CTW-03（2026-09-28）对齐 pi sliceWithWidth 双机制：
 *  ① 计入条件严格化（起点前跨界宽字符不再双端计入）——旧相交语义 `col+gw > startCol` 把起点在
 *    startCol 之前的宽字符同时计入前后两段（「汉abc」切 [0,1)+[1,3) 合计 6 > 窗宽 4，选区反白
 *    同字两屏、行宽虚增界面错位）；严格语义 = 起点 col ∈ [startCol, startCol+len) 才计入，截点落
 *    宽字中间时整字让位（truncateToWidth 同款口径，fullapp 滚动条路径 2026-09-27 走查拍板）。
 *  ② 起点前的 ANSI 累积为 pending、随首个入列内容前回放（pi pendingAnsi 同构）——mid/after 段
 *    不再丢切点前的着色上下文（拖选经过 dim/彩色行右侧掉色、overlay 右侧掉色）。 */
export function sliceByColumn(line: string, startCol: number, len: number): string {
	let out = "";
	let col = 0;
	let i = 0;
	let leaked = "";
	let pending = ""; // startCol 前的 ANSI（含 OSC 8 链接态）——首个入列内容前整段回放
	while (i < line.length) {
		const a = extractAnsiCode(line, i);
			if (a) {
				if (col >= startCol) {
					if (out === "" && pending !== "") {
						out += pending;
						pending = "";
					}
					out += a.code;
				} else {
					pending += a.code;
				}
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
		if (col >= startCol && col < startCol + len) {
			if (out === "" && pending !== "") {
				out += pending;
				pending = "";
			}
			out += g;
		}
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

/** OSC 8 超链接探测（m5 鼠标批 T7——kimi utils.ts:344-366 精简）：扫渲染行的 ANSI 码，遇
 *  \x1b]8;;URI\x07 设「当前链接」，指针列落在其文本上即返回 URI——只认行内 OSC 8 码（自产自销，
 *  与终端支持无关；决策点 16 不做裸文本正则兜底）。 */
export function osc8LinkAtColumn(line: string, column: number): string | undefined {
	let active: string | undefined;
	let col = 0;
	let i = 0;
	while (i < line.length) {
		const a = extractAnsiCode(line, i);
		if (a !== null) {
			// eslint-disable-next-line no-control-regex -- OSC 转义序列本身含控制字符
			const m = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(a.code);
			if (m !== null) active = m[1] === "" ? undefined : m[1]; // 空参数闭对 = 链接结束
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
		if (col <= column && column < col + gw) return active;
		col += gw;
		i += g.length;
	}
	return undefined;
}
