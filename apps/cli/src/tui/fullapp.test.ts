import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { FullApp, diagListLines, indexAtRowCol, layoutInputRows, locateCursor, type FullAppIO, type PanelData, type SlashItem } from "./fullapp.ts";
import type { AtEntry } from "./fullapp-at.ts";
import type { DialogSpec } from "@orosus/contracts/module";
import { stripAnsi, visibleWidth } from "./width.ts";
import { pickPageOf } from "./fullapp-overlay.ts";
import { fg, dim } from "../theme.ts";

type FakeInput = NodeJS.ReadStream;
type FakeOutput = NodeJS.WriteStream & { buf: string };

function fakeTerm(cols = 100, rows = 30): { input: FakeInput; output: FakeOutput } {
	const input = new EventEmitter() as FakeInput;
	input.isTTY = true;
	input.setRawMode = (() => input) as FakeInput["setRawMode"];
	input.setEncoding = (() => input) as FakeInput["setEncoding"];
	input.resume = (() => input) as FakeInput["resume"];
	input.pause = (() => input) as FakeInput["pause"];
	const output = new EventEmitter() as FakeOutput;
	output.buf = "";
	output.columns = cols;
	output.rows = rows;
	output.write = ((s: string) => {
		output.buf += s;
		return true;
	}) as FakeOutput["write"];
	return { input, output };
}

/** 默认面板数据（m5 T6：rig 与卡组测试共用——测试侧展开后覆写 cards）。 */
function defaultPanelData(): PanelData {
	return {
				model: "glm-5.3",
				session: "test-sid",
				cwd: "D:/x",
				tokens: { input: 12408, output: 3052 },
				startedAt: new Date(Date.now() - 12 * 60000).toISOString(),
				contextWindow: 100000,
				modules: [
					{ name: "orosus-core", desc: "核心循环", state: "mounted", locked: true },
					{ name: "orosus-mcp", desc: "MCP 桥接", state: "off" },
				],
				tasks: [{ text: "样例任务", state: "active" }],
				permission: "ask-risky",
				permissionNext: () => "/permission ask-always",
	};
}

function rig(docLines: string[] = ["# 你好"], cols = 100, rows = 30, over: Partial<FullAppIO> = {}) {
	const submitted: string[] = [];
	const actions: string[] = [];
	const queue: string[] = [];
	const io: FullAppIO = {
		columns: () => cols,
		rows: () => rows,
		docTotal: () => docLines.length,
		docWindow: (s, c) => docLines.slice(s, s + c),
		submit: (t) => submitted.push(t),
		// CTU-11：requestExit 死接口已三方删除（fullapp.ts 声明 + main.ts 实现 + 本桩）
		requestCancel: () => actions.push("cancel"),
		queueItems: () => [...queue],
		recallQueued: () => queue.pop(),
		requestSteer: (texts) => actions.push(`steer:${texts.join("|")}`),
		panelData: () => defaultPanelData(),
		slashCommands: () => [
			{ name: "/help", desc: "帮助", long: "长说明" },
			{ name: "/title", desc: "会话命名", long: "长" },
			{ name: "/permission", desc: "权限", long: "长", children: ["ask-risky", "never"] },
		],
		slashCurrent: () => "ask-risky",
		thinkOpen: () => false,
		toggleThink: () => actions.push("think"),
		toggleTool: () => actions.push("tool"),
		toggleErr: () => actions.push("err"),
		toggleSteps: () => actions.push("steps"),
		...over,
	};
	const { input, output } = fakeTerm(cols, rows);
	const app = new FullApp(io, { input, output });
	return { app, io, input, output, submitted, actions, queue };
}

const flush = async (ms = 40): Promise<void> => {
	await new Promise((r) => setTimeout(r, ms));
};

describe("全屏应用骨架（TUI 批阶段三 F3——双栏布局 + 焦点循环 + 崩溃恢复）", () => {
	it("① 布局：无标题栏（首行即 stream 内容）+ 右栏面板框 + 输入框带框 + 竖分隔", async () => {
		const { app, output } = rig();
		app.start();
		await flush();
		app.stop();
		const plain = stripAnsi(output.buf);
		expect(plain).toContain("# 你好");
		expect(plain).toContain("╭");
		expect(plain).toContain("运行状态");
		expect(plain).toContain("任务清单");
		expect(plain).toContain("│");
		expect(plain).toContain("❯");
		expect(output.buf.startsWith("\x1b[?1049h")).toBe(true); // 进 alt-screen
	});
	it("② Tab 焦点循环 → 聚焦面板框变青玉（accent SGR）", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		const before = output.buf;
		input.emit("data", "\t");
		await flush();
		app.stop();
		const after = output.buf.slice(before.length);
		expect(after.includes("\x1b[38;2;124;201;165m") || after.includes("\x1b[38;5;115m")).toBe(true); // accent 聚焦框（truecolor/256 两形态）
	});
	it("③ 输入编辑与提交：打字 → Enter → submit；↑ 召回历史", async () => {
		const { app, input, submitted } = rig();
		app.start();
		await flush();
		input.emit("data", "你好");
		input.emit("data", "\r");
		await flush();
		expect(submitted).toEqual(["你好"]);
		input.emit("data", "\x1b[A"); // ↑ 召回
		await flush();
		app.stop();
		expect(stripAnsi((app as unknown as { state: { input: string } }).state.input)).toBe("你好");
	});
	it("③c ↑/↓ 分级历史导航（2026-09-23 走查拍板，kimi pi-tui editor.ts 规格照抄）：行内上移 → 回首 → 才召回；草稿快照恢复", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "第一条"); // 先造一条历史
		input.emit("data", "\r");
		await flush();
		input.emit("data", "草"); // 两行草稿
		input.emit("data", "\x1b\r"); // Alt+Enter 换行
		input.emit("data", "稿");
		await flush();
		input.emit("data", "\x1b[A"); // 光标在第二行 → 上移一行（不召回）
		await flush();
		expect(app.stateRef.input).toBe("草\n稿");
		expect(app.stateRef.cursor).toBe(1); // 移到第一行同列（"草"后）
		input.emit("data", "\x1b[A"); // 第一行非起始 → 回起始点（仍不召回）
		await flush();
		expect(app.stateRef.cursor).toBe(0);
		expect(app.stateRef.input).toBe("草\n稿");
		input.emit("data", "\x1b[A"); // 起始点 → 召回上一条历史
		await flush();
		expect(app.stateRef.input).toBe("第一条");
		input.emit("data", "\x1b[B"); // ↓ 翻回最新位 → 草稿原样恢复
		await flush();
		expect(app.stateRef.input).toBe("草\n稿");
		app.stop();
	});
	it("CTU-02 emoji 退格整对删除（2026-09-28 code review）：输入 😀ab 逐次退格清空，无孤立代理残留", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "😀ab");
		await flush();
		expect([...app.stateRef.input]).toEqual(["😀", "a", "b"]); // 码点展开——插入路径未被劈开
		input.emit("data", "\x7f"); // 退格删 b
		await flush();
		expect(app.stateRef.input).toBe("😀a");
		input.emit("data", "\x7f"); // 退格删 a
		await flush();
		expect([...app.stateRef.input]).toEqual(["😀"]);
		input.emit("data", "\x7f"); // 退格删 emoji——整对删除（原 bug：判定区间写反只删低代理，残留孤立高代理 \ud83d）
		await flush();
		expect(app.stateRef.input).toBe(""); // 码元级断言——\ud83d 残留时此处为 "\ud83d" 而非空串
		expect(app.stateRef.cursor).toBe(0);
		app.stop();
	});
	it("③b Alt + O / Alt + F 触发工具明细/失败体折叠切换（io.toggleTool / io.toggleErr——2026-09-23 走查批）", async () => {
		const { app, input, actions } = rig();
		app.start();
		await flush();
		input.emit("data", "\x1bo");
		input.emit("data", "\x1bf");
		await flush();
		app.stop();
		expect(actions).toContain("tool");
		expect(actions).toContain("err");
	});
	it("④ PgUp/PgDn 滚动 stream（scrollBack 变化）", async () => {
		const doc = Array.from({ length: 60 }, (_, i) => `第 ${i} 行`);
		const { app, input } = rig(doc);
		app.start();
		await flush();
		const st = app as unknown as { state: { scrollBack: number } };
		expect(st.state.scrollBack).toBe(0);
		input.emit("data", "\x1b[5~"); // PgUp
		await flush();
		expect(st.state.scrollBack).toBeGreaterThan(0);
		input.emit("data", "\x1b[6~"); // PgDn
		await flush();
		expect(st.state.scrollBack).toBe(0);
		app.stop();
	});
	it("④b 面板聚焦裸键直控（2026-09-24 拍板——翻页不再借道 Shift）：状态面板 ←→ 翻页 / PgUp·PgDn 模块翻页 / ↑↓ 选择；任务面板 PgUp·PgDn 翻页；聚焦期 PgUp·PgDn 不滚对话流", async () => {
		const doc = Array.from({ length: 60 }, (_, i) => `第 ${i} 行`);
		const mods = Array.from({ length: 12 }, (_, i) => ({ name: `mod-${i}`, desc: "测试", state: "mounted" as const })); // 12 条防 clamp 混测：模块每页行数动态（44 行终端 24−15=9），PgDn 步长 9 需总数 ≥10
		const tasks = Array.from({ length: 18 }, (_, i) => ({ text: `任务 ${i}`, state: "pending" as const }));
		// 44 行：状态面板（55% 定高）才装得下底部提示行——30 行终端提示行被 slice 截掉（既有挤压口径）
		const { app, input, output } = rig(doc, 100, 44, {
			panelData: () => ({
				model: "glm-5.3",
				session: "test-sid",
				cwd: "D:/x",
				tokens: { input: 1, output: 1 },
				startedAt: new Date(Date.now() - 60000).toISOString(),
				contextWindow: 100000,
				modules: mods,
				tasks: tasks,
				permission: "ask-risky",
				permissionNext: () => "/permission ask-always",
			}),
		});
		app.start();
		await flush();
		const plain = stripAnsi(output.buf); // 首帧提示文案钉（PgUp/PgDn 能放下一行——用户拍板用完整形态）
		expect(plain).toContain("←→ 翻页 · PgUp/PgDn 模块翻页");
		expect(plain).toContain("↑↓ 模块选择 · Enter 挂/卸载");
		expect(plain).toContain("PgUp/PgDn 翻页 · Esc 返回");
		const st = app as unknown as {
			state: { scrollBack: number; moduleSel: number; taskSel: number; statePage: number; focusIdx: number };
		};
		input.emit("data", "\t"); // 焦点 → 运行状态
		await flush();
		expect(st.state.focusIdx).toBe(1);
		input.emit("data", "\x1b[C"); // → 翻页：运行状态 → 网络 · MCP
		await flush();
		expect(st.state.statePage).toBe(1);
		input.emit("data", "\x1b[D"); // ← 返回运行状态页
		await flush();
		expect(st.state.statePage).toBe(0);
		input.emit("data", "\x1b[6~"); // PgDn → 模块翻页（每页动态：44 行终端 statusH=24−15=9）：sel 0 → 9 落第 2 页
		await flush();
		expect(st.state.moduleSel).toBe(9);
		expect(st.state.scrollBack).toBe(0); // 面板聚焦期 PgUp/PgDn 归面板，不滚对话流
		input.emit("data", "\x1b[B"); // ↓ 模块选择就地 +1
		await flush();
		expect(st.state.moduleSel).toBe(10);
		input.emit("data", "\t"); // 焦点 → 任务清单
		await flush();
		expect(st.state.focusIdx).toBe(2);
		input.emit("data", "\x1b[6~"); // PgDn → 任务翻页（44 行终端 taskH=20 → 每页 14）：sel 0 → 14 落第 2 页
		await flush();
		expect(st.state.taskSel).toBe(14);
		input.emit("data", "\x1b[5~"); // PgUp 翻回第一页
		await flush();
		expect(st.state.taskSel).toBe(0);
		app.stop();
	});
	it("⑤ Ctrl+T → 侧栏开关；Ctrl+C 全屏期不占用（2026-09-23 用户拍板：WT 原生复制让位——退出走 /quit）", async () => {
		const { app, input, actions } = rig();
		app.start();
		await flush();
		input.emit("data", "\x14");
		await flush();
		expect(app.stateRef.sidebarVisible).toBe(false); // Ctrl+T = 侧栏开关（互切下线）
		expect(actions).toEqual([]); // 互切下线（用户拍板）——按键无动作
		input.emit("data", "\x03"); // Ctrl+C 不响应（复制让位——双击退出/忙碌取消均下线）
		await flush();
		expect(actions).toEqual([]);
		app.stop();
	});
	it("⑤b 忙碌中 Ctrl+C 也不再取消（复制让位同拍板——停生成只有双击 Esc）", async () => {
		const { app, input, actions } = rig();
		app.start();
		await flush();
		app.setBusy(true);
		input.emit("data", "\x03");
		await flush();
		expect(actions).toEqual([]);
		app.setBusy(false);
		app.stop();
	});
	it("⑤bb 忙碌中双击 Esc 才停止生成（2026-09-23 走查拍板——单击防误触：toast 提示，1s 窗口内再按才取消）", async () => {
		const { app, input, actions } = rig();
		app.start();
		await flush();
		app.setBusy(true);
		input.emit("data", "\x1b"); // 首按：只提示不取消
		await flush(80); // ESC 时间窗判定单 Esc
		expect(actions).toEqual([]);
		expect(app.stateRef.toast?.text).toContain("再按一次 Esc");
		input.emit("data", "\x1b"); // 窗口内再按：真正取消
		await flush(80);
		expect(actions).toEqual(["cancel"]);
		input.emit("data", "\x1b"); // 取消后（仍 busy 至 turn 收尾）按 = 重新计首按
		await flush(80);
		expect(actions).toEqual(["cancel"]);
		app.setBusy(false);
		app.stop();
	});
	it("⑤bb-b 生成中焦点在侧栏面板时 Esc 先收焦点回输入框（2026-10-01 走查——不被双击停止确认截胡；收焦点同时打断双击序列）", async () => {
		const { app, input, actions } = rig();
		app.start();
		await flush();
		app.setBusy(true);
		input.emit("data", "\t"); // Tab：焦点 0→1（侧栏模块面板）
		await flush();
		expect(app.stateRef.focusIdx).toBe(1);
		input.emit("data", "\x1b"); // 忙时 Esc：先回焦点——不提示不取消
		await flush(80);
		expect(app.stateRef.focusIdx).toBe(0);
		expect(app.stateRef.toast).toBeUndefined();
		expect(actions).toEqual([]);
		input.emit("data", "\x1b"); // 回输入框后再按 = 双击停止序列首拍（正常提示）
		await flush(80);
		expect(app.stateRef.toast?.text).toContain("再按一次 Esc");
		input.emit("data", "\x1b"); // 窗口内再按：真正取消
		await flush(80);
		expect(actions).toEqual(["cancel"]);
		app.setBusy(false);
		app.stop();
	});
	it("⑤bb-c 注入查看窗两层 Esc 退出不得触发双击停止（2026-10-04 用户实机：Ctrl+H 看注入全文、Esc×2 关窗后生成被停——复现钉）", async () => {
		const { app, input, actions } = rig();
		app.start();
		await flush();
		app.setBusy(true);
		// showInjections 同款时序（main.ts:1164）：pick 列表 → Enter 看全文（viewText 不 await）→ 循环回拍 pickOverlay FIFO 暂存
		const entries = ["  [UserPromptSubmit] 知识注入 · 2041 字符"];
		const pick1 = app.pickOverlay("钩子注入（回车看全文 · Esc 返回）", entries);
		await flush(120);
		input.emit("data", "\r"); // Enter：开全文窗、列表解算
		await flush(120);
		await expect(pick1).resolves.toBe(0);
		app.viewText("注入全文", "# 知识索引\n- 条目一", { layout: "dock" }); // 不 await——同 showInjections
		const pick2 = app.pickOverlay("钩子注入（回车看全文 · Esc 返回）", entries); // FIFO 顶在全文窗后
		await flush(120);
		// 用户关窗手势：Esc#1 关全文窗（列表顶回）、Esc#2 关列表
		input.emit("data", "\x1b");
		await flush(80);
		input.emit("data", "\x1b");
		await flush(80);
		await expect(pick2).resolves.toBeUndefined();
		expect(actions).toEqual([]); // 关窗 Esc 不得拼进双击停止序列——实锤复现则此处收 ["cancel"]
		app.setBusy(false);
		app.stop();
	});
	it("⑤bb-d 关窗余震门（2026-10-04 用户实机事故修）：多层弹窗连按 Esc 关窗不得停生成；屏幕安静后双击仍可停", async () => {
		const { app, input, actions } = rig();
		app.start();
		await flush();
		app.setBusy(true);
		// showInjections 同款两层时序：列表 → Enter → 全文窗 + 列表 FIFO 顶回
		const entries = ["  [UserPromptSubmit] 知识注入 · 2041 字符"];
		const pick1 = app.pickOverlay("钩子注入（回车看全文 · Esc 返回）", entries);
		await flush(120);
		input.emit("data", "\r");
		await flush(120);
		await expect(pick1).resolves.toBe(0);
		app.viewText("注入全文", "# 知识索引\n- 条目一", { layout: "dock" });
		const pick2 = app.pickOverlay("钩子注入（回车看全文 · Esc 返回）", entries);
		await flush(120);
		// 用户手势：四连击关窗（全文窗 → 列表 → 惯性两拍）——窗吃两拍、余震门吃两拍
		input.emit("data", "\x1b"); // 关全文窗（列表顶回）
		await flush(80);
		input.emit("data", "\x1b"); // 关列表
		await flush(80);
		await expect(pick2).resolves.toBeUndefined();
		input.emit("data", "\x1b"); // 余震拍一：500ms 内被吃——不计数不提示
		await flush(80);
		input.emit("data", "\x1b"); // 余震拍二：同吃
		await flush(80);
		expect(actions).toEqual([]); // 不再误停
		expect(app.stateRef.toast).toBeUndefined(); // 余震不弹「再按一次」邀请
		// 屏幕安静后（余震窗过期）双击仍可停——首拍 toast、二拍真停
		await flush(600);
		input.emit("data", "\x1b");
		await flush(80);
		expect(app.stateRef.toast?.text).toContain("再按一次 Esc");
		input.emit("data", "\x1b");
		await flush(80);
		expect(actions).toEqual(["cancel"]);
		app.setBusy(false);
		app.stop();
	});
	it("⑤bb-e busy 期斜杠菜单 Esc 先关菜单不喂停止计数器（2026-10-04 顺序统一：旧序菜单开着按 Esc 双击会停生成且菜单不关）", async () => {
		const { app, input, actions } = rig();
		app.start();
		await flush();
		app.setBusy(true);
		input.emit("data", "/"); // 开斜杠菜单（busy 期照常可开）
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "\x1b"); // Esc：关菜单——不再进双击停止计数器
		await flush(80);
		expect(app.stateRef.overlayOpen).toBe(false);
		expect(actions).toEqual([]);
		expect(app.stateRef.toast).toBeUndefined(); // 关窗拍无提示（busy 分支根本没进）
		input.emit("data", "\x1b"); // 关窗后 500ms 内 = 余震——不计数不提示
		await flush(80);
		expect(app.stateRef.toast).toBeUndefined();
		expect(actions).toEqual([]);
		app.setBusy(false);
		app.stop();
	});
	it("⑤bc 图片 chip 文内 token：insertAtCursor 光标位插入、restoreInput 恢复原文（2026-09-23 走查拍板）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "看图");
		await flush();
		app.insertAtCursor("[image #1 (271×157)]"); // 光标在文尾 → 追加
		expect(app.stateRef.input).toBe("看图[image #1 (271×157)]");
		// 退格删除 chip（用户可编辑 = 撤销挂图）：全选删除后恢复原文
		app.restoreInput("看图[image #1 (271×157)]");
		expect(app.stateRef.input).toBe("看图[image #1 (271×157)]");
		expect(app.stateRef.cursor).toBe(app.stateRef.input.length);
		app.stop();
	});
	it("⑤bd 消息队列区（2026-09-23 队列批——kimi QueuePane 同族）：逐条摘要 + hint 入帧；Ctrl+U = steer 队列+草稿；空输入 ↑ 召回队尾", async () => {
		const { app, input, output, queue, actions } = rig();
		app.start();
		await flush();
		queue.push("第一条排队", "第二条排队");
		app.setBusy(true);
		input.emit("data", "草稿内容");
		await flush();
		const plain = stripAnsi(output.buf);
		expect(plain).toContain("› 第一条排队"); // 队列区逐条摘要
		expect(plain).toContain("› 第二条排队");
		expect(plain).toContain("Ctrl + U 立即注入"); // 操作 hint
		// 排队正文石青 info（2026-10-03 走查拍板：灰被否、误用 accent 青玉绿被二次打回）；hint 行仍 muted
		expect(output.buf).toContain(fg("info", "第一条排队"));
		expect(output.buf).toContain("\x1b[2m  ↑ 召回队尾");
		// 队列行补齐左栏宽（不齐则右栏分隔线左移错位——2026-09-23 走查实锤回归钉）：截获帧屏幕行测宽
		const { visibleWidth } = await import("./width.ts");
		let lastScreen: string[] = [];
		const fullRef = (app as unknown as { full: { render(s: string[], ...rest: unknown[]): number } }).full;
		const origRender = fullRef.render.bind(fullRef);
		fullRef.render = (s: string[], ...rest: unknown[]): number => {
			lastScreen = s;
			return origRender(s, ...rest);
		};
		input.emit("data", "\x1b[D"); // 方向键触发一帧（不改文本）
		await flush();
		const qLine = stripAnsi(lastScreen.find((l) => stripAnsi(l).includes("› 第一条排队"))!);
		// 面板边框必须落在左栏宽处（队列行未补齐则面板边框左移错位——2026-09-23 走查实锤回归钉；
		// 2026-09-27 分隔线退役后此处钉的是面板自身边框 = 左栏宽 leftW = cols − sidebarW − 1；CJK 计宽用 visibleWidth）
		expect(visibleWidth(qLine.slice(0, qLine.indexOf("│")))).toBe(100 - (app as unknown as { sidebarW(): number }).sidebarW() - 1);
		input.emit("data", "\x15"); // Ctrl+U = steer：队列 + 草稿一起给宿主
		await flush();
		expect(actions).toEqual(["steer:第一条排队|第二条排队|草稿内容"]);
		expect(app.stateRef.input).toBe(""); // 输入框清空
		// ↑ 召回队尾（LIFO）——steer 后宿主会清队（此处手动模拟宿主清队）
		queue.length = 0;
		queue.push("再排一条");
		input.emit("data", "\x1b[A");
		await flush();
		expect(app.stateRef.input).toBe("再排一条");
		expect(queue).toEqual([]);
		app.setBusy(false);
		app.stop();
	});
	it("⑤be 斜杠菜单带参提交原文（/title 新名字 → 参数不丢——2026-09-23 实测前案）+ seedHistory 播种后 ↑ 召回", async () => {
		const { app, input, submitted } = rig();
		app.start();
		await flush();
		input.emit("data", "/title 新名字");
		await flush();
		input.emit("data", "\r"); // 菜单开着按 Enter——必须提交含参数的原文而非裸 /title
		await flush();
		expect(submitted).toEqual(["/title 新名字"]);
		// 输入历史播种（/sessions 恢复路径）：播种后空输入 ↑ 即召回
		app.seedHistory(["旧问题甲", "旧问题乙"]);
		input.emit("data", "\x1b[A");
		await flush();
		expect(app.stateRef.input).toBe("旧问题乙");
		app.stop();
	});
	it("⑤c 模块询问挂起期 Esc → 询问取消（不被忙碌取消截胡——F5 实证卡死位）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		app.setBusy(true); // 命令执行中弹询问（/model 确认形态）
		const p = app.promptInput("写入 config？", false);
		input.emit("data", "\x1b"); // Esc
		await flush(80); // ESC 时间窗 30ms 判定单 Esc
		await expect(p).resolves.toBeUndefined();
		app.setBusy(false);
		app.stop();
	});
	it("⑤d 提交闸门（批④）：拒因 = 不提交/不进历史/输入保留/尾行拒因；闸门放行后原文再按回车即发", async () => {
		const r = rig();
		// 菜单含 /provider——斜杠命令形态下 Enter 走浮层「Enter 执行」路径进 submitLine（闸门对两入口同覆盖的实证）
		r.io.slashCommands = () => [
			{ name: "/help", desc: "帮助", long: "长说明" },
			{ name: "/provider", desc: "厂商向导", long: "长" },
		];
		r.io.submitGate = (t) => (t.startsWith("/provider") ? "回答进行中——/provider 本轮不可执行（Esc 取消当前回答；结束后原文再按回车即发）" : undefined);
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/provider");
		await flush();
		input.emit("data", "\r"); // 浮层选定 → submitLine → 闸门拦下
		await flush();
		expect(r.submitted).toEqual([]); // 不提交
		expect(app.stateRef.input).toBe("/provider"); // 原文保留
		expect(app.stateRef.history).toEqual([]); // 不进历史
		expect(stripAnsi(r.output.buf)).toContain("本轮不可执行"); // 尾行拒因瞬显
		r.io.submitGate = () => undefined; // 回答结束（闸门放开）——原文还在，再按回车即发
		input.emit("data", "\r");
		await flush();
		expect(r.submitted).toEqual(["/provider"]);
		app.stop();
	});
	it("⑤e 挂起互斥（批③②）：choose 占用期新 choose FIFO 暂存不顶退——审批不会被静默否决；结算后暂存者自动展开", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		const p1 = app.pickOverlay("工具执行确认", ["批准一次", "拒绝"]); // 审批挂起
		const p2 = app.pickOverlay("选择模型", ["m1", "m2"]); // busy 期 /model——暂存而非顶退
		await flush();
		expect(stripAnsi(output.buf)).toContain("工具执行确认"); // 审批还在
		expect(stripAnsi(output.buf)).not.toContain("选择模型");
		input.emit("data", "\r"); // 答审批
		await expect(p1).resolves.toBe(0);
		await flush();
		expect(stripAnsi(output.buf)).toContain("选择模型"); // 暂存的 /model 浮层自动展开
		input.emit("data", "\x1b"); // Esc 取消
		await flush(80);
		await expect(p2).resolves.toBeUndefined();
		app.stop();
	});
	it("⑤f 浮动 toast（批⑧——瞬时反馈统一形态）：输入框上边缘黄字入帧、约 3s 后自消（状态清空）", async () => {
		const { app, output } = rig();
		app.start();
		await flush();
		app.showToast("模型已切换 → fake/m1（已写入 config）");
		await flush();
		expect(stripAnsi(output.buf)).toContain("模型已切换 → fake/m1（已写入 config）"); // 入帧（顶边行）
		expect(output.buf).toContain("38;5;179"); // warn 黄（#d4a25e → 256 色最近邻）
		await flush(3300); // 自消定时器
		expect(app.stateRef.toast).toBeUndefined();
		app.stop();
	});
	it("⑤h fork 回显缝（2026-09-22 用户实测「fork 后没有历史信息」）：sessionLoop 顶序列 = 新 DocModel + historyFrom + FullApp 首帧——继承历史必须在屏", async () => {
		const { DocModel } = await import("./docmodel.ts");
		const dm = new DocModel();
		dm.pushLine("[已从 s_parent 分叉——新会话 s_child，继承历史如下]");
		dm.historyFrom([
			{ type: "user/message", content: [{ kind: "text", text: "第一问" }] },
			{ type: "assistant/message", content: [{ kind: "text", text: "答一" }] },
		], 80);
		const r = rig();
		// m5-render-perf T5：行源两口替换（旧 io.doc 整拷退役）
		r.io.docTotal = () => dm.totalLines(96);
		r.io.docWindow = (s, c) => dm.frameWindow(96, s, c);
		r.app.start();
		await flush();
		const frame = stripAnsi(r.output.buf);
		expect(frame).toContain("继承历史如下");
		expect(frame).toContain("第一问");
		expect(frame).toContain("答一");
		r.app.stop();
	});
	it("⑥ 退出恢复序列：stop() 后 alt-screen 退出序列写出（?1049l + ?25h）", async () => {
		const { app, output } = rig();
		app.start();
		await flush();
		app.stop();
		expect(output.buf).toContain("\x1b[?1049l");
		expect(output.buf).toContain("\x1b[?25h");
	});
	it("⑤g 交互挂起期 spinner 让位（2026-09-22 用户实测：/model 选择期间「正在生成…」照转——挂起 = 等用户不是生成）", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		app.setBusy(true);
		await flush(150); // spinner 先入帧
		const mark = output.buf.length; // 只截取挂起后的帧（diff 渲染逐帧累积——含前置 spinner 帧属正常）
		const p = app.pickOverlay("选择模型", ["m1", "m2"]); // busy + pick 挂起（/model 形态）
		await flush(150);
		const seg = stripAnsi(output.buf.slice(mark));
		expect(seg).not.toContain("正在生成…"); // spinner 让位
		expect(seg).toContain("正在待命"); // 尾行回退待命
		input.emit("data", "\x1b");
		await flush(80);
		await p;
		app.setBusy(false);
		app.stop();
	});
	it("⑦ 忙碌态：setBusy(true) → 尾行 spinner 文案进帧", async () => {
		const { app, output } = rig();
		app.start();
		await flush();
		app.setBusy(true);
		await flush(150);
		expect(stripAnsi(output.buf)).toContain("正在生成…");
		app.setBusy(false);
		app.stop();
	});
	it("⑧ bracketed paste 直通进输入行（多行归一为 \n）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "\x1b[200~第一行\r\n第二行\x1b[201~");
		await flush();
		const st = app as unknown as { state: { input: string } };
		expect(st.state.input).toBe("第一行\n第二行");
		app.stop();
	});
});


