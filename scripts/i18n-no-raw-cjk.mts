/**
 * m5-i18n T4：i18n-no-raw-cjk 门禁——TS AST 扫「已入册」渲染文件里的 CJK 字符串字面量。
 *
 * 棘轮模型（诚实的渐进门）：抽取任务（T4-T14）逐文件入册——
 * - max = -1（strict）：该文件零 CJK 字面量（抽取完的终态）；
 * - max ≥ 0：该文件现存 CJK 字面量数的上限（只许降不许升——每轮抽取后收紧）。
 * 白名单同源（D13）：apps/cli/src/i18n/protocol-strings.ts 的 PROTOCOL_STRINGS 值放行（协议判据串）。
 * 注释天然不扫（AST 只看字面量）；测试/locales/脚本/md 资产不在扫描面。
 *
 * 用法：node --experimental-strip-types scripts/i18n-no-raw-cjk.mts [--report]
 * 违规 = 任何文件超其 max → 退出码 1 并逐条列出（file:line + 字面量截断）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { PROTOCOL_STRINGS } from "../apps/cli/src/i18n/protocol-strings.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 入册清单（T4 试点起步；T5-T14 各区抽取任务入册其文件并收紧 max）。 */
export const ENROLLED: readonly { file: string; max: number; note?: string }[] = [
	{ file: "apps/cli/src/tui/fullapp-types.ts", max: 0, note: "T5 清零（elapsed/diag.more 族已 t() 化）" },
	{ file: "apps/cli/src/tui/fullapp-frame.ts", max: 0, note: "T4 试点清零（唯一残余 = logWarn 诊断串走 i18n:diag 豁免）" },
	{ file: "apps/cli/src/tui/fullapp-panels.ts", max: 0, note: "T5 清零（尾行/状态页/网络页/任务页已 t() 化）" },
	{ file: "apps/cli/src/modules-ui.ts", max: 0, note: "T8 清零（预设两串为 h.log 诊断——diag 豁免）" },
	{ file: "apps/cli/src/proxy-env.ts", max: 0, note: "T5 清零" },
	{ file: "apps/cli/src/mcp-ui.ts", max: 8, note: "T5 入册；残余 = 键帽行八处（清单标不翻-键名——Alt+N 添加等动词面走查定夺）" },
	{ file: "apps/cli/src/subagent-status.ts", max: 0, note: "T5 清零（agent 组全族 + sub.status.failed 补账）" },
	{ file: "apps/cli/src/tui/fullapp-overlay.ts", max: 0, note: "T6 清零（pick/at/菜单/诊断/总览 chrome 全族）" },
	{ file: "apps/cli/src/picker.ts", max: 0, note: "T6 清零" },
	{ file: "apps/cli/src/menu.ts", max: 0, note: "T6 清零（行模式 choose chrome）" },
	{ file: "apps/cli/src/tui/fullapp-select.ts", max: 0, note: "T6 清零（选区复制/链接三则）" },
	{ file: "apps/cli/src/repl-io.ts", max: 0, note: "T7 清零（行模式 IO chrome；补全抛错诊断行 diag 豁免）" },
	{ file: "apps/cli/src/paste.ts", max: 0, note: "T7 清零（PASTE_EMPTY/pasteOkHint 改函数）" },
	{ file: "apps/cli/src/altpaste.ts", max: 0, note: "T7 清零" },
	{ file: "apps/cli/src/module-deps.ts", max: 0, note: "T7 清零（挂/卸载阻断两由）" },
	{ file: "apps/cli/src/module-toggle-result.ts", max: 0, note: "T7 清零（动词键 + {list/无} 模板缺省）" },
	{ file: "apps/cli/src/settings-ui.ts", max: 0, note: "T8 清零（根列表/子代理子菜单/导入族/busy·reloaded 串）" },
	{ file: "apps/cli/src/usage-text.ts", max: 0, note: "T8 清零（三用量卡全族——全角填充随表值）" },
	{ file: "apps/cli/src/compaction-view.ts", max: 0, note: "T8 清零（compact.* 四键）" },
	{ file: "apps/cli/src/sessions.ts", max: 0, note: "T8 清零（相对时间/空态/序号提示/未命名）" },
	{ file: "apps/cli/src/help.ts", max: 0, note: "T9 清零（HELP_TEXT→helpText() 组装）" },
	{ file: "apps/cli/src/args.ts", max: 0, note: "T9 清零" },
	{ file: "apps/cli/src/home-cmd.ts", max: 0, note: "T9 清零" },
	{ file: "apps/cli/src/prune.ts", max: 0, note: "T9 清零" },
	{ file: "apps/cli/src/module-cmd.ts", max: 0, note: "T9 清零" },
	{ file: "apps/cli/src/provider-cmd.ts", max: 0, note: "T9 清零（success： 前缀=PROVIDER_WRITE_DONE 判据不动）" },
	{ file: "apps/cli/src/skills-ui.ts", max: 0, note: "T10 清零（SKILL_MARK 协议族走 D13 登记表）" },
	{ file: "apps/cli/src/skill-settings.ts", max: 0, note: "T10 清零（skillseed 两键）" },
	{ file: "apps/cli/src/tasks-cmd.ts", max: 0, note: "T10 清零（agent 组/审批应答/查看窗题）" },
	{ file: "apps/cli/src/subagent-settings.ts", max: 0, note: "T10 清零（APPROVAL_MENU/PRESETS 惰性化）" },
	{ file: "apps/cli/src/module-confirm.ts", max: 0, note: "T10 清零" },
	{ file: "apps/cli/src/module-diagnostics.ts", max: 0, note: "T10 清零（判据行 diag 豁免——双语扩表走查定）" },
	{ file: "apps/cli/src/vision-media.ts", max: 0, note: "T10 清零（vision.why 族）" },
];

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/; // CJK 统一表意 + 部首 + CJK 符号/全角（不含假名谚文——界面串以汉字为主，误报宁可少）

