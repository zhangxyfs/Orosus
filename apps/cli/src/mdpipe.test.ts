import { describe, it, expect } from "vitest";
import { createStreamingMarkdown, renderMarkdown } from "./mdpipe.ts";
import { stripAnsi } from "./tui/width.ts";

const plain = (lines: string[]): string => stripAnsi(lines.join("\n"));

describe("markdown 新管线（TUI 批阶段三 F1——九条挂账缺陷验收面）", () => {
	it("① 表格渲染为对齐网格（缺陷：表格零处理裸奔）", () => {
		const lines = renderMarkdown("| 名称 | 值 |\n|---|---|\n| 甲 | 1 |\n| 乙 | 22 |", 60);
		const p = plain(lines);
		expect(p).toContain("│"); // 网格分隔
		expect(p).toContain("─"); // 表头分隔行
		// 列对齐：「乙」与「甲」同列起始
		const row甲 = lines.find((l) => stripAnsi(l).includes("甲"))!;
		const row乙 = lines.find((l) => stripAnsi(l).includes("乙"))!;
		expect(stripAnsi(row甲).indexOf("1")).toBe(stripAnsi(row乙).indexOf("22"));
	});
	it("② 嵌套列表缩进 + 圆点（缺陷：缩进列表裸奔）", () => {
		const lines = renderMarkdown("- 甲\n  - 子项一\n  - 子项二\n- 乙", 60);
		const p = plain(lines);
		expect(p).toContain("• 甲");
		expect(p).toContain("    • 子项一"); // 子项缩进两级
	});
	it("③ ### 及更深标题渲染且不带字面 #（缺陷：h3+ 裸奔）", () => {
		const lines = renderMarkdown("### 三级\n\n#### 四级", 60);
		const p = plain(lines);
		expect(p).toContain("三级");
		expect(p).toContain("四级");
		expect(p).not.toContain("###");
		expect(lines.some((l) => l.includes("\x1b[1m"))).toBe(true); // 加粗
	});
	it("④ 链接/斜体/引用/删除线/水平线各有形态（缺陷：全部原样）", () => {
		const lines = renderMarkdown("[标题](https://x.com) *斜* ~~删~~\n\n> 引用\n\n---", 60);
		const joined = lines.join("\n");
		expect(stripAnsi(joined)).toContain("标题 (https://x.com)");
		expect(joined).toContain("\x1b[4m"); // 链接下划线
		expect(joined).toContain("\x1b[3m"); // 斜体
		expect(joined).toContain("\x1b[9m"); // 删除线
		expect(plain(lines)).toContain("▎ 引用");
		expect(plain(lines)).toContain("────");
	});
	it("⑤ 行内码内标记不误剥（缺陷：粗体替换先行于行内码）", () => {
		const lines = renderMarkdown("代码 `**不解析**` 和 **真粗体**", 60);
		const p = plain(lines);
		expect(p).toContain("**不解析**"); // 行内码内字面保留
		expect(p).toContain("真粗体");
		expect(p).not.toContain("**真粗体**"); // 真粗体被解析
	});
	it("⑥ CJK 标题下划线按显示宽（缺陷：UTF-16 长度致宽减半）", () => {
		const lines = renderMarkdown("# 中文标题", 60);
		const u = stripAnsi(lines[1]!);
		expect(u).toBe("═".repeat(8)); // 4 个全角字 = 8 显示宽
	});
	it("⑦ 围栏代码块语法着色（缺陷：零着色——mdpipe 批 T1 改写：cli-highlight 色板，断言泛化为「有着色且内容完整」）", () => {
		const lines = renderMarkdown("```ts\nconst x = 1;\n// 注释\n```", 60);
		const code = lines.find((l) => stripAnsi(l).includes("const"))!;
		// oxlint-disable-next-line no-control-regex -- 终端断言合法形态：断言 ANSI 着色存在必须匹配 ESC
		expect(code).toMatch(/\x1b\[/); // 关键字行有着色（cli-highlight DEFAULT_THEME 色板）
		expect(stripAnsi(code)).toContain("const x = 1;"); // 内容完整
		const comment = lines.find((l) => stripAnsi(l).includes("注释"))!;
		expect(comment).not.toBe(code);
	});
	it("⑧ 列表内代码块正确缩进（缺陷：无嵌套上下文语义）", () => {
		const lines = renderMarkdown("- 步骤\n  ```\n  echo hi\n  ```", 60);
		const p = plain(lines);
		expect(p).toContain("echo hi");
		// 代码行缩进对齐列表项
		const codeLine = lines.find((l) => stripAnsi(l).includes("echo hi"))!;
		expect(stripAnsi(codeLine).indexOf("echo hi")).toBeGreaterThan(2);
	});
	it("⑨ 超宽表格：长单元格网格内折行不降级（mdpipe 批 T4 改写——pi 等比列宽替换 cap 24 降级；本批唯一既有测试改写，特此登记）", () => {
		const wide = "很长".repeat(30);
		const lines = renderMarkdown(`| 名称 | 说明 |\n|---|---|\n| 甲 | ${wide} |`, 60);
		const p = plain(lines);
		expect(p).toContain("│"); // 网格形态保持
		expect(p).toContain("┌");
		expect(p).toContain("甲");
	});
	it("⑩ 流式冻结：已闭合段只解析一次，尾部逐帧重渲", () => {
		const sm = createStreamingMarkdown(60);
		const a = sm.render("# 标题\n\n第一段。");
		const b = sm.render("# 标题\n\n第一段。\n\n第二段");
		// 冻结段行字符串引用稳定（零重解析零重折行）
		expect(b[0]).toBe(a[0]);
		expect(b[1]).toBe(a[1]);
		expect(b[2]).toBe(a[2]);
		expect(plain(b)).toContain("第二段");
	});
	it("⑪ 未闭合 fence pending 语义：内容按到达渲染，闭合后成块", () => {
		const sm = createStreamingMarkdown(60);
		const open = sm.render("```ts\nconst x = 1;");
		expect(plain(open)).toContain("const x = 1;"); // 未闭合也可见（pending）
		const closed = sm.render("```ts\nconst x = 1;\n```");
		expect(plain(closed)).toContain("```ts");
	});
	it("⑫ 有序列表编号与任务列表标记", () => {
		const lines = renderMarkdown("1. 甲\n2. 乙\n3. 丙", 60);
		const p = plain(lines);
		expect(p).toContain("1. 甲");
		expect(p).toContain("2. 乙");
		expect(p).toContain("3. 丙");
	});
});
