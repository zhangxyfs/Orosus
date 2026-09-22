import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../mdpipe.ts";
import { renderTable } from "./table.ts";
import { stripAnsi } from "../tui/width.ts";
import type { Tokens } from "marked";

const plain = (lines: string[]): string => stripAnsi(lines.join("\n"));

const cellOf = (text: string, extra: Tokens.Generic[] = []): Tokens.TableCell =>
	({ type: "table_cell", raw: text, text, tokens: [{ type: "text", raw: text, text }, ...extra] } as unknown as Tokens.TableCell);

describe("md/ 表格完整化（mdpipe 批 T4——P1-④：全边框网格 + 等比列宽 + 降级补分隔）", () => {
	it("1. 常规表：全套框线 + 数据行间分隔线 + 表头加粗", () => {
		const lines = renderMarkdown("| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |", 40);
		const p = plain(lines);
		expect(p).toContain("┌"); expect(p).toContain("┬"); expect(p).toContain("┐");
		expect(p).toContain("├"); expect(p).toContain("┼"); expect(p).toContain("┤");
		expect(p).toContain("└"); expect(p).toContain("┴"); expect(p).toContain("┘");
		// 两行数据 → 行间分隔线（├─┼─┤ 形态出现两次：表头下 + 数据行间）
		expect(p.split("\n").filter((l) => l.includes("┼")).length).toBe(2);
		expect(lines.some((l) => stripAnsi(l).includes("甲") && l.includes("\x1b[1m"))).toBe(true);
	});
	it("2. 窄宽度：列宽收缩、长单元格列内折行、跨行对齐", () => {
		const lines = renderMarkdown("| 短 | 长内容列 |\n|---|---|\n| a | 一二三四五六七八九十 |", 24);
		const p = plain(lines);
		expect(p).toContain("┌"); // 仍为网格
		expect(p.split("\n").filter((l) => l.includes("│")).length).toBeGreaterThan(2); // 单元格折成多行
		// 对齐：同一物理行的两列由 │ 分隔，所有内容行的 │ 显示列位置一致（按显示宽非码点下标）
		const contentRows = lines.map(stripAnsi).filter((l) => /│.*│/.test(l) && !l.includes("┼"));
		const colPositions = (l: string): string => {
			const pos: number[] = [];
			let col = 0;
			for (const ch of l) {
				if (ch === "│") pos.push(col);
				col += /[\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\u4e00-\u9fff]/.test(ch) ? 2 : 1;
			}
			return pos.join(",");
		};
		expect(new Set(contentRows.map(colPositions)).size).toBe(1);
		expect(p).toContain("十"); // 内容不丢
	});
	it("3. 宽 60 + 长 CJK 单元格：网格内折行、不降级（原⑨场景改写）", () => {
		const wide = "很长".repeat(30);
		const lines = renderMarkdown(`| 名称 | 说明 |\n|---|---|\n| 甲 | ${wide} |`, 60);
		const p = plain(lines);
		expect(p).toContain("┌");
		expect(p).toContain("│");
		expect(p).not.toContain("· 名称:"); // 不再触发 key-value 降级
	});
	it("4. 极窄（宽 10）：降级 key-value，记录间 ─ 分隔线、值续行缩进 2 空格", () => {
		const two = renderMarkdown("| 名称 | 说明 |\n|---|---|\n| 甲 | 长值一 |\n| 乙 | 长值二 |", 10);
		const p = plain(two);
		expect(p).not.toContain("┌"); // 降级
		expect(p).toContain("甲");
		// 两条记录之间有 ─ 分隔线（宽 min(width-1, 40)）
		const sep = two.find((l) => /^─+$/.test(stripAnsi(l)));
		expect(sep).toBeDefined();
		expect(stripAnsi(sep!).length).toBe(9); // min(10-1, 40)
		// 值完整（极窄下折行为多行，剥空白拼接不丢字）
		expect(p.replace(/\s+/g, "")).toContain("长值二");
		expect(p.replace(/\s+/g, "")).toContain("长值一");
	});
	it("5. 降级单元格内换行归一为空格（P3 计宽偏差——合成 br token 钉）", () => {
		const table = {
			type: "table",
			raw: "",
			header: [cellOf("键"), cellOf("值"), cellOf("备注")],
			rows: [[cellOf("a"), cellOf("第一行", [{ type: "br", raw: "  \n" } as unknown as Tokens.Generic, { type: "text", raw: "第二行", text: "第二行" } as unknown as Tokens.Generic]), cellOf("aaaaaaaaaaaa")]],
			align: [null, null, null],
		} as unknown as Tokens.Table;
		const out: string[] = [];
		renderTable(table, out, 20); // 长词列挤高行 → 降级路径；值列行宽 13 足够单行放下归一后的值
		const p = stripAnsi(out.join("\n"));
		expect(p).toContain("第一行 第二行"); // br → 单空格，非裸换行
	});
	it("6. 折行单元格 ANSI 不串列：片段间样式归零序列存在", () => {
		const bold = "粗".repeat(20); // 40 显示宽，宽 30 squeeze 后两行网格
		const lines = renderMarkdown(`| 甲 | **${bold}** |\n|---|---|\n| a | b |`, 30);
		expect(plain(lines)).toContain("┌"); // 网格（行高 ≤ 4）
		// 多行单元格的非末行片段以样式归零序列收尾（pi wrapCellText 同款）
		expect(lines.join("\n")).toContain("\x1b[22;23;24;25;27;28;29;39m");
	});
});
