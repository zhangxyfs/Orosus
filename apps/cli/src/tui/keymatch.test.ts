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
		expect(matchKey("\x11")).toBe("ctrl+q"); // M4-3 T1d 引导退出（仅第 1 页）
	});
	it("② 可打印判定：普通字符/CJK 可打印，控制码与转义序列不可打印", () => {
		expect(isPrintable("a")).toBe(true);
		expect(isPrintable("中")).toBe(true);
		expect(isPrintable("\x7f")).toBe(false);
		expect(isPrintable("\x1b[A")).toBe(false);
	});
});
