import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withLiveTokens } from "./usage-text.ts";
import type { PanelData } from "./tui/fullapp.ts";
import type { SessionEvent } from "@orosus/core";

/** SessionEvent 形最小夹具（todo-panel.test.ts 同款——载荷字段顶层直摊）。seq 递增由调用侧排。 */
const ev = (seq: number, type: string, extra: Record<string, unknown> = {}): SessionEvent => ({
	v: 1, id: `e${seq}`, parentId: null, seq, ts: "2026-10-04T00:00:00Z", type, ...extra,
});

/** PanelData 形最小夹具（渲染只读这些字段——快照等价即可）。 */
const cache = (): PanelData => ({
	model: "glm-5.3", session: "新会话", cwd: "D:\\develop\\Orosus", tokens: { input: 0, output: 0 },
	startedAt: undefined, contextWindow: 1000, modules: [], tasks: [],
	permission: "never", permissionNext: () => "/permission never",
});

describe("Tokens/上下文实时刷新（withLiveTokens——2026-10-04 拍板「有变化就得更新」）", () => {
	it("cache 未就绪返 undefined——首刷前不误建快照（todo 同款跳过口径）", () => {
		expect(withLiveTokens(undefined, [ev(1, "assistant/message", { usage: { input: 10, output: 5 } })])).toBeUndefined();
	});

	it("空历史 tokens 落 0/0——新会话首 turn 面板可见但不假造数字", () => {
		const next = withLiveTokens(cache(), [])!;
		expect(next.tokens).toEqual({ input: 0, output: 0 });
	});

	it("assistant/message 落 usage 即生效：新对象写回、原快照不动、其余字段原样（就地更新非变异）", () => {
		const c = cache();
		const next = withLiveTokens(c, [ev(1, "user/message"), ev(2, "assistant/message", { usage: { input: 1234, output: 567 } })])!;
		expect(next.tokens).toEqual({ input: 1234, output: 567 });
		expect(next.model).toBe("glm-5.3"); // 其余字段保留（浅拷展开非重建）
		expect(c.tokens).toEqual({ input: 0, output: 0 }); // 原快照未被变异
		expect(next).not.toBe(c);
	});

	it("多轮请求取末条 usage——模型第 N 次调用的数字顶掉第 N-1 次", () => {
		const next = withLiveTokens(cache(), [
			ev(1, "user/message"),
			ev(2, "assistant/message", { usage: { input: 100, output: 10 } }),
			ev(3, "tool/call", { name: "Read" }),
			ev(4, "tool/result"),
			ev(5, "assistant/message", { usage: { input: 300, output: 40 } }),
		])!;
		expect(next.tokens).toEqual({ input: 300, output: 40 });
	});

	it("assistant/chunk usage 方言（GLM 同帧尾包）也被认——消息不带 usage 不丢统计", () => {
		const next = withLiveTokens(cache(), [
			ev(1, "assistant/chunk", { chunk: { type: "usage", input: 88, output: 9 } }),
			ev(2, "assistant/message"), // 无 usage 字段（方言：只走 chunk）
		])!;
		expect(next.tokens).toEqual({ input: 88, output: 9 });
	});

	it("turn/compaction 晚于末条 usage：input 换压缩后投影估算并带 postCompaction 标记（输出累计不丢）", () => {
		const events: SessionEvent[] = [
			ev(1, "user/message", { content: [{ kind: "text", text: "第一轮问题，占住投影让估算非零的一段文本内容。" }] }),
			ev(2, "assistant/message", { content: [{ kind: "text", text: "回答" }], usage: { input: 5000, output: 100 } }),
			ev(3, "turn/compaction", { summary: "前文已压缩为摘要——历史对话的主题与结论总结。", keepFrom: 0 }),
		];
		const next = withLiveTokens(cache(), events)!;
		expect(next.tokens.postCompaction).toBe(true);
		expect(next.tokens.input).toBeGreaterThan(0); // 压缩后投影估算（显著小于 5000）
		expect(next.tokens.input).toBeLessThan(5000);
		expect(next.tokens.output).toBe(100); // 输出累计沿用末条 usage
	});

	it("压缩后的新请求落定即恢复正常口径——postCompaction 只活在压缩到下条 usage 的窗口里", () => {
		const events: SessionEvent[] = [
			ev(1, "assistant/message", { usage: { input: 5000, output: 100 } }),
			ev(2, "turn/compaction", { summary: "摘要", keepFrom: 0 }),
			ev(3, "assistant/message", { usage: { input: 800, output: 60 } }),
		];
		const next = withLiveTokens(cache(), events)!;
		expect(next.tokens).toEqual({ input: 800, output: 60 });
	});
});

describe("Tokens 实时刷新接线源面钉（main.ts 事件回调无独立缝——CM-19③ 同款技法）", () => {
	const src = readFileSync(join(import.meta.dirname, "main.ts"), "utf8");

	it("assistant/message·turn/compaction 两事件挂 withLiveTokens 就地写回——接线拆除/触发条件丢失即红", () => {
		expect(src).toContain('e.type === "assistant/message" || e.type === "turn/compaction"');
		expect(src).toContain("withLiveTokens(getPanelCache()");
		expect(src).toContain("if (next !== undefined) setPanelCache(next)");
	});
});
