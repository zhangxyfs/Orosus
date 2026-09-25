import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApiDocs, parseContractFile, auditSymbols, DOMAINS } from "../scripts/gen-api-docs.mts";

/** API 参考生成器（2026-09-25 重写）：fail-loud 完整性门禁 + 产物同步快照。 */

const read = (p: string): string => readFileSync(join(import.meta.dirname, "..", p), "utf8");

describe("API 参考生成器（Markdown 人话版）", () => {
	it("① 真实五域全过审计：每个导出有注释、每个带参口有 @param、module 域有 @example；产物六件齐", () => {
		const { files, symbols } = buildApiDocs(read);
		expect(symbols).toBeGreaterThanOrEqual(45);
		expect(files.map((f) => f.path)).toEqual(["docs/api/README.md", "docs/api/module.md", "docs/api/tool.md", "docs/api/provider.md", "docs/api/fs.md", "docs/api/home.md"]);
		const moduleMd = files.find((f) => f.path === "docs/api/module.md")!.content;
		expect(moduleMd).toContain("**方法参数**"); // 参数表在
		expect(moduleMd).toContain("**示例**"); // 示例在
	});

	it("② fail-loud：抹掉全部 @param → 抛错点名缺口（宁可不渲染，不给读者没说清的口）", () => {
		expect(() => buildApiDocs((p) => read(p).replace(/@param/g, "@arg"))).toThrow(/缺 @param/);
		expect(() => buildApiDocs((p) => read(p).replace(/@param/g, "@arg"))).toThrow(/CommandUi\.viewText|SettingsService\.setModel/);
	});

	it("③ fail-loud：导出无注释 → 抛错；module 域缺 @example → 抛错", () => {
		const src = parseContractFile(read("packages/contracts/src/module/index.ts"));
		const stripped = src.map((s) => (s.name === "Logger" ? { ...s, doc: { body: [], params: [] } } : s));
		expect(auditSymbols(stripped, DOMAINS[0]!).some((x) => x.includes("Logger：没有文档注释"))).toBe(true);
		const noEx = src.map((s) => (s.name === "PopupKey" ? { ...s, doc: { body: s.doc.body, params: s.doc.params } } : s));
		expect(auditSymbols(noEx, DOMAINS[0]!).some((x) => x.includes("PopupKey：缺 @example"))).toBe(true);
	});

	it("④ 产物入库同步：docs/api 六件与当前源生成结果一致（docs:check 门禁的测试面）", () => {
		const { files } = buildApiDocs(read);
		for (const f of files) {
			const onDisk = readFileSync(join(import.meta.dirname, "..", f.path), "utf8");
			expect(onDisk, f.path).toBe(f.content);
		}
	});
});
