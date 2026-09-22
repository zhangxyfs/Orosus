import { describe, it, expect } from "vitest";
import { renderMarkdown, createStreamingMarkdown } from "../mdpipe.ts";
import { stripAnsi } from "../tui/width.ts";
import { setLatexEnabled } from "./latex.ts";
import * as theme from "../theme.ts";

const plain = (lines: string[]): string => stripAnsi(lines.join("\n"));
const openOf = (fn: (t: string) => string): string => fn("\u0000").split("\u0000")[0]!;

describe("md/ LaTeX 数学渲染（mdpipe 批 T7——TeX→Unicode 线性化，pi-tui 移植）", () => {
	it("1. 行内 $x^2 + y^2$ 渲染上标 ²", () => {
		const p = plain(renderMarkdown("勾股定理 $x^2 + y^2 = z^2$ 成立", 60));
		expect(p).toContain("x² + y²");
		expect(p).not.toContain("$");
	});
	it("2. 分式线性化 a/b——行内与块级 $$ 同样单行（竖排堆叠路径摘除钉）", () => {
		expect(plain(renderMarkdown("值是 $\\frac{a}{b}$ 即二分之一", 60))).toContain("a/b");
		const block = renderMarkdown("$$\\frac{a}{b}$$", 60);
		expect(plain(block)).toContain("a/b");
		expect(block.length).toBe(2); // 单行 + 空行——堆叠形态会是三行（分子/横线/分母）
	});
	it("3. \\sqrt{2} 渲染 √ 形态", () => {
		expect(plain(renderMarkdown("$\\sqrt{2}$", 60))).toContain("√2");
	});
	it("4. 希腊字母 \\alpha \\beta \\pi", () => {
		const p = plain(renderMarkdown("圆的面积用 $\\pi r^2$，角 $\\alpha$ 与 $\\beta$", 60));
		expect(p).toContain("π");
		expect(p).toContain("α");
		expect(p).toContain("β");
	});
	it("5. 货币守卫：价格 $5 and $10 不当数学、原样保留", () => {
		const p = plain(renderMarkdown("价格 $5 and $10 美元之间", 60));
		expect(p).toContain("$5");
		expect(p).toContain("$10");
	});
	it("6. 反引号内的 $...$ 不命中（行内码优先）", () => {
		const p = plain(renderMarkdown("命令 `echo $x$ end` 保持原样", 60));
		expect(p).toContain("$x$");
	});
	it("7. 块级 $$...$$ 独立成块", () => {
		const lines = renderMarkdown("前文\n\n$$a + b = c$$\n\n后文", 60);
		const p = plain(lines);
		expect(p).toContain("a + b = c");
		expect(p).not.toContain("$$");
	});
	it("8. 块级 \\[...\\] 同", () => {
		const p = plain(renderMarkdown("前文\n\n\\[a + b\\]\n\n后文", 60));
		expect(p).toContain("a + b");
		expect(p).not.toContain("\\[");
		expect(p).not.toContain("[a + b]"); // 钉死非「转义吃掉反斜杠」的假绿路径
	});
	it("9. 行内 \\(...\\) 同", () => {
		const p = plain(renderMarkdown("值 \\(a + b\\) 即和", 60));
		expect(p).toContain("a + b");
		expect(p).not.toContain("("); // 钉死非转义假绿路径（latex 渲染不产括号）
	});
	it("10. 未闭合 $\\frac{1 原样透传（流式逐帧与终态一致）", () => {
		const src = "公式 $\\frac{1 尚未闭合";
		const sm = createStreamingMarkdown(60);
		for (let i = 1; i <= src.length; i++) {
			const f = sm.render(src.slice(0, i));
			if (f.join("").includes("\\frac")) {
				expect(f.join("")).toContain("$");
			}
		}
		const done = plain(sm.render(src));
		expect(done).toContain("$\\frac{1");
	});
	it("11. 未知命令整段回退原文、不崩", () => {
		const p = plain(renderMarkdown("怪式 $\\foo{bar}$ 结束", 60));
		expect(p).toContain("\\foo{bar}");
	});
	it("12. 开关关闭后全部原样透传", () => {
		try {
			setLatexEnabled(false);
			const p = plain(renderMarkdown("圆 $\\pi$ 与块\n\n$$\\frac{a}{b}$$\n", 60));
			expect(p).toContain("$\\pi$");
			expect(p).toContain("$$");
		} finally {
			setLatexEnabled(true);
		}
	});
	it("13. 表格单元格内行内公式：π 渲染、列对齐不被打歪", () => {
		const lines = renderMarkdown("| 符号 | 含义 |\n|---|---|\n| $\\pi$ | 圆周率 |", 40);
		const p = plain(lines);
		expect(p).toContain("π");
		expect(p).toContain("圆周率");
		expect(p).toContain("┌"); // 网格形态
	});
	it("14. 公式 × 代码块：围栏内 $...$ 保持原样文本（防 tokenizer 配置回归——P0-① 同类事故）", () => {
		const p = plain(renderMarkdown("```ts\nconst s = \"$\\frac{a}{b}$\";\n```", 60));
		expect(p).toContain("$\\frac{a}{b}$");
	});
	it("15. 公式 × 标题/引用样式：公式不断外层颜色（latex 走上下文 applyText）", () => {
		const head = renderMarkdown("# 标题 $x^2$ 尾", 60).find((l) => l.includes("标题"))!;
		expect(stripAnsi(head)).toContain("x²");
		expect(head).toContain(openOf((t) => theme.fg("accent", t))); // 标题 accent 仍在
		const quote = renderMarkdown("> 引用 $\\pi$ 内容", 60).find((l) => l.includes("引用"))!;
		expect(stripAnsi(quote)).toContain("π");
		expect(quote).toContain(openOf((t) => theme.fg("muted", t))); // 引用 muted 仍在
	});
});