describe("侧栏开关持久化接缝（F5 十二轮②）", () => {
	it("sidebarInit false → 初始隐藏；切换回调上抛新态", async () => {
		const r = rig();
		const changes: boolean[] = [];
		const r2 = { io: { ...r.io, sidebarInit: () => false, onSidebarChange: (v: boolean) => changes.push(v) } };
		const app2 = new FullApp(r2.io, { input: r.input, output: r.output });
		expect(app2.stateRef.sidebarVisible).toBe(false);
		app2.start();
		await flush();
		r.input.emit("data", "\x14");
		await flush();
		expect(changes).toEqual([true]); // 隐藏→显示，回调上抛新态
		app2.stop();
	});
});


describe("中行斜杠菜单（2026-10-03「消息内容 空格 /」也开菜单继续）", () => {
	it("① 消息+空格+/ 开菜单，续打按 / 词过滤；退格删掉 / 词菜单关", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "看下 /");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true); // 串尾 / 词即开（词界 = 空白）
		input.emit("data", "ti");
		await flush(120);
		expect(app.menu.overlayItems().map((r) => r.key)).toEqual(["/title"]); // 过滤词只取 / 词，消息前缀不掺
		input.emit("data", "\x7f");
		input.emit("data", "\x7f");
		await flush(120);
		expect(app.stateRef.input).toBe("看下 /"); // 删到只剩 /：串尾 / 词仍在——菜单还开（空过滤全显）
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "\x7f");
		await flush(120);
		expect(app.stateRef.input).toBe("看下 ");
		expect(app.stateRef.overlayOpen).toBe(false); // / 词删没 → 菜单关，消息留着
		app.stop();
	});
	it("② 负例：URL 的 // 与词中斜杠不触发菜单", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "见 http://x");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		input.emit("data", "\x7f".repeat("http://x".length)); // 清回「见 」
		await flush(120);
		input.emit("data", "a/b");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false); // 斜杠前是非空白字符 → 词内斜杠
		app.stop();
	});
	it("③ Enter 调用命令：提交菜单真名 + 消息前缀保留回输入框当草稿", async () => {
		const { app, input, submitted } = rig();
		app.start();
		await flush();
		input.emit("data", "帮我看下 /ti");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "\r");
		await flush(120);
		expect(submitted).toEqual(["/title"]); // 调用的是命令（不是把整行当消息发）
		expect(app.stateRef.input).toBe("帮我看下 "); // 打过的字不丢——草稿回输入框
		expect(app.stateRef.overlayOpen).toBe(false);
		app.stop();
	});
	it("④ Tab 原地补全（前缀保留）；Esc 关菜单文本不动、续打重开", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "帮我看下 /ti");
		await flush(120);
		input.emit("data", "\t");
		await flush(120);
		expect(app.stateRef.input).toBe("帮我看下 /title");
		expect(app.stateRef.overlayOpen).toBe(false);
		// Esc 路径：重开后再 Esc，文本保留；继续补字母重开（与行首形态同款）
		input.emit("data", "\x7f".repeat("/title".length)); // 清回「帮我看下 」
		await flush(120);
		input.emit("data", "/ti");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "\x1b");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		expect(app.stateRef.input).toBe("帮我看下 /ti");
		input.emit("data", "t");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		app.stop();
	});
	it("⑤ 二级命令中行：入级前缀保留；选子项提交 /permission 子项 + 草稿回填", async () => {
		const { app, input, submitted } = rig();
		app.start();
		await flush();
		input.emit("data", "消息 /pe");
		await flush(120);
		input.emit("data", "\r"); // Enter 入二级（/permission 有 children）
		await flush(120);
		expect(app.stateRef.overlayCmd).toBe("/permission");
		expect(app.stateRef.input).toBe("消息 /permission"); // 前缀保留非裸 /permission
		input.emit("data", "\r"); // 选当前值 ask-risky
		await flush(120);
		expect(submitted).toEqual(["/permission ask-risky"]);
		expect(app.stateRef.input).toBe("消息 ");
		app.stop();
	});
	it("⑥ 二级 Esc 退级回「消息 /」（前缀保留），再 Esc 关菜单文本不动", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "消息 /pe");
		await flush(120);
		input.emit("data", "\r");
		await flush(120);
		expect(app.stateRef.overlayCmd).toBe("/permission");
		input.emit("data", "\x1b");
		await flush(120);
		expect(app.stateRef.overlayCmd).toBe("");
		expect(app.stateRef.input).toBe("消息 /"); // 退级回串尾 /，不裸 "/"
		expect(app.stateRef.overlayOpen).toBe(true); // 一级菜单仍开
		input.emit("data", "\x1b");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		expect(app.stateRef.input).toBe("消息 /");
		app.stop();
	});
	it("⑦ submitGate 拦回车档：命令没提交、原文整体保留（草稿不回填不丢字）", async () => {
		const r = rig(["# 你好"], 100, 30, { submitGate: () => "生成中，稍后再发" });
		const { app, input, submitted } = r;
		app.start();
		await flush();
		input.emit("data", "帮我看下 /ti");
		await flush(120);
		input.emit("data", "\r");
		await flush(120);
		expect(submitted).toEqual([]);
		expect(app.stateRef.input).toBe("帮我看下 /ti"); // 闸门拦下：原文含 / 词整体保留
		expect(app.stateRef.overlayOpen).toBe(false);
		app.stop();
	});
	it("⑧ 写错命令零命中即关窗：退格回命中重开——行首/中行两形态", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "/ti");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "z"); // /tiz 全不命中
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		input.emit("data", "\x7f"); // 退格回 /ti——菜单重开
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "\x1b"); // 先关菜单再清空（菜单开着 Ctrl+A 会被 overlay 吃掉）
		await flush(120);
		input.emit("data", "\x01"); // Ctrl+A 全选清空，换中行形态再验一遍
		input.emit("data", "\x7f");
		await flush(120);
		expect(app.stateRef.input).toBe("");
		input.emit("data", "看下 /ti");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "z");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		input.emit("data", "\x7f");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		app.stop();
	});
	it("⑧b 有空格就关窗（2026-10-03 拍板「只要有空格就关窗」，九仓主流同款）：行首/裸斜杠/中行三形态——空格即关、退格删空格重开；argPhase 例外另见参数阶段 describe", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "/ti"); // 行首命令词——开
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", " "); // 空格 = 出了命令词——关（前案：/yolo aaa 菜单挂着 /yolo 不走）
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		expect(app.stateRef.input).toBe("/ti ");
		input.emit("data", "新名字"); // 继续打参数——不再重开（含空格形态不重开）
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		input.emit("data", "\x7f"); // 退格删「字」——仍含空格，关着
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		input.emit("data", "\x7f"); // 删「名」——仍关着
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		input.emit("data", "\x7f"); // 删「新」——剩「/ti 」仍关着（尾空格也算空格）
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		input.emit("data", "\x7f"); // 删掉空格——回命令词形态，重开
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "\x1b"); // 关菜单再清空（菜单开着 Ctrl+A 会被 overlay 吃掉）
		await flush(120);
		input.emit("data", "\x01");
		input.emit("data", "\x7f");
		await flush(120);
		expect(app.stateRef.input).toBe("");
		input.emit("data", "/"); // 裸斜杠——全量列表开
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", " "); // 「/ 」也关（normCmd 抹斜杠后空格的旧口径随之退役——codex「/ test」同判）
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		input.emit("data", "\x7f");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "\x01"); // 菜单开着按 Ctrl+A——键名串不得混入输入框（守卫修复回归钉）
		await flush(120);
		expect(app.stateRef.input).toBe("/");
		input.emit("data", "\x1b"); // 关菜单再全选清空（⑧ 同款路径）
		await flush(120);
		input.emit("data", "\x01");
		input.emit("data", "\x7f");
		await flush(120);
		expect(app.stateRef.input).toBe("");
		input.emit("data", "看下 /ti"); // 中行串尾词——开
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", " "); // 词尾空格（normCmd 裁尾仍算开着的旧口径退役）——关
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		input.emit("data", "\x7f");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		app.stop();
	});
});

describe("Esc 后继续输入重开斜杠菜单（F5 十五轮②）", () => {
	it("'/ti' + Esc + 继续输入 → 菜单重开；非斜杠输入不重开", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "/ti");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "\x1b"); // Esc 关菜单（文本保留）
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		expect(app.stateRef.input).toBe("/ti");
		input.emit("data", "t"); // 继续补字母——菜单重开
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "\x1b");
		await flush(120);
		// 清空再输入普通文本——不重开
		input.emit("data", "\x01"); // Ctrl+A 全选
		input.emit("data", "\x7f");
		await flush(120);
		input.emit("data", "h");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		app.stop();
	});
});

	describe("斜杠菜单固定布局（2026-09-23 用户拍板：命令恒 10 行 + ↑↓ 常驻占位 + 详释恒 3 行——高度恒定防闪烁）", () => {
	const overlayLines = (app: FullApp): string[] =>
		(app as unknown as { buildOverlay(leftW: number, divRow: number): { lines: string[] } }).buildOverlay(80, 24).lines;
	// 空占位行 = 框线 + 空格填充（boxRow padToWidth 全宽）——除 │ 外无可见内容
	const isBlankRow = (l: string): boolean => l.replace(/│/g, "").trim().length === 0;

	it("短/超长说明、滚动前后——菜单总行数一律相同；超长说明第 2 行末尾 ... 截断", async () => {
		const r = rig();
		r.io.slashCommands = () => [
			{ name: "/short", desc: "短说明", long: "一句话讲完。" },
			{ name: "/long", desc: "长说明", long: "这句说明非常长，".repeat(30) },
			...Array.from({ length: 10 }, (_, i) => ({ name: `/cmd${i}`, desc: `第${i}`, long: `第${i}条` })),
		]; // 12 条 → 有滚动余量
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/"); // 开菜单（首条 /short 选中）
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		const hTop = overlayLines(app).length;
		input.emit("data", "\x1b[B"); // ↓ 选中 /long（5+ 行折行说明）
		await flush(120);
		const longLines = overlayLines(app);
		expect(longLines.length).toBe(hTop); // 高度不随说明长短跳
		expect(longLines.map(stripAnsi).some((l) => l.includes("..."))).toBe(true); // 超出 2 行 → 第 2 行末尾 ...
		input.emit("data", "\x1b[6~"); // PageDown → 窗口滚动
		await flush(120);
		expect(overlayLines(app).length).toBe(hTop); // 滚动边界同样不跳
		app.stop();
	});

	it("不足 10 条与滚动两端：命令区恒 10 行（空槽补空行）、↑/↓ 行常驻占位", async () => {
		const r = rig(); // rig 默认 3 条命令
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/");
		await flush(120);
		const plain = overlayLines(app).map(stripAnsi);
		// 结构恒定：标题 + 10 行命令 + ↑↓合行 + 分隔 + 2 行说明 + foot + 底框 = 17 行（标题下无空行、余量提示合一行——用户打回两轮）
		expect(plain).toHaveLength(17);
		const cmdRows = plain.slice(1, 11);
		expect(cmdRows.filter((l) => l.includes("/help") || l.includes("/title") || l.includes("/permission"))).toHaveLength(3);
		expect(cmdRows.filter(isBlankRow)).toHaveLength(7); // 7 个空槽
		expect(isBlankRow(plain[11]!)).toBe(true); // 合行常驻：3 条全显示无余量 → 空占位
		app.stop();
	});

	it("超出 10 条滚动：合行随窗口位置显示「↑ 还有 N · ↓ 还有 M」，滚到底 ↓ 段消失——行数仍 17", async () => {
		const r = rig();
		r.io.slashCommands = () => Array.from({ length: 13 }, (_, i) => ({ name: `/c${String(i).padStart(2, "0")}`, desc: `第${i}`, long: `说明${i}` }));
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/");
		await flush(120);
		input.emit("data", "\x1b[6~"); // PageDown → sel=10，窗口 [1,11)：上下都有余量
		await flush(120);
		const mid = overlayLines(app).map(stripAnsi);
		expect(mid).toHaveLength(17);
		expect(mid[11]).toContain("↑ 还有 1");
		expect(mid[11]).toContain("↓ 还有 2");
		input.emit("data", "\x1b[6~"); // PageDown 再一次 → sel=12 到底（↓ 键回绕到顶，fullapp.ts down 取模——故用 PgDn）
		await flush(120);
		const bottom = overlayLines(app).map(stripAnsi);
		expect(bottom).toHaveLength(17);
		expect(bottom[11]).toContain("↑ 还有 3");
		expect(bottom[11]).not.toContain("↓"); // 底下没有 → ↓ 段不出现
		app.stop();
	});
});

describe("选择浮层输入过滤（F5 九轮①——厂商目录全量直列、列表内 includes 筛）", () => {
	const rig20 = (): { app: FullApp; input: FakeInput } => {
		const r = rig();
		const items = Array.from({ length: 20 }, (_, i) => `vendor-${String(i).padStart(2, "0")}（厂商${i}）`);
		void r.app.pickOverlay("选择厂商", items);
		return { app: r.app, input: r.input };
	};

	it("① ≥12 项自动启用过滤：输入子串即筛（includes 非 startsWith）、Enter 返回原表序号", async () => {
		const { app, input } = rig20();
		app.start();
		await flush();
		input.emit("data", "vendor-1"); // 输入过滤串
		await flush(120);
		const pu = (app as unknown as { pendingUi: { filter?: string } }).pendingUi; // 私有面测试探针
		expect(pu?.filter).toBe("vendor-1");
		input.emit("data", "\r");
		await flush();
		app.stop();
	});

	it("② 退格收缩过滤串；中缀匹配命中（非前缀）", async () => {
		const { app, input } = rig20();
		app.start();
		await flush();
		input.emit("data", "厂商1");
		await flush(120);
		const probe = (app as unknown as { pendingUi: { filter?: string } }).pendingUi;
		expect(probe?.filter).toBe("厂商1"); // 中缀（"厂商10"在第二列）也命中——includes 口径
		input.emit("data", "\x7f\x7f\x7f"); // 退格三次清空
		await flush(120);
		expect((app as unknown as { pendingUi: { filter?: string } }).pendingUi?.filter).toBe("");
		app.stop();
	});
});

describe("pick 高窗页大小（settings 2026-10-08 用户拍板——页大小随终端高动态 [10,20]）", () => {
	it("① pickPageOf：tall 面按 divRow−6 钳 [10,20]；非 tall 恒 10", () => {
		expect(pickPageOf(30, true)).toBe(20); // divRow ≥ 26 → 到顶 20
		expect(pickPageOf(26, true)).toBe(20);
		expect(pickPageOf(20, true)).toBe(14); // 中间随高浮动
		expect(pickPageOf(16, true)).toBe(10); // 钳下界
		expect(pickPageOf(4, true)).toBe(10);
		expect(pickPageOf(30, false)).toBe(10); // 老面恒 10
		expect(pickPageOf(30, undefined)).toBe(10);
	});

	it("② pickOverlay { tall: true }：老选择面（无「其他/确定」合成行）+ pendingUi 挂 tall；13 项常规终端一屏尽览、PageDown 步长随页", async () => {
		const r = rig(); // 默认 rows=30 → divRow=26 → pickPageOf=20
		const items = Array.from({ length: 13 }, (_, i) => `项${String(i + 1).padStart(2, "0")}`);
		void r.app.pickOverlay("设置", items, 0, undefined, { tall: true });
		r.app.start();
		await flush();
		const pu = (r.app as unknown as { pendingUi: { tall?: true; custom?: true; sel: number } }).pendingUi; // 私有面测试探针
		expect(pu?.tall).toBe(true);
		expect(pu?.custom).toBeUndefined(); // 增强面旗标显式化（2026-10-08）——tall 不再隐式触发合成行
		const plain = stripAnsi(r.output.buf);
		expect(plain).toContain("项13"); // 老面 10 行只到 项10——高窗 13 项全显
		expect(plain).not.toContain("还有"); // 无 ↑/↓ 余量行
		expect(plain).not.toContain("其他"); // 老选择面无合成行
		r.input.emit("data", "\x1b[6~"); // PageDown：tall 步长 = 页大小 20 → 钳到底（sel=12）
		await flush(120);
		expect((r.app as unknown as { pendingUi: { sel: number } }).pendingUi?.sel).toBe(12);
		r.input.emit("data", "\x1b"); // Esc 收面
		await flush();
		r.app.stop();
	});

	it("③ 矮终端钳下界：divRow−6 < 10 → 页仍 10、余量行照常", async () => {
		const r = rig(undefined, 100, 20); // rows=20 → divRow=16 → pickPageOf=10
		const items = Array.from({ length: 13 }, (_, i) => `项${String(i + 1).padStart(2, "0")}`);
		void r.app.pickOverlay("设置", items, 0, undefined, { tall: true });
		r.app.start();
		await flush();
		const plain = stripAnsi(r.output.buf);
		expect(plain).toContain("↓ 还有 3"); // 13 − 10 = 3 殿后
		expect(plain).not.toContain("项13"); // 首屏只见前 10
		r.input.emit("data", "\x1b");
		await flush();
		r.app.stop();
	});
});

// M4-3 T1d：引导弹窗 FullApp 集成（焦点锁/键路由/结算/渲染）
describe("首次使用引导弹窗 FullApp 集成（M4-3 T1d）", () => {
	const obDeps = (calls: { secrets: [string, string][]; models: string[]; defaults: [string, string][]; search: Record<string, unknown>[] }) => ({
		providers: [
			{ id: "zhipu", name: "智谱 GLM", envKey: "ZHIPU_API_KEY", baseUrl: "https://x/v1", type: "openai" as const },
		],
		writeProvider: () => {},
		appendSecret: (k: string, v: string) => { calls.secrets.push([k, v]); },
		setModel: (s: string) => { calls.models.push(s); },
		writeDefaultModel: (slot: string, model: string) => { calls.defaults.push([slot, model]); },
		writeSearch: (p: Record<string, unknown>) => { calls.search.push(p); },
		listModels: async () => ["glm-5.3"],
		writeVision: () => {},
		visionModels: async () => [],
		detectMemorySources: () => [],
		importMemory: async () => ({ imported: 0, skipped: 0, merged: 0 }),
	});

	it("⑬ 弹窗开 → 焦点锁全键序走通三页 → completed 结算 + 弹窗消退", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		const calls = { secrets: [] as [string, string][], models: [] as string[], defaults: [] as [string, string][], search: [] as Record<string, unknown>[] };
		const outcome = app.runOnboarding(obDeps(calls));
		await flush();
		expect(stripAnsi(output.buf)).toContain("引导 1 / 5");
		input.emit("data", "\x0e"); // Ctrl + N → p2
		await flush();
		expect(stripAnsi(output.buf)).toContain("引导 2 / 5");
		input.emit("data", "\r"); // 进 key 态（zhipu）
		input.emit("data", "zk");
		input.emit("data", "\r"); // 确认 key → 选默认模型子态（2026-10-07 修）
		await flush();
		input.emit("data", "\r"); // 选定首个模型——defaultModel 落盘在前、裸名 setModel 在后
		await flush();
		expect(calls.secrets).toEqual([["ZHIPU_API_KEY", "zk"]]);
		expect(calls.defaults).toEqual([["zhipu", "glm-5.3"]]);
		expect(calls.models).toEqual(["zhipu"]);
		input.emit("data", "\x0e"); // → p3
		await flush();
		input.emit("data", ""); // → p4 搜索页（视觉页跳过——默认不开启）
		await flush();
		expect(stripAnsi(output.buf)).toContain("引导 4 / 5");
		input.emit("data", "\r"); // opts → llm 子态
		input.emit("data", "\r"); // 默认项选定
		await flush();
		input.emit("data", "\x0e"); // → p5 导入页（T6d——原「完成」顺延一页）
		await flush();
		expect(stripAnsi(output.buf)).toContain("引导 5 / 5");
		input.emit("data", "\x0e"); // 未勾选源 = 跳过导入 → 完成
		await flush();
		expect(await outcome).toEqual({ kind: "completed" });
		const tail = stripAnsi(output.buf.slice(-4000));
		expect(tail).not.toContain("引导 5 / 5"); // 弹窗已消退
		app.stop();
	});

	it("⑭ 第 1 页 Ctrl + Q → quit 结算；stop() 兜底结算不永挂", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		const calls = { secrets: [] as [string, string][], models: [] as string[], defaults: [] as [string, string][], search: [] as Record<string, unknown>[] };
		const outcome = app.runOnboarding(obDeps(calls));
		await flush();
		input.emit("data", "\x11"); // Ctrl + Q
		await flush();
		expect(await outcome).toEqual({ kind: "quit" });
		const outcome2 = app.runOnboarding(obDeps(calls));
		await flush();
		app.stop(); // 未结算即 stop → quit 兜底（promise 不永挂）
		expect(await outcome2).toEqual({ kind: "quit" });
	});
});

describe("斜杠菜单过滤：前缀优先、含字殿后（2026-09-24 拍板：/ol 先列 ol 开头，再列含 ol 的 /yolo）", () => {
	const overlayLines = (app: FullApp): string[] =>
		(app as unknown as { buildOverlay(leftW: number, divRow: number): { lines: string[] } }).buildOverlay(80, 24).lines;

	it("① /ol → 前缀命中的 /olap 排前，含字命中的 /yolo 殿后，不含 ol 的不列", async () => {
		const r = rig();
		// 注册序故意让 /yolo 在前——列表序必须是「前缀组在前」而非注册序
		r.io.slashCommands = () => [
			{ name: "/help", desc: "帮助", long: "说明" },
			{ name: "/yolo", desc: "免确认", long: "说明" },
			{ name: "/olap", desc: "分析", long: "说明" },
		];
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/ol");
		await flush(120);
		const plain = overlayLines(app).map(stripAnsi);
		const idx = (name: string) => plain.findIndex((l) => l.includes(name));
		expect(idx("/olap")).toBeGreaterThan(-1);
		expect(idx("/yolo")).toBeGreaterThan(idx("/olap"));
		expect(idx("/help")).toBe(-1);
		app.stop();
	});

	it("② 别名同规则：别名前缀命中排前（/qu → quit→/exit），仅名字含字的 /equip 殿后", async () => {
		const r = rig();
		r.io.slashCommands = () => [
			{ name: "/equip", desc: "装备", long: "说明" },
			{ name: "/exit", desc: "退出", long: "说明", aliases: ["quit", "q"] },
		];
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/qu");
		await flush(120);
		const plain = overlayLines(app).map(stripAnsi);
		const idx = (name: string) => plain.findIndex((l) => l.includes(name));
		expect(idx("/exit")).toBeGreaterThan(-1); // 别名 quit 前缀命中
		expect(idx("/equip")).toBeGreaterThan(idx("/exit")); // 名字含 "qu"（非前缀）殿后
		app.stop();
	});

	it("③ 全不命中 → 菜单不显示（2026-10-03 拍板：写错命令零命中即关窗，推翻空态占位旧纪律）", async () => {
		const r = rig();
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/zz");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false); // 清单空 → 菜单关（渲染层「无匹配命令」空态分支留作异步清单收缩安全网）
		app.stop();
	});

	it("④ 仅含字命中也回车直达：/ol → Enter 提交真名 /yolo", async () => {
		const r = rig();
		r.io.slashCommands = () => [
			{ name: "/help", desc: "帮助", long: "说明" },
			{ name: "/yolo", desc: "免确认", long: "说明" },
		];
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/ol");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "\r");
		await flush(120);
		expect(r.submitted).toEqual(["/yolo"]);
		app.stop();
	});
});

// 2026-09-24 走查实锤前案：/provider 选择平台上下移动大概率残影（黑带+||）——多行项（name\n（url））
// 进 overlay 行带裸 \n，padToWidth/合成全乱
describe("pickOverlay 多行项压平（2026-09-24 前案回归钉）", () => {
	it("① 多行项 → overlay 行零裸换行、行宽不超框宽；选中移动行数不变", () => {
		const r = rig();
		const app = r.app;
		const pick = (sel: number) =>
			(app as unknown as { buildPickOverlay(leftW: number, divRow: number, title: string, items: string[], sel: number, filter?: string): { lines: string[]; width: number } })
				.buildPickOverlay(60, 24, "选择平台", [
					"zhipuai-coding-plan\n（https://open.bigmodel.cn/api/coding/paas/v4）",
					"kimi-code-plan-cn\n（https://api.kimi.com/coding/v1）",
					"[取消]",
				], sel, undefined);
		const ov = pick(1);
		for (const l of ov.lines) expect(l).not.toContain("\n");
		for (const l of ov.lines) expect(visibleWidth(l)).toBeLessThanOrEqual(ov.width);
		// 两段式（2026-09-28 用户拍板）：URL 括注折平后为说明段——灰；可见形态仍「名 （URL）」
		const joined = ov.lines.join("\n");
		expect(stripAnsi(joined)).toContain("kimi-code-plan-cn （https://api.kimi.com/coding/v1）"); // 压平形态
		expect(joined).toContain(`kimi-code-plan-cn ${dim("（https://api.kimi.com/coding/v1）")}`); // 说明段灰
		const ov0 = pick(0);
		expect(ov0.lines.length).toBe(ov.lines.length); // 移动选中行数恒定（防闪烁纪律同族）
	});
});

// 2026-09-28 用户拍板：子界面与斜杠主菜单同形——标题白、副题/说明灰（walk 截图实锤：全屏 choose 项整行白）
describe("pickOverlay 两段式渲染（标题白/说明灰）", () => {
	// 宽 100——审批档全文 30+ 字（60 列浮窗会右截断，拍板断言要看完整说明段）
	const build = (items: string[], sel: number): { lines: string[]; width: number } =>
		(rig().app as unknown as { buildPickOverlay(leftW: number, divRow: number, title: string, items: string[], sel: number, filter?: string): { lines: string[]; width: number } })
			.buildPickOverlay(100, 24, "测试", items, sel, undefined);

	it("① 尾部括注形态（「标题（说明）」——设置菜单/厂商目录）：说明段灰、标题保持素色", () => {
		const ov = build(["磁盘占用（各目录大小与清理口径）", "[取消]"], 0);
		const text = ov.lines.join("\n");
		expect(text).toContain(`磁盘占用${dim("（各目录大小与清理口径）")}`);
		expect(stripAnsi(text)).toContain("磁盘占用（各目录大小与清理口径）"); // 可见形态不变
		expect(stripAnsi(text)).toContain("[取消]"); // 纯标题项不动（无发明拆分）
	});

	it("② 「——」形态（审批三档/搜索后端「标题——说明」）与尾注让位：—— 在括注组内时整组为说明", () => {
		const ov = build([
			"需要时候询问——走主对话关卡——规则链照常、危险操作弹窗询问",
			"技能（查看 / 启停——四轨目录全部技能）",
		], 0);
		const text = ov.lines.join("\n");
		expect(text).toContain(`需要时候询问 ${dim("——走主对话关卡——规则链照常、危险操作弹窗询问")}`); // 首 —— 拆分
		expect(text).toContain(`技能${dim("（查看 / 启停——四轨目录全部技能）")}`); // 括注组优先
	});

	it("③ 「 ✓」当前值 + 说明并存：标题青玉、说明仍灰、尾标青玉（纯标题项整项青玉不变）", () => {
		const ov = build(["low", "high ✓", "每次都询问——有问题就先问用户 ✓"], 0);
		const text = ov.lines.join("\n");
		expect(text).toContain(fg("accent", "high ✓")); // 纯标题当前项整项青玉（2026-09-25 拍板原样）
		expect(text).toContain(`${fg("accent", "每次都询问")} ${dim("——有问题就先问用户")} ${fg("accent", "✓")}`);
		expect(stripAnsi(text)).toContain(" low"); // 普通项素色
	});
});

describe("pickOverlay 当前值项染色（2026-09-25 用户拍板——/effort /model 菜单当前档用选中色）", () => {
	it("① 「 ✓」尾标项整项染青玉 accent；普通项保持素色；行宽不超框", () => {
		const r = rig();
		const app = r.app;
		const ov = (app as unknown as { buildPickOverlay(leftW: number, divRow: number, title: string, items: string[], sel: number, filter?: string): { lines: string[]; width: number } })
			.buildPickOverlay(60, 24, "选择思考档位（glm-5.3 · 当前 high）", ["low", "high ✓", "max"], 0, undefined);
		const text = ov.lines.join("\n");
		expect(text).toContain(fg("accent", "high ✓")); // 当前档整项青玉（选中色）
		expect(text).not.toContain(fg("accent", "low")); // 普通项不染
		expect(stripAnsi(text)).toContain(" low"); // 普通项仍在
		for (const l of ov.lines) expect(visibleWidth(l)).toBeLessThanOrEqual(ov.width); // ANSI 计宽不炸框
	});
});

