import { describe, it, expect } from "vitest";
import { renderMarkdown, createStreamingMarkdown } from "../mdpipe.ts";
import { stripAnsi } from "../tui/width.ts";
import * as theme from "../theme.ts";

const plain = (lines: string[]): string => stripAnsi(lines.join("\n"));

describe("md/ 高亮器 cli-highlight 化（mdpipe 批 T1——P0-① 根除）", () => {
	it("1. json 围栏无「对已着色产物再加工」腐蚀：\\x1b[\\x1b 相邻碎片零出现，内容完整", () => {
		const src = '```json\n{"a": "v", "n": 12, "t": true}\n```';
		const lines = renderMarkdown(src, 60);
		expect(lines.join("\n")).not.toContain("\x1b[\x1b"); // 腐蚀特征（现状必红：数字二次替换咬进色码）
		expect(plain(lines)).toContain('"a": "v"');
		expect(plain(lines)).toContain('"n": 12');
	});
	it("2. ts 围栏 #private 不落注释形态（token 化语义——旧正则 #.*$ 误判钉防回退）", () => {
		const lines = renderMarkdown("```ts\nclass A {\n  #count = 0;\n}\n```", 60);
		const line = lines.find((l) => stripAnsi(l).includes("#count"))!;
		expect(stripAnsi(line)).toContain("#count = 0;");
		expect(line).not.toContain(theme.fg("muted", "#count = 0;")); // 不再整段注释灰
	});
	it("3. 未知语言 → 纯文本行、不崩不空", () => {
		const lines = renderMarkdown("```foobar\nsome code $x\n```", 60);
		expect(plain(lines)).toContain("some code $x");
		const codeLine = lines.find((l) => stripAnsi(l).includes("some code"))!;
		// oxlint-disable-next-line no-control-regex -- 终端断言合法形态：断言纯文本无 ANSI 需匹配 ESC
		expect(codeLine).not.toMatch(/\x1b\[/); // 代码内容自身无色（围栏行 dim 除外）
	});
	it("4. transient 交叉钉（高亮 × 流式）：尾段未闭合块纯文本、闭合冻结后一次着色", () => {
		const sm = createStreamingMarkdown(60);
		const f1 = sm.render("```ts\nconst x = 1;");
		const open = f1.find((l) => stripAnsi(l).includes("const x"))!;
		// oxlint-disable-next-line no-control-regex -- 终端断言合法形态
		expect(open).not.toMatch(/\x1b\[/); // 流式期（未定格）纯文本行
		const f2 = sm.render("```ts\nconst x = 1;\n```");
		const closed = f2.find((l) => stripAnsi(l).includes("const x"))!;
		// oxlint-disable-next-line no-control-regex -- 终端断言合法形态
		expect(closed).toMatch(/\x1b\[/); // 定格着色
	});
	it("5. diff 围栏：+ 行落 accent、- 行落 err（kimi 覆写的连山落点——设计空白 #5）", () => {
		const lines = renderMarkdown("```diff\n+ added line\n- removed line\n```", 60);
		const plus = lines.find((l) => stripAnsi(l).includes("+ added"))!;
		const minus = lines.find((l) => stripAnsi(l).includes("- removed"))!;
		expect(plus).toContain(theme.fg("accent", "+ added line"));
		expect(minus).toContain(theme.fg("err", "- removed line"));
	});
});
