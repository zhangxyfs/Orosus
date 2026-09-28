import { describe, it, expect } from "vitest";
import { stripDangerEsc } from "./ansi-guard.ts";

/** CR-01 回归钉（2026-09-28 用户拍板「只堵危险子集」）：外部文字里的终端控制码——
 *  危险类（光标移动/清屏/OSC 改标题/写剪贴板/伪装链接/DCS/存取光标）剥净、SGR 颜色保留、
 *  正常文本零变化。 */

describe("stripDangerEsc（CR-01 外部文字危险转义净化）", () => {
	it("① 危险类全剥：光标移动/清屏/私有序列/OSC（标题·剪贴板）/DCS/两字符序列；OSC 8 只剥序列、可见标签保留", () => {
		const evil: [string, string][] = [
			["a\x1b[2Jb", "ab"],        // 清屏
			["a\x1b[10;5Hb", "ab"],     // 光标定位
			["a\x1b[?25lb", "ab"],      // 隐藏光标（私有参数）
			["a\x1b]0;evil-title\x07b", "ab"], // OSC 改标题（BEL 终止）
			["a\x1b]52;c;cGFzcZWQ=\x1b\\b", "ab"], // OSC 52 写剪贴板（ST 终止）
			["a\x1bP+q5b6b\x1b\\b", "ab"], // DCS 查询
			["a\x1b7b\x1b8c", "abc"],   // 存/取光标（ESC+数字两字符序列——只剥序列，正文 b/c 保留）
			["a\x1b[2Kb", "ab"],        // 清行
		];
		for (const [s, want] of evil) expect(`${stripDangerEsc(s)} ← ${JSON.stringify(s)}`).toBe(`${want} ← ${JSON.stringify(s)}`);
		// OSC 8 伪装链接：两个 OSC 序列剥净，夹在中间的可见标签「link」是明文——保留
		expect(stripDangerEsc("a\x1b]8;;http://evil\x07link\x1b]8;;\x07b")).toBe("alinkb");
	});

	it("② SGR 颜色保留：外部文字自带颜色码原样过（ls --color 等合法场景）", () => {
		const s = "\x1b[31m红\x1b[39m\x1b[1;32m绿\x1b[0m完";
		expect(stripDangerEsc(s)).toBe(s);
	});

	it("③ 拆包形态：序列跨 chunk 拆开后孤儿 ESC/BEL 被清、余文无害", () => {
		expect(stripDangerEsc("a\x1b]52;c;")).toBe("a");          // 前半（截断形 OSC 到串尾整段剥）
		expect(stripDangerEsc("pwn\x07")).toBe("pwn");             // 后半（孤儿 BEL 清、明文保留）
		expect(stripDangerEsc("a\x1b")).toBe("a");                 // 孤儿 ESC
	});

	it("④ 正常文本零变化：中文/换行/制表/回车/markdown 全保留；残散 C0 清除", () => {
		const s = "# 标题\n- 列表\t缩进\r\n`code` [链接](http://a)";
		expect(stripDangerEsc(s)).toBe(s);
		expect(stripDangerEsc("a\x00b\x08c\x7fd")).toBe("abcd");
	});
});
