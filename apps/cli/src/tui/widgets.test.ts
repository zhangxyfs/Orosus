import { describe, it, expect } from "vitest";
import { renderWidgetLines } from "./widgets.ts";
import type { WidgetSpec } from "@orosus/contracts/module";
import { stripAnsi } from "./width.ts";

describe("控件渲染器三②（m5 T8——input/columns/table 纯渲染面）", () => {
	it("① input：未聚焦灰显占位、聚焦带光标块", () => {
		const w = renderWidgetLines([{ id: "i", kind: "input", placeholder: "说点什么" }], 20).lines;
		expect(stripAnsi(w.join("\n"))).toContain("说点什么");
		const f = renderWidgetLines([{ id: "i", kind: "input" }], 20, { focusedId: "i", inputById: { i: { text: "hi", cursor: 2 } } }).lines;
		expect(stripAnsi(f.join("\n"))).toContain("hi");
		expect(f.join("\n")).toContain("▏"); // 光标块
	});

	it("② input 多行 lines 开窗跟随光标行（5 行文本 lines=2 → 只显光标附近两行）", () => {
		const text = "a\nb\nc\nd\ne";
		const f = renderWidgetLines([{ id: "i", kind: "input", multiline: true, lines: 2 }], 20, { focusedId: "i", inputById: { i: { text, cursor: text.length } } }).lines;
		const plain = stripAnsi(f.join("\n"));
		expect(plain).toContain("d");
		expect(plain).toContain("e");
		expect(plain).not.toContain("[a");
	});

	it("③ columns 均分两列并列（列间 │ 分隔）", () => {
		const cols: WidgetSpec[][] = [
			[{ id: "l", kind: "text", text: "左" }],
			[{ id: "r", kind: "text", text: "右" }],
		];
		const out = renderWidgetLines([{ id: "c", kind: "columns", cols: [...cols] }], 40).lines;
		const plain = stripAnsi(out.join("\n"));
		expect(plain).toContain("左");
		expect(plain).toContain("右");
		expect(out.length).toBe(1); // 并列一行
		expect(out[0]).toContain("│");
	});

	it("④ columns 比例宽（widths 百分比）", () => {
		const cols: WidgetSpec[][] = [
			[{ id: "l", kind: "text", text: "左列" }],
			[{ id: "r", kind: "text", text: "右列" }],
		];
		const out = renderWidgetLines([{ id: "c", kind: "columns", cols: [...cols], widths: [70, 30] }], 40).lines;
		expect(stripAnsi(out.join("\n"))).toContain("左列");
		const idxL = stripAnsi(out[0]!).indexOf("左");
		const idxR = stripAnsi(out[0]!).indexOf("右");
		expect(idxR - idxL).toBeGreaterThanOrEqual(24); // 70% 列宽 ≈ 26 格
	});

	it("⑤ columns 最小列宽 8：窄窗逐层减列到 1 列塌纵向（10 格两列 → 纵向两行）", () => {
		const cols: WidgetSpec[][] = [
			[{ id: "l", kind: "text", text: "上" }],
			[{ id: "r", kind: "text", text: "下" }],
		];
		const out = renderWidgetLines([{ id: "c", kind: "columns", cols: [...cols] }], 10).lines;
		expect(out.length).toBe(2); // 塌纵向
		expect(out.join(" ")).not.toContain("│");
	});

	it("⑥ columns 嵌套两层（外层两列、内层再两列）", () => {
		const inner: WidgetSpec[][] = [
			[{ id: "a", kind: "text", text: "甲" }],
			[{ id: "b", kind: "text", text: "乙" }],
		];
		const cols: WidgetSpec[][] = [
			[{ id: "nest", kind: "columns", cols: [...inner] }],
			[{ id: "r", kind: "text", text: "丙" }],
		];
		const out = renderWidgetLines([{ id: "outer", kind: "columns", cols: [...cols] }], 60).lines;
		const plain = stripAnsi(out.join("\n"));
		expect(plain).toContain("甲");
		expect(plain).toContain("乙");
		expect(plain).toContain("丙");
	});

	it("⑦ table 网格 + 超宽降级 key-value", () => {
		const t = renderWidgetLines([{ id: "t", kind: "table", head: ["名", "值"], rows: [["a", "1"]] }], 30).lines;
		const plain = stripAnsi(t.join("\n"));
		expect(plain).toContain("名");
		expect(plain).toContain("a");
		expect(plain).toContain("┌"); // 网格形态
		const kv = renderWidgetLines([{ id: "t", kind: "table", head: ["名", "值", "备注", "多余列"], rows: [["a", "1", "x", "y"]] }], 10).lines;
		const kvPlain = stripAnsi(kv.join("\n"));
		expect(kvPlain).toContain("名:");
		expect(kvPlain).not.toContain("┌"); // 降级无网格
	});
});
