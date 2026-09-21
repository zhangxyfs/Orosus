import { describe, it, expect } from "vitest";
import { dispLines, stripAnsi, visibleWidth, wrapText } from "./width.ts";

describe("宽度引擎（TUI 批阶段三 F0——pi-tui utils 零依赖移植）", () => {
	it("① CJK 折行：12 个全角字在 10 列宽折 3 行（24 显示宽 ÷ 10 列向上取整）", () => {
		expect(wrapText("中文中文中文中文中文中文", 10)).toHaveLength(3);
		expect(dispLines("中文中文中文中文中文中文", 10)).toBe(3);
	});
	it("② VS16 emoji 宽 2、ambiguous=1、代理对不拆", () => {
		expect(visibleWidth("☀️")).toBe(2); // U+2600 + VS16
		expect(visibleWidth("❯⏺◐✓")).toBe(4); // ambiguous 图标各 1
		expect(wrapText("😀😀😀", 3)).toEqual(["😀", "😀", "😀"]); // 每字 2 列、3 列宽每行 1 个——不拆代理对
	});
	it("③ ANSI/OSC/APC 转义零宽（剥除后测宽）", () => {
		expect(visibleWidth("\x1b[31m中文\x1b[39m")).toBe(4);
		expect(stripAnsi("\x1b[38;2;1;2;3m甲\x1b]8;;http://x\x07乙\x1b]8;;\x07\x1b_pi:c\x07")).toBe("甲乙");
	});
	it("④ wrapText 的 ANSI 状态跨行延续（折行处状态带入下一行防色漏）", () => {
		const red = "\x1b[31m" + "甲".repeat(12) + "\x1b[39m";
		const lines = wrapText(red, 8); // 12 全角 = 24 宽，8 列 → 3 行
		expect(lines).toHaveLength(3);
		expect(lines[1]!.startsWith("\x1b[31m")).toBe(true); // 第二行继承红色前缀
		expect(lines[0]!.endsWith("\x1b[0m")).toBe(true); // 首行末尾复位防漏色
	});
});
