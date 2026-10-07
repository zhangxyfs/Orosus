import { describe, expect, it } from "vitest";

import defaultExport from "./index.ts";

/**
 * m5-i18n T16：multilang 骨架验证——defaultEnabled: false 全仓出厂首用。
 * 覆盖：① 声明面静态可读（不挂载也进图 discovered）② 三语言包槽命名（规则 1）
 * ③ 挂载语义（P1 回退/重挂恢复）由 tests/i18n/locale-store.e2e.test.ts 走真 harness。
 */
describe("multilang 语言包模块（T16 骨架）", () => {
	it("① 声明面：defaultEnabled=false（出厂首用）/ 纯数据（无工具无命令贡献声明）/ 三语言槽命名", () => {
		expect(defaultExport.name).toBe("multilang");
		expect(defaultExport.defaultEnabled).toBe(false); // 全仓出厂模块首用
		expect(defaultExport.provides).toEqual(["i18n.locale.ja-JP", "i18n.locale.ko-KR", "i18n.locale.ru-RU"]);
		expect(defaultExport.mounts).toEqual(["provide"]);
		expect((defaultExport as { contribute?: unknown }).contribute).toBeUndefined();
	});

	it("② activate 注入三槽（每语言一 key、单所有者、native 名随包）", async () => {
		const provided = new Map<string, unknown>();
		await defaultExport.activate({
			provide: (key: string, impl: unknown) => {
				provided.set(key, impl);
			},
		} as never);
		expect([...provided.keys()].sort()).toEqual(["i18n.locale.ja-JP", "i18n.locale.ko-KR", "i18n.locale.ru-RU"]);
		const ja = provided.get("i18n.locale.ja-JP") as { native: string; messages: Record<string, string> };
		expect(ja.native).toBe("日本語");
		expect(ja.messages["kv.model"]).toBe("モデル");
	});
});
