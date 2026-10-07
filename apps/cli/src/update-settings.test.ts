/** m5-update-check T6：「更新检查」开关读写 + 设置流（HERMETIC——tmp config，行级写不洗注释钉）。 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpdateCheckEnabled, runUpdateCheckSetting, writeUpdateCheckKey } from "./update-settings.ts";
import { bindTestLocale } from "./i18n/app.ts";

let dir: string | undefined;
afterEach(() => {
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

const tmpFile = (content = ""): string => {
	dir = mkdtempSync(join(tmpdir(), "orosus-updset-"));
	const f = join(dir, "config.toml");
	if (content !== "") writeFileSync(f, content, "utf8");
	return f;
};

describe("[update] check 键读写", () => {
	it("缺文件/缺节/坏值 = 缺省开", () => {
		expect(readUpdateCheckEnabled(tmpFile())).toBe(true);
		expect(readUpdateCheckEnabled(tmpFile('[tui]\nmode = "full"\n'))).toBe(true);
		expect(readUpdateCheckEnabled(tmpFile('[update]\ncheck = "yes"\n'))).toBe(true); // 坏值（字符串）不认
	});

	it("写 false → 读 false → 写 true 回开；行级写不洗既有注释与节", () => {
		const f = tmpFile("# 用户注释\n[provider-custom]\nkey = \"v\"\n");
		writeUpdateCheckKey(false, f);
		expect(readUpdateCheckEnabled(f)).toBe(false);
		const raw = readFileSync(f, "utf8");
		expect(raw).toContain("# 用户注释"); // 行级节区感知写铁律
		expect(raw).toContain("[provider-custom]");
		expect(raw).toContain("check = false");
		writeUpdateCheckKey(true, f);
		expect(readUpdateCheckEnabled(f)).toBe(true);
		expect(readFileSync(f, "utf8")).toContain("check = true");
	});
});

describe("runUpdateCheckSetting（设置流——两档 ✓ + 回执）", () => {
	it("选关 → 写盘 + 关回执", async () => {
		bindTestLocale("zh-CN");
		const f = tmpFile();
		const res = await runUpdateCheckSetting(async (_title, items) => items[1]!, f);
		expect(res).toContain("已关闭");
		expect(readUpdateCheckEnabled(f)).toBe(false);
	});

	it("选开 → 写盘 + 开回执", async () => {
		bindTestLocale("zh-CN");
		const f = tmpFile("[update]\ncheck = false\n");
		const res = await runUpdateCheckSetting(async (_title, items) => items[0]!, f);
		expect(res).toContain("已开启");
		expect(readUpdateCheckEnabled(f)).toBe(true);
	});

	it("未匹配（Esc 空串路径）= 静默不写", async () => {
		bindTestLocale("zh-CN");
		const f = tmpFile();
		const res = await runUpdateCheckSetting(async () => "zzz", f);
		expect(res).toBe("");
		expect(readUpdateCheckEnabled(f)).toBe(true); // 缺省未动
	});
});
