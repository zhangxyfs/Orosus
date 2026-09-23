/** 工具明细视图（2026-09-23 走查批——工具行 diff/错误体的纯函数面，DocModel 渲染期调用）。
 *  形态（2026-09-23 二轮走查拍板，kimi/pi 同族）：行号栏暗色 + 删行 err 文字 / 增行 accent 文字
 *  （不铺底色）、公共前导缩进剥除、tab 展开为 2 空格（tab 在终端是变宽跳格——visibleWidth 计 1
 *  而终端跳到 8 倍数列，实宽漂移把面板行冲破的前案）、超宽折行归渲染层。
 *  数据源 = tool/call 事件的 args（tool-fs__edit 的 edits[].oldText/newText、tool-fs__write 的
 *  content）与 tool/result 的 output（失败体）——此前在 renderEvent 被压成一行文本丢失。 */

/** diff 行：ctx 上下文 / del 删除 / add 新增 / gap 省略隔断；no = 块内 1 基行号（删行与上下文按
 *  旧文本计、增行按新文本计——真实文件行号调用面不可得，登记为已知口径）。 */
export interface DiffRow {
	tag: "ctx" | "del" | "add" | "gap";
	no: number;
	text: string;
}

/** tab → 2 空格（终端跳格变宽，计宽与实显必漂移）；剥行尾空白。 */
function cleanLine(l: string): string {
	return l.replace(/\t/g, "  ").trimEnd();
}

/** 剥除一组行的公共前导空白（deep indent 白占流区宽——二轮走查图2 拍板）；gap 行不参与。 */
function dedent(rows: DiffRow[]): DiffRow[] {
	let common = Infinity;
	for (const r of rows) {
		if (r.tag === "gap" || r.text.trim() === "") continue;
		const m = /^ */.exec(r.text)!;
		common = Math.min(common, m[0].length);
	}
	if (common === Infinity || common === 0) return rows;
	return rows.map((r) => (r.tag === "gap" ? r : { ...r, text: r.text.slice(common) }));
}

/** 单处替换 → diff 行：公共前缀/后缀作上下文（各留 ≤3 行——kimi/zcode/cc-haha/reasonix 四家同口径，
 *  超出以 gap 隔断），中段旧删新增。 */
export function editDiffRows(oldText: string, newText: string): DiffRow[] {
	const oldLines = oldText.split("\n").map(cleanLine);
	const newLines = newText.split("\n").map(cleanLine);
	let pre = 0;
	while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
	let suf = 0;
	while (
		suf < oldLines.length - pre &&
		suf < newLines.length - pre &&
		oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
	)
		suf++;
	const rows: DiffRow[] = [];
	const CTX = 3;
	const preShown = Math.min(pre, CTX);
	if (pre > preShown) rows.push({ tag: "gap", no: 0, text: `… 上方 ${pre - preShown} 行相同` });
	for (let i = pre - preShown; i < pre; i++) rows.push({ tag: "ctx", no: i + 1, text: oldLines[i]! });
	for (let i = pre; i < oldLines.length - suf; i++) rows.push({ tag: "del", no: i + 1, text: oldLines[i]! });
	for (let i = pre; i < newLines.length - suf; i++) rows.push({ tag: "add", no: i + 1, text: newLines[i]! });
	const sufShown = Math.min(suf, CTX);
	for (let j = 0; j < sufShown; j++) {
		const idx = oldLines.length - sufShown + j;
		rows.push({ tag: "ctx", no: idx + 1, text: oldLines[idx]! });
	}
	if (suf > sufShown) rows.push({ tag: "gap", no: 0, text: `… 下方 ${suf - sufShown} 行相同` });
	return dedent(rows);
}

/** 工具调用 → diff 行（无 diff 形态的工具 → undefined——Read/Bash 等保持单行）。
 *  edit：edits 数组逐处展开，多处之间 gap 隔断；write：content 全量增行（去尾空段）。 */
