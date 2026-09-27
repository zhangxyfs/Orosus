/** 鼠标序列解析（m5 鼠标批 T0——kimi pi-tui tui-alt-screen.ts:952-979 parseWheelEvent + :708 吞非滚轮
 *  的精简独立件）。T0 只认滚轮；T4 在本件扩按下/拖动/松开。 */

export interface WheelEvent {
	direction: -1 | 1; // -1 = 向上滚，+1 = 向下滚（kimi 同号向）
	x: number; // 0 起列
	y: number; // 0 起行
	alt: boolean; // SGR 按键位 bit3（值 8）= Alt 修饰
}

export function parseWheel(seq: string): WheelEvent | undefined {
	// eslint-disable-next-line no-control-regex -- 鼠标序列本身就是控制字符转义序列（\x1b 起）
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(seq);
	if (sgr) {
		const button = Number.parseInt(sgr[1]!, 10);
		if ((button & 64) === 0) return undefined; // bit6 非置位 = 普通按键，不是滚轮
		const dir = button & 3;
		if (dir !== 0 && dir !== 1) return undefined; // 64+2/64+3 = 横向滚轮，忽略
		return {
			direction: dir === 0 ? -1 : 1,
			x: Number.parseInt(sgr[2]!, 10) - 1,
			y: Number.parseInt(sgr[3]!, 10) - 1,
			alt: (button & 8) !== 0,
		};
	}
	if (seq.length === 6 && seq.startsWith("\x1b[M")) {
		// 旧 X10 编码（老终端开了 ?1000 不开 ?1006 时的兜底——kimi :966-977 同款；字节偏移 32）
		const button = seq.charCodeAt(3) - 32;
		if ((button & 64) === 0) return undefined;
		const dir = button & 3;
		if (dir !== 0 && dir !== 1) return undefined;
		return { direction: dir === 0 ? -1 : 1, x: seq.charCodeAt(4) - 33, y: seq.charCodeAt(5) - 33, alt: (button & 8) !== 0 };
	}
	return undefined;
}

/** 是否鼠标序列（含非滚轮：点击/拖动/释放）——识别后调用方整吞（kimi :708 consume 同款）。 */
export function isMouseSequence(seq: string): boolean {
	// eslint-disable-next-line no-control-regex -- 鼠标序列本身就是控制字符转义序列（\x1b 起）
	return /^\x1b\[<[0-9;]*[Mm]$/.test(seq) || (seq.startsWith("\x1b[M") && seq.length === 6); // X10 恒 6 字节——切分器特判保证原子性
}

/** SGR 按钮事件（m5 鼠标批 T4——kimi parseSgrMouseEvent :1000-1009 同形）：按下建锚 / 拖动扩选 /
 *  松开结算。修饰位值：Shift=4 / Alt=8 / Ctrl=16（kimi :811-813 同式）——Shift+拖选走终端原生
 *  的让路口，本批解析不消费但解出备查。 */
export interface ButtonEvent {
	kind: "press" | "drag" | "release";
	button: number; // 主键号（0 左键 / 1 中键 / 2 右键）
	x: number; // 0 起列
	y: number; // 0 起行
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

export function parseButton(seq: string): ButtonEvent | undefined {
	// eslint-disable-next-line no-control-regex -- 鼠标序列本身就是控制字符转义序列（\x1b 起）
	const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(seq);
	if (!m) return undefined;
	const code = Number.parseInt(m[1]!, 10);
	if (code & 64) return undefined; // 滚轮/横滚归 parseWheel，不在此报
	const release = m[4] === "m";
	const motion = (code & 32) !== 0;
	if (release && motion) return undefined; // 释放+motion 组合不存在的防御
	return {
		kind: release ? "release" : motion ? "drag" : "press",
		button: code & 3,
		x: Number.parseInt(m[2]!, 10) - 1,
		y: Number.parseInt(m[3]!, 10) - 1,
		shift: (code & 4) !== 0,
		alt: (code & 8) !== 0,
		ctrl: (code & 16) !== 0,
	};
}