/** 扫单文件源码：返回含 CJK 的字面量（file:line + 文本）。可导入形态供测试。 */
export function scanSource(file: string, source: string): { line: number; text: string }[] {
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
	const hits: { line: number; text: string }[] = [];
	const visit = (node: ts.Node): void => {
		const isDiag = (pos: number): boolean => {
			// 行级诊断豁免：ROADMAP 边界「诊断面不翻译」的显式出口——该行尾注 i18n:diag 即放行
			const { line } = sf.getLineAndCharacterOfPosition(pos);
			const lineStart = sf.getLineStarts()[line] ?? 0;
			const lineEnd = source.indexOf("\n", lineStart);
			return source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).includes("i18n:diag");
		};
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			const text = node.text;
			if (CJK.test(text) && !PROTOCOL_STRINGS.includes(text) && !isDiag(node.getStart(sf))) {
				const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
				hits.push({ line: line + 1, text });
			}
		} else if (ts.isTemplateExpression(node)) {
			// 带插值模板：head 与 middle 静态段照扫
			for (const seg of [node.head.text, ...node.templateSpans.map((sp) => sp.literal.text)]) {
				if (CJK.test(seg) && !PROTOCOL_STRINGS.includes(seg) && !isDiag(node.getStart(sf))) {
					const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
					hits.push({ line: line + 1, text: seg });
				}
			}
			node.templateSpans.forEach((sp) => visit(sp.expression));
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return hits;
}

export function run(): number {
	let bad = 0;
	for (const entry of ENROLLED) {
		const source = readFileSync(join(ROOT, entry.file), "utf8");
		const hits = scanSource(entry.file, source);
		if (hits.length > entry.max) {
			bad += hits.length - Math.max(0, entry.max);
			console.error(`${entry.file}：CJK 字面量 ${hits.length} 处 > 上限 ${entry.max}${entry.note ? `（${entry.note}）` : ""}`);
			for (const h of hits) console.error(`  ${entry.file}:${h.line}  ${h.text.slice(0, 60)}`);
		}
	}
	if (bad > 0) {
		console.error(`i18n-no-raw-cjk：${bad} 处超限（棘轮只降不升——抽取后收紧 max，终态 -1）`);
		return 1;
	}
	console.log(`i18n-no-raw-cjk：${ENROLLED.length} 个入册文件全过（白名单 ${PROTOCOL_STRINGS.length} 条协议串）`);
	return 0;
}

const { resolve } = await import("node:path");
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exit(run());
}
