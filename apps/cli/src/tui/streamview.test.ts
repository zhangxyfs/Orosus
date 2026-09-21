import { describe, it, expect } from "vitest";
import { createStreamView } from "./streamview.ts";
import { stripAnsi } from "./width.ts";

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
