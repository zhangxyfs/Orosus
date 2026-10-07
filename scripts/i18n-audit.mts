/**
 * m5-i18n T0 对账脚本（2026-10-07）：对账三件——
 * ① 全量清单五分区明细行数 / 跨区去重 / 处置分布精数；
 * ② 五语译文对照表 A/B 键集平行、分区计数、zh 列两表一致；
 * ③ 同串异键检测（tasks-cmd A/B 双键族——方案 §九：T0 并键定名、抽取严禁双搬）。
 *
 * 用法：node --experimental-strip-types scripts/i18n-audit.mts
 * 测试锁（tests/i18n/spec-audit.test.ts）断言本脚本的全部不变量；本脚本供人读报告。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const specsDir = join(repoRoot, "docs", "superpowers", "specs");

/** 按首个单元格切表行（清单区 E 以全角 ｜ 代管道，无需转义处理；译文表单元格内 \| 需先保护）。 */
const ESCAPED_PIPE = "\uE000"; // 私用区占位符——\u0000 会被 oxlint no-control-regex 拦
function splitRow(line: string): string[] {
	const protectedLine = line.replace(/\\\|/g, ESCAPED_PIPE);
	return protectedLine
		.slice(protectedLine.startsWith("|") ? 1 : 0, protectedLine.endsWith("|") ? -1 : 0)
		.split("|")
		.map((c) => c.split(ESCAPED_PIPE).join("|").replace(/^ /, "").replace(/ $/, "")); // 只剥单格 padding——前导" · "等有义空格保真
}

/**
 * 清单明细行专用：两端定界解析——行锚=首格、处置=末格、建议键=次末格、原文=中间余量。
 * 原文格存在未转义裸管道（如 `{HTTP|stdio}`、`--dry-run|--apply`），中切会碎行。
 */
function splitDetailRow(line: string): string[] | undefined {
	const segs = splitRow(line);
	if (segs.length < 4) return undefined;
	const anchor = segs[0]!;
	const disp = segs.at(-1)!;
	const key = segs.at(-2)!;
	const text = segs.slice(1, -2).join("|");
	return [anchor, text, key, disp];
}

// ---------- ① 全量清单五分区 ----------

export interface InventoryRow {
	zone: string;
	file: string;
	anchor: string;
	text: string;
	key: string;
	disposition: string;
}

export function parseInventory(): InventoryRow[] {
	const rows: InventoryRow[] = [];
	const zoneFiles = readdirSync(join(specsDir, "i18n-inventory")).filter((f) => f.endsWith(".md")).sort();
	let zone = "";
	let file = "";
	for (const zf of zoneFiles) {
		zone = zf.replace(/^zone-/, "").replace(/\.md$/, "");
		file = "";
		let inDetail = false;
		for (const line of readFileSync(join(specsDir, "i18n-inventory", zf), "utf8").split(/\r?\n/)) {
			if (line.startsWith("## 明细")) {
				inDetail = true;
				continue;
			}
			const h3 = /^### (.+)/.exec(line);
			if (h3) {
				file = h3[1]!.trim();
				continue;
			}
			if (!inDetail || !line.startsWith("|")) continue;
			if (/^\|\s*---/.test(line)) continue;
			const cells = splitDetailRow(line);
			if (!cells || cells[0] === "行锚") continue;
			rows.push({ zone, file, anchor: cells[0]!, text: cells[1]!, key: cells[2]!, disposition: cells[3]! });
		}
	}
	return rows;
}

// ---------- ② 五语译文对照表（分区段件 ta/tb- 为可编辑源） ----------

export interface TranslationRow {
	zone: string;
	key: string;
	zh: string;
	/** A 表：zh-TW / en；B 表：ja / ko / ru */
	values: string[];
	note: string;
}

function parseTranslationsSide(prefix: "ta" | "tb"): TranslationRow[] {
	const rows: TranslationRow[] = [];
	const files = readdirSync(join(specsDir, "i18n-translations"))
		.filter((f) => f.startsWith(`${prefix}-zone-`) && f.endsWith(".md"))
		.sort();
	let zone = "";
	for (const f of files) {
		zone = f.replace(`${prefix}-zone-`, "").replace(/-\d+\.md$/, "");
		for (const line of readFileSync(join(specsDir, "i18n-translations", f), "utf8").split(/\r?\n/)) {
			if (!line.startsWith("|")) continue;
			if (/^\|\s*---/.test(line)) continue;
			const cells = splitRow(line);
			if (cells[0] === "键") continue;
			if (cells.length < 5) continue; // 表头/异常行
			rows.push({ zone, key: cells[0]!, zh: cells[1]!, values: cells.slice(2, -1), note: cells.at(-1) ?? "" });
		}
	}
	return rows;
}

