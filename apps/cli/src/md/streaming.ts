/** 流式渲染（稳定前缀冻结；原 mdpipe.ts:203-262 零变化搬迁，renderSeg 改调 blocks.renderLines）：
 *  冻结点只落在 fence 外 → frozenUpto 处 fence 态恒为「外」，扫描从 frozenUpto 起步即可
 *  （O(尾长) 非 O(n)）；行判定走 charCodeAt 不切片（spike 实测热点）。
 *  mdpipe 批 T2 将把冻结点判定升到 marked token 边界（~~~ / 缩进围栏根治），本件仅为 T0 搬迁过渡。 */
import { renderLines } from "./blocks.ts";

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
				if (!inFence) cut = nl === -1 ? n : nl + 1; // fence 刚闭合——整块冻结（EOF 处闭合同样算，transient 定格钉需要）
			} else if (!inFence && lineEnd === i && nl !== -1) {
				cut = nl + 1; // 空行（fence 外）= 冻结点
			}
			if (nl === -1) break;
			i = nl + 1;
		}
		return cut;
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
				frozenLines.push(...renderLines(full.slice(frozenUpto, cut), width));
				frozenUpto = cut;
			}
			const tail = full.slice(frozenUpto);
			if (tail === "") return frozenLines;
			// 尾段 transient：代码块纯文本跳高亮，冻结定格时一次上色（设计空白 #16）
			return [...frozenLines, ...renderLines(tail, width, { transient: true })];
		},
	};
}
