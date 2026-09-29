import { describe, it, expect } from "vitest";
import { createStreamView } from "./streamview.ts";
import { stripAnsi, wrapText, truncateToWidth } from "./width.ts";
import * as theme from "../theme.ts";

const rig = (columns = 80) => {
	const frames: string[] = [];
	const writes: string[] = [];
	const sv = createStreamView({
		write: (s) => {
			writes.push(s);
			frames.push(s);
		},
		isTTY: true,
		columns: () => columns,
	});
	return { sv, frames, writes };
};

const flush = async (): Promise<void> => {
	await new Promise((r) => setTimeout(r, 40)); // 16ms 帧调度两拍余量
};

describe("滚动流流式视图（TUI 批阶段三 F2——liveview 替换件，缺陷⑨销账）", () => {
	it("① 流式 chunk → 帧序列含渲染形态（列表圆点）；思考块 dim + [思考] 前缀", async () => {
		const { sv, writes } = rig();
		sv.activity({ kind: "reasoning", text: "在分析上下文……" });
		sv.activity({ kind: "text", text: "- 第一项\n- 第二项" });
		await flush();
		const out = writes.join("");
		expect(out).toContain("[思考]");
		expect(out).toContain("\x1b[2m"); // dim
		expect(out).toContain("•"); // markdown 列表圆点（渲染形态非裸文本）
		sv.end();
	});
	it("② 工具行交错：write 前活动块先固化（帧内顺序 = 正文 → 工具行）", async () => {
		const { sv, writes } = rig();
		sv.activity({ kind: "text", text: "先输出一段正文" });
		sv.write("[tool] Read\n");
		await flush();
		const out = stripAnsi(writes.join(""));
		expect(out.indexOf("先输出一段正文")).toBeLessThan(out.indexOf("[tool] Read"));
		sv.end();
	});
	it("③ discard 擦除临时活动块（/compact 指示行——后续帧不含指示行）", async () => {
		const { sv, writes } = rig();
		sv.activity({ kind: "text", text: "正在压缩…（生成摘要需数秒到数十秒）" });
		await flush();
		expect(writes.join("")).toContain("正在压缩");
		const before = writes.length;
		sv.discard();
		await flush();
		const after = writes.slice(before).join("");
		expect(after).not.toContain("正在压缩"); // 擦除帧不重复内容
		// 且不得出现在后续新内容里
		sv.activity({ kind: "text", text: "压缩完成" });
		sv.end();
		await flush();
		expect(stripAnsi(writes.slice(before).join(""))).toContain("压缩完成");
		expect(writes.slice(before).join("")).not.toContain("正在压缩…");
	});
	it("④ end 定格后继续 write 直写（不再上移重绘历史）", async () => {
		const { sv, writes } = rig();
		sv.activity({ kind: "text", text: "终稿正文" });
		sv.end();
		await flush();
		const before = writes.length;
		sv.write("后续工具行\n");
		await flush();
		const after = writes.slice(before).join("");
		expect(after).toContain("后续工具行");
		expect(after).not.toContain("终稿正文"); // 不重写已定格内容
	});
	it("⑤ 非 TTY 全直通：零缓冲零帧（思考 dim 形态同旧 renderChunk）", () => {
		const out: string[] = [];
		const sv = createStreamView({ write: (s) => out.push(s), isTTY: false, columns: () => 80 });
		sv.activity({ kind: "reasoning", text: "想" });
		sv.activity({ kind: "text", text: "答" });
		sv.end();
		const joined = out.join("");
		expect(joined).toContain("\x1b[2m[思考] 想");
		expect(joined).toContain("\x1b[22m");
		expect(joined).toContain("答");
		expect(joined).not.toContain("?2026"); // 零帧同步序列
	});
});

describe("streamview 活动思考块增量折行（m5-render-perf T2——LiveWrap 接线，行模式同治）", () => {
	/** 旧路径参照（streamview thinkBlock 原样——接线后行为须逐字节等价）。 */
	const legacyThink = (text: string, w: number): string[] =>
		wrapText(text, Math.max(8, w - 2)).map((l, i) => theme.dim((i === 0 ? "[思考] " : "  ") + l));
	const thinkSource =
		"行模式的思考同样会很长。check:boundaries 与 https://example.com/long/path?query=1 词原子。\n" +
		"中文混排覆盖折行与禁则（「」【】），再来 ❤️ emoji 与 English 混合的长段内容。".repeat(2);

	it("① 全链路等价：逐 delta 喂入后触发宽度变化全量重绘，末帧屏面行 == 旧路径全量渲染行（逐行）", async () => {
		// DiffScreen 常态帧 = 行级 diff（同一行的多个历史版本交错在写流里，逐行 contains 必被
		// 中间态打断）；宽度变化走「清屏 + 全量直写完整行数组」——末帧即完整屏面，是对拍的干净靶子。
		let w = 24;
		const writes: string[] = [];
		const sv = createStreamView({ write: (s) => writes.push(s), isTTY: true, columns: () => w });
		let acc = "";
		let prev = 0;
		for (const n of [7, 20, 11, 35, 9, 28, 50, 6]) {
			acc = thinkSource.slice(0, Math.min(thinkSource.length, acc.length + n));
			sv.activity({ kind: "reasoning", text: acc.slice(prev) });
			prev = acc.length;
			await flush();
		}
		acc = thinkSource;
		w = 30; // 触发全量重绘（宽度变化分支）
		sv.activity({ kind: "reasoning", text: acc.slice(prev) }); // prev == acc.length → 空 delta 只触发帧
		await flush();
		w = 24; // 宽度回缩再全量重绘（LiveWrap 换宽清缓存重建——等价于接线路径终态）
		sv.activity({ kind: "reasoning", text: "" });
		await flush();
		const lastFrame = writes[writes.length - 1] ?? "";
		expect(lastFrame).toContain("\x1b[2J"); // 确认末帧走的是全量重绘分支
		const visible = stripAnsi(lastFrame).split("\r\n");
		// DiffScreen 全量重绘对超宽行过显示列截断（thinkBlock 样式前缀 4 列不计入折行宽会超终端宽）——参照同过截断
		expect(visible).toEqual(legacyThink(thinkSource, 24).map((l) => stripAnsi(truncateToWidth(l, 24)))); // 逐行对拍（含缩进/折行点）
		expect(lastFrame).toContain("\x1b[2m[思考] "); // dim 前缀不变
	});

	it("② settle 后活动块清空、定格行正确；再开新思考块从头渲染正常（liveWrap 重置）", async () => {
		const { sv, writes } = rig(40);
		sv.activity({ kind: "reasoning", text: "第一段思考内容足够长会被折行处理成多行的形态" });
		await flush();
		sv.write("[tool] Read\n"); // write 触发 settleActive——思考块定格进 lines
		await flush();
		const settled = writes.length;
		sv.activity({ kind: "reasoning", text: "第二段新思考" }); // 新块（liveWrap 已重置）
		await flush();
		sv.end();
		await flush();
		const all = stripAnsi(writes.join(""));
		expect(all).toContain("[思考] 第一段思考");
		expect(all).toContain("第二段新思考");
		// 定格后新帧不重复重写第一段的中间态（只出现一次头行形态）
		expect(all.split("[思考] ").length - 1).toBe(2); // 两块各一个头行
	});
});
