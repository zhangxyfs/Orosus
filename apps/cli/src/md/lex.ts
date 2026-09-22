/** md/ 目录地基（mdpipe 批 T0）：共享 marked 实例与 lex 口径——全目录唯一的 marked 进口，
 *  防止各件各配一份解析器（后续 T2 流式 token 边界与 T7 LaTeX 扩展都挂在这一个实例上）。 */
import { Marked, type Token } from "marked";

const marked = new Marked();

/** GFM 口径 lex（原 mdpipe.ts 单实例直调形态，行为零变化搬迁）。 */
export function lex(src: string): Token[] {
	return marked.lexer(src, { gfm: true });
}
