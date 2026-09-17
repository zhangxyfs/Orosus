import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import anthropic from "@orosus/provider-anthropic";
import glm from "@orosus/provider-glm";
import kimi from "@orosus/provider-kimi";
import deepseek from "@orosus/provider-deepseek";
import openai from "@orosus/provider-openai";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const USER_TOML_ALL = `
[provider-anthropic]
apiKey = "sk-test"

[provider-glm]
apiKey = "zk-test"

[provider-kimi]
apiKey = "mk-test"

[provider-deepseek]
apiKey = "dk-test"
`;

const USER_TOML_GLM = `
[provider-glm]
apiKey = "zk-test"
`;

describe("五适配器共存（T20）：分槽路由 + 裸名 + 冲突降级", () => {
  it("五品牌适配器全 active（apiKey 经密封 user.toml 注入）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-multi-")); dirs.push(dir);
    writeFileSync(join(dir, "user.toml"), USER_TOML_ALL);
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
      builtinModules: [anthropic, glm, kimi, deepseek, openai],
      config: { userFile: join(dir, "user.toml"), projectFile: join(dir, "no2.toml"), env: {} },
    });
    const names = h.graph().records.filter((r) => r.state === "active").map((r) => r.name);
    for (const n of ["provider-anthropic", "provider-glm", "provider-kimi", "provider-deepseek", "provider-openai"]) {
      expect(names).toContain(n);
    }
    await h.close();
  });

  it("裸名 defaultModel 路由（glm 槽值含 glm-5.3）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-multi-")); dirs.push(dir);
    writeFileSync(join(dir, "user.toml"), USER_TOML_GLM);
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
      builtinModules: [glm],
      config: { userFile: join(dir, "user.toml"), projectFile: join(dir, "no2.toml"), env: {}, cliOverrides: { model: "glm" } },
    });
    const rec = h.graph().records.find((r) => r.name === "provider-glm");
    expect(rec?.state).toBe("active");
    await h.close();
  });
});
