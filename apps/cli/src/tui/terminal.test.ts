import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Term } from "./terminal.ts";

/** fake TTY 输入流：EventEmitter + isTTY + setRawMode 桩。 */
type FakeInput = NodeJS.ReadStream & { lines: string[] };
function fakeInput(): FakeInput {
	const em = new EventEmitter() as FakeInput;
	em.isTTY = true;
	em.lines = [];
	em.setRawMode = ((m: boolean): FakeInput => {
		em.lines.push(`raw:${m}`);
		return em;
	}) as FakeInput["setRawMode"];
	em.setEncoding = ((): FakeInput => em) as FakeInput["setEncoding"];
	em.resume = ((): FakeInput => em) as FakeInput["resume"];
	em.pause = ((): FakeInput => em) as FakeInput["pause"];
	return em;
}

function fakeOutput(): NodeJS.WriteStream & { buf: string } {
	const em = new EventEmitter() as NodeJS.WriteStream & { buf: string };
	em.buf = "";
	em.columns = 80;
	em.rows = 24;
	em.write = ((s: string) => {
		em.buf += s;
		return true;
	}) as NodeJS.WriteStream["write"];
	return em;
}

describe("终端接管层（TUI 批阶段三 F0——pi ProcessTerminal + StdinBuffer 移植）", () => {
	it("① 序列切分：跨 chunk CSI（\\x1b 与 [A 分包）+ 单 ESC 时间窗 + meta 组合", async () => {
		const input = fakeInput();
		const output = fakeOutput();
		const term = new Term({ input, output }, { escWindowMs: 5 });
		const got: string[] = [];
		term.onInput((s) => got.push(s));
		term.start();
		input.emit("data", "\x1b");
		expect(got).toEqual([]); // 挂起等续包
		input.emit("data", "[A");
		expect(got).toEqual(["\x1b[A"]); // 拼成方向键
		input.emit("data", "\x1bv"); // Alt+V 单 chunk
		expect(got).toEqual(["\x1b[A", "\x1bv"]);
		input.emit("data", "\x1b"); // 孤 ESC → 时间窗后判单 Esc
		await new Promise((r) => setTimeout(r, 20));
		expect(got).toEqual(["\x1b[A", "\x1bv", "\x1b"]);
		term.stop();
		expect(output.buf).toContain("\x1b[?2004h"); // start 开 paste
		expect(output.buf).toContain("\x1b[?2004l"); // stop 关 paste
		expect(input.lines).toEqual(["raw:true", "raw:false"]);
	});
	it("①b ESC ESC 拆分：双击 Esc 同 chunk 不再捆成未知序列整吞（2026-09-23 用户拍板——双击停止生成时好时坏根因）", async () => {
		const input = fakeInput();
		const output = fakeOutput();
		const term = new Term({ input, output }, { escWindowMs: 5 });
		const got: string[] = [];
		term.onInput((s) => got.push(s));
		term.start();
		input.emit("data", "\x1b\x1b"); // 双击同 chunk：第一拍立即出，第二拍走孤 ESC 时间窗
		expect(got).toEqual(["\x1b"]);
		await new Promise((r) => setTimeout(r, 20));
		expect(got).toEqual(["\x1b", "\x1b"]);
		input.emit("data", "\x1b\x1b[A"); // Esc 后快按 ↓：首 ESC 独立成键，方向键照常拼装
		expect(got).toEqual(["\x1b", "\x1b", "\x1b", "\x1b[A"]);
		input.emit("data", "\x1b\x1b\x1b"); // 三连按：两拍立即 + 一拍时间窗
		expect(got).toEqual(["\x1b", "\x1b", "\x1b", "\x1b[A", "\x1b", "\x1b"]);
		await new Promise((r) => setTimeout(r, 20));
		expect(got).toEqual(["\x1b", "\x1b", "\x1b", "\x1b[A", "\x1b", "\x1b", "\x1b"]);
		term.stop();
	});
	it("② bracketed paste 直通（内容不拆成按键）+ paste 后按键恢复解析", () => {
		const input = fakeInput();
		const term = new Term({ input, output: fakeOutput() }, { escWindowMs: 5 });
		const keys: string[] = [];
		const pastes: string[] = [];
		term.onInput((s) => keys.push(s));
		term.onPaste((t) => pastes.push(t));
		term.start();
		input.emit("data", "a\x1b[200~多行\n内容\x1b[201~b");
		expect(pastes).toEqual(["多行\n内容"]);
		expect(keys).toEqual(["a", "b"]);
		term.stop();
	});
});