describe("模块诊断一级列表（T9——Ctrl + E 开关、恒 8 行防闪烁、↑↓ 选择）", () => {
	const entries = (n: number) => Array.from({ length: n }, (_, i) => ({
		name: `mod-${i}`, tag: (i % 3 === 0 ? "激活失败" : i % 3 === 1 ? "级联" : "加载失败") as "激活失败" | "级联" | "加载失败",
		reason: `失败原因文本 ${i}`, count: i + 1, last: `2026-09-25T10:0${i % 10}:00.000Z`,
	}));

	it("① 定高：5 条记录渲染 8 行区（3 空槽真空白无装饰）+ 行含状态点/名/标签/计次/最后时间", () => {
		const { lines } = diagListLines(entries(5), 0, 76);
		expect(lines).toHaveLength(9); // 8 内容行 + 1 余量行（恒定——条件性增删行即闪烁源）
		const plain = lines.map((l) => stripAnsi(l));
		expect(plain[0]).toContain("mod-0");
		expect(plain[4]).toContain("mod-4");
		expect(plain[5]).toBe(""); // 空槽真空白（禁装饰占位）
		expect(plain[6]).toBe("");
		expect(plain[7]).toBe("");
		expect(plain[8]).toBe(""); // 无余量 → 空白占位
		expect(lines[0]).toContain(fg("err", "●")); // 赭石状态点
		expect(lines[0]).toContain(fg("info", "激活失败")); // 石青标签
		expect(plain[0]).toContain("1 次 · 10:00:00");
	});

	it("② 超页：12 条记录出现「↓ 还有 N」合一行提示；选中第 10 条时窗口尾随（↑↓ 都提示）", () => {
		const first = diagListLines(entries(12), 0, 76);
		expect(stripAnsi(first.lines[8] ?? "")).toContain("↓ 还有 4");
		const at10 = diagListLines(entries(12), 9, 76);
		expect(stripAnsi(at10.lines[8] ?? "")).toContain("↑ 还有 2");
		expect(stripAnsi(at10.lines[8] ?? "")).toContain("↓ 还有 2");
		expect(stripAnsi(at10.lines[7] ?? "")).toContain("mod-9"); // 选中行恒可见（窗口尾随）
		expect(at10.lines).toHaveLength(9); // 行区仍恒 8 行
	});

	it("③ 键路由：ctrl+e 开（空态走 toast 不弹窗）、再按关、↑↓ 夹紧、Esc 关", async () => {
		const { app, input, output } = rig(["# hi"], 100, 30, { diagEntries: () => entries(3) });
		app.start();
		await flush();
		input.emit("data", "\x05"); // Ctrl+E 开
		await flush();
		expect(app.stateRef.diagOpen).toBe(true);
		expect(stripAnsi(output.buf)).toContain("mod-0");
		input.emit("data", "\x1b[B"); // ↓
		input.emit("data", "\x1b[B"); // ↓（到 2）
		input.emit("data", "\x1b[B"); // ↓（夹紧在 2）
		await flush();
		expect(app.stateRef.diagSel).toBe(2);
		input.emit("data", "\x1b[A"); // ↑
		await flush();
		expect(app.stateRef.diagSel).toBe(1);
		input.emit("data", "\x1b"); // Esc 关
		await flush();
		expect(app.stateRef.diagOpen).toBe(false);
		input.emit("data", "\x05"); // 再开
		await flush();
		input.emit("data", "\x05"); // Ctrl+E 再按 = 关
		await flush();
		expect(app.stateRef.diagOpen).toBe(false);

		// 空态：不弹窗，toast 提示
		const empty = rig(["# hi"], 100, 30, { diagEntries: () => [] });
		empty.app.start();
		await flush();
		empty.input.emit("data", "\x05");
		await flush();
		expect(empty.app.stateRef.diagOpen).toBe(false);
		expect(stripAnsi(empty.output.buf)).toContain("模块全部正常——没有诊断记录");
	});
});

describe("模块诊断二级详情（T10——viewText 复用、Esc 逐级返回、Ctrl + E 全关）", () => {
	const entries = (n: number) => Array.from({ length: n }, (_, i) => ({
		name: `mod-${i}`, tag: "激活失败" as const, reason: `失败原因文本 ${i}`, count: 1, last: `2026-09-25T10:0${i}:00.000Z`,
	}));

	it("④ 一级 Enter 进二级（viewText 开）、二级 Esc 回一级（标记驱动、选中行保留）、二级 Ctrl + E 全关", async () => {
		const { app, input, output } = rig(["# hi"], 100, 30, {
			diagEntries: () => entries(3),
			diagDetail: (n) => `【失败原因】\n${n} 的详情文本`,
		});
		app.start();
		await flush();
		input.emit("data", "\x05"); // Ctrl+E 开一级
		await flush();
		expect(app.stateRef.diagOpen).toBe(true);
		input.emit("data", "\x1b[B"); // ↓ 到 mod-1
		await flush();
		expect(app.stateRef.diagSel).toBe(1);
		input.emit("data", "\r"); // Enter 进二级
		await flush();
		expect(app.stateRef.diagOpen).toBe(false);
		expect(app.stateRef.diagReturn).toBe(true);
		expect(stripAnsi(output.buf)).toContain("mod-1 的详情文本"); // viewText 渲染详情
		input.emit("data", "\x1b"); // Esc 逐级返回一级
		await flush();
		expect(app.stateRef.diagOpen).toBe(true);
		expect(app.stateRef.diagReturn).toBe(false);
		expect(app.stateRef.diagSel).toBe(1); // 选中行保留（S5）
		input.emit("data", "\r"); // 再进二级
		await flush();
		input.emit("data", "\x05"); // 二级开着 Ctrl+E = 全关
		await flush();
		expect(app.stateRef.diagOpen).toBe(false);
		expect(app.stateRef.diagReturn).toBe(false);
	});
});

describe("弹窗 viewText（m5 T2——新几何居中弹窗 + 自定义键 + 排队化 + 保留键剔除；diagReturn 逐级返回由既有 T10 ④ 用例覆盖新几何）", () => {
	it("① 排队：连开两窗后者等前者关（原「直接覆槽顶掉」行为修正——设计空白 8）", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		app.viewText("第一窗", "甲内容");
		await flush();
		app.viewText("第二窗", "乙内容");
		await flush();
		const buf1 = stripAnsi(output.buf);
		expect(buf1).toContain("第一窗");
		expect(buf1).toContain("甲内容");
		expect(buf1).not.toContain("第二窗"); // 后者排队未上屏
		input.emit("data", "\x1b"); // Esc 关第一窗 → 队首提升
		await flush();
		const buf2 = stripAnsi(output.buf);
		expect(buf2).toContain("第二窗");
		expect(buf2).toContain("乙内容");
		input.emit("data", "\x1b");
		await flush();
	});

	it("② 自定义键三态：r 整窗替换、c 关窗、无返回不动；抛错黄字且窗保留（全局约束 4）", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		app.viewText("键窗", "旧内容", {
			keys: {
				r: { label: "刷新", run: () => "新内容" },
				c: { label: "关闭", run: () => "close" as const },
				n: { label: "不动", run: () => undefined },
				e: { label: "炸", run: () => { throw new Error("模块炸了"); } },
			},
		});
		await flush();
		input.emit("data", "n");
		await flush();
		expect(stripAnsi(output.buf)).toContain("旧内容");
		input.emit("data", "r");
		await flush();
		expect(stripAnsi(output.buf)).toContain("新内容");
		input.emit("data", "e");
		await flush();
		expect(stripAnsi(output.buf)).toContain("弹窗按键处理出错");
		expect(stripAnsi(output.buf)).toContain("新内容"); // 窗保留
		output.buf = "";
		input.emit("data", "c");
		await flush();
		expect(stripAnsi(output.buf)).not.toContain("键窗"); // 窗已关（后续帧无窗体）
	});

	it("③ 保留键注册即拒并记日志：Esc/Ctrl+C·V·A·S·Z/Ctrl+T·E·O 九例；Ctrl+E 仍走宿主全局键", async () => {
		const logs: string[] = [];
		const { app, input, output } = rig(["# hi"], 100, 30, {
			logWarn: (code, msg) => logs.push(`${code}:${msg}`),
			diagEntries: () => [],
		});
		app.start();
		await flush();
		app.viewText("键窗", "内容", {
			owner: "mod-x",
			keys: {
				escape: { label: "esc", run: () => "不该出现" },
				"ctrl+c": { label: "c", run: () => "不该出现" },
				"ctrl+v": { label: "v", run: () => "不该出现" },
				"ctrl+a": { label: "a", run: () => "不该出现" },
				"ctrl+s": { label: "s", run: () => "不该出现" },
				"ctrl+z": { label: "z", run: () => "不该出现" },
				"ctrl+t": { label: "t", run: () => "不该出现" },
				"ctrl+e": { label: "e", run: () => "不该出现" },
				"ctrl+o": { label: "o", run: () => "不该出现" },
			},
		});
		await flush();
		expect(logs.length).toBe(9);
		expect(logs.every((l) => l.startsWith("tui.viewkey.reserved"))).toBe(true);
		expect(logs.some((l) => l.includes("ctrl+e"))).toBe(true);
		// 走查⑤（2026-09-29 用户拍板「焦点在弹窗 → 主界面快捷键不可用」）推翻旧断言「Ctrl+E 仍走
		// 宿主全局键」：弹窗聚焦期 Ctrl+E 静默不可用（不开诊断、无空态 toast）；Esc 关窗后恢复主窗语义
		input.emit("data", "\x05"); // Ctrl+E——弹窗期吞
		await flush();
		expect(stripAnsi(output.buf)).not.toContain("模块全部正常");
		expect(stripAnsi(output.buf)).not.toContain("不该出现");
		input.emit("data", "\x1b"); // Esc 关模块窗
		await flush();
		input.emit("data", "\x05"); // 关窗后 Ctrl+E 恢复主窗语义（诊断空态 toast）
		await flush();
		expect(stripAnsi(output.buf)).toContain("模块全部正常");
	});

	it("④ 布局参数传到几何：full 弹 99 宽（90+ 连横线）、缺省 center80 弹 79 宽", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		app.viewText("全屏窗", "x", { layout: "full" });
		await flush();
		expect(stripAnsi(output.buf)).toContain("─".repeat(90));
		input.emit("data", "\x1b");
		await flush();
		output.buf = "";
		app.viewText("居中窗", "x");
		await flush();
		const b = stripAnsi(output.buf);
		expect(b).toContain("居中窗");
		expect(b).not.toContain("─".repeat(90)); // 79 宽弹窗撑不出 90 连横线
	});

	it("④b 恒满屏（2026-10-01 走查①拍板「不论内容填不填满都得满屏」）：full 弹窗单行内容也画满整屏（大量空盒行）；dock 仍内容自适应短盒", async () => {
		const { app, input, output } = rig(["# hi"], 100, 20);
		app.start();
		await flush();
		output.buf = "";
		app.viewText("全屏窗", "仅一行", { layout: "full" });
		await flush();
		const b = stripAnsi(output.buf);
		expect(b).toContain("全屏窗");
		// 补空行后的空盒行（│ + 长空串 + │）：page-1 ≈ 16 行——旧实现抱内容只有 4 行盒、零空盒行
		expect((b.match(/│ {60,}│/g) ?? []).length).toBeGreaterThanOrEqual(10);
		expect(b).toContain("╰"); // 底框在
		input.emit("data", "\x1b");
		await flush();
		output.buf = "";
		app.viewText("贴底窗", "仅一行", { layout: "dock" });
		await flush();
		const d = stripAnsi(output.buf);
		expect(d).toContain("贴底窗");
		expect((d.match(/│ {60,}│/g) ?? []).length).toBeLessThanOrEqual(3); // dock 不补——盒行数=内容数（≤ 内容 1 行 + 提示行）
	});

	it("⑤ too-small：8×2 终端连保底都装不下——不弹窗、黄字「终端窗口太小」", async () => {
		const { app, output } = rig(["# hi"], 8, 2);
		app.start();
		await flush();
		app.viewText("小窗", "内容");
		await flush();
		// 8×2 退化布局渲染不出 toast 行——断言落在状态面（窗没开 + toast 已置）
		expect(app.stateRef.toast?.text).toContain("终端窗口太小");
		expect(stripAnsi(output.buf)).not.toContain("小窗");
	});
	it("⑥ Ctrl+O 字节直达（2026-09-27 修复回归钉）：\\x0f → showCompactionSummary → 全屏摘要窗", async () => {
		const { app, input, output } = rig(["# hi"], 100, 30, {
			// 宿主接线同款（main.ts showCompactionSummary → viewText 全屏窗）——此处验「字节 → 键名 → 宿主全局键」这条断链
			showCompactionSummary: () => app.viewText("压缩摘要", "摘要正文一行", { layout: "full" }),
		});
		app.start();
		await flush();
		input.emit("data", "\x0f");
		await flush();
		const b = stripAnsi(output.buf);
		expect(b).toContain("压缩摘要");
		expect(b).toContain("摘要正文一行");
		expect(b).toContain("─".repeat(90)); // full 布局（④ 同款判据：90+ 连横线）
	});

	it("⑦ live 一秒缓存（m5-agentview-perf T4）：窗口期内多帧真执行一次；run 回新文本即失效一拍（不顶回旧帧）；过 1s 恢复现算", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		let calls = 0;
		let cur = "旧帧内容";
		app.viewText("实时窗", cur, {
			live: () => { calls++; return cur; },
			keys: { r: { label: "刷新", run: () => { cur = "键刷新内容"; return cur; } } },
		});
		await flush();
		const firstCalls = calls; // 首帧已现算（≥1）
		expect(firstCalls).toBeGreaterThanOrEqual(1);
		app.renderFrame();
		app.renderFrame();
		expect(calls).toBe(firstCalls); // 1s 龄门内——live 真执行零次（渲染层兜底：成本封顶 1 次/秒）
		// 折叠键 run 回新文本 → 缓存失效一拍：下一帧立即现算（D1 交互——不得顶回旧帧）
		input.emit("data", "r");
		await flush();
		const afterRun = calls;
		expect(afterRun).toBe(firstCalls + 1); // run 后恰好现算一拍
		expect(stripAnsi(output.buf)).toContain("键刷新内容");
		// 过 1s 龄门恢复现算：数据源变化重新可见（心跳帧时点不定，断言为「有新执行」非精确计数）
		cur = "过了一秒的内容";
		await new Promise((r2) => setTimeout(r2, 1050));
		app.renderFrame();
		expect(calls).toBeGreaterThan(afterRun);
		expect(stripAnsi(output.buf)).toContain("过了一秒的内容");
		input.emit("data", "\x1b");
		await flush();
	});
});

describe("斜杠菜单技能区（m4-7 T7——原型图 1 验收点 1-4：skill : 名殿后于命令/分隔行/详释 3 行/Enter 提交「/skill : 名」等价命令；2026-09-30 增 Tab 填 /skill : 名 形态与子序列第三档；2026-10-03 方案 2 起 Enter 不再直接提交合成体——↑ 历史记命令形态）", () => {
	const SK = (name: string, desc: string, usage?: string): SlashItem => ({
		name: `skill : ${name}`, desc, long: desc, skill: name, ...(usage !== undefined ? { usage } : {}),
	});
	const overlayOf = (app: FullApp): string[] =>
		(app as unknown as { buildOverlay(leftW: number, divRow: number): { lines: string[] } }).buildOverlay(80, 24).lines;

	it("① 技能条目「skill : 名」殿后于全部命中命令 + 分隔行「── 技能 ──」+ 标题计数并注技能段", async () => {
		const r = rig(["# hi"], 100, 30, {
			skillItems: () => [SK("pdf", "生成 PDF 文件", "需要交付 PDF 文件时"), SK("review-pr", "审查拉取请求")],
		});
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/"); // q 为空 = 命令技能全显
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		const plain = overlayOf(app).map(stripAnsi);
		const joined = plain.join("\n");
		const cmdPos = joined.indexOf("/help");
		const sepPos = joined.indexOf("── 技能");
		const skillPos = joined.indexOf("skill : pdf");
		expect(cmdPos).toBeGreaterThanOrEqual(0);
		expect(sepPos).toBeGreaterThan(cmdPos); // 分隔行在命令之后
		expect(skillPos).toBeGreaterThan(sepPos); // 技能条目殿后于分隔行
		expect(joined.indexOf("skill : review-pr")).toBeGreaterThan(skillPos); // 技能组内保持注册序
		expect(joined).toContain("生成 PDF 文件"); // 行内短说明 = description
		expect(joined).toContain("3 个命令 · 2 个技能"); // 标题计数（rig 自带 3 命令）
		app.stop();
	});

	it("② 详释恒 3 行：技能选中 = 说明折行 + 第 3 行「适用：…」；无 when_to_use 第 3 行整行留空（不删行不回退操作提示）", async () => {
		const r = rig(["# hi"], 100, 30, {
			skillItems: () => [SK("pdf", "根据用户需求生成 PDF 文档，支持从 markdown 转换、中文字体嵌入与目录生成", "需要交付 PDF 文件时"), SK("plain", "无适用说明的技能")],
		});
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/");
		await flush(120);
		input.emit("data", "\x1b[B"); // ↓ ×3：/help → /title → /permission →（跳过 sep）pdf
		input.emit("data", "\x1b[B");
		input.emit("data", "\x1b[B");
		await flush(120);
		let plain = overlayOf(app).map(stripAnsi);
		let third = plain[plain.length - 2]!; // 倒数第 2 内容行 = 详释第 3 行（框底之上）
		expect(third).toContain("适用：需要交付 PDF 文件时");
		const hWithUsage = plain.length;
		input.emit("data", "\x1b[B"); // ↓ → plain（无 usage）
		await flush(120);
		plain = overlayOf(app).map(stripAnsi);
		third = plain[plain.length - 2]!;
		expect(third.replace(/│/g, "").trim()).toBe(""); // 整行留空（不删行——高度恒定纪律）
		expect(plain.length).toBe(hWithUsage); // 有无适用行高度不变
		app.stop();
	});

	it("③ 无技能环境菜单与现状一致——不多分隔行、标题无技能计数段（验收点 3）", async () => {
		const r = rig(["# hi"], 100, 30); // 不接 skillItems 口 = 宿主零技能形态
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/");
		await flush(120);
		const plain = overlayOf(app).map(stripAnsi);
		expect(plain.some((l) => l.includes("技能"))).toBe(false); // 无「── 技能 ──」分隔行
		expect(plain.join("\n")).toContain("3 个命令"); // 计数照旧，无「 · N 个技能」段
		app.stop();
	});

	it("④ Enter = 提交等价命令「/skill : 名」（2026-10-03 方案 2）：↑ 历史记命令形态不进合成体、submit 收真名命令、菜单关", async () => {
		const r = rig(["# hi"], 100, 30, {
			skillItems: () => [SK("pdf", "生成 PDF 文件")],
		});
		const { app, input, submitted } = r;
		app.start();
		await flush();
		input.emit("data", "/");
		await flush(120);
		input.emit("data", "\x1b[B"); // ↓ ×3 →（3 命令后跳 sep）pdf
		input.emit("data", "\x1b[B");
		input.emit("data", "\x1b[B");
		await flush(120);
		input.emit("data", "\r"); // Enter → 提交等价命令走宿主解析
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		expect(submitted).toEqual(["/skill : pdf"]); // 真名命令形态（非 skill : 名 显示文本）
		// 旧实现 submitLine(合成体) → 标记行+<skill> 正文整条进 ↑ 历史（用户实测按上键翻出标记行）
		expect(app.stateRef.history).toEqual(["/skill : pdf"]);
		app.stop();
	});

	it("⑤ Tab ≠ Enter（2026-09-30 用户拍板）：技能条目 Tab 填可输入形态「/skill : 名」进输入框（菜单关、不提交），回车提交原文走宿主解析", async () => {
		const r = rig(["# hi"], 100, 30, {
			skillItems: () => [SK("pdf", "生成 PDF 文件")],
		});
		const { app, input, submitted } = r;
		app.start();
		await flush();
		input.emit("data", "/");
		await flush(120);
		input.emit("data", "\x1b[B"); // ↓ ×3 → pdf
		input.emit("data", "\x1b[B");
		input.emit("data", "\x1b[B");
		await flush(120);
		input.emit("data", "\t"); // Tab → 填形态不注入
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false); // 菜单关（命令 Tab 同款）
		expect(app.stateRef.input).toBe("/skill : pdf"); // 可输入形态落输入框（光标尾）
		expect(app.stateRef.cursor).toBe("/skill : pdf".length);
		expect(submitted).toHaveLength(0); // 未提交（注入等动作全在回车后的宿主解析层）
		input.emit("data", "\r"); // 回车 → 提交原文（/skill : 名 的解析在宿主 processReplLine，rig 只收提交串）
		await flush(120);
		expect(submitted).toEqual(["/skill : pdf"]);
		app.stop();
	});

	it("⑦ 手敲完整形态（含参数）：空格即关窗（2026-10-03 拍板），Enter 提交原话不走菜单条目——参数不丢、原话可回显（2026-09-30 拍板「我输入啥就显示啥」）", async () => {
		const r = rig(["# hi"], 100, 30, {
			skillItems: () => [SK("pdf", "生成 PDF 文件")],
		});
		const { app, input, submitted } = r;
		app.start();
		await flush();
		input.emit("data", "/skill : pdf 附带参数整段"); // 从 / 起整行手敲——首个空格（/skill 后）即关窗
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false); // 有空格就关（旧口径「全程开着」随 2026-10-03 拍板退役）
		input.emit("data", "\r");
		await flush(120);
		expect(submitted).toEqual(["/skill : pdf 附带参数整段"]); // 原话整段提交（提交层解析：回显 + args 注入）
		expect(app.stateRef.overlayOpen).toBe(false);
		app.stop();
	});

	it("⑥ 过滤两档：q=「re」→ 技能 review-pr 命中（pdf 不含不显）；命令零命中技能有货不显示「无匹配命令」；↑ 跨分隔行回绕不停 sep", async () => {
		const r = rig(["# hi"], 100, 30, {
			skillItems: () => [SK("pdf", "生成 PDF 文件"), SK("review-pr", "审查拉取请求")],
		});
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/");
		await flush(120);
		input.emit("data", "re"); // q = re：rig 三命令（/help /title /permission）零命中
		await flush(120);
		let plain = overlayOf(app).map(stripAnsi);
		const joined = plain.join("\n");
		expect(app.stateRef.overlayOpen).toBe(true); // 技能有货 → 清单非空 → 照开（2026-10-03 零命中关窗只关真干净）
		expect(joined).toContain("skill : review-pr");
		expect(joined).not.toContain("skill : pdf"); // 不含 q 不显
		expect(joined).not.toContain("无匹配命令"); // 技能有货不算全空
		expect(joined).toContain("0 个命令 · 1 个技能");
		expect(app.stateRef.input).toBe("/re");
		input.emit("data", "\x1b[A"); // ↑ 回绕：唯一可选行 review-pr（sep 在 0 位被跳过不停）
		await flush(120);
		plain = overlayOf(app).map(stripAnsi);
		expect(plain[plain.length - 2]!.includes("适用")).toBe(false); // 仍选中 review-pr（无 usage 第 3 行空）——未停在 sep
		app.stop();
	});

		it("⑦ 过滤第三档子序列（2026-09-30 用户拍板：/skas 筛出 skill : ask——fzf/命令面板同款）：散见命中殿后于前缀/含字档，可搜文本 = 真名 + 显示标签", async () => {
			const r = rig(["# hi"], 100, 30, {
				skillItems: () => [SK("ask", "提问技能"), SK("pdf", "生成 PDF 文件")],
			});
			const { app, input } = r;
			app.start();
			await flush();
			input.emit("data", "/skas"); // skas = 「skill : ask」的子序列（真名 ask 不含——只认真名筛不出）
			await flush(120);
			const plain = overlayOf(app).map(stripAnsi);
			const joined = plain.join("\n");
			expect(joined).toContain("skill : ask");
			expect(joined).not.toContain("skill : pdf"); // pdf 真名/标签都不是 skas 子序列
			expect(joined).toContain("0 个命令 · 1 个技能"); // rig 三命令（help/title/permission）无 skas 散见命中
			app.stop();
		});

		it("⑧ 过滤把命令筛光只剩技能时焦点自动落首个技能行（2026-09-30 用户走查：/mcp 只剩 context7-mcp 却无 ❯——敲字重置用敲键前清单，0 命令后 sep 占 0 位渲染不跳 sep、焦点整屏隐身；该态下 Tab 还会吃 sep 空串清空输入框）", async () => {
			const r = rig(["# hi"], 100, 30, {
				skillItems: () => [SK("review-pr", "审查拉取请求")],
			});
			const { app, input } = r;
			app.start();
			await flush();
			// 敲 e 那一拍敲键前清单 = /r 态 [/permission, sep, review-pr]（首行命令）——旧实现重置 0 后
			// /re 态清单变 [sep, review-pr]，0 位是 sep：渲染不高亮、Tab 取 items[0].key 空串
			input.emit("data", "/re");
			await flush(120);
			const joined = overlayOf(app).map(stripAnsi).join("\n");
			expect(joined).toContain("0 个命令 · 1 个技能");
			expect(joined).toContain("❯ skill : review-pr"); // 焦点可见地落在首个（唯一）技能行
			input.emit("data", "\t"); // Tab：选中行填 /skill : 名（不再清空输入框）
			await flush(120);
			expect(app.stateRef.input).toBe("/skill : review-pr");
			app.stop();
		});
	});

describe("斜杠菜单 Enter 越界钳制（CTU-01 回归钉 2026-09-28——粘贴收缩/技能清单 5s TTL 异步换数组后 overlaySel 陈旧越界，旧实现在此 TypeError 沿 stdin 链炸进程）", () => {
	it("① 越界索引 + Enter：钳到有效行照常提交，不崩", async () => {
		const r = rig(["# hi"], 100, 30);
		const { app, input, submitted } = r;
		app.start();
		await flush();
		input.emit("data", "/h"); // 只剩 /help 一条
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		(app.stateRef as { overlaySel: number }).overlaySel = 5; // 模拟清单收缩后的陈旧索引
		input.emit("data", "\r");
		await flush(120);
		expect(submitted).toEqual(["/help"]); // 旧行为：items[5]!.kind 读 undefined 崩进程
		app.stop();
	});
});

describe("技能管理面（m4-7 T8/T9——/settings → 技能 列表/详情，原型图 2/3/4）", () => {
	it("① pickOverlay 初始选中参数（详情 Esc 回列表——选中行回到该技能）+ view 窗自定义键 alt+k 内容替换翻转", async () => {
		const r = rig(["# hi"], 100, 30);
		const { app, input, output } = r;
		app.start();
		await flush();
		const outText = (): string => stripAnsi(output.buf);
		// selAt：列表重开时选中第 3 行（技能详情返回列表场景）——pendingUi 私有，断言走渲染形态
		const p = app.pickOverlay("技能（回车查看详情）", ["pdf 生成 PDF 文件 启用", "docx 生成 Word 文档 启用", "ok-wiki 维基条目收录 停用"], 2);
		await flush(120);
		expect(outText()).toContain("技能（回车查看详情）");
		input.emit("data", "\r"); // Enter——回传选中索引（selAt 钳在可选行上）
		await flush(120);
		await expect(p).resolves.toBe(2); // selAt=2 的行被选中
		// view 窗 alt+k：run 返回串 = 窗内容整体替换（状态行翻转的机制底座）
		let on = false;
		app.viewText("技能详情", "状态    启用", {
			keys: {
				"alt+k": {
					label: "Alt + K 启用或停用",
					run: (): string => {
						on = !on;
						return `状态    ${on ? "停用" : "启用"}`;
					},
				},
			},
		});
		await flush(120);
		expect(outText()).toContain("技能详情");
		input.emit("data", "\x1bk"); // Alt+K
		await flush(120);
		expect(on).toBe(true); // 键触发
		expect(outText()).toContain("停用"); // 返回串替换窗内容（状态行翻转后重渲上屏）
		app.stop();
	});

	it("② dock 布局（m4-7 走查修 2026-09-27 用户拍板「贴输入框上边缘 + 与输入框同宽」）：col 0 起左栏宽、row 贴输入框上缘、高度内容自适应", async () => {
		const r = rig(["# hi"], 100, 30);
		const { app, input } = r;
		app.start();
		await flush();
		app.viewText("技能详情", ["名称    pdf", "描述    d", "范围    个人（用户级）", "状态    启用", "文件    p"].join("\n"), { layout: "dock" });
		await flush(120);
		const f = (app as unknown as { buildViewOverlay(pu: unknown, leftW: number, divRow: number): { lines: string[]; row: number; col: number; width: number } });
		const pu = (app as unknown as { pendingUi: unknown }).pendingUi;
		// 直调传模拟几何（leftW=80、divRow=24）——渲染期真实值同式
		const frame = f.buildViewOverlay(pu, 80, 24);
		expect(frame.width).toBe(80); // 与输入框（左栏）同宽
		expect(frame.col).toBe(0); // 左起对齐输入框
		expect(frame.row).toBe(24 - frame.lines.length); // 底缘贴输入框上缘（divRow 之上）
		expect(frame.lines.length).toBe(8); // 5 行内容 + 框顶 + 提示行 + 框底——内容自适应（不是居中弹窗的定高）
		// 超高内容封顶可滚：20 行内容在 divRow=24 上方封页不越屏顶（先关第一窗——单槽 FIFO）
		input.emit("data", "\x1b"); // Esc
		await flush(120);
		app.viewText("技能详情", Array.from({ length: 20 }, (_, i) => `行${i}`).join("\n"), { layout: "dock" });
		await flush(120);
		const pu2 = (app as unknown as { pendingUi: unknown }).pendingUi;
		const frame2 = f.buildViewOverlay(pu2, 80, 24);
		expect(frame2.row).toBe(1); // 封顶不越屏：高度 23（20 内容+框 3）钳在 divRow 24 内，底缘仍贴输入框（24−23=1）
		expect(frame2.lines.length).toBeLessThanOrEqual(24);
		app.stop();
	});
});

