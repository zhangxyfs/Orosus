import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocModel } from "./docmodel.ts";
import * as toolview from "./toolview.ts";
import * as theme from "../theme.ts";
import { stripAnsi, wrapText } from "./width.ts";
import { TOOL_MERGE } from "../render.ts";
import { loadHistoricalSubagents } from "../tasks-cmd.ts";

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

	it("①b 多词 label 工具行（2026-09-24 用户拍板——Search→Web Search 可读化）：合并与配色都吃空格名", () => {
		const dm = new DocModel();
		dm.write("● Using Web Search (北京天气)\n", 80);
		dm.write(TOOL_MERGE + "5 行\n", 80);
		const lines = dm.frameLines(80);
		const plain = lines.map(stripAnsi);
		expect(plain).toContain("● Used Web Search (北京天气) · 5 行"); // 合并手术 slice(8) 对 label 透明
		// 配色分段精确钉：● 与「Web Search」accent（整段含空格——非贪婪正则吃到「 (」为止），参数/chip 段 dim
		const colored = lines.find((l) => stripAnsi(l).includes("Web Search"));
		expect(colored).toBe(
			theme.fg("accent", "●") + theme.fg("fg", " Used ") + theme.fg("accent", "Web Search") + theme.dim(" (北京天气) · 5 行"),
		);
	});

	it("①c label 行无参数直接挂 chip（「 · N 行」前无「 (」）——正则按 chip 分段不吞进显示名", () => {
		const dm = new DocModel();
		dm.write("● Using Web Fetch · 3 行\n", 80);
		const colored = dm.frameLines(80)[0]!;
		expect(stripAnsi(colored)).toBe("● Using Web Fetch · 3 行");
		expect(colored).toBe(theme.fg("accent", "●") + theme.fg("fg", " Using ") + theme.fg("accent", "Web Fetch") + theme.dim(" · 3 行"));
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

describe("DocModel 技能手动加载行（2026-09-28 用户拍板：技能正文不打印进对话流）", () => {
	const skillText = (name: string, body: string): string =>
		`（用户通过菜单手动加载技能 "${name}"——请按该技能正文行事）\n<skill name="${name}">\n${body}\n</skill>`;

	it("① 实时路径：userPrompt 吃到技能标记消息 → 单行紧凑标记，正文与 <skill> 标签都不出现", () => {
		const dm = new DocModel();
		dm.userPrompt(skillText("ask-matt", "# 超长技能正文\n逐行都是 markdown 原文"));
		const plain = dm.frameLines(80).map(stripAnsi);
		expect(plain.join("\n")).toContain("已加载技能 ask-matt");
		expect(plain.join("\n")).not.toContain("超长技能正文"); // 正文不进对话流
		expect(plain.join("\n")).not.toContain("<skill"); // 标签也不裸露
		expect(plain.filter((l) => l.trim() !== "").length).toBe(1); // 单行（无用户块的空行包裹）
	});

	it("② 回放路径：historyFrom 的 user/message 同标记 → 同款单行（与实时同形）；普通用户消息不受影响", () => {
		const dm = new DocModel();
		dm.historyFrom([
			{ type: "user/message", content: [{ kind: "text", text: skillText("pdf", "正文原文") }] },
			{ type: "user/message", content: [{ kind: "text", text: "普通提问" }] },
		], 80);
		const plain = dm.frameLines(80).map(stripAnsi).join("\n");
		expect(plain).toContain("已加载技能 pdf");
		expect(plain).not.toContain("正文原文");
		expect(plain).toContain("❯ 普通提问"); // 普通用户消息照旧整块渲染
	});

	it("③ 带参形态（2026-09-30 拍板：/skill : 名 参数——kimi skillArgs 同款）：手敲=原话行嵌标记行后持久化，拆分渲染原话块在前、● 行随后；菜单形态（标记行后无 / 行）照旧只 ● 行", () => {
		const dm = new DocModel();
		// 手敲路径：main 层产出「标记行 / 原话行 / <skill args> 正文」一条消息（原话不放开头——防命令路由误吞）——实时与回放同走本口
		dm.userPrompt(
			"（用户通过菜单手动加载技能 \"doc-review\"——请按该技能正文行事）\n/skill : doc-review 2026-09-27-m4-3c-mcp-production.md 全量\n<skill name=\"doc-review\" args=\"2026-09-27-m4-3c-mcp-production.md 全量\">\n# 技能正文\n</skill>",
		);
		const plain = dm.frameLines(120).map(stripAnsi);
		const joined = plain.join("\n");
		expect(joined).toContain("❯ /skill : doc-review 2026-09-27-m4-3c-mcp-production.md 全量"); // 原话整行上屏
		expect(joined).toContain("已加载技能 doc-review"); // ● 行随后
		expect(joined.indexOf("❯ /skill : doc-review")).toBeLessThan(joined.indexOf("已加载技能 doc-review")); // 顺序：输入行在前
		expect(joined).not.toContain("技能正文"); // 正文照旧不进对话流
		expect(joined).not.toContain("args="); // 属性不裸露
		// 菜单 Enter 形态：标记行后直接 <skill>（无 / 开头的原话行）→ 只 ● 行
		const dm2 = new DocModel();
		dm2.userPrompt("（用户通过菜单手动加载技能 \"pdf\"——请按该技能正文行事）\n<skill name=\"pdf\">\n正文\n</skill>");
		expect(dm2.frameLines(80).map(stripAnsi).join("\n")).not.toContain("❯"); // 无原话块
	});
});

describe("工具结果图片附件信息行（m5-media F4——chip 常显 + Alt+O 展开逐图行，不渲染像素）", () => {
	it("① 收起态：头行 chip「· 附 N 图」；展开态：逐图行（格式 · 体积 · 路径）；坏条目剔除", () => {
		const imgDir = mkdtempSync(join(tmpdir(), "orosus-dm-m5-"));
		try {
			const img = join(imgDir, "shot.png");
			writeFileSync(img, Buffer.alloc(2048, 7));
			const dm = new DocModel();
			dm.toolCall("mcp__fx__screenshot", {}, "c1");
			dm.toolResult("（附 1 张图：png，约 2.0 KB）", false, "c1", [
				{ path: img, mimeType: "image/png" },
				{ path: "", mimeType: "image/png" }, // 坏条目——剔除
			]);
			let plain = dm.frameLines(80).map(stripAnsi).filter((l) => l.trim() !== "");
			expect(plain[0]).toContain("Used Screenshot"); // 显示名 chip 照旧
			expect(plain[0]).toContain("· 附 1 图"); // 好图计数（坏条目不计）
			expect(plain.join("\n")).not.toContain(img); // 收起态路径不上屏
			dm.toolOpen = true;
			plain = dm.frameLines(80).map(stripAnsi).filter((l) => l.trim() !== "");
			expect(plain.join("\n")).toContain("png · 2.0 KB"); // 格式+体积
			// 路径（展开态可见——想看可取）；wrapText 词原子折行可能把长路径拆两行，断言按去空白拼合
			expect(plain.join(" ").replace(/\s+/g, "")).toContain(img.replace(/\s+/g, ""));
		} finally {
			rmSync(imgDir, { recursive: true, force: true });
		}
	});

	it("② 无图结果零差异：chip 无「附 N 图」", () => {
		const dm = new DocModel();
		dm.toolCall("mcp__fx__query", {}, "c1");
		dm.toolResult("ok", false, "c1");
		const plain = dm.frameLines(80).map(stripAnsi);
		expect(plain.join("\n")).not.toContain("附 ");
	});
});

describe("连续只读工具聚合（2026-09-30 用户拍板抄 cc-haha 计数行——同名紧邻并组、一行计数、Alt+O 展开逐条）", () => {
	it("① 三个连续 read 并组：单行「Used Read 3 个文件 · 共 N 行」，路径不上屏，行数 = 各次之和", () => {
		const dm = new DocModel();
		dm.toolCall("tool-fs__read", { path: "a.md" }, "c1");
		dm.toolCall("tool-fs__read", { path: "b.md" }, "c2");
		dm.toolCall("tool-fs__read", { path: "c.md" }, "c3");
		dm.toolResult("line1\nline2", false, "c1");
		dm.toolResult("x\ny\nz", false, "c2");
		dm.toolResult("w", false, "c3");
		const plain = dm.frameLines(80).map(stripAnsi).filter((l) => l.trim() !== "");
		expect(plain).toHaveLength(1);
		expect(plain[0]).toContain("Used Read 3 个文件 · 共 6 行");
		expect(plain.join("\n")).not.toContain("a.md"); // 收起态路径不上屏
	});

	it("② 进行中组头 Using…，挂果后原位翻 Used（不新增行）；部分挂果仍 Using", () => {
		const dm = new DocModel();
		dm.toolCall("tool-fs__read", { path: "a.md" }, "c1");
		dm.toolCall("tool-fs__read", { path: "b.md" }, "c2");
		let plain = dm.frameLines(80).map(stripAnsi).filter((l) => l.trim() !== "");
		expect(plain).toHaveLength(1);
		expect(plain[0]).toContain("Using Read 2 个文件");
		dm.toolResult("x", false, "c1");
		plain = dm.frameLines(80).map(stripAnsi).filter((l) => l.trim() !== "");
		expect(plain).toHaveLength(1);
		expect(plain[0]).toContain("Using Read 2 个文件"); // 仍有未结组员
		dm.toolResult("y\nz", false, "c2");
		plain = dm.frameLines(80).map(stripAnsi).filter((l) => l.trim() !== "");
		expect(plain).toHaveLength(1);
		expect(plain[0]).toContain("Used Read 2 个文件 · 共 3 行");
	});

	it("③ 断组与单飞：异名工具断组、组后单次调用保持 solo 形态；write 永不并组", () => {
		const dm = new DocModel();
		dm.toolCall("tool-fs__read", { path: "a.md" }, "c1");
		dm.toolCall("tool-fs__read", { path: "b.md" }, "c2");
		dm.toolCall("tool-fs__write", { path: "w.md", content: "x" }, "c3"); // 非折叠类——断组
		dm.toolCall("tool-fs__read", { path: "c.md" }, "c4"); // 断组后单飞 → solo 行
		dm.toolResult("1", false, "c1");
		dm.toolResult("2", false, "c2");
		dm.toolResult("ok", false, "c3");
		dm.toolResult("3", false, "c4");
		const plain = dm.frameLines(80).map(stripAnsi).filter((l) => l.trim() !== "");
		expect(plain).toHaveLength(4); // 组一行 + write 头行 + write 内容预览一行 + read solo 一行
		expect(plain[0]).toContain("Used Read 2 个文件 · 共 2 行");
		expect(plain[1]).toContain("Used Write");
		expect(plain[3]).toContain("Used Read (c.md)"); // solo 形态照旧（不误并已断组的调用）
	});

	it("④ Alt+O 展开：组头 + 逐组员单行（kimi 树形近似），账本行数随展开精确", () => {
		const dm = new DocModel();
		dm.toolCall("tool-fs__read", { path: "a.md" }, "c1");
		dm.toolCall("tool-fs__read", { path: "b.md" }, "c2");
		dm.toolResult("x", false, "c1");
		dm.toolResult("y", false, "c2");
		dm.toolOpen = true;
		const plain = dm.frameLines(80).map(stripAnsi).filter((l) => l.trim() !== "");
		expect(plain).toHaveLength(3);
		expect(plain[0]).toContain("Used Read 2 个文件");
		expect(plain[1]).toContain("a.md");
		expect(plain[2]).toContain("b.md");
	});

	it("⑤ 去重口径：同文件同范围读两次算一个文件（cc-haha 唯一路径 Set 同款）", () => {
		const dm = new DocModel();
		dm.toolCall("tool-fs__read", { path: "a.md" }, "c1");
		dm.toolCall("tool-fs__read", { path: "a.md" }, "c2");
		dm.toolResult("x", false, "c1");
		dm.toolResult("y", false, "c2");
		const plain = dm.frameLines(80).map(stripAnsi).filter((l) => l.trim() !== "");
		expect(plain).toHaveLength(1);
		expect(plain[0]).toContain("Used Read 1 个文件 · 共 2 行"); // 去重后 1 个文件、行数仍两次之和
	});

	it("⑥ 回放同形（旧日志无 callId 走组内回退配对）：historyFrom 的连续 tool/call 同并组", () => {
		const dm = new DocModel();
		dm.historyFrom([
			{ type: "tool/call", name: "tool-fs__read", args: { path: "a.md" } },
			{ type: "tool/call", name: "tool-fs__read", args: { path: "b.md" } },
			{ type: "tool/result", output: "x", isError: false },
			{ type: "tool/result", output: "y", isError: false },
		], 80);
		const plain = dm.frameLines(80).map(stripAnsi).filter((l) => l.trim() !== "");
		expect(plain).toHaveLength(1);
		expect(plain[0]).toContain("Used Read 2 个文件 · 共 2 行");
	});
});


describe("DocModel 条目级渲染缓存（bash 卡顿批 A——帧心跳不重排全史）", () => {
	it("① 二次 frameLines 行引用相同 = 缓存命中（think/user/raw/tool/md 定格条目都不重算）", () => {
		const dm = new DocModel();
		dm.activity({ kind: "reasoning", text: "一段定稿的推理内容，涵盖多个视觉行宽度的文本。" }, 80);
		dm.activity({ kind: "text", text: "定稿回答" }, 80);
		dm.end(80);
		dm.userPrompt("一条较长的用户提问，".repeat(8));
		dm.pushLine("● Using Read (src/a.ts)");
		dm.pushLine("一行普通提示文字");
		dm.toolCall("tool-fs__read", { path: "src/a.ts" }, "c1");
		dm.toolResult("a\nb\nc", false, "c1");
		const a = dm.frameLines(80);
		const b = dm.frameLines(80);
		expect(b.length).toBe(a.length);
		for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]); // toBe = 引用相等：重算会产出新字符串对象
	});

	it("② 宽度变化击穿缓存重排（键含宽度）——内容完整、窄宽必折行、回宽再排仍完整", () => {
		const dm = new DocModel();
		dm.userPrompt("这是一条很长的用户提问，".repeat(20)); // ~220 显示宽
		dm.frameLines(120); // 先按宽渲染入缓存
		const narrow = dm.frameLines(30);
		expect(narrow.length).toBeGreaterThan(3); // 30 列下必折成多行
		const tail = "这是一条很长的用户提问，".repeat(20).slice(-6);
		expect(narrow.map(stripAnsi).join("")).toContain(tail); // 尾部内容在档（回流未丢）
		expect(dm.frameLines(120).map(stripAnsi).join("")).toContain(tail); // 回宽再排仍完整
	});

	it("③ thinkOpen 切换击穿缓存（键含折叠态）——展开见全文、切回与首次收起同形", () => {
		const dm = new DocModel();
		dm.activity({ kind: "reasoning", text: "推理全文。".repeat(60) }, 80);
		dm.end(80);
		const collapsed1 = dm.frameLines(80);
		dm.thinkOpen = true;
		const opened = dm.frameLines(80);
		expect(opened.map(stripAnsi).join(" ")).toContain("推理全文");
		expect(opened.length).toBeGreaterThan(collapsed1.length);
		dm.thinkOpen = false;
		expect(dm.frameLines(80).length).toBe(collapsed1.length); // 切回 = 重排回收起形态
	});

	it("④ tool result 挂上击穿缓存（键含 result 在场）——Using → Used · 行数 chip", () => {
		const dm = new DocModel();
		dm.toolCall("tool-fs__read", { path: "src/a.ts" }, "c1");
		expect(dm.frameLines(80).map(stripAnsi).join("\n")).toContain("● Using Read (src/a.ts)");
		dm.toolResult("a\nb\nc", false, "c1");
		expect(dm.frameLines(80).map(stripAnsi).join("\n")).toContain("● Used Read (src/a.ts) · 3 行");
	});

	it("⑤ errOpen 切换击穿缓存（键含失败体折叠态）——展开见错误详情", () => {
		const dm = new DocModel();
		dm.toolCall("tool-shell__bash", { command: "ping -t x" }, "c1");
		dm.toolResult("命令输出 boom 失败详情", true, "c1");
		const collapsed = dm.frameLines(80).map(stripAnsi).join("\n");
		expect(collapsed).toContain("Alt + F");
		expect(collapsed).not.toContain("boom"); // 默认全收起
		dm.errOpen = true;
		expect(dm.frameLines(80).map(stripAnsi).join("\n")).toContain("boom");
	});

	it("⑥ 原位合并替换条目对象不带旧缓存——TOOL_MERGE 后 Used 行即刻可见", () => {
		const dm = new DocModel();
		dm.write("● Using Read (src/a.ts)\n", 80);
		dm.frameLines(80); // Using 行已入缓存
		dm.write(TOOL_MERGE + "32 行\n", 80);
		const lines = dm.frameLines(80).map(stripAnsi);
		expect(lines).toContain("● Used Read (src/a.ts) · 32 行");
		expect(lines.filter((l) => l.includes("Read (src/a.ts)"))).toHaveLength(1); // 原位合并——单行
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

		it("①b 多行消息块只画一个 ❯（2026-09-27 拍板：换行/折行续行同为缩进续行——旧实现逐逻辑行各画 ❯，多行子代理任务书满屏箭头）", () => {
			const dm = new DocModel();
			dm.userPrompt("你是项目文档分析专家。分析这个项目。\n\n请阅读：\n- README.md\n- docs/ROADMAP.md\n输出：三段总结。");
			const plain = dm.frameLines(60).map(stripAnsi).filter((l) => l !== "");
			expect(plain.filter((l) => l.includes("❯"))).toHaveLength(1); // 整块一个箭头
			expect(plain[0]).toMatch(/^❯ /);
			expect(plain[1]).toMatch(/^ {2}/); // 其余逻辑行/折行都是缩进续行
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

	it("③d CTW-09 展开错误体入场一次解析缓存：帧心跳不再每帧重算 errorLines（hl/detail 同纪律——旧实现每帧两次现算）", () => {
		const spy = vi.spyOn(toolview, "errorLines");
		try {
			const dm = new DocModel();
			dm.toolCall("tool-shell__run", { command: "pnpm test" });
			dm.toolResult("ENOENT: boom\nat somewhere (f.js:1)", true);
			dm.errOpen = true;
			dm.frameLines(80); // 首帧入场解析一次
			dm.frameLines(80);
			dm.frameLines(80);
			expect(spy).toHaveBeenCalledTimes(1); // 旧实现 slice(0,60) + length 各调一次 → 每帧 2 次 × 3 帧 = 6
			expect(dm.frameLines(80).map(stripAnsi).some((l) => l.includes("ENOENT"))).toBe(true); // 缓存后渲染不变形
		} finally {
			spy.mockRestore();
		}
	});

	it("③e CTW-08 Write 尾多 \\n：chip 行数与同卡预览行数同口径（旧：chip「· 4 行」vs 预览 2 行——同卡两口径自相矛盾）", () => {
		const dm = new DocModel();
		dm.toolCall("tool-fs__write", { path: "y.ts", content: "l1\nl2\n\n\n" });
		dm.toolResult("已写入 y.ts（70B）", false);
		dm.toolOpen = true;
		const plain = dm.frameLines(80).map(stripAnsi);
		expect(plain[0]).toBe("● Used Write (y.ts) · 2 行"); // chip = 剥净全部尾空段后的内容行数（旧：4）
		expect(plain.filter((l) => /^ +\d+ {2}l\d$/.test(l)).length).toBe(2); // 预览恰 2 行——两口径一致
	});
});

describe("工具结果按 callId 配对（2026-09-25 用户实机错配修复）", () => {
	it("① 并发乱序：后发起的先完成——结果各归各行（callId 精确配对，不交叉挂错）", () => {
		const dm = new DocModel();
		dm.toolCall("tool-fs__glob", { pattern: "*" }, "g1");
		dm.toolCall("tool-shell__bash", { command: 'git status; echo "---"; git log --oneline -15' }, "b1");
		// 完成序与发起序相反（快工具后发起先完成）：bash 慢、glob 快——glob 的 result 先到
		dm.toolResult("file1.ts\nfile2.ts", false, "g1");
		dm.toolResult("[退出码 1]\ngit: 'status;' is not a git command", true, "b1");
		const lines = dm.frameLines(100).map(stripAnsi);
		expect(lines.some((l) => l.includes("Used Glob (*)") && l.includes("2 行"))).toBe(true); // glob 挂行数
		expect(lines.some((l) => l.includes("Used Bash") && l.includes("失败"))).toBe(true); // bash 挂失败——修前 glob 的 result 会先挂到 bash 行、bash 的失败挂到 glob 行
		expect(lines.some((l) => l.includes("Used Glob") && l.includes("失败"))).toBe(false);
	});

	it("② callId 缺席（旧会话日志兼容）：回退最近未完结条目（现状行为保持）", () => {
		const dm = new DocModel();
		dm.toolCall("tool-fs__glob", { pattern: "*" });
		dm.toolCall("tool-shell__bash", { command: "git status" });
		dm.toolResult("a.ts", false); // 无 id → 最近未完结 = bash（旧启发式）
		const lines = dm.frameLines(100).map(stripAnsi);
		expect(lines.some((l) => l.includes("Used Bash") && l.includes("1 行"))).toBe(true);
	});
});

describe("子代理送回行渲染（M4.5 T9——灰色系统行，非用户块）", () => {
	it("㉝ sourceModule=tool-subagent 的 steering 走灰色 raw 行；普通 steer 照旧用户块", () => {
		const dm = new DocModel();
		dm.historyFrom([
			{ type: "agent/steering-message", messages: [{ text: "[非用户输入] 后台子代理 调研 完成：结论首行", sourceModule: "tool-subagent" }] },
			{ type: "agent/steering-message", messages: [{ text: "用户 steer 的话", sourceModule: "host" }] },
		], 80);
		const lines = dm.frameLines(80).map(stripAnsi);
		expect(lines.some((l) => l.includes("后台子代理 调研 完成：结论首行"))).toBe(true);
		expect(lines.some((l) => l.includes("用户 steer 的话"))).toBe(true); // 普通 steer 照旧回显
		// 灰色形态：送回行带 muted 色码（区别于用户块形态）——用带色原文断言
		const colored = dm.frameLines(80).find((l) => l.includes("后台子代理 调研"));
		expect(colored).toBeDefined();
		expect(colored! !== stripAnsi(colored!)).toBe(true);
	});
	it("㉝b host/date 日期系统行回放不渲染（2026-09-28 修复：resume 后流区不冒「系统提醒：今天是…」——对齐实时路 renderEvent 不渲染）", () => {
		const dm = new DocModel();
		dm.historyFrom([
			{ type: "user/message", content: [{ kind: "text", text: "用技能干活" }] },
			{ type: "agent/steering-message", messages: [{ text: "[非用户输入] 系统提醒：今天是 2026-09-28。", sourceModule: "host/date" }] },
			{ type: "assistant/message", content: [{ kind: "text", text: "好" }] },
		], 80);
		const lines = dm.frameLines(80).map(stripAnsi);
		expect(lines.some((l) => l.includes("系统提醒"))).toBe(false); // 日期行不显示
		expect(lines.some((l) => l.includes("用技能干活"))).toBe(true); // 前后消息照常
	});
describe("子代理 agent 组条目（2026-09-27 用户拍板：spawn 工具行合并为组——绝不显示 Using Spawn）", () => {
	it("㊿-6 组条目：agentGroupCall 开组、provider 现算行、连续 spawn 并一组、终态后新组", () => {
		const dm = new DocModel();
		const roster: import("@orosus/contracts/module").SubagentRosterEntry[] = [];
		dm.agentProvider = () => roster;
		dm.agentGroupCall(); // 第一次 spawn
		roster.push({ id: "aaaa1111", depth: 1, label: "调研", status: "running", background: false, turns: 1, enqueuedAt: "t" } as never);
		let lines = dm.frameLines(80).map(stripAnsi);
		expect(lines.some((l) => l.includes("● 1 general agents 运行中"))).toBe(true);
		expect(lines.some((l) => l.includes("Using"))).toBe(false); // 绝不显示 Using Spawn
		dm.agentGroupCall(); // 末组活着 → 并组
		expect(dm.frameLines(80).filter((l) => l.includes("agents")).length).toBe(1); // 仍只有一组
		roster[0] = { ...roster[0]!, status: "completed" } as never;
		dm.agentGroupCall(); // 末组全终态 → 开新组
		roster.push({ id: "bbbb2222", depth: 1, label: "第二波", status: "running", background: false, turns: 0, enqueuedAt: "t" } as never);
		lines = dm.frameLines(80).map(stripAnsi);
		expect(lines.filter((l) => l.includes("agents ")).length).toBe(2); // 两组各自渲染
	});

	it("㊿-7 回放：spawn 重建 agent 组（callId 配对从 result 抠编号）——同轮连续 spawn 并组、轮边界断组；spawn 不出工具行、非 spawn 照常", () => {
		const dm = new DocModel();
		const roster: import("@orosus/contracts/module").SubagentRosterEntry[] = [
			{ id: "aaaa1111", depth: 1, label: "调研", status: "completed", background: false, turns: 3, enqueuedAt: "t" } as never,
			{ id: "bbbb2222", depth: 1, label: "检索", status: "completed", background: true, turns: 2, enqueuedAt: "t" } as never,
		];
		dm.agentProvider = () => roster;
		dm.historyFrom([
			{ type: "user/message", content: [{ kind: "text", text: "去查" }] },
			{ type: "assistant/message", content: [] },
			{ type: "tool/call", name: "tool-subagent__spawn", callId: "c1", args: {} },
			{ type: "tool/result", callId: "c1", output: "- aaaa1111 · 完成\n结论：略" },
			{ type: "tool/call", name: "tool-subagent__spawn", callId: "c2", args: {} }, // 同轮（无 assistant 边界）→ 并组
			{ type: "tool/result", callId: "c2", output: "已派出后台子代理：bbbb2222" },
			{ type: "tool/call", name: "tool-fs__read", callId: "c3", args: { path: "a.ts" } },
		], 80);
		const lines = dm.frameLines(80).map(stripAnsi);
		expect(lines.filter((l) => l.includes("agents ")).length).toBe(1); // 同轮两 spawn 并一组
		expect(lines.some((l) => l.includes("调研"))).toBe(true);          // 组员 = result 抠出的编号现算
		expect(lines.some((l) => l.includes("检索"))).toBe(true);
		expect(lines.some((l) => l.includes("Using"))).toBe(true);         // 非 spawn 照常工具行
		expect(lines.some((l) => l.includes("Spawn"))).toBe(false);        // spawn 绝不出工具行
		expect(lines.some((l) => l.includes("结论：略"))).toBe(false);      // spawn result 不落行（组里已有）
	});
});

describe("回放 agent 组重建集成（2026-09-27：重载后与实时同形——盘上布局 → 历史名册 → 回放组 → 渲染）", () => {
	let dir: string | undefined;
	it("㊿-8 真盘布局：spawn call/result 落主会话文件 + agents/ 目录在盘 → loadHistoricalSubagents 喂 provider → historyFrom 回放出完整组（两端抠编号口径一致）", () => {
		dir = mkdtempSync(join(tmpdir(), "orosus-replay-"));
		const mainSid = "main-sid";
		// 主会话文件：一轮 user→assistant→spawn call→result（结果文本含 8 位编号——回放组与历史重建都从这抠）
		const mainEvents = [
			{ type: "user/message", content: [{ kind: "text", text: "查一下" }] },
			{ type: "assistant/message", content: [] },
			{ type: "tool/call", name: "tool-subagent__spawn", callId: "c1", args: { description: "调研依赖", background: true } },
			{ type: "tool/result", callId: "c1", output: "后台已入册（1 个，跑完自动送回）：a3f9c2e1" },
		];
		mkdirSync(join(dir, mainSid, "agents"), { recursive: true }); // 主会话文件 = JsonlStore 原生形状 <sid>/agents/session.jsonl
		writeFileSync(join(dir, mainSid, "agents", "session.jsonl"), mainEvents.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
		// 子代理会话文件（决策 19 落盘形状）：header 带 parentSession、turn/step、turn/end completed、usage
		const agentEvents = [
			{ type: "session/header", parentSession: mainSid },
			{ type: "turn/step", ts: "2026-09-27T10:00:00Z" },
			{ type: "tool/call", name: "tool-fs__read" },
			{ type: "turn/end", kind: "completed", ts: "2026-09-27T10:00:05Z", usage: { input: 100, output: 50 } },
		];
		const agentDir = join(dir, mainSid, "agents", "agents_a3f9c2e1", "agents");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "session.jsonl"), agentEvents.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
		// 宿主 provider 合并形态（main.ts attachRender 同款）：活名册空 + 盘上历史按组引用补挂
		const hist = loadHistoricalSubagents(dir, mainSid);
		expect(hist.length).toBe(1);
		expect(hist[0]!.id).toBe("a3f9c2e1");
		const dm = new DocModel();
		dm.agentProvider = () => {
			const want = dm.groupIds();
			return hist.filter((e) => want.has(e.id));
		};
		dm.historyFrom(JSON.parse(JSON.stringify(mainEvents)) as { type: string }[], 80);
		const lines = dm.frameLines(80).map(stripAnsi);
		expect(lines.some((l) => l.includes("● 1 general agents 完成"))).toBe(true); // 组头（全终态聚合态）
		expect(lines.some((l) => l.includes("调研依赖"))).toBe(true);                 // 简述从 spawn 参数回查
		expect(lines.some((l) => l.includes("后台"))).toBe(true);                     // 后台标注
		expect(lines.some((l) => l.includes("Spawn"))).toBe(false);                   // spawn 不出工具行
		rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});
});

describe("tasks 纯查询行静默（2026-09-27 拍板：收进 agent 组，不一行行刷屏）", () => {
	it("㊿-9 tasks 的 call+result 整对吞掉：不占行、不错挂到其他工具行；旧日志无 callId 旗标兜底", () => {
		const dm = new DocModel();
		dm.toolCall("tool-subagent__tasks", {}, "t1");
		dm.toolResult("- aaaa · 运行中", false, "t1");
		dm.toolCall("tool-shell__bash", { command: "ls" }, "b1");
		dm.toolResult("ok", false, "b1");
		let lines = dm.frameLines(80).map(stripAnsi);
		expect(lines.some((l) => l.includes("Tasks"))).toBe(false); // tasks 无影
		expect(lines.some((l) => l.includes("Bash"))).toBe(true);   // 其他工具照常
		expect(lines.some((l) => l.includes("运行中"))).toBe(false); // tasks 结果也没串进别人的行
		// 旧日志（无 callId）：call 吞后紧跟的孤儿结果也吞——不落到 Bash 行上
		dm.toolCall("tool-subagent__tasks", {});
		dm.toolResult("- bbbb · 运行中", false);
		lines = dm.frameLines(80).map(stripAnsi);
		expect(lines.some((l) => l.includes("bbbb"))).toBe(false);
	});

	it("㊿-10 CTW-10 旧日志乱序：tasks 静默 call 后夹其他工具的 call/result——中间结果不被吞、不错挂（位置感知旗标）", () => {
		const dm = new DocModel();
		dm.historyFrom([
			{ type: "tool/call", name: "tool-subagent__tasks", args: {} }, // 静默 call（无 callId）
			{ type: "tool/call", name: "tool-shell__bash", args: { command: "ls" } }, // 乱序实存（2026-09-25 前旧会话）：并发后发先完成
			{ type: "tool/result", output: "file1\nfile2", isError: false }, // bash 的结果——旧：被 tasks 旗标吞掉、Bash 行永显 Using
			{ type: "tool/result", output: "- aaaa · 运行中", isError: false }, // tasks 的孤儿结果——旧：错挂到 bash 行（1 行 chip）
		], 80);
		const lines = dm.frameLines(80).map(stripAnsi);
		expect(lines.some((l) => l.includes("Used Bash") && l.includes("2 行"))).toBe(true); // bash 结果各归各行
		expect(lines.some((l) => l.includes("Using Bash"))).toBe(false); // 不再因吞错而冻结 Using
		expect(lines.some((l) => l.includes("运行中"))).toBe(false); // 孤儿无处可挂不落屏（宁可不挂不错挂）
	});
});

});

describe("DocModel 活动思考块增量折行（m5-render-perf T1——LiveWrap 接线，热点 (a)）", () => {
	/** 旧路径参照实现（docmodel.ts thinkBlock 的原样拷贝——接线后行为须与之逐字节相等）。 */
	const legacyThink = (text: string, w: number, open: boolean): string[] => {
		const raw = wrapText(text, Math.max(8, w - 2));
		if (!open) {
			const head = theme.dim("[思考] · Alt + E 展开");
			return [head, ...raw.slice(-2).map((l) => theme.dim("  " + l))];
		}
		return raw.map((l, i) => theme.dim((i === 0 ? "[思考] " : "  ") + l));
	};
	const thinkSource =
		"先分析问题的结构再决定方案。\n" +
		"考虑边界：check:boundaries 与 https://example.com/long/path/component?query=1 的词原子。\n\n" +
		"中文与 English 混排的长段落，用来覆盖超宽折行与 CJK 禁则（括号「」【】不许收尾开头）的各类断点形态，" +
		"再加 ❤️ emoji 与组合字符的重度混合。".repeat(3);

	it("① 全链路等价：逐 delta 喂入每步 frameLines == 该时刻旧路径（wrapText + 现有样式），收起/展开两态", () => {
		for (const open of [false, true]) {
			const dm = new DocModel();
			dm.thinkOpen = open;
			let acc = "";
			let prev = 0;
			for (const n of [3, 11, 5, 27, 9, 40, 2, 16, 33, 8, 21, 60, 4]) {
				acc = thinkSource.slice(0, Math.min(thinkSource.length, acc.length + n));
				dm.activity({ kind: "reasoning", text: acc.slice(prev) }, 80);
				prev = acc.length;
				const got = dm.frameLines(80);
				expect(got, `open=${open} len=${acc.length}`).toEqual(legacyThink(acc, 80, open));
			}
		}
	});

	it("② Alt+E 流中切换：同一累积文本下收起/展开两态各自与旧路径一致（一份裸行缓存两态共用）", () => {
		const dm = new DocModel();
		let acc = "";
		for (const n of [15, 30, 45, 60]) {
			const prev = acc.length;
			acc = thinkSource.slice(0, acc.length + n);
			dm.activity({ kind: "reasoning", text: acc.slice(prev) }, 80);
			dm.thinkOpen = false;
			expect(dm.frameLines(80)).toEqual(legacyThink(acc, 80, false));
			dm.thinkOpen = true;
			expect(dm.frameLines(80)).toEqual(legacyThink(acc, 80, true));
		}
	});

	it("③ end() 定格行 == 定格前最后一帧活动块行（含 ANSI 逐字节）——LiveWrap 路径与 thinkBlock 定格路径同形", () => {
		const dm = new DocModel();
		dm.thinkOpen = true;
		dm.activity({ kind: "reasoning", text: thinkSource }, 80);
		const before = dm.frameLines(80); // 活动块最后一帧（LiveWrap 路径）
		dm.end(80); // settleActive → think 条目（thinkBlock 一次折行路径）
		expect(dm.frameLines(80)).toEqual(before);
		dm.thinkOpen = false; // 收起态也同形（样式在两路径共用 styleWrappedThink）
		const b2 = dm.frameLines(80);
		dm.discard();
		expect(b2).toEqual(legacyThink(thinkSource, 80, false));
	});
});

describe("DocModel 视口窗口化（m5-render-perf T4——条目级行数账本 + frameWindow 只物化窗口）", () => {
	/** 随机文档构造器：混合 user/md/think(收起+展开)/tool(含 result/失败)/raw/skill/group 条目。 */
	const buildDoc = (seed: number): DocModel => {
		let s = seed >>> 0;
		const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
		const dm = new DocModel();
		dm.agentProvider = () => [
			{ id: "a1", label: "探索", status: "completed", spawnedAt: 0, model: "fake/m" },
			{ id: "a2", label: "实现", status: "running", spawnedAt: 0, model: "fake/m" },
		] as unknown as readonly import("@orosus/contracts/module").SubagentRosterEntry[];
		const n = 6 + Math.floor(rnd() * 8);
		for (let i = 0; i < n; i++) {
			const kind = Math.floor(rnd() * 7);
			if (kind === 0) dm.userPrompt(`用户提问 ${i} `.repeat(1 + Math.floor(rnd() * 30)));
			else if (kind === 1) { dm.activity({ kind: "reasoning", text: `推理 ${i} `.repeat(1 + Math.floor(rnd() * 50)) }, 80); dm.end(80); }
			else if (kind === 2) { dm.activity({ kind: "text", text: `**回答** ${i} 一段 markdown 正文，含长词 check:boundaries 与列表：\n- 甲\n- 乙`.repeat(1 + Math.floor(rnd() * 3)) }, 80); dm.end(80); }
			else if (kind === 3) { dm.write(`● Using Read (src/file${i}.ts)\n`, 80); if (rnd() < 0.7) dm.write(TOOL_MERGE + `${1 + Math.floor(rnd() * 40)} 行\n`, 80); }
			else if (kind === 4) { const c = `c${i}`; dm.toolCall("tool-fs__read", { path: `src/f${i}.ts` }, c); dm.toolResult("a\nb\nc", rnd() < 0.3, c); }
			else if (kind === 5) dm.pushLine(`一行提示 ${i} ` + "普通文本 ".repeat(Math.floor(rnd() * 30)));
			else dm.agentGroupCall();
		}
		return dm;
	};

	it("① 窗口等价性质：随机文档多组 (s,m)——frameWindow == frameLines.slice 且 totalLines == frameLines.length", () => {
		for (const open of [false, true]) {
			const dm = buildDoc(7);
			dm.thinkOpen = open;
			dm.toolOpen = open;
			const full = dm.frameLines(60); // 先全量（兼容包装内部也走窗口路径）
			expect(dm.totalLines(60)).toBe(full.length);
			let st = 12345;
			const rnd = (): number => ((st = (st * 1664525 + 1013904223) >>> 0) / 0x100000000);
			for (let k = 0; k < 30; k++) {
				const s0 = Math.floor(rnd() * full.length);
				const m = 1 + Math.floor(rnd() * 25);
				const got = dm.frameWindow(60, s0, m);
				expect(got, `open=${open} s=${s0} m=${m}`).toEqual(full.slice(s0, s0 + m));
			}
			// 窗口起点超尾：空数组
			expect(dm.frameWindow(60, full.length + 10, 5)).toEqual([]);
		}
	});

	it("② refoldAll 后几何恒精确：换宽全量重折——totalLines == 新宽全量长度、窗口切片 == 新宽 frameLines 切片（无双态无收敛）", () => {
		const dm = buildDoc(11);
		dm.frameLines(80); // 旧宽入账
		dm.refoldAll(30);
		const fresh = (() => { const d2 = buildDoc(11); d2.thinkOpen = dm.thinkOpen; return d2.frameLines(30); })(); // 独立新例按 30 宽全量渲染
		expect(dm.totalLines(30)).toBe(fresh.length); // == Σ精确计数（无估计值）
		expect(dm.frameWindow(30, 0, fresh.length)).toEqual(fresh);
		expect(dm.frameWindow(30, Math.floor(fresh.length / 3), 7)).toEqual(fresh.slice(Math.floor(fresh.length / 3), Math.floor(fresh.length / 3) + 7));
		// 回宽仍精确
		dm.refoldAll(80);
		expect(dm.totalLines(80)).toBe(dm.frameLines(80).length);
	});

	it("③ 新入列条目计数即时精确——不依赖先被渲染过（totalLines 读口自动补账）", () => {
		const dm = new DocModel();
		dm.userPrompt("第一问");
		const n1 = dm.totalLines(80);
		expect(n1).toBe(dm.frameLines(80).length);
		dm.pushLine("后来追加的一行提示"); // 未渲染——计数须即时
		dm.pushMd("追加的 **markdown** 段", 80);
		expect(dm.totalLines(80)).toBe(dm.frameLines(80).length); // 补账后恒等
		expect(dm.totalLines(80)).toBeGreaterThan(n1);
	});

	it("④ 条目原位变更（toolResult 挂上）后账本行更新、窗口内容反映变更", () => {
		const dm = new DocModel();
		dm.toolCall("tool-fs__read", { path: "src/a.ts" }, "c1");
		dm.frameLines(80); // Using 态入账
		dm.toolResult("line1\nline2\nline3", false, "c1"); // 挂 result → Using 变 Used + chip
		expect(dm.totalLines(80)).toBe(dm.frameLines(80).length); // 账本恒精确（计数已反映变更）
		expect(dm.frameWindow(80, 0, 10).map(stripAnsi).join("\n")).toContain("● Used Read (src/a.ts)"); // 窗口内容反映变更
		// 失败体展开态走键校验重折（errOpen 在帧入口捕获）——同样恒精确
		dm.errOpen = true;
		expect(dm.totalLines(80)).toBe(dm.frameLines(80).length);
	});
});

describe("DocModel 性能回归钉二（m5-render-perf T6——防三处退化：稳态帧全量物化/窗口超预算/冷却失效）", () => {
	it("① 稳态帧零折行：缓存热后连续 frameWindow/totalLines 的 debugWrapCalls 增量为 0（group/skill 除外——前者活体恒现算后者无折行）", () => {
		const dm = new DocModel();
		for (let i = 0; i < 40; i++) {
			dm.userPrompt(`用户第 ${i} 问 `.repeat(6));
			dm.activity({ kind: "reasoning", text: `推理 ${i} `.repeat(40) }, 80);
			dm.activity({ kind: "text", text: `**答** ${i} 一段正文内容加长以触发折行路径。`.repeat(4) }, 80);
			dm.end(80);
			dm.toolCall("tool-fs__read", { path: `src/f${i}.ts` }, `c${i}`);
			dm.toolResult("a\nb", false, `c${i}`);
			dm.pushLine(`提示行 ${i} ` + "文本 ".repeat(15));
		}
		dm.frameWindow(80, 0, 50); // 热缓存（首帧全量渲染）
		const base = dm.debugWrapCalls;
		expect(base).toBeGreaterThan(0); // 首帧确实折过（自证观测口活着）
		dm.frameWindow(80, 0, 50);
		dm.frameWindow(80, 30, 25);
		dm.totalLines(80);
		expect(dm.debugWrapCalls).toBe(base); // 稳态三连帧零折行——被接回全量物化则必红
	});

	it("② 每帧物化行数 ≤ 请求 maxLines；500ms 内二次宽度变化只重折一次（护栏②接线——fullapp 冷却吞 = DocModel 不见第二次换宽）", async () => {
		const dm = new DocModel();
		for (let i = 0; i < 60; i++) dm.pushLine(`历史行 ${i} ${"内容".repeat(i % 12)}`);
		for (const [s, m] of [[0, 10], [20, 40], [55, 5]] as const) {
			expect(dm.frameWindow(80, s, m).length).toBeLessThanOrEqual(m); // 返回侧不超预算
		}
		// 冷却护栏（fullapp 级接线验证——DocModel 真例行源 rig）：
		const { FullApp } = await import("./fullapp.ts");
		const { EventEmitter } = await import("node:events");
		const input = new EventEmitter() as unknown as NodeJS.ReadStream;
		(input as unknown as { isTTY: boolean }).isTTY = true;
		(input as unknown as { setRawMode: unknown }).setRawMode = () => input;
		(input as unknown as { setEncoding: unknown }).setEncoding = () => input;
		(input as unknown as { resume: unknown }).resume = () => input;
		(input as unknown as { pause: unknown }).pause = () => input;
		const output = new EventEmitter() as unknown as NodeJS.WriteStream & { buf: string };
		(output as unknown as { buf: string }).buf = "";
		(output as unknown as { columns: number }).columns = 100;
		(output as unknown as { rows: number }).rows = 30;
		output.write = ((s: string) => {
			(output as unknown as { buf: string }).buf += s;
			return true;
		}) as NodeJS.WriteStream["write"];
		const w = (): number => appRef?.streamCols ?? 96; // 生产同源：streamCols 随 sidebarVisible 变（宽度链真通）
		let appRef: import("./fullapp.ts").FullApp | undefined;
		const app = new FullApp({
			columns: () => 100,
			rows: () => 30,
			docTotal: () => dm.totalLines(w()),
			docWindow: (s, c) => dm.frameWindow(w(), s, c),
			submit: () => {},
			requestCancel: () => {},
			panelData: () => ({ model: "m", session: "s", cwd: "d", tokens: { input: 0, output: 0 }, startedAt: new Date().toISOString(), contextWindow: 200_000, modules: [], tasks: [], permission: "never", permissionNext: () => "/permission ask-always" }),
			slashCommands: () => [],
			slashCurrent: () => "",
			thinkOpen: () => false,
			toggleThink: () => {},
			toggleTool: () => {},
			toggleErr: () => {},
			queueItems: () => [],
			recallQueued: () => undefined,
			requestSteer: () => {},
		}, { input, output });
		appRef = app;
		app.start();
		await new Promise((r) => setTimeout(r, 40));
		dm.debugWrapCalls = 0;
		expect(app.setSidebar(false)).toBe(true); // 第一次切换：宽度变化 → 全量重折
		await new Promise((r) => setTimeout(r, 60));
		const afterFirst = dm.debugWrapCalls;
		expect(afterFirst).toBeGreaterThan(0); // 重折确实发生（换宽击穿缓存）
		expect(app.setSidebar(true)).toBe(false); // 冷却内被吞——不切 = 不换宽
		await new Promise((r) => setTimeout(r, 60));
		expect(dm.debugWrapCalls).toBe(afterFirst); // 没有第二次全量重折（护栏②生效）
		app.stop();
	});
});

describe("DocModel kimi 式轮次滑窗 + 远区缓存淘汰（m5-render-perf T7——D11-D13）", () => {
	/** 造 n 轮对话：每轮 user 提问 + 定格回答（md）+ 帧渲染（counts 热——贴近宿主每帧渲染时序，
	 *  裁剪判定的行账本生产恒热）+ turnEnd。 */
	const turns = (dm: DocModel, n: number, from = 0): void => {
		for (let i = from; i < from + n; i++) {
			dm.userPrompt(`第 ${i} 轮提问`);
			dm.activity({ kind: "text", text: `第 ${i} 轮回答内容，`.repeat(6) }, 80);
			dm.end(80);
			dm.frameLines(80);
			dm.turnEnd();
		}
	};

	it("① 轮次记账与裁剪触发：21 轮裁到 15 轮 + 折叠行在头部 + 第 8 轮起内容完整；env 0 = 不裁", () => {
		const dm = new DocModel();
		dm.turnWindowEnabled = true;
		turns(dm, 21); // 轮号 0..20，第 21 个 turnEnd 后 curTurn=21 → 22 轮 > 20 裁到 15（保留轮 7..21）
		const plain = dm.frameLines(80).map(stripAnsi);
		expect(plain.some((l) => l.includes("已折叠更早的") && l.includes("轮对话"))).toBe(true); // 折叠行（D12 文案）
		expect(plain.join("\n")).not.toContain("第 3 轮提问"); // 早期轮已销毁
		expect(plain.join("\n")).toContain("第 7 轮提问"); // 保留窗最老轮（15 轮 = 7..21）
		expect(plain.join("\n")).toContain("第 20 轮回答"); // 最新轮完整
		// env 0 = 逃生阀不裁
		const dm2 = new DocModel();
		dm2.turnWindowEnabled = true;
		process.env.OROSUS_TUI_MAX_TURNS = "0";
		try {
			turns(dm2, 25);
			const p2 = dm2.frameLines(80).map(stripAnsi).join("\n");
			expect(p2).toContain("第 0 轮提问"); // 全保留
			expect(p2).not.toContain("已折叠更早的");
		} finally {
			delete process.env.OROSUS_TUI_MAX_TURNS;
		}
	});

	it("② 阅读保护：视口在最老轮（head）时整批顺延不裁；滚回底部后下一次触发再裁（几何安全前提 = 恒头部移除）", () => {
		const dm = new DocModel();
		dm.turnWindowEnabled = true;
		let head = true; // 视口钉在头部（最老轮上方）
		dm.viewportProbe = () => (head ? { start: 0, end: 8 } : { start: dm.totalLines(80) - 8, end: dm.totalLines(80) });
		turns(dm, 21); // 22 轮超阈——但被裁段与视口相交 → 整批顺延
		expect(dm.frameLines(80).map(stripAnsi).join("\n")).toContain("第 0 轮提问"); // 没裁
		head = false; // 滚回底部
		turns(dm, 1, 21); // 下一轮触发再裁（from=21：新一轮文案与被裁旧轮不撞名）
		const plain = dm.frameLines(80).map(stripAnsi).join("\n");
		expect(plain).not.toContain("第 0 轮提问"); // 这才裁掉
		expect(plain).toContain("已折叠更早的");
	});

	it("③ resume 即裁：historyFrom 喂 30 轮事件后 = 最近 15 轮 + 折叠行（大会话恢复只物化最近窗）", () => {
		const events: { type: string; [k: string]: unknown }[] = [];
		for (let i = 0; i < 30; i++) {
			events.push({ type: "user/message", content: [{ kind: "text", text: `历史问 ${i}` }] });
			events.push({ type: "assistant/message", content: [{ kind: "text", text: `历史答 ${i} `.repeat(10) }] });
			events.push({ type: "turn/end" });
		}
		const dm = new DocModel();
		dm.turnWindowEnabled = true;
		dm.historyFrom(events, 80);
		const plain = dm.frameLines(80).map(stripAnsi).join("\n");
		expect(plain).not.toContain("历史问 5"); // 早轮裁掉（30 轮 → 保留 15..29... 轮号判定见实现）
		expect(plain).toContain("已折叠更早的");
		expect(plain).toContain("历史问 29"); // 最新轮在
	});

	it("④ 远区缓存淘汰：距视口 > 3 轮的条目丢渲染缓存——滚回该区输出与淘汰前逐字节一致（计数未丢、几何不变）", () => {
		const dm = new DocModel();
		for (let i = 0; i < 10; i++) {
			dm.userPrompt(`轮 ${i} 提问`);
			dm.pushLine(`轮 ${i} 提示行内容 `.repeat(3));
			dm.turnEnd();
		}
		const before = dm.frameWindow(80, 0, 10_000); // 全量基线（渲染热）
		dm.evictFarCaches(dm.totalLines(80) - 2); // 视口在最新轮（轮 9）——距 3 轮外（轮 ≤ 5）淘汰
		const after = dm.frameWindow(80, 0, 10_000);
		expect(after).toEqual(before); // 源与 counts 保留——重渲逐字节一致
		expect(dm.totalLines(80)).toBe(before.length); // 计数未丢
	});
});

describe("工具失败体展开帽（m5-render-perf 走查③修——旧帽 60 整屏 err 色，对齐 kimi RESULT_PREVIEW_LINES 预览哲学）", () => {
	it("Alt+F 展开态：错误体只显前 10 行 + 「其余 N 行从略」提示；收起态照旧仅头行", () => {
		const dm = new DocModel();
		const output = Array.from({ length: 15 }, (_, i) => `输出行 ${i}`).join("\n");
		dm.toolCall("tool-shell__bash", { command: "npm create vite" }, "c1");
		dm.toolResult(output, true, "c1");
		const collapsed = dm.frameLines(80).map(stripAnsi).join("\n");
		expect(collapsed).toContain("● Used Bash"); // 头行在
		expect(collapsed).not.toContain("输出行 0"); // 收起态零正文
		dm.errOpen = true;
		const opened = dm.frameLines(80).map(stripAnsi);
		const body = opened.filter((l) => l.includes("输出行"));
		expect(body).toHaveLength(10); // 帽 10（旧帽 60 则 15 行全铺）
		expect(opened.some((l) => l.includes("其余 5 行从略"))).toBe(true); // 提示行带余量数
	});
});
