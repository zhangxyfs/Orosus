/**
 * m5-i18n 抽取生成器（T5 起用）：从译文对照表段件（ta/tb-zone-*）按键清单提取五语值，
 * 生成 locale 条目块（zh-CN/zh-TW/en-US 进界面主目录；ja/ko/ru 留 T17-T19 语言包搬运）。
 *
 * 用法：node --experimental-strip-types scripts/i18n-gen.mts <key前缀或键>...
 * 例：node --experimental-strip-types scripts/i18n-gen.mjs kv. panel.mod. tail.
 * 输出：stdout 三语 TS 条目（人审后贴进 apps/cli/src/locales/<tag>/<域>.ts）。
 *
 * C2 包侧：node --experimental-strip-types scripts/i18n-gen.mts --pack <分区>（如 w）
 * ——按 B 表该分区行集（tb-zone-<分区>-* 的表行）输出 ja/ko/ru 三块（i18n-pack-gen 同款
 * 转义/键序，贴 packages/modules/multilang/src/locales/）。⚠️ 分区行集过滤、禁 `web.` 前缀
 * 粗滤：m5 zone-d tool-web 57 键同用 web. 前缀（web.settings.desc*、web.llm.* 等），前缀滤会误收。
 */

import { parseTranslations } from "./i18n-audit.mts";

const args = process.argv.slice(2);
const packZone = args[0] === "--pack" ? args[1] : undefined;
const patterns = packZone === undefined ? args : args.slice(2);
if (patterns.length === 0 && packZone === undefined) {
	console.error("用法：i18n-gen.mts <key前缀或键>...（如 kv. panel.mod. mcp.action.）｜ --pack <分区>（如 w）");
	process.exit(1);
}
if (args[0] === "--pack" && packZone === undefined) {
	console.error("--pack 需分区参数（如 --pack w）");
	process.exit(1);
}

const { a, b } = parseTranslations();
// A 表行：r.zh = 简体原文；r.values = [繁體, English]
const escape = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
// 包侧转义（C2，E8 落表政策同款）：单元格内 \n 是 JS 源转义形（原字面量同形求值——真换行），
// 保单反斜杠不双写；其余反斜杠双写；双引号转 \"。若照 pack-gen 全量双写，diag markup 键在包语
// 会显字面 \n 文本（主侧三面已是转义形——六侧运行时值须同语义）。
const escapePack = (v: string): string => v.replace(/\\n/g, "\uE000").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\uE000/g, "\\n");

if (packZone !== undefined) {
	// 包侧（C2）：B 表分区行集 → ja/ko/ru 三块（列 0/1/2——i18n-pack-gen 同款取值/转义）
	const rows = b.filter((r) => r.zone === packZone);
	if (rows.length === 0) {
		console.error(`分区 ${packZone} 无 B 表行——先跑 i18n-audit 检查段件`);
		process.exit(1);
	}
	const packs: [string, number][] = [["ja-JP", 0], ["ko-KR", 1], ["ru-RU", 2]];
	for (const [tag, col] of packs) {
		console.log(`\n// ===== ${tag}（zone ${packZone} · ${rows.length} 键）=====`);
		for (const r of rows) console.log(`\t"${r.key}": "${escapePack(r.values[col] ?? "")}",`);
	}
	console.error(`分区 ${packZone}：${rows.length} 键 × ja/ko/ru（B 表行集过滤——非前缀滤）`);
} else {
	const match = (key: string): boolean => patterns.some((pat) => (pat.endsWith(".") ? key.startsWith(pat) : key === pat));
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
}
