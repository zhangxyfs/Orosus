/**
 * m5-i18n T15：紧槽位宽度预算登记表——把「放得下」变成测试。
 *
 * 预算来源（方案 §四锚点，2026-10-07 实核）：
 * - KV 标签列恒 8 格：fullapp-panels.ts:49 kvRow padToWidth(label, 8) + widgets.ts:101 同款；
 * - skill 列表徽章 statusW=4：skill-settings.ts:99（全仓唯一固定宽徽章列）。
 * 其余槽位（按钮行/键帽行/页题）走 truncateToWidth 宽裕位不设预算（方案 §6.2 分级）。
 * 测试（width-budgets.test.ts）遍历六语 × 预算键断言 visibleWidth(t(tag,key)) ≤ budget；
 * 超预算 → 改短形（译文表备注留全称）。ru 是最大风险语种（方案 §6.1）。
 */

import { visibleWidth } from "../tui/width.ts";
import { t } from "../i18n/app.ts";

/** 紧槽位预算（格数 = visibleWidth 口径——EAW 双宽计 2）。 */
export const WIDTH_BUDGETS: readonly { keys: readonly string[]; budget: number; slot: string }[] = [
	{
		slot: "kv 标签列（padToWidth 8——fullapp-panels kvRow / widgets kv）",
		budget: 8,
		keys: [
			"kv.model", "kv.session", "kv.cwd", "kv.elapsed", "kv.context", "kv.proxy", "kv.modelService",
			// approval 弹窗行内标签（approval/src/index.ts:171——approval.dialog.* 表键）
			"approval.dialog.tool", "approval.dialog.rule", "approval.dialog.access", "approval.dialog.reason",
			// modconfirm 详情窗 KV 标签（widgets kv 同款 8 格列）
			"modconfirm.source", "modconfirm.provides", "modconfirm.dependsOn", "modconfirm.mounts", "modconfirm.uses",
		],
	},
	{
		slot: "skill 列表徽章列（statusW=4——skill-settings.ts:99）",
		budget: 4,
		keys: ["skill.badge.on", "skill.badge.off"],
	},
];

/** 六语遍历面（内置三 + 语言包三——包未挂载时跳过该语并报告）。 */
export function budgetCheck(activeTags: readonly string[]): { tag: string; key: string; width: number; budget: number; slot: string }[] {
	const violations: { tag: string; key: string; width: number; budget: number; slot: string }[] = [];
	for (const entry of WIDTH_BUDGETS) {
		for (const tag of activeTags) {
			for (const key of entry.keys) {
				const value = t(key, undefined, "");
				if (value === "") continue; // 键缺席（该语未收）不判预算——parity 门另管
				const width = visibleWidth(value);
				if (width > entry.budget) violations.push({ tag, key, width, budget: entry.budget, slot: entry.slot });
			}
		}
	}
	return violations;
}
