import { describe, expect, it } from "vitest";

import type { Harness } from "@orosus/core";

import { runLocaleSetting } from "./switch.ts";
import { createLocaleStore, type LocaleGraphFace } from "./store.ts";

function fakeHarnessGraph(slots: Record<string, unknown>): LocaleGraphFace {
	const map = new Map(Object.entries(slots));
	return {
		services: {
			getOptional: (key: string) => Promise.resolve(map.get(key)),
			keys: (prefix?: string) => [...map.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
		},
	};
}

describe("m5-i18n T3：runLocaleSetting（/locale 与 /settings「切换语言」共用流）", () => {
	const makeDeps = (slots: Record<string, unknown>, startTag: string) => {
		const store = createLocaleStore({ getGraph: () => fakeHarnessGraph(slots) });
		const setLanguageCalls: string[] = [];
		const fakeH = { setLanguage: async (tag: string) => { setLanguageCalls.push(tag); } } as unknown as Harness;
		return { deps: { getH: () => fakeH, store }, store, setLanguageCalls, init: store.init(startTag) };
	};

	it("① 列表 = 内置三语原生名 + 语言包追加；当前语 ✓ 勾标（/model 先例）", async () => {
		const { deps, init } = makeDeps({ "i18n.locale.ja-JP": { "k": "v" } }, "en-US");
		await init;
		const seen: string[][] = [];
		await runLocaleSetting(async (t, items) => {
			seen.push([t, ...items]);
			return items[0] ?? ""; // Esc 前先记录再取消
		}, deps).catch(() => undefined);
		expect(seen[0]![0]).toBe("切换语言");
		expect(seen[0]).toContain("简体中文");
		expect(seen[0]).toContain("繁體中文");
		expect(seen[0]).toContain("English ✓"); // 当前语勾标
		expect(seen[0]).toContain("日本語"); // 语言包槽追加
	});

	it("② 选非当前语 → h.setLanguage + store 换 tag + toast 带原生名", async () => {
		const { deps, init, setLanguageCalls } = makeDeps({}, "en-US");
		await init;
		const toast = await runLocaleSetting(async (_t, items) => items.find((x) => x === "简体中文") ?? "", deps);
		expect(setLanguageCalls).toEqual(["zh-CN"]);
		expect(toast).toBe("语言已切换：简体中文（已写入 config）");
		expect(deps.store.activeTag()).toBe("zh-CN");
	});

	it("③ 选当前语 → 无操作（不写盘不换 tag）", async () => {
		const { deps, init, setLanguageCalls } = makeDeps({}, "zh-CN");
		await init;
		const toast = await runLocaleSetting(async (_t, items) => items.find((x) => x.endsWith("✓")) ?? "", deps);
		expect(toast).toBeUndefined();
		expect(setLanguageCalls).toEqual([]);
		expect(deps.store.activeTag()).toBe("zh-CN");
	});

	it("④ 取消（Esc）= chooseVia 抛「已取消（Esc）」直传——不落盘（P4）", async () => {
		const { deps, init, setLanguageCalls } = makeDeps({}, "en-US");
		await init;
		await expect(
			runLocaleSetting(async () => {
				throw new Error("已取消（Esc）");
			}, deps),
		).rejects.toThrow("已取消（Esc）");
		expect(setLanguageCalls).toEqual([]);
	});
});
