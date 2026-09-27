/** 鼠标序列解析（m5 鼠标批 T0——kimi pi-tui tui-alt-screen.ts:952-979 parseWheelEvent + :708 吞非滚轮
 *  的精简独立件）。T0 只认滚轮；T4 在本件扩按下/拖动/松开。 */

export interface WheelEvent {
	direction: -1 | 1; // -1 = 向上滚，+1 = 向下滚（kimi 同号向）
	x: number; // 0 起列
	y: number; // 0 起行
	alt: boolean; // SGR 按键位 bit3（值 8）= Alt 修饰
}

export function parseWheel(seq: string): WheelEvent | undefined {
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
	return /^\x1b\[<[0-9;]*[Mm]$/.test(seq) || (seq.startsWith("\x1b[M") && seq.length === 6); // X10 恒 6 字节——切分器特判保证原子性
}
