import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { mainTables } from "../../apps/cli/src/locales/index.ts";

/**
 * m5-i18n 回归钉：apps/cli 源码里每个 t("...") 字面键必须在 zh-CN 主目录可解析。
 * 缘起：dialog 族与 picker 族等键在代码里使用但从未落 locale（门禁只查 CJK 字面量不查键解析）——
 * 缺键静默显 key 本身（D2），用户看到裸键串。此钉扫源码全量断言。
 */

function* walk(dir: string): Generator<string> {
	for (const name of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, name.name);
		if (name.isDirectory()) yield* walk(p);
		else if (name.name.endsWith(".ts") && !name.name.endsWith(".test.ts")) yield p;
	}
}

describe("m5-i18n t() 键全解析钉", () => {
	it("apps/cli 源码全部 t(\"...\") 字面键 ∈ zh-CN 主目录（缺键=裸显 key 串）", () => {
		const zh = mainTables()["zh-CN"]!;
		const keys = new Set<string>();
		const root = join(import.meta.dirname, "..", "..", "apps", "cli", "src");
		const RE = /\bt\(\s*["']([a-zA-Z0-9][a-zA-Z0-9_.-]*)["']/g;
		for (const file of walk(root)) {
			const src = readFileSync(file, "utf8");
			for (const m of src.matchAll(RE)) keys.add(m[1]!);
		}
		expect(keys.size).toBeGreaterThan(300); // 基线：现网约 500+ 键在用
		const missing = [...keys].filter((k) => !(k in zh) && !k.startsWith("core."));
		// core.* 住地板目录（packages/i18n floorCatalogs）——主目录不含属预期
		expect(missing, `源码用了但主目录缺键：${missing.join(", ")}`).toEqual([]);
	});
});
