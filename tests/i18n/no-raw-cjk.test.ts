import { describe, expect, it } from "vitest";

import { scanSource } from "../../scripts/i18n-no-raw-cjk.mts";

/** m5-i18n T4：门禁扫描器单元钉（AST 字面量面 + 三类豁免）。 */
describe("i18n-no-raw-cjk 扫描器", () => {
	it("无 CJK 源码零命中；注释里的 CJK 不扫（AST 只看字面量）", () => {
		expect(scanSource("a.ts", 'const x = "hello";')).toEqual([]);
		expect(scanSource("a.ts", '// 注释里的中文不算\nconst x = "ok";')).toEqual([]);
	});

	it("字符串与无插值模板命中；带插值模板逐静态段计（粒度 = 段）", () => {
		expect(scanSource("a.ts", 'const a = "模型";')).toHaveLength(1);
		expect(scanSource("a.ts", "const b = `会话`;")).toHaveLength(1);
		expect(scanSource("a.ts", "const c = `第 ${n} 页`;")).toHaveLength(2); // 「第 」+「 页」
	});

	it("三类豁免：协议串白名单 / 行级 i18n:diag（诊断面不翻）；全角符号类计入", () => {
		expect(scanSource("a.ts", 'const a = "已取消（Esc）";')).toEqual([]); // D13 白名单同源
		expect(scanSource("a.ts", 'logWarn("code", "渲染帧抛错"); // i18n:diag')).toEqual([]);
		expect(scanSource("a.ts", 'const a = "（空目录）";')).toHaveLength(1); // 全角括号属 CJK 符号区
	});
});
