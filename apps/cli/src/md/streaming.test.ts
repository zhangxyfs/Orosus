import { describe, it, expect } from "vitest";
import { createStreamingMarkdown, renderMarkdown } from "../mdpipe.ts";
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
	// CMD-02 回归钉（doc/16）：帧 N「para1 含 [a] + para2 已到」时 para1 可冻结，旧守卫只查
	// 冻结点之后的尾（无 [ 则放行）→ para1 被冻结成字面 [a]，帧 N+1 定义后到也永不重渲，
	// 流式输出与终态 renderMarkdown 持续发散（修复前 after 仍字面 [a]）。修复口径：待冻结段
	// 含引用使用候选时只冻结到首个候选 token 之前，候选段保持尾段逐帧重 lex 自愈。
	it("7. CMD-02：先行引用段不冻结成字面——定义后到帧链接即成形，流式与终态一致", () => {
		const sm = createStreamingMarkdown(60);
		const frameN = "see [a] here\n\nnext para\n\n";
		const mid = sm.render(frameN); // 帧 N：para1 已可冻结且含引用候选 [a]
		expect(plain(mid)).toContain("[a]"); // 定义未到：字面形态 == 当时一次性终态
		expect(plain(mid)).toBe(plain(renderMarkdown(frameN, 60))); // 不发散承诺的帧级钉法
		const after = sm.render("see [a] here\n\nnext para\n\n[a]: https://e.com"); // 帧 N+1：定义后到
		expect(plain(after)).toContain("a (https://e.com)"); // 修复前：冻结段保持字面 [a]
		expect(plain(after)).not.toContain("[a]");
		expect(plain(after)).toBe(plain(renderMarkdown("see [a] here\n\nnext para\n\n[a]: https://e.com", 60)));
	});
	// CMD-02 边界补充：候选之前的段落照常冻结（守卫只拦候选段起，不整体躺平），
	// 且行内链接 [x](url) 不构成候选（后到定义改不动它）不拦冻结。
	it("8. CMD-02：候选段之前的段落照常冻结；行内链接不误拦", () => {
		const sm = createStreamingMarkdown(60);
		const frameN = "plain head\n\nsee [a] here\n\nnext para\n\n";
		sm.render(frameN); // 帧 N：候选守卫下 plain head 冻结、候选段留尾
		const after = sm.render(frameN + "[a]: https://e.com");
		expect(plain(after)).toContain("a (https://e.com)");
		expect(plain(after)).toBe(plain(renderMarkdown(frameN + "[a]: https://e.com", 60)));
		// 行内链接段：无候选 → 该帧已把 plain head 冻结（冻结面不被行内链接拖住——由后帧一致性保障）
		const sm2 = createStreamingMarkdown(60);
		const f1 = sm2.render("plain head\n\nsee [a](https://e.com) here\n\nnext para\n\n");
		const f2 = sm2.render("plain head\n\nsee [a](https://e.com) here\n\nnext para\n\nmore");
		expect(plain(f1)).toBe(
			plain(renderMarkdown("plain head\n\nsee [a](https://e.com) here\n\nnext para\n\n", 60)),
		);
		expect(f2.slice(0, 2).map(stripAnsi)).toEqual(f1.slice(0, 2).map(stripAnsi)); // plain head 两行冻结零漂移
	});
	// CMD-04 回归钉（doc/16）：isCompleteCode 旧口径两处漏——① 开/闭合正则缺 ` {0,3}` 缩进
	// 前缀，缩进围栏（列表项内代码块常态）恒进不了「闭合即定格」通道；② 闭合行后的尾换行
	// 使末行为空串（EOF 处 marked 把尾 \n 并入 code raw——实测），带尾换行的顶格围栏同样
	// 不即刻冻结（报告原「带换行不是缺陷」括注被实测推翻，冻结缺席面比报告宽）。钉法同
	// highlight.test.ts ④：高亮语言下闭合帧内容行带 ANSI = 已冻结（transient 跳高亮纯文本）。
	it("9. CMD-04：带尾换行的顶格围栏闭合帧即刻冻结（内容行已着色非 transient）", () => {
		const sm = createStreamingMarkdown(60);
		const closed = sm.render("```ts\nconst x = 1;\n```\n"); // 闭合行后带换行——常见流式帧形态
		const line = closed.find((l) => stripAnsi(l).includes("const x"))!;
		// oxlint-disable-next-line no-control-regex -- 终端断言合法形态：断言冻结着色存在需匹配 ESC
		expect(line).toMatch(/\x1b\[/); // 修复前：尾 \n 使末行为空串 → 不冻结 → 纯文本
	});
	it("10. CMD-04：缩进 2 空格围栏闭合帧即刻冻结，后续帧前缀逐行一致", () => {
		const body = "  ```ts\n  const x = 1;\n  ```\n";
		const sm = createStreamingMarkdown(60);
		const closed = sm.render(body);
		const line = closed.find((l) => stripAnsi(l).includes("const x"))!;
		// oxlint-disable-next-line no-control-regex -- 终端断言合法形态：断言冻结着色存在需匹配 ESC
		expect(line).toMatch(/\x1b\[/); // 修复前：开栏正则不认前导空格 → 恒不冻结 → 纯文本
		const after = sm.render(`${body}\nafter para`);
		expect(after.slice(0, closed.length)).toEqual(closed); // 冻结段零重渲零漂移
	});
});
