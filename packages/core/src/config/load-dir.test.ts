import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./load.ts";

/** m4-8 T1：loadConfig 挂 modules.d 目录层——每层「config.toml 先、目录 *.toml 按文件名序后读」，
 *  合并走现行 merge（含 CH-07 深合并兜底）；坏文件跳过出 warning 不炸；目录不存在零影响。 */

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const setup = (): { userFile: string; userModulesDir: string } => {
  dir = mkdtempSync(join(tmpdir(), "m48-dir-"));
  const userFile = join(dir, "config.toml");
  const userModulesDir = join(dir, "modules.d");
  return { userFile, userModulesDir };
};

describe("modules.d 目录层（m4-8 T1）", () => {
  it("① 目录文件生效：config.toml 与 modules.d/<名>.toml 的节都进 sections，键都可见", () => {
    const { userFile, userModulesDir } = setup();
    writeFileSync(userFile, 'contextWindow = 500000\n[skill]\ndisabled = ["a"]\n', "utf8");
    mkdirSync(userModulesDir);
    writeFileSync(join(userModulesDir, "tool-web.toml"), "[tool-web]\nenabled = false\n", "utf8");
    const cfg = loadConfig({ userFile, userModulesDir, env: {} });
    expect(cfg.core.contextWindow).toBe(500000);
    expect(cfg.sections.get("skill")).toEqual({ disabled: ["a"] });
    expect(cfg.sections.get("tool-web")).toEqual({ enabled: false });
  });

  it("② 文件名序 = 优先级：后读覆盖先读（b.toml 压 a.toml 的同名键；目录压 config.toml）", () => {
    const { userFile, userModulesDir } = setup();
    writeFileSync(userFile, "[skill]\ndisabled = [\"old\"]\n", "utf8");
    mkdirSync(userModulesDir);
    writeFileSync(join(userModulesDir, "a-skill.toml"), "[skill]\ndisabled = [\"from-a\"]\n", "utf8");
    writeFileSync(join(userModulesDir, "b-skill.toml"), "[skill]\ndisabled = [\"from-b\"]\n", "utf8");
    const cfg = loadConfig({ userFile, userModulesDir, env: {} });
    expect(cfg.sections.get("skill")).toEqual({ disabled: ["from-b"] }); // ASCII 序 b 后读覆盖 a 与单文件
  });

  it("③ 坏文件跳过不炸：坏 toml 出 warning、其余文件与单文件层照常；不触发 broken 级失败", () => {
    const { userFile, userModulesDir } = setup();
    writeFileSync(userFile, "[skill]\ndisabled = []\n", "utf8");
    mkdirSync(userModulesDir);
    writeFileSync(join(userModulesDir, "00-broken.toml"), "[skill 这是坏 TOML\n", "utf8");
    writeFileSync(join(userModulesDir, "mcp.toml"), "[mcp]\nenabled = true\n", "utf8");
    const cfg = loadConfig({ userFile, userModulesDir, env: {} });
    expect(cfg.sections.get("skill")).toEqual({ disabled: [] }); // 单文件层不受坏文件影响
    expect(cfg.sections.get("mcp")).toEqual({ enabled: true }); // 好文件照常生效
    expect(cfg.warnings.some((w) => w.includes("00-broken.toml") && w.includes("解析失败"))).toBe(true);
  });

  it("④ 目录不存在零影响（新装机器常态）；非 .toml 后缀文件忽略", () => {
    const { userFile, userModulesDir } = setup();
    writeFileSync(userFile, "[skill]\ndisabled = []\n", "utf8");
    mkdirSync(userModulesDir);
    writeFileSync(join(userModulesDir, "notes.md"), "not toml\n", "utf8");
    writeFileSync(join(userModulesDir, "readme.txt"), "x\n", "utf8");
    const cfg = loadConfig({ userFile, userModulesDir, env: {} });
    expect(cfg.sections.get("skill")).toEqual({ disabled: [] });
    expect(cfg.warnings).toHaveLength(0);
    const noDir = loadConfig({ userFile, userModulesDir: join(dir, "no-such-dir"), env: {} });
    expect(noDir.sections.get("skill")).toEqual({ disabled: [] });
  });
});