export function toolDiffRows(name: string, args: Record<string, unknown> | undefined): DiffRow[] | undefined {
	const tail = name.includes("__") ? name.split("__").pop()! : name;
	if (tail === "edit") {
		const edits = Array.isArray(args?.edits) ? args.edits : [];
		const rows: DiffRow[] = [];
		for (const e of edits) {
			const o = (e as { oldText?: unknown }).oldText;
			const n = (e as { newText?: unknown }).newText;
			if (typeof o !== "string" || typeof n !== "string") continue;
			if (rows.length > 0) rows.push({ tag: "gap", no: 0, text: "⋯" });
			rows.push(...editDiffRows(o, n));
		}
		return rows.length > 0 ? rows : undefined;
	}
	if (tail === "write") {
		const content = typeof args?.content === "string" ? args.content : "";
		const lines = content.split("\n").map(cleanLine).filter((_, i, arr) => i < arr.length - 1 || arr[i] !== ""); // 去尾空段（tool-fs read 同口径）
		if (lines.length === 0) return undefined;
		return dedent(lines.map((l, i) => ({ tag: "add" as const, no: i + 1, text: l })));
	}
	return undefined;
}

/** 变更统计（chip 数据源——二轮走查图4 拍板：Write/Edit 的行数按内容算，不按结果文案算；
 *  结果 output 是「已写入 path（70B）」一行，「· 1 行」误导）。edit → 增/删行数；write → 内容行数。 */
export function toolChangeStats(
	name: string,
	args: Record<string, unknown> | undefined,
): { adds: number; dels: number; lines: number } | undefined {
	const rows = toolDiffRows(name, args);
	if (rows === undefined) return undefined;
	const adds = rows.filter((r) => r.tag === "add").length;
	const dels = rows.filter((r) => r.tag === "del").length;
	return { adds, dels, lines: adds + dels };
}

/** 失败体 → 可读行：JSON 壳剥掉（message/error/msg/reason/detail 递归取值），取不到回退紧凑串；
 *  非 JSON 原文逐行。错误行不再把原始 JSON 拍屏（走查拍板：错误信息需解析后呈现）。 */
export function errorLines(output: unknown): string[] {
	let text = typeof output === "string" ? output : String(output ?? "");
	const t = text.trim();
	if (t.startsWith("{") || t.startsWith("[")) {
		let msg = parseMessage(t);
		if (msg === undefined && t.includes("\n")) {
			// 首行 JSON 壳 + 后续原文行（堆栈等）——只剥首行
			const nl = t.indexOf("\n");
			const head = parseMessage(t.slice(0, nl));
			if (head !== undefined) msg = head + t.slice(nl);
		}
		if (msg !== undefined) text = msg;
	}
	const lines = text.split("\n").map(cleanLine);
	return lines.filter((l, i) => i < lines.length - 1 || l !== "");
}

function parseMessage(t: string): string | undefined {
	try {
		return pickMessage(JSON.parse(t), 0);
	} catch {
		return undefined; // 非合法 JSON——原文兜底
	}
}

function pickMessage(v: unknown, depth: number): string | undefined {
	if (depth > 4 || v === null || typeof v !== "object") return undefined;
	const o = v as Record<string, unknown>;
	for (const k of ["message", "msg", "reason", "detail"]) {
		if (typeof o[k] === "string" && o[k] !== "") return o[k] as string;
	}
	if (typeof o.error === "string" && o.error !== "") return o.error;
	const inner = pickMessage(o.error, depth + 1);
	if (inner !== undefined) return inner;
	try {
		return JSON.stringify(v);
	} catch {
		return undefined;
	}
}

/** Write 内容预览数据源（2026-09-23 三轮走查拍板，kimi 形态：Write 展示 = dim 行号 + 语法高亮正文、
 *  无 +/- 记号——与 Edit 的 diff 形态区分；内容即新增，标 + 是纯噪音）。 */
export function writeContentFor(
	name: string,
	args: Record<string, unknown> | undefined,
): { path: string; content: string } | undefined {
	const tail = name.includes("__") ? name.split("__").pop()! : name;
	if (tail !== "write") return undefined;
	const content = typeof args?.content === "string" ? args.content : "";
	if (content === "") return undefined;
	const path = args !== undefined && typeof args.path === "string" ? args.path : "";
	return { path, content };
}

/** 扩展名 → hljs 语言名（cli-highlight supportsLanguage 口径——kimi code-highlight.ts 同族映射）；
 *  未命中 → undefined（纯文本原样）。 */
const EXT_LANG: Record<string, string> = {
	ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
	js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
	json: "json", md: "markdown", py: "python", sh: "bash", yaml: "yaml", yml: "yaml",
	toml: "ini", css: "css", html: "xml", xml: "xml", vue: "xml",
	go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", cs: "csharp", sql: "sql",
};
export function langForPath(path: string): string | undefined {
	const m = /\.([a-z0-9]+)$/i.exec(path);
	return m === null ? undefined : EXT_LANG[m[1]!.toLowerCase()];
}
