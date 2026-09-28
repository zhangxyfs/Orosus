import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { readSkillDisabled, toggleSkillDisabled, skillScopeLabel, skillListRow, skillDetailText, truncateAtWord, type SkillCatalogRow } from "./skill-settings.ts";
import { stripAnsi, visibleWidth } from "./tui/width.ts";

/** m4-7 T8/T9：技能停用配置读写（[skill] disabled 数组键）+ 列表行/详情文本纯函数（原型图 2/3）。 */

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const cfgFile = (): string => join(dir, "config.toml");

describe("技能停用配置（m4-7 T8——[skill] 节 disabled 数组键，行级节区感知写）", () => {
	it("① 读：缺文件 = 空表；正常读数组；缺节/缺键 = 空表", () => {
		dir = mkdtempSync(join(tmpdir(), "skill-cfg-"));
		expect(readSkillDisabled(cfgFile())).toEqual([]);
		writeFileSync(cfgFile(), '[skill]\ndisabled = ["pdf", "ok-wiki"]\n', "utf8");
		expect(readSkillDisabled(cfgFile())).toEqual(["pdf", "ok-wiki"]);
		writeFileSync(cfgFile(), '[tool-subagent]\ndisabled = ["x"]\n', "utf8"); // 别的节不算
		expect(readSkillDisabled(cfgFile())).toEqual([]);
	});

	it("② 翻转：增名写键（建节）、再翻整替、清空删键回缺省态", () => {
		dir = mkdtempSync(join(tmpdir(), "skill-cfg-"));
		expect(toggleSkillDisabled("pdf", cfgFile())).toBe(true);
		expect(readFileSync(cfgFile(), "utf8")).toContain('[skill]');
		expect(readFileSync(cfgFile(), "utf8")).toContain('disabled = ["pdf"]');
		expect(toggleSkillDisabled("ok-wiki", cfgFile())).toBe(true);
		expect(readFileSync(cfgFile(), "utf8")).toContain('disabled = ["pdf", "ok-wiki"]'); // 整替追加
		expect(toggleSkillDisabled("pdf", cfgFile())).toBe(false);
		expect(readFileSync(cfgFile(), "utf8")).toContain('disabled = ["ok-wiki"]');
		expect(toggleSkillDisabled("ok-wiki", cfgFile())).toBe(false);
		expect(readFileSync(cfgFile(), "utf8")).not.toContain("disabled"); // 空表删键
	});

	it("③ 翻转不动 [skill] 节其他键与注释（不洗配置的铁律）", () => {
		dir = mkdtempSync(join(tmpdir(), "skill-cfg-"));
		writeFileSync(cfgFile(), '# 注释\n[skill]\nuserDir = "D:/my-skills"\n', "utf8");
		toggleSkillDisabled("pdf", cfgFile());
		const raw = readFileSync(cfgFile(), "utf8");
		expect(raw).toContain("# 注释");
		expect(raw).toContain('userDir = "D:/my-skills"');
		expect(raw).toContain('disabled = ["pdf"]');
	});

	it("⑧ CM-11：技能名含引号/换行（目录名可合法含）→ disabled 数组转义写入、读回还原、smol-toml 可解析（无新行注入）", () => {
		dir = mkdtempSync(join(tmpdir(), "skill-cm11-"));
		const evil = 'a"b\nc';
		expect(toggleSkillDisabled(evil, cfgFile())).toBe(true);
		const raw = readFileSync(cfgFile(), "utf8");
		expect(raw).toContain('disabled = ["a\\"b\\nc"]'); // 引号/换行转成字面量转义序列——单行、无裸换行（旧实现可注入新节）
		expect(readSkillDisabled(cfgFile())).toEqual([evil]); // 读侧还原成对
		expect(() => parse(raw)).not.toThrow(); // 落盘产物是真 TOML
		expect((parse(raw) as { skill?: { disabled?: string[] } }).skill?.disabled).toEqual([evil]);
		// 再翻一个正常名：数组整替不丢已转义项
		expect(toggleSkillDisabled("pdf", cfgFile())).toBe(true);
		expect(readSkillDisabled(cfgFile())).toEqual([evil, "pdf"]);
	});
});

describe("技能列表行与详情文本（m4-7 T8/T9——原型图 2/3）", () => {
	const row = (over: Partial<SkillCatalogRow> = {}): SkillCatalogRow => ({
		name: "pdf",
		description: "生成 PDF 文件",
		layer: "user",
		source: "agents",
		file: "C:\\Users\\me\\.agents\\skills\\pdf\\SKILL.md",
		disabled: false,
		modelInvocable: true,
		...over,
	});

	it("④ 范围三值映射文案照写（禁缩写）：个人（用户级）/ 所有人（项目级）/ 内置（出厂自带）", () => {
		expect(skillScopeLabel("user")).toBe("个人（用户级）");
		expect(skillScopeLabel("project")).toBe("所有人（项目级）");
		expect(skillScopeLabel("bundled")).toBe("内置（出厂自带）");
	});

	it("⑤ 列表行三列：名左/描述中/状态右；「停用」灰色；长描述截断；行宽恰为内宽", () => {
		const w = 60;
		const on = skillListRow(w, row());
		const plain = stripAnsi(on);
		expect(plain.indexOf("pdf")).toBeGreaterThanOrEqual(0);
		expect(plain).toContain("生成 PDF 文件");
		expect(plain.endsWith("启用")).toBe(true); // 状态右贴行尾
		expect(visibleWidth(on)).toBe(w - 1); // pick 渲染行首还有 ❯ 前缀列（调用方拼「 ❯ 」）
		const off = skillListRow(w, row({ disabled: true }));
		expect(stripAnsi(off).endsWith("停用")).toBe(true);
		expect(off).not.toBe(stripAnsi(off)); // 停用灰 = 行含 ANSI
		const long = skillListRow(w, row({ description: "很长的描述".repeat(20) }));
		expect(stripAnsi(long)).not.toContain("很长的描述".repeat(20)); // 截断
		expect(visibleWidth(long)).toBeLessThanOrEqual(w - 1);
	});

	it("⑥ 详情五字段竖排：名称/描述/范围/状态/文件；超宽不折行——词原子截断末尾加 …（2026-09-27 用户拍板）", () => {
		const text = skillDetailText(74, row());
		const plain = stripAnsi(text);
		expect(plain).toContain("名称    pdf");
		expect(plain).toContain("描述    生成 PDF 文件");
		expect(plain).toContain("范围    个人（用户级）");
		expect(plain).toContain("状态    启用");
		expect(plain).toContain("文件    C:\\Users\\me\\.agents\\skills\\pdf\\SKILL.md");
		const longText = skillDetailText(74, row({ description: "超长描述内容。".repeat(30) }));
		const ls = stripAnsi(longText).split("\n");
		expect(ls).toHaveLength(5); // 不折行——恒五字段五行
		const descLine = ls[1]!;
		expect(descLine).toMatch(/…$/); // 末尾省略号
		for (const l of longText.split("\n")) expect(visibleWidth(l)).toBeLessThanOrEqual(74); // 不溢出
	});

	it("⑦ 词原子截断：ASCII 词不劈半 + CJK 整字 + 省略号占位（m4-7 走查修断词问题）", () => {
		expect(truncateAtWord("deployment batching 详解", 14)).toBe("deployment…");
		expect(truncateAtWord("超长的中文描述内容在这里", 10)).toBe("超长的中…"); // 预算 9 列 = 4 个 CJK + …
		expect(truncateAtWord("short", 10)).toBe("short"); // 不超宽原样
	});
});
