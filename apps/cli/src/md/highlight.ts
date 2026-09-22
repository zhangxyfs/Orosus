/** 代码高亮——cli-highlight 全 token 化（mdpipe 批 T1，v3 决策点②：用户拍板 2026-09-22
 *  「他们怎么做我们就怎么做，引包不能算做红线」，撤销 T9 期「28 包/97ms 否决硬依赖」）。
 *  结构 = 多数派同款（claude-code / cc-haha / kimi + Reasonix1，封装 highlight.js）：
 *  hljs 只负责把代码切成 token 并按主题上色，色板映射与调用权在本仓——与「解析外包
 *  marked、渲染自写」同一哲学。
 *  主题 = cli-highlight DEFAULT_THEME 基底 + kimi 同款覆写（kimi `highlight-theme.ts`）：
 *  string/regexp → 素色（kimi 注释原意：DEFAULT_THEME 把字符串涂红，恰好重置让高亮代码
 *  里没有红）；diff addition → 连山 accent、deletion → err（连山 palette 无 diff 专属
 *  token，取语义最近邻——设计空白 #5）。自写正则三形态与 KEYWORDS 语言表随本重写退役：
 *  JSON 转义腐蚀与 ts/js `#` 误判随 token 化天然根除（「对已着色产物再跑正则」反模式清零），
 *  语言覆盖从 5 族扩到 hljs 全量。 */
import { createRequire } from "node:module";
import { highlight, plain, supportsLanguage } from "cli-highlight";
import type { Theme } from "cli-highlight";
import * as theme from "../theme.ts";

// chalk@4（cli-highlight 内嵌依赖）按 import 期环境探测决定是否出 ANSI：非 TTY（vitest /
// 管道）下 color level 0、DEFAULT_THEME 全部 token 无色。本仓渲染口径 = 恒出 ANSI（theme.ts
// 从不做 TTY 探测），故把 cli-highlight 所链的同一 chalk 实例的 level 钉到 3——chalk@4 在
// 样式调用时才读 level，事后调整即生效，且不受 import 求值序影响（vitest 外部依赖预载下同样可靠）。
const cliHighlightRequire = createRequire(import.meta.url);
const cliHighlightEntry = cliHighlightRequire.resolve("cli-highlight");
const chalkInstance: { level: number } = createRequire(cliHighlightEntry)("chalk");
chalkInstance.level = 3;

const codeTheme: Theme = {
	string: plain,
	regexp: plain,
	addition: (code: string): string => theme.fg("accent", code),
	deletion: (code: string): string => theme.fg("err", code),
};

export interface HighlightOpts {
	/** 流式尾段（未定格）：纯文本行跳过高亮——防生长中的代码块每帧重高亮（O(n²) 帧成本，
	 *  kimi transient 同款，设计空白 #16）；冻结定格时一次上色。 */
	transient?: boolean;
}

/** 多行高亮：supportsLanguage 守卫（未知语言 → 纯文本行）+ try/catch 降级（失败 → 纯文本行，
 *  survey §4 P5「加载失败降级」共识）。 */
export function highlightLines(code: string, lang: string | undefined, opts?: HighlightOpts): string[] {
	if (opts?.transient) return code.split("\n");
	const l = lang?.trim().toLowerCase();
	if (!l || !supportsLanguage(l)) return code.split("\n");
	try {
		return highlight(code, { language: l, ignoreIllegals: true, theme: codeTheme }).split("\n");
	} catch {
		return code.split("\n");
	}
}
