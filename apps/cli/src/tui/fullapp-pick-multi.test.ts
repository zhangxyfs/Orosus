import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { FullApp, type FullAppIO, type PanelData } from "./fullapp.ts";
import { stripAnsi } from "./width.ts";

/** m5-ask-multi 全屏挑选窗测试——rig 为 fullapp.test.ts 同款最小形态（本文件聚焦增强面，
 *  不混既有 270 用例的时序负载）。 */

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
		permissionNext: () => "/permission ask-risky",
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
		requestCancel: () => actions.push("cancel"),
		queueItems: () => [...queue],
		recallQueued: () => queue.pop(),
		requestSteer: (texts) => actions.push(`steer:${texts.join("|")}`),
		panelData: () => defaultPanelData(),
		slashCommands: () => [{ name: "/help", desc: "帮助", long: "长说明" }],
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

const press = (input: FakeInput, x: number, y: number): void => { input.emit("data", `\x1b[<0;${x + 1};${y + 1}M`); };
const key = (input: FakeInput, seq: string): void => { input.emit("data", seq); };

describe("pickOverlay 增强面（m5-ask-multi——多选 + 自由输入；D1-D16）", () => {
	it("① 渲染：☐ 勾选前缀、✎ 其他行、✓ 确定尾行（D16）、标题尾拼「（可多选）」（D14）、multi 脚注措辞", async () => {
		const { app, output } = rig();
		app.start();
		await flush();
		const before = output.buf.length;
		void app.pickOverlay("发布前检查", ["lint", "test"], 0, undefined, { multi: true });
		await flush(80);
		const frame = stripAnsi(output.buf.slice(before));
		expect(frame).toContain("发布前检查（可多选）");
		expect(frame).toContain("☐");
		expect(frame).toContain("✎ 其他（自行输入）");
		expect(frame).toContain("✓ 确定");
		expect(frame).toContain("空格/Enter 勾选 · 确定行提交· Esc 取消"); // esc 尾段直拼（legacy pick.foot.esc 同款无空格）
		app.stop();
	});

	it("② 多选空格切换勾选、光标不动（D7/kimi）；确定行 Enter 提交勾选集 → string[]", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		const p = app.pickOverlay("选", ["甲", "乙", "丙"], 0, undefined, { multi: true });
		await flush();
		key(input, "\x1b[B"); await flush(); // ↓ 乙
		key(input, " "); await flush(); // 空格勾选——光标不动
		const pu = app.pendingUi;
		if (pu?.kind !== "pick") throw new Error("窗不应关");
		expect(pu.checked).toEqual([1]);
		expect(pu.sel).toBe(1); // 光标不动钉
		key(input, "\x1b[B"); key(input, "\x1b[B"); key(input, "\x1b[B"); await flush(); // ↓↓↓ 确定行（跳过其他行）
		key(input, "\r"); await flush(80);
		await expect(p).resolves.toEqual(["乙"]);
		expect(app.pendingUi).toBeUndefined();
		app.stop();
	});

	it("③ 零勾选在确定行 Enter = toast「未选择任何项」不关窗（D5）；Esc 清场 → undefined（MB-08 面）", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		const p = app.pickOverlay("选", ["甲", "乙", "丙"], 0, undefined, { multi: true });
		await flush();
		key(input, "\x1b[B"); key(input, "\x1b[B"); key(input, "\x1b[B"); key(input, "\x1b[B"); await flush(); // ↓↓↓↓ 确定行（3 项 multi：行域 5 行）
		key(input, "\r"); await flush(80);
		expect(app.state.toast?.text).toContain("未选择任何项");
		expect(app.pendingUi?.kind).toBe("pick"); // 不关窗
		key(input, "\x1b"); await flush(80);
		await expect(p).resolves.toBeUndefined(); // 列表态 Esc = 取消整窗（老语义零改）
		app.stop();
	});

	it("④ 单选：普通项 Enter 即答恰一项；其他行进输入态、非空 Enter 立即以文本为答案（窗关）", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		const p1 = app.pickOverlay("单", ["A", "B"], 0, undefined, {});
		await flush();
		key(input, "\r"); await flush(80);
		await expect(p1).resolves.toEqual(["A"]); // 单选恰一项（D11）
		const p2 = app.pickOverlay("单2", ["A", "B"], 0, undefined, {});
		await flush();
		key(input, "\x1b[B"); key(input, "\x1b[B"); await flush(); // ↓↓ 其他行
		const before = output.buf.length;
		key(input, "\r"); await flush(); // 进输入态（foot 换输入态键导引——截点须含此帧）
		key(input, "自"); key(input, "由"); await flush(); // 字符收
		let pu = app.pendingUi;
		if (pu?.kind !== "pick") throw new Error("输入态窗不应关");
		expect(pu.editing).toBe(true);
		expect(pu.customText).toBe("自由");
		key(input, "\x7f"); await flush(); // 退格
		pu = app.pendingUi;
		if (pu?.kind !== "pick") throw new Error("unreachable");
		expect(pu.customText).toBe("自");
		const frame = stripAnsi(output.buf.slice(before));
		expect(frame).toContain("自行输入：自"); // 输入行直显草稿
		expect(frame).toContain("Enter 确认 · Esc 返回列表"); // 输入态键导引（不写「Esc 取消」）
		key(input, "由"); key(input, "文本"); await flush();
		key(input, "\r"); await flush(80);
		await expect(p2).resolves.toEqual(["自由文本"]); // 单选自定义即答（kimi commitOtherInput）
		app.stop();
	});

	it("⑤ Esc 分层（opencode 双注册佐证）：输入态 Esc 回列表勾选/草稿保留、不落 busy 双击停止；列表态 Esc 走 MB-08", async () => {
		const { app, input, actions } = rig();
		app.start();
		await flush();
		app.setBusy(true);
		const p = app.pickOverlay("选", ["甲", "乙"], 0, undefined, { multi: true });
		await flush();
		key(input, " "); await flush(); // 勾甲
		key(input, "\x1b[B"); key(input, "\x1b[B"); await flush(); // ↓↓ 其他行
		key(input, "\r"); await flush(); // 进输入态
		key(input, "草"); key(input, "稿"); await flush();
		key(input, "\x1b"); await flush(80); // 输入态 Esc——回列表（非取消）
		let pu = app.pendingUi;
		if (pu?.kind !== "pick") throw new Error("输入态 Esc 不应关窗");
		expect(pu.editing).toBe(false);
		expect(pu.checked).toEqual([0]); // 勾选保留
		expect(pu.customText).toBe("草稿"); // 草稿保留
		expect(app.state.toast).toBeUndefined(); // 不落「再按一次 Esc」提示
		key(input, "\x1b"); await flush(80); // 列表态 Esc = 取消整窗
		await expect(p).resolves.toBeUndefined();
		expect(actions).toEqual([]); // 关窗 Esc 不拼进双击停止序列（⑤bb-c 同款纪律）
		app.setBusy(false);
		app.stop();
	});

	it("⑥ 多选其他行三态：未勾进输入 / 已勾 Enter 取消勾选（kimi :301-307）/ 提交时自定义恒尾", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		const p = app.pickOverlay("选", ["甲", "乙"], 0, undefined, { multi: true });
		await flush();
		key(input, "\x1b[B"); key(input, "\x1b[B"); await flush(); // ↓↓ 其他行
		key(input, "\r"); await flush(); // 进输入态（未勾）
		key(input, "旧"); key(input, "值"); key(input, "\r"); await flush(); // 非空 Enter——单槽提交回列表
		let pu = app.pendingUi;
		if (pu?.kind !== "pick") throw new Error("多选输入 Enter 回列表不关窗");
		expect(pu.customCommitted).toBe("旧值");
		expect(stripAnsi(output.buf.slice(-4000))).toContain("☑ ✎ 旧值"); // 行显提交态
		key(input, "\r"); await flush(); // 其他行已勾 Enter = 取消勾选
		pu = app.pendingUi;
		if (pu?.kind !== "pick") throw new Error("unreachable");
		expect(pu.customCommitted).toBeUndefined();
		key(input, "\r"); await flush(); // 再进输入态（草稿保留续编——方案「退出输入态不清 customText」）
		key(input, "新"); key(input, "值"); key(input, "\r"); await flush(); // 单槽覆盖为「旧值新值」（续编追加）
		key(input, "\x1b[B"); key(input, "\r"); await flush(80); // ↓ 确定行提交
		await expect(p).resolves.toEqual(["旧值新值"]); // 自定义恒尾（「其他」恒尾语义）
		app.stop();
	});

	it("⑦ 过滤共存（≥12 项）：打字过滤照旧、「其他」「确定」两合成行恒显（D8）、结算跟原始索引（CTU-08）", async () => {
		const { app, input, output } = rig();
		app.start();
		await flush();
		const items = Array.from({ length: 14 }, (_, i) => `v${i}`);
		const p = app.pickOverlay("选", items, 0, undefined, { multi: true });
		await flush();
		key(input, "1"); key(input, "3"); await flush(); // 过滤词 "13"——唯一命中 v13（原始下标 13）
		const frame = stripAnsi(output.buf.slice(-4000));
		expect(frame).toContain("✎ 其他（自行输入）"); // 合成行恒显不参与过滤
		expect(frame).toContain("✓ 确定");
		expect(frame).toContain("1/14"); // 过滤计数段
		key(input, "\r"); await flush(); // Enter 勾选 v13（原始索引 13——按携带索引非值回查）
		key(input, "\x1b[B"); key(input, "\x1b[B"); await flush(); // ↓↓ 确定行（过滤后行域 = 1 项 + 两合成行）
		key(input, "\r"); await flush(80);
		await expect(p).resolves.toEqual(["v13"]);
		app.stop();
	});

	it("⑧ 鼠标（m5-ask-multi T2）：multi 点击行 = 切换勾选、点击确定行 = 提交；单选点击普通行 = 选定", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		// 几何与命中共源（pickOverlayGeo/布局帧同源口径）
		const { streamH, queue, leftW } = app.frame.layoutFrame();
		const divRow = streamH + (queue.length === 0 ? 0 : queue.length + 1);
		expect(leftW).toBeGreaterThan(20);
		const p = app.pickOverlay("选", ["甲", "乙", "丙"], 0, undefined, { multi: true });
		await flush(80);
		const top = divRow - 9; // 3 项 multi：4 固定行 + 5 内容行（3 项 + 其他 + 确定）
		press(input, 3, top + 2); await flush(); // 点击甲行——切换勾选
		let pu = app.pendingUi;
		if (pu?.kind !== "pick") throw new Error("点击行不应关窗");
		expect(pu.checked).toEqual([0]);
		expect(pu.sel).toBe(0); // 焦点随点击
		press(input, 3, top + 6); await flush(80); // 点击确定行——提交
		await expect(p).resolves.toEqual(["甲"]);
		const p2 = app.pickOverlay("单", ["A", "B"], 0, undefined, {});
		await flush(80);
		press(input, 3, divRow - 4); await flush(80); // 单选 2 项：总 7 行，B 行 = top+3 = divRow−4——点击 = 选定
		await expect(p2).resolves.toEqual(["B"]);
		app.stop();
	});
});

describe("pickOverlay 老面零变（m5-ask-multi 回归钉——33 处消费方零感知）", () => {
	it("⑨ 无 opts：Enter 结算原始下标 number、Esc → undefined——签名与语义一字不动", async () => {
		const { app, input } = rig();
		app.start();
		await flush();
		const p = app.pickOverlay("老面", ["x", "y", "z"]);
		await flush();
		key(input, "\x1b[B"); await flush();
		key(input, "\r"); await flush(80);
		await expect(p).resolves.toBe(1); // number——非 string[]
		app.stop();
	});
});
