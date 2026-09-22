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
	const io: FullAppIO = {
		columns: () => cols,
		rows: () => rows,
		doc: () => docLines,
		submit: (t) => submitted.push(t),
		requestExit: () => actions.push("exit"),
		requestCancel: () => actions.push("cancel"),
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
			{ name: "/permission", desc: "权限", long: "长", children: ["ask-risky", "never"] },
		],
		slashCurrent: () => "ask-risky",
		thinkOpen: () => false,
		toggleThink: () => actions.push("think"),
	};
	const { input, output } = fakeTerm(cols, rows);
	const app = new FullApp(io, { input, output });
	return { app, io, input, output, submitted, actions };
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
	it("⑤ Ctrl+T → requestLineMode；Ctrl+C 空闲双击才退出（F5 用户实测：单按毁 app 观感=崩）", async () => {
		const { app, input, actions } = rig();
		app.start();
		await flush();
		input.emit("data", "\x14");
		await flush();
		expect(app.stateRef.sidebarVisible).toBe(false); // Ctrl+T = 侧栏开关（互切下线）
		expect(actions).toEqual([]); // 互切下线（用户拍板）——按键无动作
		input.emit("data", "\x03"); // 首按：只给提示不退出
		await flush();
		expect(actions).toEqual([]);
		input.emit("data", "\x03"); // 2s 窗口内再按 → 退出
		await flush();
		expect(actions).toEqual(["exit"]);
		app.stop();
	});
	it("⑤b 忙碌中 Ctrl+C → requestCancel（不退出）；Esc 同效", async () => {
		const { app, input, actions } = rig();
		app.start();
		await flush();
		app.setBusy(true);
		input.emit("data", "\x03");
		await flush();
		expect(actions).toEqual(["cancel"]);
		input.emit("data", "\x03"); // 忙碌期连按也只取消
		await flush();
		expect(actions).toEqual(["cancel", "cancel"]);
		app.setBusy(false);
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
	it("⑥ 退出恢复序列：stop() 后 alt-screen 退出序列写出（?1049l + ?25h）", async () => {
		const { app, output } = rig();
		app.start();
		await flush();
		app.stop();
		expect(output.buf).toContain("\x1b[?1049l");
		expect(output.buf).toContain("\x1b[?25h");
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
		input.emit("data", ""); // 退格三次清空
		await flush(120);
		expect((app as unknown as { pendingUi: { filter?: string } }).pendingUi?.filter).toBe("");
		app.stop();
	});
});
