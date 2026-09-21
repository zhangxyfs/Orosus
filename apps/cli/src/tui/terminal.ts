/** 终端接管层（TUI 批阶段三 F0——pi-tui terminal.ts 精简移植，spike 验证件）。
 *  蓝本：pi `terminal.ts` ProcessTerminal(:137-203, :422-468) + `stdin-buffer.ts` 序列切分全文。
 *  抄取：raw 保存/恢复（wasRaw）、bracketed paste 开关（?2004h/l）、resize 经 stdout 'resize'
 *  事件、stdin 序列切分（CSI/OSC/APC/SS3/meta 完整性判定 + ESC 时间窗 + paste 直通）、退出时
 *  stdin pause（防缓冲输入被壳层误读）。
 *  不抄：kitty keyboard protocol 协商、modifyOtherKeys、OSC 配色查询、native EVTI helper——
 *  ConPTY 下修饰键裸 setRawMode 即达（spike S5 实证，验证报告 §二「不适用」表）。 */

export interface TermIO {
	input: NodeJS.ReadStream;
	output: NodeJS.WriteStream;
}

const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function isCompleteSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(ESC)) return "complete";
	if (data.length === 1) return "incomplete";
	const after = data.slice(1);
	if (after.startsWith("[")) {
		// CSI：终字节 0x40–0x7E
		if (data.length < 3) return "incomplete";
		const c = data.charCodeAt(data.length - 1);
		return c >= 0x40 && c <= 0x7e ? "complete" : "incomplete";
	}
	if (after.startsWith("]") || after.startsWith("_") || after.startsWith("P")) {
		return data.endsWith("\x07") || data.endsWith("\x1b\\") ? "complete" : "incomplete";
	}
	if (after.startsWith("O")) return after.length >= 2 ? "complete" : "incomplete";
	return "complete"; // meta（ESC + 单字符）与未知序列按完整处理
}

function extractSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;
	while (pos < buffer.length) {
		const rest = buffer.slice(pos);
		if (!rest.startsWith(ESC)) {
			// 非转义：取单个码点（代理对整取）
			const cp = rest.codePointAt(0)!;
			const len = cp > 0xffff ? 2 : 1;
			sequences.push(rest.slice(0, len));
			pos += len;
			continue;
		}
		let end = 1;
		while (end <= rest.length && isCompleteSequence(rest.slice(0, end)) === "incomplete") end++;
		if (end > rest.length) return { sequences, remainder: rest };
		sequences.push(rest.slice(0, end));
		pos += end;
	}
	return { sequences, remainder: "" };
}

export class Term {
	private wasRaw = false;
	private buffer = "";
	private timer: NodeJS.Timeout | undefined;
	private inputCb: ((seq: string) => void) | undefined;
	private pasteCb: ((text: string) => void) | undefined;
	private resizeCb: (() => void) | undefined;
	private inPaste = false;
	private pasteBuf = "";
	readonly escWindowMs: number;
	private io: TermIO;

	constructor(io: TermIO = { input: process.stdin, output: process.stdout }, opts?: { escWindowMs?: number }) {
		this.io = io;
		this.escWindowMs = opts?.escWindowMs ?? 30; // 与 T0 keys.ts 常量同口径
	}

	get columns(): number {
		return this.io.output.columns || 80;
	}
	get rows(): number {
		return this.io.output.rows || 24;
	}

	private onData = (chunk: string | Buffer): void => {
		const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.buffer += str;

		// bracketed paste 直通（pi StdinBuffer 同构）
		if (this.inPaste) {
			this.pasteBuf += this.buffer;
			this.buffer = "";
			const end = this.pasteBuf.indexOf(PASTE_END);
			if (end === -1) return;
			const content = this.pasteBuf.slice(0, end);
			const rest = this.pasteBuf.slice(end + PASTE_END.length);
			this.inPaste = false;
			this.pasteBuf = "";
			this.pasteCb?.(content);
			if (rest) {
				this.buffer = rest;
			} else return;
		}
		const ps = this.buffer.indexOf(PASTE_START);
		if (ps !== -1) {
			const before = this.buffer.slice(0, ps);
			this.inPaste = true;
			this.pasteBuf = this.buffer.slice(ps + PASTE_START.length);
			this.buffer = "";
			for (const s of extractSequences(before).sequences) this.inputCb?.(s);
			const end = this.pasteBuf.indexOf(PASTE_END);
			if (end !== -1) {
				const content = this.pasteBuf.slice(0, end);
				const rest = this.pasteBuf.slice(end + PASTE_END.length);
				this.inPaste = false;
				this.pasteBuf = "";
				this.pasteCb?.(content);
				this.buffer = rest;
			} else return;
		}

		const { sequences, remainder } = extractSequences(this.buffer);
		this.buffer = remainder;
		for (const s of sequences) this.inputCb?.(s);
		if (this.buffer) {
			// 挂起的不完整序列：孤 ESC 用 escWindowMs 判定单 Esc，其余给 50ms 等续包
			const wait = this.buffer === ESC ? this.escWindowMs : 50;
			this.timer = setTimeout(() => {
				this.timer = undefined;
				const flushed = this.buffer;
				this.buffer = "";
				if (flushed) this.inputCb?.(flushed);
			}, wait);
			this.timer.unref?.();
		}
	};

	onInput(cb: (seq: string) => void): void {
		this.inputCb = cb;
	}
	onPaste(cb: (text: string) => void): void {
		this.pasteCb = cb;
	}
	onResize(cb: () => void): void {
		this.resizeCb = cb;
	}

	/** 进入接管态：raw + bracketed paste + resize 监听。非 TTY（headless 测试）只挂输出。 */
	start(): void {
		const { input, output } = this.io;
		if (input.isTTY !== true) {
			output.on("resize", this.handleResize);
			return;
		}
		this.wasRaw = (input as unknown as { isRaw?: boolean }).isRaw ?? false;
		input.setRawMode?.(true);
		input.setEncoding("utf8");
		input.resume();
		output.write("\x1b[?2004h"); // bracketed paste on
		input.on("data", this.onData);
		output.on("resize", this.handleResize);
	}

	private handleResize = (): void => {
		this.resizeCb?.();
	};

	/** 退出接管态：恢复序列必写（pi stop() 同构——?2004l + raw 还原 + stdin pause）。 */
	stop(): void {
		const { input, output } = this.io;
		if (input.isTTY !== true) {
			output.removeListener("resize", this.handleResize);
			return;
		}
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		output.write("\x1b[?2004l"); // bracketed paste off
		input.removeListener("data", this.onData);
		output.removeListener("resize", this.handleResize);
		input.pause();
		if (input.setRawMode) input.setRawMode(this.wasRaw);
	}

	private writeMsTotal = 0;

	write(data: string): void {
		const t0 = performance.now();
		this.io.output.write(data);
		this.writeMsTotal += performance.now() - t0;
	}

	/** 累计写出耗时（传输回压与引擎计算分离打点——spike bench 的 renderNet 口径）。 */
	get writeMs(): number {
		return this.writeMsTotal;
	}
}
