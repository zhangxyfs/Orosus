/** 滚动流渲染器（TUI 批阶段三 F0——pi-tui tui-main-screen.ts 精简移植，spike 验证件）。
 *  蓝本：pi `tui-main-screen.ts` doRender(:247-616)。
 *  抄取：行数组即 framebuffer（render(width) → string[]）、firstChanged/lastChanged 局部重写
 *  （`\x1b[2K` 逐行清 + `\r\n` 推进）、**append 快路径**（只追加不回退——滚动流常态）、
 *  `?2026` 同步输出包裹每帧防撕裂、宽度变化 → 全量重绘（清屏+清滚动回退）、行数收缩清尾。
 *  不抄：kitty 图像、overlay 合成（滚动流无浮层）、CURSOR_MARKER、crash dump。
 *  本件即缺陷⑨（流式重绘内容重复）的替换引擎：上移行数不靠「已画视觉行数记账」——
 *  行数组下标对齐、折行由组件层 wrapText 先折成物理行再进帧缓冲，终端折行不进账
 *  （spike §四 对照实验：唯一标记全历史计数恰好 1）。 */

import { visibleWidth } from "./width.ts";

const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";

export class DiffScreen {
	private previousLines: string[] = [];
	private previousWidth = 0;
	private cursorRow = 0; // 终端光标当前所在的内容行下标
	private write: (data: string) => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	/** 渲染一帧：newLines = 组件树产出的完整行数组（契约：行内 SGR 状态自闭合——
	 *  theme 助手均自带收尾；不逐帧 map 补 reset，保持行字符串引用稳定供 diff 走引用相等快路径）。
	 *  返回写出字节数。 */
	render(newLines: string[], width: number): number {
		let out = SYNC_ON;

		if (this.previousLines.length === 0) {
			// 首帧：干净屏幕假设，直接全量写
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) out += "\r\n";
				out += newLines[i];
			}
			this.cursorRow = Math.max(0, newLines.length - 1);
			out += SYNC_OFF;
			this.commit(newLines, width);
			this.write(out);
			return out.length;
		}

		if (this.previousWidth !== width) {
			// 宽度变化 → 折行全变，全量重绘（清屏 + 清滚动回退）
			out += "\x1b[2J\x1b[H\x1b[3J";
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) out += "\r\n";
				out += newLines[i];
			}
			this.cursorRow = Math.max(0, newLines.length - 1);
			out += SYNC_OFF;
			this.commit(newLines, width);
			this.write(out);
			return out.length;
		}

		// 找变化区间
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldL = i < this.previousLines.length ? this.previousLines[i]! : "";
			const newL = i < newLines.length ? newLines[i]! : "";
			if (oldL !== newL) {
				if (firstChanged === -1) firstChanged = i;
				lastChanged = i;
			}
		}
		const appended = newLines.length > this.previousLines.length;
		if (appended && firstChanged === -1) {
			firstChanged = this.previousLines.length;
			lastChanged = newLines.length - 1;
		}
		if (firstChanged === -1) {
			out += SYNC_OFF;
			this.commit(newLines, width);
			if (out.length > SYNC_ON.length + SYNC_OFF.length) this.write(out);
			return 0;
		}

		// append 快路径：变化区间全部在旧内容之后 → 只追加（pi appendStart 同构）
		const appendStart = appended && firstChanged === this.previousLines.length && firstChanged > 0;
		const targetRow = appendStart ? firstChanged - 1 : firstChanged;
		const lineDiff = targetRow - this.cursorRow;
		if (lineDiff > 0) out += `\x1b[${lineDiff}B`;
		else if (lineDiff < 0) out += `\x1b[${-lineDiff}A`;
		out += appendStart ? "\r\n" : "\r";

		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) out += "\r\n";
			const line = newLines[i]!;
			// 超宽行截断防御（pi 直接 throw+crash log——框架化 F2 接线时定严格策略）
			out += "\x1b[2K" + (visibleWidth(line) > width ? line.slice(0, width) : line);
		}
		let finalRow = renderEnd;

		// 行数收缩：清掉多出的旧行
		if (this.previousLines.length > newLines.length) {
			const extra = this.previousLines.length - newLines.length;
			if (renderEnd < newLines.length - 1) {
				const down = newLines.length - 1 - renderEnd;
				out += `\x1b[${down}B`;
				finalRow = newLines.length - 1;
			}
			for (let i = 0; i < extra; i++) out += "\r\n\x1b[2K";
			out += `\x1b[${extra}A`;
		}

		out += SYNC_OFF;
		this.cursorRow = finalRow;
		this.commit(newLines, width);
		this.write(out);
		return out.length;
	}

	private commit(lines: string[], width: number): void {
		this.previousLines = lines;
		this.previousWidth = width;
	}

	/** 终态收尾：光标移到内容末行之下（退出前调用，防壳提示符覆写内容）。 */
	finish(): void {
		const target = this.previousLines.length;
		const diff = target - this.cursorRow;
		let out = "";
		if (diff > 0) out += `\x1b[${diff}B`;
		else if (diff < 0) out += `\x1b[${-diff}A`;
		out += "\r\n";
		this.write(out);
	}

	reset(): void {
		this.previousLines = [];
		this.previousWidth = 0;
		this.cursorRow = 0;
	}
}
