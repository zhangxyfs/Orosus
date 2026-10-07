import { describe, expect, it } from "vitest";

import { koKR } from "./locales/ko-KR.ts";
import { jaJP } from "./locales/ja-JP.ts";
import { ruRU } from "./locales/ru-RU.ts";

/**
 * m5-i18n T17-T19：三语包 D9 parity 硬锁 + 复数实表。
 * 键集对比面：内置键集 = 1496（2026-10-07 引导修 +5、setDefault 补选 +2；上批指令收尾 +22 表侧已追、
 * pack 侧当时漏再生成本批补齐）——由 tests/i18n/spec-audit.test.ts 锁表侧，此处锁「包键数 == 1496 且零
 * 重复」（跨包键集全等价由 e2e 挂载后 t() 覆盖面保证）。
 */
describe("multilang 三语包 parity（D9 硬锁）", () => {
	const EXPECTED_KEYS = 1496; // 引导修终态（2026-10-07）

	it("① ja/ko/ru 各 1496 键、键内零重复、键名三包全等（与内置键集的逐键全等由表侧锁 + 生成器键序锁共同保证）", () => {
		for (const [name, pack] of [["ja-JP", jaJP], ["ko-KR", koKR], ["ru-RU", ruRU]] as const) {
			const keys = Object.keys(pack);
			expect(keys.length, `${name} 键数`).toBe(EXPECTED_KEYS);
			expect(new Set(keys).size, `${name} 键内零重复`).toBe(keys.length);
		}
		const jaKeys = Object.keys(jaJP).sort();
		expect(Object.keys(koKR).sort()).toEqual(jaKeys);
		expect(Object.keys(ruRU).sort()).toEqual(jaKeys);
	});

	it("② 紧槽短形抽查：kv.cwd=フォルダ/작업폴더/Каталог ≤8；徽章 有効·無効/켬·끔/Вкл·Выкл ≤4", () => {
		expect(jaJP["kv.cwd"]).toBe("フォルダ");
		expect(koKR["kv.cwd"]).toBe("작업폴더");
		expect(ruRU["kv.cwd"]).toBe("Каталог");
		expect(jaJP["skill.badge.on"]).toBe("有効");
		expect(koKR["skill.badge.off"]).toBe("끔");
		expect(ruRU["skill.badge.on"]).toBe("Вкл");
	});

	it("③ ru 复数三形实表：计数键含 {1:|2:|5:} 模板（CLDR 选择器消费）；ja 单形", () => {
		expect(ruRU["mcp.toolsCount"]).toContain("{1:");
		expect(ruRU["mcp.toolsCount"]).toContain("|5:");
		expect(jaJP["mcp.toolsCount"]).not.toContain("{1:");
	});
});
