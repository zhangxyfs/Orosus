import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSectionKey, sectionPath } from "./write.ts";

/** m4-8 T3：统一写口——行级节区感知写（三份复制逻辑并一份）+ sectionPath 路由。
 *  null = 删键；字符串/字符串数组带引号、数值/布尔裸；保注释/键序/EOL（CM-01 纪律：行级写不 parse
 *  整文件，坏 TOML 的其他行不动）。 */

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const cfg = (raw: string): string => {
  dir = mkdtempSync(join(tmpdir(), "m48-w-"));
  const p = join(dir, "config.toml");
  writeFileSync(p, raw, "utf8");
  return p;
};

const BASE = "# 顶层注释\nprovider = \"p/m\"\n\n[tui] # 界面\nsidebar = true\nmode = \"full\"\n\n[skill]\n# 名单\ndisabled = [\"a\"]\n";

describe("writeSectionKey（m4-8 T3 统一写口）", () => {
  it("① 四态·改值：布尔裸 / 字符串带引号 / 数组整替——保注释保键序保 EOL（CRLF）", () => {
    const p = cfg(BASE.replace(/\n/g, "\r\n"));
    writeSectionKey(p, "tui", "sidebar", false);
    writeSectionKey(p, "tui", "mode", "line");
    writeSectionKey(p, "skill", "disabled", ["a", "b"]);
    const after = readFileSync(p, "utf8");
    expect(after).toContain("sidebar = false");
    expect(after).toContain('mode = "line"');
    expect(after).toContain('disabled = ["a", "b"]');
    expect(after).toContain("# 顶层注释");
    expect(after).toContain("[tui] # 界面");
    expect(after).toContain("# 名单");
    expect(after.indexOf("[tui]")).toBeLessThan(after.indexOf("[skill]")); // 键序/节序不动
    expect(after).toContain("\r\n");
  });

  it("①-b CM-11 注入防线：字符串值带引号/反斜杠/换行 → 转义写出单行，不产生额外 TOML 行", () => {
    const p = cfg(BASE);
    writeSectionKey(p, "tui", "mode", 'a"b\\c\nd');
    expect(readFileSync(p, "utf8")).toContain('mode = "a\\"b\\\\c\\nd"');
    expect(readFileSync(p, "utf8").split("\n").filter((l) => l.startsWith("mode")).length).toBe(1); // 单行
  });

  it("② 删键：null 删行——节内中段删、节尾唯一键删、键不在场 = 无操作", () => {
    const p = cfg(BASE);
    writeSectionKey(p, "tui", "mode", null); // 节内中段（sidebar 在后）
    let after = readFileSync(p, "utf8");
    expect(after).not.toContain("mode =");
    expect(after).toContain("sidebar = true");
    writeSectionKey(p, "skill", "disabled", null); // 节尾键删（含其上专属注释行不动）
    after = readFileSync(p, "utf8");
    expect(after).toContain("# 名单");
    expect(after).not.toContain('disabled = ["a"]');
    const before = after;
    writeSectionKey(p, "tui", "ghost", null); // 键不在——无操作
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("③ 建节：目标节不存在——文件尾新建（空行隔开；文件不存在/空文件从 [节] 起）", () => {
    const p = cfg(BASE);
    writeSectionKey(p, "mcp", "enabled", true);
    const after = readFileSync(p, "utf8");
    expect(after.endsWith("\n[mcp]\nenabled = true\n")).toBe(true);
    expect(after.indexOf("[skill]")).toBeLessThan(after.indexOf("[mcp]"));
    const empty = join(dir, "empty.toml");
    writeFileSync(empty, "", "utf8");
    writeSectionKey(empty, "skill", "disabled", []);
    expect(readFileSync(empty, "utf8")).toBe("[skill]\ndisabled = []\n");
  });

  it("④ 建键：节存在键不在——插在节尾（下一节头前）", () => {
    const p = cfg(BASE);
    writeSectionKey(p, "tui", "latex", true);
    const after = readFileSync(p, "utf8");
    const tuiAt = after.indexOf("[tui]");
    const latexAt = after.indexOf("latex = true");
    const skillAt = after.indexOf("[skill]");
    expect(latexAt).toBeGreaterThan(tuiAt);
    expect(latexAt).toBeLessThan(skillAt);
  });
});

describe("sectionPath（m4-8 T3 路由）", () => {
  it("⑤ 模块节 → modules.d/<名>.toml（目录/文件不存在则建，文件带节头）；留守节 → 原 config 路径", () => {
    dir = mkdtempSync(join(tmpdir(), "m48-p-"));
    const userConfig = join(dir, "config.toml");
    const modulesDir = join(dir, "modules.d");
    const isModule = (n: string) => n === "skill" || n === "tool-fs";
    const p1 = sectionPath("skill", { userConfig, modulesDir, isModule });
    expect(p1).toBe(join(modulesDir, "skill.toml"));
    expect(existsSync(modulesDir)).toBe(true);
    expect(readFileSync(p1, "utf8")).toBe("[skill]\n"); // 建文件带节头
    const p2 = sectionPath("tui", { userConfig, modulesDir, isModule });
    expect(p2).toBe(userConfig); // 留守节回原文件（不建）
    expect(existsSync(userConfig)).toBe(false);
  });
});
