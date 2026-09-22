import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "@orosus/core";
import type { CommandUi, ModuleDefinition } from "@orosus/contracts/module";
import { Access, defineTool } from "@orosus/contracts/tool";
import type { Chunk } from "@orosus/contracts/provider";
import { fakeProvider } from "@orosus/testing";
import { z } from "zod";

const repoRoot = (): string => join(import.meta.dirname, "..", "..", "..");
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
    sessionsDir: join(d, "sessions"), // 密封（2026-09-19 走查泄漏修复）：此前缺省 = 真实 ~/.orosus/sessions——
    // 每跑一次测试套件就在用户真实目录漏 2 个会话文件（走查实录：10 个 2040B 的 run/done 空壳）。M1 纪律补丁。
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
      ["approval", "compaction", "mcp", "provider-custom", "provider-openai", "skill", "tool-ask", "tool-fs", "tool-shell", "tool-todo"], // T3 approval / T5 compaction 入图
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
    expect(help).toContain("/model /help /reload"); // 内建清单含 /reload（补账；批⑤⑥：/status /usage 退役出内建表）
    await h.close();
  });

  it("h.status() 读口在 model 未配置时显示（未配置）而非字面量 undefined（补账回归——批⑥ /status 命令退役转读口）", async () => {
    const h = await isolated();
    const st = h.status();
    expect(st.model).toBe("（未配置）");
    expect(JSON.stringify(st)).not.toContain("undefined");
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

  it("① 菜单选『Never Ask——全部自动放行，批准自动处理（never）』→ configFile 写回 + 运行期立即生效（subprocess 零询问直通）", async () => {
    const d = tmp("perm");
    const writeTarget = join(d, "written.toml");
    const cfgLine = "[approval]\nmode = \"ask-risky\"\nconfigFile = '";
    writeFileSync(join(d, "user.toml"), cfgLine + writeTarget.split("\\").join("/") + "'\n", "utf8");
    const ui: CommandUi = {
      ask: async () => { throw new Error("不应 ask"); },
      askSecret: async () => "",
      confirm: async () => { throw new Error("不应 confirm"); },
      choose: async (_t, items) => { choices.push(items.join("|")); return items.find((i) => i.includes("Never Ask"))!; },
    };
    const h = await createHarness({
      cwd: d, builtinModules: BUILTIN_MODULES, modules: [subToolModule(), fakeProv()], commandUi: ui,
      secretsFile: join(d, "s.env"), diagDir: join(d, "logs"), spillDir: join(d, "spill"),
      sessionsDir: join(d, "sessions"), // 密封（2026-09-19 泄漏修复）——自建 harness 不过 isolated() 的两处
      discovery: { userDir: join(d, "m"), projectDir: join(d, "p"), trustFile: join(d, "t.json") },
      config: { userFile: join(d, "user.toml"), projectFile: join(d, "n.toml"), env: {}, cliOverrides: { model: "fake/x" } },
    });
    const msg = await h.prompt("/permission");
    expect(msg).toBe(""); // 静默钉（批⑧——切换成功零输出；生效面在写盘与下方渲染）
    expect(readFileSync(writeTarget, "utf8")).toContain('mode = "never"');
    const render = (async () => { for await (const _ of h.events()) void _; })();
    await h.prompt("run"); // ask-risky 下本应询问——override 后零询问直通
    await h.close();
    await render;
    expect(choices).toEqual(["Always Ask——每次工具调用都确认（ask-always）|Ask When Needed——仅危险操作确认（ask-risky，默认）|Never Ask——全部自动放行，批准自动处理（never）"]); // F5 十轮⑤：英文档名 // 顶级菜单退役（2026-09-19 用户走查）——一级直达三档
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
      askSecret: async () => "",
      confirm: async () => false,
      choose: async (_t, items) => items.find((i) => i.includes("Never Ask"))!,
    };
    const h = await createHarness({
      cwd: d, builtinModules: BUILTIN_MODULES, commandUi: ui,
      secretsFile: join(d, "s.env"), diagDir: join(d, "logs"), spillDir: join(d, "spill"),
      sessionsDir: join(d, "sessions"), // 密封（2026-09-19 泄漏修复）——自建 harness 不过 isolated() 的两处
      discovery: { userDir: join(d, "m"), projectDir: join(d, "p"), trustFile: join(d, "t.json") },
      config: { userFile: userToml, projectFile: projToml, env: {} },
    });
    await h.prompt("/permission");
    expect(readFileSync(projToml, "utf8")).toContain('mode = "never"'); // 写的是项目层
    expect(readFileSync(userToml, "utf8")).toContain('mode = "ask-risky"'); // 用户层未被误写
    await h.close();
  });
});