describe("toast 时长参数（m5 T3——缺省 3000 不变、范围 [1000, 30000] 越界钳边界；主程序自家调用全走缺省）", () => {
	it("时长参数落到 state.toast.duration 并上屏", async () => {
		const { app, output } = rig();
		app.start();
		await flush();
		app.showToast("停八秒", 8000);
		expect(app.stateRef.toast?.duration).toBe(8000);
		await flush(60);
		expect(stripAnsi(output.buf)).toContain("停八秒");
	});

	it("缺省不落 duration 字段（3000 路径零变化）；越界钳到 [1000, 30000]", () => {
		const { app } = rig();
		app.start();
		app.showToast("缺省");
		expect(app.stateRef.toast?.duration).toBeUndefined();
		app.showToast("太短", 100);
		expect(app.stateRef.toast?.duration).toBe(1000);
		app.showToast("太长", 999999);
		expect(app.stateRef.toast?.duration).toBe(30000);
	});
});

describe("模块卡与两区卡组（m5 T6——内建在前模块卡按 order、←→ 切卡、单卡页码隐藏、渲染错误边界、卸载自然消失）", () => {
	it("① 右上卡组翻页：运行状态 → 网络·MCP → top 模块卡（3/3）→ 回绕运行状态", async () => {
		const { app, input, output } = rig(["# hi"], 100, 30, {
			panelData: () => ({
				...defaultPanelData(),
				cards: [{ area: "top", order: 60, title: "上卡", widgets: [{ id: "t", kind: "text", text: "上卡内容" }] }],
			}),
		});
		app.start();
		await flush();
		input.emit("data", "\t"); // 聚焦面板 1
		await flush();
		input.emit("data", "\x1b[C"); // → 网络·MCP
		await flush();
		input.emit("data", "\x1b[C"); // → top 模块卡
		await flush();
		const b = stripAnsi(output.buf);
		expect(b).toContain("上卡");
		expect(b).toContain("3/3");
		expect(b).toContain("上卡内容");
		input.emit("data", "\x1b[C"); // 回绕运行状态
		await flush();
		expect(app.stateRef.statePage).toBe(0);
	});

	it("② 右下卡组：单卡（无模块卡）页码隐藏；bottom 卡 ←→ 切换与回任务清单", async () => {
		let cards: { area: "top" | "bottom"; order: number; title: string; widgets: never[] }[] = [];
		const { app, input, output } = rig(["# hi"], 100, 30, {
			panelData: () => ({ ...defaultPanelData(), cards }),
		});
		app.start();
		await flush();
		input.emit("data", "\t\t"); // 聚焦面板 2（单卡态）
		await flush();
		input.emit("data", "\x1b[C"); // 单卡 → 页号不动（页码隐藏的键序面）
		await flush();
		expect(app.stateRef.taskPage).toBe(0);
		// 帧缓冲是 ANSI 定位序列不按 \n 分行——截「任务清单」框头到框角验证（单卡页码隐藏 = 无数字）
		const b0 = stripAnsi(output.buf);
		const t0 = b0.indexOf("任务清单");
		expect(t0).toBeGreaterThanOrEqual(0);
		expect(/\d/.test(b0.slice(t0, b0.indexOf("╮", t0)))).toBe(false);
		cards = [{ area: "bottom", order: 50, title: "下卡", widgets: [] }];
		input.emit("data", "\x1b[C"); // → bottom 卡（焦点已在面板 2）
		await flush();
		expect(stripAnsi(output.buf)).toContain("下卡");
		expect(stripAnsi(output.buf)).toContain("1/2");
		input.emit("data", "\x1b[D"); // ← 回任务清单
		await flush();
		expect(app.stateRef.taskPage).toBe(0);
	});

	it("③ 渲染错误边界：活值函数抛错 → 当帧占位行不炸侧栏、其余卡照常", async () => {
		const logs: string[] = [];
		const { app, input, output } = rig(["# hi"], 100, 30, {
			logWarn: (code, msg) => logs.push(`${code}:${msg}`),
			panelData: () => ({
				...defaultPanelData(),
				cards: [
					{ area: "top", order: 60, title: "好卡", widgets: [{ id: "k", kind: "kv", label: "读数", value: "正常" }] },
					{ area: "top", order: 70, title: "坏卡", widgets: [{ id: "b", kind: "text", text: () => { throw new Error("活值炸了"); } }] },
				],
			}),
		});
		app.start();
		await flush();
		input.emit("data", "\t"); // 聚焦面板 1
		await flush();
		input.emit("data", "\x1b[C\x1b[C"); // → 好卡（第 3 页）
		await flush();
		expect(stripAnsi(output.buf)).toContain("好卡");
		expect(stripAnsi(output.buf)).toContain("正常");
		input.emit("data", "\x1b[C"); // → 坏卡
		await flush();
		expect(stripAnsi(output.buf)).toContain("卡片渲染出错");
		expect(logs.some((l) => l.startsWith("tui.card.render-error"))).toBe(true);
	});

	it("④ 卸载后卡消失：cards 变空后页号夹回、标题不再上屏（每秒现读——不需要通知）", async () => {
		let cards: { area: "top"; order: number; title: string; widgets: never[] }[] = [{ area: "top", order: 60, title: "将卸卡", widgets: [] }];
		const { app, input, output } = rig(["# hi"], 100, 30, {
			panelData: () => ({ ...defaultPanelData(), cards }),
		});
		app.start();
		await flush();
		input.emit("data", "\t");
		await flush();
		input.emit("data", "\x1b[C\x1b[C"); // 到卡页
		await flush();
		expect(stripAnsi(output.buf)).toContain("将卸卡");
		cards = []; // 模块卸载——卡注册表自然消失
		input.emit("data", "\x1b[C"); // 页号 2 越界 → 夹回 0（运行状态）
		await flush();
		expect(app.stateRef.statePage).toBe(0);
		output.buf = "";
		input.emit("data", "\x1b[B"); // 任意重渲（↓）
		await flush();
		expect(stripAnsi(output.buf)).not.toContain("将卸卡");
	});

	it("⑤ 卡组键序守恒：面板 1 的 ↑↓/Enter 语义不变（模块选择/挂卸不受 ←→ 扩页影响）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "\t"); // 聚焦面板 1
		await flush();
		input.emit("data", "\x1b[B"); // ↓ 到 orosus-mcp
		await flush();
		expect(app.stateRef.moduleSel).toBe(1);
		input.emit("data", "\x1b[C"); // → 翻页不重置选中
		await flush();
		expect(app.stateRef.moduleSel).toBe(1);
	});
});

describe("控件窗三①（m5 T7——数据流三路 + 事件回传 + 句柄 + 卸载关窗；input 事件型在 T8）", () => {
	const listSpec = (items: string[]): DialogSpec => ({
		title: "后台作业",
		widgets: [
			{ id: "t", kind: "text", text: "作业列表", style: "accent" },
			{ id: "l", kind: "list", interactive: true, items },
		],
	});

	it("① 路一开窗快照：控件清单直渲染（文本 + 交互列表带选中标记）", async () => {
		const { app, output } = rig();
		app.start();
		await flush();
		app.openDialog(listSpec(["跑着", "排队", "完成"]));
		await flush();
		const b = stripAnsi(output.buf);
		expect(b).toContain("后台作业");
		expect(b).toContain("作业列表");
		expect(b).toContain("跑着");
	});

	it("② 事件三型之 select/activate：↓ 触发 select、Enter 触发 activate——onEvent 收到 index", async () => {
		const events: string[] = [];
		const { app, input } = rig();
		app.start();
		await flush();
		app.openDialog({
			title: "后台作业",
			widgets: [{ id: "l", kind: "list", interactive: true, items: ["a", "b", "c"] }],
			onEvent: (e) => {
				events.push(e.type === "select" || e.type === "activate" ? `${e.type}:${e.id}:${e.index}` : e.type);
			},
		});
		await flush();
		input.emit("data", "\x1b[B"); // ↓ → select index 1
		await flush();
		input.emit("data", "\r"); // Enter → activate index 1
		await flush();
		expect(events).toEqual(["select:l:1", "activate:l:1"]);
	});

	it("③ 路二 onEvent 回新清单 = 整窗替换（滚回顶部）；路三 update 句柄换清单", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		let mode = "列表态";
		const h = app.openDialog({
			title: "作业",
			widgets: [{ id: "l", kind: "list", interactive: true, items: ["x", "y"] }],
			onEvent: (e) => {
				if (e.type === "activate") {
					mode = "激活态";
					return [{ id: "done", kind: "text", text: "已激活：完成", style: "accent" }];
				}
				return undefined;
			},
		});
		await flush();
		expect(h).toBeDefined();
		input.emit("data", "\r"); // activate → onEvent 回新清单（路二）
		await flush();
		expect(stripAnsi(output.buf)).toContain("已激活：完成");
		h!.update([{ id: "u", kind: "kv", label: "状态", value: "句柄更新" }]); // 路 3
		await flush();
		expect(stripAnsi(output.buf)).toContain("句柄更新");
		expect(mode).toBe("激活态");
	});

	it("④ Esc 关窗 + 句柄作废：关窗后 update/close 无操作不报错", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		const h = app.openDialog(listSpec(["a"]));
		await flush();
		input.emit("data", "\x1b"); // Esc
		await flush();
		output.buf = "";
		h!.update([{ id: "x", kind: "text", text: "不应出现" }]);
		await flush();
		expect(stripAnsi(output.buf)).not.toContain("不应出现");
		expect(() => h!.close()).not.toThrow();
	});

	it("⑤ 卸载关窗：closeModuleUi(owner) 关在屏窗 + toast；句柄随之作废", async () => {
		const { app, output } = rig();
		app.start();
		await flush();
		const h = app.openDialog(listSpec(["a"]), "job-mod");
		await flush();
		app.closeModuleUi("job-mod");
		await flush();
		expect(stripAnsi(output.buf)).toContain("模块 job-mod 已卸载");
		output.buf = "";
		h!.update([{ id: "x", kind: "text", text: "不应出现" }]);
		await flush();
		expect(stripAnsi(output.buf)).not.toContain("不应出现");
	});

	it("⑥ onEvent 抛错 = 黄字提示且窗保留（全局约束 4）", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		app.openDialog({
			title: "炸窗",
			widgets: [{ id: "l", kind: "list", interactive: true, items: ["a"] }],
			onEvent: () => {
				throw new Error("模块炸了");
			},
		});
		await flush();
		input.emit("data", "\r");
		await flush();
		const b = stripAnsi(output.buf);
		expect(b).toContain("控件窗事件处理出错");
		expect(b).toContain("炸窗"); // 窗保留
	});

	it("⑦ Tab 焦点循环：两个交互列表间换焦点，↑↓ 只动焦点列表", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		app.openDialog({
			title: "双列表",
			widgets: [
				{ id: "a", kind: "list", interactive: true, items: ["a1", "a2"] },
				{ id: "b", kind: "list", interactive: true, items: ["b1", "b2"] },
			],
		});
		await flush();
		input.emit("data", "\t"); // 焦点 a → b
		await flush();
		input.emit("data", "\x1b[B"); // ↓ 动 b 列表（b1 → b2）
		await flush();
		// 断言走输出：b2 被选中（焦点列表选中行带 ❯ 且高亮）——检查 b2 行含选中标记
		const b = stripAnsi(output.buf);
		expect(b).toContain("双列表");
		expect(b).toContain("❯ b2");
	});
});

describe("控件窗三②交互（m5 T8——input 编辑/提交/换行 + input 事件型）", () => {
	it("① input 单行：打字触发 input 事件、Enter 触发 activate（enterSubmit 缺省）", async () => {
		const events: string[] = [];
		const { app, input, output } = rig();
		app.start();
		await flush();
		app.openDialog({
			title: "表单",
			widgets: [{ id: "q", kind: "input", placeholder: "问点啥" }],
			onEvent: (e) => {
				events.push(e.type === "input" ? `input:${e.text}` : e.type === "activate" ? "activate" : e.type);
			},
		});
		await flush();
		input.emit("data", "h");
		input.emit("data", "i");
		await flush();
		expect(events).toEqual(["input:h", "input:hi"]);
		expect(stripAnsi(output.buf)).toContain("hi");
		input.emit("data", "\r"); // Enter 提交
		await flush();
		expect(events).toEqual(["input:h", "input:hi", "activate"]);
	});

	it("② input 多行：Alt+Enter 换行（默认 enterSubmit = 多行 false → Enter 也换行）", async () => {
		const events: string[] = [];
		const { app, input } = rig();
		app.start();
		await flush();
		app.openDialog({
			title: "多行",
			widgets: [{ id: "m", kind: "input", multiline: true, lines: 3 }],
			onEvent: (e) => {
				events.push(e.type === "input" ? `input:${JSON.stringify(e.text)}` : e.type);
			},
		});
		await flush();
		input.emit("data", "a");
		input.emit("data", "\x1b\r"); // Alt+Enter 换行
		input.emit("data", "b");
		await flush();
		expect(events).toEqual(['input:"a"', 'input:"a\\n"', 'input:"a\\nb"']);
	});

	it("③ 多行 enterSubmit:true 时 Enter = 提交不换行", async () => {
		const events: string[] = [];
		const { app, input } = rig();
		app.start();
		await flush();
		app.openDialog({
			title: "提交框",
			widgets: [{ id: "m", kind: "input", multiline: true, enterSubmit: true }],
			onEvent: (e) => {
				events.push(e.type === "input" ? "input" : e.type);
			},
		});
		await flush();
		input.emit("data", "\r");
		await flush();
		expect(events).toEqual(["activate"]);
	});

	it("④ Tab 在输入框与列表间循环；光标键归输入框（列表选中不动）", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		app.openDialog({
			title: "混排",
			widgets: [
				{ id: "q", kind: "input" },
				{ id: "l", kind: "list", interactive: true, items: ["x", "y"] },
			],
		});
		await flush();
		input.emit("data", "a"); // 焦点默认在 q（首个交互控件）
		await flush();
		expect(stripAnsi(output.buf)).toContain("a▏"); // 2026-09-30 框形：字进框内容行、光标块随行
		input.emit("data", "\t"); // 焦点 q → l
		await flush();
		input.emit("data", "\x1b[B"); // ↓ 动列表
		await flush();
		input.emit("data", "\t"); // l → q
		await flush();
		input.emit("data", "b"); // 回到输入框继续打字
		await flush();
		expect(stripAnsi(output.buf)).toContain("ab▏");
	});
});

describe("侧栏开关公共出口（m5 T11——Ctrl+T 与设置服务共用，原内联三件套提纯）", () => {
	it("① setSidebar(false)：持久化回调收到、焦点回输入区、幂等短路（同值不再回调）", async () => {
		const changes: boolean[] = [];
		const { app, input } = rig(["# hi"], 100, 30, { onSidebarChange: (v) => changes.push(v) });
		app.start();
		await flush();
		input.emit("data", "\t"); // 焦点到面板
		await flush();
		input.emit("data", "\x14"); // Ctrl+T 关侧栏（公共出口）
		await flush();
		expect(app.stateRef.sidebarVisible).toBe(false);
		expect(app.stateRef.focusIdx).toBe(0); // 面板隐藏——焦点回输入区
		expect(changes).toEqual([false]);
		app.setSidebar(false); // 幂等短路：不再回调
		expect(changes).toEqual([false]);
		app.setSidebar(true); // 冷却内（T5 护栏②——500ms 连击静默吞）
		await flush();
		expect(changes).toEqual([false]);
		await flush(600); // 过冷却再切——设置服务路径同款出口
		app.setSidebar(true);
		await flush();
		expect(changes).toEqual([false, true]);
	});
});

describe("面板待确认第四态（m5 T17——渲染 + 回车弹确认窗而非热插拔）", () => {
	it("① 渲染「待确认」文案；回车走 confirmModule 出口（不 toggle）；off 态回车照旧 toggle", async () => {
		const confirmCalls: string[] = [];
		const toggleCalls: string[] = [];
		const panel = () => ({
			...defaultPanelData(),
			modules: [
				{ name: "orosus-core", desc: "核心循环", state: "mounted" as const, locked: true },
				{ name: "new-mod", desc: "", state: "pendingConfirm" as const },
				{ name: "off-mod", desc: "", state: "off" as const },
			],
		});
		const { app, input, output } = rig(["# hi"], 100, 30, {
			panelData: panel,
			confirmModule: (n) => confirmCalls.push(n),
			toggleModule: (n) => toggleCalls.push(n),
		});
		app.start();
		await flush();
		expect(stripAnsi(output.buf)).toContain("待确认");
		input.emit("data", "\t"); // 聚焦面板 1
		await flush();
		input.emit("data", "\x1b[B"); // ↓ 到 new-mod（待确认）
		await flush();
		input.emit("data", "\r");
		await flush();
		expect(confirmCalls).toEqual(["new-mod"]);
		input.emit("data", "\x1b[B"); // ↓ 到 off-mod
		await flush();
		input.emit("data", "\r");
		await flush();
		expect(toggleCalls).toEqual(["off-mod"]); // 常规态回车照旧热插拔
	});
});

describe("斜杠菜单参数阶段（m5 T15——命令名已定 + 空格后长出参数候选，复用菜单过滤与翻页）", () => {
	it("① 输入 /note__open + 空格 → 菜单切参数候选；↑↓ 选择 Tab 补全词；Esc 关菜单不清输入", async () => {
		const { app, input, output } = rig(["# hi"], 100, 30, {
			slashArgComplete: (cmd, word) => (cmd === "/note__open" ? ["todo.md", "notes.md"].filter((x) => x.startsWith(word)) : undefined),
		});
		app.start();
		await flush();
		input.emit("data", "/note__open ");
		await flush();
		const b = stripAnsi(output.buf);
		expect(b).toContain("todo.md"); // 参数候选上屏
		expect(b).toContain("notes.md");
		input.emit("data", "\x1b[B"); // ↓ 到 notes.md
		await flush();
		input.emit("data", "\t"); // Tab 补全当前词
		await flush();
		expect(app.stateRef.input).toBe("/note__open notes.md ");
		input.emit("data", "\x1b"); // Esc 关菜单（不清输入）
		await flush();
		expect(app.stateRef.overlayOpen).toBe(false);
		expect(app.stateRef.input).toBe("/note__open notes.md ");
	});

	it("② 前缀过滤（输入 n 只剩 notes.md）+ Enter 用选中候选提交", async () => {
		const { app, input, output } = rig(["# hi"], 100, 30, {
			slashArgComplete: (_cmd, word) => ["todo.md", "notes.md"].filter((x) => x.startsWith(word)),
		});
		app.start();
		await flush();
		input.emit("data", "/note__open n");
		await flush();
		const b = stripAnsi(output.buf);
		expect(b).toContain("notes.md");
		expect(b).not.toContain("todo.md"); // 前缀过滤
		input.emit("data", "\r"); // Enter 提交（选中候选替换当前词）
		await flush();
		expect(app.stateRef.input).toBe(""); // 已提交清输入
	});

	it("③ 无 completeArg 的命令照旧命令名菜单（不误入参数阶段）", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		input.emit("data", "/ti"); // /title 未声明补全
		await flush();
		const b = stripAnsi(output.buf);
		expect(b).toContain("/title");
	});
});

describe("双击 Esc 全停子代理（M4.5 T14——决策 12 + 忙时叠合定案）", () => {
	it("㊿ 空闲 + 焦点输入框 + 有子代理在册：双击（1 秒窗口）全停；单击只提示；无子代理零行为改动", async () => {
		const { app, input, actions } = rig([], 100, 30, {
			subagentActive: () => true,
			stopAllSubagents: () => actions.push("stopall"),
		});
		app.start();
		await flush();
		input.emit("data", ""); // 空闲首按：只提示不动作
		await flush(80);
		expect(actions).toEqual([]);
		expect(app.stateRef.toast?.text).toContain("再按一次 Esc 停止全部子代理");
		input.emit("data", ""); // 窗口内再按：全停
		await flush(80);
		expect(actions).toEqual(["stopall"]);
		app.stop();
	});

	it("㊿b 无子代理在册：空闲双击不触发全停（界面规矩零改动——第二按也只回焦点）", async () => {
		const { app, input, actions } = rig([], 100, 30, { stopAllSubagents: () => actions.push("stopall") });
		app.start();
		await flush();
		input.emit("data", "");
		await flush(80);
		input.emit("data", "");
		await flush(80);
		expect(actions).toEqual([]); // 无子代理——不进入全停分支
		app.stop();
	});

	it("㊿c 忙时双击叠合（T14 定案）：停生成 + 全停子代理一次双击两件事", async () => {
		const { app, input, actions } = rig([], 100, 30, { stopAllSubagents: () => actions.push("stopall") });
		app.start();
		await flush();
		app.setBusy(true);
		input.emit("data", "");
		await flush(80);
		expect(app.stateRef.toast?.text).toContain("停止生成与全部子代理");
		input.emit("data", "");
		await flush(80);
		expect(actions).toEqual(["cancel", "stopall"]); // 两件都做、顺序 = 停生成先
		app.stop();
	});
});

describe("双击 Esc 中止视觉转述（m5-media 走查四——非 busy 独立态：等待期 turn 未开始）", () => {
	it("ⓐ 转述等待期：单击只提示，窗口内双击触发中止；不再等待后 Esc 回归零行为", async () => {
		let transcribing = true;
		const { app, input, actions } = rig([], 100, 30, {
			visionTranscribing: () => transcribing,
			abortVisionTranscribe: () => { transcribing = false; actions.push("abort-vision"); },
		});
		app.start();
		await flush();
		input.emit("data", ""); // 首按只提示不动作
		await flush(80);
		expect(actions).toEqual([]);
		expect(app.stateRef.toast?.text).toContain("再按一次 Esc 中止转述");
		input.emit("data", ""); // 窗口内再按：中止
		await flush(80);
		expect(actions).toEqual(["abort-vision"]);
		input.emit("data", ""); // 已不在等待——不炸、不再触发中止（回焦点零行为）
		await flush(80);
		expect(actions).toEqual(["abort-vision"]);
		app.stop();
	});

	it("ⓑ 非等待期（未挂 io 两个口）：空闲双击零行为改动——回归钉（不误入中止分支）", async () => {
		const { app, input, actions } = rig([], 100, 30, {});
		app.start();
		await flush();
		input.emit("data", "");
		await flush(80);
		input.emit("data", "");
		await flush(80);
		expect(actions).toEqual([]); // 无子代理无转述——维持旧零行为
		app.stop();
	});
});

describe("浮层期硬件光标隐藏（2026-09-27 用户走查：子代理查看窗里浮着个光标——浮层是字符层盖不住物理光标）", () => {
	it("view/pick/dialog 浮层在位时 placeCursor 写隐藏序列（?25l）；ask 输入行接管与斜杠菜单期仍显示（?25h）", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		expect(output.buf).toMatch(/H\[\?25h/); // 稳态：光标显示（placeCursor visible 形态）
		const beforeView = output.buf.length;
		app.viewText("查看", "一行内容");
		await flush(80);
		// 只查查看窗后的增量（ENTER_ALT 自带 [H[?25l 会污染全量匹配）
		expect(output.buf.slice(beforeView)).toMatch(/H\[\?25l/); // 查看窗盖住输入框 → 光标隐藏
		input.emit("data", ""); // Esc 关窗
		await flush(80);
		expect(output.buf.slice(-400)).toMatch(/H\[\?25h/); // 关窗回输入 → 光标恢复
		app.stop();
	});
});

describe("查看窗全屏贴底（2026-09-27 用户拍板：自动滚动到底部）", () => {
	/** 查看窗渲染层断言口径（T1 迁移）：直接调 buildViewOverlay 拿浮层行——不再读内部 scroll 字段。 */
	const viewLines = (app: FullApp): string[] => {
		const pu = (app as unknown as { pendingUi: unknown }).pendingUi;
		return (app as unknown as { buildViewOverlay(pu: unknown): { lines: string[] } }).buildViewOverlay(pu).lines.map(stripAnsi);
	};
	const rows = (n: number): string => Array.from({ length: n }, (_, i) => `行${i + 1}`).join("\n");

	it("㊿-8 viewText bottom：初始渲染末页；live 变长贴底跟随（断言走渲染层口径——T1 pinned 迁移）", async () => {
		const { app } = rig();
		app.start();
		await flush();
		let body = rows(60);
		app.viewText("查看", body, { layout: "full", bottom: true, live: () => body });
		await flush(80);
		let lines = viewLines(app);
		expect(lines.some((l) => l.includes("行60"))).toBe(true); // 首帧渲染末页（60 行 / page 27）
		expect(lines.some((l) => l.includes("行34"))).toBe(true); // 末页首行 = 行34（60−27 起）
		expect(lines.some((l) => l.includes("行33"))).toBe(false);
		body = rows(80); // live 长内容
		// T4（m5-agentview-perf）语义适配：live 一秒结果缓存 + tickTimer 1000ms 保底帧相位叠加——
		// 数据源变化到屏幕可见最坏 ≈2s（龄门 1s + 下一 tick 帧 1s）。跨两个 tick 帧必见现算刷新。
		await flush(2100);
		lines = viewLines(app);
		expect(lines.some((l) => l.includes("行80"))).toBe(true); // 贴底跟随到新末页
		app.stop();
	});
	it("T1-a 首按 ↑ 立即上移一行（死区消除——旧哨兵形态要连按 29 次才动）且 live 刷新不抢回贴底", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		let body = rows(80);
		app.viewText("查看", body, { layout: "full", bottom: true, live: () => body });
		await flush(80);
		input.emit("data", "\x1b[A"); // ↑
		await flush(80);
		let lines = viewLines(app);
		expect(lines.some((l) => l.includes("行79"))).toBe(true);
		expect(lines.some((l) => l.includes("行80"))).toBe(false); // 立即上移（落地 53 后 −1 = 52 → 行53..79）
		body = rows(100);
		await flush(1200);
		lines = viewLines(app);
		expect(lines.some((l) => l.includes("行79"))).toBe(true);
		expect(lines.some((l) => l.includes("行100"))).toBe(false); // 脱钉——live 不抢用户滚动位置
		app.stop();
	});
	it("T1-b 贴底时按 ↓ 钳在末页不动（语义不变）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		app.viewText("查看", rows(60), { layout: "full", bottom: true });
		await flush(80);
		input.emit("data", "\x1b[B"); // ↓
		await flush(80);
		const lines = viewLines(app);
		expect(lines.some((l) => l.includes("行60"))).toBe(true); // 仍在末页
		app.stop();
	});
	it("T1-c 非 bottom 窗照旧从顶开始（pinned 不影响缺省窗）", async () => {
		const { app } = rig();
		app.start();
		await flush();
		app.viewText("查看", rows(60), { layout: "full" });
		await flush(80);
		const lines = viewLines(app);
		expect(lines.some((l) => l.includes("行1"))).toBe(true);
		expect(lines.some((l) => l.includes("行60"))).toBe(false); // 未满一屏多的部分不出现在首帧
		app.stop();
	});
});

describe("斜杠命令大小写（2026-09-27 用户走查拍板：命令英文忽略大小写）", () => {
	it("输入 /HE 与 /HELP 都能筛出 /help；Enter 提交的是菜单真名（小写规范化）", async () => {
		const { app, input, submitted } = rig();
		app.start();
		await flush();
		input.emit("data", "/HE");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		expect(app.stateRef.overlaySel).toBe(0);
		input.emit("data", "\r"); // Enter 执行选中项
		await flush(120);
		expect(submitted).toEqual(["/help"]); // 提交真名——不带大写过滤串
		app.stop();
	});
});

