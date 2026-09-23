import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setModuleEnabledInConfig } from "./module-toggle.ts";

/** 模块热插拔的行级 TOML 写（2026-09-23 用户拍板）——节区感知三形态 + 注释/行尾保全。 */
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("setModuleEnabledInConfig（行级写 TOML——节区感知）", () => {
  it("① 节内已有 enabled → 原位改值，注释与既有键保全", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-modtoggle-"));
    const f = join(dir, "config.toml");
    writeFileSync(f, "# 用户注释\nprovider = \"provider-custom\"\n\n[compaction]\n# 压缩注释\nthresholdTokens = 60000\nenabled = true\n\n[approval]\nmode = \"ask-risky\"\n", "utf8");
    setModuleEnabledInConfig("compaction", false, f);
    const out = readFileSync(f, "utf8");
    expect(out).toContain("# 用户注释");
    expect(out).toContain("# 压缩注释");
    expect(out).toContain("thresholdTokens = 60000");
    expect(out).toContain("enabled = false");
    expect(out).not.toContain("enabled = true");
    expect(out.indexOf("enabled = false")).toBeGreaterThan(out.indexOf("[compaction]"));
    expect(out.indexOf("enabled = false")).toBeLessThan(out.indexOf("[approval]"));
  });

  it("② 节存在无 enabled → 插节尾（下一节头之前）；目标节是末节 → 文件尾", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-modtoggle-"));
    const f = join(dir, "config.toml");
    writeFileSync(f, "[approval]\nmode = \"ask-risky\"\n\n[mcp]\nservers = []\n", "utf8");
    setModuleEnabledInConfig("mcp", false, f); // mcp 是末节 → 文件尾
    let out = readFileSync(f, "utf8");
    expect(out.indexOf("enabled = false")).toBeGreaterThan(out.indexOf("servers = []"));
    setModuleEnabledInConfig("approval", false, f); // approval 是首节 → 插在 [mcp] 前
    out = readFileSync(f, "utf8");
    expect(out.indexOf("enabled = false", out.indexOf("[approval]"))).toBeLessThan(out.indexOf("[mcp]"));
    expect(out).toContain("mode = \"ask-risky\"");
  });

  it("③ 节不存在 → 文件尾新建节（前留空行）；缺文件从空起；CRLF 风格保全", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-modtoggle-"));
    const f = join(dir, "config.toml");
    writeFileSync(f, "[approval]\r\nmode = \"ask-risky\"\r\n", "utf8");
    setModuleEnabledInConfig("tool-todo", true, f);
    const out = readFileSync(f, "utf8");
    expect(out).toContain("\r\n\r\n[tool-todo]\r\nenabled = true");
    const f2 = join(dir, "absent.toml");
    setModuleEnabledInConfig("skill", true, f2);
    expect(readFileSync(f2, "utf8")).toBe("[skill]\nenabled = true");
  });
});
