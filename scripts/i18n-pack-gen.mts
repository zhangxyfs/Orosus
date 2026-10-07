/**
 * m5-i18n T17-T19：三语全键包生成器——从译文对照表 B 表（tb-zone-* 段件）搬运 ja/ko/ru 全键。
 * 输出三件 locale TS（packages/modules/multilang/src/locales/），键集 == 内置键集（D9 parity 硬锁）。
 *
 * 用法：node --experimental-strip-types scripts/i18n-pack-gen.mts
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTranslations } from "./i18n-audit.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACK_DIR = join(ROOT, "packages", "modules", "multilang", "src", "locales");

const { b } = parseTranslations();
if (b.length === 0) throw new Error("B 表空——先跑 i18n-audit 检查段件");

const langs: { tag: string; col: 0 | 1 | 2; varName: string; head: string }[] = [
	{ tag: "ja-JP", col: 0, varName: "jaJP", head: "ja-JP 语言包（T17 搬运自五语译文对照表 B 表——事实源即本件）。" },
	{ tag: "ko-KR", col: 1, varName: "koKR", head: "ko-KR 语言包（T18 搬运自五语译文对照表 B 表——事实源即本件）。" },
	{ tag: "ru-RU", col: 2, varName: "ruRU", head: "ru-RU 语言包（T19 搬运自五语译文对照表 B 表——复数三形 {1:|2:|5:} 模板由 @orosus/i18n CLDR 选择器落地）。" },
];

const escape = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

for (const lang of langs) {
	const lines: string[] = [`/** ${lang.head} */`, `export const ${lang.varName}: Record<string, string> = {`];
	for (const row of b) {
		const value = row.values[lang.col] ?? "";
		lines.push(`\t"${row.key}": "${escape(value)}",`);
	}
	lines.push("};");
	writeFileSync(join(PACK_DIR, `${lang.tag}.ts`), lines.join("\n") + "\n", "utf8");
	console.log(`${lang.tag}: ${b.length} 键`);
}
