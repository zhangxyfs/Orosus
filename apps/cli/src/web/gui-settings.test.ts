import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { guiConfigFile, migrateLegacyGuiData, readBtwModel, readGuiPreferences, writeGuiPreferences } from "./gui-settings.ts";
import { guiDataFile } from "./gui-files.ts";
import { readInstance } from "./instance.ts";
import { readPins } from "./pins.ts";
import { readHidden } from "./workspaces.ts";

const homes: string[] = [];
const tmpHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "orosus-gui-settings-"));
  homes.push(home);
  return home;
};

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("GUI 用户偏好（~/.orosus/gui/gui.toml）", () => {
  it("缺文件返回默认值；外观与侧问模型写后可读回，并清除旧 config.toml 顶层 btwModel", () => {
    const home = tmpHome();
    expect(readGuiPreferences(home)).toMatchObject({ exists: false, appearanceConfigured: false, theme: "连山", mode: "dark", fontScale: 1 });
    writeFileSync(join(home, "config.toml"), 'btwModel = "demo/legacy"\n', "utf8");

    writeGuiPreferences(home, { theme: "连山", mode: "light", fontScale: 1.25, btwModel: "demo/new-model" });

    expect(readGuiPreferences(home)).toMatchObject({ exists: true, appearanceConfigured: true, theme: "连山", mode: "light", fontScale: 1.25, btwModel: "demo/new-model" });
    const raw = readFileSync(guiConfigFile(home), "utf8");
    expect(raw).toContain("[appearance]");
    expect(raw).toContain('mode = "light"');
    expect(raw).toContain("fontScale = 1.25");
    expect(raw).toContain("[sideQuestion]");
    expect(raw).toContain('model = "demo/new-model"');
    expect(readFileSync(join(home, "config.toml"), "utf8")).not.toContain("btwModel");

    writeGuiPreferences(home, { btwModel: null });
    expect(readBtwModel(home)).toBeUndefined();
  });

  it("启动迁移把旧 web 共享数据与侧问偏好搬到 GUI 目录；未迁移前也能回退读取", () => {
    const home = tmpHome();
    mkdirSync(join(home, "web"), { recursive: true });
    writeFileSync(join(home, "web", "pins.json"), '["s_pin"]', "utf8");
    writeFileSync(join(home, "web", "workspaces.json"), '{"v":1,"hidden":["D:/old"]}', "utf8");
    writeFileSync(join(home, "web", "server.json"), JSON.stringify({ v: 1, pid: 123, port: 4321, startedAt: 1, token: "a".repeat(64) }), "utf8");
    writeFileSync(join(home, "config.toml"), 'btwModel = "demo/legacy"\n', "utf8");

    expect(readPins(home)).toEqual(["s_pin"]); // 迁移函数未跑时读旧路径的兼容回退
    expect(readHidden(home)).toEqual(["D:/old"]);
    expect(readInstance(home)?.port).toBe(4321);
    expect(readBtwModel(home)).toBe("demo/legacy");

    migrateLegacyGuiData(home);

    for (const name of ["pins.json", "workspaces.json", "server.json"]) {
      expect(existsSync(guiDataFile(home, name))).toBe(true);
      expect(existsSync(join(home, "web", name))).toBe(false);
    }
    expect(readPins(home)).toEqual(["s_pin"]);
    expect(readHidden(home)).toEqual(["D:/old"]);
    expect(readInstance(home)?.port).toBe(4321);
    expect(readBtwModel(home)).toBe("demo/legacy");
    expect(readFileSync(join(home, "config.toml"), "utf8")).not.toContain("btwModel");
  });
});
