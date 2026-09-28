/** 滚动流渲染器（TUI 批阶段三 F0——pi-tui tui-main-screen.ts 精简移植，spike 验证件）。
 *  蓝本：pi `tui-main-screen.ts` doRender(:247-616)。
 *  抄取：行数组即 framebuffer（render(width) → string[]）、firstChanged/lastChanged 局部重写
 *  （`\x1b[2K` 逐行清 + `\r\n` 推进）、**append 快路径**（只追加不回退——滚动流常态）、
 *  `?2026` 同步输出包裹每帧防撕裂、宽度变化 → 全量重绘（清屏+清滚动回退）、行数收缩清尾。
 *  不抄：kitty 图像、overlay 合成（滚动流无浮层）、CURSOR_MARKER、crash dump。
 *  本件即缺陷⑨（流式重绘内容重复）的替换引擎：上移行数不靠「已画视觉行数记账」——
 *  行数组下标对齐、折行由组件层 wrapText 先折成物理行再进帧缓冲，终端折行不进账
 *  （spike §四 对照实验：唯一标记全历史计数恰好 1）。 */

import { truncateToWidth } from "./width.ts";

const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";

export class DiffScreen {
	private previousLines: string[] = [];
	private previousWidth = 0;
	private cursorRow = 0; // 终端光标当前所在的内容行下标
	// CTW-11（2026-09-28）：首帧哨兵独立化——previousLines.length === 0 曾兼任「尚未渲染」判据，但渲染过
	// 空帧后它同样为空：下一非空帧被误判首帧走「干净屏幕假设」无定位直写，写进残留行原位（旧行比新行长
	// 时尾部残字永久留屏，只能靠宽度变化全量重绘自愈）
	private hasRendered = false;
	private write: (data: string) => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	/** 渲染一帧：newLines = 组件树产出的完整行数组（契约：行内 SGR 状态自闭合——
	 *  theme 助手均自带收尾；不逐帧 map 补 reset，保持行字符串引用稳定供 diff 走引用相等快路径）。
	 *  返回写出字节数。 */
	render(newLines: string[], width: number): number {
		let out = SYNC_ON;

		if (!this.hasRendered) {
			// 首帧：干净屏幕假设，直接全量写（CTW-02：超宽行同样过显示列截断守卫——
			// 行源不全是「先折成物理行再进帧」的组件产物，write 直写行可超宽）
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) out += "\r\n";
				out += truncateToWidth(newLines[i]!, width);
			}
			this.cursorRow = Math.max(0, newLines.length - 1);
			out += SYNC_OFF;
			this.commit(newLines, width);
			this.write(out);
			return out.length;
		}

		if (this.previousWidth !== width) {
			// 宽度变化 → 折行全变，全量重绘（清屏 + 清滚动回退）；CTW-02：重绘行过显示列截断守卫
			// （定格行按旧宽冻结、不随宽度回流，原样写出会硬折行 → 物理行数 > 数组行数、记账失准）
			out += "\x1b[2J\x1b[H\x1b[3J";
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) out += "\r\n";
				out += truncateToWidth(newLines[i]!, width);
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
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		// CTW-01 修复（2026-09-28 code review）：纯前缀收缩（firstChanged > renderEnd、写循环零迭代）时
		// targetRow 原取 firstChanged，比清尾不变式的基线（renderEnd）低一行——首条残留行恰在
		// firstChanged 行被跳过不清，且 cursorRow 记账与物理光标永久差一行。钳到 renderEnd 对齐
		// 「清尾循环从最后已写内容之下开始清」的不变式（正常区间 firstChanged ≤ renderEnd，取 min 不变行为）
		const targetRow = appendStart ? firstChanged - 1 : Math.max(0, Math.min(firstChanged, renderEnd));
		const lineDiff = targetRow - this.cursorRow;
		if (lineDiff > 0) out += `\x1b[${lineDiff}B`;
		else if (lineDiff < 0) out += `\x1b[${-lineDiff}A`;
		out += appendStart ? "\r\n" : "\r";

		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) out += "\r\n";
			const line = newLines[i]!;
			// CTW-02 修复：超宽行按显示列截断（原 line.slice(0, width) 按 UTF-16 码元切——CJK 行实际
			// 显示宽可达 2×width 列、代理对与 SGR 序列可被拦腰劈断）；truncateToWidth 末尾补 reset 防色漏
			out += "\x1b[2K" + truncateToWidth(line, width);
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
			if (renderEnd < 0) {
				// CTW-11（2026-09-28）：收缩到完全空帧——待清基线应为 renderEnd+1 = 0 行，但光标已被
				// CTW-01 钳制钉在物理 0 行：第 0 行原位清 + 下移清 extra-1 行。旧循环「先 \r\n 再清」
				// 永远漏掉第 0 行；也不能按旧次数多下移一行凑数——帧底再 \r\n 会触发终端滚动把整帧
				// 顶走。finalRow 钳回物理行 0：cursorRow 记 -1 会让下一帧相对位移整体错一行（CTW-01 同族）
				out += "\x1b[2K";
				for (let i = 1; i < extra; i++) out += "\r\n\x1b[2K";
				if (extra > 1) out += `\x1b[${extra - 1}A`;
				finalRow = 0;
			} else {
				for (let i = 0; i < extra; i++) out += "\r\n\x1b[2K";
				out += `\x1b[${extra}A`;
			}
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
		this.hasRendered = true; // CTW-11：首帧哨兵与 previousLines 是否为空解耦（空帧也是「已渲染」）
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
		this.hasRendered = false; // CTW-11：重置回「干净屏幕假设」
	}
}
