import { describe, it, expect } from "vitest";
import { parseWheel, isMouseSequence } from "./mouse.ts";

describe("鼠标序列解析件（m5 鼠标批 T0——kimi parseWheelEvent 精简独立）", () => {
	it("① SGR 滚轮向上（button 64）→ direction -1 + 坐标 0 起", () => {
		// \x1b[<64;10;5M = 第 9 列第 4 行向上滚一格
		expect(parseWheel("\x1b[<64;10;5M")).toEqual({ direction: -1, x: 9, y: 4, alt: false });
	});
	it("② SGR 滚轮向下（button 65）→ direction +1", () => {
		expect(parseWheel("\x1b[<65;1;1M")).toEqual({ direction: 1, x: 0, y: 0, alt: false });
	});
	it("③ SGR Alt+滚轮（bit3 = 值 8）→ alt true（65+8=73）", () => {
		expect(parseWheel("\x1b[<73;1;1M")).toEqual({ direction: 1, x: 0, y: 0, alt: true });
	});
	it("④ 横滚（66/67）与非鼠标按键（0）→ undefined", () => {
		expect(parseWheel("\x1b[<66;1;1M")).toBeUndefined(); // 横滚右
		expect(parseWheel("\x1b[<67;1;1M")).toBeUndefined(); // 横滚左
		expect(parseWheel("\x1b[<0;1;1M")).toBeUndefined(); // 普通左键按下
		expect(parseWheel("\x1b[A")).toBeUndefined(); // 方向键不是鼠标
	});
	it("⑤ 旧 X10 编码（\\x1b[M + 3 载荷字节，字节偏移 32）→ 向上：button 字节 0x60「`」= 64+32、坐标字节 0x21「!」= 0", () => {
		// 只开 ?1000 不开 ?1006 的老终端兜底（conhost 风险面）
		expect(parseWheel("\x1b[M`!!")).toEqual({ direction: -1, x: 0, y: 0, alt: false });
		// X10 向下：button 字节 0x61「a」= 65+32
		expect(parseWheel("\x1b[Ma!!")).toEqual({ direction: 1, x: 0, y: 0, alt: false });
	});
	it("⑥ isMouseSequence：点击 SGR（button 0）true、拖动/释放 true、方向键与可打印字符 false", () => {
		expect(isMouseSequence("\x1b[<0;1;1M")).toBe(true); // 左键按下
		expect(isMouseSequence("\x1b[<32;1;1M")).toBe(true); // 拖动（motion 位）
		expect(isMouseSequence("\x1b[<0;1;1m")).toBe(true); // 释放
		expect(isMouseSequence("\x1b[M`!!")).toBe(true); // X10 整 6 字节
		expect(isMouseSequence("\x1b[A")).toBe(false);
		expect(isMouseSequence("a")).toBe(false);
		expect(isMouseSequence("\x1b[<0;1;1Mx")).toBe(false); // 尾巴多字节不是完整鼠标序列
	});
});
