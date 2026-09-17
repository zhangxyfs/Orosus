import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "@orosus/core";
import type { CommandUi, ModuleDefinition } from "@orosus/contracts/module";
import { Access, defineTool } from "@orosus/contracts/tool";
import type { Chunk } from "@orosus/contracts/provider";
import { fakeProvider } from "@orosus/testing";
import { z } from "zod";
import approvalDef from "@orosus/approval";
import { BUILTIN_MODULES } from "./builtins.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tmp = (name = "cli"): string => (dir = mkdtempSync(join(tmpdir(), `orosus-${name}-`)));

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
    expect(audit).toHaveLength(BUILTIN_MODULES.length); // T5 起 12
    expect(audit.filter((a) => a.state === "active").map((a) => a.name).sort()).toEqual(
      ["approval", "compaction", "mcp", "provider-custom", "provider-openai", "skill", "tool-fs", "tool-shell"], // T3 approval / T5 compaction 入图
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
    // T3 接通后：/permission 别名不再带「未安装」尾注
    expect(help).toContain("/permission → approval__permission");
    expect(help).not.toContain("未安装对应模块");
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

describe("/permission 接入 CLI（M3 T3）", () => {
  const subToolModule = (): ModuleDefinition => ({
    name: "t-sub", version: "0.1.0", description: "sub", api: 1,
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "t-sub__run", description: "run", parameters: z.object({}),
        resolveExecution: async () => ({
          accesses: [Access.subprocess()], approvalRule: "t-sub__run(x)",
          execute: async () => ({ output: "executed", isError: false }),
        }),
      }));
    },
  });
  const fakeProv = (): ModuleDefinition => ({
    name: "provider-fake", version: "0.1.0", description: "f", api: 1,
    activate(ctx) {
      const { stream } = fakeProvider([
        [{ type: "toolcall/argumentsDelta", callId: "c1", name: "t-sub__run", argumentsDelta: "{}" }, { type: "finish", kind: "toolUse" }] as Chunk[],
        [{ type: "text/delta", text: "done" }, { type: "finish", kind: "stop" }] as Chunk[],
      ]);
      ctx.provide("provider:fake" as never, stream);
    },
  });
  const choices: string[] = [];

  it("① 菜单选『从不询问（危险命令仍确认）』→ configFile 写回 + 运行期立即生效（subprocess 零询问直通）", async () => {
    const d = tmp("perm");
    const writeTarget = join(d, "written.toml");
    const cfgLine = "[approval]\nmode = \"ask-risky\"\nconfigFile = '";
    writeFileSync(join(d, "user.toml"), cfgLine + writeTarget.split("\\").join("/") + "'\n", "utf8");
    const ui: CommandUi = {
      ask: async () => { throw new Error("不应 ask"); },
      confirm: async () => { throw new Error("不应 confirm"); },
      choose: async (_t, items) => { choices.push(items.join("|")); return items.find((i) => i.includes("从不询问"))!; },
    };
    const h = await createHarness({
      cwd: d, builtinModules: BUILTIN_MODULES, modules: [subToolModule(), fakeProv()], commandUi: ui,
      secretsFile: join(d, "s.env"), diagDir: join(d, "logs"), spillDir: join(d, "spill"),
      discovery: { userDir: join(d, "m"), projectDir: join(d, "p"), trustFile: join(d, "t.json") },
      config: { userFile: join(d, "user.toml"), projectFile: join(d, "n.toml"), env: {}, cliOverrides: { model: "fake/x" } },
    });
    const msg = await h.prompt("/permission");
    expect(msg).toContain("never");
    expect(readFileSync(writeTarget, "utf8")).toContain('mode = "never"');
    const render = (async () => { for await (const _ of h.events()) void _; })();
    await h.prompt("run"); // ask-risky 下本应询问——override 后零询问直通
    await h.close();
    await render;
    expect(choices).toEqual(["切换权限模式|查看规则清单|取消", "始终询问（ask-always）|需要时询问（ask-risky，默认）|从不询问（危险命令仍确认）"]);
  });

  it("② 出厂 required：activate 抛错的 approval 替身 → createHarness reject（§10 安全护栏 e2e）", async () => {
    const d = tmp("req");
    const throwing = { ...approvalDef, activate(): void { throw new Error("激活失败（测试注入）"); } } as ModuleDefinition;
    await expect(createHarness({
      cwd: d, builtinModules: [throwing],
      secretsFile: join(d, "s.env"), diagDir: join(d, "logs"),
      discovery: { userDir: join(d, "m"), projectDir: join(d, "p"), trustFile: join(d, "t.json") },
      config: { userFile: join(d, "u.toml"), projectFile: join(d, "p.toml"), env: {} },
    })).rejects.toThrow(/required.*approval|approval.*required/);
  });

  it("③ /help 别名行存在且不再带「未安装对应模块」尾注（M2 预留口子接通）", async () => {
    const h = await isolated();
    const help = await h.prompt("/help");
    expect(help).toContain("/permission → approval__permission");
    expect(help).not.toContain("（未安装对应模块）的 /permission");
    await h.close();
  });

  it("④ 写生效层（五轮 P1）：项目层含 [approval] 节时切换写项目层并生效", async () => {
    const d = tmp("layer");
    const userToml = join(d, "user.toml");
    const projToml = join(d, "proj", "config.toml");
    mkdirSync(join(d, "proj"), { recursive: true });
    const cfgLine4 = "[approval]\nmode = \"ask-risky\"\nprojectConfigFile = '";
    writeFileSync(userToml, cfgLine4 + projToml.split("\\").join("/") + "'\n", "utf8");
    writeFileSync(projToml, "[approval]" + String.fromCharCode(10) + 'mode = "ask-risky"' + String.fromCharCode(10), "utf8"); // 项目层节存在 → 生效层
    const ui: CommandUi = {
      ask: async () => { throw new Error("不应 ask"); },
      confirm: async () => false,
      choose: async (_t, items) => items.find((i) => i.includes("从不询问"))!,
    };
    const h = await createHarness({
      cwd: d, builtinModules: BUILTIN_MODULES, commandUi: ui,
      secretsFile: join(d, "s.env"), diagDir: join(d, "logs"), spillDir: join(d, "spill"),
      discovery: { userDir: join(d, "m"), projectDir: join(d, "p"), trustFile: join(d, "t.json") },
      config: { userFile: userToml, projectFile: projToml, env: {} },
    });
    await h.prompt("/permission");
    expect(readFileSync(projToml, "utf8")).toContain('mode = "never"'); // 写的是项目层
    expect(readFileSync(userToml, "utf8")).toContain('mode = "ask-risky"'); // 用户层未被误写
    await h.close();
  });
});
