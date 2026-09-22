/** 流式渲染（稳定前缀冻结——mdpipe 批 T2：冻结点判定从手写字符扫描升到 marked token 边界）。
 *  基线策略 = cc-haha（Markdown.tsx:186-233）：从冻结点起 lex，尾前 space 跳过，最后一个非
 *  space token 视为生长中的块、其之前全部冻结（单调只进不退）；marked 把未闭合围栏（```/~~~/
 *  缩进围栏）天然留作单个 token，块边界永远安全——旧 stableCut 只认行首三反引号，~~~ 围栏内的
 *  空行被当冻结点劈块、后半段成裸段落且终态定格错误（P0-② 根治即此）。
 *  加固三件：① 完整闭合的 code token 即刻计入冻结（「闭合即定格着色」——T1 transient 钉的
 *  观察前提）；② 引用式链接定义守卫（opencode 同式正则 + 行首 [ 潜在定义半截加固——本仓
 *  持久冻结面下，逐字到达的中间态也须护住）；③ trimPartialClosingFences（pi markdown.ts
 *  移植）：末尾半截闭合围栏从 token 内容修掉，防闭合围栏逐字到达时代码块高度抖动。 */
import type { Token, Tokens } from "marked";
import { lex } from "./lex.ts";
import { renderLines, renderTokens } from "./blocks.ts";

export interface StreamingMarkdown {
	render(full: string): string[]; // 返回已按 width 折行的物理行
}

/** 引用式链接定义完整形态（opencode markdown-stream.ts 同式——设计空白 #9）。 */
const REF_DEF = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:\S+|\r?\n[ \t]+\S+)/m;

/** 冻结前进守卫：未稳定尾含完整定义或「行首 [ 起头的潜在定义半截」→ 本轮不前进。
 *  机理：后到的定义会改变前面链接的渲染，定义到齐（或确定不是定义）前整段不冻结。 */
function holdsForRefDefs(unstable: string): boolean {
	if (!unstable.includes("[")) return false; // opencode 同式短路：零成本跳过
	return REF_DEF.test(unstable) || /^[ \t]{0,3}\[/m.test(unstable);
}

/** 完整闭合的 code token 判定（围栏行 = 同围栏字符且长度 ≥ 开栏，允许尾随空白）。
 *  raw 必须含换行：光杆开栏行（EOF 处只有 ~~~）形状与闭合行相同，会误判。 */
function isCompleteCode(t: Token): boolean {
	if (t.type !== "code") return false;
	const raw = (t as Tokens.Code).raw;
	if (!raw.includes("\n")) return false;
	const open = /^(`{3,}|~{3,})/.exec(raw)?.[1];
	if (!open) return false;
	const last = raw.split("\n").pop() ?? "";
	return new RegExp(`^${open[0] === "`" ? "`" : "~"}{${open.length},}[ \\t]*$`).test(last);
}

/** 半截闭合围栏修剪（pi markdown.ts:146-169 移植，MIT）：末 token 为 code 且最后一行是开栏
 *  标记的真前缀（如 ``` 只到 ``）时，把这半截从内容里修掉——闭合围栏逐字到达时代码块高度
 *  不抖。list/blockquote 末项下钻同 pi。 */
function trimPartialClosingFences(tokens: readonly Token[]): void {
	const token = tokens[tokens.length - 1];
	if (token?.type === "list") {
		const items = (token as Tokens.List).items;
		trimPartialClosingFences(items[items.length - 1]?.tokens ?? []);
		return;
	}
	if (token?.type === "blockquote") {
		trimPartialClosingFences((token as Tokens.Blockquote).tokens ?? []);
		return;
	}
	if (token?.type !== "code") return;
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const lastLine = token.raw.split("\n").pop();
	if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]!.repeat(lastLine.length)) {
		return;
	}
	(token as Tokens.Code).text = (token as Tokens.Code).text.slice(0, -lastLine.length).replace(/\n$/, "");
}

export function createStreamingMarkdown(width: number): StreamingMarkdown {
	let frozenUpto = 0; // 已冻结的文本前缀长度
	let frozenText = ""; // 已冻结的原文前缀（startsWith 重置防御——cc-haha 同款）
	let frozenLines: string[] = []; // 已冻结的折行后物理行（冻结时折行一次，永不重折）

	return {
		render(full: string): string[] {
			if (!full.startsWith(frozenText)) {
				// 文本被重置（防御）
				frozenUpto = 0;
				frozenText = "";
				frozenLines = [];
			}
			const tailSrc = full.slice(frozenUpto);
			const tokens = lex(tailSrc);
			let lastIdx = tokens.length - 1;
			while (lastIdx >= 0 && tokens[lastIdx]!.type === "space") lastIdx--;
			// 完整闭合的 code 即刻完整；否则末 token 恒视为生长中（cc-haha 保守规则——
			// 段落/标题等还可能被后到内容改写形态，如 setext 下划线，不动）
			const upto = lastIdx >= 0 && isCompleteCode(tokens[lastIdx]!) ? lastIdx + 1 : lastIdx;
			let adv = 0;
			for (let i = 0; i < upto; i++) adv += tokens[i]!.raw.length;
			if (adv > 0 && holdsForRefDefs(full.slice(frozenUpto + adv))) adv = 0;
			let tailTokens = tokens;
			if (adv > 0) {
				const seg = tailSrc.slice(0, adv);
				frozenText += seg;
				frozenUpto += adv;
				frozenLines.push(...renderLines(seg, width));
				tailTokens = lex(full.slice(frozenUpto));
			}
			trimPartialClosingFences(tailTokens);
			// 尾段 transient：代码块纯文本跳高亮，冻结定格时一次上色（设计空白 #16）
			return [...frozenLines, ...renderTokens(tailTokens, width, { transient: true })];
		},
	};
}
