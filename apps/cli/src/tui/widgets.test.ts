import { describe, it, expect } from "vitest";
import { renderWidgetLines } from "./widgets.ts";
import type { WidgetSpec } from "@orosus/contracts/module";
import { stripAnsi } from "./width.ts";
import { fg, dim } from "../theme.ts";

describe("控件渲染器三②（m5 T8——input/columns/table 纯渲染面）", () => {
	it("① input：未动笔灰显占位、聚焦带光标块", () => {
		const w = renderWidgetLines([{ id: "i", kind: "input", placeholder: "说点什么" }], 20).lines;
		expect(stripAnsi(w.join("\n"))).toContain("说点什么");
		const f = renderWidgetLines([{ id: "i", kind: "input" }], 20, { focusedId: "i", inputById: { i: { text: "hi", cursor: 2 } } }).lines;
		expect(stripAnsi(f.join("\n"))).toContain("hi");
		expect(f.join("\n")).toContain("▏"); // 光标块
	});

	it("①b input 框形（2026-09-30 实机走查拍板）：label 画进顶边；框色聚焦白/失焦灰；单行 = 顶边+内容+底边三行", () => {
		const w = renderWidgetLines([{ id: "i", kind: "input", label: "名称" }], 30).lines;
		expect(w.length).toBe(3); // 三行框
		expect(stripAnsi(w[0]!)).toBe(" ┌─ 名称 " + "─".repeat(19) + "┐"); // 顶边 label 形态（boxW=28）
		expect(stripAnsi(w[1]!)).toBe(" │" + " ".repeat(26) + "│"); // 内容行框边
		expect(stripAnsi(w[2]!)).toBe(" └" + "─".repeat(26) + "┘");
		// 框色：聚焦 = fg（白）、失焦 = muted（灰）——顶边整行单包，直接整行比对
		const focused = renderWidgetLines([{ id: "i", kind: "input", label: "名称" }], 30, { focusedId: "i" }).lines;
		const top = (c: "fg" | "muted"): string => " " + fg(c, `┌─ 名称 ${"─".repeat(19)}┐`);
		expect(w[0]).toBe(top("muted"));
		expect(focused[0]).toBe(top("fg"));
		// 无 label 顶边纯线
		const nl = renderWidgetLines([{ id: "i", kind: "input" }], 20).lines;
		expect(stripAnsi(nl[0]!)).toBe(" ┌" + "─".repeat(16) + "┐");
	});

	it("② input 多行 lines 开窗跟随光标行（5 行文本 lines=2 → 只显光标附近两行）", () => {
		const text = "a\nb\nc\nd\ne";
		const f = renderWidgetLines([{ id: "i", kind: "input", multiline: true, lines: 2 }], 20, { focusedId: "i", inputById: { i: { text, cursor: text.length } } }).lines;
		const plain = stripAnsi(f.join("\n"));
		expect(plain).toContain("d");
		expect(plain).toContain("e");
		expect(plain).not.toContain("a");
		expect(f.length).toBe(4); // 顶边 + 两行内容 + 底边
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

describe("交互列表两段式（2026-09-28 用户拍板——子界面与斜杠主菜单同形：标题白/说明灰）", () => {
	it("⑧ 未选中项说明段灰；选中项标题青玉、说明仍灰（纯标题项整项青玉不变）", () => {
		const widgets: WidgetSpec[] = [{ id: "l", kind: "list", interactive: true, items: ["磁盘占用（各目录大小与清理口径）", "运行状态"] }];
		const st = { focusedId: "l", selById: { l: 1 } };
		const out = renderWidgetLines(widgets, 40, st).lines.join("\n");
		expect(out).toContain(`磁盘占用${dim("（各目录大小与清理口径）")}`); // 未选中：标题白 + 说明灰
		expect(out).toContain(fg("accent", "运行状态")); // 选中纯标题项整项青玉（原行为）
		expect(stripAnsi(out)).toContain("磁盘占用（各目录大小与清理口径）"); // 可见形态不变
		const sel2 = renderWidgetLines(widgets, 40, { focusedId: "l", selById: { l: 0 } }).lines.join("\n");
		expect(sel2).toContain(`${fg("accent", "磁盘占用")}${dim("（各目录大小与清理口径）")}`); // 选中带说明项：标题青玉、说明灰
	});
});

describe("progress 分数块档位（CTW-05 回归钉 2026-09-28——FRACS 索引 off-by-one：k/8 档被映到 FRACS[k-1]，每档少显 1/8 格）", () => {
	it("⑨ frac=1/8 渲染 ▏（旧实现取 FRACS[0] 空串——1/8 进度整格凭空消失）；frac=7/8 渲染 ▉（旧 ▊、FRACS[7] 永不可达）", () => {
		// w=20 → barW = max(6, 20-4-pctText.len-1)
		// 1/8 边界：value=1/max=64（pctText 4 字符 → barW=11）→ ratio*barW*8 = 1.375 → round → total = 1/8（full=0）
		const e8th = renderWidgetLines([{ id: "p", kind: "progress", value: 1, max: 64 }], 20).lines[0]!;
		expect(stripAnsi(e8th)).toBe(" ▏░░░░░░░░░░ 1/64"); // 亮段恰 1/8 格 ▏（旧：全 ░ 空串）
		expect(e8th).toContain("▏");
		// 7/8 边界：value=23/max=80 → ratio*barW*8 = 23 → total = 2 + 7/8（full=2）
		const s8th = renderWidgetLines([{ id: "p", kind: "progress", value: 23, max: 80 }], 20).lines[0]!;
		expect(stripAnsi(s8th)).toBe(" ██▉░░░░░░░ 23/80"); // 亮段 = 2 整格 + 7/8 格 ▉（旧：▊ = 6/8 档）
		expect(s8th).not.toContain("▊");
	});
});

describe("列表结构行（2026-10-16 用户走查「时间显示在最右边」）：TUI 拼回单串与字符串形态同形", () => {
	it("① 交互列表：{ text, note } 行拼 `text · note`；字符串行原样——两种行同窗混排", () => {
		const items = [
			{ text: "◆ 共享记忆索引（MEMORY.md）", note: "6 分钟前" },
			{ text: "  部署要点 · 简介", note: "2 天前" },
			"‹ 上一页",
			{ text: "无注行" },
		];
		const w = renderWidgetLines([{ id: "l", kind: "list", interactive: true, items }], 60).lines.map(stripAnsi);
		expect(w[0]).toContain("◆ 共享记忆索引（MEMORY.md） · 6 分钟前");
		expect(w[1]).toContain("  部署要点 · 简介 · 2 天前");
		expect(w[2]).toContain("‹ 上一页");
		expect(w[3]).toContain("无注行");
		expect(w[3]).not.toContain(" · "); // note 缺席不拼尾
	});

	it("② 非交互列表同款拼回（只读 list 的结构行不落对象串）", () => {
		const w = renderWidgetLines([{ id: "l", kind: "list", items: [{ text: "甲", note: "1 小时前" }, "乙"] }], 40).lines.map(stripAnsi);
		expect(w[0]).toContain("甲 · 1 小时前");
		expect(w[1]).toContain("乙");
	});
});

describe("列表结构行自适应截断（2026-10-16 用户走查二轮「简介显示到时间前面一点」——摘模块 60 帽后的 TUI 接棒）", () => {
	it("③ 长主文压进剩余宽度：note 恒在行尾可见、行不越界——宽窗多显窄窗少显（按实际宽度自适应）", () => {
		const item = { text: `标题 · ${"长".repeat(60)}`, note: "5 分钟前" };
		const rows = (w: number) => renderWidgetLines([{ id: "l", kind: "list", interactive: true, items: [item] }], w).lines.map(stripAnsi);
		const r40 = rows(40)[0]!;
		expect(r40.endsWith("5 分钟前")).toBe(true); // note 存活在行尾（不被长主文顶掉）
		expect(r40).not.toContain("长".repeat(40)); // 主文被压缩
		const r80 = rows(80)[0]!;
		expect(r80.endsWith("5 分钟前")).toBe(true);
		expect(stripAnsi(r80).length).toBeGreaterThan(stripAnsi(r40).length); // 宽窗显示更多主文
		const r160 = rows(160)[0]!;
		expect(r160).toContain("长".repeat(60)); // 全放得下：不截
		expect(r160.endsWith("5 分钟前")).toBe(true);
	});

	it("④ 非交互列表同款自适应（只读 list 长主文不吞 note）", () => {
		const w = renderWidgetLines([{ id: "l", kind: "list", items: [{ text: `甲 · ${"长".repeat(50)}`, note: "1 小时前" }] }], 40).lines.map(stripAnsi);
		expect(w[0]!.endsWith("1 小时前")).toBe(true);
	});
});
