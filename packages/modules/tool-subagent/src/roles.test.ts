import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRoleDirs, loadRoles, parseRoleFile } from "./roles.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const FULL_FILE = `---
name: review
description: 代码审查员，只读代码找问题
tools:
  - tool-fs__read
  - tool-fs__glob
  - tool-fs__grep
disallowedTools:
  - tool-shell__bash
model: custom/m2
maxTurns: 20
writePaths:
  - docs/
---

你是代码审查员。仔细阅读指定代码，找出问题，按严重程度排序输出。不要修改任何文件。
`;

describe("工种文件加载 T3（决策 8/9：frontmatter 七键 + 四级目录优先级）", () => {
  it("① 完整七键文件：全字段解析（列表/引号/多行正文），source 记来源", () => {
    const r = parseRoleFile(FULL_FILE, "/x/review.md");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.name).toBe("review");
    expect(r.description).toBe("代码审查员，只读代码找问题");
    expect(r.tools).toEqual(["tool-fs__read", "tool-fs__glob", "tool-fs__grep"]);
    expect(r.disallowedTools).toEqual(["tool-shell__bash"]);
    expect(r.model).toBe("custom/m2");
    expect(r.maxTurns).toBe(20);
    expect(r.writePaths).toEqual(["docs/"]);
    expect(r.prompt).toContain("你是代码审查员");
    expect(r.prompt).not.toContain("---");
    expect(r.source).toBe("/x/review.md");
  });

  it("② 必填校验：缺 name / 缺 description / 无 frontmatter / 正文为空 → 错误对象带文件名", () => {
    expect("error" in parseRoleFile("---\ndescription: d\n---\n正文", "/x/a.md")).toBe(true);
    expect("error" in parseRoleFile("---\nname: a\n---\n正文", "/x/b.md")).toBe(true);
    expect("error" in parseRoleFile("没有头", "/x/c.md")).toBe(true);
    expect("error" in parseRoleFile("---\nname: a\ndescription: d\n---\n", "/x/d.md")).toBe(true);
    const e = parseRoleFile("---\nname: A1\ndescription: d\n---\n正文", "/x/e.md") as { error: string };
    expect(e.error).toContain("/x/e.md"); // 错误信息带文件定位
    expect(e.error).toContain("kebab");
  });

  it("③ 值域校验：maxTurns 非正整数报错；空列表键报错；frontmatter 行不认识报错（fail-closed 不静默丢字段）", () => {
    expect("error" in parseRoleFile("---\nname: a\ndescription: d\nmaxTurns: abc\n---\n正文", "/x/a.md")).toBe(true);
    expect("error" in parseRoleFile("---\nname: a\ndescription: d\nmaxTurns: 0\n---\n正文", "/x/b.md")).toBe(true);
		const unlimited = parseRoleFile("---\nname: a\ndescription: d\nmaxTurns: -1\n---\n正文", "/x/d1.md");
		expect("error" in unlimited).toBe(false); // -1 = 不限（双保险丝批 2026-09-27）
		if (!("error" in unlimited)) expect(unlimited.maxTurns).toBe(-1);
    expect("error" in parseRoleFile("---\nname: a\ndescription: d\ntools:\n---\n正文", "/x/c.md")).toBe(true);
    expect("error" in parseRoleFile("---\nname: a\ndescription: d\n嵌套: [a, b]\n---\n正文", "/x/d.md")).toBe(true);
    expect("error" in parseRoleFile("---\n- 孤儿列表项\n---\n正文", "/x/e.md")).toBe(true);
  });

  it("③b 重复键 fail-closed（MV-08）：标量重复 / 列表后又标量 / 标量后空值重申 / 列表后空值重申 均报错不静默覆盖", () => {
    // 形态①：同标量键出现两次（原：后值静默覆前值）
    const dupScalar = parseRoleFile("---\nname: a\ndescription: 第一\ndescription: 第二\n---\n正文", "/x/f1.md") as { error: string };
    expect(dupScalar.error).toContain("重复定义");
    expect(dupScalar.error).toContain("description");
    // 形态②：先列表再给同名标量（原：已积累列表被整体丢弃）
    const listThenScalar = parseRoleFile("---\nname: a\ndescription: d\ntools:\n  - tool-fs__read\ntools: tool-shell__bash\n---\n正文", "/x/f2.md") as { error: string };
    expect(listThenScalar.error).toContain("重复定义");
    // 形态③：先标量后空值重申为列表（原：标量被静默丢弃、列表重新起算）
    const scalarThenList = parseRoleFile("---\nname: a\ndescription: d\ntools: x\ntools:\n  - tool-fs__read\n---\n正文", "/x/f3.md") as { error: string };
    expect(scalarThenList.error).toContain("重复定义");
    // 形态④：先列表后空值重申（原：旧列表被整体重置）
    const listThenList = parseRoleFile("---\nname: a\ndescription: d\ntools:\n  - tool-fs__read\ntools:\n  - tool-fs__glob\n---\n正文", "/x/f4.md") as { error: string };
    expect(listThenList.error).toContain("重复定义");
    expect(listThenList.error).toContain("/x/f4.md"); // 错误信息带文件定位
    // 反向钉：不重复的正常文件不受影响（FULL_FILE 已由 ① 覆盖，此处再钉多列表键并存的合法形态）
    const ok = parseRoleFile("---\nname: a\ndescription: d\ntools:\n  - tool-fs__read\nwritePaths:\n  - docs/\n---\n正文", "/x/f5.md");
    expect("error" in ok).toBe(false);
  });

  it("④ 引号与 BOM：值带引号剥壳；UTF-8 BOM 头剥掉不炸", () => {
    const r = parseRoleFile('---\nname: a\ndescription: "说明"\ntools:\n  - \'tool-fs__read\'\n---\n正文', "/x/a.md");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.description).toBe("说明");
    expect(r.tools).toEqual(["tool-fs__read"]);
    const bom = parseRoleFile("\uFEFF---\nname: a\ndescription: d\n---\n正文", "/x/b.md");
    expect("error" in bom).toBe(false);
  });

  it("⑤ 四级优先级同名覆盖：项目品牌 > 项目通用 > 用户品牌 > 用户通用（同名取最高优先级那份）", () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-roles-"));
    dir = d;
    const mk = (sub: string, name: string, marker: string): void => {
      mkdirSync(join(d, sub), { recursive: true });
      writeFileSync(join(d, sub, `${name}.md`), `---\nname: ${name}\ndescription: ${marker}\n---\n${marker} 正文`, "utf8");
    };
    mk("user-generic", "same", "用户通用版");
    mk("user-brand", "same", "用户品牌版");
    mk("proj-generic", "same", "项目通用版");
    mk("proj-brand", "same", "项目品牌版");
    const { roles, warnings } = loadRoles({
      projectBrand: join(d, "proj-brand"),
      projectGeneric: join(d, "proj-generic"),
      userBrand: join(d, "user-brand"),
      userGeneric: join(d, "user-generic"),
    });
    expect(warnings).toEqual([]);
    expect(roles.size).toBe(1);
    expect(roles.get("same")!.description).toBe("项目品牌版");
  });

  it("⑥ 不同名共存：四个目录多个工种全进表", () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-roles-"));
    dir = d;
    const dirs = ["proj-brand", "proj-generic", "user-brand", "user-generic"];
    dirs.forEach((sub, i) => {
      mkdirSync(join(d, sub), { recursive: true });
      writeFileSync(join(d, sub, `role-${i}.md`), `---\nname: role-${i}\ndescription: d${i}\n---\n正文 ${i}`, "utf8");
    });
    const { roles } = loadRoles({
      projectBrand: join(d, "proj-brand"),
      projectGeneric: join(d, "proj-generic"),
      userBrand: join(d, "user-brand"),
      userGeneric: join(d, "user-generic"),
    });
    expect([...roles.keys()].sort()).toEqual(["role-0", "role-1", "role-2", "role-3"]);
  });

  it("⑦ 坏文件不炸整目录：跳过 + warning 收集；同目录撞名先者胜并告警", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-roles-"));
    mkdirSync(join(dir, "one"), { recursive: true });
    writeFileSync(join(dir, "one", "good.md"), "---\nname: good\ndescription: 好\n---\n正文", "utf8");
    writeFileSync(join(dir, "one", "bad.md"), "---\nname: bad\n---\n正文", "utf8"); // 缺 description
    writeFileSync(join(dir, "one", "dup-a.md"), "---\nname: dup\ndescription: 第一份\n---\n正文", "utf8");
    writeFileSync(join(dir, "one", "dup-b.md"), "---\nname: dup\ndescription: 第二份\n---\n正文", "utf8");
    const { roles, warnings } = loadRoles({
      projectBrand: join(dir, "one"),
      projectGeneric: join(dir, "none"),
      userBrand: join(dir, "none"),
      userGeneric: join(dir, "none"),
    });
    expect(roles.size).toBe(2); // good + dup（第一份）
    expect(roles.get("dup")!.description).toBe("第一份");
    expect(warnings.length).toBe(2); // bad.md 错误 + 同目录撞名
    expect(warnings[0]).toContain("bad.md");
    expect(warnings[1]).toContain("dup-b.md");
  });

  it("⑧ 空态与缺省目录形状：全不存在 = 空表零警告；defaultRoleDirs 四路径落位", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-roles-"));
    const empty = loadRoles({
      projectBrand: join(dir, "a"), projectGeneric: join(dir, "b"),
      userBrand: join(dir, "c"), userGeneric: join(dir, "d"),
    });
    expect(empty.roles.size).toBe(0);
    expect(empty.warnings).toEqual([]);
    const dirs = defaultRoleDirs(join(dir, "proj"), join(dir, "home"));
    expect(dirs.projectBrand).toBe(join(dir, "proj", ".orosus", "agents"));
    expect(dirs.projectGeneric).toBe(join(dir, "proj", ".agents", "agents"));
    expect(dirs.userBrand).toBe(join(dir, "home", ".orosus", "agents"));
    expect(dirs.userGeneric).toBe(join(dir, "home", ".agents", "agents"));
  });
});
