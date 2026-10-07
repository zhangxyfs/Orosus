import { describe, expect, it } from "vitest";

import { createLocaleStore, type LocaleGraphFace } from "./store.ts";

/** 假图：槽表 + 记录表注入。 */
function fakeGraph(slots: Record<string, unknown>, records: { name: string }[] = [{ name: "multilang" }, { name: "mymodule" }]): LocaleGraphFace {
	const map = new Map(Object.entries(slots));
	return {
		services: {
			getOptional: (key: string) => Promise.resolve(map.get(key)),
			keys: (prefix?: string) => [...map.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
		},
		records,
	};
}

describe("m5-i18n store：合并表与解析链", () => {
	it("floor ∪ main ∪ catalog 段 ∪ 语言包槽——槽优先覆盖内置同键；缺键走 en 链再 fallback/key", async () => {
		const store = createLocaleStore({
			getGraph: () => fakeGraph({
				"i18n.locale.ja-JP": { "kv.model": "モデル（包）" },
			}),
			mainTables: () => ({ "zh-CN": { "kv.model": "模型" }, "en-US": { "kv.model": "Model", "a.only": "only-en" } }),
		});
		await store.init("zh-CN");
		expect(store.t("kv.model")).toBe("模型");
		expect(store.t("core.kernel.disabled")).toContain("未启用"); // 地板键进合并表
		await store.setLanguage("ja-JP");
		expect(store.t("kv.model")).toBe("モデル（包）"); // 语言包槽覆盖内置（槽优先 §5.1）
		expect(store.t("a.only")).toBe("only-en"); // ja 表缺键 → en 链
		expect(store.t("a.missing", undefined, "兜底")).toBe("兜底");
		expect(store.t("a.missing")).toBe("a.missing");
	});

	it("zh-TW 特例链经 zh-CN：主目录无 zh-TW 键时蹦简体（P3）", async () => {
		const store = createLocaleStore({
			getGraph: () => fakeGraph({}),
			mainTables: () => ({ "zh-CN": { "g.hi": "你好" }, "en-US": { "g.hi": "hi" } }),
		});
		await store.init("zh-TW");
		expect(store.t("g.hi")).toBe("你好");
	});

	it("i18n.catalog.* 段参与合并（键须以模块名前缀由作者自律；槽名=模块名校验在 store）", async () => {
		const warns: string[] = [];
		const store = createLocaleStore({
			getGraph: () =>
				fakeGraph(
					{
						"i18n.catalog.mymodule": { "zh-CN": { "mymodule.hello": "模块你好 {n}" }, "en-US": { "mymodule.hello": "module hello {n}" } },
						"i18n.catalog.rogue": { "zh-CN": { "rogue.k": "v" } }, // 槽名 ≠ 任何模块名 → 拒收
						"i18n.catalog.bad": { "zh-CN": "not-a-table" }, // 槽名是模块名但形状非法 → 整槽忽略
					},
					[{ name: "multilang" }, { name: "mymodule" }, { name: "bad" }],
				),
			warn: (m) => warns.push(m),
		});
		await store.init("zh-CN");
		expect(store.t("mymodule.hello", { n: 1 })).toBe("模块你好 1");
		expect(store.t("rogue.k")).toBe("rogue.k"); // 拒收档
		expect(warns.some((w) => w.includes("槽名 ≠ 模块名"))).toBe(true);
		expect(warns.some((w) => w.includes("形状非法"))).toBe(true);
	});
});

describe("m5-i18n store：语言列表与 P1 卸载降级", () => {
	it("availableLocales：内置三语原生名 + 语言包槽动态追加（已知原生名/未知显 tag）", async () => {
		const store = createLocaleStore({
			getGraph: () =>
				fakeGraph({
					"i18n.locale.ja-JP": { "k": "v" },
					"i18n.locale.xx-YY": { native: "Xxish", messages: { k: "v" } },
				}),
		});
		await store.init("en-US");
		const list = store.availableLocales();
		expect(list.slice(0, 3)).toEqual([
			{ tag: "zh-CN", native: "简体中文", fromPack: false },
			{ tag: "zh-TW", native: "繁體中文", fromPack: false },
			{ tag: "en-US", native: "English", fromPack: false },
		]);
		expect(list.find((e) => e.tag === "ja-JP")).toEqual({ tag: "ja-JP", native: "日本語", fromPack: true });
		expect(list.find((e) => e.tag === "xx-YY")).toEqual({ tag: "xx-YY", native: "Xxish", fromPack: true });
	});

	it("P1：语言包卸载（reload 后槽消失）→ packMissing=true、解析落 en；重挂自动恢复；内置语种恒 false", async () => {
		let slots: Record<string, unknown> = { "i18n.locale.ja-JP": { "kv.model": "モデル" } };
		const store = createLocaleStore({ getGraph: () => fakeGraph(slots), mainTables: () => ({ "en-US": { "kv.model": "Model" } }) });
		await store.init("ja-JP");
		expect(store.t("kv.model")).toBe("モデル");
		expect(store.packMissing()).toBe(false);
		slots = {}; // 卸载 → 宿主 reload 后 store.rebuild()
		await store.rebuild();
		expect(store.packMissing()).toBe(true);
		expect(store.t("kv.model")).toBe("Model"); // 落 en（降级锚 = en 非 zh）
		slots = { "i18n.locale.ja-JP": { "kv.model": "モデル（复挂）" } }; // 重挂 → 自动恢复
		await store.rebuild();
		expect(store.t("kv.model")).toBe("モデル（复挂）");
		await store.setLanguage("zh-CN");
		expect(store.packMissing()).toBe(false); // 内置语种恒 false
	});
});
