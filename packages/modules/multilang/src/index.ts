/**
 * multilang 语言包模块（m5-i18n T16 骨架——空表占位，T17-T19 逐语搬运全键表）。
 *
 * 纯数据模块：无工具无命令；provides 三个语言包槽（每语言一 key、单所有者——规则 1 命名登记）。
 * defaultEnabled: false —— 全仓出厂模块首用（§5.3）：默认不挂载，挂载后 /locale 从三语变六语。
 * 挂载 = 模块挂载页翻转 enabled + reload（Added 路径）；卸载自动回退英文、配置不改写（P1）。
 */

import { defineModule } from "@orosus/contracts/module";

import { jaJP } from "./locales/ja-JP.ts";
import { koKR } from "./locales/ko-KR.ts";
import { ruRU } from "./locales/ru-RU.ts";

export default defineModule({
	name: "multilang",
	version: "0.1.0",
	description: "Language pack: Japanese / Korean / Russian message tables (pure data; mount to add them to /locale)",
	api: 1,
	defaultEnabled: false,
	provides: ["i18n.locale.ja-JP", "i18n.locale.ko-KR", "i18n.locale.ru-RU"],
	mounts: ["provide"],
	activate(ctx) {
		ctx.provide("i18n.locale.ja-JP", { native: "日本語", messages: jaJP });
		ctx.provide("i18n.locale.ko-KR", { native: "한국어", messages: koKR });
		ctx.provide("i18n.locale.ru-RU", { native: "Русский", messages: ruRU });
	},
});