export function parseTranslations(): { a: TranslationRow[]; b: TranslationRow[] } {
	return { a: parseTranslationsSide("ta"), b: parseTranslationsSide("tb") };
}

// ---------- ③ 报告 ----------

function report(): void {
	const inv = parseInventory();
	const byZone = new Map<string, number>();
	for (const r of inv) byZone.set(r.zone, (byZone.get(r.zone) ?? 0) + 1);
	const totalRows = inv.length;

	// 跨区去重：键优先（键即身份）；键为空的行（合并指针等）按 原文+文件 去重
	const seenKey = new Set<string>();
	const seenTextFile = new Set<string>();
	const unique: InventoryRow[] = [];
	for (const r of inv) {
		if (r.key && !["—", "-"].includes(r.key)) {
			if (seenKey.has(r.key)) continue;
			seenKey.add(r.key);
		} else {
			const tf = `${r.text}@@${r.file}`;
			if (seenTextFile.has(tf)) continue;
			seenTextFile.add(tf);
		}
		unique.push(r);
	}

	const byDisp = new Map<string, number>();
	for (const r of unique) {
		const d = r.disposition.split(/[（(（]/)[0]!.trim();
		byDisp.set(d, (byDisp.get(d) ?? 0) + 1);
	}

	console.log("== 清单（i18n-inventory/ 五分区） ==");
	console.log(`明细行合计：${totalRows}（T0 实测 1728；原账面 1731 = 文档侧汇总表算术漂移 zone-a −4 / zone-b +1，见清单主文件 §一 T0 勘正）`);
	for (const [z, n] of [...byZone].sort()) console.log(`  zone-${z}: ${n}`);
	console.log(`跨区去重后（键级口径）：${unique.length}（账面 ≈1515 为原文级跨区估算，两法口径不同——键级含同串异键多行）`);
	console.log("处置分布（去重后）：");
	for (const [d, n] of [...byDisp].sort((x, y) => y[1]! - x[1]!)) console.log(`  ${d}: ${n}`);

	const { a, b } = parseTranslations();
	const aKeys = a.map((r) => r.key);
	const bKeys = b.map((r) => r.key);
	const aSet = new Set(aKeys);
	const bSet = new Set(bKeys);
	const dupA = aKeys.filter((k, i) => aKeys.indexOf(k) !== i);
	console.log("\n== 译文对照表（ta/tb 分区段件） ==");
	console.log(`A 表键数：${a.length}（勘正⑩-⑰后 1356）；B 表键数：${b.length}（勘正⑩-⑰后 1356）`);
	console.log(`A/B 键集漂移：${[...aSet].filter((k) => !bSet.has(k)).length} + ${[...bSet].filter((k) => !aSet.has(k)).length}`);
	if (dupA.length) console.log(`A 表键内重复：${[...new Set(dupA)].join(", ")}`);
	const zoneA = new Map<string, number>();
	for (const r of a) zoneA.set(r.zone, (zoneA.get(r.zone) ?? 0) + 1);
	console.log(`分区计数（勘正⑩-⑰后 224/495/226/174/237）：${[...zoneA.entries()].sort().map(([z, n]) => `${z}=${n}`).join(" ")}`);

	// zh 列两表一致（B 表基准列 = A 表原文列）
	const zhB = new Map(b.map((r) => [r.key, r.zh]));
	const zhMismatch = a.filter((r) => zhB.get(r.key) !== r.zh).map((r) => `${r.key}: A=${JSON.stringify(r.zh)} B=${JSON.stringify(zhB.get(r.key))}`);
	console.log(`zh 列 A/B 不一致：${zhMismatch.length}${zhMismatch.length ? "\n  " + zhMismatch.join("\n  ") : ""}`);

	// 同串异键（去重后清单侧 + 译文表侧各报一份；tasks 族 A/B 双键 = 方案 §九勘正⑥）
	const byText = new Map<string, Set<string>>();
	for (const r of a) {
		if (!byText.has(r.zh)) byText.set(r.zh, new Set());
		byText.get(r.zh)!.add(r.key);
	}
	const dupText = [...byText.entries()].filter(([, ks]) => ks.size > 1);
	console.log(`\n== 同串异键（A 表，zh 值相同键不同——需并键定名） ==`);
	for (const [text, ks] of dupText) console.log(`  ${JSON.stringify(text)} ← ${[...ks].join(" / ")}`);
	console.log(`共 ${dupText.length} 组（账面：tasks 族 11 对 + 共用短串若干）`);
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) report();
