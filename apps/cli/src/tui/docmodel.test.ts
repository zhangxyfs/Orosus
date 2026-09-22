import { describe, it, expect } from "vitest";
import { DocModel } from "./docmodel.ts";
import { stripAnsi } from "./width.ts";
import { TOOL_MERGE } from "../render.ts";

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

describe("DocModel 工具行与历史结构化（F5 五轮）", () => {
		it("① 工具行：call 行 → result 哨兵原位合并为 Used · N 行（不新增行）", () => {
		const dm = new DocModel();
		dm.write("● Using Read (src/main.ts)\n", 80);
		dm.write(TOOL_MERGE + "32 行\n", 80);
		const lines = dm.frameLines(80).map(stripAnsi);
		expect(lines).toContain("● Used Read (src/main.ts) · 32 行");
		expect(lines.filter((l) => l.includes("Read (src/main.ts)"))).toHaveLength(1); // 原位合并——单行
	});

	it("①b pushMd：命令结果通道走 md 管线——/compact /summary 类输出无字面 ** 与反引号（F5 六轮②）", () => {
		const dm = new DocModel();
		dm.pushMd("**四门全绿才准 commit**：`test`（vitest）/ `typecheck` / `check:boundaries`（依赖方向脚本）/ `docs:check`（typedoc 生成物 diff）", 60);
		const lines = dm.frameLines(60).map(stripAnsi);
		expect(lines.join("\n")).not.toContain("**");
		expect(lines.join("\n")).not.toContain("`");
		expect(lines.some((l) => l.includes("check:boundaries"))).toBe(true); // 词原子——长 token 不劈半
	});

	it("② 历史结构化：提问暖金、md 解析（** 不残留）、思考 marker、工具 Used 形态", () => {
		const dm = new DocModel();
		dm.historyFrom([
			{ type: "user/message", content: [{ kind: "text", text: "你好" }] },
			{ type: "assistant/message", content: [{ kind: "reasoning", text: "推理过程" }, { kind: "text", text: "**加粗回答**" }] },
			{ type: "tool/call", name: "tool-fs__read", args: { path: process.cwd().replace(/\\/g, "/") + "/src/main.ts" } },
			{ type: "tool/result", output: "a\nb\nc", isError: false },
		], 80);
		const raw = dm.frameLines(80).join("\n");
		expect(raw).toContain("38;5;179m"); // 提问暖金
		expect(raw).not.toContain("**"); // md 已解析
		expect(raw).toContain("[思考]"); // 思考块在档（收起态）
		const plain = dm.frameLines(80).map(stripAnsi).join("\n");
		expect(plain).toContain("Used Read (src/main.ts) · 3 行");
		dm.thinkOpen = true;
		expect(dm.frameLines(80).map(stripAnsi).join(" ")).toContain("推理过程"); // Alt+E 可翻
	});
});


describe("DocModel 宽度回流（F5 十一轮——Ctrl+T 侧栏开关后内容按新宽重排）", () => {
	it("md 块与用户消息在宽度变化后重新折行（窄宽折的行在宽下回流）", () => {
		const dm = new DocModel();
		dm.userPrompt("这句提问很长很长很长很长很长需要折行才能放下测试回流行为");
		dm.activity({ kind: "text", text: "回答也安排一段很长的内容用来验证markdown块宽度回流同样的效果如何" }, 40);
		dm.end(40);
		const narrow = dm.frameLines(40);
		const wide = dm.frameLines(100);
		expect(wide.length).toBeLessThan(narrow.length); // 宽下行数更少（回流发生）
		const plain = wide.map(stripAnsi);
		expect(plain.some((l) => stripAnsi(l).trim().length >= 30)).toBe(true); // 单行容纳更多内容
	});
});
