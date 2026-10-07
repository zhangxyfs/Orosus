import { describe, expect, it } from "vitest";

import { mainTables } from "../../apps/cli/src/locales/index.ts";

/** m5-i18n T4：界面主目录三语 parity 硬锁（试点起跑——后续任务每加一键三语必须同步，否则此钉红）。 */
describe("m5-i18n 界面主目录三语 parity", () => {
	it("zh-CN / zh-TW / en-US 键集完全一致（parity 从试点起即三语锁——方案 §七）", () => {
		const tables = mainTables();
		const zhCN = Object.keys(tables["zh-CN"]!).sort();
		const zhTW = Object.keys(tables["zh-TW"]!).sort();
		const enUS = Object.keys(tables["en-US"]!).sort();
		expect(zhTW).toEqual(zhCN);
		expect(enUS).toEqual(zhCN);
		expect(zhCN.length).toBeGreaterThanOrEqual(26); // 试点基线：input 7 + panels 19
	});

	it("试点键三语值抽查（KV 短形/状态映射/权限三档——值漂移即红）", () => {
		const t = mainTables();
		expect(t["zh-CN"]!["kv.cwd"]).toBe("工作目录");
		expect(t["en-US"]!["kv.cwd"]).toBe("Workdir"); // 紧槽短形（Directory 9 格超 8）
		expect(t["zh-TW"]!["kv.session"]).toBe("工作階段");
		expect(t["en-US"]!["panel.conn.idle"]).toBe("Lazy");
		expect(t["zh-CN"]!["perm.never"]).toBe("从不询问");
		expect(t["en-US"]!["frame.error"]).toContain("Render error");
	});
});
