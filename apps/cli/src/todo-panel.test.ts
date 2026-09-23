import { describe, it, expect } from "vitest";
import { panelTasksFromEvent } from "./todo-panel.ts";

/** SessionEvent 形最小夹具（载荷字段在顶层——session/append(type, fields) 直摊开）。 */
const ev = (type: string, extra: Record<string, unknown> = {}) => ({
	v: 1 as const, id: "e1", parentId: null, seq: 1, ts: "2026-09-23T00:00:00Z", type, ...extra,
});

describe("任务清单面板实时投影（tool-todo/write → 面板任务行）", () => {
	it("todo/write 事件映射三态：done→done、in_progress→active、pending→pending", () => {
		expect(panelTasksFromEvent(ev("tool-todo/write", {
			todos: [
				{ content: "读完 README", status: "done" },
				{ content: "梳理分层", status: "in_progress" },
				{ content: "写总结", status: "pending" },
			],
		}))).toEqual([
			{ text: "读完 README", state: "done" },
			{ text: "梳理分层", state: "active" },
			{ text: "写总结", state: "pending" },
		]);
	});

	it("非 todo 事件返回 undefined——onEvent 分支跳过不改快照", () => {
		expect(panelTasksFromEvent(ev("tool/call"))).toBeUndefined();
		expect(panelTasksFromEvent(ev("turn/end"))).toBeUndefined();
	});

	it("载荷缺失或非数组返回 undefined——不投影不炸", () => {
		expect(panelTasksFromEvent(ev("tool-todo/write"))).toBeUndefined();
		expect(panelTasksFromEvent(ev("tool-todo/write", { todos: "x" }))).toBeUndefined();
	});

	it("空数组返回 []——全完成自动清空的落点，面板同步清空是语义不是丢数据", () => {
		expect(panelTasksFromEvent(ev("tool-todo/write", { todos: [] }))).toEqual([]);
	});
});