describe("滚轮路由（m5 鼠标批 T2——onWheel 窗口栈版：主流区兜底直绑 scrollBack，与键盘焦点无关）", () => {
	const wheel = (input: FakeInput, dir: "up" | "down", alt = false): void => {
		const code = 64 + (dir === "up" ? 0 : 1) + (alt ? 8 : 0);
		input.emit("data", `\x1b[<${code};10;5M`);
	};
	const longDoc = Array.from({ length: 100 }, (_, i) => `第${i + 1}行`);

	it("T2-1 主流区：上滚 scrollBack 增、下滚减、到 0 钳住", async () => {
		const { app, input } = rig(longDoc);
		app.start();
		await flush();
		wheel(input, "up"); wheel(input, "up");
		await flush();
		expect(app.stateRef.scrollBack).toBe(2);
		wheel(input, "down");
		await flush();
		expect(app.stateRef.scrollBack).toBe(1);
		wheel(input, "down"); wheel(input, "down");
		await flush();
		expect(app.stateRef.scrollBack).toBe(0); // 0 钳住不越界
		app.stop();
	});
	it("T2-2 同字段等价（拍板钉子）：滚 3 格恰 +3；再按 PgUp 在此之上 +页步长——滚轮与翻页键写同一字段只是步长不同", async () => {
		const { app, input } = rig(longDoc);
		app.start();
		await flush();
		wheel(input, "up"); wheel(input, "up"); wheel(input, "up");
		await flush();
		expect(app.stateRef.scrollBack).toBe(3);
		input.emit("data", "\x1b[5~"); // PgUp：页步长 = rows−10 = 20
		await flush();
		expect(app.stateRef.scrollBack).toBe(23);
		app.stop();
	});
	it("T2-3 Alt+滚轮 ×5 步长", async () => {
		const { app, input } = rig(longDoc);
		app.start();
		await flush();
		wheel(input, "up", true);
		await flush();
		expect(app.stateRef.scrollBack).toBe(5);
		app.stop();
	});
	it("T2-4 busy 期照滚（生成中回看历史）", async () => {
		const { app, input } = rig(longDoc);
		app.start();
		await flush();
		app.setBusy(true);
		wheel(input, "up");
		await flush();
		expect(app.stateRef.scrollBack).toBe(1);
		app.setBusy(false);
		app.stop();
	});
	it("T2-5 面板聚焦期滚轮仍滚主流区（对照 ④b：同场景 PgUp 归面板而滚轮不归）", async () => {
		const { app, input } = rig(longDoc);
		app.start();
		await flush();
		input.emit("data", "\t"); // 焦点 → 运行状态面板
		await flush();
		expect(app.stateRef.focusIdx).toBe(1);
		wheel(input, "up");
		await flush();
		expect(app.stateRef.scrollBack).toBe(1); // 滚轮不吃面板焦点
		app.stop();
	});
	it("T2-6 查看窗：滚轮滚查看窗与 PgUp 同字段（先滚 2 格再 PgUp，scroll 在 −2 基础上 −页步长；pinned 窗首滚即脱钉）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		app.viewText("查看", Array.from({ length: 80 }, (_, i) => `行${i + 1}`).join("\n"), { layout: "full", bottom: true });
		await flush(80);
		wheel(input, "up"); wheel(input, "up"); // pinned 落地 maxScroll（80−27=53）后 −2 = 51
		await flush(80);
		const pu = (app as unknown as { pendingUi: { scroll: number; pinned?: boolean } }).pendingUi;
		expect(pu.pinned).toBe(false); // 首滚即脱钉
		expect(pu.scroll).toBe(51);
		input.emit("data", "\x1b[5~"); // PgUp：−27
		await flush(80);
		expect(pu.scroll).toBe(24); // 同字段在此之上 −页步长
		app.stop();
	});
	it("T2-7 pick 开着：滚轮翻选中且到头停（不回绕）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		void app.pickOverlay("选择", ["a", "b", "c"]);
		await flush();
		wheel(input, "down"); wheel(input, "down"); wheel(input, "down"); wheel(input, "down");
		await flush();
		const pu = (app as unknown as { pendingUi: { sel: number } }).pendingUi;
		expect(pu.sel).toBe(2); // 到底停（决策点 6——键盘 ↑↓ 取模回绕，滚轮不学）
		wheel(input, "up");
		await flush();
		expect(pu.sel).toBe(1);
		app.stop();
	});
	it("T2-8 斜杠菜单开着：滚轮翻选中", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "/"); // 开菜单（3 条命令）
		await flush(120);
		wheel(input, "down"); wheel(input, "down");
		await flush(120);
		expect(app.stateRef.overlaySel).toBe(2);
		wheel(input, "down"); // 到头停
		await flush(120);
		expect(app.stateRef.overlaySel).toBe(2);
		app.stop();
	});
	it("T2-9 onboarding 期与 ask 期滚轮无效果", async () => {
		const r = rig(longDoc);
		const { app, input } = r;
		app.start();
		await flush();
		(app as unknown as { onboarding: unknown }).onboarding = { session: {}, resolve: () => {} }; // 旁路挂引导态（滚轮只看在场性）
		wheel(input, "up");
		await flush();
		expect(app.stateRef.scrollBack).toBe(0); // 引导锁
		(app as unknown as { onboarding: unknown }).onboarding = undefined;
		void app.promptInput("问题？", false); // ask 挂起
		await flush();
		wheel(input, "up");
		await flush();
		expect(app.stateRef.scrollBack).toBe(0); // ask 没有可滚面
		app.stop();
	});
	it("T2-10 非滚轮鼠标事件整吞不漏：点击/拖动/释放序列 emit 后输入框内容不变", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "\x1b[<0;10;5M"); // 左键按下
		input.emit("data", "\x1b[<32;12;6M"); // 拖动
		input.emit("data", "\x1b[<0;12;6m"); // 释放
		await flush();
		expect(app.stateRef.input).toBe(""); // 不漏字符进输入框
		app.stop();
	});
});

describe("主窗文本选择（m5 鼠标批 T5——拖选反白 + 松开即复制；不再需要按住 Shift）", () => {
	// SGR 按钮序列辅助（坐标 0 起 → SGR 1 起编码）
	const press = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<0;${x + 1};${y + 1}M`); };
	const dragTo = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<32;${x + 1};${y + 1}M`); };
	const releaseAt = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<0;${x + 1};${y + 1}m`); };
	const doc100 = Array.from({ length: 100 }, (_, i) => `第${i + 1}行内容`);
	type SelState = { mselAnchor: { docIdx: number; col: number } | undefined; mselFocus: { docIdx: number; col: number } | undefined };

	it("T5-1 pointToDoc 映射：屏行→doc 行（scrollBack 0 时 start=75）、左内衬 2 列、流区外/面板列 undefined", async () => {
		const { app } = rig(doc100);
		app.start();
		await flush();
		const ptd = (app as unknown as { pointToDoc(x: number, y: number): { docIdx: number; col: number } | undefined }).pointToDoc.bind(app);
		expect(ptd(5, 0)).toEqual({ docIdx: 75, col: 3 }); // 屏行 0 = doc 尾屏首行；x−2 = 左内衬
		expect(ptd(0, 0)).toEqual({ docIdx: 75, col: 0 }); // x 负值钳 0
		expect(ptd(5, 26)).toBeUndefined(); // y >= streamH（30−4）= 输入框区 → 不选
		expect(ptd(70, 0)).toBeUndefined(); // x >= leftW（100−34−2=64）= 右侧面板 → 不选（防幻影锚点）
		app.stop();
	});
	it("T5-2 selectionText：单行区间/跨行区间提取纯文本（ANSI 色码剥离、列区间按显示宽切）", async () => {
		const lines = [
			"\x1b[31m红色第一行\x1b[0m",
			"second line",
			"third",
		];
		const { app } = rig(lines);
		app.start();
		await flush();
		const st = app.stateRef as unknown as SelState;
		const sel = (app as unknown as { selectionText(): string | undefined }).selectionText.bind(app);
		st.mselAnchor = { docIdx: 0, col: 2 }; // 「红色第一行」列位（汉字 2 列）：红0-1 色2-3 第4-5 一6-7 行8-9
		st.mselFocus = { docIdx: 0, col: 8 };
		expect(sel()).toBe("色第一"); // 单行列区间 + 色码剥离
		st.mselAnchor = { docIdx: 0, col: 0 };
		st.mselFocus = { docIdx: 1, col: 6 }; // 反向跨行（focus 在后）
		expect(sel()).toBe("红色第一行\nsecond");
		st.mselAnchor = { docIdx: 1, col: 6 };
		st.mselFocus = { docIdx: 0, col: 0 }; // 正向（anchor 在后）——排序后同上
		expect(sel()).toBe("红色第一行\nsecond");
		st.mselAnchor = undefined;
		st.mselFocus = undefined;
		expect(sel()).toBeUndefined(); // 无选区
		app.stop();
	});
	it("T5-3 渲染反白：选区行含 \\x1b[7m 反白段、非选区行不含", async () => {
		const { app, input, output } = rig(doc100);
		app.start();
		await flush();
		const before = output.buf.length;
		press(input, 4, 0); // docIdx 75 col 2
		dragTo(input, 10, 0);
		await flush();
		const frame = output.buf.slice(before);
		expect(frame).toContain("\x1b[7m"); // 反白段（theme.inverse）
		app.stop();
	});
	it("T5-4 按下-拖动-松开全链：writeClipboard 被调且 toast「已复制 N 行」；失败走 OSC 52 兜底提示", async () => {
		const writes: string[] = [];
		const { app, input } = rig(doc100, 100, 30, { writeClipboard: async (t: string) => { writes.push(t); return true; } });
		app.start();
		await flush();
		press(input, 4, 0); // docIdx 75 col 2「第76行内容」的「7」附近
		dragTo(input, 20, 1); // docIdx 76 col 18——跨行
		releaseAt(input, 20, 1);
		await flush();
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain("76行内容"); // 提取的是 doc 内容（press col 2 恰从「第76」的 7 起——左内衬 2 列 + 汉字 2 列宽）
		expect(writes[0]).toContain("\n"); // 跨行
		expect(app.stateRef.toast?.text).toMatch(/^已复制 2 行$/);
		app.stop();
	});
	it("T5-5 空点击（按下-松开无拖动）= 清空选区（决策点 12）", async () => {
		const { app, input } = rig(doc100);
		app.start();
		await flush();
		press(input, 4, 0);
		dragTo(input, 10, 0);
		releaseAt(input, 10, 0); // 有选区的松开——非空选区保留反白
		await flush();
		const st = app.stateRef as unknown as SelState;
		expect(st.mselAnchor).toBeDefined(); // 非空选区保留
		press(input, 4, 5); // 空点击（新按下即折叠）
		releaseAt(input, 4, 5);
		await flush();
		expect(st.mselAnchor).toBeUndefined(); // 松开即消
		expect(st.mselFocus).toBeUndefined();
		app.stop();
	});
	it("T5-6 非流区按下（面板列/输入框行）不建选区", async () => {
		const { app, input } = rig(doc100);
		app.start();
		await flush();
		press(input, 70, 0); // 面板列
		await flush();
		const st = app.stateRef as unknown as SelState;
		expect(st.mselAnchor).toBeUndefined(); // 不建幻影锚点（清选区语义）
		press(input, 5, 28); // 输入框行（y >= streamH=26）
		await flush();
		expect(st.mselAnchor).toBeUndefined();
		app.stop();
	});
	it("T5-7 writeClipboardText 失败落 OSC 52 兜底：终端收到 52 复制口令 + toast 未确认提示", async () => {
		const { app, input, output } = rig(doc100, 100, 30, { writeClipboard: async () => false });
		app.start();
		await flush();
		const before = output.buf.length;
		press(input, 4, 0);
		dragTo(input, 10, 0);
		releaseAt(input, 10, 0);
		await flush();
		expect(output.buf.slice(before)).toContain("\x1b]52;c;"); // OSC 52 逃生口
		expect(app.stateRef.toast?.text).toBe("已发终端复制口令（系统剪贴板未确认）");
		app.stop();
	});
	it("CC-1 Ctrl+A 全选后 Ctrl+C：writeClipboard 收到输入框全文 + toast「已复制输入框 N 字」（2026-09-30 拍板）", async () => {
		const writes: string[] = [];
		const { app, input } = rig(["# 你好"], 100, 30, { writeClipboard: async (t: string) => { writes.push(t); return true; } });
		app.start();
		await flush();
		input.emit("data", "你好世界");
		input.emit("data", "\x01"); // Ctrl+A 全选
		input.emit("data", "\x03"); // Ctrl+C
		await flush();
		expect(writes).toEqual(["你好世界"]);
		expect(app.stateRef.toast?.text).toBe("已复制输入框 4 字");
		app.stop();
	});
	it("CC-2 无键盘选区时 Ctrl+C：吞键维持现状——不写剪贴板、无 toast", async () => {
		const writes: string[] = [];
		const { app, input } = rig(["# 你好"], 100, 30, { writeClipboard: async (t: string) => { writes.push(t); return true; } });
		app.start();
		await flush();
		input.emit("data", "abc");
		input.emit("data", "\x03"); // 无选区的 Ctrl+C
		await flush();
		expect(writes).toHaveLength(0);
		expect(app.stateRef.toast).toBeUndefined();
		app.stop();
	});
	it("CC-3 输入框 Ctrl+C 失败落 OSC 52 兜底（与拖选同一条降级路）", async () => {
		const { app, input, output } = rig(["# 你好"], 100, 30, { writeClipboard: async () => false });
		app.start();
		await flush();
		const before = output.buf.length;
		input.emit("data", "ab");
		input.emit("data", "\x01");
		input.emit("data", "\x03");
		await flush();
		expect(output.buf.slice(before)).toContain("\x1b]52;c;");
		expect(app.stateRef.toast?.text).toBe("已发终端复制口令（系统剪贴板未确认）");
		app.stop();
	});
	it("CC-4 键盘选区诞生清拖选高亮：Ctrl+A 与 Shift+→ 两路都清（拍板：屏幕最多一块高亮）", async () => {
		const { app, input } = rig(doc100, 100, 30);
		app.start();
		await flush();
		const st = app.stateRef as unknown as SelState;
		input.emit("data", "xy");
		press(input, 4, 0); dragTo(input, 20, 1); releaseAt(input, 20, 1); // 拖选留高亮
		await flush();
		expect(st.mselAnchor).toBeDefined();
		input.emit("data", "\x01"); // Ctrl+A → 键盘选区诞生
		await flush();
		expect(st.mselAnchor).toBeUndefined(); // 拖选高亮被清
		input.emit("data", "\x1b[C"); // → 收起键盘选区
		await flush();
		press(input, 4, 0); dragTo(input, 20, 1); releaseAt(input, 20, 1); // 再拖选一次
		await flush();
		expect(st.mselAnchor).toBeDefined();
		input.emit("data", "\x1b[1;2C"); // Shift+→ 首拍 → 键盘选区从无到有
		await flush();
		expect(st.mselAnchor).toBeUndefined(); // 同样清拖选高亮
		app.stop();
	});
});

describe("双击选词/三击选行（m5 鼠标批 T6——kimi :1169-1257 同款：500ms 窗口 + 词/行边界连击计数）", () => {
	const press = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<0;${x + 1};${y + 1}M`); };
	const dragTo = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<32;${x + 1};${y + 1}M`); };
	type SelState = { mselAnchor: { docIdx: number; col: number } | undefined; mselFocus: { docIdx: number; col: number } | undefined; lastClick: { at: number; count: number; docIdx: number; wordStart: number; wordEnd: number } | undefined };
	// 可视区 docIdx 75 起（100 行 doc + tailLine、streamH 26、scrollBack 0）
	const mkDoc = (): string[] => {
		const d = Array.from({ length: 100 }, () => "filler");
		d[75] = "see a/b/c.ts ok";
		d[76] = "well-known done";
		return d;
	};

	it("T6-1 词区间纯函数 wordRangeAt：连接符贪心拼接（a/b/c.ts、well-known 整词）；空白段 undefined", async () => {
		const { wordRangeAt } = await import("./fullapp.ts");
		expect(wordRangeAt("see a/b/c.ts ok", 1)).toEqual({ start: 0, end: 3 }); // "see"
		expect(wordRangeAt("see a/b/c.ts ok", 4)).toEqual({ start: 4, end: 12 }); // 路径整词（点 a）
		expect(wordRangeAt("see a/b/c.ts ok", 10)).toEqual({ start: 4, end: 12 }); // 点 c.ts 也整词
		expect(wordRangeAt("well-known done", 3)).toEqual({ start: 0, end: 10 }); // 连字符整词（4+1+5 字符）
		expect(wordRangeAt("see a/b/c.ts ok", 3)).toBeUndefined(); // 空白段
	});
	it("T6-2 双击选词：500ms 内同词两击 → 选区恰为词区间；三击 → 整行", async () => {
		{ // 段一：双击 → 词区间（两击零间隔连发，窗口判定不受其后 flush 影响）
			const { app, input } = rig(mkDoc());
			app.start();
			await flush();
			const st = app.stateRef as unknown as SelState;
			press(input, 6, 0); // docIdx 75 列 6（b 处）——第一击 count 1
			press(input, 6, 0); // 同点第二击 count 2 → 词区间
			await flush();
			expect(st.mselAnchor).toEqual({ scope: "main", docIdx: 75, col: 4 });
			expect(st.mselFocus).toEqual({ scope: "main", docIdx: 75, col: 12 });
			app.stop();
		}
		{ // 段二：三击 → 整行。三击必须零间隔连发：旧版在两击与第三击之间夹一次 flush + 断言——
		  // 慢机/负载下 flush(40) 实际墙钟可超 500ms，第三击漂出窗口计数被重置，整行永不成立
		  //（release-npm 0.1.1 实发轮满载全量抓出；拆段保中间态断言、连发保三击窗口）
			const { app, input } = rig(mkDoc());
			app.start();
			await flush();
			const st = app.stateRef as unknown as SelState;
			press(input, 6, 0); press(input, 6, 0); press(input, 6, 0); // 连发三击（同 tick，窗口必内）
			await flush();
			expect(st.mselAnchor).toEqual({ scope: "main", docIdx: 75, col: 0 });
			expect(st.mselFocus?.docIdx).toBe(75); // 整行选区（scope main）
			app.stop();
		}
	});
	it("T6-3 双击后向上拖：锚点切到初始区间尾端（智能扩选反向）；向下拖按词对齐", async () => {
		const { app, input } = rig(mkDoc());
		app.start();
		await flush();
		const st = app.stateRef as unknown as SelState;
		press(input, 4, 1); // docIdx 76「well-known done」列 4——第一击
		press(input, 4, 1); // count 2 → 词 [0,11]
		await flush();
		dragTo(input, 6, 0); // 拖到上一行（docIdx 75 列 6）——反向
		await flush();
		expect(st.mselAnchor).toEqual({ scope: "main", docIdx: 76, col: 10 }); // 锚点切到初始区间尾端（well-known [0,10]）
		expect(st.mselFocus).toEqual({ scope: "main", docIdx: 75, col: 4 }); // 按当前行词起点对齐（a/b/c.ts [4,12] 的 start）
		app.stop();
	});
	it("T6-4 连击重置：异词第二击归 1（字符锚点折叠）；超窗后同点再击也归 1", async () => {
		const { app, input } = rig(mkDoc());
		app.start();
		await flush();
		const st = app.stateRef as unknown as SelState;
		press(input, 1, 0); // "see" 第一击
		press(input, 1, 0); // count 2 → "see" 词选区
		await flush();
		press(input, 16, 0); // 同行异词（ok 的 k——x16 = doc col 14）——count 归 1 字符锚点
		await flush();
		expect(st.mselAnchor).toEqual(st.mselFocus); // 折叠锚点
		expect(st.mselAnchor).toEqual({ scope: "main", docIdx: 75, col: 14 });
		press(input, 1, 0); // 回 "see" 第一击（前一击是异词——count 从 1 起算）
		press(input, 1, 0); // 同词再击（500ms 窗口内——升 count 2）
		await flush();
		expect(st.mselAnchor).not.toEqual(st.mselFocus); // 词选区 [0,3]（anchor {75,0} ≠ focus {75,3}）
		st.lastClick = st.lastClick !== undefined ? { ...st.lastClick, at: Date.now() - 1000 } : undefined;
		press(input, 1, 0); // 超窗同词再击 → count 归 1（折叠）而非 3
		await flush();
		expect(st.mselAnchor).toEqual(st.mselFocus);
		app.stop();
	});
});

describe("URL 点击打开（m5 鼠标批 T7——渲染侧 OSC 8 自产 + 点击侧解析 + 三平台命令；只开 http/https）", () => {
	const press = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<0;${x + 1};${y + 1}M`); };
	const dragTo = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<32;${x + 1};${y + 1}M`); };
	const releaseAt = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<0;${x + 1};${y + 1}m`); };
	const mkDoc = (): string[] => {
		const d = Array.from({ length: 100 }, () => "filler");
		d[75] = "看 \x1b]8;;https://x.com/a\x07链接\x1b]8;;\x07 完"; // 模块上色行同款：渲染行含自产 OSC 8
		d[76] = "行 \x1b]8;;file:///etc/passwd\x07本地\x1b]8;;\x07 完"; // 非 http 方案
		return d;
	};

	it("T7-1 http 链接单击打开（stub 注入被调 + toast「已打开链接」）；非 http 拒开 toast", async () => {
		const opened: string[] = [];
		const { app, input } = rig(mkDoc(), 100, 30, { openUrl: async (u: string) => { opened.push(u); return true; } });
		app.start();
		await flush();
		press(input, 5, 0); // docIdx 75、屏幕列 5 = doc col 3「链」（看0-1 空格2 链3-4）
		releaseAt(input, 5, 0);
		await flush();
		expect(opened).toEqual(["https://x.com/a"]);
		expect(app.stateRef.toast?.text).toBe("已打开链接");
		press(input, 5, 1); // docIdx 76 col 3「本」——file:// 拒开
		releaseAt(input, 5, 1);
		await flush();
		expect(opened).toHaveLength(1); // 未再开
		expect(app.stateRef.toast?.text).toBe("仅支持打开 http/https 链接");
		app.stop();
	});
	it("T7-2 拖动后松开不打开（误拖保护）；双击（count 2）不探测链接", async () => {
		const opened: string[] = [];
		const { app, input } = rig(mkDoc(), 100, 30, { openUrl: async (u: string) => { opened.push(u); return true; } });
		app.start();
		await flush();
		press(input, 5, 0);
		dragTo(input, 8, 0); // 拖动即作废
		releaseAt(input, 5, 0); // 松开回原点也不开
		await flush();
		expect(opened).toHaveLength(0);
		press(input, 5, 0); // count 1（记录链接）
		press(input, 5, 0); // count 2 双击选词——不探测（kimi :1385-1390）
		releaseAt(input, 5, 0);
		await flush();
		expect(opened).toHaveLength(0); // 双击不开链接（选词语义）
		app.stop();
	});
});

describe("查看窗文本选择（m5 鼠标批 T8——T5/T6/T7 机制全复用，坐标系换查看窗盒；关窗选区整组清空）", () => {
	const press = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<0;${x + 1};${y + 1}M`); };
	const dragTo = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<32;${x + 1};${y + 1}M`); };
	const releaseAt = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<0;${x + 1};${y + 1}m`); };
	const doc100 = Array.from({ length: 100 }, (_, i) => `第${i + 1}行内容`);
	const viewBody = Array.from({ length: 80 }, (_, i) => `窗行${i + 1}内容`).join("\n");
	type SelState = { mselAnchor: { scope: string; docIdx: number; col: number } | undefined; mselFocus: { scope: string; docIdx: number; col: number } | undefined };

	it("T8-1 查看窗内拖选：提取 pu.lines 文本（非主窗 doc——同名行区分）+ toast 已复制", async () => {
		const writes: string[] = [];
		const { app, input } = rig(doc100, 100, 30, { writeClipboard: async (t: string) => { writes.push(t); return true; } });
		app.start();
		await flush();
		app.viewText("查看", viewBody, { layout: "full" }); // full：盒 row0/col0、内容行 y1 起、内衬 2 列
		await flush(80);
		press(input, 4, 1); // pu.lines[0] col 2
		dragTo(input, 10, 2); // pu.lines[1] col 8
		releaseAt(input, 10, 2);
		await flush();
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain("行1内容"); // 提取的是查看窗内容（press col 2 切掉首字窗——列语义诚实）
		expect(writes[0]).toContain("窗行2");
		expect(writes[0]).not.toContain("第76行"); // 不是主窗 doc
		expect(app.stateRef.toast?.text).toMatch(/^已复制 2 行$/);
		app.stop();
	});
	it("T8-2 查看窗选区反白渲染（boxRow 行内 inverse 段）", async () => {
		const { app, input, output } = rig(doc100);
		app.start();
		await flush();
		app.viewText("查看", viewBody, { layout: "full" });
		await flush(80);
		const before = output.buf.length;
		press(input, 4, 1);
		dragTo(input, 12, 3);
		await flush();
		expect(output.buf.slice(before)).toContain("\x1b[7m");
		app.stop();
	});
	it("T8-3 查看窗外（浮层周边主窗流区）按下仍选主窗；Esc 关窗后选区整组清空（防残留误映射下一窗）", async () => {
		const { app, input } = rig(doc100); // center80 布局：盒 row3/col10 宽80 高24——y0 是主窗流区
		app.start();
		await flush();
		app.viewText("查看", viewBody); // 缺省 center80
		await flush(80);
		press(input, 5, 0); // 盒外主窗流区（y=0 < 盒顶 3）
		await flush(80);
		const st = app.stateRef as unknown as SelState;
		expect(st.mselAnchor?.scope).toBe("main"); // 仍选主窗
		// 查看窗内建选区后关窗 → 守卫清空
		press(input, 14, 4); // 盒内（col 14-10=4、row 4-3-1=0）
		await flush(80);
		expect(st.mselAnchor?.scope).toBe("view");
		input.emit("data", "\x1b"); // Esc 关窗
		await flush(80);
		expect(st.mselAnchor).toBeUndefined(); // 关窗即清（渲染守卫）
		expect(st.mselFocus).toBeUndefined();
		app.stop();
	});
});

describe("拖选自动滚（m5 鼠标批 T9——压边缘 50ms 一格 + 指针重映射续选，kimi :1259-1312 三件套）", () => {
	const press = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<0;${x + 1};${y + 1}M`); };
	const dragTo = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<32;${x + 1};${y + 1}M`); };
	const releaseAt = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<0;${x + 1};${y + 1}m`); };
	const doc100 = Array.from({ length: 100 }, (_, i) => `第${i + 1}行内容`);
	type AutoState = { scrollBack: number; autoScrollDir: number; autoScrollTimer: NodeJS.Timeout | undefined; mselFocus: { scope: string; docIdx: number; col: number } | undefined };

	it("T9-1 拖到流区顶压边：50ms 脉冲递增 scrollBack 且选区吃进滚入的新行（指针重映射续选）", async () => {
		const { app, input } = rig(doc100);
		app.start();
		await flush();
		const st = app.stateRef as unknown as AutoState;
		press(input, 6, 10); // 流区中部起锚（docIdx 75+10=85）
		dragTo(input, 6, 0); // 压顶（y=0 ≤ 顶）——启动向上自动滚
		await flush(700); // 50ms 脉冲给 14 倍墙钟余量（满载下 setInterval 漂移——180ms 内曾只发出 1 格）
		expect(st.scrollBack).toBeGreaterThanOrEqual(3); // 50ms 一格（kimi :1283）
		expect(st.mselFocus?.scope).toBe("main");
		expect((st.mselFocus?.docIdx ?? 0)).toBeLessThan(85); // focus 随内容上滚吃进历史行（指针没动内容动了）
		releaseAt(input, 6, 0); // 松手即停
		await flush(120);
		expect(st.autoScrollTimer).toBeUndefined();
		app.stop();
	});
	it("T9-2 指针回界内停表：drag 回中部后 scrollBack 不再变", async () => {
		const { app, input } = rig(doc100);
		app.start();
		await flush();
		const st = app.stateRef as unknown as AutoState;
		press(input, 6, 10);
		dragTo(input, 6, 0);
		await flush(120); // 滚几格
		expect(st.scrollBack).toBeGreaterThan(0);
		dragTo(input, 6, 10); // 回界内
		await flush(20);
		expect(st.autoScrollTimer).toBeUndefined(); // 停表
		const frozen = st.scrollBack;
		await flush(150);
		expect(st.scrollBack).toBe(frozen); // 不再动
		app.stop();
	});
	it("T9-3 滚到头自停：scrollBack 逼近 maxScroll 后脉冲钳制不变即清定时器", async () => {
		const { app, input } = rig(doc100);
		app.start();
		await flush();
		const st = app.stateRef as unknown as AutoState;
		st.scrollBack = 74; // maxScroll = 101−26 = 75——一格到顶
		press(input, 6, 10);
		dragTo(input, 6, 0); // 压顶继续向上
		await flush(600); // 50ms 脉冲给 12 倍余量（满载漂移下 150ms 内曾未滚到头，钳制未触发、定时器悬挂）
		expect(st.scrollBack).toBe(75); // 恰到顶
		expect(st.autoScrollTimer).toBeUndefined(); // 钳制不变即自停（无悬挂句柄）
		app.stop();
	});
});

