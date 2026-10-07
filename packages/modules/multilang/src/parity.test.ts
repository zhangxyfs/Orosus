import { describe, expect, it } from "vitest";

import { mainTables } from "../../apps/cli/src/locales/index.ts";
import { koKR } from "./locales/ko-KR.ts";
import { jaJP } from "./locales/ja-JP.ts";
import { ruRU } from "./locales/ru-RU.ts";

/** m5-i18n T17-T19：三语包 D9 parity 硬锁（pack 键集 == 内置键集）+ 复数实表抽查。 */
describe("multilang 三语包 parity（D9 硬锁）", () => {
	const builtin = new Set(Object.keys(mainTables()["zh-CN"]!));

	it("① ja/ko/ru 键集 == 内置 zh-CN 键集（1467 键全 parity——不满足即「6 语」承诺打折）", () => {
		for (const [name, pack] of [["ja-JP", jaJP], ["ko-KR", koKR], ["ru-RU", ruRU]] as const) {
			const keys = Object.keys(pack);
			expect(new Set(keys).size, `${name} 键内零重复`).toBe(keys.length);
			const missing = keys.filter((k) => !builtin.has(k));
			expect(missing, `${name} 超出内置键集（内置先收）`).toEqual([]);
			const extra = [...builtin].filter((k) => !(k in pack));
			expect(extra, `${name} 缺键`).toEqual([]);
			expect(keys.length).toBe(builtin.size);
		}
	});

	it("② 紧槽短形抽查：kv.cwd=フォルダ/작업폴더/Каталог ≤8；徽章 有効·無効/켬·끔/Вкл·Выкл ≤4", () => {
		expect(jaJP["kv.cwd"]).toBe("フォルダ");
		expect(koKR["kv.cwd"]).toBe("작업폴더");
		expect(ruRU["kv.cwd"]).toBe("Каталог");
		expect(jaJP["skill.badge.on"]).toBe("有効");
		expect(koKR["skill.badge.off"]).toBe("끔");
		expect(ruRU["skill.badge.on"]).toBe("Вкл");
	});

	it("③ ru 复数三形实表：mcp.toolsCount/ja 语言包计数键含 {1:|2:|5:} 模板（CLDR 选择器消费）", () => {
		expect(ruRU["mcp.toolsCount"]).toContain("{1:");
		expect(ruRU["mcp.toolsCount"]).toContain("|5:");
		// ja 单形（无复数模板）
		expect(jaJP["mcp.toolsCount"]).not.toContain("{1:");
	});
});
