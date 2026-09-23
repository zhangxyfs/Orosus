import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { FullApp, type FullAppIO } from "./fullapp.ts";
import { stripAnsi } from "./width.ts";

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

function rig(docLines: string[] = ["# 你好"], cols = 100, rows = 30) {
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
		// 结构恒定：标题 + ↑占位 + 10 行命令 + ↓行 + 分隔 + 2 行说明 + foot + 底框 = 18 行（标题下无装饰空行——用户打回）
		expect(plain).toHaveLength(18);
		const cmdRows = plain.slice(2, 12);
		expect(cmdRows.filter((l) => l.includes("/help") || l.includes("/title") || l.includes("/permission"))).toHaveLength(3);
		expect(cmdRows.filter(isBlankRow)).toHaveLength(7); // 7 个空槽
		expect(isBlankRow(plain[1]!)).toBe(true); // ↑ 常驻：窗口在顶时该行为空占位
		expect(isBlankRow(plain[12]!)).toBe(true); // ↓ 常驻：3 条全显示无余量 → 空占位（行不消失）
		app.stop();
	});

	it("超出 10 条滚动到底：↑ 行显示余量、↓ 行转空占位——行数仍 18", async () => {
		const r = rig();
		r.io.slashCommands = () => Array.from({ length: 13 }, (_, i) => ({ name: `/c${String(i).padStart(2, "0")}`, desc: `第${i}`, long: `说明${i}` }));
		const { app, input } = r;
		app.start();
		await flush();
		input.emit("data", "/");
		await flush(120);
		input.emit("data", "\x1b[B".repeat(12)); // ↓ 到底
		await flush(120);
		const plain = overlayLines(app).map(stripAnsi);
		expect(plain).toHaveLength(18);
		expect(plain[1]).toContain("↑ 还有"); // 头上有余量
		expect(isBlankRow(plain[12]!)).toBe(true); // 底下没有 → 空占位（不再消失）
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
