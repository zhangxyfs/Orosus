/** 全屏渲染器（TUI 批阶段三 F0——pi-tui tui-alt-screen.ts 精简移植，spike 验证件）。
 *  蓝本：pi `tui-alt-screen.ts` ENTER/EXIT(:61-64, :363-365, :387-399)。
 *  抄取：`\x1b[?1049h` 进 alt-screen + `\x1b[?7l` 关自动折行 + 清屏回 home + 隐藏光标；
 *  退出 = `?2026` 包裹 `?1049l` + 恢复自动折行 + 显示光标；屏幕缓冲 = 行数组
 *  （行数 = 终端行数），行级 diff 只重写变化行（绝对寻址 `\x1b[{row};1H` + `\x1b[2K` + 内容）；
 *  overlay 合成（sliceByColumn 按显示列贴入——斜杠菜单/右键菜单浮层）。
 *  不抄：鼠标子系统、kitty 图像、搜索/选择、滚动条。
 *  Windows conhost 两条防御（spike 执行期发现⑤，验证报告在案）：
 *  ① conhost 不实现 DECAWM（`?7l` 被忽略）——底行右角格永不写满（截到 cols−1 防滚屏）；
 *  ② 全帧重写逐行绝对寻址不用 `\r\n` 推进（写满任一末列后 `\r\n` 推进两行、整帧错位下移）。
 *  鼠标上报曾随 spike 第五轮开启（?1000/?1006），2026-09-21 用户拍板关闭待重开。 */

import { padToWidth, sliceByColumn, visibleWidth } from "./width.ts";

export const ENTER_ALT = "\x1b[?1049h\x1b[?7l\x1b[2J\x1b[H\x1b[?25l";
export const EXIT_ALT = "\x1b[?2026h\x1b[?1049l\x1b[?7h\x1b[0m\x1b[?25h\x1b[?2026l";

const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";

export interface OverlayFrame {
	lines: string[]; // 已渲染的浮层行（显示宽 ≤ width）
	row: number;
	col: number;
	width: number;
}

export class FullScreen {
	private previousScreen: string[] = [];
	private active = false;
	private write: (data: string) => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	enter(): void {
		if (this.active) return;
		this.active = true;
		this.previousScreen = [];
		this.write(ENTER_ALT);
	}

	exit(): void {
		if (!this.active) return;
		this.active = false;
		this.write(EXIT_ALT);
		this.previousScreen = [];
	}

	get isActive(): boolean {
		return this.active;
	}

	/**
	 * 渲染一帧：screen = 行数组（长度 = rows，每行显示宽 ≤ cols）。
	 * overlay 可选浮层——先合成进屏幕行再 diff。
	 * 行尾不填充空格：`\x1b[2K` 清行已覆盖擦除职责（铺底色的行由组件自行填足宽度）。
	 */
	render(screen: string[], rows: number, cols: number, overlay?: OverlayFrame): number {
		const buf: string[] = [];
		for (let r = 0; r < rows; r++) {
			const line = screen[r] ?? "";
			if (r === rows - 1) {
				// 底行右角格永不写满（conhost 无 DECAWM——文件头防御①）
				buf.push(visibleWidth(line) > cols - 1 ? sliceByColumn(line, 0, cols - 1) : line);
			} else {
				buf.push(visibleWidth(line) > cols ? sliceByColumn(line, 0, cols) : line);
			}
		}
		if (overlay) {
			for (let i = 0; i < overlay.lines.length; i++) {
				const r = overlay.row + i;
				if (r < 0 || r >= rows) continue;
				const base = buf[r]!;
				const before = sliceByColumn(base, 0, overlay.col);
				const after = sliceByColumn(base, overlay.col + overlay.width, cols - overlay.col - overlay.width);
				buf[r] =
					before +
					"\x1b[0m" +
					padToWidth(overlay.lines[i]!, overlay.width) +
					"\x1b[0m" +
					after;
			}
		}

		if (this.previousScreen.length !== rows) {
			// 首帧或行数变化（resize）→ 全量重写（逐行绝对寻址——文件头防御②）
			let out = SYNC_ON + "\x1b[H";
			for (let r = 0; r < rows; r++) {
				out += `\x1b[${r + 1};1H\x1b[2K${buf[r]}`;
			}
			out += SYNC_OFF;
			this.previousScreen = buf;
			this.write(out);
			return out.length;
		}

		// 行级 diff：只重写变化行（绝对寻址）
		let out = SYNC_ON;
		let wrote = false;
		for (let r = 0; r < rows; r++) {
			if (buf[r] === this.previousScreen[r]) continue;
			out += `\x1b[${r + 1};1H\x1b[2K${buf[r]}`;
			wrote = true;
		}
		out += SYNC_OFF;
		this.previousScreen = buf;
		if (wrote) this.write(out);
		return wrote ? out.length : 0;
	}

	/** 放置硬件光标（输入行回显用——IME 候选窗定位，pi CURSOR_MARKER 同义的直接版）。 */
	placeCursor(row: number, col: number, visible: boolean): void {
		this.write(`\x1b[${row + 1};${Math.max(1, col + 1)}H${visible ? "\x1b[?25h" : "\x1b[?25l"}`);
	}
}
