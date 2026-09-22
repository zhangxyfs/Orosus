import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../mdpipe.ts";
import * as theme from "../theme.ts";

const openOf = (fn: (t: string) => string): string => fn("\u0000").split("\u0000")[0]!;

describe("md/ 行内嵌套样式断色根修（mdpipe 批 T6——stylePrefix 哨兵）", () => {
	it("1. 标题里的粗体结束后恢复标题色（现状：收尾码洗掉 accent，尾巴掉回正文色）", () => {
		const lines = renderMarkdown("# 标题 **粗体** 尾巴", 60);
		const head = lines.find((l) => l.includes("标题"))!;
		const accentOpen = openOf((t) => theme.fg("accent", t));
		const boldClose = head.indexOf("\x1b[22m"); // 第一个粗体收尾
		expect(boldClose).toBeGreaterThan(0);
		// 粗体收尾之后再次出现标题 accent 色（哨兵前缀恢复）
		expect(head.indexOf(accentOpen, boldClose)).toBeGreaterThan(boldClose);
		expect(head).toContain("尾巴");
	});
	it("2. 引用内的行内码结束后恢复引用色", () => {
		const lines = renderMarkdown("> 引用里有 `行内码` 还有后续文字", 60);
		const quote = lines.find((l) => l.includes("引用"))!;
		const mutedOpen = openOf((t) => theme.fg("muted", t));
		const count = quote.split(mutedOpen).length - 1;
		expect(count).toBeGreaterThanOrEqual(2); // 首次上色 + 码段收尾后恢复
	});
	it("3. 纯段落：无哨兵残留、无末尾前缀", () => {
		const lines = renderMarkdown("普通段落 **粗体** 收尾", 60);
		const joined = lines.join("\n");
		expect(joined).not.toContain("\u0000");
		expect(joined).toContain("普通段落");
		expect(joined).toContain("收尾");
	});
});
