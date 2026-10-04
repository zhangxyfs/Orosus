import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOKS_TEMPLATE, migrateModulesSections, seedHooksTemplate } from "./config-migrate.ts";

/** m4-8 T2：存量迁移——config.toml 里命中白名单的模块节整节剪到 modules.d/<名>.toml，
 *  搬前 .bak 备份；幂等；开关在外层（接线测试见下）；留守节与注释不动；source 节整体留守。 */

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const setup = (configRaw: string): { configPath: string; modulesDir: string } => {
  dir = mkdtempSync(join(tmpdir(), "m48-mig-"));
  const configPath = join(dir, "config.toml");
  const modulesDir = join(dir, "modules.d");
  writeFileSync(configPath, configRaw, "utf8");
  return { configPath, modulesDir };
};

const BASE = '# 顶层注释\nprovider = "p/m"\n\n# skill 的说明\n[skill]\ndisabled = ["a"]\n\n[tui]\nsidebar = true\n\n[tool-fs]\nenabled = false\n\n[unknown-thing]\nfoo = 1\n';

describe("存量迁移（m4-8 T2）", () => {
  it("① 白名单节整节搬走 + .bak 备份 + 留守节/注释/未知节不动 + 建目录", () => {
    const { configPath, modulesDir } = setup(BASE);
    const r = migrateModulesSections(configPath, modulesDir, ["skill", "tool-fs", "with-source"]);
    expect(r.moved.sort()).toEqual(["skill", "tool-fs"]);
    expect(r.backup).toBe(`${configPath}.bak`);
    // .bak = 原文全量
    expect(readFileSync(r.backup!, "utf8")).toBe(BASE);
    // 新家内容 = 带节头整节
    expect(readFileSync(join(modulesDir, "skill.toml"), "utf8")).toBe('[skill]\ndisabled = ["a"]\n');
    expect(readFileSync(join(modulesDir, "tool-fs.toml"), "utf8")).toBe("[tool-fs]\nenabled = false\n");
    // 原文件：留守节/顶层/未知节/顶层注释全在，搬走的节与「skill 的说明」注释消失
    const after = readFileSync(configPath, "utf8");
    expect(after).toContain('provider = "p/m"');
    expect(after).toContain("# 顶层注释");
    expect(after).toContain("[tui]");
    expect(after).toContain("[unknown-thing]");
    expect(after).not.toContain("[skill]");
    expect(after).not.toContain("[tool-fs]");
  });

  it("② 幂等：二次运行无节可搬、返回空 moved、不再写 .bak", () => {
    const { configPath, modulesDir } = setup(BASE);
    migrateModulesSections(configPath, modulesDir, ["skill", "tool-fs"]);
    const before = readFileSync(configPath, "utf8");
    const r2 = migrateModulesSections(configPath, modulesDir, ["skill", "tool-fs"]);
    expect(r2.moved).toEqual([]);
    expect(r2.backup).toBeUndefined();
    expect(readFileSync(configPath, "utf8")).toBe(before); // 文件未被动
  });

  it("③ source 节整体留守：含 source 键的模块节不搬（D4——「宿主怎么找模块」归 config.toml）", () => {
    const raw = '[note]\nsource = "../note"\nfoo = 1\n\n[skill]\ndisabled = []\n';
    const { configPath, modulesDir } = setup(raw);
    const r = migrateModulesSections(configPath, modulesDir, ["note", "skill"]);
    expect(r.moved).toEqual(["skill"]);
    const after = readFileSync(configPath, "utf8");
    expect(after).toContain('[note]');
    expect(after).toContain('source = "../note"');
    expect(existsSync(join(modulesDir, "note.toml"))).toBe(false);
  });

  it("③-b 留守排除（真机踩中补钉 2026-09-29）：approval/compaction/provider-custom 是内置模块但留守——白名单含其名也不搬；provider 子节（provider-custom.providers.x）同留守", () => {
    const raw = '[approval]\nmode = "never"\n\n[compaction]\nenabled = true\n\n[skill]\ndisabled = []\n\n[provider-custom]\nenabled = true\n\n[provider-custom.providers.deepseek]\nbaseUrl = "x"\n';
    const { configPath, modulesDir } = setup(raw);
    const r = migrateModulesSections(configPath, modulesDir, ["approval", "compaction", "provider-custom", "skill"]);
    expect(r.moved).toEqual(["skill"]);
    const after = readFileSync(configPath, "utf8");
    expect(after).toContain("[approval]");
    expect(after).toContain("[compaction]");
    expect(after).toContain("[provider-custom]");
    expect(after).toContain("[provider-custom.providers.deepseek]");
    expect(existsSync(join(modulesDir, "approval.toml"))).toBe(false);
    expect(existsSync(join(modulesDir, "provider-custom.toml"))).toBe(false);
  });

  it("③-c 子节随父节同搬（真机踩中补钉）：[tool-web.search] 按第一段 tool-web 判归属——与父节同进 tool-web.toml，不留孤儿", () => {
    const raw = '[tool-web]\nenabled = true\n\n[tool-web.search]\nbackend = "auto"\n';
    const { configPath, modulesDir } = setup(raw);
    const r = migrateModulesSections(configPath, modulesDir, ["tool-web"]);
    expect(r.moved.sort()).toEqual(["tool-web", "tool-web.search"]);
    const home = readFileSync(join(modulesDir, "tool-web.toml"), "utf8");
    expect(home).toContain("[tool-web]");
    expect(home).toContain("[tool-web.search]");
    expect(home).toContain("backend");
    expect(readFileSync(configPath, "utf8")).not.toContain("tool-web");
  });

  it("④ 配置文件不存在 = 空手归（新装机器）;无模块节也空手", () => {
    const d = mkdtempSync(join(tmpdir(), "m48-mig2-"));
    dir = d;
    const r1 = migrateModulesSections(join(d, "nope.toml"), join(d, "modules.d"), ["skill"]);
    expect(r1.moved).toEqual([]);
    expect(r1.backup).toBeUndefined();
    writeFileSync(join(d, "config.toml"), 'provider = "p/m"\n[tui]\nsidebar = true\n', "utf8");
    const r2 = migrateModulesSections(join(d, "config.toml"), join(d, "modules.d"), ["skill"]);
    expect(r2.moved).toEqual([]);
  });
});

