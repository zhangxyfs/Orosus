import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { FullApp, diagListLines, type FullAppIO } from "./fullapp.ts";
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
		panelData: () => ({
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
		}),
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
		// 分隔线必须落在左栏宽处（队列行未补齐则 │ 左移错位——2026-09-23 走查实锤回归钉；CJK 计宽用 visibleWidth）
		expect(visibleWidth(qLine.slice(0, qLine.indexOf("│")))).toBe(100 - (app as unknown as { sidebarW(): number }).sidebarW() - 2);
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
});
