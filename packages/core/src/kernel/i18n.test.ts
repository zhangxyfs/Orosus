import { describe, expect, it } from "vitest";

import { kernelT, setKernelLocale } from "./i18n.ts";

describe("m5-i18n 内核地板 t（kernelT）", () => {
	it("缺省 zh-CN：failReason 族中文（存量行为不动）", () => {
		setKernelLocale(undefined);
		expect(kernelT("core.kernel.disabled")).toBe("未启用（defaultEnabled=false 或配置/CLI 禁用，§5.4）");
	});

	it("setKernelLocale 切三语；未知 tag 落 en（P1 降级锚）", () => {
		setKernelLocale("en-US");
		expect(kernelT("core.kernel.disabled")).toBe("Not enabled (defaultEnabled=false or disabled via config/CLI, §5.4)");
		setKernelLocale("zh-TW");
		expect(kernelT("core.kernel.disabled")).toBe("未啟用（defaultEnabled=false 或設定/CLI 停用，§5.4）");
		setKernelLocale("xx-YY");
		expect(kernelT("core.kernel.disabled")).toBe("Not enabled (defaultEnabled=false or disabled via config/CLI, §5.4)");
		setKernelLocale("zh-Hans-CN");
		expect(kernelT("core.kernel.disabled")).toBe("未启用（defaultEnabled=false 或配置/CLI 禁用，§5.4）");
	});

	it("形参插值与缺省（cascade {key}/{name}；model {model|（未配置）}）", () => {
		setKernelLocale("zh-CN");
		expect(kernelT("core.activate.err.cascade", { key: "a.b", name: "mod" })).toBe('硬依赖能力 "a.b" 的提供者 mod 已降级（级联降级）');
		expect(kernelT("core.context.model")).toBe("模型: （未配置）");
		expect(kernelT("core.context.model", { model: "glm" })).toBe("模型: glm");
	});

	it("缺键 → fallback 参数 → key 本身（D2）", () => {
		expect(kernelT("no.such.key", undefined, "兜底")).toBe("兜底");
		expect(kernelT("no.such.key")).toBe("no.such.key");
	});
});
