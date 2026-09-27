import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { FullApp, diagListLines, type FullAppIO, type PanelData, type SlashItem } from "./fullapp.ts";
import type { DialogSpec } from "@orosus/contracts/module";
import { stripAnsi, visibleWidth } from "./width.ts";
import { fg } from "../theme.ts";

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
		doc: () => docLines,
		submit: (t) => submitted.push(t),
		requestExit: () => actions.push("exit"),
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
		const mods = Array.from({ length: 7 }, (_, i) => ({ name: `mod-${i}`, desc: "测试", state: "mounted" as const }));
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
		input.emit("data", "\x1b[6~"); // PgDn → 模块翻页（每页 5）：sel 0 → 5 落第 2 页
		await flush();
		expect(st.state.moduleSel).toBe(5);
		expect(st.state.scrollBack).toBe(0); // 面板聚焦期 PgUp/PgDn 归面板，不滚对话流
		input.emit("data", "\x1b[B"); // ↓ 模块选择就地 +1
		await flush();
		expect(st.state.moduleSel).toBe(6);
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
		r.io.doc = () => dm.frameLines(96); // loop 顶重建后 FullApp 的行源
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


describe("Esc 后继续输入重开斜杠菜单（F5 十五轮②）", () => {
	it("'/qu' + Esc + 继续输入 → 菜单重开；非斜杠输入不重开", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		input.emit("data", "/qu");
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		input.emit("data", "\x1b"); // Esc 关菜单（文本保留）
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		expect(app.stateRef.input).toBe("/qu");
		input.emit("data", "i"); // 继续补字母——菜单重开
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

// M4-3 T1d：引导弹窗 FullApp 集成（焦点锁/键路由/结算/渲染）
describe("首次使用引导弹窗 FullApp 集成（M4-3 T1d）", () => {
	const obDeps = (calls: { secrets: [string, string][]; models: string[]; search: Record<string, unknown>[] }) => ({
		providers: [
			{ id: "zhipu", name: "智谱 GLM", envKey: "ZHIPU_API_KEY", baseUrl: "https://x/v1", type: "openai" as const, local: false },
			{ id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", type: "openai" as const, local: true },
		],
		writeProvider: () => {},
		appendSecret: (k: string, v: string) => { calls.secrets.push([k, v]); },
		setModel: (s: string) => { calls.models.push(s); },
		writeSearch: (p: Record<string, unknown>) => { calls.search.push(p); },
		listModels: async () => ["glm-5.3"],
	});

	it("⑬ 弹窗开 → 焦点锁全键序走通三页 → completed 结算 + 弹窗消退", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		const calls = { secrets: [] as [string, string][], models: [] as string[], search: [] as Record<string, unknown>[] };
		const outcome = app.runOnboarding(obDeps(calls));
		await flush();
		expect(stripAnsi(output.buf)).toContain("引导 1 / 3");
		input.emit("data", "\x0e"); // Ctrl + N → p2
		await flush();
		expect(stripAnsi(output.buf)).toContain("引导 2 / 3");
		input.emit("data", "\r"); // 进 key 态（zhipu）
		input.emit("data", "zk");
		input.emit("data", "\r"); // 确认 key
		await flush();
		expect(calls.secrets).toEqual([["ZHIPU_API_KEY", "zk"]]);
		expect(calls.models).toEqual(["zhipu"]);
		input.emit("data", "\x0e"); // → p3
		await flush();
		input.emit("data", "\r"); // opts → llm 子态
		input.emit("data", "\r"); // 默认项选定
		await flush();
		input.emit("data", "\x0e"); // 完成
		await flush();
		expect(await outcome).toEqual({ kind: "completed" });
		const tail = stripAnsi(output.buf.slice(-4000));
		expect(tail).not.toContain("引导 3 / 3"); // 弹窗已消退
		app.stop();
	});

	it("⑭ 第 1 页 Ctrl + Q → quit 结算；stop() 兜底结算不永挂", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		const calls = { secrets: [] as [string, string][], models: [] as string[], search: [] as Record<string, unknown>[] };
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

	it("③ 全不命中 → 空态「无匹配命令」", async () => {
		const r = rig();
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/zz");
		await flush(120);
		expect(overlayLines(app).map(stripAnsi).some((l) => l.includes("无匹配命令"))).toBe(true);
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
		expect(ov.lines.join("\n")).toContain("kimi-code-plan-cn （https://api.kimi.com/coding/v1）"); // 压平形态
		const ov0 = pick(0);
		expect(ov0.lines.length).toBe(ov.lines.length); // 移动选中行数恒定（防闪烁纪律同族）
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
		input.emit("data", "\x05"); // Ctrl+E 归宿主全局键（诊断总开关——空态 toast 而非模块键）
		await flush();
		expect(stripAnsi(output.buf)).toContain("模块全部正常");
		expect(stripAnsi(output.buf)).not.toContain("不该出现");
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
});

describe("斜杠菜单技能区（m4-7 T7——原型图 1 验收点 1-4：skill : 名殿后于命令/分隔行/详释 3 行/Enter 注入）", () => {
	const SK = (name: string, desc: string, usage?: string): SlashItem => ({
		name: `skill : ${name}`, desc, long: desc, skill: name, ...(usage !== undefined ? { usage } : {}),
	});
	const overlayOf = (app: FullApp): string[] =>
		(app as unknown as { buildOverlay(leftW: number, divRow: number): { lines: string[] } }).buildOverlay(80, 24).lines;

	it("① 技能条目「skill : 名」殿后于全部命中命令 + 分隔行「── 技能 ──」+ 标题计数并注技能段", async () => {
		const r = rig(["# hi"], 100, 30, {
			skillItems: () => [SK("pdf", "生成 PDF 文件", "需要交付 PDF 文件时"), SK("review-pr", "审查拉取请求")],
			skillInject: (n) => `INJ:${n}`,
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
			skillInject: (n) => `INJ:${n}`,
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

	it("④ Enter = 用户触发注入：skillInject 拿真名、submit 收注入全文、菜单关；Tab 对技能条目不补全（留菜单）", async () => {
		const injected: string[] = [];
		const r = rig(["# hi"], 100, 30, {
			skillItems: () => [SK("pdf", "生成 PDF 文件")],
			skillInject: (n) => { injected.push(n); return `（用户通过菜单手动加载技能 "${n}"）\n<skill name="${n}">\n正文\n</skill>`; },
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
		input.emit("data", "\t"); // Tab：技能不可补全——菜单仍开、输入仍 "/"
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(true);
		expect(app.stateRef.input).toBe("/");
		input.emit("data", "\r"); // Enter → 注入提交
		await flush(120);
		expect(app.stateRef.overlayOpen).toBe(false);
		expect(injected).toEqual(["pdf"]); // 真名（非 skill : 名 显示文本）
		expect(submitted).toHaveLength(1);
		expect(submitted[0]).toContain('<skill name="pdf">');
		expect(submitted[0]).toContain("正文");
		app.stop();
	});

	it("⑤ 过滤两档：q=「re」→ 技能 review-pr 命中（pdf 不含不显）；命令零命中技能有货不显示「无匹配命令」；↑ 跨分隔行回绕不停 sep", async () => {
		const r = rig(["# hi"], 100, 30, {
			skillItems: () => [SK("pdf", "生成 PDF 文件"), SK("review-pr", "审查拉取请求")],
			skillInject: (n) => `INJ:${n}`,
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
		expect(app.stateRef.overlayOpen).toBe(true); // 空过滤占位不关窗（既有纪律，技能命中同理）
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
		expect(stripAnsi(output.buf)).toContain("[a");
		input.emit("data", "\t"); // 焦点 q → l
		await flush();
		input.emit("data", "\x1b[B"); // ↓ 动列表
		await flush();
		input.emit("data", "\t"); // l → q
		await flush();
		input.emit("data", "b"); // 回到输入框继续打字
		await flush();
		expect(stripAnsi(output.buf)).toContain("[ab");
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
		app.setSidebar(true); // 设置服务路径同款出口
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
		await flush(1200); // 跨一个 tick 帧让 live 刷新
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
		const { app, input } = rig(mkDoc());
		app.start();
		await flush();
		const st = app.stateRef as unknown as SelState;
		press(input, 6, 0); // docIdx 75 列 6（b 处）——第一击 count 1
		press(input, 6, 0); // 同点第二击 count 2 → 词区间
		await flush();
		expect(st.mselAnchor).toEqual({ scope: "main", docIdx: 75, col: 4 });
		expect(st.mselFocus).toEqual({ scope: "main", docIdx: 75, col: 12 });
		press(input, 6, 0); // 第三击 count 3 → 整行
		await flush();
		expect(st.mselAnchor).toEqual({ scope: "main", docIdx: 75, col: 0 });
		expect(st.mselFocus?.docIdx).toBe(75); // 整行选区（scope main）
		app.stop();
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
		await flush(180); // ≥3 个脉冲
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
		await flush(150);
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

});
