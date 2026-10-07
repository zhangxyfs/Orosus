import { afterEach, describe, expect, it } from "vitest";

import { bindTestLocale, t } from "./app.ts";

/** m5-i18n T4：宿主 t 单例——缺省 zh-CN（存量测试零装配）、测试侧可切三语。 */
describe("m5-i18n 宿主 t 单例", () => {
	afterEach(() => bindTestLocale("zh-CN")); // 复位缺省——单例跨测试污染防护

	it("缺省 zh-CN：试点键按主目录解析（未 bind store 也有值——启动窗口/测试面）", () => {
		expect(t("kv.model")).toBe("模型");
		expect(t("input.placeholder.main")).toContain("Orosus");
	});

	it("bindTestLocale 切三语：渲染面同键换语（切语言 = 新绘面新语言）", () => {
		bindTestLocale("en-US");
		expect(t("kv.model")).toBe("Model");
		expect(t("foot.sendKeys")).toBe("Enter Send · Alt+Enter Newline");
		bindTestLocale("zh-TW");
		expect(t("kv.session")).toBe("工作階段");
		expect(t("panel.mod.mounted")).toBe("已掛載");
	});

	it("缺键走地板与 fallback：core.* 地板键可见；未知键 → fallback → key 本身（D2）", () => {
		expect(t("core.kernel.disabled")).toContain("未启用"); // 地板并进 tui 侧表
		expect(t("no.such.key", undefined, "兜底")).toBe("兜底");
		expect(t("no.such.key")).toBe("no.such.key");
		bindTestLocale("en-US");
		expect(t("core.kernel.disabled")).toContain("Not enabled");
	});
});
