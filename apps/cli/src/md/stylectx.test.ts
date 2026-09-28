import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../mdpipe.ts";
import * as theme from "../theme.ts";
import { stripAnsi } from "../tui/width.ts";

const openOf = (fn: (t: string) => string): string => fn("\u0000").split("\u0000")[0]!;

describe("md/ 行内嵌套样式断色根修（mdpipe 批 T6——stylePrefix 哨兵）", () => {
	it("1. 标题里的粗体结束后恢复标题色（现状：收尾码洗掉 accent，尾巴掉回正文色）", () => {
		const lines = renderMarkdown("# 标题 **粗体** 尾巴", 60);
		const head = lines.find((l) => l.includes("标题"))!;
		const accentOpen = openOf((t) => theme.fg("accent", t));
		const boldClose = head.indexOf("\x1b[22m"); // 第一个粗体收尾
		expect(boldClose).toBeGreaterThan(0);
		// 粗体收尾之后再次出现标题 accent 色（哨兵前缀恢复）
		expect(head.indexOf(accentOpen, boldClose)).toBeGreaterThan(boldClose);
		expect(head).toContain("尾巴");
	});
	it("2. 引用内的行内码结束后恢复引用色", () => {
		const lines = renderMarkdown("> 引用里有 `行内码` 还有后续文字", 60);
		const quote = lines.find((l) => l.includes("引用"))!;
		const mutedOpen = openOf((t) => theme.fg("muted", t));
		const count = quote.split(mutedOpen).length - 1;
		expect(count).toBeGreaterThanOrEqual(2); // 首次上色 + 码段收尾后恢复
	});
	it("3. 纯段落：无哨兵残留、无末尾前缀", () => {
		const lines = renderMarkdown("普通段落 **粗体** 收尾", 60);
		const joined = lines.join("\n");
		expect(joined).not.toContain("\u0000");
		expect(joined).toContain("普通段落");
		expect(joined).toContain("收尾");
	});
	it("4. CMD-01 链接 href 消毒：角括号 href 携带 BEL/ESC 渲染产物无裸控制字符（终端转义注入）", () => {
		// marked 对 [x](<…>) 角括号形式放行除 \n < > \ 外的任意字节——实测含 BEL/ESC 原样进 lt.href。
		// 未消毒时 href 里的 \x07 提前闭合 OSC 8，其后 \x1b]52;c;… 被终端当独立序列执行（OSC 52 剪贴板劫持）
		const lines = renderMarkdown("[x](<http://a\x07\x1b]52;c;pwn\x07>)", 60);
		const joined = lines.join("\n");
		expect(joined).toContain("x"); // 链接标签照常渲染
		// 钉法：剥掉全部合法成对序列（SGR/OSC 8 自产装饰）后，明文里不得再有裸 ESC/BEL——
		// 未消毒时 href 后缀 " (…)" 里的 BEL 是明文字符，剥不干净
		const plain = stripAnsi(joined);
		expect(plain).not.toContain("\x07");
		expect(plain).not.toContain("\x1b");
		expect(plain).toContain("(http://a]52;c;pwn)"); // 控制 除净、常规 URL 字符保留
		// 消毒后的 OSC 8 闭对仍在（点击探测依赖的自产序列不受影响）
		expect(joined).toContain("\x1b]8;;\x07");
	});
});
