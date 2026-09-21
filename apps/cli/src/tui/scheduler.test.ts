import { describe, it, expect, vi, afterEach } from "vitest";
import { FrameScheduler } from "./scheduler.ts";

describe("帧调度器（TUI 批阶段三 F0——16ms 节流 + 键盘抢占）", () => {
	afterEach(() => {
		vi.useRealTimers();
	});
	it("① 16ms 内多次 requestRender 合并一帧；间隔足 16ms 后各自成帧", async () => {
		vi.useFakeTimers();
		let renders = 0;
		const s = new FrameScheduler(() => {
			renders++;
			return 0;
		});
		s.requestRender();
		s.requestRender();
		s.requestRender();
		await vi.advanceTimersByTimeAsync(20); // async 变体连 nextTick 微任务一起冲刷
		expect(renders).toBe(1); // 合并
		s.requestRender();
		await vi.advanceTimersByTimeAsync(20);
		expect(renders).toBe(2);
		s.stop();
	});
	it("② 键盘抢占：requestImmediateRender 取消待发节流帧、nextTick 立即渲染且 reason=immediate", async () => {
		vi.useFakeTimers();
		const reasons: string[] = [];
		const s = new FrameScheduler((r) => {
			reasons.push(r);
			return 0;
		});
		s.requestRender(); // 排队一帧节流渲染
		s.requestImmediateRender(); // 抢占
		await vi.advanceTimersByTimeAsync(0); // nextTick 冲刷
		expect(reasons).toEqual(["immediate"]);
		vi.advanceTimersByTime(50); // 被取消的节流帧不得再出现
		expect(reasons).toEqual(["immediate"]);
		s.stop();
	});
});