describe("CLI 会话命令与 flag（M3 T6，D41）", () => {
  it("⑧ --resume/--fork flag 解析（含 <id>:<entryId> 冒号语法）", async () => {
    const { parseArgs } = await import("./args.ts");
    expect(parseArgs(["--resume", "s_123"])).toMatchObject({ resume: { sessionId: "s_123" } });
    expect(parseArgs(["--fork", "s_1:e_9"])).toMatchObject({ fork: { parentSessionId: "s_1", atEntryId: "e_9" } });
    expect(parseArgs(["--fork", "s_1"])).toMatchObject({ fork: { parentSessionId: "s_1" } });
    expect(() => parseArgs(["--fork"])).toThrow(/缺值/);
  });

  it("⑨ sessionCommand/harnessOptionsFor：/new 与 /fork 的会话切换指令", async () => {
    const { sessionCommand, harnessOptionsFor } = await import("./sessions.ts");
    expect(sessionCommand("/new", { sessionId: "s1" })).toEqual({ kind: "new" });
    expect(sessionCommand("/fork", { sessionId: "s1", lastEventId: "e7" })).toEqual({ kind: "fork", parentSessionId: "s1", atEntryId: "e7" });
    expect(sessionCommand("/quit", { sessionId: "s1" })).toEqual({ kind: "quit" });
    expect(sessionCommand("/exit", { sessionId: "s1" })).toEqual({ kind: "quit" });
    expect(sessionCommand("/q", { sessionId: "s1" })).toEqual({ kind: "quit" }); // 同义集（2026-09-18 用户要求）
    expect(sessionCommand("/quit now", { sessionId: "s1" })).toEqual({ kind: "none" }); // 带参不误伤
    expect(sessionCommand("/sessions", { sessionId: "s1" })).toEqual({ kind: "pick" }); // B9 拉前：无参 = 列表选中即 resume
    expect(sessionCommand("普通输入", { sessionId: "s1" })).toEqual({ kind: "none" });
    expect(harnessOptionsFor({ kind: "new" })).toEqual({});
    expect(harnessOptionsFor({ kind: "fork", parentSessionId: "s1", atEntryId: "e7" })).toEqual({ fork: { parentSessionId: "s1", atEntryId: "e7" } });
  });

  it("⑩ /sessions：列出会话目录最近会话（mtime 降序、jsonl/sqlite 双后缀、空目录友好）", async () => {
    const { listSessions, formatSessions } = await import("./sessions.ts");
    const d = tmp("sess");
    const empty = join(d, "none");
    expect(listSessions(empty)).toEqual([]);
    expect(formatSessions(empty)).toContain("暂无会话");
    const sessDir = join(d, "sessions");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, "s_old.jsonl"), "{}", "utf8");
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(join(sessDir, "s_new.jsonl"), "{}", "utf8");
    writeFileSync(join(sessDir, "s_db.sqlite"), "{}", "utf8");
    const ids = listSessions(sessDir).map((x) => x.id);
    expect(ids[0]).toBe("s_db"); // 最新写入在前
    expect(new Set(ids)).toEqual(new Set(["s_old", "s_new", "s_db"]));
    expect(formatSessions(sessDir)).toContain("s_new");
  });

  it("⑪ /new 语义端到端：新 harness 即新 session id（旧会话关闭幂等）", async () => {
    const h1 = await isolated();
    const id1 = h1.sessionId;
    await h1.close();
    await h1.close(); // 幂等
    const h2 = await isolated();
    expect(h2.sessionId).not.toBe(id1);
    await h2.close();
  });
});

describe("steering 排队锁定（M4-2 T19/B19——cc-haha 排队式：turn 进行中到达的行入队，完成后依序消费）", () => {
  it("① 子进程管道两条消息 → 两轮完整回复、退出码 0、无「已有进行中的 turn」（回归钉：并发 REPL/丢队列将变红）", async () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-steer-"));
    try {
      const env = { ...process.env, USERPROFILE: join(d, "home"), MOCK_PORT: "8765" } as Record<string, string>;
      // 家目录喂 mock provider 配置（进程外 mock 端点需可达——本机 8765 由走查环境持有；不可达时跳过断言网络内容，仅锁定退出码与无并发错误）
      mkdirSync(join(d, "home", ".orosus"), { recursive: true });
      const configOk = await fetch("http://127.0.0.1:8765/models").then((r) => r.ok, () => false);
      writeFileSync(join(d, "home", ".orosus", "config.toml"), [
        'model = "mock/mock-1"',
        "[provider-custom.providers.mock]",
        'type = "openai"',
        'baseUrl = "http://127.0.0.1:8765"',
        'apiKey = "mock-key"',
        "",
      ].join("\n"), "utf8");
      const child = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot(), "apps/cli/src/main.ts")], {
        cwd: d, env, stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c) => { out += String(c); });
      child.stderr.on("data", (c) => { out += String(c); });
      child.stdin.write("第一条\n");
      await new Promise((r) => setTimeout(r, 300)); // 第一轮进行中投递第二条（排队场景）
      child.stdin.write("第二条\n");
      child.stdin.end();
      const code = await new Promise<number>((resolve) => { child.on("exit", (c) => resolve(c ?? -1)); });
      expect(code).toBe(0);
      expect(out).not.toContain("已有进行中的 turn");
      if (configOk) {
        const replies = (out.match(/（mock）收到：/g) ?? []).length;
        expect(replies).toBe(2); // 两轮完整回复——管道喂两条不丢行
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);
});