describe("m5-hooks T4：hooks 注册 builtins + D21 出厂注释模板", () => {
  it("⑤ hooks 模块注册进 BUILTIN_MODULES（required 出厂件，同 approval/compaction）+ config 写面路由 modules.d/hooks.toml", async () => {
    const { BUILTIN_MODULES } = await import("./builtins.ts");
    expect(BUILTIN_MODULES.some((m) => m.name === "hooks")).toBe(true);
    const { writeSectionKey, sectionPath } = await import("@orosus/core");
    const d = mkdtempSync(join(tmpdir(), "m48-hooks-route-"));
    dir = d;
    const isModule = (n: string): boolean => BUILTIN_MODULES.some((m) => m.name === n); // config-face 同款判定
    const file = sectionPath("hooks", { isModule, userConfig: join(d, "config.toml"), modulesDir: join(d, "modules.d") });
    expect(file).toBe(join(d, "modules.d", "hooks.toml"));
    writeSectionKey(file, "hooks", "enabled", false);
    const { parse } = await import("smol-toml");
    expect(((parse(readFileSync(file, "utf8")) as Record<string, unknown>)["hooks"] as Record<string, unknown>)["enabled"]).toBe(false);
  });

  it("⑥ seedHooksTemplate：modules.d 在且 hooks.toml 缺席 → 播全注释示例（含 [hooks] 头 + 三场景注释样例）；幂等（已存在不动）；modules.d 不存在不建", () => {
    const d = mkdtempSync(join(tmpdir(), "m48-hooks-seed-"));
    dir = d;
    const modulesDir = join(d, "modules.d");
    // modules.d 不存在 → 不建不播
    expect(seedHooksTemplate(modulesDir)).toBe(false);
    expect(existsSync(modulesDir)).toBe(false);
    // 建目录后播种
    mkdirSync(modulesDir, { recursive: true });
    expect(seedHooksTemplate(modulesDir)).toBe(true);
    const raw = readFileSync(join(modulesDir, "hooks.toml"), "utf8");
    expect(raw).toContain("[hooks]");
    expect(raw).toContain("enabled = true");
    expect(raw).toContain("#[[hooks.Stop]]"); // 注释形态（每行 # 前缀）+ [hooks] 节头包裹（modules.d 装载纪律：顶层键漏进 core）
    expect(raw).toContain("#[[hooks.PreToolUse]]");
    expect(raw).toContain("#[[hooks.PostToolUse]]");
    // 幂等：再播不动
    writeFileSync(join(modulesDir, "hooks.toml"), "[hooks]\nenabled = false\n", "utf8");
    expect(seedHooksTemplate(modulesDir)).toBe(false);
    expect(readFileSync(join(modulesDir, "hooks.toml"), "utf8")).toContain("enabled = false");
  });

  it("⑦ 模板是合法 TOML 且解析后零事件表（全注释示例——播种后不产生任何生效钩子）", async () => {
    const { parse } = await import("smol-toml");
    const doc = parse(HOOKS_TEMPLATE) as Record<string, unknown>;
    const parsed = doc["hooks"] as Record<string, unknown>; // 节体在 [hooks] 下
    expect(parsed).toMatchObject({ enabled: true, timeoutMs: 60000 });
    for (const e of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "PermissionRequest"]) {
      expect(parsed[e]).toBeUndefined();
    }
  });
});
