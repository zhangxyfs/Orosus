import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "@orosus/core";
import { InMemorySessionStore } from "./session/memory.ts";

import { kernelT, setKernelLocale } from "./kernel/i18n.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const fakeProviderModule = {
  name: "fake", version: "0.1.0", description: "fake provider for tests", api: 1,
  provides: ["provider:fake"],
  activate: () => { /* provider 槽不需要——cliOverrides 直供 */ },
} as const;

const makeLangHarness = async (language?: string): Promise<Harness> => {
  dir = mkdtempSync(join(tmpdir(), "orosus-lang-"));
  const userFile = join(dir, "user.toml");
  writeFileSync(userFile, language === undefined ? 'provider = "fake/m"\n' : `provider = "fake/m"\nlanguage = ${JSON.stringify(language)}\n`, "utf8");
  return createHarness({
    store: new InMemorySessionStore(),
    diagDir: dir,
    sessionsDir: join(dir, "sessions"),
    spillDir: join(dir, "spill"),
    modules: [fakeProviderModule as never],
    config: {
      userFile,
      projectFile: join(dir, "no-proj.toml"),
      catalogCacheFile: join(dir, "no-catalog.json"),
      env: {},
      cliOverrides: { model: "fake/m" },
    },
  });
};

describe("m5-i18n T3：harness configuredLanguage / setLanguage", () => {
  it("configuredLanguage：未设置返回 undefined；已设置返回原文（不归一——归一在宿主 store.init）", async () => {
    const h1 = await makeLangHarness();
    expect(h1.configuredLanguage()).toBeUndefined();
    await h1.close();
    const h2 = await makeLangHarness("ja-JP");
    expect(h2.configuredLanguage()).toBe("ja-JP");
    await h2.close();
  });

  it("setLanguage：行级写顶层 language 键（原文件其余行保持——保注释保键序口径）", async () => {
    const h = await makeLangHarness();
    await h.setLanguage("zh-TW");
    const after = readFileSync(join(dir!, "user.toml"), "utf8");
    expect(after).toContain('language = "zh-TW"');
    expect(after).toContain('provider = "fake/m"'); // 既有键不动
    await h.close();
  });

  it("setLanguage 联动内核地板 t（failReason 新事件语言跟随；旧账不追改——D5）", async () => {
    const h = await makeLangHarness();
    setKernelLocale(undefined); // 复位缺省 zh-CN（kernelT 是模块级单例——测试间隔离靠显式复位）
    expect(kernelT("core.kernel.disabled")).toContain("未启用");
    await h.setLanguage("en-US");
    expect(kernelT("core.kernel.disabled")).toContain("Not enabled");
    setKernelLocale(undefined); // 收尾复位，防污染后续测试
    await h.close();
  });
});