describe("滚动条（m5 鼠标批 T10——主窗/查看窗右缘轨道+拇指，超一屏才显示，点轨道跳位 + 拖动跟手）", () => {
	const press = (input: FakeInput, x: number, y: number): void => { input.emit("data", `[<0;${x + 1};${y + 1}M`); };
	const dragTo = (input: FakeInput, x: number, y: number): void => { input.emit("data", `[<32;${x + 1};${y + 1}M`); };
	const releaseAt = (input: FakeInput, x: number, y: number): void => { input.emit("data", `[<0;${x + 1};${y + 1}m`); };
	const doc100 = Array.from({ length: 100 }, (_, i) => `第${i + 1}行内容`);

	it("T10-1 thumbGeometry 纯函数：不超一屏 undefined；超屏拇指高 ≥2 且四则位置正确", async () => {
		const { thumbGeometry } = await import("./fullapp.ts");
		expect(thumbGeometry(26, 20, 0)).toBeUndefined(); // 总 20 ≤ 视口 26——不显示
		expect(thumbGeometry(14, 16, 0)!.height).toBe(7); // 半轨上限（2026-09-27 用户走查）：略超一屏比例值 12 钳到 7——满轨拇指看不出位置
		expect(thumbGeometry(26, 52, 0)!.height).toBe(13); // 恰两屏 = 上限临界（比例值恰等于半轨，钳而不改）
		const g = thumbGeometry(26, 101, 75)!; // 101 行 26 视口、首行 75（末页）
		expect(g.height).toBeGreaterThanOrEqual(2); // 最小高 2（kimi layout.ts:288）
		expect(g.height).toBeLessThanOrEqual(26);
		expect(g.top).toBe(26 - g.height); // 末页拇指贴底
		const top = thumbGeometry(26, 101, 0)!;
		expect(top.top).toBe(0); // 首页贴顶
		const mid = thumbGeometry(26, 101, 38)!; // 37.5 → round(75/75×(26-h)) ≈ 中部
		expect(mid.top).toBeGreaterThan(0);
		expect(mid.top).toBeLessThan(26 - mid.height);
	});
	it("T10-2 主窗渲染右缘出现拇指（█）且位置随 scrollBack 移动", async () => {
		const { app, input, output } = rig(doc100);
		app.start();
		await flush();
		let before = output.buf.length;
		input.emit("data", "[5~"); // PgUp → scrollBack = 20（拇指离顶）
		await flush();
		let frame = stripAnsi(output.buf.slice(before));
		expect(frame).toContain("█"); // 拇指出现在主窗右缘
		before = output.buf.length;
		input.emit("data", "[5~"); // 再翻 → 拇指移动
		await flush();
		frame = stripAnsi(output.buf.slice(before));
		expect(frame).toContain("█");
		app.stop();
	});
	it("T10-3 查看窗右缘同款滚动条", async () => {
		const { app, output } = rig(doc100);
		app.start();
		await flush();
		const before = output.buf.length;
		app.viewText("查看", Array.from({ length: 80 }, (_, i) => `窗行${i + 1}`).join("\n"), { layout: "full" });
		await flush(80); // 首帧即含滚动条（80 行 > 27 页）
		const frame = stripAnsi(output.buf.slice(before));
		expect(frame).toContain("█");
		app.stop();
	});
	it("T10-4 点轨道跳位：press 在轨道下半 → scrollBack 按比例变化（拇指中心跳到指针行）", async () => {
		const { app, input } = rig(doc100);
		app.start();
		await flush();
		const st = app.stateRef as unknown as { scrollBack: number };
		const trackX = 65 - 1; // leftW = 100−34−1 = 65（分隔线列并入——2026-09-27）→ 轨道列 64
		press(input, trackX, 10); // 点轨道第 10 行（非拇指区——初始拇指贴底 19-25）
		await flush();
		expect(st.scrollBack).toBeGreaterThan(0); // 跳位：拇指中心跳到指针行 → first ≈ 26 → scrollBack ≈ 49
		expect(st.scrollBack).toBeLessThanOrEqual(75);
		releaseAt(input, trackX, 10);
		await flush();
		app.stop();
	});
	it("T10-6 文字与滚动条间距（2026-09-27 用户走查：文字离滚动条多空一个字的距离）：拇指/轨道行中 █/│ 前恒 ≥2 空格（一个全角字 = 2 列）", async () => {
		const { app, input, output } = rig(doc100);
		app.start();
		await flush();
		input.emit("data", "[5~"); // PgUp → 滚动条出现
		await flush();
		const text = stripAnsi(output.buf);
		// 拇指形态断言：滚动条拇指行 = █ + 侧栏分隔线（█ 紧跟 │）——前 2 字符恒空格（设计间距 1 列
		// 〔2026-09-27 走查两轮定稿：一个字收窄〕+ 前面 pad 补齐空格——文字永不贴轨道且 pad 逻辑
		// 坏掉也能抓住）；面板「上下文」进度条的 █▊ 形态不同不误伤，轨道 │ 由同一行实现保证
		let thumbRows = 0;
		for (const l of text.split("\n")) {
			for (const m of l.matchAll(/█│/g)) {
				const i = m.index ?? 0;
				thumbRows++;
				if (i >= 2) expect(l.slice(i - 2, i)).toBe("  ");
			}
		}
		expect(thumbRows).toBeGreaterThan(0); // 确认拇指真的渲染了（上面循环非空转）
	});
	it("T10-7 满宽汉字行行宽恒齐（2026-09-27 用户走查打回：截断点落汉字中间时行超 1 列——分隔线/滚动条逐行错开 1 列的界面错乱根因）：拇指列 index 全部相同", async () => {
		const wide = Array.from({ length: 100 }, () => "字".repeat(40)); // 80 列满宽汉字行——每行都触发跨界截断
		const { app, input, output } = rig(wide);
		app.start();
		await flush();
		input.emit("data", "[5~"); // PgUp → 滚动条出现
		await flush();
		// output.buf 是行级 diff 增量流（无换行符）——按光标定位序列 \x1b[{r};1H\x1b[2K 切出渲染行
		// eslint-disable-next-line no-control-regex -- 终端断言正则按形态写（\x1b 控制序列是断言对象本身）
		const parts = output.buf.split(/\x1b\[\d+;1H\x1b\[2K/);
		const idxes = new Set<number>();
		for (const seg of parts.slice(1)) {
			// 拇指位置按显示列比较（stripAnsi 字符序对宽字符行不可比——汉字 1 字符 2 列）
			const plain = stripAnsi(seg);
			for (const mm of plain.matchAll(/█│/g)) idxes.add(visibleWidth(plain.slice(0, mm.index ?? 0)));
		}
		expect(idxes.size).toBe(1); // 拇指列恒定 = 所有流区行同宽（含滚动条版行）
		app.stop();
	});
	it("T10-5 拖动跟手：drag 沿轨道下移两步 → scrollBack 单调增；release 清拖动态", async () => {
		const { app, input } = rig(doc100);
		app.start();
		await flush();
		const st = app.stateRef as unknown as { scrollBack: number; scrollbarDrag: unknown };
		const trackX = 64; // 轨道列 = leftW−1 = 64（leftW 65——分隔线退役后左栏扩 1 列）
		press(input, trackX, 13); // 点轨道中部跳位（非拇指区）
		await flush();
		const s1 = st.scrollBack;
		dragTo(input, trackX, 8); // 上移 → 回看更深（start 减 = scrollBack 增）
		await flush();
		const s2 = st.scrollBack;
		dragTo(input, trackX, 2);
		await flush();
		const s3 = st.scrollBack;
		expect(s2).toBeGreaterThan(s1); // 拖动跟手单调
		expect(s3).toBeGreaterThan(s2);
		releaseAt(input, trackX, 2);
		await flush();
		expect(st.scrollbarDrag).toBeUndefined();
		app.stop();
	});
	it("T10-9 查看窗恒宽 + 轨道实心化（2026-09-27 用户走查二轮：dim │ 字形虚线与右边框虚线交叠成锯齿——「画歪了」）：行宽恒等、轨道列无细竖线", async () => {
		const { app, output } = rig(["占位"]);
		app.start();
		await flush();
		const before = output.buf.length;
		const lines = [`${"汉".repeat(200)}`, `${"x".repeat(300)}`, ...Array.from({ length: 60 }, (_, i) => `短行${i}`)];
		app.viewText("压缩摘要", lines.join("\n"), { layout: "full" });
		await flush(80);
		// 行级 diff 增量流按光标定位序列切行（T10-7 同口径）——full 弹窗 100 列 rig → 行宽恒 99
		// eslint-disable-next-line no-control-regex -- 终端断言正则按形态写（\x1b 控制序列是断言对象本身）
		const parts = output.buf.slice(before).split(/\x1b\[\d+;1H\x1b\[2K/).slice(1);
		const rows = parts.map((p) => stripAnsi(p)).filter((l) => visibleWidth(l) === 99);
		let contentRows = 0;
		let thumbSeen = false;
		for (const l of rows) {
			if (l.endsWith("╮") || l.endsWith("╯")) continue; // 顶框/底框
			expect(l.endsWith("│")).toBe(true);
			expect(l).not.toMatch(/│ ││$/); // 轨道列不再画细竖线（实心底格或 █）——两列虚线锯齿根除
			contentRows++;
			if (l.endsWith("█│")) thumbSeen = true;
		}
		expect(contentRows).toBeGreaterThan(20); // 内容行真的切出来了
		expect(thumbSeen).toBe(true); // 拇指照常渲染
		app.stop();
	});
});

describe("toast 定时器令牌化（CTU-03 回归钉 2026-09-28——旧实现每 toast 新建 setTimeout 从不清理，旧定时器按闭包旧时长做龄检：新 toast 在旧 toast 顶替后 200ms 内创建即被旧定时器按旧时长误消。实测：A@1000ms 后 ~100ms 顶上 B@8000ms，B 于 ~1007ms 被 A 的旧定时器杀，应活 8s——混时长来源 ui.notice → session-tree 8000ms notice 真实存在）", () => {
	it("① 短 toast 顶替后长 toast 不被旧定时器误消：A@1000 顶上 B@8000，越过 A 的触发点 B 仍在", async () => {
		const { app } = rig();
		app.start();
		await flush();
		app.showToast("A", 1000);
		await flush(60); // 60ms 后顶替（落在 200ms 误消窗口内）
		app.showToast("B", 8000);
		await flush(1150); // 越过 A 定时器触发点（1000 + 100）
		expect(app.stateRef.toast?.text).toBe("B"); // 旧实现：B 在 ~1007ms 被误消（toast === undefined）
		app.stop();
	});
	it("② 自消路径不受令牌影响：短 toast 到时自清（身份相符照常消）", async () => {
		const { app } = rig();
		app.start();
		await flush();
		app.showToast("自消", 1000);
		await flush(1250);
		expect(app.stateRef.toast).toBeUndefined();
		app.stop();
	});
});

describe("输入区宽度口径统一 width.ts（CTU-04 回归钉 2026-09-28——旧私有 cpw 按首码点区间计宽，与 grapheme/EAW 权威在四类样本分歧：❤️ 3/2、谚文 Jamo ᄀ 1/2、ZWJ 家族 👨‍👩‍👧 8/2、tab 1/3。折行/列回映射用 cpw、光标列用 visibleWidth → 折行点错、硬件光标列与编辑点错位。修复：layoutInputRows/locateCursor/indexAtRowCol 三口一源走 graphemeSpans）", () => {
	it("① VS16 emoji：❤️×5 在 8 列折 4+1 两行（❤️ 实宽 2；旧 cpw 计 3 → 提前折 2+2+1 三行）、光标列按 2 累计", () => {
		const rows = layoutInputRows("❤️".repeat(5), 8);
		expect(rows.map((r) => r.text)).toEqual(["❤️".repeat(4), "❤️"]);
		expect(locateCursor(rows, 10)).toEqual({ row: 1, col: 2 }); // 行尾光标 = 1 个 ❤️ = 2 列
	});
	it("② 谚文 Jamo（macOS 韩文文件名 NFD 粘贴即中）：单字宽 2（旧 cpw 计 1），夹 ASCII 时 4 列折「aᄀbᄁ」→「aᄀb | ᄁ」（旧计 4 全进一行 → 显示宽 6 超框被截）", () => {
		const rows = layoutInputRows("aᄀbᄁ", 4);
		expect(rows.map((r) => r.text)).toEqual(["aᄀb", "ᄁ"]);
		expect(locateCursor(rows, 2)).toEqual({ row: 0, col: 3 }); // a(1) + ᄀ(2) = 3 列（旧 cpw 口径 2）
	});
	it("③ ZWJ 家族 emoji：👨‍👩‍👧 整体一个 grapheme 宽 2（旧 cpw 按码点计 8）；列回映射不落进家族内部", () => {
		const rows = layoutInputRows("👨‍👩‍👧x", 8);
		expect(rows).toHaveLength(1);
		expect(locateCursor(rows, 8)).toEqual({ row: 0, col: 2 }); // 光标在 x 前 = 列 2（旧 8）
		expect(indexAtRowCol(rows, 0, 1)).toBe(0); // 目标列 1 落家族左半格 → 回映射停在家族起点
	});
	it("④ tab 宽 3（旧 cpw 计 1）：a\\tb 在 3 列折 a | \\t | b 三行；单行内 tab 后光标列 = 前文 + 3", () => {
		const rows = layoutInputRows("a\tb", 3);
		expect(rows.map((r) => r.text)).toEqual(["a", "\t", "b"]); // 旧 cpw：3 码元全进一行，终端渲染 5 列超框
		expect(locateCursor(rows, 1)).toEqual({ row: 1, col: 0 }); // 非末行行尾 → 下行行首（折行边界语义保留）
		const wide = layoutInputRows("ab\tc", 8); // 6 列不折行
		expect(wide.map((r) => r.text)).toEqual(["ab\tc"]);
		expect(locateCursor(wide, 3)).toEqual({ row: 0, col: 5 }); // a+b+tab = 5 列（旧 cpw 折行口径 3）
	});
	it("⑤ locateCursor ↔ indexAtRowCol 互逆：grapheme 边界偏移列→码元→列 roundtrip 不丢（↑↓ 行间移动目标列同口径）", () => {
		const input = "ab❤️ᄀcd\nxy👨‍👩‍👧z\tw";
		const rows = layoutInputRows(input, 8);
		for (const off of [0, 1, 2, 4, 5, 6, 8, 9, 10, 18, 20]) {
			const loc = locateCursor(rows, off);
			expect(indexAtRowCol(rows, loc.row, loc.col), `offset ${off}`).toBe(off);
		}
	});
	it("⑥ 集成：谚文 Jamo 夹 ASCII（显示宽 15）在 innerW=8 窄栏折两行全可见（旧 cpw 计 10 → 折点错、首行显示宽 12 超 8 列预算被截、ᄃ 不上屏）", async () => {
		const { app, output } = rig(["# hi"], 18, 30); // sidebarW=5 → leftW=12 → 输入行预算 innerW=8
		app.start();
		await flush();
		app.insertAtCursor("ᄀaᄁaᄂaᄃaᄅa");
		await flush();
		expect(stripAnsi(output.buf)).toContain("ᄃ"); // 旧实现：首行截到 8 列（ᄀaᄁaᄂ），ᄃ 被截掉
		app.stop();
	});
});

describe("选区切片消费方（CTW-03 回归钉 2026-09-28——sliceByColumn 左跨界宽字符双端计入 + 起点前 SGR 丢失，消费方 styleDocSelection 三段反白 / selectionText 提取）", () => {
	type SelState = { mselAnchor: { scope?: "main" | "view"; docIdx: number; col: number } | undefined; mselFocus: { scope?: "main" | "view"; docIdx: number; col: number } | undefined };
	it("① 拖选起点落在汉字后半格：提取文本不含该字（严格语义整字让位，不双端计入——旧相交语义同一「汉」进提取段）", async () => {
		const { app } = rig(["汉abcdef"]);
		app.start();
		await flush();
		const st = app.stateRef as unknown as SelState;
		const sel = (app as unknown as { selectionText(): string | undefined }).selectionText.bind(app);
		st.mselAnchor = { scope: "main", docIdx: 0, col: 1 }; // 汉 [0,2) 的后半格
		st.mselFocus = { scope: "main", docIdx: 0, col: 8 }; // 行尾（行宽 8）
		expect(sel()).toBe("abcdef"); // 旧：相交语义把汉计入 → "汉abcdef"
		app.stop();
	});
	it("② 反白 mid 段带切点前着色：\\x1b[7m 后紧跟切点前的 \\x1b[31m（旧实现 mid 丢色，反白段回默认前景）", async () => {
		const { app, input, output } = rig(["\x1b[31m汉abcdef\x1b[39m"]);
		app.start();
		await flush();
		const before = output.buf.length;
		input.emit("data", "\x1b[<0;6;1M"); // 按下 x=5 → col 3（汉 [2,4) 后半格 + 左内衬 2）
		input.emit("data", "\x1b[<32;9;1M"); // 拖到 x=8 → col 6：mid = bcd、right = ef（行中收尾，right 有内容）
		await flush();
		const frame = output.buf.slice(before);
		expect(frame).toContain("\x1b[7m\x1b[31m"); // 反白段自带切点前红色（旧："\x1b[7mb" 直接裸字掉色）
		expect(frame).toContain("\x1b[7m\x1b[31mbcd"); // mid = b..d，色在字前
		expect(frame).toContain("\x1b[27m\x1b[31mef"); // right 段同样回放切点前样式（overlay 合成 after 段同机制）
		app.stop();
	});
});

describe("查看窗自定义键内容替换的滚动语义（走查⑥ 2026-09-29 改钉——用户报「折叠键按完直接置顶」；旧 CTU-06 钉的「替换即回顶」承诺被推翻：学 kimi agent-activity-viewer ctrl+o 折叠切换不动滚动、followTail 贴底窗继续贴底）", () => {
	it("bottom 窗（pinned）自定义键返回新文本：替换后保持贴底（末页可见、首行不可见——折叠/刷新不顶飞视口）", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		const oldText = Array.from({ length: 50 }, (_, i) => `旧行${i + 1}`).join("\n");
		const fresh = ["首行甲", ...Array.from({ length: 40 }, (_, i) => `中行${i}`), "末行乙"].join("\n");
		app.viewText("贴底窗", oldText, { bottom: true, keys: { r: { label: "刷新", run: () => fresh } } });
		await flush();
		expect(stripAnsi(output.buf)).toContain("旧行50"); // pinned 初值贴底——末页可见
		input.emit("data", "r"); // 自定义键整窗替换（新文本同样超一页）
		await flush();
		const b = stripAnsi(output.buf);
		expect(b).toContain("末行乙"); // 贴底保持（followTail 语义）
		expect(b).not.toContain("首行甲"); // 不回顶
		app.stop();
	});
	it("普通窗自定义键返回新文本：scroll 保持、仅钳到新范围（内容变短超界才动）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		const long = Array.from({ length: 60 }, (_, i) => `行${i}`).join("\n");
		const short = ["甲", "乙", "丙"].join("\n");
		app.viewText("普通窗", long, { keys: { r: { label: "换短", run: () => short } } });
		await flush();
		// 滚到中部（非顶部非底部）
		const pu0 = (app as unknown as { pendingUi: { scroll: number } }).pendingUi;
		pu0.scroll = 30;
		app.repaint();
		await flush();
		input.emit("data", "r"); // 替换为 3 行短文本——scroll=30 超界钳到 0
		await flush();
		expect((app as unknown as { pendingUi: { scroll: number; text: string } }).pendingUi.scroll).toBe(0); // 钳到范围内（3 行窗 max=0）
		app.stop();
	});
});

describe("promptInput 草稿恢复对称（CTU-07 回归钉 2026-09-28——Esc 取消恢复接管前草稿、Enter 结算却清空：busy 期答完模块询问回来草稿无声消失。统一为两路径都恢复）", () => {
	it("① Enter 提交答案后接管前草稿回输入框（旧实现此处为空串）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "正在写的草稿");
		await flush();
		const answered = app.promptInput("补充理由", false);
		await flush();
		expect(app.stateRef.input).toBe(""); // 接管期清空（答案输入位）
		input.emit("data", "答");
		await flush();
		input.emit("data", "\r"); // Enter 结算
		await flush();
		await expect(answered).resolves.toBe("答");
		expect(app.stateRef.input).toBe("正在写的草稿"); // 草稿恢复（与 Esc 对称）
		app.stop();
	});
	it("② Esc 取消恢复草稿（既有行为——钉住不回归）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "草稿X");
		await flush();
		const canceled = app.promptInput("问", false);
		await flush();
		input.emit("data", "\x1b");
		await flush();
		await expect(canceled).resolves.toBeUndefined();
		expect(app.stateRef.input).toBe("草稿X");
		app.stop();
	});
});

describe("pickOverlay 重复文本项索引（CTU-08 回归钉 2026-09-28——Enter 结算 indexOf 按值回查拿首个同值项而非实际选中项；choose 是模块契约面、契约未禁止重复项。修复 = 过滤携带原始索引按引用结算）", () => {
	it("① 两同值项：↓ 到第二项 Enter → resolve 1（旧实现恒 0）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		const picked = app.pickOverlay("选", ["同值", "同值"]);
		await flush();
		input.emit("data", "\x1b[B"); // ↓ 第二项
		await flush();
		input.emit("data", "\r");
		await expect(picked).resolves.toBe(1);
		app.stop();
	});
	it("② 过滤态同理（≥12 项启用过滤——过滤后索引仍指原清单位次）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		const items = ["甲", ...Array.from({ length: 10 }, (_, i) => `备${i}`), "甲"]; // 12 项 → 过滤激活
		const picked = app.pickOverlay("选", items);
		await flush();
		input.emit("data", "甲"); // 过滤串
		await flush();
		input.emit("data", "\x1b[B"); // ↓ 第二个甲（原索引 11）
		await flush();
		input.emit("data", "\r");
		await expect(picked).resolves.toBe(11); // 旧实现：indexOf("甲") 恒回 0
		app.stop();
	});
});

describe("弹窗/面板标题与模块名源头截断（CTU-09 回归钉 2026-09-28——模块/用户供给的超长标题与模块名原靠 padToWidth 兜底，右框角 ╮ 与行尾状态字被切；七个拼行点源头 visibleWidth 截断）", () => {
	/** 顶框行判据：剥 ANSI 后显示宽 ≤ 框宽且右端收 ╮（截断发生在标题内，不在框角）。 */
	const topOk = (line: string, w: number): boolean => visibleWidth(stripAnsi(line)) <= w && stripAnsi(line).endsWith("╮");
	it("① viewText 超长标题：顶框行宽收在框宽内（诊断二级「模块诊断 · 名」同路）", async () => {
		const { app } = rig();
		app.start();
		await flush();
		app.viewText("题".repeat(200), "内容");
		await flush();
		const pu = (app as unknown as { pendingUi: unknown }).pendingUi;
		const ov = (app as unknown as { buildViewOverlay(pu: unknown): { lines: string[]; width: number } }).buildViewOverlay(pu);
		expect(topOk(ov.lines[0]!, ov.width)).toBe(true); // 旧实现：顶框行 ≈ 207 列远超 79
		app.stop();
	});
	it("② 控件窗超长标题同款", async () => {
		const { app } = rig();
		app.start();
		await flush();
		app.openDialog({ title: "题".repeat(200), widgets: [{ id: "q", kind: "input" }] });
		await flush();
		const pu = (app as unknown as { pendingUi: unknown }).pendingUi;
		const ov = (app as unknown as { buildDialogOverlay(pu: unknown): { lines: string[]; width: number } }).buildDialogOverlay(pu);
		expect(topOk(ov.lines[0]!, ov.width)).toBe(true);
		app.stop();
	});
	it("③ pick 超长标题同款（过滤段在场）", async () => {
		const { app } = rig();
		app.start();
		await flush();
		const ov = (app as unknown as { buildPickOverlay(leftW: number, divRow: number, title: string, items: string[], sel: number, filter?: string): { lines: string[]; width: number } })
			.buildPickOverlay(60, 20, "题".repeat(200), ["a"], 0, "词");
		expect(topOk(ov.lines[0]!, ov.width)).toBe(true);
		app.stop();
	});
	it("④ 斜杠菜单二级超长命令名同款（overlayCmd 是用户输入）", async () => {
		const { app } = rig();
		app.start();
		await flush();
		app.stateRef.overlayOpen = true;
		app.stateRef.overlayCmd = "/" + "题".repeat(100);
		const ov = (app as unknown as { buildOverlay(leftW: number, divRow: number): { lines: string[]; width: number } }).buildOverlay(60, 20);
		expect(topOk(ov.lines[0]!, ov.width)).toBe(true);
		app.stop();
	});
	it("⑤ 模块卡超长 title：panelBox 顶框行宽收在面板宽内", async () => {
		const { app } = rig(["# hi"], 100, 30, {
			panelData: () => ({ ...defaultPanelData(), cards: [{ area: "top", order: 0, title: "题".repeat(60), widgets: [] }] }),
		});
		app.start();
		await flush();
		app.stateRef.statePage = 2; // 翻到 top 模块卡页
		const rows = (app as unknown as { statusRows(w: number, h: number): string[] }).statusRows(34, 16);
		expect(visibleWidth(stripAnsi(rows[0]!))).toBeLessThanOrEqual(34); // 旧实现：标题 122 列把行顶爆
		expect(stripAnsi(rows[0]!).endsWith("╮")).toBe(true);
		app.stop();
	});
	it("⑥ 超长模块名：行尾状态字不被挤掉（截断发生在名字内）", async () => {
		const { app } = rig(["# hi"], 100, 30, {
			panelData: () => ({ ...defaultPanelData(), modules: [{ name: "巨".repeat(60), desc: "", state: "mounted" }] }),
		});
		app.start();
		await flush();
		const rows = (app as unknown as { statusRows(w: number, h: number): string[] }).statusRows(34, 16);
		const row = rows.find((r) => stripAnsi(r).includes("巨"));
		expect(row).toBeDefined();
		expect(stripAnsi(row!)).toContain("已挂载"); // 旧实现：120 列名字把状态字顶出内宽、padToWidth 截掉
		app.stop();
	});
});

describe("控件窗 input 编辑器代理对（CTU-10 回归钉 2026-09-28——退格/左右移原按 UTF-16 码元步进，非 BMP 字符被割裂成孤立代理；对齐主编辑器整对处理）", () => {
	type DialogPu = { inputById: Record<string, { text: string; cursor: number }> };
	const puOf = (app: FullApp): DialogPu => (app as unknown as { pendingUi?: DialogPu }).pendingUi!;
	it("① 退格整对删 emoji：事件回传无孤立高代理", async () => {
		const events: string[] = [];
		const { app, input } = rig();
		app.start();
		await flush();
		app.openDialog({
			title: "表单",
			widgets: [{ id: "q", kind: "input" }],
			onEvent: (e) => { if (e.type === "input") events.push(JSON.stringify(e.text)); },
		});
		await flush();
		puOf(app).inputById["q"] = { text: "a😀", cursor: 3 };
		input.emit("data", "\x7f"); // 退格删 emoji
		await flush();
		expect(events).toEqual([JSON.stringify("a")]); // 旧实现：text 变 "a\ud83d"（孤立高代理）
		app.stop();
	});
	it("② 左右移按码点跨越代理对（光标不落 emoji 内部）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		app.openDialog({ title: "表单", widgets: [{ id: "q", kind: "input" }] });
		await flush();
		puOf(app).inputById["q"] = { text: "a😀b", cursor: 4 };
		input.emit("data", "\x1b[D"); // left：b 前 → 3
		input.emit("data", "\x1b[D"); // left：跨过 emoji → 1（旧实现：2 落进代理对中间）
		await flush();
		expect(puOf(app).inputById["q"]!.cursor).toBe(1);
		puOf(app).inputById["q"]!.cursor = 1;
		input.emit("data", "\x1b[C"); // right：跨过 emoji → 3（旧实现：2 落进中间）
		await flush();
		expect(puOf(app).inputById["q"]!.cursor).toBe(3);
		app.stop();
	});
});

describe("renderFrame 帧级错误边界（CTU-12 回归钉 2026-09-28——主渲染帧每帧现调宿主回调 io.doc/panelData/queueItems 无防护：异常沿 scheduler 定时器/nextTick 逃逸 uncaughtException 杀进程。对照 fireDialogEvent/renderModuleCard 全局约束 4 同款降级为帧级）", () => {
	it("io.doc() 抛错：logWarn + 占位错误帧，进程不死、宿主恢复后下一帧即回", async () => {
		const logs: string[] = [];
		let boom = true;
		const { app, output } = rig(["恢复后的内容"], 100, 30, {
			docTotal: () => { if (boom) throw new Error("宿主 doc 炸了"); return 1; },
			docWindow: (): string[] => { if (boom) throw new Error("宿主 doc 炸了"); return ["恢复后的内容"]; },
			logWarn: (code) => logs.push(code),
		});
		app.start();
		await flush(); // 首帧即抛（immediate 渲染路径）
		expect(logs).toContain("tui.render.frame-error");
		expect(stripAnsi(output.buf)).toContain("渲染出错"); // 占位帧（旧实现：uncaughtException 直接炸测试进程）
		boom = false;
		await flush(1100); // 1s 心跳重绘驱动下一帧——宿主恢复即回
		expect(stripAnsi(output.buf)).toContain("恢复后的内容");
		app.stop();
	});
});

