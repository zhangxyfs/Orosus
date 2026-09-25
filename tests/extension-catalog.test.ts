import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog, CATALOG_ENTRIES } from "../scripts/gen-extension-catalog.mts";

/** m5 T16：扩展点目录生成器——fail-loud 门禁 + 输出快照。 */

const realSource = readFileSync(join(import.meta.dirname, "..", "packages/contracts/src/module/index.ts"), "utf8");

describe("扩展点目录生成器（m5 T16）", () => {
	it("① 真实契约源生成成功：全部条目有注释与 @example，输出含人话/声明/示例三件", () => {
		const { markdown, entries } = buildCatalog(realSource);
		expect(entries).toBe(CATALOG_ENTRIES.length);
		for (const e of CATALOG_ENTRIES) {
			expect(markdown).toContain(`### ${e.id}`);
		}
		expect(markdown).toContain("```ts");
	});

	it("② fail-loud：缺 @example 的源即抛错点名条目（宁可不渲染，不给模型调不了的口）", () => {
		const stripped = realSource.replace(/@example/g, "@sample"); // 抹掉全部示例标记
		expect(() => buildCatalog(stripped)).toThrow(/fail-loud/);
		expect(() => buildCatalog(stripped)).toThrow(/contribute\.tool/);
	});

	it("③ fail-loud：条目声明消失（口子被删）也抛错——目录与契约不许漂移", () => {
		const removed = realSource.replace("card?(spec: CardSpec): Disposer;", "cardX?(spec: CardSpec): Disposer;");
		expect(() => buildCatalog(removed)).toThrow(/contribute\.card/);
	});

	it("④ 产物入库同步：docs/extension-catalog.md 与当前源生成结果一致（docs:check 门禁的测试面）", () => {
		const onDisk = readFileSync(join(import.meta.dirname, "..", "docs/extension-catalog.md"), "utf8");
		expect(onDisk).toBe(buildCatalog(realSource).markdown);
	});
});
