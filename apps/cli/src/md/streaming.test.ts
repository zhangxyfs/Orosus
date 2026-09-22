import { describe, it, expect } from "vitest";
import { createStreamingMarkdown } from "../mdpipe.ts";
import { stripAnsi } from "../tui/width.ts";

const plain = (lines: string[]): string => stripAnsi(lines.join("\n"));

describe("md/ 流式定稿 token 边界（mdpipe 批 T2——P0-② 根治）", () => {
	it("1. 未闭合 ~~~ + 围栏内空行：全程代码块形态、终帧闭合整块冻结（现状终帧错误，此条现状必红）", () => {
		const final = "正文段。\n\n~~~\nconst a = 1;\n\nconst b = 2;\n~~~";
		const sm = createStreamingMarkdown(60);
		for (let i = 1; i <= final.length; i++) {
			const f = sm.render(final.slice(0, i));
			const line = f.find((l) => stripAnsi(l).includes("const b = 2;"));
			if (line) expect(stripAnsi(line)).toMatch(/^ {2}const b = 2;/); // 代码块缩进形态，非裸段落
		}
		const done = sm.render(final);
		expect(plain(done)).toMatch(/^ {2}const b = 2;$/m);
		expect(plain(done)).toMatch(/^ {2}```$/m); // 终帧：闭合围栏以围栏形态存在（渲染件闭合行恒 ```，开栏行 ~~~）
	});
	it("2. 缩进 2 空格 ``` 围栏同场景不劈块", () => {
		const final = "para\n\n  ```\n  code line\n\n  more code\n  ```";
		const sm = createStreamingMarkdown(60);
		for (let i = 1; i <= final.length; i++) {
			const f = sm.render(final.slice(0, i));
			const line = f.find((l) => stripAnsi(l).includes("more code"));
			if (line) expect(stripAnsi(line)).toMatch(/^ {2}more code/);
		}
		// 终帧不劈块：整块恰一对围栏线（现状劈成三截——冻结块一对 + 尾段裸 ```）
		const done = sm.render(final).map(stripAnsi);
		expect(done.filter((l) => /^ {2}```\s*$/.test(l)).length).toBe(2);
	});
	it("3. ~~~ 正常闭合：闭合帧起该块进冻结段（后续帧前缀逐行一致）", () => {
		const body = "~~~\nline one\n~~~\n\nafter para";
		const closedAt = body.indexOf("~~~", 4) + 3;
		const sm = createStreamingMarkdown(60);
		const closed = sm.render(body.slice(0, closedAt));
		expect(plain(closed)).toMatch(/^ {2}line one$/m);
		const after = sm.render(body);
		expect(after.slice(0, closed.length)).toEqual(closed); // 冻结段零重渲零漂移
	});
	it("4. 闭合围栏半截到达：当帧与补完帧行数一致（无收缩抖动）", () => {
		const sm = createStreamingMarkdown(60);
		const partial = sm.render("```ts\nconst x = 1;\n``");
		const complete = sm.render("```ts\nconst x = 1;\n```");
		expect(plain(partial)).toContain("const x = 1;");
		expect(complete.length).toBe(partial.length);
	});
	it("5. 引用定义守卫：定义在流尾后到不劈死前文，到达后链接成形", () => {
		const sm = createStreamingMarkdown(60);
		sm.render("see [链接] here\n\n");
		const after = sm.render("see [链接] here\n\n[链接]: https://e.com");
		expect(plain(after)).toContain("链接 (https://e.com)");
	});
	it("6. 文本重置防御：变短文本全量重渲不崩、输出正确", () => {
		const sm = createStreamingMarkdown(60);
		sm.render("# 标题\n\n段落一\n\n段落二");
		const out = sm.render("全新短文");
		expect(plain(out)).toContain("全新短文");
		expect(plain(out)).not.toContain("标题");
	});
});
