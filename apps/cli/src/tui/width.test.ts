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

describe("CJK 禁则（2026-09-24 用户拍板——「名字（长URL）」段落行尾孤「（」乱象）", () => {
	it("⑤ 开括号不收行尾：URL 词原子掉行时「（」随之下移（截图 1:1 场景）", () => {
		const text = "来源：中国天气网北京站（http://bj.weather.com.cn/sygdt/09/4802051_m.shtml）· 中央气象台（https://www.nmc.cn/publish/forecast/ABJ/beijing.html）";
		const lines = wrapText(text, 78);
		for (const l of lines) expect(l.endsWith("（")).toBe(false); // 旧行为：每行以孤「（」收尾
		expect(stripAnsi(lines.join("")).replace(/ /g, "")).toBe(text.replace(/ /g, "")); // 无内容丢失（断点空格合法吞掉）
		expect(lines.some((l) => l.includes("http://bj.weather.com.cn"))).toBe(true); // URL 完整不被劈
	});

	it("⑥ 行首闭排印：。、）等不落在行首（上一单元带下去）", () => {
		const lines = wrapText("北京天气晴。明天呢。好的。", 8);
		for (const l of lines) expect(l).not.toMatch(/^[）。，、；：！？…·]/); // 行首禁则
		expect(lines.join("")).toBe("北京天气晴。明天呢。好的。"); // 无内容丢失
	});

	it("⑦ URL 词原子不回归 + OSC 链接边界保守跳过禁则不炸", () => {
		const fits = wrapText("see http://abc.example/x here", 34);
		expect(fits).toHaveLength(1); // 整行装得下——零折行
		const linked = "看（\x1b]8;;http://x.example/a/b\x07http://x.example/a/b\x1b]8;;\x07）完";
		const lines = wrapText(linked, 20);
		expect(stripAnsi(lines.join(""))).toBe("看（http://x.example/a/b）完"); // OSC 链接内容无损
	});
});
