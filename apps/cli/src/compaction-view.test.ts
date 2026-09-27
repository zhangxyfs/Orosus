import { describe, it, expect } from "vitest";
import { compactionSummaryView } from "./compaction-view.ts";
import { stripAnsi } from "./tui/width.ts";

describe("压缩摘要查看口装配（2026-09-27 用户反馈「只显示最后一次」改全部列出）", () => {
	it("① 空/无摘要 → undefined（调用方走 toast）", () => {
		expect(compactionSummaryView([])).toBeUndefined();
		expect(compactionSummaryView([{ type: "user/message" }])).toBeUndefined();
		expect(compactionSummaryView([{ type: "turn/compaction" }])).toBeUndefined(); // 事件在但 summary 缺席
	});
	it("② 单次：标题不带计数，头行 + 正文（正文 muted 逐行包灰）", () => {
		const r = compactionSummaryView([{ type: "turn/compaction", summary: "第一段\n第二段", droppedCount: 13, trigger: "manual", ts: new Date().toISOString() }])!;
		expect(r.title).toBe("压缩摘要");
		const plain = stripAnsi(r.text).split("\n");
		expect(plain[0]).toContain("第 1 次压缩");
		expect(plain[0]).toContain("13 条历史");
		expect(plain[0]).toContain("manual");
		expect(plain[0]).toContain("刚刚"); // relativeTime 与 /sessions 同源
		expect(plain.slice(1)).toEqual(["第一段", "第二段"]);
	});
	it("③ 多次：全部列出、最新在最上、次序按时间正序编号", () => {
		const now = Date.now();
		const ev = (s: string, minAgo: number, n: number): { type: string; summary: string; ts: string; droppedCount: number } =>
			({ type: "turn/compaction", summary: s, ts: new Date(now - minAgo * 60000).toISOString(), droppedCount: n });
		const r = compactionSummaryView([ev("旧摘要", 60, 30), ev("新摘要", 1, 13)])!;
		expect(r.title).toBe("压缩摘要（共 2 次）");
		const plain = stripAnsi(r.text).split("\n");
		// 最新在最上：第一段头行 = 第 2 次（时间正序编号——旧的是第 1 次）
		expect(plain[0]).toContain("第 2 次压缩");
		expect(plain[0]).toContain("13 条历史");
		expect(plain[1]).toBe("新摘要");
		const secondHead = plain.findIndex((l) => l.includes("第 1 次压缩"));
		expect(secondHead).toBeGreaterThan(0);
		expect(plain[secondHead + 1]).toBe("旧摘要");
	});
	it("④ 长行按 width 预折行（2026-09-27 用户走查：viewText 不折行——超宽行被弹窗截断丢字）：不丢内容、每行不超宽", () => {
		const long = "这一行摘要特别长".repeat(30); // 240 字 ≈ 480 列——远超窗宽
		const r = compactionSummaryView([{ type: "turn/compaction", summary: long, droppedCount: 1 }], { width: 40 })!;
		const lines = r.text.split("\n").slice(1); // 跳过头行
		expect(lines.length).toBeGreaterThan(1);
		for (const l of lines) expect(stripAnsi(l).length).toBeLessThanOrEqual(40);
		expect(stripAnsi(lines.join(""))).toBe(long); // 折行不丢字
	});
});
