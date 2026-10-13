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

	it("CR-12：todos 元素 null/非对象/无 content → 过滤跳过，不抛 TypeError 崩 attachRender 链", () => {
		expect(panelTasksFromEvent(ev("tool-todo/write", {
			todos: [null, 42, "文本", { status: "done" }, { content: "合法项", status: "pending" }],
		}))).toEqual([{ text: "合法项", state: "pending" }]);
		expect(panelTasksFromEvent(ev("tool-todo/write", { todos: [null] }))).toEqual([]); // 全畸形 → 空清单非崩
	});

	// ——子代理载荷防御（批次二 T7 / 问题1收尾）：T2 路由后子代理的 tool-todo/write 载荷带 agentId 归属。
	// 元素级防御回归（警诫口径）：投影是 .at(-1) 末条制且不过滤 agentId（零改动兼容）——本组只断言
	// 「带 agentId 载荷可投影、不崩、行形状合法」，不断言「投影 [A, B] 后面板仍是 A」的字面语义
	// （「面板恒显主清单」由路由层承担——tests/subagent s17/s18 已证子代理事件不落主会话）。
	describe("子代理载荷防御（agentId 载荷元素级回归 T7）", () => {
		it("带 agentId 载荷的 todo/write 事件可投影：todos 行照常三态映射、agentId 字段不参与映射也不崩", () => {
			expect(panelTasksFromEvent(ev("tool-todo/write", {
				todos: [
					{ content: "子代理步骤一", status: "done" },
					{ content: "子代理步骤二", status: "in_progress" },
					{ content: "子代理步骤三", status: "pending" },
				],
				agentId: "ab12cd34",
			}))).toEqual([
				{ text: "子代理步骤一", state: "done" },
				{ text: "子代理步骤二", state: "active" },
				{ text: "子代理步骤三", state: "pending" },
			]);
		});

		it("带 agentId 载荷的全完成终痕（全 done 全表）→ 投影全 done 行——面板侧行形状合法", () => {
			expect(panelTasksFromEvent(ev("tool-todo/write", {
				todos: [{ content: "A", status: "done" }, { content: "B", status: "done" }],
				agentId: "ab12cd34",
			}))).toEqual([
				{ text: "A", state: "done" },
				{ text: "B", state: "done" },
			]);
		});

		it("带 agentId 载荷的畸形元素同样过滤跳过（CR-12 防御不分载荷来源）、未知 status 归 pending", () => {
			expect(panelTasksFromEvent(ev("tool-todo/write", {
				todos: [null, "x", { content: "合法", status: "weird" }],
				agentId: "ff00",
			}))).toEqual([{ text: "合法", state: "pending" }]);
			expect(panelTasksFromEvent(ev("tool-todo/write", { todos: [], agentId: "ff00" }))).toEqual([]);
		});
	});
});
