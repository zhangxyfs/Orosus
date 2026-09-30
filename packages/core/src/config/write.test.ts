import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { writeSectionKey, sectionPath, writeNestedTable } from "./write.ts";

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

  it("①-c CM-01 拒写：文件在但整文件 parse 失败 = 读不懂的盘——盘上原样（写入不生效还动坏文件,宁丢这次写;缺文件/空文件不受此限）", () => {
    const p = cfg("this is = = not valid toml ][");
    writeSectionKey(p, "tui", "sidebar", true);
    expect(readFileSync(p, "utf8")).toBe("this is = = not valid toml ][");
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


describe("writeNestedTable（T13 嵌套表写入器——m4-3c）", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const td = () => { const d = mkdtempSync(join(tmpdir(), "orosus-nested-")); dirs.push(d); return join(d, "mcp.toml"); };
  const rd = (p: string) => readFileSync(p, "utf8");

  it("① 新建：空文件/缺表 → 文件尾追加 [mcp.servers.x] 整表（env 内联表、args 数组、引号键名）", () => {
    const p = td();
    writeNestedTable(p, "mcp.servers.gh", { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "t1" }, timeoutMs: 90_000 });
    const t = rd(p);
    expect(t).toContain('[mcp.servers.gh]');
    expect(t).toContain('command = "npx"');
    expect(t).toContain('args = ["-y", "pkg"]');
    expect(t).toContain('env = { TOKEN = "t1" }');
    expect(t).toContain("timeoutMs = 90000");
    expect(parse(t)).toEqual({ mcp: { servers: { gh: { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "t1" }, timeoutMs: 90_000 } } } }); // 落盘是合法 TOML 且结构如预期
    writeNestedTable(p, "mcp.servers.my srv", { command: "x" });
    expect(rd(p)).toContain('[mcp.servers."my srv"]'); // 非裸键段自动引号
  });

  it("② 替换：既有表体与子表整体让位、其余节与注释不动", () => {
    const p = td();
    const PRE = ["# 顶部注释", "[mcp]", "enabled = true", "", "[mcp.servers.old]", "command = \"a\"", "[mcp.servers.old.env]", "K = \"v\"", "", "[skill]", "disabled = []"].join("\n") + "\n";
    writeFileSync(p, PRE, "utf8");
    writeNestedTable(p, "mcp.servers.old", { url: "https://x/mcp", headers: { authorization: "Bearer t" } });
    const t = rd(p);
    expect(t).toContain("# 顶部注释"); // 注释保住
    expect(t).not.toContain('command = "a"');
    expect(t).not.toContain("[mcp.servers.old.env]"); // 子表一并让位
    expect(parse(t)).toEqual({ mcp: { enabled: true, servers: { old: { url: "https://x/mcp", headers: { authorization: "Bearer t" } } } }, skill: { disabled: [] } }); // 邻节无损
  });

  it("③ 删除：整表摘除 + 空行折叠；表不在无操作；坏 TOML 拒写", () => {
    const p = td();
    writeNestedTable(p, "mcp.servers.a", { command: "x" });
    writeNestedTable(p, "mcp.servers.b", { command: "y" });
    writeNestedTable(p, "mcp.servers.a", null);
    const t = rd(p);
    expect(t).not.toContain("[mcp.servers.a]");
    expect(parse(t)).toEqual({ mcp: { servers: { b: { command: "y" } } } });
    expect(t.match(/^$/gm)?.length ?? 0).toBeLessThanOrEqual(2); // 双空行折回
    writeNestedTable(p, "mcp.servers.ghost", null); // 不在——无操作
    expect(rd(p)).toBe(t);
    const bad = td();
    writeFileSync(bad, "不是 = 合法 = TOML", "utf8");
    writeNestedTable(bad, "mcp.servers.x", { command: "x" });
    expect(rd(bad)).toBe("不是 = 合法 = TOML"); // 拒写（CM-01）——原样一字未动
  });

  it("④ 精确匹配：前缀同名表不误伤（gh 与 gh2 互不相干）", () => {
    const p = td();
    writeNestedTable(p, "mcp.servers.gh", { command: "a" });
    writeNestedTable(p, "mcp.servers.gh2", { command: "b" });
    writeNestedTable(p, "mcp.servers.gh", null);
    expect(parse(rd(p))).toEqual({ mcp: { servers: { gh2: { command: "b" } } } });
  });
});
