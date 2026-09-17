import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "@orosus/core";
import { BUILTIN_MODULES } from "./builtins.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tmp = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-cli-")));

/** 密封 harness（M1 纪律：测试不碰真实 ~/.orosus）。 */
const isolated = (over: { userToml?: string } = {}) => {
  const d = tmp();
  const userFile = join(d, "config.toml");
  if (over.userToml !== undefined) writeFileSync(userFile, over.userToml, "utf8");
  return createHarness({
    cwd: d,
    builtinModules: BUILTIN_MODULES,
    secretsFile: join(d, "secrets.env"),
    diagDir: join(d, "logs"),
    discovery: { userDir: join(d, "mods"), projectDir: join(d, "pmods"), trustFile: join(d, "trust.json") },
    config: { userFile, projectFile: join(d, "proj.toml"), env: {} },
  });
};

describe("CLI 全家福与命令装配（M2 补账——M1 CLI × M2 模块生态的配合闭环）", () => {
  it("builtinModules 十模块进图：M2 产物全部可达；未配置密钥的适配器诚实降级", async () => {
    const h = await isolated();
    const audit = h.graph().audit();
    expect(audit).toHaveLength(BUILTIN_MODULES.length);
    expect(audit.filter((a) => a.state === "active").map((a) => a.name).sort()).toEqual(
      ["mcp", "provider-custom", "provider-openai", "skill", "tool-fs", "tool-shell"],
    );
    const failed = audit.filter((a) => a.state === "failed");
    expect(failed.map((a) => a.name).sort()).toEqual(["provider-anthropic", "provider-deepseek", "provider-glm", "provider-kimi"]);
    expect(failed.every((a) => (a.failReason ?? "").includes("apiKey"))).toBe(true); // apiKey 必填的适配器空配置下明示原因（§10）
    await h.close();
  });

  it("/provider 别名目标真实存在（T7 欠账回归）：命令注册 + /help 不再提示未安装", async () => {
    const h = await isolated();
    expect(h.graph().commands.map((c) => c.name)).toContain("provider-custom__provider");
    const help = await h.prompt("/help");
    expect(help).toContain("/provider → provider-custom__provider");
    expect(help).not.toContain("（未安装对应模块）的 /provider");
    // M3 口子（现有行为）：/permission 别名指向尚不存在的 approval 模块——提示安装，正是留口形态
    expect(help).toContain("/permission → approval__permission");
    expect(help).toContain("未安装对应模块");
    expect(help).toContain("/model /help /status /usage /reload"); // 内建清单含 /reload（补账）
    await h.close();
  });

  it("/status 在 model 未配置时显示（未配置）而非字面量 undefined（补账回归）", async () => {
    const h = await isolated();
    const out = await h.prompt("/status");
    expect(out).toContain("model: （未配置）");
    expect(out).not.toContain("undefined");
    await h.close();
  });
});
