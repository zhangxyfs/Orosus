/**
 * m5-i18n T3：语言切换流程（/locale 直达命令与 /settings「切换语言」行共用）。
 *
 * 列表 = 内置三语原生名（永不翻译——P4）+ 语言包槽动态追加；当前语 ✓ 勾标（/model 先例）。
 * 选定 → h.setLanguage（写 config + 内核地板对齐）→ store.setLanguage（重建合并表）→ 宿主 repaint + toast。
 * Esc 不落盘（chooseVia 抛「已取消（Esc）」——上层 isEsc 静默）；选当前语 = 无操作。
 */

import type { Harness } from "@orosus/core";

import type { LocaleStore } from "./store.ts";

export interface LocaleSwitchDeps {
	getH(): Harness;
	store: LocaleStore;
}

/** 弹列表选语言；返回 toast 文案；未切换（选当前语）返回 undefined；取消抛「已取消（Esc）」。 */
export async function runLocaleSetting(chooseVia: (title: string, items: string[]) => Promise<string>, deps: LocaleSwitchDeps): Promise<string | undefined> {
	const locales = deps.store.availableLocales();
	const active = deps.store.activeTag();
	const items = locales.map((l) => (l.tag === active ? `${l.native} ✓` : l.native));
	const picked = await chooseVia("切换语言", items);
	const chosen = locales[items.indexOf(picked)];
	if (chosen === undefined || chosen.tag === active) return undefined; // 选当前语 = 无操作（不写盘）
	await deps.getH().setLanguage(chosen.tag);
	await deps.store.setLanguage(chosen.tag);
	return `语言已切换：${chosen.native}（已写入 config）`;
}
