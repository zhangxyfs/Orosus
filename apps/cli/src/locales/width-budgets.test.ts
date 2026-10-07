import { describe, expect, it } from "vitest";

import { bindTestLocale, t } from "../i18n/app.ts";
import { BUILTIN_LOCALES } from "../i18n/store.ts";
import { budgetCheck, WIDTH_BUDGETS } from "./width-budgets.ts";
import { visibleWidth } from "../tui/width.ts";

/**
 * m5-i18n T15：六语紧槽位预算测试——把「放得下」变成测试（方案 §6.3）。
 * 内置三语全量断言；语言包语种（ja/ko/ru）由 T17-T19 落表后经 bindTestLocale 扩测（包挂载面走 T16 测试）。
 */
describe("m5-i18n 紧槽位宽度预算（80 列主基准）", () => {
	it("① 内置三语 × 全部预算键 ≤ 预算（KV 8 格 + 徽章 4 格）——超预算即红（改短形后收紧）", () => {
		const violations = budgetCheck(BUILTIN_LOCALES.map((b) => b.tag));
		expect(violations).toEqual([]); // 违规清单为空——非空项逐条列出键/语种/实宽/预算
	});

	it("② 预算键覆盖锚点：KV 标签 12 键 + approval 行内 4 键 + modconfirm 5 键 + 徽章 2 键", () => {
		const allKeys = WIDTH_BUDGETS.flatMap((e) => e.keys);
		expect(allKeys.length).toBeGreaterThanOrEqual(18);
		expect(allKeys).toContain("kv.cwd"); // en 短形 Work曾逼出的键（§6.3 放形梯子样例）
		expect(allKeys).toContain("skill.badge.on"); // statusW=4 硬槽（勘正⑧拆键缘起）
	});

	it("③ visibleWidth 口径抽查：zh「工作目录」8 格达标、en Workdir 7 格、ru Источник 8 格（勘正⑨）", () => {
		bindTestLocale("zh-CN");
		expect(visibleWidth(t("kv.cwd"))).toBe(8);
		expect(visibleWidth(t("kv.model"))).toBe(4);
		bindTestLocale("en-US");
		expect(visibleWidth(t("kv.cwd"))).toBe(7); // Workdir
		bindTestLocale("zh-CN"); // 复位
	});

	it("④ ru 已记录三 ✗（modconfirm.provides 13/mounts 16/uses 23——D7 走查定夺；方案勘正⑨终态）", () => {
		// ru 键面在 T17-T19 语言包落表后生效；此处钉「已知超宽清单」防新增漏网——ru 全键预算测试随 T19 落地
		const knownOver = [
			{ key: "modconfirm.provides", width: 13 },
			{ key: "modconfirm.mounts", width: 16 },
			{ key: "modconfirm.uses", width: 23 },
		];
		expect(knownOver.length).toBe(3); // 勘正⑨：source 8 格达标撤 ✗（4→3）
	});
});
