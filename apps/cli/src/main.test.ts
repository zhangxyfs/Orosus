import { describe, it, expect, afterEach } from "vitest";import { spawn } from "node:child_process";
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
const isolated = (over: { userToml?: string; commandUi?: CommandUi } = {}) => {
  const d = tmp();
  const userFile = join(d, "config.toml");
  if (over.userToml !== undefined) writeFileSync(userFile, over.userToml, "utf8");
  return createHarness({
    cwd: d,
    builtinModules: BUILTIN_MODULES,
    ...(over.commandUi !== undefined ? { commandUi: over.commandUi } : {}),
    secretsFile: join(d, "secrets.env"),
    diagDir: join(d, "logs"),
    sessionsDir: join(d, "sessions"), // 密封（2026-09-19 走查泄漏修复）：此前缺省 = 真实 ~/.orosus/sessions——
    // 每跑一次测试套件就在用户真实目录漏 2 个会话文件（走查实录：10 个 2040B 的 run/done 空壳）。M1 纪律补丁。
    discovery: { userDir: join(d, "mods"), projectDir: join(d, "pmods"), trustFile: join(d, "trust.json") },
    config: { userFile, projectFile: join(d, "proj.toml"), env: {} },
  });
};

describe("CLI 全家福与命令装配（M2 补账——M1 CLI × M2 模块生态的配合闭环）", () => {
  it("builtinModules 十三模块进图（会话树批 T12：session-tree 入图）；tool-search 默认关态，余者 active", async () => {
    const h = await isolated();
    const audit = h.graph().audit();
    expect(audit).toHaveLength(BUILTIN_MODULES.length); // 品牌 ×5 退役后 9 + tool-web + tool-search + tool-goal = 12
    expect(audit.filter((a) => a.state === "active").map((a) => a.name).sort()).toEqual(
      ["approval", "compaction", "mcp", "provider-custom", "session-tree", "skill", "tool-ask", "tool-fs", "tool-goal", "tool-shell", "tool-todo", "tool-web"],
    );
    // SW-26：tool-search 默认关（defaultEnabled:false）= 模块不激活（discovered 未激活态——机制整门不启的正解；[tool-search] enabled=true 开启）
    expect(audit.find((a) => a.name === "tool-search")?.state).toBe("discovered");
    const failed = audit.filter((a) => a.state === "failed");
    expect(failed).toEqual([]); // 品牌降级面已随 ×5 退役消失（banner 品牌分支同拆）
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
    expect(help).toContain("/model /effort /help /reload"); // 内建清单含 /reload（补账；批⑤⑥：/status /usage 退役出内建表；2026-09-25 /effort 入内建表）
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

  it("① 菜单选『从不询问——批准自动处理，就算有问题也是模型自行判断（never）』→ configFile 写回 + 运行期立即生效（subprocess 零询问直通）", async () => {
    const d = tmp("perm");
    const writeTarget = join(d, "written.toml");
    const cfgLine = "[approval]\nmode = \"ask-risky\"\nconfigFile = '";
    writeFileSync(join(d, "user.toml"), cfgLine + writeTarget.split("\\").join("/") + "'\n", "utf8");
    const ui: CommandUi = {
      ask: async () => { throw new Error("不应 ask"); },
      askSecret: async () => "",
      confirm: async () => { throw new Error("不应 confirm"); },
      choose: async (_t, items) => { choices.push(items.join("|")); return items.find((i) => i.includes("从不询问"))!; },
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
    expect(choices).toEqual(["每次都询问——每次工具调用都确认（ask-always）|需要时候询问——仅危险操作确认（ask-risky，默认）|从不询问——批准自动处理，就算有问题也是模型自行判断（never）"]); // 2026-09-26 拍板：显示名改中文（内部档名括注保留） // 顶级菜单退役（2026-09-19 用户走查）——一级直达三档
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
      choose: async (_t, items) => items.find((i) => i.includes("从不询问"))!,
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

  it("⑩ /sessions：列出会话目录最近会话（mtime 降序、jsonl/sqlite 双主文件、空目录友好；T2 目录化新形态）", async () => {
    const { listSessions, formatSessions } = await import("./sessions.ts");
    const d = tmp("sess");
    const empty = join(d, "none");
    expect(listSessions(empty)).toEqual([]);
    expect(formatSessions(empty)).toContain("暂无会话");
    const sessDir = join(d, "sessions");
    const seed = (sid: string, ext: "jsonl" | "sqlite"): void => {
      mkdirSync(join(sessDir, "B", sid, "agents"), { recursive: true });
      writeFileSync(join(sessDir, "B", sid, "agents", `session.${ext}`), "{}", "utf8");
    };
    seed("s_old", "jsonl");
    await new Promise((r) => setTimeout(r, 30));
    seed("s_new", "jsonl");
    seed("s_db", "sqlite");
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

describe("模块命令 Esc 穿透契约（2026-09-24 走查实锤前案回归钉——/settings 弹窗 Esc 炸穿 exit 7）", () => {
  it("配置流 choose Esc → h.prompt 原样抛出「已取消（Esc）」+ 零写盘（宿主 catch-all 接住的责任链钉）", async () => {
    // Esc 穿透是设计契约（/model 收窄 catch 同款——处理器的兜底 catch 不许吞 UI 交互）；
    // 接住的责任在宿主 processReplLine catch-all + runSubmit 网兜（settleCommandError 同政策）——
    // 本钉锁死契约本身：穿透若哪天被 harness 吞掉，宿主静默面就失效了
    const escUi: CommandUi = {
      ask: async () => "",
      askSecret: async () => "",
      choose: async () => { throw new Error("已取消（Esc）"); },
      confirm: async () => false,
    };
    const h = await isolated({ commandUi: escUi });
    await expect(h.prompt("/tool-web__settings")).rejects.toThrow("已取消（Esc）");
    await h.close();
  });
});

describe("/provider 写盘 → reload → 新槽进图（2026-09-24 走查 bug②机制钉——/settings LLM 钉模型清单读活槽）", () => {
  it("配置中新增平台 + h.reload() → listProviders 含新槽、槽模型经目录聚合可取", async () => {
    // 机制钉：自动重载钩在 main.ts processReplLine（宿主脚本内件无独立缝——与 Esc 修复同记录在案）；
    // 本钉锁死其依赖的语义面：reload 后新槽激活进图 + 槽模型目录优选聚合（盘喂盘密封，零网络）；
    // 跨槽聚合 provider/model 限定形钉在 harness.test.ts ⑤⑥（不重复）
    const h = await isolated({ userToml: 'model = "fake/m"' + String.fromCharCode(10) }); // tmp 目录即共享 dir
    const prevHome = process.env["OROSUS_HOME"];
    process.env["OROSUS_HOME"] = dir; // 目录缓存密封进同一 tmp（listModels 调用期才解析路径）
    try {
      mkdirSync(join(dir, "cache"), { recursive: true });
      writeFileSync(join(dir, "cache", "models-dev.json"), JSON.stringify({
        fetchedAt: Date.now(),
        catalog: { newprov: { id: "newprov", name: "NewProv", models: { "nm-1": { id: "nm-1" } } } },
      }), "utf8");
      // 中途写盘新增平台（等价 /provider 向导的产物）
      writeFileSync(join(dir, "config.toml"), [
        'model = "fake/m"',
        "",
        "[provider-custom.providers.newprov]",
        'type = "openai"',
        'baseUrl = "https://newprov.example/v1"',
        'defaultModel = "nm-1"',
        "",
      ].join("\n"), "utf8");
      await h.reload();
      expect(h.graph().services.listProviders().map((p) => p.name)).toContain("newprov");
      // 槽级 listModels 数据源直证（目录优选——盘喂盘即中，live 不触网）
      const { catalogPreferredListModels, diskFirstCatalogLoader, openaiListModels } = await import("@orosus/provider-custom");
      const list = await catalogPreferredListModels("newprov", openaiListModels({ baseUrl: "https://newprov.example/v1", fetchImpl: (async () => { throw new Error("不该走 live"); }) as typeof fetch }), diskFirstCatalogLoader())();
      expect(list).toEqual(["nm-1"]);
      await h.close();
    } finally {
      if (prevHome === undefined) delete process.env["OROSUS_HOME"];
      else process.env["OROSUS_HOME"] = prevHome;
    }
  });
});
