import { describe, it, expect } from "vitest";
import { FullScreen, ENTER_ALT, EXIT_ALT, MOUSE_OFF, MOUSE_ON_ALL_MOTION, MOUSE_ON_BUTTON_MOTION, CRASH_RESTORE, mouseOnFor } from "./fullscreen.ts";

describe("鼠标上报开关（m5 鼠标批 T3——kimi 两档照抄：全动/按钮级 + 多路复用器降级）", () => {
	it("① mouseOnFor：普通环境 = 全动四段（1000/1002/1003/1006）；TMUX/STY/ZELLIJ/TERM 前缀 = 按钮级三段（去 1003）", () => {
		expect(MOUSE_ON_ALL_MOTION).toBe("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");
		expect(MOUSE_ON_BUTTON_MOTION).toBe("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
		expect(mouseOnFor({})).toBe(MOUSE_ON_ALL_MOTION);
		expect(mouseOnFor({ TMUX: "1" })).toBe(MOUSE_ON_BUTTON_MOTION);
		expect(mouseOnFor({ STY: "x" })).toBe(MOUSE_ON_BUTTON_MOTION);
		expect(mouseOnFor({ ZELLIJ: "0" })).toBe(MOUSE_ON_BUTTON_MOTION);
		expect(mouseOnFor({ TERM: "screen.xterm" })).toBe(MOUSE_ON_BUTTON_MOTION);
		expect(mouseOnFor({ TERM: "tmux-256color" })).toBe(MOUSE_ON_BUTTON_MOTION);
		expect(mouseOnFor({ TERM: "xterm-256color" })).toBe(MOUSE_ON_ALL_MOTION);
	});
	it("② MOUSE_OFF 全关四段逆序；ENTER_ALT 尾接选中档开串；EXIT_ALT 关鼠标在退屏（?1049l）之前", () => {
		expect(MOUSE_OFF).toBe("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
		expect(ENTER_ALT.startsWith("\x1b[?1049h")).toBe(true); // 切屏段不动（既有断言兼容）
		expect(ENTER_ALT.endsWith(MOUSE_ON_ALL_MOTION) || ENTER_ALT.endsWith(MOUSE_ON_BUTTON_MOTION)).toBe(true); // 按模块加载时 env 定档
		expect(EXIT_ALT.indexOf(MOUSE_OFF)).toBeGreaterThanOrEqual(0);
		expect(EXIT_ALT.indexOf(MOUSE_OFF)).toBeLessThan(EXIT_ALT.indexOf("\x1b[?1049l")); // kimi 顺序：关鼠标在退屏前
	});
	it("③ 崩溃恢复串 CRASH_RESTORE 与 MOUSE_OFF 同文件同源：光标/折行/bracketed paste/鼠标恢复段俱全（?1049l 由钩子按 isActive 追加）", () => {
		expect(CRASH_RESTORE).toBe("\x1b[?25h\x1b[?2004l\x1b[?7h" + MOUSE_OFF);
	});
});

describe("全屏渲染器（TUI 批阶段三 F0——alt-screen 行级 diff + overlay 合成）", () => {
	it("① 首帧逐行绝对寻址（不用 \\r\\n 推进——conhost 无 DECAWM 防御）；diff 只重写变化行", () => {
		const frames: string[] = [];
		const f = new FullScreen((s) => frames.push(s));
		const scr = (rows: string[]) => rows;
		f.render(scr(["aa", "bb", "cc"]), 3, 10);
		const first = frames[0]!;
		expect(first).toContain("\x1b[1;1H\x1b[2Kaa");
		expect(first).toContain("\x1b[2;1H\x1b[2Kbb");
		expect(first).toContain("\x1b[3;1H\x1b[2Kcc");
		expect(first).not.toContain("aa\r\nbb"); // 无 \r\n 推进
		// 第二帧只改第 2 行 → 只重写第 2 行
		f.render(scr(["aa", "BB", "cc"]), 3, 10);
		const second = frames[1]!;
		expect(second).toContain("\x1b[2;1H\x1b[2KBB");
		expect(second).not.toContain("\x1b[1;1H");
		expect(second).not.toContain("\x1b[3;1H");
		// 底行右角格：末行内容截到 cols-1
		f.render(scr(["aa", "bb", "x".repeat(20)]), 3, 10);
		const third = frames[2]!;
		expect(third).toContain("x".repeat(9)); // 末行截到 9
		expect(third).not.toContain("x".repeat(10));
	});
	it("② overlay 合成：浮层按显示列贴入（底行内容让位、边界干净）", () => {
		const frames: string[] = [];
		const f = new FullScreen((s) => frames.push(s));
		f.render(["aaaaaaaaaa", "bbbbbbbbbb"], 2, 10, {
			lines: ["XX"],
			row: 0,
			col: 3,
			width: 2,
		});
		const out = frames[0]!;
		expect(out).toContain("aaa");
		expect(out).toContain("XX");
		// 合成行 = 前 3 列原文 + 浮层 + 后 5 列原文
		expect(out.indexOf("aaa")).toBeLessThan(out.indexOf("XX"));
	});
});
