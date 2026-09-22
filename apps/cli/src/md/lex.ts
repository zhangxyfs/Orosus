/** md/ 目录地基（mdpipe 批 T0）：共享 marked 实例与 lex 口径——全目录唯一的 marked 进口，
 *  防止各件各配一份解析器。T7 起挂 LATEX_MARKDOWN_EXTENSIONS（块级 $$…$$ / \[…\]、
 *  行内 $…$ / \(…\)，含货币守卫等防误判启发式；未闭合不命中——设计空白 #15）。 */
import { Marked, type Token } from "marked";
import { LATEX_MARKDOWN_EXTENSIONS } from "./latex-tokenizer.ts";

const marked = new Marked();
marked.use({ extensions: [...LATEX_MARKDOWN_EXTENSIONS] });

/** GFM 口径 lex。**不得传 options 实参**——Marked 实例的 lexer(src, opts) 会用 opts 整体
 *  替换实例 defaults（不合并），挂在 defaults.extensions 上的 LATEX 扩展会随之丢失
 *  （marked 缺省本就是 gfm: true，无需显式传）。 */
export function lex(src: string): Token[] {
	return marked.lexer(src);
}
