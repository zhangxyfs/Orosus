import { describe, it, expect, afterEach } from "vitest";
import { fg, registerTheme, setTheme, activeThemeName, THEMES, type ThemeTokens } from "./theme.ts";

/** m5 T12：主题可切机制——注册表 + 换集出新色 + 缓存失效 + 未知名抛错。
 *  导出函数签名全不变（调用面 301 处零改动）。本批仓内仅连山一套——测试注册临时主题验证机制。 */

const debugTheme: ThemeTokens = {
  bg: "#000000", surface: "#0a0a0a", surface2: "#111111", fg: "#eeeeee", muted: "#888888",
  border: "#333333", accent: "#ff0000", info: "#00ff00", warn: "#ffff00", err: "#ff00ff",
  diffAdd: "#00ff66", diffDel: "#ff0066", accentSoft: "#200000", errSoft: "#200020",
};

describe("主题可切机制（m5 T12）", () => {
  afterEach(() => {
    setTheme("连山"); // 恢复——不污染其他测试的默认主题
  });

  it("① 缺省 = 连山；换集后同语义名出新色（accent 从青玉变测试红）", () => {
    registerTheme("调试", debugTheme);
    expect(activeThemeName()).toBe("连山");
    const before = fg("accent", "x");
    setTheme("调试");
    expect(activeThemeName()).toBe("调试");
    const after = fg("accent", "x");
    expect(after).not.toBe(before); // 缓存失效 + 新集生效
    expect(after).not.toBe(before); // 256 降级形态 38;5;196 / truecolor 38;2;255;0;0——只断言换值不断言形态
    setTheme("连山");
    expect(fg("accent", "x")).toBe(before); // 切回原样（缓存随切换失效重算）
  });

  it("② 未知名抛错（settingsService.setTheme 转 reject 的底座）；错误消息列可用主题", () => {
    expect(() => setTheme("不存在")).toThrow(/未知主题/);
    expect(() => setTheme("不存在")).toThrow(/连山/);
  });

  it("③ 注册表形态：THEMES 含连山；重复注册同名覆盖（机制口，主题包将来用）", () => {
    expect(THEMES.has("连山")).toBe(true);
    registerTheme("重复", debugTheme);
    registerTheme("重复", debugTheme);
    setTheme("重复");
    expect(activeThemeName()).toBe("重复");
  });
});
