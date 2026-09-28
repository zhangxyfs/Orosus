import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocModel } from "./docmodel.ts";
import * as toolview from "./toolview.ts";
import * as theme from "../theme.ts";
import { stripAnsi } from "./width.ts";
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
