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
		requestLineMode: () => actions.push("line"),
		requestExit: () => actions.push("exit"),
		requestCancel: () => actions.push("cancel"),
		panelData: () => ({
			model: "glm-5.3",
			session: "test-sid",
			cwd: "D:/x",
			usedTokens: 42000,
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
	it("⑤ Ctrl+T → requestLineMode；Ctrl+C → requestExit", async () => {
		const { app, input, actions } = rig();
		app.start();
		await flush();
		input.emit("data", "\x14");
		await flush();
		expect(actions).toEqual(["line"]);
		input.emit("data", "\x03");
		await flush();
		expect(actions).toEqual(["line", "exit"]);
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