describe("fullapp 窗口化行源 + 侧栏护栏（m5-render-perf T5——D8 定案两道护栏 + 契约加宽）", () => {
	const bigDoc = Array.from({ length: 200 }, (_, i) => `行 ${String(i).padStart(3, "0")} · 唯一标记 m${i}x`);

	it("① 整帧等价：窗口行源拼屏行序正确（scrollBack=0 尾部跟随 / 中部滚动两态——标记有序覆盖验证 start 换算）", async () => {
		// 窗口化后屏行 = doc[r]（窗口局部下标，窗口从 start 起）——若 start 换算错位/漏行，
		// 下列「标记按行序严格递增出现在写流」断言必红（每行唯一标记 m<N>x）。
		// streamH = 30 −（1+3）− 0 = 26；total = 200 + 尾行 1 = 201。
		const assertOrdered = (frame: string, from: number, to: number): void => {
			let last = -1;
			for (let i = from; i <= to; i++) {
				const p = frame.indexOf(`m${i}x`);
				expect(p, `行 ${i} 的标记应在屏上且晚于前行`).toBeGreaterThan(last);
				last = p;
			}
		};
		// 跟随（scrollBack=0）：首帧即尾部 26 行（175-200 为尾行让位——尾行 200 是 tailLine；175..199 为 doc 行）
		const follow = rig(bigDoc, 100, 30, { docTotal: () => bigDoc.length, docWindow: (s, c) => bigDoc.slice(s, s + c) });
		follow.app.start();
		await flush();
		follow.app.stop();
		assertOrdered(stripAnsi(follow.output.buf), 175, 199);
		// 中部滚动（scrollBack=120）：start = 201 − 120 − 26 = 55 → 55..80
		const mid = rig(bigDoc, 100, 30, { docTotal: () => bigDoc.length, docWindow: (s, c) => bigDoc.slice(s, s + c) });
		mid.app.start();
		await flush();
		mid.app.stateRef.scrollBack = 120;
		mid.app.repaint();
		await flush();
		mid.app.stop();
		const midFrame = stripAnsi(mid.output.buf);
		assertOrdered(midFrame, 55, 80);
		expect(midFrame).not.toContain("m081x"); // 窗口精确到 start+streamH−1：越界行不上屏
		// 窗口请求量被钳制：docWindow 收到的 count ≤ streamH×2（视口余量 #6）且 start 与滚动位置一致
		const calls: Array<{ s: number; c: number }> = [];
		const probe = rig(bigDoc, 100, 30, {
			docTotal: () => bigDoc.length,
			docWindow: (s, c) => {
				calls.push({ s, c });
				return bigDoc.slice(s, s + c);
			},
		});
		probe.app.start();
		await flush();
		probe.app.stop();
		expect(calls.length).toBeGreaterThan(0);
		for (const { s, c } of calls) {
			expect(c).toBeLessThanOrEqual(26 * 2); // 每帧物化行数 ≤ 视口 ×2
			expect(s).toBeGreaterThanOrEqual(0);
		}
	});

	it("② 宽度变化后几何立即精确：DocModel 真例行源 + setSidebar 切换——dmTotal == 新宽全量长度、滚动钳制无混合态", async () => {
		const { DocModel } = await import("./docmodel.ts");
		const dm = new DocModel();
		for (let i = 0; i < 60; i++) dm.pushLine(`历史行 ${i} ${"内容".repeat(i % 20)}`); // 多宽度敏感行
		const w = (): number => 96; // 简化：dm 按 96 折行（窗口化只验几何链路——宽度重折本身 T4 ②已钉）
		const { app } = rig([], 100, 30, {
			docTotal: () => dm.totalLines(w()),
			docWindow: (s, c) => dm.frameWindow(w(), s, c),
		});
		app.start();
		await flush();
		app.stateRef.scrollBack = 5;
		app.setSidebar(false); // 宽度变化（左栏变宽）——护栏下正常切换
		await flush(600); // 冷却余量
		// 几何恒精确：fullapp 侧总长 = dm.totalLines + 尾行 1，与新宽全量一致（无混合计数）
		const dmN = dm.totalLines(w());
		const probe = app.stateRef.scrollBack;
		expect(probe).toBeLessThanOrEqual(Math.max(0, dmN + 1 - (30 - 8))); // 钳制按新几何（streamH≈rows-inputH）
		expect(dm.frameWindow(w(), 0, 1_000_000).length).toBe(dmN); // 窗口全量 == totalLines（自洽）
		app.stop();
	});

	it("③ busy 期双口被拒：Ctrl+T 键路 toast、setSidebar 返回 false；非 busy 期正常切换", async () => {
		const { app, input, output } = rig(["# hi"], 100, 30);
		app.start();
		await flush();
		app.setBusy(true);
		await flush();
		input.emit("data", "\x14"); // Ctrl+T
		await flush();
		expect(app.stateRef.sidebarVisible).toBe(true); // 没切
		expect(stripAnsi(output.buf)).toContain("生成中不能切换侧栏"); // toast 文案（设计空白 #9）
		expect(app.setSidebar(false)).toBe(false); // 模块路径：明确拒绝
		expect(app.stateRef.sidebarVisible).toBe(true);
		app.setBusy(false);
		await flush(600); // 冷却无关（busy 期未成功切换过）——直接切
		expect(app.setSidebar(false)).toBe(true); // 非 busy 正常
		expect(app.stateRef.sidebarVisible).toBe(false);
		app.stop();
	});

	it("④ 500ms 冷却：第二次切换被吞、超过冷却恢复；幂等短路返回 true（契约定值）", async () => {
		const changes: boolean[] = [];
		const { app } = rig(["# hi"], 100, 30, { onSidebarChange: (v) => changes.push(v) });
		app.start();
		await flush();
		expect(app.setSidebar(false)).toBe(true); // 成功
		expect(app.setSidebar(true)).toBe(false); // 冷却吞
		expect(app.setSidebar(false)).toBe(true); // 幂等短路 = 已在目标态亦 true（无事可做即已达成）
		expect(changes).toEqual([false]); // 幂等不再回调
		await flush(600);
		expect(app.setSidebar(true)).toBe(true); // 过冷却恢复
		expect(changes).toEqual([false, true]);
		app.stop();
	});
});

describe("主窗滚动钉住（m5-render-perf 真机走查①修——流式增长不顶走已上滚的视口）", () => {
	it("上滚后内容增长：视口起点不动（正读的行钉住）、新尾部不闯入；跟随模式（scrollBack=0）照旧自动滚", async () => {
		let docLines = Array.from({ length: 50 }, (_, i) => `行 ${String(i).padStart(3, "0")} · 标记 m${i}x`);
		const { app, output } = rig(docLines, 100, 30, {
			docTotal: () => docLines.length,
			docWindow: (s, c) => docLines.slice(s, s + c),
		});
		app.start();
		await flush();
		app.stateRef.scrollBack = 10; // 用户上滚脱钉
		app.repaint();
		await flush();
		const before = output.buf.length;
		docLines = [...docLines, ...Array.from({ length: 30 }, (_, i) => `新尾部 ${i} · 标记 new${i}x`)]; // 流式增长 30 行
		app.repaint();
		await flush();
		const frame = stripAnsi(output.buf.slice(before));
		// 视口起点不动（diff 更新帧只重写变化行——钉住的证据 = scrollBack 补偿精确 + 视口外行不闯入）
		expect(app.stateRef.scrollBack).toBe(40); // 10 + 30：钉住补偿精确（start 恒 ≈ 15）
		expect(frame).not.toContain("m048x"); // 无补偿时视口会被顶到 [45,71)——该段行不出现
		expect(frame).not.toContain("new0x"); // 新尾部不闯入视口
		// 跟随模式：滚回底部（scrollBack=0）再增长 → 自动滚（新尾部进视口）
		app.stateRef.scrollBack = 0;
		app.repaint();
		await flush();
		docLines = [...docLines, "最新一行 · 标记 newest"];
		app.repaint();
		await flush();
		expect(stripAnsi(output.buf)).toContain("newest");
		app.stop();
	});

	it("走查⑦统一补偿：尾部收缩也钉住（start 保持）；头部平移（滑窗裁剪形，经 docHeadShift 差分）不补", async () => {
		let docLines = Array.from({ length: 50 }, (_, i) => `行 ${i} · s${i}x`);
		let headShift = 0;
		const { app } = rig(docLines, 100, 30, {
			docTotal: () => docLines.length,
			docWindow: (s, c) => docLines.slice(s, s + c),
			docHeadShift: () => headShift,
		});
		app.start();
		await flush();
		app.stateRef.scrollBack = 10;
		app.repaint();
		await flush();
		// 尾部收缩 5 行（合并/discard/重折变短形）——视口 start 保持：scrollBack 跟着缩
		docLines = docLines.slice(0, 45);
		app.repaint();
		await flush();
		expect(app.stateRef.scrollBack).toBe(5); // 10 − 5：钉住（旧实现不补收缩 → 视口上跳）
		// 头部平移（T7 裁剪形：移除 removed 行 + fold 回插 1 行 = 净头移 removed−1；total 同步变 −(removed−1)）
		const removed = 7;
		docLines = ["┄ 已折叠", ...docLines.slice(removed)];
		headShift += removed - 1; // dm.headShiftTotal 同口径（cut 行 − fold 1 行）
		app.repaint();
		await flush();
		expect(app.stateRef.scrollBack).toBe(5); // 行号平移不补（视口内容本就不动——T7 几何论证）
		app.stop();
	});
});

describe("查看窗全局键让位（m5-render-perf 走查④修——宿主查看窗聚焦期主窗叠窗键不穿透）", () => {
	it("查看窗打开期 Ctrl+E 不开诊断、查看窗不被顶掉；Ctrl+O 不入队摘要、Ctrl+T 不切侧栏（走查⑤）；Esc 关窗后 Ctrl+E 恢复主窗语义", async () => {
		const summaries: string[] = [];
		const sidebars: boolean[] = [];
		const { app, input, output } = rig(["# hi"], 100, 30, {
			diagEntries: () => [{ at: "2026-09-29T00:00:00Z", code: "m.x", msg: "样例诊断" } as never],
			showCompactionSummary: () => summaries.push("called"),
			onSidebarChange: (v) => sidebars.push(v),
		});
		app.start();
		await flush();
		app.viewText("子代理消息", "状态：已完成 · 3 轮\n子代理的输出内容");
		await flush();
		input.emit("data", "\x05"); // Ctrl+E（0x05）——查看窗聚焦期
		await flush();
		expect(app.stateRef.diagOpen).toBe(false); // 诊断没开（穿透修掉）
		expect(stripAnsi(output.buf)).toContain("子代理的输出内容"); // 查看窗还在（未被顶掉）
		input.emit("data", "\x0f"); // Ctrl+O——不入队摘要
		await flush();
		expect(summaries).toEqual([]);
		input.emit("data", "\x14"); // Ctrl+T——弹窗聚焦期不切侧栏（走查⑤）
		await flush(600); // 冷却余量（防前次切换干扰）
		expect(app.stateRef.sidebarVisible).toBe(true);
		expect(sidebars).toEqual([]);
		input.emit("data", "\x1b"); // Esc 关查看窗
		await flush();
		input.emit("data", "\x05"); // Ctrl+E 恢复主窗语义——诊断开
		await flush();
		expect(app.stateRef.diagOpen).toBe(true);
		app.stop();
	});
});

describe("查看窗内容快捷键与主窗一致（走查④续——Alt+E/O/F 窗内优先，不穿透主窗折叠态）", () => {
	it("查看窗注册 alt+e → 键落窗内（内容替换、主窗 toggleThink 不触发）；未注册的 alt+o 弹窗期也不可用（走查⑤），关窗后恢复", async () => {
		const actions: string[] = [];
		const { app, input, output } = rig(["# hi"], 100, 30, {
			toggleThink: () => actions.push("think"),
			toggleTool: () => actions.push("tool"),
		});
		app.start();
		await flush();
		app.viewText("子代理消息", "状态：已完成\n收起形态的内容", {
			layout: "full",
			bottom: true,
			keys: { "alt+e": { label: "思考", run: () => "状态：已完成\n展开形态的思考全文" } },
		});
		await flush();
		input.emit("data", "\x1be"); // Alt+E——窗内注册键
		await flush();
		expect(actions).toEqual([]); // 主窗 toggleThink 没触发（让位）
		expect(stripAnsi(output.buf)).toContain("展开形态的思考全文"); // 窗内容已替换
		input.emit("data", "\x1bo"); // Alt+O——查看窗未注册：弹窗聚焦期主窗折叠态不可用（走查⑤）
		await flush();
		expect(actions).toEqual([]);
		input.emit("data", "\x1b"); // Esc 关查看窗
		await flush();
		input.emit("data", "\x1bo"); // 关窗后恢复主窗语义
		await flush();
		expect(actions).toEqual(["tool"]);
		app.stop();
	});
});

describe("斜杠菜单 MCP 区退役（2026-09-30 用户打回「没有意义」——m4-3c T18 整段移除，管理面唯一入口 /settings）", () => {
	it("退役钉：菜单无「── MCP ──」分隔行、无 `mcp : ` 条目、标题计数无 server 段（技能区不受影响）", async () => {
		const { app, input } = rig(["# hi"], 100, 30, {
			skillItems: () => [{ name: "skill : pdf", desc: "生成 PDF", long: "生成 PDF", skill: "pdf" }],
		});
		app.start();
		await flush();
		input.emit("data", "/");
		await flush(120);
		const joined = (app as unknown as { buildOverlay(leftW: number, divRow: number): { lines: string[] } }).buildOverlay(80, 24).lines.map(stripAnsi).join("\n");
		expect(joined).not.toContain("── MCP");
		expect(joined).not.toContain("mcp : ");
		expect(joined).not.toContain("server");
		expect(joined).toContain("skill : pdf"); // 技能区原样
		app.stop();
	});
});

describe("「网络 · MCP」卡（2026-10-01 拍板填实——被动真值：代理态 + 模型服务信息行 + mcp.catalog 五态连接列表＋首连耗时；占位行退役）", () => {
	const netPanel = (): PanelData => ({
		...defaultPanelData(),
		network: {
			proxy: "已启用 · 127.0.0.1:7890",
			modelService: "api.z.ai · 末次 1.8s",
			connections: [
				{ name: "mcp:context7", state: "connected", desc: "HTTP · 12 工具", connectMs: 231 },
				{ name: "mcp:filesystem", state: "connected", desc: "stdio · 8 工具", connectMs: 6 },
				{ name: "mcp:naked", state: "connected", desc: "stdio" }, // connected 无耗时 → 右列回落状态文案
				{ name: "mcp:playwright", state: "idle", desc: "stdio · 懒启动——首调连接" },
				{ name: "mcp:web-search", state: "failed", desc: "stdio" },
				{ name: "mcp:db-helper", state: "pending-confirm", desc: "项目 .mcp.json" },
				{ name: "mcp:seq", state: "disabled", desc: "stdio · 5 工具" },
			],
		},
	});
	const page2 = (app: FullApp): string =>
		(app as unknown as { statusRows(w: number, h: number): string[] }).statusRows(42, 18).map(stripAnsi).join("\n");

	it("① KV 两行 + 五态连接行 + 首连耗时右列 + 恒定提示行（「健康探测」占位文案退役）", () => {
		const { app } = rig(["# hi"], 100, 30, { panelData: netPanel });
		app.stateRef.statePage = 1;
		const rows = page2(app);
		expect(rows).toContain("网络 · MCP");
		expect(rows).toContain("已启用 · 127.0.0.1:7890");
		expect(rows).toContain("api.z.ai · 末次 1.8s");
		expect(rows).toContain("网络 / MCP 连接");
		expect(rows).toContain("mcp:context7");
		expect(rows).toContain("HTTP · 12 工具");
		expect(rows).toContain("231ms"); // connected + connectMs → 右列显首连耗时
		expect(rows).toContain("6ms");
		expect(rows).toContain("已连接"); // connected 无 connectMs → 状态文案回落
		expect(rows).toContain("待启动"); // idle
		expect(rows).toContain("失败"); // failed
		expect(rows).toContain("未确认"); // pending-confirm
		expect(rows).toContain("已停用"); // disabled
		expect(rows).toContain("←→ 切卡 · Esc 返回"); // 提示两行制（走查打回：单行窄侧栏折行）
		expect(rows).toContain("PgUp/PgDn 连接翻页");
		expect(rows).not.toContain("健康探测"); // 占位行退役
		app.stop();
	});

	it("② 连接翻页：>8 行分页（1/2 · SERVERS），PgDn 翻至第 2 页；空表占位行；network 缺省退化行", async () => {
		const conns = Array.from({ length: 9 }, (_, i) => ({ name: `srv${i + 1}`, state: "connected" as const, desc: "stdio" }));
		const { app, input } = rig(["# hi"], 100, 30, { panelData: () => ({ ...defaultPanelData(), network: { proxy: "直连 · 未检测到代理", modelService: "api.z.ai", connections: conns } }) });
		app.stateRef.statePage = 1;
		let rows = page2(app);
		expect(rows).toContain("1/2 · SERVERS");
		expect(rows).toContain("srv1");
		expect(rows).toContain("srv8");
		expect(rows).not.toContain("srv9"); // 每页 8 行
		app.stateRef.statePage = 0; // 预启动直渲设过页号——键序从运行状态页起步复位
		app.start();
		await flush();
		input.emit("data", "\t"); // 焦点 → 运行状态组
		await flush();
		input.emit("data", "\x1b[C"); // → 网络·MCP 页
		await flush();
		input.emit("data", "\x1b[6~"); // PgDn → 连接第 2 页
		await flush();
		rows = (app as unknown as { statusRows(w: number, h: number): string[] }).statusRows(42, 18).map(stripAnsi).join("\n");
		expect(rows).toContain("2/2 · SERVERS");
		expect(rows).toContain("srv9");
		app.stop();
		// 空表：占位指路行
		const empty = rig(["# hi"], 100, 30, { panelData: () => ({ ...defaultPanelData(), network: { proxy: "直连", modelService: "x", connections: [] } }) });
		empty.app.stateRef.statePage = 1;
		expect(page2(empty.app)).toContain("无 MCP server");
		empty.app.stop();
		// network 未供（退化/老桩）：给一行占位不空白
		const bare = rig(["# hi"], 100, 30);
		bare.app.stateRef.statePage = 1;
		expect(page2(bare.app)).toContain("网络面数据未装配");
		bare.app.stop();
	});

	it("③ 键序面：网络页 Enter 不隔页热插拔、↑↓ 不暗挪 moduleSel；回运行状态页行为恢复", async () => {
		const { app, input, actions } = rig(["# hi"], 100, 30, { panelData: netPanel, toggleModule: (n) => actions.push(`toggle:${n}`) });
		app.start();
		await flush();
		input.emit("data", "\t"); // 焦点 → 面板组（运行状态页）
		await flush();
		input.emit("data", "\x1b[C"); // → 网络·MCP 页
		await flush();
		input.emit("data", "\r"); // Enter：不该隔页热插拔看不见的模块
		await flush();
		input.emit("data", "\x1b[B"); // ↓：网络页无选择语义
		await flush();
		expect(actions).toEqual([]);
		expect(app.stateRef.moduleSel).toBe(0);
		input.emit("data", "\x1b[D"); // ← 回运行状态页
		await flush();
		input.emit("data", "\r"); // Enter：热插拔恢复生效
		await flush();
		expect(actions).toEqual(["toggle:orosus-core"]);
		app.stop();
	});
});

describe("「网络 · MCP」卡窄宽防线（2026-10-01 走查打回：字体大 = 卡窄，说明段/小节头不得顶飞——每行可见宽恒 ≤ 卡内宽）", () => {
	const fatPanel = (): PanelData => ({
		...defaultPanelData(),
		network: {
			proxy: "已启用 · 10.9.2.3:7890",
			modelService: "api.z.ai · 末次 1.1s",
			connections: [
				{ name: "mcp:desktop-commander", state: "connected", desc: "stdio · 17 工具", connectMs: 12500 },
				{ name: "mcp:sequential-thinking", state: "connected", desc: "stdio · 3 工具", connectMs: 2100 },
				{ name: "mcp:playwright", state: "idle", desc: "stdio · 2 工具" },
				{ name: "mcp:web-search", state: "failed", desc: "stdio" },
			],
		},
	});
	const rowsAt = (w: number): string[] => {
		const { app } = rig(["# hi"], 100, 30, { panelData: fatPanel });
		app.stateRef.statePage = 1;
		const rows = (app as unknown as { statusRows(w: number, h: number): string[] }).statusRows(w, 20);
		app.stop();
		return rows.map(stripAnsi);
	};

	it("① 每行可见宽恒 ≤ 卡宽（46/38/30/28 四档——顶飞回归钉）；连接行右端恒 ≥1 空隙不贴边框", () => {
		for (const w of [48, 40, 32, 28]) {
			const rows = rowsAt(w);
			for (const r of rows) {
				expect(visibleWidth(r), `w=${w} 行超宽：${r}`).toBeLessThanOrEqual(w);
			}
			for (const r of rows.filter((x) => x.includes("●") || x.includes("○"))) {
				expect(r.endsWith(" │"), `w=${w} 连接行贴边框（右边框前无空隙）：${r}`).toBe(true);
			}
		}
	});

	it("② 说明段两段降级（走查拍板「字体大时传输方式不显示」——预算驱动）：宽=全段 / 中=只显工具数 / 窄=空；小节头窄卡丢后缀不腰斩", () => {
		const wide = rowsAt(54).join("\n");
		expect(wide).toContain("mcp:desktop-commander stdio · 17 工具"); // 全段
		expect(wide).toContain("1/1 · SERVERS");
		const mid = rowsAt(34).join("\n"); // 短名行 playwright 预算余 8——中档只显「2 工具」
		expect(mid).toContain("mcp:playwright 2 工具");
		expect(mid).not.toContain("mcp:playwright stdio");
		expect(mid).not.toContain("mcp:desktop-commander stdio"); // 长名行预算穷——desc 整段空
		const narrow = rowsAt(28).join("\n");
		expect(narrow).not.toContain("stdio"); // 最窄档：传输方式全灭（工具数也不显）
		expect(narrow).not.toContain("SERVERS"); // 小节头降级只留页码——不被腰斩成「SER」
		expect(narrow).toContain("1/1");
	});
});

// ---------- m5-at-menu（T2 键族与状态机——@ 文件选择菜单） ----------

