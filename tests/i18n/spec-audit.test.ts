import { describe, expect, it } from "vitest";

import { parseInventory, parseTranslations } from "../../scripts/i18n-audit.mts";

/**
 * m5-i18n T0 对账钉（2026-10-07）：锁清单/译文表的源账不变量。
 * 数值有变动 = 有人动了规格表——要么有意（并键/拆键须同步改此钉与表头勘正记录），要么误编辑。
 */

describe("m5-i18n 全量清单对账（i18n-inventory/ 五分区）", () => {
	it("明细实数 1728 + 分区计数（账面 1731 为文档汇总算术漂移——zone-a −4 / zone-b +1，以明细为准）", () => {
		const rows = parseInventory();
		expect(rows.length).toBe(1728);
		const byZone = new Map<string, number>();
		for (const r of rows) byZone.set(r.zone, (byZone.get(r.zone) ?? 0) + 1);
		expect(Object.fromEntries([...byZone].sort())).toEqual({
			"a-tui-frame": 255,
			"b-commands-settings": 549,
			"c-main-onboarding": 266,
			"d-modules-a": 187,
			"e-modules-b": 471,
		});
	});

	it("键级去重 1704；译类（含合并指针）与不翻/协议/模型面分布稳定", () => {
		const rows = parseInventory();
		const seenKey = new Set<string>();
		const seenTextFile = new Set<string>();
		let unique = 0;
		let translatable = 0;
		let excluded = 0;
		for (const r of rows) {
			const keyed = r.key && !["—", "-"].includes(r.key);
			if (keyed) {
				if (seenKey.has(r.key)) continue;
				seenKey.add(r.key);
			} else {
				const tf = `${r.text}@@${r.file}`;
				if (seenTextFile.has(tf)) continue;
				seenTextFile.add(tf);
			}
			unique++;
			const head = r.disposition.split("（")[0]!.trim();
			if (head.startsWith("译")) translatable++;
			if (head.startsWith("不翻") || head.startsWith("协议") || head.startsWith("模型面") || head.startsWith("排除")) excluded++;
		}
		expect(unique).toBe(1704);
		expect(translatable).toBe(1478);
		// 不翻-专名 36 + 不翻-命令名 33 + 协议-不翻 21 + 不翻-键名 8 + 不翻-品牌 6 + 模型面-排除 64 + 排除·模型可见 1
		expect(excluded).toBe(169);
	});
});

describe("m5-i18n 五语译文对照表对账（ta/tb 分区段件 = 可编辑源）", () => {
	it("A/B 键数 2461=2461（m5 1496 + web 区 965）、键集零漂移、分区计数（web-i18n 批 2026-10-16：五段落表 + 跨段并键 15 + 主题族图标出节点并键 3；E5 2026-10-17 执行期补账 +1：web.render.chip.lines）", () => {
		const { a, b } = parseTranslations();
		expect(a.length).toBe(2461);
		expect(b.length).toBe(2461);
		const aKeys = new Set(a.map((r) => r.key));
		const bKeys = new Set(b.map((r) => r.key));
		expect(aKeys).toEqual(bKeys);
		// 键内零重复（同键双收是勘正⑥教训；web.* 前缀与 m5 zone-d tool-web 57 键前缀共存，撞键亦靠此闸）
		expect(aKeys.size).toBe(a.length);
		const zoneCounts = new Map<string, number>();
		for (const r of a) zoneCounts.set(r.zone, (zoneCounts.get(r.zone) ?? 0) + 1);
		expect(Object.fromEntries([...zoneCounts].sort())).toEqual({ a: 281, b: 502, c: 299, d: 176, e: 238, w: 965 });
	});

	it("zh 列 A/B 两表逐键一致 + 勘正⑩被删 11 键不再出现（抽取严禁双搬）+ web 并键 15 键不再出现", () => {
		const { a, b } = parseTranslations();
		const zhB = new Map(b.map((r) => [r.key, r.zh]));
		for (const r of a) expect(zhB.get(r.key), `zh 列漂移：${r.key}`).toBe(r.zh);
		const killed = [
			"tasks.mark.approval",
			"tasks.mark.background",
			"tasks.unloadBlock",
			"tasks.historyLabel",
			"tasks.pickTitle",
			"tasks.approvalTitle",
			"tasks.approve",
			"tasks.reject",
			"tasks.approved",
			"tasks.rejected",
			"tasks.viewTitle",
			// web-i18n 并键（2026-10-16 audit 同串异键 14 组——保留键见 ta-zone-w-* 复用节）
			"web.render.connecting",
			"web.ui.cwd.title",
			"web.pane.btw.fileTitle",
			"web.shell.sendTitle",
			"web.pane.btw.sendTitle",
			"web.pane.btw.sendAria",
			"web.pane.chevTitle",
			"web.pane.noTabs",
			"web.pane.addTitle",
			"web.view.footAnnounce",
			"web.view.footScroll",
			"web.spawn.taskFallback",
			"web.btw.modelsFetchFail",
			"web.misc.peers.phError",
			"web.render.spawn.rowTitle",
			// 主题族并键（2026-10-16 用户口令「文案不是一个文案么」——☀/☾ 图标出文本节点后浅色/深色各一键）
			"web.shell.themeLightFull",
			"web.settings.appearance.darkBtn",
			"web.settings.appearance.lightBtn",
		];
		const present = killed.filter((k) => zhB.has(k));
		expect(present, "被删键再现——并键决定被回退或误编辑").toEqual([]);
	});
});
