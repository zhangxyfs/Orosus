/** 行内标记（token 级映射——行级正则误剥行内码前案的根治路径；原 mdpipe.ts:19-53 搬迁后
 *  于 mdpipe 批 T6 引入样式上下文：stylePrefix 哨兵根修「内层收尾洗掉外层色」）。
 *  机理（pi markdown.ts:440-445/673-719/736-738 同式）：外层样式（标题 accent / 引用 muted）
 *  用哨兵 \u0000 过一遍样式函数、截取其前的转义序列得 stylePrefix；行内各 token（strong/em/
 *  del/codespan/link）渲染完把 stylePrefix 贴回——外层色断不了；行尾剥掉残留前缀。 */
import type { Token, Tokens } from "marked";
import * as theme from "../theme.ts";
import { renderLatex } from "./latex.ts";

/** 行内渲染的样式上下文：applyText = 外层文本着色口（T7 latex 分支必须经此拼接），
 *  stylePrefix = 外层样式转义前缀（内层收尾后恢复用；空串 = 无外层）。 */
export interface InlineStyleContext {
	applyText(text: string): string;
	stylePrefix: string;
}

/** 默认上下文（段落等无外层样式场景）。 */
export const defaultInlineStyleContext: InlineStyleContext = {
	applyText: (text) => text,
	stylePrefix: "",
};

/** 哨兵法求样式前缀：样式函数包住 \u0000，取其前的转义序列（哨兵即弃，不出现在产物）。 */
export function stylePrefixOf(styleFn: (text: string) => string): string {
	const sentinel = "\u0000";
	const styled = styleFn(sentinel);
	const index = styled.indexOf(sentinel);
	return index >= 0 ? styled.slice(0, index) : "";
}

export function inlineToken(t: Token, ctx: InlineStyleContext = defaultInlineStyleContext): string {
	switch (t.type) {
		case "text":
			return ctx.applyText((t as Tokens.Text).text);
		case "escape":
			return ctx.applyText((t as Tokens.Escape).text);
		case "strong":
			return theme.bold(inlineTokens((t as Tokens.Strong).tokens ?? [], ctx)) + ctx.stylePrefix;
		case "em":
			return `\x1b[3m${inlineTokens((t as Tokens.Em).tokens ?? [], ctx)}\x1b[23m${ctx.stylePrefix}`;
		case "del":
			return `\x1b[9m${inlineTokens((t as Tokens.Del).tokens ?? [], ctx)}\x1b[29m${ctx.stylePrefix}`;
		case "codespan":
			return theme.fg("warn", (t as Tokens.Codespan).text) + ctx.stylePrefix;
		case "latex": {
			// LaTeX 行内公式（mdpipe 批 T7）：产出必须经上下文 applyText 拼接（T6 管线——
			// 公式不断标题/引用外层色）；渲染失败（undefined）回退原文，判空 ?? 非 === null
			const lt = t as unknown as { text: string; raw: string };
			return ctx.applyText(renderLatex(lt.text) ?? lt.raw);
		}
		case "link": {
			const lt = t as Tokens.Link;
			const label = inlineTokens(lt.tokens ?? [], ctx);
			return theme.fg("info", theme.underline(label)) + theme.dim(` (${lt.href})`) + ctx.stylePrefix;
		}
		case "br":
			return "\n";
		default:
			return "raw" in t && typeof (t as { raw?: string }).raw === "string"
				? (t as { raw: string }).raw
				: "";
	}
}

export function inlineTokens(tokens: Token[], ctx: InlineStyleContext = defaultInlineStyleContext): string {
	let out = "";
	for (const t of tokens) out += inlineToken(t, ctx);
	// 尾部残留前缀剥除（pi :736-738——最后一个 token 是内层样式时，收尾不必再贴回）
	while (ctx.stylePrefix !== "" && out.endsWith(ctx.stylePrefix)) {
		out = out.slice(0, -ctx.stylePrefix.length);
	}
	return out;
}
