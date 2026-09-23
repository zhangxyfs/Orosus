import { describe, it, expect } from "vitest";
import { editDiffRows, toolDiffRows, toolChangeStats, errorLines } from "./toolview.ts";

describe("toolview diff 行（2026-09-23 走查批——Edit/Write 明细渲染数据源）", () => {
	it("① editDiffRows：公共前后缀作上下文（≤2 行）、中段旧删新增、行号按旧/新文本各自计", () => {
		const rows = editDiffRows(
			"export const COMPACT = {\n  strategy: 'sliding-window',\n  threshold: 0.6,\n  preserve: ['system'],",
			"export const COMPACT = {\n  strategy: 'sliding-window',\n  threshold: 0.8,\n  preserve: ['system'],",
		);
		expect(rows).toEqual([
			{ tag: "ctx", no: 1, text: "export const COMPACT = {" },
			{ tag: "ctx", no: 2, text: "  strategy: 'sliding-window'," },
			{ tag: "del", no: 3, text: "  threshold: 0.6," },
			{ tag: "add", no: 3, text: "  threshold: 0.8," },
			{ tag: "ctx", no: 4, text: "  preserve: ['system']," },
		]);
	});

	it("② editDiffRows：长公共前缀只留 3 行 + gap 隔断（上下文 3 行 = kimi/zcode/cc-haha/reasonix 同口径）", () => {
		const rows = editDiffRows("a\nb\nc\nd\ne\nOLD\nz", "a\nb\nc\nd\ne\nNEW\nz");
		expect(rows[0]).toEqual({ tag: "gap", no: 0, text: "… 上方 2 行相同" });
		expect(rows.filter((r) => r.tag === "ctx").map((r) => r.text)).toEqual(["c", "d", "e", "z"]);
	});

	it("③ toolDiffRows：edit 多处编辑 gap 分隔；write 全量增行去尾空段；read 无 diff", () => {
		const edit = toolDiffRows("tool-fs__edit", {
			path: "x.ts",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
		expect(edit?.map((r) => r.tag)).toEqual(["del", "add", "gap", "del", "add"]);
		const write = toolDiffRows("tool-fs__write", { path: "y.ts", content: "l1\nl2\n" });
		expect(write).toEqual([
			{ tag: "add", no: 1, text: "l1" },
			{ tag: "add", no: 2, text: "l2" },
		]);
		expect(toolDiffRows("tool-fs__read", { path: "z.ts" })).toBeUndefined();
	});
});

describe("toolview 错误体解析（失败工具调用展开内容——JSON 壳剥掉）", () => {
	it("④ JSON 错误体取 message/error 嵌套字段，非 JSON 原文逐行（tab 展开为 2 空格——终端跳格变宽漂移前案）", () => {
		expect(errorLines('{"error":{"message":"余额不足"},"code":1113}')).toEqual(["余额不足"]);
		expect(errorLines('{"message":"参数非法"}')).toEqual(["参数非法"]);
		expect(errorLines("ENOENT: no such file\n\tat read (fs.js:1)")).toEqual(["ENOENT: no such file", "  at read (fs.js:1)"]);
	});

	it("⑥ 公共前导缩进剥除 + tab 展开（二轮走查图2：深缩进白占流区宽、tab 跳格冲破面板）", () => {
		const rows = editDiffRows("\t\tconst a = 1;\n\t\tconst b = 2;", "\t\tconst a = 1;\n\t\tconst b = 3;");
		expect(rows).toEqual([
			{ tag: "ctx", no: 1, text: "const a = 1;" },
			{ tag: "del", no: 2, text: "const b = 2;" },
			{ tag: "add", no: 2, text: "const b = 3;" },
		]);
	});

	it("⑦ toolChangeStats：edit → 增删行数；write → 内容行数（结果文案就一行，chip 不能按它算）", () => {
		expect(toolChangeStats("tool-fs__edit", { edits: [{ oldText: "a\nb", newText: "c" }] })).toEqual({ adds: 1, dels: 2, lines: 3 });
		expect(toolChangeStats("tool-fs__write", { content: "l1\nl2\nl3\n" })).toEqual({ adds: 3, dels: 0, lines: 3 });
		expect(toolChangeStats("tool-fs__read", { path: "x" })).toBeUndefined();
	});

	it("⑤ JSON 无已知字段回退紧凑串；非法 JSON 原文兜底", () => {
		expect(errorLines('{"code":42}')).toEqual(['{"code":42}']);
		expect(errorLines("{not json")).toEqual(["{not json"]);
	});
});
