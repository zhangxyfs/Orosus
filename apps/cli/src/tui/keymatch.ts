/** 按键匹配表（TUI 批阶段三 F0——pi keys.ts 的 matchesKey 形态精简，spike 验证件）。
 *  T0 keys.ts 的 KeyEvent 不建模 shift 修饰（T0 文件头预留「框架化阶段在已知表扩展」——
 *  本件即扩展位的全屏模式落地）：`\x1b[1;2A` 系 shift 修饰 + `\x1b[Z` shift+tab + Alt+Enter。
 *  返回值 = 规范化键名（"up" / "shift+up" / "alt+v" / "enter" / 可打印字符原文）。 */

const KEY_TABLE: Record<string, string> = {
	"\r": "enter",
	"\n": "enter",
	"\x7f": "backspace",
	"\x08": "backspace",
	"\t": "tab",
	"\x1b[Z": "shift+tab",
	"\x1b": "escape",
	"\x1b[A": "up",
	"\x1b[B": "down",
	"\x1b[C": "right",
	"\x1b[D": "left",
	"\x1bOA": "up",
	"\x1bOB": "down",
	"\x1bOC": "right",
	"\x1bOD": "left",
	"\x1b[H": "home",
	"\x1b[F": "end",
	"\x1b[5~": "pageUp",
	"\x1b[6~": "pageDown",
	"\x1b[3~": "delete",
	"\x1b[1;2A": "shift+up",
	"\x1b[1;2B": "shift+down",
	"\x1b[1;2C": "shift+right",
	"\x1b[1;2D": "shift+left",
	"\x1b[5;2~": "shift+pageUp",
	"\x1b[6;2~": "shift+pageDown",
	"\x1b[a": "shift+up", // 部分终端旧形态
	"\x1b[b": "shift+down",
	"\x01": "ctrl+a",
	"\x03": "ctrl+c",
	"\x04": "ctrl+d",
	"\x05": "ctrl+e",
	"\x0b": "ctrl+k",
	"\x0e": "ctrl+n", // M4-3 T1d 引导弹窗「下一步/完成」（SW-22 统一语义）
	"\x11": "ctrl+q", // M4-3 T1d 引导弹窗退出（仅第 1 页可用——/quit 同款）
	"\x14": "ctrl+t",
	"\x15": "ctrl+u",
	"\x17": "ctrl+w",
	"\x1b\r": "alt+enter", // Alt+Enter 换行（多行输入）
};

/** 规范化：先查表；`\x1b<单字符>` → alt+ch；单可打印字符原样；其余 → 原串（调用方吞掉）。 */
export function matchKey(seq: string): string {
	const hit = KEY_TABLE[seq];
	if (hit) return hit;
	if (seq.length === 2 && seq[0] === "\x1b") {
		const ch = seq[1]!;
		if (ch >= " " && ch !== "\x7f") return `alt+${ch.toLowerCase()}`;
	}
	return seq;
}

/** 是否可打印字符输入（单码点、非控制符、非转义前缀）。 */
export function isPrintable(seq: string): boolean {
	if (seq.startsWith("\x1b")) return false;
	const cp = seq.codePointAt(0)!;
	return cp >= 0x20 && cp !== 0x7f;
}
