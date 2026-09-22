import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../mdpipe.ts";
import { stripAnsi } from "../tui/width.ts";

describe("md/ 列表与引用悬挂缩进（mdpipe 批 T3——P1-③）", () => {
	it("1. 无序列表长条目：续行与首行内容列对齐（宽 30）", () => {
		const text = "这是一条很长很长很长的列表条目内容用来测试折行续行对齐形态是否正确";
		const lines = renderMarkdown(`- ${text}`, 30);
		const p = lines.map(stripAnsi);
		expect(p[0]).toMatch(/^• /);
		expect(p[1]).toMatch(/^ {2}\S/); // 续行 = marker 等宽空格 + 内容（现状：回第 0 列）
		// 首行 + 全部续行（各剥 2 列前缀）拼回原文：内容零丢失、每行前缀恰好 2 列
		expect(p[0]!.slice(2) + p.slice(1).filter((x) => x !== "").map((x) => x.slice(2)).join("")).toBe(text);
	});
	it("2. 有序列表 10+ 项：末项续行按 4 列 marker 宽对齐", () => {
		const items = Array.from({ length: 11 }, (_, i) =>
			i === 10 ? "11. 第十一项是一条很长很长的条目内容用来测试有序列表续行对齐" : `${i + 1}. 项${i}`);
		const lines = renderMarkdown(items.join("\n"), 30);
		const p = lines.map(stripAnsi);
		const tenIdx = p.findIndex((l) => l.startsWith("11. "));
		expect(tenIdx).toBeGreaterThan(0);
		expect(p[tenIdx + 1]).toMatch(/^ {4}\S/); // "11. " = 4 列 marker
	});
	it("3. 嵌套列表内长条目：续行对齐自身层级内容列", () => {
		const lines = renderMarkdown("- 外层简\n  - 嵌套层级的长条目内容用来测试嵌套续行对齐形态是否正确维持缩进关系", 34);
		const p = lines.map(stripAnsi);
		const nested = p.findIndex((l) => l.includes("嵌套"));
		expect(p[nested]).toMatch(/^ {4}• /); // 外层续行列 2 + 嵌套缩进 2 → 子项 marker 落 4 列（测试②形态）
		expect(p[nested + 1]).toMatch(/^ {6}\S/); // 4 + marker 2 = 内容列 6
	});
	it("4. 任务列表：[x] 进 marker、续行对齐", () => {
		const lines = renderMarkdown("- [x] 已办事项的长条目内容用来测试任务标记进入 marker 后的对齐形态", 30);
		const p = lines.map(stripAnsi);
		expect(p[0]).toMatch(/^• \[x\] /); // [x] 拼进 marker（现状：标记被 marked 剥掉不显示）
		expect(p[1]).toMatch(/^ {6}\S/); // "• [x] " = 6 列
	});
	it("5. 引用长行：续行带 ▎ 前缀且内容列对齐（宽 30）", () => {
		const lines = renderMarkdown("> 这是一条很长很长的引用内容用来测试折行续行的引用符前缀对齐形态", 30);
		const p = lines.map(stripAnsi).filter((l) => l !== "");
		expect(p.length).toBeGreaterThan(1);
		for (const l of p) expect(l).toMatch(/^▎ /); // 每条物理行都有引用符（现状：续行前缀丢失）
	});
});
