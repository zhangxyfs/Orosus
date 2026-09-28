import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExternalModule } from "./loader.ts";

/** CK-01 回归钉（2026-09-28 code review P0）：外部模块热重载必须读到磁盘新代码——
 *  旧实现 jiti moduleCache:true 复用进程级 require 缓存，同入口第二次加载拿回同一个旧对象，
 *  /reload 对外部模块静默失效（此前零测试覆盖）。 */

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadExternalModule 热重载取新代码（CK-01）", () => {
	it("① 同一入口改盘后再载：行为跟随磁盘新版本，而非缓存旧对象", async () => {
		dir = mkdtempSync(join(tmpdir(), "ext-mod-"));
		const file = "mod.ts";
		const write = (tag: string) =>
			writeFileSync(
				join(dir, file),
				`const tag = ${JSON.stringify(tag)};\nconst def = { name: "ext-mod", activate: () => tag };\nexport default def;\n`,
				"utf8",
			);
		write("v1");
		const d1 = await loadExternalModule(dir, file);
		expect((d1 as unknown as { activate: () => string }).activate()).toBe("v1");
		write("v2"); // 磁盘改版（热重载场景：用户改完模块代码按 /reload）
		const d2 = await loadExternalModule(dir, file);
		expect((d2 as unknown as { activate: () => string }).activate()).toBe("v2"); // 旧行为：activate 仍是旧 v1
	});
});
