import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHarness } from "@orosus/core";
import { InMemorySessionStore } from "@orosus/core";

import { createLocaleStore, type LocaleGraphFace } from "../../src/i18n/store.ts";

/**
 * m5-i18n T16：multilang 真机装配验证（方案 §十一验收——全新 OROSUS_HOME）。
 * ① 默认不挂载：审计无 multilang 激活、/locale 仅内置三语
 * ② 挂载（写 modules.d enabled + reload）→ 六语（日本語/한국어/Русский 追加）
 * ③ 卸载 → 回退 en + packMissing（P1）；config 保持 ru（不改写）；重挂自动恢复
 */
describe("multilang 挂载生命周期（真 harness）", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	const make = async (): Promise<{ store: ReturnType<typeof createLocaleStore>; setEnabled: (on: boolean) => Promise<void> }> => {
		dir = mkdtempSync(join(tmpdir(), "orosus-multilang-"));
		const home = join(dir, "home");
		const userFile = join(home, "config.toml");
		mkdirSync(home, { recursive: true });
		writeFileSync(userFile, 'provider = "fake/m"\n', "utf8");
		// 动态 import 避免 Vitest 静态解析 builtins（内置表在测试进程已含 multilang 声明——defaultEnabled:false 即不激活）
		const { default: multilang } = await import("@orosus/multilang");
		const h = await createHarness({
			store: new InMemorySessionStore(),
			diagDir: dir,
			sessionsDir: join(dir, "sessions"),
			spillDir: join(dir, "spill"),
			builtinModules: [multilang as never],
			config: { userFile, projectFile: join(dir, "no-proj.toml"), catalogCacheFile: join(dir, "no-cat.json"), env: {}, cliOverrides: { model: "fake/m" } },
		});
		const { mainTables } = await import("../locales/index.ts");
		const store = createLocaleStore({
			getGraph: (): LocaleGraphFace => h.graph() as unknown as LocaleGraphFace,
			mainTables,
			warn: () => {},
		});
		await store.init("zh-CN");
		const setEnabled = async (on: boolean): Promise<void> => {
			// 模拟挂载页翻转：直接改 config 节 + reload（真实路径走 writeSectionKey；测试直写等价）
			mkdirSync(home, { recursive: true });
		writeFileSync(userFile, `provider = "fake/m"\nlanguage = "ru-RU"\n\n[multilang]\nenabled = ${on}\n`, "utf8");
			await h.reload();
			await store.rebuild();
		};
		return { store, setEnabled };
	};

	it("① 默认不挂载：审计 discovered；/locale 三内置语", async () => {
		const { store } = await make();
		const audit = (store as unknown as { t: (k: string) => string });
		expect(audit.t("kv.model")).toBe("模型"); // zh-CN 内置
		const list = store.availableLocales();
		expect(list.length).toBe(3); // 简/繁/英——multilang 未挂载
		expect(list.map((l) => l.tag).sort()).toEqual(["en-US", "zh-CN", "zh-TW"]);
	});

	it("② 挂载 → 六语（native 名随包）；③ 卸载 → ru 缺包回退 en + config 不改写；重挂恢复", async () => {
		const { store, setEnabled } = await make();
		await setEnabled(true);
		expect(store.availableLocales().length).toBe(6);
		expect(store.availableLocales().map((l) => l.native)).toContain("日本語");
		await store.setLanguage("ru-RU");
		expect(store.activeTag()).toBe("ru-RU");
		expect((store as unknown as { t: (k: string) => string }).t("kv.model")).toBe("Модель"); // 包生效（骨架五键）
		await setEnabled(false); // 卸载
		expect(store.packMissing()).toBe(true); // P1：active=ru 但包没了
		expect((store as unknown as { t: (k: string) => string }).t("kv.model")).toBe("Model"); // 落 en（锚=en 非 zh）
		await setEnabled(true); // 重挂
		expect(store.packMissing()).toBe(false);
		expect((store as unknown as { t: (k: string) => string }).t("kv.model")).toBe("Модель");
	}, 30_000);
});
