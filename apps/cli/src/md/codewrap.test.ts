import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../mdpipe.ts";
import { stripAnsi } from "../tui/width.ts";

describe("md/ 代码行折行不截断（mdpipe 批 T5——P2-⑤）", () => {
	it("1. 宽 30 + 100 字符代码行：折成 ≥ 3 行，剥色拼接内容完整（截断则必缺尾）", () => {
		const code = "x".repeat(100);
		const lines = renderMarkdown("```\n" + code + "\n```", 30);
		const joined = lines.map(stripAnsi).join("\n");
		expect(lines.length).toBeGreaterThanOrEqual(3 + 2); // 内容 ≥ 3 行 + 上下围栏
		expect(joined.replace(/\s+/g, "")).toContain(code); // 完整可见（现状：截断丢尾，此条现状必红）
	});
	it("2. 已着色超宽行折行后：续行仍带正确颜色（AnsiTracker 前缀存在），无色漏", () => {
		const lines = renderMarkdown("```ts\nconst sssssssssss = \"aaaa\";" + "// " + "c".repeat(60) + "\n```", 30);
		const codeLines = lines.filter((l) => stripAnsi(l).includes("ccccc"));
		expect(codeLines.length).toBeGreaterThan(1); // 折成多行
		// 非首行续行：要么自身带 ANSI 前缀（颜色延续），要么是围栏行（不含内容字符）
		for (const l of codeLines.slice(1)) {
			// oxlint-disable-next-line no-control-regex -- 终端断言合法形态：断言 ANSI 延续存在需匹配 ESC
			expect(l).toMatch(/\x1b\[/);
		}
	});
});
