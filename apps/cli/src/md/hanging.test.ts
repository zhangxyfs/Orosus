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
	it("6. 列表项内行内标记渲染（T8 矩阵钉出的漏网——text 块原样直推修复）", () => {
		const lines = renderMarkdown("- 项 **粗体** 与 `码` 和 [链](https://e.com)", 60);
		const joined = lines.join("\n");
		expect(stripAnsi(joined)).toContain("粗体");
		expect(joined).toContain("\x1b[1m"); // 粗体真实着色（原样直推则无）
		expect(stripAnsi(joined)).toContain("码");
		expect(stripAnsi(joined)).toContain("链 (https://e.com)");
	});
	// CMD-07 回归钉（doc/16）：marked 对 "0." 起始解析 start=0，旧 `(l.start || 1)` 把 0
	// 起始改写成 1。0 是合法起始序号须保留；start 缺省（marked 给 ""）才兜底 1。
	it("7. CMD-07：0 起始有序列表保留 0 序号（|| 兜底会改写成 1）", () => {
		const p = renderMarkdown("0. zero\n1. one", 40).map(stripAnsi);
		expect(p[0]).toMatch(/^0\. zero/); // 修复前："1. zero"
		expect(p[1]).toMatch(/^1\. one/); // 修复前："2. one"（随 start 改写整体偏移）
		const q = renderMarkdown("3. three\n4. four", 40).map(stripAnsi); // 非 0/非 1 起始不受影响
		expect(q[0]).toMatch(/^3\. three/);
		expect(q[1]).toMatch(/^4\. four/);
	});
	// CMD-08 回归钉（doc/16）：列表项/引用内的块间空行旧版被 continue/filter 丢弃——
	// 松散列表项双段落、`> a\n>\n> b` 多段落视觉粘连，与顶层段落间空行口径不一致。
	// 修复：空行透传为带前缀的空物理行（列表贴 continuationPrefix 纯空格、引用贴 ▎ 前缀）。
	it("8. CMD-08：松散列表项双段落块间空行透传（贴续行前缀空行）", () => {
		const p = renderMarkdown("- 甲段\n\n  乙段", 40).map(stripAnsi);
		expect(p[0]).toMatch(/^• 甲段/);
		expect(p[1]).toBe("  "); // 块间空行 = marker 等宽空格的续行前缀（修复前乙段直接粘连在续行）
		expect(p[2]).toMatch(/^ {2}乙段/);
	});
	it("9. CMD-08：引用内多段落块间空行保留 ▎ 前缀（不再相邻粘连）", () => {
		const p = renderMarkdown("> 甲段\n>\n> 乙段", 40).map(stripAnsi);
		expect(p.filter((l) => l.startsWith("▎"))).toEqual(["▎ 甲段", "▎ ", "▎ 乙段"]);
	});
});
