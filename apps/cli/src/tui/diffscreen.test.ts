import { describe, it, expect } from "vitest";
import { DiffScreen } from "./diffscreen.ts";

/** 收集写出帧。 */
const rig = () => {
	const frames: string[] = [];
	const d = new DiffScreen((s) => frames.push(s));
	return { d, frames };
};

describe("滚动流渲染器（TUI 批阶段三 F0——行级 diff + append 快路径）", () => {
	it("① 首帧全量 + 纯追加只写尾部（append 快路径，不重写已有行）", () => {
		const { d, frames } = rig();
		d.render(["a", "b"], 80);
		d.render(["a", "b", "c"], 80);
		expect(frames[0]).toContain("a");
		expect(frames[0]).toContain("b");
		expect(frames[1]).toContain("c");
		expect(frames[1]).not.toContain("\x1b[2Ka"); // 不重写 a 行
		expect(frames[1]).not.toContain("\x1b[2Kb"); // 不重写 b 行
		expect(frames[1]).toContain("\x1b[?2026h"); // 同步输出包裹
	});
	it("② 中间行变化只重写变化区间（上移 N 行 + 逐行清，未变行不出现）", () => {
		const { d, frames } = rig();
		d.render(["a", "b", "c"], 80);
		d.render(["a", "B", "c"], 80);
		const f = frames[1]!;
		expect(f).toContain("\x1b[1A"); // 上移 1 行回到 b 行
		expect(f).toContain("\x1b[2KB"); // 清行重写为 B
		expect(f).not.toContain("\x1b[2Ka");
		expect(f).not.toContain("\x1b[2Kc");
	});
	it("③ 行数收缩：多余旧行清除（\\x1b[2K 清尾）", () => {
		const { d, frames } = rig();
		d.render(["a", "b", "c", "d"], 80);
		d.render(["a", "b"], 80);
		const f = frames[1]!;
		expect((f.match(/\x1b\[2K/g) ?? []).length).toBeGreaterThanOrEqual(2); // 清掉两行旧内容
	});
	it("④ 宽度变化 → 全量重绘（清屏 + 清滚动回退 \\x1b[3J）", () => {
		const { d, frames } = rig();
		d.render(["a", "b"], 80);
		d.render(["a", "b"], 60);
		const f = frames[1]!;
		expect(f).toContain("\x1b[2J\x1b[H\x1b[3J");
		// 宽度不变 → 零帧
		d.render(["a", "b"], 60);
		expect(frames).toHaveLength(2);
	});
});
