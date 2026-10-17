import { describe, expect, it } from "vitest";

import { mainTables } from "../../apps/cli/src/locales/index.ts";
import { zhCNWeb } from "../../apps/cli/src/locales/zh-CN/web.ts";
import { jaJP } from "../../packages/modules/multilang/src/locales/ja-JP.ts";
import { koKR } from "../../packages/modules/multilang/src/locales/ko-KR.ts";
import { ruRU } from "../../packages/modules/multilang/src/locales/ru-RU.ts";
import { parseTranslations } from "../../scripts/i18n-audit.mts";

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

/** web-i18n C2：web.* 区六侧键集全等（parity ①式补主表三侧同核——multilang 包侧不可越界 import 主表，
 *  落位于此）。w 区表行集（ta/tb-zone-w-*，964 键）为核：三包全量含表、主表三侧同核、主侧缺口 =
 *  E5/E6/E8 登记的 17 不落键（外邦 w-2 退役/变体族 6〔sessionNote/markNew×2/forked/createdIn×2——
 *  现源无串，外邦集成时按补表纪律落表〕+ 无消费位公共微标签种子 11）——集成落表时此清单同步收缩。 */
describe("web-i18n C2：web.* 区六侧键集（三主表 + 三语言包 × w 区表行集）", () => {
	const W = new Set(
		parseTranslations()
			.a.filter((r) => r.zone === "w")
			.map((r) => r.key),
	);
	const EXPECTED_GAP = [
		"web.common.all",
		"web.common.clear",
		"web.common.close",
		"web.common.collapse",
		"web.common.copied",
		"web.common.copy",
		"web.common.expand",
		"web.common.none",
		"web.common.open",
		"web.common.search",
		"web.common.success",
		"web.cwd.sessionNote",
		"web.session.markNewPost",
		"web.session.markNewPre",
		"web.toast.createdInPost",
		"web.toast.createdInPre",
		"web.toast.forked",
	].sort();

	it("① w 区表行 964；主表三侧 web 切片同核且 ⊆ 表；三包 w 区键集全量含表（964）", () => {
		expect(W.size).toBe(964);
		const t = mainTables();
		const slice = (tag: string): string[] => Object.keys(t[tag]!).filter((k) => W.has(k)).sort();
		const cn = slice("zh-CN");
		expect(slice("zh-TW")).toEqual(cn); // 主表三侧同核（独立于全表 peers.win.* 基线红——那是 zh-TW 四键缺口，非 web 区）
		expect(slice("en-US")).toEqual(cn);
		expect(Object.keys(zhCNWeb).every((k) => W.has(k))).toBe(true); // web.ts 落表键全部有表行（禁无表落键）
		for (const [name, pack] of [["ja-JP", jaJP], ["ko-KR", koKR], ["ru-RU", ruRU]] as const) {
			expect(Object.keys(pack).filter((k) => W.has(k)).sort(), `${name} w 区全量含表`).toEqual([...W].sort());
		}
	});

	it("② 主侧缺口恰为登记的 17 键（外邦退役/变体族 6 + 无消费位种子 11——清单外的缺口即回归）", () => {
		const t = mainTables();
		const cn = new Set(Object.keys(t["zh-CN"]!).filter((k) => W.has(k)));
		expect([...W].filter((k) => !cn.has(k)).sort()).toEqual(EXPECTED_GAP);
	});
});
