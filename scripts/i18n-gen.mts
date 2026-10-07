/**
 * m5-i18n 抽取生成器（T5 起用）：从译文对照表段件（ta/tb-zone-*）按键清单提取五语值，
 * 生成 locale 条目块（zh-CN/zh-TW/en-US 进界面主目录；ja/ko/ru 留 T17-T19 语言包搬运）。
 *
 * 用法：node --experimental-strip-types scripts/i18n-gen.mts <key前缀或键>...
 * 例：node --experimental-strip-types scripts/i18n-gen.mjs kv. panel.mod. tail.
 * 输出：stdout 三语 TS 条目（人审后贴进 apps/cli/src/locales/<tag>/<域>.ts）。
 */

import { parseTranslations } from "./i18n-audit.mts";

const args = process.argv.slice(2);
if (args.length === 0) {
	console.error("用法：i18n-gen.mts <key前缀或键>...（如 kv. panel.mod. mcp.action.）");
	process.exit(1);
}

const { a } = parseTranslations();
const match = (key: string): boolean => args.some((pat) => (pat.endsWith(".") ? key.startsWith(pat) : key === pat));

const escape = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
// A 表行：r.zh = 简体原文；r.values = [繁體, English]
const valueOf = (r: (typeof a)[number], tag: string): string | undefined =>
	tag === "zh-CN" ? r.zh : tag === "zh-TW" ? r.values[0] : r.values[1];
for (const tag of ["zh-CN", "zh-TW", "en-US"] as const) {
	const rows = a.filter((r) => match(r.key));
	if (rows.length === 0) continue;
	console.log(`\n// ===== ${tag}（${rows.length} 键）=====`);
	for (const r of rows) console.log(`\t"${r.key}": "${escape(valueOf(r, tag) ?? "")}",`);
}
console.error(`共 ${a.filter((r) => match(r.key)).length} 键命中`);
