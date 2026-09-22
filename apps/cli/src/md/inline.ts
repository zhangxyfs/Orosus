/** 行内标记（token 级映射——行级正则误剥行内码前案的根治路径；原 mdpipe.ts:19-53 零变化搬迁）。 */
import type { Token, Tokens } from "marked";
import * as theme from "../theme.ts";

export function inlineToken(t: Token): string {
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

export function inlineTokens(tokens: Token[]): string {
	let out = "";
	for (const t of tokens) out += inlineToken(t);
	return out;
}
