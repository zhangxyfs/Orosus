import { describe, it, expect } from "vitest";
import { isPrintable, matchKey } from "./keymatch.ts";

describe("按键匹配表（TUI 批阶段三 F0——T0 解析器的 shift 修饰扩展位落地）", () => {
	it("① 基础形态与 shift 修饰：方向键 / shift+方向 / shift+tab / page / alt 组合 / alt+enter", () => {
		expect(matchKey("\x1b[A")).toBe("up");
		expect(matchKey("\x1b[1;2A")).toBe("shift+up");
		expect(matchKey("\x1b[1;2D")).toBe("shift+left");
		expect(matchKey("\x1b[Z")).toBe("shift+tab");
		expect(matchKey("\x1b[5;2~")).toBe("shift+pageUp");
		expect(matchKey("\x1bv")).toBe("alt+v");
		expect(matchKey("\x1b\r")).toBe("alt+enter");
		expect(matchKey("\r")).toBe("enter");
		expect(matchKey("\x01")).toBe("ctrl+a");
		expect(matchKey("\x0e")).toBe("ctrl+n"); // M4-3 T1d 引导「下一步/完成」
		expect(matchKey("\x0f")).toBe("ctrl+o"); // 2026-09-27 修复回归钉：压缩摘要查看口字节映射曾漏表——全屏 Ctrl+O 出生即静默失效
		expect(matchKey("\x11")).toBe("ctrl+q"); // M4-3 T1d 引导退出（仅第 1 页）
	});
	it("② 可打印判定：普通字符/CJK 可打印，控制码与转义序列不可打印", () => {
		expect(isPrintable("a")).toBe(true);
		expect(isPrintable("中")).toBe(true);
		expect(isPrintable("\x7f")).toBe(false);
		expect(isPrintable("\x1b[A")).toBe(false);
	});
	it("③ Shift+Enter 换行（2026-09-27 用户拍板）：裸 LF 与 CSI-u 两形态 → shift+enter；\\r 仍 = enter（提交）", () => {
		expect(matchKey("\n")).toBe("shift+enter"); // 裸 VT 多数终端 Shift+Enter 落 LF；原映射 enter 会误提交
		expect(matchKey("\x1b[13;2u")).toBe("shift+enter"); // win32-input / kitty 键盘模式的终端
		expect(matchKey("\r")).toBe("enter"); // 提交键不变
		expect(matchKey("\x1b\r")).toBe("alt+enter"); // Alt+Enter 换行原键保留
	});
});

describe("m5-hooks T10：Ctrl+H 键位拆分（\x7f 独占 backspace、\x08 归 ctrl+h + CSI-u 形）", () => {
	it("⌫ 删字不误开窗：\x7f 仍是 backspace；\x08 归 ctrl+h（原双字节都映射 backspace——Ctrl+H 必撞退格）", () => {
		expect(matchKey("\x7f")).toBe("backspace");
		expect(matchKey("\x08")).toBe("ctrl+h");
	});
	it("CSI-u 形（kitty/win32-input 协议终端）：\x1b[104;5u 同归 ctrl+h（shift+enter 的 \x1b[13;2u 同族）", () => {
		expect(matchKey("\x1b[104;5u")).toBe("ctrl+h");
	});
});
