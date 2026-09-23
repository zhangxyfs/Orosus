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

describe("DocModel 用户消息折行与工具明细（2026-09-23 走查批）", () => {
	it("① 用户长提问按流区宽折行——首行 ❯ 前缀、续行缩进，无超宽行", () => {
		const dm = new DocModel();
		dm.userPrompt("这是一个很长的提问需要自动折行不然在消息窗口里会被截断看不到后面的内容".repeat(2));
		const plain = dm.frameLines(40).map(stripAnsi).filter((l) => l !== "");
		expect(plain.length).toBeGreaterThan(2); // 折出多行
		expect(plain[0]).toMatch(/^❯ /);
		expect(plain[1]).toMatch(/^ {2}\S/); // 续行缩进对齐正文
		for (const l of plain) expect([...l].length).toBeLessThanOrEqual(42); // CJK 2 列——字数上限 40+余量
	});

	it("② Edit 工具：收起帽 10 行 + Alt+O 提示，展开态全量（删 -/增 +/行号栏；chip 按内容计增删）", () => {
		const dm = new DocModel();
		const block = "a\nb\nc\nd\ne\nf\ng\nh";
		dm.toolCall("tool-fs__edit", {
			path: "src/x.ts",
			edits: [
				{ oldText: `${block}\nOLD1\nz`, newText: `${block}\nNEW1\nz` },
				{ oldText: `${block}\nOLD2\nz`, newText: `${block}\nNEW2\nz` },
			],
		});
		dm.toolResult("已编辑 src/x.ts", false);
		const collapsed = dm.frameLines(80).map(stripAnsi);
		expect(collapsed[0]).toBe("● Used Edit (src/x.ts) · +2 -2"); // chip 按 diff 内容算（图4 拍板——不按结果文案行数）
		expect(collapsed.some((l) => l.includes("- OLD1"))).toBe(true);
		expect(collapsed.some((l) => l.includes("+ NEW1"))).toBe(true);
		expect(collapsed.some((l) => l.includes("Alt + O 展开全部"))).toBe(true); // 两处编辑共 19 行 > 收起帽 10
		dm.toolOpen = true;
		const opened = dm.frameLines(80).map(stripAnsi);
		expect(opened.length).toBeGreaterThan(collapsed.length);
		expect(opened.some((l) => l.includes("上方") && l.includes("行相同"))).toBe(true); // 长前缀 gap 隔断
		expect(opened.some((l) => l.includes("+ NEW2"))).toBe(true); // 展开态第二处编辑可见
	});

	it("②b diff 行形态：行号栏暗色、删行 err 文字/增行 accent 文字、不铺底色；超宽折行续行对齐正文列", () => {
		const dm = new DocModel();
		dm.toolCall("tool-fs__edit", {
			path: "x.ts",
			edits: [{ oldText: "旧行", newText: "新行很长很长很长很长很长很长很长很长很长很长很长很长需要折行" }],
		});
		dm.toolResult("ok", false);
		dm.toolOpen = true;
		const raw = dm.frameLines(40);
		expect(raw.join("\n")).not.toContain("48;"); // 无背景色（二轮走查图1 拍板——不铺底）
		const del = raw.find((l) => l.includes("旧行"))!;
		const add = raw.find((l) => l.includes("新行很长"))!;
		expect(del).toContain("38;5;167m"); // 删行 diffDel 明确红（256 降级口径——err 赭石偏橙前案）
		expect(add).toContain("38;5;78m"); // 增行 diffAdd 明确绿
		const plain = raw.map(stripAnsi);
		const addIdx = plain.findIndex((l) => l.includes("+ 新行很长"));
		expect(plain[addIdx + 1]).toMatch(/^\s+[^\s+]/); // 续行空行号栏、缩进对齐正文
	});

	it("③ Write 工具：content 全量增行、chip 按内容行数；失败工具：错误默认全收起（Alt+F 展开、JSON 壳剥掉）", () => {
		const dm = new DocModel();
		const content = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n");
		dm.toolCall("tool-fs__write", { path: "y.ts", content });
		dm.toolResult("已写入 y.ts（70B）", false);
		const plain = dm.frameLines(80).map(stripAnsi);
		expect(plain[0]).toBe("● Used Write (y.ts) · 12 行"); // chip = 内容行数（图4 拍板——不是结果文案的 1 行）
		// Write = 内容预览形态（kimi 同款：dim 行号 + 语法高亮正文、无 +/- 记号——三轮走查拍板）
		expect(plain.some((l) => /^ +\d+ {2}l1$/.test(l))).toBe(true);
		expect(plain.filter((l) => /^ +\d+ {2}l\d+$/.test(l)).length).toBe(10); // 收起帽 10 行
		expect(plain.some((l) => l.includes("还有 2 行"))).toBe(true);
		expect(dm.frameLines(80).join("\n")).not.toContain("+ l1"); // 无 + 记号

		const dm2 = new DocModel();
		dm2.toolCall("tool-shell__run", { command: "pnpm test" });
		dm2.toolResult('{"error":{"message":"余额不足"},"code":1113}\n堆栈第二行\n堆栈第三行\n堆栈第四行', true);
		const c = dm2.frameLines(80).map(stripAnsi);
		expect(c).toEqual(["● Used Run (pnpm test) · 失败 · Alt + F 查看"]); // 默认全收起 + 提示（二轮走查拍板）
		expect(dm2.frameLines(80)[0]).toContain("38;5;173m●"); // 失败卡 ● 转 err 红（kimi ✗ 形态）
		dm2.errOpen = true;
		const o = dm2.frameLines(80).map(stripAnsi);
		expect(o[0]).toBe("● Used Run (pnpm test) · 失败");
		expect(o.join("\n")).toContain("余额不足"); // JSON 已解析
		expect(o.join("\n")).not.toContain('"code"'); // 原始 JSON 不上屏
		expect(o.some((l) => l.includes("堆栈第四行"))).toBe(true); // 展开全量
	});
});
