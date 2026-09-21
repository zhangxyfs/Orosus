import { describe, it, expect } from "vitest";
import { DocModel } from "./docmodel.ts";
import { stripAnsi } from "./width.ts";

describe("DocModel 思考块与流区折行（F5 三轮）", () => {
	it("① 收起态显示思考尾部（最新内容）——流式追加后尾行跟随", () => {
		const dm = new DocModel();
		dm.activity({ kind: "reasoning", text: "第一句很早的想法。\n第二句中间。\n第三句最新的结论。" }, 80);
		const lines = dm.frameLines(80).map(stripAnsi);
		expect(lines.some((l) => l.includes("第三句最新的结论"))).toBe(true);
		expect(lines.some((l) => l.includes("第一句很早"))).toBe(false); // slice(0,2) 旧口径不再出现
	});

	it("② 定稿后 Alt + E 仍生效：think marker 按 frameLines 当下折叠态渲染", () => {
		const dm = new DocModel();
		dm.activity({ kind: "reasoning", text: "想法甲很长的一段推理，".repeat(30) }, 80); // 660 显示宽——展开必多行
		dm.activity({ kind: "text", text: "正文" }, 80);
		dm.end(80);
		dm.thinkOpen = false;
		const collapsed = dm.frameLines(80);
		expect(collapsed.length).toBeLessThan(6); // 收起 = 提示 + 最多 2 行
		dm.thinkOpen = true;
		const opened = dm.frameLines(80);
		expect(opened.map(stripAnsi).join(" ")).toContain("想法甲很长的一段推理");
		expect(opened.length).toBeGreaterThan(collapsed.length); // 展开 = 全文逐行
	});

	it("③ 定格行超流区宽 → 折行（此前按整屏宽、被截尾）", () => {
		const dm = new DocModel();
		const long = "[orosus] " + "模块已激活提示文字".repeat(30); // ~270 显示宽
		dm.pushLine(long);
		const lines = dm.frameLines(60);
		const plain = lines.map(stripAnsi);
		for (const l of plain) expect([...l].length).toBeLessThanOrEqual(62); // 每行不超宽（CJK 2 列 → 字数 ≤ 61+）
		expect(plain.join("")).toContain("模块已激活提示文字".repeat(30).slice(-8)); // 尾部内容在档（未被截掉）
	});
});
