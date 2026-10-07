import { describe, expect, it } from "vitest";

import { pickFromSignals } from "./detect.ts";

describe("m5-i18n 检测：pickFromSignals 三平台矩阵（P2）", () => {
	it("win32：ICU 真值优先于 env（Git Bash LANG=en_US 噪音免疫）；Hans/Hant 分族；无 ICU 才看 env", () => {
		expect(pickFromSignals({ platform: "win32", icuLocale: "zh-CN", envChain: ["en_US.UTF-8"] })).toBe("zh-CN");
		expect(pickFromSignals({ platform: "win32", icuLocale: "zh-TW" })).toBe("zh-TW");
		expect(pickFromSignals({ platform: "win32", icuLocale: "zh-Hans-CN" })).toBe("zh-CN");
		expect(pickFromSignals({ platform: "win32", icuLocale: "zh-Hant" })).toBe("zh-TW");
		expect(pickFromSignals({ platform: "win32", icuLocale: "en-US" })).toBe("en-US");
		expect(pickFromSignals({ platform: "win32", icuLocale: "fr-FR" })).toBe("en-US"); // 非 zh → en
		expect(pickFromSignals({ platform: "win32", envChain: ["zh_CN.UTF-8"] })).toBe("zh-CN"); // ICU 缺席兜底
		expect(pickFromSignals({ platform: "win32" })).toBe("en-US");
	});

	it("linux：四级链 LC_ALL > LC_MESSAGES > LANG > LC_CTYPE；C/POSIX 视为未设", () => {
		expect(pickFromSignals({ platform: "linux", envChain: ["zh_CN.UTF-8", "en_US.UTF-8"] })).toBe("zh-CN");
		expect(pickFromSignals({ platform: "linux", envChain: [undefined, "en_US.UTF-8", "zh_TW.UTF-8"] })).toBe("en-US");
		expect(pickFromSignals({ platform: "linux", envChain: [undefined, undefined, "zh_TW.big5"] })).toBe("zh-TW");
		expect(pickFromSignals({ platform: "linux", envChain: [undefined, undefined, undefined, "zh_CN"] })).toBe("zh-CN");
		expect(pickFromSignals({ platform: "linux", envChain: ["C", "POSIX", "C.UTF-8", undefined] })).toBe("en-US");
		expect(pickFromSignals({ platform: "linux", envChain: [] })).toBe("en-US");
	});

	it("darwin：env 先；env 全空走 AppleLocale 兜底；再无 = en-US", () => {
		expect(pickFromSignals({ platform: "darwin", envChain: ["en_US.UTF-8"], appleLocale: "zh_CN" })).toBe("en-US"); // env 优先
		expect(pickFromSignals({ platform: "darwin", envChain: [], appleLocale: "zh_TW" })).toBe("zh-TW");
		expect(pickFromSignals({ platform: "darwin", envChain: ["C"], appleLocale: "ja_JP" })).toBe("en-US"); // 非 zh → en
		expect(pickFromSignals({ platform: "darwin", envChain: [], appleLocale: undefined })).toBe("en-US");
	});

	it("未知平台：env 链兜底后 en-US；全缺 en-US", () => {
		expect(pickFromSignals({ platform: "freebsd", envChain: ["zh_CN.UTF-8"] })).toBe("zh-CN");
		expect(pickFromSignals({ platform: "freebsd" })).toBe("en-US");
	});
});
