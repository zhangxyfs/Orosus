import { describe, it, expect, afterEach } from "vitest";import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { orosusHome as homeDir } from "@orosus/contracts/home";
import { createHarness } from "@orosus/core";
import type { CommandUi, ModuleDefinition, SubagentRosterEntry } from "@orosus/contracts/module";
import { Access, defineTool } from "@orosus/contracts/tool";
import type { Chunk } from "@orosus/contracts/provider";
import { fakeProvider } from "@orosus/testing";
import { z } from "zod";

const repoRoot = (): string => join(import.meta.dirname, "..", "..", "..");
import approvalDef from "@orosus/approval";
import { BUILTIN_MODULES } from "./builtins.ts";
import { shortenPath } from "./usage-text.ts";
import { openBtw, lastBtwArchive } from "./btw-cmd.ts";
import { stripAnsi } from "./tui/width.ts";

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
  it("builtinModules 十七模块进图（会话树批 session-tree / M4.5 tool-subagent / m5-media tool-media / m5-hooks hooks 入图）；tool-search 默认开（2026-09-30 拍板翻转——预装批承重墙）", async () => {
    const h = await isolated();
    const audit = h.graph().audit();
    expect(audit).toHaveLength(BUILTIN_MODULES.length);
    expect(audit.filter((a) => a.state === "active").map((a) => a.name).sort()).toEqual(
      ["approval", "compaction", "hooks", "mcp", "provider-custom", "session-tree", "skill", "tool-ask", "tool-fs", "tool-goal", "tool-media", "tool-search", "tool-shell", "tool-subagent", "tool-todo", "tool-web"],
    );
    // SW-26 语义不变只翻默认：关态 = enabled:false 显式（isolated 无 tool-search 配置 → 默认开 active；meta 工具在场）
    expect(audit.find((a) => a.name === "tool-search")?.state).toBe("active");
    expect(h.graph().tools.toolInfos().find((t) => t.name === "tool-search__search")).toBeDefined(); // meta 工具在场（工具面非命令面）
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

  it("① 菜单选『从不询问——批准自动处理，就算有问题也是模型自行判断』→ configFile 写回 + 运行期立即生效（subprocess 零询问直通）", async () => {
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
    expect(choices).toEqual(["每次都询问——每次工具调用都确认|需要时候询问——仅危险操作确认|从不询问——批准自动处理，就算有问题也是模型自行判断"]); // 2026-09-26 拍板：显示名改中文（纯中文无英文括注——2026-09-28 走查修在途红） // 顶级菜单退役（2026-09-19 用户走查）——一级直达三档
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
  // CL-04 同步（2026-09-28 code review）：--fork 死旗标已从 args.ts 移除（args.fork 全仓零消费——CLI fork
  // 实际全部走交互 /fork → extra.fork 路径）；本用例原三行 --fork 断言随旗标退役，改钉「未知参数」口径。
  // 详钉在 args.test.ts（CL-04 回归钉）。
  it("⑧ --resume flag 解析；--fork 已移除（CL-04 死旗标——未知参数报错）", async () => {
    const { parseArgs } = await import("./args.ts");
    expect(parseArgs(["--resume", "s_123"])).toMatchObject({ resume: { sessionId: "s_123" } });
    expect(() => parseArgs(["--fork", "s_1"])).toThrow(/未知参数/);
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
    expect(formatSessions(sessDir)).toContain("1. s_db"); // sqlite 会话标题走 id 兜底（readTitle 既有口径）
    expect(formatSessions(sessDir)).toContain("2. 新会话"); // jsonl 空会话行兜底「新会话」（2026-10-01 起不裸显 sid）
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
      // 密封家目录（CM-03 修复）：HOME（POSIX homedir）+ USERPROFILE（Windows）双覆盖 + OROSUS_HOME
      // 单一解析点直指 tmp 的 .orosus——此前只设 USERPROFILE，POSIX 上子进程读真实 ~/.orosus（往真实
      // sessions 漏会话文件、真实 provider 配置出向）；OROSUS_HOME 还挡掉外层环境已设的同名变量
      // （...process.env 展开不洗它）。HOME 同时封住 homedir() 系其余读点（如技能扫描 ~/.agents/skills）。
      const env = {
        ...process.env,
        USERPROFILE: join(d, "home"),
        HOME: join(d, "home"),
        OROSUS_HOME: join(d, "home", ".orosus"),
        MOCK_PORT: "8765",
      } as Record<string, string>;
      const { orosusHome } = await import("@orosus/contracts/home");
      expect(orosusHome(env)).toBe(join(d, "home", ".orosus")); // 密封钉：子进程数据目录解析进 tmp（夹具漏 HOME 时 POSIX 上读真实家，此处变红）
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

describe("/tasks 选中行 → 条目反查（CM-02 回归钉——rows 亲缘重排后显示行下标 ≠ 名册位次）", () => {
  it("孙代理最新时选中任意行，落到的是选中那行自己的条目（旧实现 entries[idx] 在此名册上选 A 执行 B）", async () => {
    // 机制钉（openTasks 是 main.ts 装配内件无独立缝——与 Esc 契约同记录方式）：钉死其选中解析依赖的
    // 语义面——taskIdOfRow(tasksListRows(entries)[i]) 必须指认该行渲染的那条，供 openTasks 按 id 回查
    const { sortNewestFirst, tasksListRows, taskIdOfRow } = await import("./tasks-cmd.ts");
    const T = (over: Partial<SubagentRosterEntry>): SubagentRosterEntry => ({
      id: "1111aaaa", depth: 1, label: "父代理一", status: "running", background: false, turns: 2, enqueuedAt: "t",
      ...over,
    } as SubagentRosterEntry);
    // 名册：父一（最早）+ 后台父二 + 孙（父一的娃，最新）——含后台子代理（背景标注进行文案）
    const entries = sortNewestFirst([
      T({ id: "1111aaaa", label: "父代理一", enqueuedAt: "2026-09-27T10:00:00Z" }),
      T({ id: "2222bbbb", label: "后台调研", background: true, enqueuedAt: "2026-09-27T11:00:00Z" }),
      T({ id: "3333cccc", depth: 2, parentId: "1111aaaa", label: "孙查日志", turns: 1, enqueuedAt: "2026-09-27T12:00:00Z" }),
    ]);
    expect(entries.map((e) => e.id)).toEqual(["3333cccc", "2222bbbb", "1111aaaa"]); // 时间序：孙最新在最上
    const rows = tasksListRows(entries).map(stripAnsi);
    expect(rows).toEqual([
      "[子代理] 2222bbbb 后台调研 · 运行中 · 后台",
      "[子代理] 1111aaaa 父代理一 · 运行中",
      "[孙代理] 1111aaaa - 3333cccc 孙查日志 · 运行中",
    ]); // 显示序：孙行紧跟父行——与 entries 位次整体错开（错位前提实锤：旧实现 entries[0] 是孙，第 0 行却是后台调研）
    expect(taskIdOfRow(rows[0]!)).toBe("2222bbbb"); // 选中的第 0 行 → 后台调研的编号（不是位次 0 的孙）
    for (const row of rows) {
      const id = taskIdOfRow(row);
      expect(id).toBeDefined();
      const entry = entries.find((e) => e.id === id)!;
      expect(row).toContain(entry.label); // 行 → 编号 → 条目往返自洽：每一行指认的都是自己渲染的那条
    }
  });
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

describe("CLI 顶层错误面与 --print 收尾（CM-04/05/06 回归钉——2026-09-28 code review）", () => {
  // 密封家目录（CM-03 修复同款三变量覆盖）：子进程数据目录解析进 tmp
  const sealedEnv = (d: string): Record<string, string> => ({
    ...process.env,
    USERPROFILE: join(d, "home"),
    HOME: join(d, "home"),
    OROSUS_HOME: join(d, "home", ".orosus"),
  }) as Record<string, string>;
  const runCli = (d: string, cliArgs: string[]): { child: ReturnType<typeof spawn>; done: Promise<{ code: number; out: string; err: string }> } => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot(), "apps/cli/src/main.ts"), ...cliArgs], {
      cwd: d, env: sealedEnv(d), stdio: ["pipe", "pipe", "pipe"],
    });
    let out = ""; let err = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.stderr.on("data", (c) => { err += String(c); });
    child.stdin.end();
    const done = new Promise<{ code: number; out: string; err: string }>((resolve) => {
      child.on("exit", (c) => resolve({ code: c ?? -1, out, err }));
    });
    return { child, done };
  };

  it("CM-05：未知 flag → 人话错误 + 用法 + 退出码 2（不再穿透模块求值打印 Node 裸堆栈）", async () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-cm05-"));
    try {
      const { done } = runCli(d, ["--bogus-flag"]);
      const r = await done;
      expect(r.code).toBe(2);
      expect(r.err).toContain("未知参数 --bogus-flag");
      expect(r.err).toContain("用法"); // message 携带 USAGE（args.ts throw 原文）
      expect(`${r.out}${r.err}`).not.toMatch(/^\s+at\s/m); // 无 Node 堆栈帧
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);

  it("CM-06：`provider list` 遇坏 TOML → 人话 + 退出码 1（readConfig 抛错不再裸堆栈穿透子命令分发）", async () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-cm06-"));
    try {
      mkdirSync(join(d, "home", ".orosus"), { recursive: true });
      writeFileSync(join(d, "home", ".orosus", "config.toml"), 'model = "unterminated\n', "utf8");
      const { done } = runCli(d, ["provider", "list"]);
      const r = await done;
      expect(r.code).toBe(1);
      expect(r.err).toContain("子命令失败"); // CM-06① 兜底文案
      expect(`${r.out}${r.err}`).not.toMatch(/^\s+at\s/m);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);

  it("CM-04：--print 坏端点 → turn error 空正文 + 退出码 1（脚本消费方可分辨失败，不再静默 exit 0）", async () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-cm04-"));
    try {
      mkdirSync(join(d, "home", ".orosus"), { recursive: true });
      // mock 槽指向必然连接拒绝的端口：provider 网络错 → 适配器 finish{kind:error} → turn/end{kind:error}
      // → main 按 CM-04③ 置退出码 1（旧实现：空正文 + exit 0）
      writeFileSync(join(d, "home", ".orosus", "config.toml"), [
        'model = "mock/mock-1"',
        "[provider-custom.providers.mock]",
        'type = "openai"',
        'baseUrl = "http://127.0.0.1:1"',
        'apiKey = "mock-key"',
        "",
      ].join("\n"), "utf8");
      const { done } = runCli(d, ["--print", "打个招呼"]);
      const r = await done;
      expect(r.code).toBe(1);
      expect(`${r.out}${r.err}`).not.toMatch(/^\s+at\s/m); // 错误走 formatStartupError 人话面/带内收口，非裸堆栈
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);
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

describe("P3 批跨域收尾（2026-09-28 code review）——CS-05 / CT-02 / CM-15① 行为钉（管道 REPL e2e）", () => {
  // 密封家目录（CM-03 三变量覆盖同款）：子进程数据目录解析进 tmp；交互行经行队列逐条消费（顺序保证）
  const sealedEnv = (d: string): Record<string, string> => ({
    ...process.env,
    USERPROFILE: join(d, "home"),
    HOME: join(d, "home"),
    OROSUS_HOME: join(d, "home", ".orosus"),
  }) as Record<string, string>;
  const runRepl = (d: string, lines: string[], config?: string): Promise<{ code: number; out: string; err: string }> => {
    if (config !== undefined) {
      mkdirSync(join(d, "home", ".orosus"), { recursive: true });
      writeFileSync(join(d, "home", ".orosus", "config.toml"), config, "utf8");
    }
    const child = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot(), "apps/cli/src/main.ts")], {
      cwd: d, env: sealedEnv(d), stdio: ["pipe", "pipe", "pipe"],
    });
    let out = ""; let err = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.stderr.on("data", (c) => { err += String(c); });
    child.stdin.write(lines.map((l) => `${l}\n`).join("")); // 单块写入：全部行先进待处理队列（命令逐条串行消费）
    child.stdin.end();
    return new Promise((resolve) => { child.on("exit", (c) => resolve({ code: c ?? -1, out, err })); });
  };

  it("MCP 管理口退役钉（2026-09-30 用户口令去掉 /mcp 斜杠命令）：敲 /mcp 不再是命令（未知命令面）；管理走 /settings", async () => {
    const d = tmp("mcp-retire");
    try {
      const r = await runRepl(d, ["/mcp", "/quit"]);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("共 5 个 MCP server"); // 不再有命令输出（列表在 /settings → MCP）
      expect(r.out).toContain("未知命令"); // 路由不再命中——未知命令反馈
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

  it("CS-05①：/new 换会话后立即 /fork——不再把上一会话的事件 id 当分叉点（残留即「fork 分叉点不在父会话投影内」崩进程）", async () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-cs05a-"));
    try {
      // /title 落 label 事件（lastEventId 被喂）→ /new（新会话零事件）→ /fork：atEntryId 必须已重置为
      // undefined（fork 走父投影尾缺省）；旧实现携带 s1 的 label 事件 id → ForkedSessionStore.all() 在
      // createSession 内 throw（session 域 CS-05 把投影外 atEntryId 从宽容降级改为 throw）→ 行模式
      // processReplLine 拦截区外无 catch → 进程崩（exit 1 + 栈）
      const r = await runRepl(d, ["/title 甲", "/new", "/fork", "/quit"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("[新会话");
      expect(r.out).toContain("[已从"); // /fork 成功（分叉自 /new 换出的新会话）
      expect(`${r.out}${r.err}`).not.toContain("fork 分叉点不在父会话投影内");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 45_000);

  it("CS-05②：/resume 切回旧会话（switchTo）后立即 /fork——lastEventId 重置，不携带他会话事件 id", async () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-cs05b-"));
    try {
      // s1 命名「甲」→ /new 出 s2 命名「乙」（lastEventId 被喂成 s2 的 label 事件）→ /resume 2 切回 s1
      // （列表创建时间倒序：s2 最新 #1、s1 #2——恢复标题「甲」断言锚定切的就是 s1）→ /fork：分叉点
      // 必须走 s1 投影尾；旧实现 lastEventId 仍是 s2 的事件 id，∉ s1 投影 → 同 CS-05① 崩溃面
      const r = await runRepl(d, ["/title 甲", "/new", "/title 乙", "/resume 2", "/fork", "/quit"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("[已命名 → 甲]");
      // 恢复横幅已退役（2026-09-30 拍板：恢复零提示只回放）——锚改走 sid：/resume 2 应切到「甲」（s1），
      // 随后 /fork 的父必须是 s1 而非 /new 打出的 s2（乙）。父若错拿 s2 的尾事件 id，则 s2 id ∉ s1 投影
      // → CS-05 崩溃面（下方 not.toContain 钉）——两会话池里「父 ≠ s2」即唯一锚定「父 = s1 = 甲」
      const newSid = /\[新会话 (s_[0-9A-Za-z]+)\]/.exec(r.out)?.[1];
      const forkParent = /\[已从 (s_[0-9A-Za-z]+) 分叉/.exec(r.out)?.[1];
      expect(newSid).toBeDefined();
      expect(forkParent).toBeDefined();
      expect(forkParent).not.toBe(newSid);
      expect(r.out).toContain("[已从"); // switchTo 后 /fork 成功
      expect(`${r.out}${r.err}`).not.toContain("fork 分叉点不在父会话投影内");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 45_000);

  it("空会话清理批（2026-10-01 拍板③+②）：空会话 /new 不换 sid 就地刷新；退出漏斗清 0 消息壳", async () => {
    const d = tmp("empty-new");
    try {
      // /yolo 落 approval/policy 事件 = 物化 0 消息壳（与 MCP manifest 壳同判定面）；/new 应复用本会话
      // 不另起（旧实现：旧壳留尸 + 新壳又生）；/quit 退出漏斗把最后的空会话整目录清掉
      const r = await runRepl(d, ["/yolo", "/new", "/quit"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("[已是空会话——沿用本会话"); // 复用分支命中
      expect(r.out).not.toMatch(/\[新会话 s_[0-9A-Za-z]+\]/); // 不再另起新会话
      const sessRoot = join(d, "home", ".orosus", "sessions");
      const sids = existsSync(sessRoot) ? readdirSync(sessRoot).flatMap((b) => readdirSync(join(sessRoot, b))) : [];
      expect(sids).toEqual([]); // 退出漏斗已清——桶内零会话目录
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 45_000);

  it("CM-15① + CT-02：/HELP 大写命令归一命中 CLI 层拦截；/context 上下文用量模型段按首斜杠切分（嵌套 id 不丢前缀）", async () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-ct02-"));
    try {
      // model = prov/m/n（嵌套模型 id）：/context 面模型行 = 首个 "/" 后整体 "m/n"（CT-02 新口径，与
      // contracts 一致）；旧 split("/").pop() 只剩 "n"。/HELP：cmdNameOf 归一（小写 + 斜杠后空格抹除）
      // 命中 CLI 层带快捷键的 HELP_TEXT；旧精确等值漏到 core 简版 /help（无「快捷键（全屏）」节）
      const cfg = [
        'model = "prov/m/n"',
        "",
        "[provider-custom.providers.prov]",
        'type = "openai"',
        'baseUrl = "http://127.0.0.1:1"',
        'defaultModel = "m/n"',
        "",
      ].join("\n");
      const r = await runRepl(d, ["/HELP", "/settings", "2", "/quit"], cfg);
      expect(r.code).toBe(0);
      expect(r.out).toContain("快捷键（全屏）"); // CM-15①：大写 /HELP 命中 CLI 层说明版（core 简版无此节）
      const modelLine = r.out.split("\n").find((l) => l.startsWith("模型"));
      expect(modelLine).toBeDefined();
      expect(modelLine!.endsWith("m/n")).toBe(true); // CT-02：模型段 = 首斜杠后整体（旧实现只剩 "n"）
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 45_000);
});

describe("P3 批跨域收尾——CM-16② / CM-19③ 源面钉（main.ts 内件无独立缝且渲染面行模式不可达）", () => {
  // PROVIDER_WRITE_DONE 是 processReplLine 内联门——无法经 import/子进程观测（与 CM-02 机制钉同困境，
  // 但无外部语义面可钉），退而钉源面：关键形态复发（前缀正则内联）即红。
  // CM-16② m5-split-main T3 升格：shortenPath 已搬 usage-text.ts 可 import——行为直钉两档模板 +
  // 源面旧形钉（硬编码分隔符复发即红）双保险；测试数 1→1 不变。
  const src = readFileSync(join(repoRoot(), "apps", "cli", "src", "main.ts"), "utf8");

  it("CM-16②：shortenPath 两档模板 + join 全走 path.sep——旧硬编码模板复发即红（Windows 输出不变，POSIX 修正）", () => {
    const utSrc = readFileSync(join(repoRoot(), "apps", "cli", "src", "usage-text.ts"), "utf8");
    const seg = utSrc.slice(utSrc.indexOf("const shortenPath"), utSrc.indexOf("const lastUsageOf"));
    expect(seg).toContain("join(sep)");
    expect(seg).toContain(`parts[0] + sep + "…" + sep + tail`);
    expect(seg).toContain(`"…" + sep + tail`);
    // 旧形逐字钉（split(/[\\/]/ 的合法双反斜杠不含在内）：join("\\") / "…\\" / "\\…\\" 复发即红
    expect(seg).not.toContain('join("\\\\")');
    expect(seg).not.toContain('"…\\\\"');
    expect(seg).not.toContain('"\\\\…\\\\"');
    // 行为直钉（升格新增——三档压缩形逐档验；路径以 sep 组装跨平台成立）
    expect(shortenPath(homeDir(), 4)).toBe("~"); // 档一：家目录本体 → ~
    expect(shortenPath(homeDir() + sep + "proj", 100)).toBe("~" + sep + "proj"); // 档一：家前缀替换
    const deep = ["A:", "bbbb", "cccc", "dddd", "eeee"].join(sep); // 5 段深路径（>3 触发档三）
    expect(shortenPath(deep, deep.length)).toBe(deep); // 档二：塞得下直出
    expect(shortenPath(deep, 16)).toBe(["A:", "…", "dddd", "eeee"].join(sep)); // 档三：头+…+尾两段
    expect(shortenPath(deep, 12)).toBe(["…", "dddd", "eeee"].join(sep)); // 档四：只留尾两段
  });

  it("CM-19③：/provider 重载门的前缀正则单点常量化——内联回归即红", () => {
    expect(src).toContain("const PROVIDER_WRITE_DONE = /^(?:success|已设为当前默认|已移除)/"); // 定义带清单（来源注释同点）
    expect(src).toContain("PROVIDER_WRITE_DONE.test(cmdOut"); // 消费走常量
    expect((src.match(/\^\(\?:success\|已设为当前默认\|已移除\)/g) ?? []).length).toBe(1); // 正则字面量只此一处——内联 = 二处即红
  });
});

describe("输入召回旁注写侧（2026-10-03 拍板「↑ 召回 = 我输入的内容」——重开会话后技能正文整条被召回 bug）：@ 展开体原话随 user/message 落盘（管道 e2e）+ 接线源面钉", () => {

  it("e2e：提交「看看 @a.txt」→ session.jsonl 里 user/message（展开体）紧随 host/input-echo（输入框原文）——重开播种据此还原原话", async () => {
    const d = tmp("inputecho"); // 模块级 tmp：置 dir 供 afterEach 清理（mkdtempSync 裸用会让过滤跑炸 afterEach）
    try {
      writeFileSync(join(d, "a.txt"), "内容甲\n", "utf8"); // @ 引用展开源（resolveAtRefs 按子进程 cwd=d 解析）
      // 假 provider（端点不可达——turn 单次快速失败属预期；消息闸门 needsProviderSetup 只看配置在不在，
      // user/message 与旁注先于 turn 落盘即为本钉目标，重试批未落地无退避拖尾）
      mkdirSync(join(d, "home", ".orosus"), { recursive: true });
      writeFileSync(join(d, "home", ".orosus", "config.toml"), [
        'model = "deadprov/dm-1"',
        "",
        "[provider-custom.providers.deadprov]",
        'type = "openai"',
        'baseUrl = "http://127.0.0.1:9/v1"',
        'apiKey = "sk-test"',
        'defaultModel = "dm-1"',
        "",
      ].join("\n"), "utf8");
      const child = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot(), "apps/cli/src/main.ts")], {
        // 密封家目录三变量内联（P3 批同款；不再抽助手——第三份拷贝会多一条 consistent-function-scoping 基线外警告）
        cwd: d,
        env: { ...process.env, USERPROFILE: join(d, "home"), HOME: join(d, "home"), OROSUS_HOME: join(d, "home", ".orosus") } as Record<string, string>,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = ""; let err = "";
      child.stdout.on("data", (c) => { out += String(c); });
      child.stderr.on("data", (c) => { err += String(c); });
      child.stdin.write("看看 @a.txt\n/quit\n");
      child.stdin.end();
      const code = await new Promise<number>((resolve) => { child.on("exit", (c) => resolve(c ?? -1)); });
      expect(code).toBe(0); // 消息 turn 无 provider 报模型错误属正常路径，不炸进程（旁注先于 turn 落盘）
      // 找会话文件（sessions/<桶>/<sid>/session.jsonl）
      const sessRoot = join(d, "home", ".orosus", "sessions");
      const jsonls = readdirSync(sessRoot, { recursive: true }).map(String).filter((p) => p.endsWith("session.jsonl"));
      expect(jsonls.length).toBeGreaterThanOrEqual(1);
      const lines = readFileSync(join(sessRoot, jsonls[0]!), "utf8").split("\n").filter((l) => l !== "");
      const iU = lines.findIndex((l) => l.includes('"user/message"'));
      expect(iU).toBeGreaterThanOrEqual(0);
      const u = JSON.parse(lines[iU]!) as { content: { kind: string; text: string }[] };
      expect(u.content[0]!.text).toContain("[@a.txt]"); // 发出体 = 原文（引用已删）+ 附件展开
      const echo = JSON.parse(lines[iU + 1]!) as { type: string; text: string };
      expect(echo.type).toBe("host/input-echo"); // 旁注原子紧随 user/message
      expect(echo.text).toBe("看看 @a.txt"); // 旁注 = 输入框原文（↑ 召回口径；不进上下文/渲染面由 harness ⑨b 与 docmodel 未知类型跳过保证）
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

  it("接线源面钉（processReplLine 无独立缝——CM-16② 同困境退而钉源面）：技能递归穿原话 + 发出≠原话才落旁注 + 播种收口纯函数", () => {
    tmp("inputecho-pin"); // 置模块级 dir——afterEach rmSync 需要（本测自建目录仅作清理锚）
    const src = readFileSync(join(repoRoot(), "apps", "cli", "src", "main.ts"), "utf8");
    expect(src).toContain("out, text); // typed=原话——合成体不带原话"); // 技能递归 typed=输入框原文
    expect(src).toContain("if (withAt !== typedText) afterNotes.push({ type: INPUT_ECHO_EVENT"); // 判据：发出体 ≠ 原话
    expect(src).toContain("app.seedHistory(isSwitching ? [] : inputHistoryFor(activeDirRef(), h.sessionId, await h.history()))"); // 播种走 session-io（T13 sidecar 优先、老会话降级；T4 切换期跳过、注水完成补挂）
  });
});

describe("T4b m5-resume-perf: 全屏切会话就地换页（不退出 FullApp——闪空根因拆除）", () => {
	it("接线源面钉（CM-16② 同困境退而钉源面）：runSubmit 拦截 pendingSwitchSid → switchInPlace 原子换 dm（不设 action=switch 退出）", () => {
		tmp("t4b-pin");
		const src = readFileSync(join(repoRoot(), "apps", "cli", "src", "main.ts"), "utf8");
		expect(src).toContain('if (r === "switch" && (pendingSwitchSid !== undefined || pendingForkIntent !== undefined))'); // 拦截判据（resume/sessions 切换与 fork 分叉）
		expect(src).toContain("switchInPlace(sid);"); // 就地换页（无 action 退出）
		expect(src).toContain("dm = next;"); // 原子换行源（io.docTotal/docWindow 现读模块级 dm）
		expect(src).toContain("app.sessionSwapped();"); // 懒分页到头态重置
	});

	it("D14 ② 接线钉：/sessions 列表时机后台全库补建事件索引（void 不挡界面）", () => {
		const src = readFileSync(join(repoRoot(), "apps", "cli", "src", "main.ts"), "utf8");
		expect(src).toContain("void refreshEventIndex(defaultEventIndexFile(), sessionsRoot);"); // 列表时机后台补建
	});

	it("fork 快径钉：full 模式 /fork 登记意图即返回（重活 forkInPlace 异步走）+ 拦截分派", () => {
		const src = readFileSync(join(repoRoot(), "apps", "cli", "src", "main.ts"), "utf8");
		expect(src).toContain('if (directive.kind === "fork" && tuiMode === "full") {'); // 快径判据
		expect(src).toContain("pendingForkIntent = {"); // 意图登记
		expect(src).toContain("forkInPlace(forkIntent!);"); // 拦截分派
	});
});

/** 密封家目录（P3 批同款；模块层唯一名——describe 内副本会触发 consistent-function-scoping）：子进程数据目录解析进 tmp。 */
const btwSealedEnv = (d: string): Record<string, string> => ({
	...process.env,
	USERPROFILE: join(d, "home"),
	HOME: join(d, "home"),
	OROSUS_HOME: join(d, "home", ".orosus"),
}) as Record<string, string>;
const btwRunRepl = (d: string, lines: string[]): Promise<{ code: number; out: string; err: string }> => {
	const child = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot(), "apps/cli/src/main.ts")], {
		cwd: d, env: btwSealedEnv(d), stdio: ["pipe", "pipe", "pipe"],
	});
	let out = ""; let err = "";
	child.stdout.on("data", (c) => { out += String(c); });
	child.stderr.on("data", (c) => { err += String(c); });
	child.stdin.write(lines.map((l) => `${l}\n`).join("")); // 单块写入：全部行先进待处理队列（命令逐条串行消费）
	child.stdin.end();
	return new Promise((resolve) => { child.on("exit", (c) => resolve({ code: c ?? -1, out, err })); });
};
/** 桩 FullApp（btw-cmd.test 同款；模块层唯一名同因）：捕获 viewText 调用。 */
const btwStubApp = (): { app: import("./tui/fullapp.ts").FullApp; calls: { title: string; opts: { live?: () => string } }[] } => {
	const calls: { title: string; opts: { live?: () => string } }[] = [];
	const app = {
		viewText: (title: string, _text: string, opts: { live?: () => string }) => { calls.push({ title, opts }); },
		pickRowWidth: () => 60,
	} as unknown as import("./tui/fullapp.ts").FullApp;
	return { app, calls };
};
/** 闸门流（btw-cmd.test 同款；模块层唯一名同因）：挂起直到 release——旧问在飞的时序缝。 */
const btwGateStream = (): { stream: () => AsyncIterable<Chunk>; release: (chunks: Chunk[]) => void } => {
	let release!: (chunks: Chunk[]) => void;
	const gate = new Promise<Chunk[]>((r) => { release = r; });
	return { stream: () => (async function* () { yield* await gate; })(), release };
};

describe("/btw 侧问命令接线（m5-btw T4）", () => {

	it("带参路由命中：/btw <问题> 不落「未知命令」、不弹用法提示（fire-and-forget 立即返回不挂路由）", async () => {
		const d = tmp("btw-arg");
		try {
			const r = await btwRunRepl(d, ["/btw 为什么这里用 unsafe", "/quit"]);
			expect(r.code).toBe(0);
			expect(r.out).not.toContain("未知命令"); // 宿主拦截命中——不漏到 core 路由
			expect(r.out).not.toContain("用法：/btw"); // 带参不开空态提示
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	}, 60_000);

	it("无参路由（D7 空态）：无记录 → 用法提示一行（toast 通道，不进流区不落盘）", async () => {
		const d = tmp("btw-noarg");
		try {
			const r = await btwRunRepl(d, ["/btw", "/quit"]);
			expect(r.code).toBe(0);
			expect(r.out).toContain("用法：/btw");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	}, 60_000);

	it("非 /btw 不误伤：/bt（前缀撞名）走未知命令面，不被 btw 分支吞", async () => {
		const d = tmp("btw-near");
		try {
			const r = await btwRunRepl(d, ["/bt", "/quit"]);
			expect(r.code).toBe(0);
			expect(r.out).toContain("未知命令"); // cmdNameOf 精确匹配——前缀不误伤
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	}, 60_000);

	it("接线源面钉（processReplLine 无独立缝——CM-16② 同困境退而钉源面）：BUSY_EXEC 即改档 + 拦截分支 + SLASH_ITEMS 菜单条目", () => {
		tmp("btw-pin"); // 置模块级 dir——afterEach rmSync 需要
		const src = readFileSync(join(repoRoot(), "apps", "cli", "src", "main.ts"), "utf8");
		const busyLine = src.split("\n").find((l) => l.includes("const BUSY_EXEC = new Set"));
		expect(busyLine).toBeDefined();
		expect(busyLine).toContain('"/btw"'); // busy 期立即执行、不占 inflight（侧问永不阻塞主输入）
		expect(src).toContain('if (cmdNameOf(text) === "/btw")'); // 拦截分支（try 内、/tasks 旁）
		expect(src).toContain("openBtw(activeApp, btwDeps, btwQuestion)"); // 带参走侧问本体（fire-and-forget）
		expect(src).toContain("reopenBtw(activeApp, btwDeps)"); // 无参回看（D7）
		expect(src).toContain('name: "/btw", desc: "侧问（不打断主对话）"'); // 菜单条目
	});
});

describe("/btw 边界与集成（m5-btw T5）", () => {
	it("连发两问：新问先中止旧在飞、第二窗照开（真 FullApp 下排队 FIFO）；负向——/tasks 名册与 <sid>/agents/ 目录均无 btw 痕迹", async () => {
		const d = tmp("btw-two");
		const h = await isolated();
		try {
			const { app, calls } = btwStubApp();
			const g1 = btwGateStream();
			const first = openBtw(app, { getH: () => h, llmStream: g1.stream }, "旧问题");
			const second = openBtw(app, {
				getH: () => h,
				llmStream: () => (async function* () { yield { type: "text/delta", text: "新答" }; yield { type: "finish", kind: "stop" }; })(),
			}, "新问题");
			g1.release([{ type: "finish", kind: "stop" }]); // 旧问流此刻才收流——signal 早已 aborted
			await first.done;
			await second.done;
			expect(calls).toHaveLength(2); // 两窗都开（pendingUi 单槽、第二窗排队——真 FullApp 下 FIFO 顶上）
			expect(first.slot).toMatchObject({ phase: "error", text: "已被新侧问取代" });
			expect(second.slot).toMatchObject({ phase: "answer", text: "新答" });
			expect(lastBtwArchive()).toEqual({ question: "新问题", text: "新答" }); // 归档只有新问
			// 负向断言收尾（v1.3b 注：附于连发两问例，不另立第四测）——D5/D6 临时性：零落盘零名册
			expect(h.subagents()).toEqual([]); // /tasks 名册零痕迹（btw 不是子代理）
			expect(existsSync(join(d, "sessions", h.sessionId, "agents"))).toBe(false); // <sid>/agents/ 目录零痕迹（子代理转录才建）
			const hist = JSON.stringify(await h.history());
			expect(hist).not.toContain("旧问题");
			expect(hist).not.toContain("新问题");
			expect(hist).not.toContain("新答"); // 会话事件零 btw 内容
		} finally {
			await h.close();
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("busy 共存：主 turn 在飞时侧问照答（不占 inflight/不碰 turn 状态），主 turn 完好收尾且历史零 btw 痕迹", async () => {
		const d = tmp("btw-busy");
		let releaseMain!: () => void;
		const mainGate = new Promise<void>((r) => { releaseMain = r; });
		const gateProv: ModuleDefinition = {
			name: "provider-gate", version: "0.1.0", description: "g", api: 1,
			activate(ctx) {
				ctx.provide("provider:gate" as never, () => (async function* () {
					await mainGate; // 主 turn 挂在闸门上——侧问期间「busy」为真
					yield { type: "text/delta", text: "主答" };
					yield { type: "finish", kind: "stop" };
				})());
			},
		};
		const h = await createHarness({
			cwd: d, builtinModules: BUILTIN_MODULES, modules: [gateProv],
			secretsFile: join(d, "s.env"), diagDir: join(d, "logs"), spillDir: join(d, "spill"),
			sessionsDir: join(d, "sessions"),
			discovery: { userDir: join(d, "m"), projectDir: join(d, "p"), trustFile: join(d, "t.json") },
			config: { userFile: join(d, "u.toml"), projectFile: join(d, "n.toml"), env: {}, cliOverrides: { model: "gate/m" } },
		});
		try {
			const mainTurn = h.prompt("主问题"); // busy 开始（provider 闸门未放）
			const outs: string[] = [];
			const btw = openBtw(undefined, {
				getH: () => h,
				out: (s) => outs.push(s),
				llmStream: () => (async function* () { yield { type: "text/delta", text: "侧答" }; yield { type: "finish", kind: "stop" }; })(),
			}, "busy 时问一句");
			await btw.done; // 主 turn 仍在飞（闸门未放）——侧问已答完 = 不占 inflight、不等待 busy
			expect(outs[0]).toContain("[侧问] 侧答"); // 行模式回显
			releaseMain(); // 放主 turn
			await mainTurn; // 主 turn 完好收尾——侧问没有碰它（未取消/未串流）
			const hist = JSON.stringify(await h.history());
			expect(hist).toContain("主答");
			expect(hist).not.toContain("侧答"); // D6：流区/会话事件零 btw 痕迹
			expect(hist).not.toContain("busy 时问一句");
		} finally {
			await h.close();
			rmSync(d, { recursive: true, force: true });
		}
	});
});
