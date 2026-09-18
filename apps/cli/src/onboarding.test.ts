import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandUi } from "@orosus/contracts/module";
import { needsProviderSetup, readConfigModel, runOnboarding } from "./onboarding.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const tmp = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-onboard-"))) as string;

describe("首启 provider 引导（M3 T10 补——D37/D38 的宿主侧闭环）", () => {
  it("needsProviderSetup 检测矩阵：无 model / provider 不在槽列表 → true；可用 → false；flag 优先", () => {
    expect(needsProviderSetup({ model: undefined, providers: [] })).toBe(true);
    expect(needsProviderSetup({ model: "  ", providers: ["openai"] })).toBe(true);
    expect(needsProviderSetup({ model: "glm", providers: ["openai", "glm"] })).toBe(false);   // 裸名：glm 槽在
    expect(needsProviderSetup({ model: "glm/glm-5.3", providers: ["glm"] })).toBe(false);     // 全名
    expect(needsProviderSetup({ model: "ghost/x", providers: ["openai"] })).toBe(true);       // 指向不可用 provider
  });

  it("readConfigModel：user→project 分层（后者胜）；无文件/坏 TOML → undefined 不炸", () => {
    const d = tmp();
    const user = join(d, "user.toml");
    const proj = join(d, "proj.toml");
    expect(readConfigModel(user, proj)).toBeUndefined();
    writeFileSync(user, 'model = "glm"\n', "utf8");
    expect(readConfigModel(user, join(d, "none.toml"))).toBe("glm");
    writeFileSync(proj, 'model = "openai/gpt-5"\n', "utf8");
    expect(readConfigModel(user, proj)).toBe("openai/gpt-5"); // project 覆盖 user
    const bad = join(d, "bad.toml");
    writeFileSync(bad, "model = ", "utf8");
    expect(readConfigModel(bad, join(d, "none.toml"))).toBeUndefined();
  });

  it("runOnboarding：拒绝 → 跳过提示且不进 /provider；同意 → 转发 /provider 并回显结果", async () => {
    const prompts: string[] = [];
    const h = { graph: () => ({ services: { listProviders: () => [] } }), prompt: async (t: string) => { prompts.push(t); return "provider 菜单结果"; } };
    const noUi: CommandUi = { ask: async () => "", choose: async (_t, i) => i[0]!, confirm: async () => false };
    expect(await runOnboarding(h, noUi)).toContain("跳过");
    expect(prompts).toEqual([]);
    const yesUi: CommandUi = { ask: async () => "", choose: async (_t, i) => i[0]!, confirm: async () => true };
    expect(await runOnboarding(h, yesUi)).toBe("provider 菜单结果");
    expect(prompts).toEqual(["/provider"]);
  });

  it("真实谓词在全家福下的行为：无 config → true（model 缺失主导）；配 openai model → false", async () => {
    const { createHarness } = await import("@orosus/core");
    const { BUILTIN_MODULES } = await import("./builtins.ts");
    const d = tmp();
    writeFileSync(join(d, "config.toml"), 'model = "openai/gpt-5"\n', "utf8");
    const base = (userToml?: string) => ({
      cwd: d,
      builtinModules: BUILTIN_MODULES,
      secretsFile: join(d, "s.env"),
      diagDir: join(d, "logs"),
      discovery: { userDir: join(d, "m"), projectDir: join(d, "p"), trustFile: join(d, "t.json") },
      config: { userFile: userToml ?? join(d, "u.toml"), projectFile: join(d, "n.toml"), env: {} },
    });
    const h1 = await createHarness(base());
    const providers = h1.graph().services.listProviders().map((p) => p.name);
    expect(providers).toContain("openai"); // openai 无 key 也激活（apiKey 可选）
    expect(needsProviderSetup({ model: undefined, providers })).toBe(true); // 全新安装：model 缺失
    const h2 = await createHarness(base(join(d, "config.toml")));
    expect(needsProviderSetup({ model: readConfigModel(join(d, "config.toml"), join(d, "n.toml")), providers: h2.graph().services.listProviders().map((p) => p.name) })).toBe(false);
    await h1.close();
    await h2.close();
  });
});
