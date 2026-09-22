/** 高亮（正则三形态：关键字/字符串/注释——语言表外的按纯文本；原 mdpipe.ts:55-82 零变化搬迁）。
 *  mdpipe 批 T1 将整体重写为 cli-highlight 全 token 化（方案 v3 决策点②——「对已着色产物再跑
 *  正则」的反模式随重写根除），本件形态仅为 T0 搬迁过渡。 */
import * as theme from "../theme.ts";

const KEYWORDS: Record<string, string[]> = {
	ts: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "interface", "type", "import", "export", "from", "new", "async", "await", "of", "in", "instanceof", "typeof"],
	js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "import", "export", "from", "new", "async", "await", "of", "in", "instanceof", "typeof"],
	py: ["def", "return", "if", "elif", "else", "for", "while", "class", "import", "from", "as", "with", "lambda", "pass", "raise", "try", "except", "finally"],
	bash: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "in", "echo", "exit", "return", "local", "export"],
	sh: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "in", "echo", "exit", "return", "local", "export"],
};
const LANG_ALIAS: Record<string, string> = { typescript: "ts", javascript: "js", python: "py", shell: "bash", zsh: "bash" };

/** 单行高亮：字符串 → warn、注释 → muted、关键字 → accent、其余 → fg。 */
export function highlightLine(line: string, lang: string): string {
	const l = LANG_ALIAS[lang] ?? lang;
	if (l === "json") {
		// json：字符串键值 warn、数字 info
		return line.replace(/("(?:[^"\\]|\\.)*")/g, (_m, g: string) => theme.fg("warn", g)).replace(/\b(\d+(?:\.\d+)?)\b/g, (_m, g: string) => theme.fg("info", g));
	}
	const kws = KEYWORDS[l];
	if (!kws) return theme.fg("fg", line);
	const kw = kws.join("|");
	const re = new RegExp(`("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`|\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/|#.*$|\\b(?:${kw})\\b)`, "g");
	return line.replace(re, (m) => {
		if (m.startsWith("//") || m.startsWith("/*") || m.startsWith("#")) return theme.fg("muted", m);
		if (m.startsWith('"') || m.startsWith("'") || m.startsWith("`")) return theme.fg("warn", m);
		return theme.fg("accent", m);
	});
}