/** 目录桩：根/apps/apps-cli/src/src-tui 五级（未知目录 → [] = 目录不存在空态）。 */
const AT_TREE: Record<string, AtEntry[]> = {
	"": [
		{ name: "apps", dir: true },
		{ name: "src", dir: true },
		{ name: "a.ts", dir: false },
		{ name: "readme.md", dir: false },
	],
	apps: [{ name: "cli", dir: true }],
	"apps/cli": [{ name: "main.ts", dir: false }],
	src: [
		{ name: "tui", dir: true },
		{ name: "a.ts", dir: false },
	],
	"src/tui": [
		{ name: "fullapp.ts", dir: false },
		{ name: "menu.ts", dir: false },
	],
	big: Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.ts`, dir: false })),
};

/** at rig：rig 桩上叠 atMenuEntries（导航点现读——目录变了才读的现读语义由键族驱动）。 */
const atRig = (over: Partial<FullAppIO> = {}) =>
	rig(["# 你好"], 100, 30, {
		atMenuEntries: (d) => {
			const e = AT_TREE[d];
			return e === undefined ? { entries: [] as AtEntry[], miss: true } : { entries: e };
		},
		...over,
	});

describe("m5-at-menu（T2 键族与状态机——开菜单/钻入/Esc 回退/插路径/Tab 补全/过滤/召回/光标与退格触发）", () => {
	it("① 打 @ 开菜单 + 继续打字过滤（词快照落 state）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@");
		await flush();
		expect(app.stateRef.atMenu).toEqual({ dir: "", entries: AT_TREE[""], sel: 0, start: 0, filter: "" });
		input.emit("data", "sr");
		await flush();
		expect(app.stateRef.atMenu?.filter).toBe("sr"); // 过滤词跟打字更新
		expect(app.stateRef.atMenu?.dir).toBe(""); // 词内无 / 仍根目录
		app.stop();
	});
	it("② 退格删到 @ 消失关菜单", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@sr");
		await flush();
		expect(app.stateRef.atMenu).toBeDefined();
		input.emit("data", "\x7f"); // @s
		input.emit("data", "\x7f"); // @
		await flush();
		expect(app.stateRef.atMenu).toBeDefined(); // 裸 @ 空词仍命中（根全显）
		input.emit("data", "\x7f"); // 空
		await flush();
		expect(app.stateRef.atMenu).toBeUndefined();
		app.stop();
	});
	it("③ 退格删成 @ 词重开（D16——Esc 关掉后续打/退格回词内菜单回来）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@sr");
		await flush();
		input.emit("data", "\x1b"); // Esc 根上关菜单（文本保留）
		await flush();
		expect(app.stateRef.atMenu).toBeUndefined();
		expect(app.stateRef.input).toBe("@sr");
		input.emit("data", "\x7f"); // @s——退格删成 @ 词即开（D16 挂点）
		await flush();
		expect(app.stateRef.atMenu).toBeDefined();
		expect(app.stateRef.atMenu?.filter).toBe("s");
		app.stop();
	});
	it("④ Enter 目录钻入：输入框变 `@src/` + 现读下级 + sel 归零", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@sr"); // 过滤到 src 唯一命中
		await flush();
		input.emit("data", "\r");
		await flush();
		expect(app.stateRef.input).toBe("@src/");
		expect(app.stateRef.cursor).toBe(5); // 光标落替换尾（/ 右侧）
		expect(app.stateRef.atMenu).toEqual({ dir: "src", entries: AT_TREE.src!, sel: 0, start: 0, filter: "" });
		app.stop();
	});
	it("⑤ Enter 文件插 `@路径` + 空格 + 关菜单（光标落空格后已不在词上）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@src/a"); // path=src filter=a → 唯一命中 src/a.ts
		await flush();
		input.emit("data", "\r");
		await flush();
		expect(app.stateRef.input).toBe("@src/a.ts ");
		expect(app.stateRef.cursor).toBe(10);
		expect(app.stateRef.atMenu).toBeUndefined();
		app.stop();
	});
	it("⑥ Tab 目录补全且续显下级（与 Enter 钻入同款）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@sr");
		await flush();
		input.emit("data", "\t");
		await flush();
		expect(app.stateRef.input).toBe("@src/");
		expect(app.stateRef.atMenu?.dir).toBe("src");
		app.stop();
	});
	it("⑦ Tab 文件补全收尾关菜单（与 Enter 选定同款）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@src/a");
		await flush();
		input.emit("data", "\t");
		await flush();
		expect(app.stateRef.input).toBe("@src/a.ts ");
		expect(app.stateRef.atMenu).toBeUndefined();
		app.stop();
	});
	it("⑧ 连按 Tab 逐级补到文件：@ → @apps/ → @apps/cli/ → @apps/cli/main.ts ", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@");
		await flush();
		input.emit("data", "\t"); // 选中 apps（根目录在前 sel 0）
		await flush();
		expect(app.stateRef.input).toBe("@apps/");
		expect(app.stateRef.atMenu?.dir).toBe("apps");
		input.emit("data", "\t"); // apps 下唯一 cli
		await flush();
		expect(app.stateRef.input).toBe("@apps/cli/");
		input.emit("data", "\t"); // cli 下唯一 main.ts——补全收尾
		await flush();
		expect(app.stateRef.input).toBe("@apps/cli/main.ts ");
		expect(app.stateRef.atMenu).toBeUndefined();
		app.stop();
	});
	it("⑨ Esc 子目录退根：词截到上一级 + 目录跟着回退", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@src/tui/f");
		await flush();
		expect(app.stateRef.atMenu?.dir).toBe("src/tui");
		input.emit("data", "\x1b");
		await flush();
		expect(app.stateRef.input).toBe("@src/");
		expect(app.stateRef.cursor).toBe(5);
		expect(app.stateRef.atMenu).toEqual({ dir: "src", entries: AT_TREE.src!, sel: 0, start: 0, filter: "" });
		app.stop();
	});
	it("⑩ Esc 根上关菜单且文本与光标保留", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@sr");
		await flush();
		input.emit("data", "\x1b");
		await flush();
		expect(app.stateRef.atMenu).toBeUndefined();
		expect(app.stateRef.input).toBe("@sr");
		expect(app.stateRef.cursor).toBe(3);
		app.stop();
	});
	it("⑪ 词与目录联动：打字推进词内出现 / 时目录切换现读", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@src");
		await flush();
		expect(app.stateRef.atMenu?.dir).toBe(""); // 词内无 / 仍根
		input.emit("data", "/"); // 词变 @src/ → path=src
		await flush();
		expect(app.stateRef.atMenu?.dir).toBe("src");
		expect(app.stateRef.atMenu?.entries).toEqual(AT_TREE.src);
		expect(app.stateRef.atMenu?.filter).toBe("");
		app.stop();
	});
	it("⑫ 中文紧贴「看下@sr」也开菜单", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "看下@sr");
		await flush();
		expect(app.stateRef.atMenu).toBeDefined();
		expect(app.stateRef.atMenu?.start).toBe(2);
		expect(app.stateRef.atMenu?.filter).toBe("sr");
		app.stop();
	});
	it("⑬ 斜杠命令形态打 @ 不开（互斥：atWordAt 排除 + 斜杠侧空格关窗）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "/x@"); // 行首斜杠形态——at 恒不命中；斜杠侧 x@ 零命中也不开
		await flush();
		expect(app.stateRef.atMenu).toBeUndefined();
		expect(app.stateRef.overlayOpen).toBe(false);
		app.stop();
	});
	it("⑭ busy 期照常可开（菜单不依赖空闲态）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		app.setBusy(true);
		input.emit("data", "@");
		await flush();
		expect(app.stateRef.atMenu).toBeDefined();
		app.stop();
	});
	it("⑮ 桩返回空不炸（目录不存在 miss 标志——空态可见反馈，菜单照开）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@nosuch/"); // 未知目录 → miss（目录不存在空态）
		await flush();
		expect(app.stateRef.atMenu).toEqual({ dir: "nosuch", entries: [], sel: 0, start: 0, filter: "", miss: true });
		input.emit("data", "\r"); // 空清单 Enter 无动作
		await flush();
		expect(app.stateRef.atMenu).toBeDefined();
		app.stop();
	});
	it("⑯ 词区间替换不吃正文中段同串（Enter 换第二条词，第一条原样）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@a.ts 前言 @a.t");
		await flush();
		expect(app.stateRef.atMenu?.start).toBe(9); // 光标在第二条词上（@9a10.11t12——第一条词区间替换不得误啃）
		input.emit("data", "\r");
		await flush();
		expect(app.stateRef.input).toBe("@a.ts 前言 @a.ts ");
		app.stop();
	});
	it("⑰ D15 光标触发：光标挪到正文中间 @ 词上续打一字符即开（过滤词 = 词内容）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "前言 @a.ts 后语");
		await flush(); // 打完空格/后语已失中关菜单
		expect(app.stateRef.atMenu).toBeUndefined();
		input.emit("data", "\x1b[D"); // ←×4：光标 17→13（词 @a.ts 区间 [3,9] 内——s 左/t 右）
		input.emit("data", "\x1b[D");
		input.emit("data", "\x1b[D");
		input.emit("data", "\x1b[D");
		await flush();
		expect(app.stateRef.atMenu).toBeUndefined(); // 纯移动不触发（D15）
		input.emit("data", "x"); // 词中续打 → @a.txs → 命中即开
		await flush();
		expect(app.stateRef.atMenu).toBeDefined();
		expect(app.stateRef.atMenu?.filter).toBe("a.txs");
		app.stop();
	});
	it("⑱ D15 菜单开着 ← 挪出词不关、内容静止；续打非词字符后关", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "前言 @sr");
		await flush();
		expect(app.stateRef.atMenu?.filter).toBe("sr");
		input.emit("data", "\x1b[D"); // ←×4：光标 6→2（空格位 = 词外）
		input.emit("data", "\x1b[D");
		input.emit("data", "\x1b[D");
		input.emit("data", "\x1b[D");
		await flush();
		expect(app.stateRef.atMenu).toBeDefined(); // 纯移动不关
		expect(app.stateRef.atMenu?.filter).toBe("sr"); // 内容静止——词快照不追光标
		input.emit("data", "x"); // 光标 2（词外——空格位）插入 → 失中 → 关
		await flush();
		expect(app.stateRef.atMenu).toBeUndefined();
		expect(app.stateRef.input).toBe("前言x @sr");
		app.stop();
	});
	it("⑲ D15 Enter 时光标已挪离词：无动作不误替换（kimi applyCompletion 防活词失中同款）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "前言 @sr");
		await flush();
		input.emit("data", "\x1b[D");
		input.emit("data", "\x1b[D");
		input.emit("data", "\x1b[D");
		input.emit("data", "\x1b[D"); // 光标 2 = 词外
		await flush();
		input.emit("data", "\r"); // Enter 现算失中 → 无动作
		await flush();
		expect(app.stateRef.input).toBe("前言 @sr"); // 不误替换
		expect(app.stateRef.atMenu).toBeDefined(); // 无动作 = 菜单不动（保持开）
		app.stop();
	});
	it("⑳ D13 队列召回：↑ 召回落「…@src/a.ts」光标串尾 → 自动开菜单且过滤词 = 文件名", async () => {
		const { app, input, queue } = atRig();
		app.start();
		await flush();
		queue.push("看看 @src/a.ts"); // @ 词收尾（D13 挂点 = 串尾光标在词上）
		input.emit("data", "\x1b[A"); // 空输入 + 队列非空 → 召回队尾（光标落串尾）
		await flush();
		expect(app.stateRef.input).toBe("看看 @src/a.ts");
		expect(app.stateRef.atMenu).toBeDefined();
		expect(app.stateRef.atMenu?.dir).toBe("src");
		expect(app.stateRef.atMenu?.filter).toBe("a.ts");
		app.stop();
	});
	it("㉑ D13 历史上翻：↑ 召回「@src/a.ts 前言」光标落串首也开（串首即词首——@ 开头形态）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@src/a.ts 前言");
		input.emit("data", "\r"); // 进历史（rig submit 桩）
		await flush();
		input.emit("data", "\x1b[A"); // 历史上翻：cursor = 0
		await flush();
		expect(app.stateRef.cursor).toBe(0);
		expect(app.stateRef.atMenu).toBeDefined(); // 词区间起点 0 含光标 0
		expect(app.stateRef.atMenu?.filter).toBe("a.ts");
		app.stop();
	});
	it("㉒ D13 召回后改中段引用：→ 挪词尾 + 退格一下开菜单 + Enter 替换词区间（后段完好）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@src/a.ts 你看看");
		input.emit("data", "\r");
		await flush();
		input.emit("data", "\x1b[A"); // 上翻召回：cursor = 0、词首命中开菜单
		await flush();
		expect(app.stateRef.atMenu).toBeDefined();
		for (let i = 0; i < 9; i++) input.emit("data", "\x1b[C"); // →×9：光标 0→9（词尾 s 右——纯移动菜单保持开内容静止）
		await flush();
		input.emit("data", "\x7f"); // 退格删 s → 词 @src/a.t → 重判命中刷新（D15 编辑动作）
		await flush();
		expect(app.stateRef.atMenu?.filter).toBe("a.t");
		input.emit("data", "\r"); // 唯一命中 src/a.ts → 替换词区间 [0,8)
		await flush();
		// 词区间替换 + 文件尾缀空格：后段「 你看看」原样跟随（原空格 + 补空格 = 两空格——设计空白 5 词边界语义）
		expect(app.stateRef.input).toBe("@src/a.ts  你看看");
		app.stop();
	});
	it("㉓ 菜单开着 ↑/↓ 走选中移动不走历史召回", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "第一条"); // 无 @ 的普通消息——造历史全程不开菜单
		input.emit("data", "\r");
		await flush();
		input.emit("data", "@");
		await flush();
		expect(app.stateRef.atMenu).toBeDefined();
		const before = app.stateRef.input;
		input.emit("data", "\x1b[A"); // ↑ = 选中循环到尾（4 条 → sel 3）
		await flush();
		expect(app.stateRef.atMenu?.sel).toBe(3);
		expect(app.stateRef.input).toBe(before); // 不召回
		input.emit("data", "\x1b[B"); // ↓ 回 0
		await flush();
		expect(app.stateRef.atMenu?.sel).toBe(0);
		app.stop();
	});
	it("㉔ 共存串让位（doc-review 三轮勒定）：光标在 @ 词上编辑，串尾 / 词不得劫持斜杠重开", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@a /he"); // 打到 /he 时光标在串尾 / 词上——斜杠侧该开斜杠菜单
		await flush();
		expect(app.stateRef.overlayOpen).toBe(true); // 斜杠菜单开着（中行 / 词形态）
		expect(app.stateRef.atMenu).toBeUndefined();
		input.emit("data", "\x1b"); // Esc 关斜杠菜单（文本保留）
		await flush();
		input.emit("data", "\x1b[D"); // ←×4：光标 5→1（@a 词区间 [0,3] 内）
		input.emit("data", "\x1b[D");
		input.emit("data", "\x1b[D");
		input.emit("data", "\x1b[D");
		await flush();
		expect(app.stateRef.overlayOpen).toBe(false);
		input.emit("data", "x"); // 在 @a 词上续打（←×4 光标 2 = 词右缘内、a 后空格前）→ at 命中优先、短路斜杠重开
		await flush();
		expect(app.stateRef.atMenu).toBeDefined();
		expect(app.stateRef.overlayOpen).toBe(false); // 斜杠不得重开（双菜单态不出现）
		expect(app.stateRef.atMenu?.filter).toBe("ax");
		app.stop();
	});
});

describe("m5-at-menu（T3 渲染层 + 滚轮 + 互斥——buildAtOverlay 框线/选中/分页/空态与斜杠菜单同款纪律）", () => {
	it("① 菜单框形态：标题/计数段/目录文件两形态行/键提示行 + 恒定行数不随条目数变", async () => {
		const { app } = atRig();
		app.start();
		await flush();
		const f = app.overlay.buildAtOverlay(80, 20, "", AT_TREE[""]!, 0, "");
		const plain = f.lines.map((l) => stripAnsi(l));
		expect(plain[0]).toContain("@ 文件");
		expect(plain[0]).toContain("2 个目录 · 2 个文件");
		expect(plain.join("\n")).toContain("apps/");
		expect(plain.join("\n")).toContain("readme.md");
		expect(plain.join("\n")).toContain("↑↓ 选择 · Enter/Tab 进入目录/插入路径 · Esc 返回 · 输入过滤");
		expect(f.lines).toHaveLength(14); // 顶框 + 10 列表 + 余量 + 键提示 + 底框
		// 恒定行数：2 条目录（src/tui）与 4 条根同高——防闪烁纪律
		expect(app.overlay.buildAtOverlay(80, 20, "src/tui", AT_TREE["src/tui"]!, 0, "").lines).toHaveLength(14);
		// 窗几何：贴输入框上缘、全左栏宽（斜杠同款）
		expect(f.row).toBe(20 - 14);
		expect(f.col).toBe(0);
		expect(f.width).toBe(80);
		app.stop();
	});
	it("② 子目录标题 + 目录行 accent 色、文件行默认色、选中行 ❯ 前缀软底", async () => {
		const { app } = atRig();
		app.start();
		await flush();
		const f = app.overlay.buildAtOverlay(80, 20, "src/tui", AT_TREE.src!, 1, "");
		expect(stripAnsi(f.lines[0]!)).toContain("@ src/tui/");
		// 空 filter 目录在前：行序 = [tui/, a.ts]；sel 1 = a.ts 选中
		expect(stripAnsi(f.lines[1]!)).toContain("tui/");
		expect(stripAnsi(f.lines[2]!)).toContain("a.ts");
		expect(stripAnsi(f.lines[2]!)).toContain("❯"); // 选中前缀
		expect(f.lines[2]!).toMatch(/48;2;26;42;35|48;5;234/); // accentSoft 软底（truecolor/256 两形态）
		expect(f.lines[1]!).not.toContain("❯"); // 未选中行无前缀
		app.stop();
	});
	it("③ 过滤段（pick overlay filter 段同款形态）与空态三则：无匹配文件/（空目录）/目录不存在", async () => {
		const { app } = atRig();
		app.start();
		await flush();
		const zero = app.overlay.buildAtOverlay(80, 20, "", AT_TREE[""]!, 0, "zzz");
		expect(stripAnsi(zero.lines[0]!)).toContain("过滤「zzz」 0/4");
		expect(zero.lines.map((l) => stripAnsi(l)).join("\n")).toContain("无匹配文件");
		const empty = app.overlay.buildAtOverlay(80, 20, "apps/cli", [], 0, "");
		expect(empty.lines.map((l) => stripAnsi(l)).join("\n")).toContain("（空目录）");
		const miss = app.overlay.buildAtOverlay(80, 20, "nosuch", [], 0, "", true);
		expect(miss.lines.map((l) => stripAnsi(l)).join("\n")).toContain("目录不存在——检查路径或 Esc 返回");
		app.stop();
	});
	it("④ 余量提示合一行：12 条目录首屏 10 条 + 「↓ 还有 2 项」；sel 落尾页带上余量", async () => {
		const { app } = atRig();
		app.start();
		await flush();
		const f = app.overlay.buildAtOverlay(80, 20, "big", AT_TREE.big!, 0, "");
		const plain = f.lines.map((l) => stripAnsi(l));
		expect(plain.join("\n")).toContain("↓ 还有 2 项");
		expect(plain[10]).not.toContain("↑"); // 无上余量行
		const tail = app.overlay.buildAtOverlay(80, 20, "big", AT_TREE.big!, 11, "");
		expect(tail.lines.map((l) => stripAnsi(l)).join("\n")).toContain("↑ 还有 2 项");
		app.stop();
	});
	it("⑤ 滚轮上下翻选中（与 onAtKey 共用 filterEntries 一源、到头停）", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		const wheel = (dir: "up" | "down"): void => {
			input.emit("data", `\x1b[<${64 + (dir === "up" ? 0 : 1)};10;5M`);
		};
		input.emit("data", "@");
		await flush();
		expect(app.stateRef.atMenu?.sel).toBe(0);
		wheel("down");
		wheel("down");
		await flush();
		expect(app.stateRef.atMenu?.sel).toBe(2);
		wheel("up");
		await flush();
		expect(app.stateRef.atMenu?.sel).toBe(1);
		wheel("up");
		await flush();
		expect(app.stateRef.atMenu?.sel).toBe(0); // 到头停（不回绕）
		app.stop();
	});
	it("⑥ 菜单期主窗全局键不可用（popupFocused 弹窗模态）：Ctrl+T 拦截，Esc 后恢复", async () => {
		const { app, input } = atRig();
		app.start();
		await flush();
		input.emit("data", "@");
		await flush();
		expect(app.stateRef.atMenu).toBeDefined();
		const before = app.stateRef.sidebarVisible;
		input.emit("data", "\x14"); // Ctrl+T
		await flush();
		expect(app.stateRef.sidebarVisible).toBe(before); // 被拦
		input.emit("data", "\x1b"); // Esc 关菜单
		await flush();
		expect(app.stateRef.atMenu).toBeUndefined();
		input.emit("data", "\x14"); // Ctrl+T 恢复可用
		await flush();
		expect(app.stateRef.sidebarVisible).toBe(!before);
		app.stop();
	});
	it("⑦ 与诊断弹窗互斥：at 菜单期 Ctrl+E 吞（不叠诊断）；诊断期编辑不开 at；诊断关后恢复", async () => {
		const diagEntries = () =>
			Array.from({ length: 2 }, (_, i) => ({
				name: `mod-${i}`, tag: "激活失败" as const, reason: `失败原因文本 ${i}`, count: 1, last: "2026-09-25T10:00:00.000Z",
			}));
		const { app, input } = atRig({ diagEntries });
		app.start();
		await flush();
		input.emit("data", "@");
		await flush();
		expect(app.stateRef.atMenu).toBeDefined();
		input.emit("data", "\x05"); // Ctrl+E：at 菜单是弹窗态（popupFocused）——不开诊断
		await flush();
		expect(app.stateRef.diagOpen).toBe(false);
		expect(app.stateRef.atMenu).toBeDefined(); // 菜单不受扰
		input.emit("data", "\x1b"); // Esc 关 at 菜单
		await flush();
		input.emit("data", "\x05"); // Ctrl+E 开诊断
		await flush();
		expect(app.stateRef.diagOpen).toBe(true);
		input.emit("data", "@"); // 诊断期打字被诊断窗吞（键不落编辑态）——at 不开、input 不追加
		await flush();
		expect(app.stateRef.input).toBe("@"); // Esc 关 at 菜单时保留的原词（未变成 "@@"）
		expect(app.stateRef.atMenu).toBeUndefined();
		input.emit("data", "\x1b"); // Esc 关诊断
		await flush();
		input.emit("data", "@"); // 诊断关后恢复
		await flush();
		expect(app.stateRef.atMenu).toBeDefined();
		app.stop();
	});
});

describe("T14 m5-resume-perf: 翻到顶懒分页（防抖触发 + 到头 toast + 停触）", () => {
	it("b. requestOlderPage 防抖合并连击一次取段；到头（false）→ toast「已到会话开头」+ exhausted 停触", async () => {
		let calls = 0;
		const pages = [true, false];
		const { app } = rig([], 100, 30, {
			fetchOlderPage: async () => {
				calls++;
				return pages[Math.min(calls - 1, pages.length - 1)]!;
			},
		});
		app.requestOlderPage();
		app.requestOlderPage();
		app.requestOlderPage(); // 防抖窗口内连击 → 合并为一次
		expect(calls).toBe(0);
		await flush(300); // 过防抖 150ms
		expect(calls).toBe(1);
		await flush(100);
		app.requestOlderPage(); // 第二次：返回 false → 到头
		await flush(300);
		expect(calls).toBe(2);
		app.requestOlderPage(); // exhausted → 停触
		await flush(300);
		expect(calls).toBe(2);
		app.stop?.();
	});
});

describe("T4b m5-resume-perf: 就地换页配套 sessionSwapped（懒分页到头态随会话重置）", () => {
	it("到头（exhausted）后 sessionSwapped 重置——requestOlderPage 可再次触发取段", async () => {
		let calls = 0;
		const { app } = rig([], 100, 30, {
			fetchOlderPage: async () => {
				calls++;
				return calls === 1; // 第一次有更早、第二次到头……重置后第三次再有
			},
		});
		app.requestOlderPage();
		await flush(300);
		expect(calls).toBe(1);
		app.requestOlderPage();
		await flush(300);
		expect(calls).toBe(2); // 到头
		app.requestOlderPage();
		await flush(300);
		expect(calls).toBe(2); // exhausted 停触
		app.sessionSwapped(); // 换会话——重置
		app.requestOlderPage();
		await flush(300);
		expect(calls).toBe(3); // 新会话可重新上翻
		app.stop?.();
	});
});

describe("验收门 6 几何钉（2026-10-05 方案复读补）：头部插页视口钉住——底部锚定 scrollBack 下头部内容只增不移", () => {
	it("补页（doc 头部插入 N 行）后视口窗口内容不变——start/end 随内容下移同一可视内容", () => {
		const old: string[] = Array.from({ length: 40 }, (_, i) => `旧内容 ${i}`);
		let doc = [...old];
		let headShift = 0; // 模拟 dm.headShiftTotal（main.ts docHeadShift 同款接线）
		const { app } = rig([], 100, 30, {
			docTotal: () => doc.length,
			docWindow: (start: number, count: number) => doc.slice(start, Math.min(doc.length, start + count)),
			docHeadShift: () => headShift,
		} as never);
		app.state.scrollBack = 10; // 用户上翻停在距底 10 行（非贴底）
		app.scheduler.requestImmediateRender();
		const before = app.viewportRange();
		const beforeContent = doc.slice(before.start, before.end);
		// 补页：头部插入 12 行 + headShift 负平移 -12（dm.prependHistory 同款账）
		doc = [...Array.from({ length: 12 }, (_, i) => `补页行 ${i}`), ...old];
		headShift -= 12;
		app.scheduler.requestImmediateRender();
		const after = app.viewportRange();
		const afterContent = doc.slice(after.start, after.end);
		expect(after.start).toBe(before.start + 12); // 行号随内容下移 12（scrollBack 不动）
		expect(afterContent).toEqual(beforeContent); // 视口钉住：同一可视内容（headShift 负平移对消补偿）
		expect(app.state.scrollBack).toBe(10); // 距底不动——头部插入未被当尾部增长
		app.stop?.();
	});
});

// m5-peers T6e：模块总览启动器（Ctrl+P——A-1 极简版）FullApp 集成
describe("模块总览启动器（m5-peers T6e）", () => {
	it("① Ctrl+P 开总览：列表渲染 + ↑↓/Enter 执行登记命令（submit 通道）+ Esc 关闭", async () => {
		const { app, input, output, submitted } = rig(["# 你好"], 100, 30, {
			launcherEntries: () => [
				{ name: "tool-peers", label: "记忆", command: "/tool-peers__memory" },
				{ name: "other", label: "另一窗", command: "/other__ui" },
			],
		});
		app.start();
		await flush();
		input.emit("data", "\x10"); // Ctrl+P 开
		await flush();
		const plain = stripAnsi(output.buf);
		expect(plain).toContain("模块总览");
		expect(plain).toContain("记忆");
		expect(plain).toContain("/tool-peers__memory");
		expect(plain).toContain("2 个带界面模块");
		input.emit("data", "\x1b[B"); // ↓ 到第二项
		await flush();
		input.emit("data", "\r"); // Enter → submit 登记命令
		await flush();
		expect(submitted).toEqual(["/other__ui"]);
		input.emit("data", "\x10"); // 再按 Ctrl+P（总键再按关闭——此时已关，重开）
		await flush();
		input.emit("data", "\x1b"); // Esc 关
		await flush();
		const tail = stripAnsi(output.buf.slice(-3000));
		expect(tail).not.toContain("模块总览");
		app.stop();
	});

	it("② 空态：无登记模块 → toast 不弹空窗", async () => {
		const { app, input, output } = rig(["# 你好"], 100, 30, { launcherEntries: () => [] });
		app.start();
		await flush();
		input.emit("data", "\x10");
		await flush();
		const plain = stripAnsi(output.buf);
		expect(plain).toContain("没有可打开的模块界面");
		app.stop();
	});

	it("③ 弹窗期模态让位：总览开着时 Ctrl+T 不切侧栏（popupFocused 链）；busy 期 Ctrl+P 可用", async () => {
		const { app, input } = rig(["# 你好"], 100, 30, {
			launcherEntries: () => [{ name: "tool-peers", label: "记忆", command: "/tool-peers__memory" }],
		});
		app.start();
		await flush();
		const before = app.stateRef.sidebarVisible;
		input.emit("data", "\x10"); // 开总览
		await flush();
		input.emit("data", "\x14"); // Ctrl+T（总览开着——应被吞）
		await flush();
		expect(app.stateRef.sidebarVisible).toBe(before); // 未切换
		input.emit("data", "\x1b"); // Esc 关总览
		await flush();
		input.emit("data", "\x14"); // Ctrl+T（关了——应切换）
		await flush();
		expect(app.stateRef.sidebarVisible).toBe(!before);
		app.stop();
	});
});

// m5-peers 走查六-②/七：浏览窗（dialog interactive list）长列表翻页/滚轮/滚动条验证
describe("dialog 长列表滚动（m5-peers 浏览窗形态）", () => {
	const wheel = (input: FakeInput, dir: "up" | "down"): void => {
		const code = 64 + (dir === "up" ? 0 : 1);
		input.emit("data", `\x1b[<${code};10;5M`);
	};

	it("40 条列表：↑↓ 视口跟随；PgDn 整页翻（视口真动）；滚轮 = 移选中行；滚动条在场", async () => {
		const items = Array.from({ length: 40 }, (_, i) => `笔记-${String(i).padStart(2, "0")}`);
		const { app, input, output } = rig(["# 你好"], 100, 30);
		app.start();
		await flush();
		app.openDialogHost({
			title: "记忆 · 本项目",
			layout: "full",
			widgets: [{ id: "list", kind: "list", interactive: true, items }],
		});
		await flush();
		let plain = stripAnsi(output.buf);
		expect(plain).toContain("笔记-00");
		expect(plain).toContain("█");   // 走查七-②：超一屏 → 右缘滚动条拇指在场
		// PgDn = 整页翻（走查七-①）：sel 跳到页高(~24)处、首屏内容滚出视野（末帧口径——buf 叠全部历史帧）
		input.emit("data", "\x1b[6~");
		await flush();
		plain = stripAnsi(output.buf.slice(-3800));
		expect(plain).not.toContain("笔记-01");   // 首屏已翻走（整页语义——旧 ±10 步长时首屏仍在）
		expect(plain).toContain("笔记-24");   // sel 落到页高步长处
		// 滚轮 = ↑↓（走查七-②）：滚两格 sel +2、视口跟随
		wheel(input, "down");
		wheel(input, "down");
		await flush(120);
		plain = stripAnsi(output.buf.slice(-3800));
		expect(plain).toContain("笔记-26");   // 24 → 26（滚轮移选中非滚窗体）
		app.stop();
	});
});

// m5-peers 走查九-③：进行态 dialog 禁 Esc（强停走显式键）
describe("dialog 禁 Esc（disallowEscape）", () => {
	it("进行态按 Esc 不关窗、toast 指路 Alt+C", async () => {
		const { app, input } = rig(["# 你好"], 100, 30);
		app.start();
		await flush();
		app.openDialogHost({
			title: "记忆 · 导入",
			layout: "dock",
			disallowEscape: true,
			widgets: [{ id: "bar", kind: "progress", value: 3, max: 10 }],
		});
		await flush();
		input.emit("data", "\x1b"); // Esc
		await flush();
		const pu = (app as unknown as { pendingUi?: unknown }).pendingUi;
		expect(pu).toBeDefined();   // 窗未关（disallowEscape 生效）
		expect(app.stateRef.toast?.text).toContain("进行中不可关闭");   // toast 走状态探针（dock 窗与 toast 同区域渲染互挤）
		app.stop();
	});
	// 走查十-②：完成态「没有新条目」关不掉窗——窗内无 interactive 控件时 activate 事件永不触发
	// （ids 空 → keys 的 enter→activate 分支不进）+ Esc 被禁 = 窗死锁。修法 = Enter 走 hostKeys
	//（派发在 ids 分支之前、escape 除外恒可达）：完成态关窗、进行态吞掉（不消费会落回输入框当发送）。
	//（走查十二-① 后完成态由宿主自动关窗——此测钉 hostKeys.enter 机制兜底仍可达。）
	it("完成态 Enter 经 hostKeys 关窗（无 interactive 控件也能到）", async () => {
		const { app, input } = rig(["# 你好"], 100, 30);
		app.start();
		await flush();
		let finished = false;
		app.openDialogHost({
			title: "记忆 · 导入",
			layout: "dock",
			disallowEscape: true,
			widgets: [
				{ id: "status", kind: "text", text: () => (finished ? "已导入 3 条记忆" : "导入中…") },
				{ id: "bar", kind: "progress", value: () => (finished ? 3 : 0), max: 3 },
			],
			hostKeys: {
				"alt+c": { label: "Alt + C 停止并关闭", run: () => true },
				enter: { label: "Enter 关闭", run: (ctx) => { if (finished) ctx.close(); return true; } },
			},
		});
		await flush();
		input.emit("data", "\r"); // 进行态 Enter：吞掉不动作（窗在）
		await flush();
		expect((app as unknown as { pendingUi?: unknown }).pendingUi).toBeDefined();
		finished = true;   // 完成态（活值 getter 现读）
		app.scheduler.requestImmediateRender();
		await flush();
		input.emit("data", "\r"); // 完成态 Enter：关窗
		await flush();
		expect((app as unknown as { pendingUi?: unknown }).pendingUi).toBeUndefined();
		app.stop();
	});
	// 走查十-①红框：键导引行硬编码「Enter 激活 · Esc 关闭」——禁 Esc 窗里 Esc 被吞、Enter 无控件可激活，
	// 两句都是空头支票。修法 = disallowEscape 时尾巴整段不拼、键表由 hostKeys 标签自带（带键名）。
	it("禁 Esc 窗键导引行只显 hostKeys 标签、不再提 Esc 关闭/Enter 激活", async () => {
		const { app } = rig(["# 你好"], 100, 30);
		app.start();
		await flush();
		app.openDialogHost({
			title: "记忆 · 导入",
			layout: "dock",
			disallowEscape: true,
			widgets: [{ id: "bar", kind: "progress", value: 0, max: 3 }],
			hostKeys: {
				"alt+c": { label: "Alt + C 停止并关闭", run: () => true },
				enter: { label: "", run: () => true },
			},
		});
		await flush();
		const pu = (app as unknown as { pendingUi: unknown }).pendingUi;
		const ov = (app as unknown as { buildDialogOverlay(pu: unknown): { lines: string[] } }).buildDialogOverlay(pu);
		const plain = stripAnsi(ov.lines.join("\n"));
		expect(plain).toContain("Alt + C 停止并关闭");
		expect(plain).not.toContain("Esc 关闭");
		expect(plain).not.toContain("Enter 激活");
		app.stop();
	});
});
