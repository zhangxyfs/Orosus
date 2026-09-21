import { describe, it, expect } from "vitest";
import { FullScreen } from "./fullscreen.ts";

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
