/** web 批 T2 伴生测试：HostedSession 托管引擎 + HostPool + /web 退出交接 + SIGINT 优雅清退。
 * 按任务简报 ①-⑨ 编号逐条对应。真 harness 真跑 turn（@orosus/testing fake provider +
 * main.test.ts 的 gated provider 先例——手工可控的挂起/放行流）；close 序（presence dispose →
 * h.close → purgeIfEmpty）在 ④ 以注入式 fake harness 定断顺序（跨平台确定性：purge 若抢在
 * h.close 完成前跑，close 起止探针即见目录已消失）。
 * /web 交接（⑥⑦⑧）按 main.ts 退出序列逐句模拟——processReplLine 不可 import（main.ts import
 * 即执行，方案 G1 注记），本测试锁死交接契约：退出序 → runWebSubcommand(argv, io, handover)
 * → HostPool 状态；main.ts 侧另有子进程 e2e（行模式 /web → server 起服横幅）盖真实接线。
 * SIGINT ⑨ 与 T1 同口：shutdownWebServer("sigint")（SIGINT 钩子调的同一函数）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createHarness, encodeCwd, JsonlSessionStore, SESSION_LOCK_FILE, type Harness } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import type { CommandUi, ModuleDefinition } from "@orosus/contracts/module";
import type { Chunk, ProviderRequest, StreamFn } from "@orosus/contracts/provider";
import { BUILTIN_MODULES } from "../builtins.ts";
import { presence } from "../presence.ts";
import { runWebSubcommand, webHostPool } from "./mod.ts";
import { instanceFilePath, writeInstance } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";
import { HostedSession, purgeIfEmptyAt } from "./hosted.ts";
import { HostPool } from "./hostpool.ts";

const repoRoot = (): string => join(import.meta.dirname, "..", "..", "..", ".."); // web/ 子目录四级回仓根

/** 项目目录（cwd 隔离——项目层 config/modules 不串仓库自身 .orosus）。 */
const tmpCwd = (): string => mkdtempSync(join(tmpdir(), "orosus-web-t2-cwd-"));

/** 轮询等待（25ms 步进；超时抛错——异步里程碑用）。 */
const waitFor = async (pred: () => boolean, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor 超时");
};

/** 无头 CommandUi（core 缺省拒绝式同款——交互式命令 fail-closed，T5 WebCommandUi 接位前的事实形态）。 */
const headlessUi: CommandUi = {
  ask: async () => { throw new Error("无交互环境（headless）"); },
  askSecret: async () => { throw new Error("无交互环境（headless）"); },
  choose: async () => { throw new Error("无交互环境（headless）"); },
  confirm: async () => { throw new Error("无交互环境（headless）"); },
};

/** 引导门放行形态的 config.toml（T1 测试同款）。 */
const writeProviderConfig = (home: string): void => {
  writeFileSync(join(home, "config.toml"), 'model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "http://127.0.0.1:9"\n', "utf8");
};

/** 手工可控 provider（main.test.ts fakeProv 先例 + 挂起/放行闸门）：entered = 流已进入（turn 已起），
 *  release = 放行收尾；abort 后按带内 aborted 收尾（CT-05 同语义）。 */
const gatedProvider = (): { mod: ModuleDefinition; entered: Promise<void>; release: () => void } => {
  let resolveEnter!: () => void;
  const entered = new Promise<void>((r) => { resolveEnter = r; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const stream: StreamFn = (req: ProviderRequest) => (async function* () {
    resolveEnter();
    yield { type: "text/delta", text: "部分输出" } as Chunk;
    await gate;
    if (req.signal.aborted) {
      yield { type: "finish", kind: "aborted" } as Chunk;
      return;
    }
    yield { type: "finish", kind: "stop" } as Chunk;
  })();
  const mod: ModuleDefinition = {
    name: "provider-gated", version: "0.1.0", description: "gated", api: 1,
    activate(ctx) {
      ctx.provide("provider:gated" as never, stream);
    },
  };
  return { mod, entered, release };
};

/** 注入式 fake harness（④ 顺序断言用——HostedSession.harness 测试缝）。 */
const makeFakeHarness = (sid: string, over: Partial<Harness> = {}): { h: Harness; stop: () => void } => {
  let stopped = false;
  const idle = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const h: Harness = {
    sessionId: sid,
    prompt: async () => undefined,
    cancel: () => {},
    steer: () => false,
    events: () => (async function* () { await idle(); yield* []; })(),
    history: async () => [],
    ensureHistoryFull: async () => {},
    eventsBefore: async () => [],
    liveChunks: () => (async function* () { await idle(); yield* []; })(),
    usage: async () => ({ current: { input: 0, output: 0 } }),
    status: () => ({ model: "fake/x", overridden: false, sessionId: sid, modules: { active: 0, failed: 0, discovered: 0 } }),
    setLabel: async () => {},
    fork: async () => ({ sessionId: sid }),
    tree: async () => [],
    setModel: async () => {},
    configuredLanguage: () => undefined,
    setLanguage: async () => {},
    setEffort: () => {},
    subagents: () => [],
    answerSubagentApproval: () => false,
    stopAllSubagents: () => {},
    llm: () => { throw new Error("no llm"); },
    pendingConfirms: () => [],
    log: () => {},
    setModuleT: () => {},
    graph: () => ({ bus: { on: () => () => {} } }) as never,
    reload: async () => ({}) as never,
    close: async () => { stopped = true; },
    ...over,
  };
  return { h, stop: () => { stopped = true; } };
};

/** 种子空会话（header-only 文件，core JsonlSessionStore 真实落盘形态）。 */
const seedEmptySession = async (bucketDir: string, sid: string, cwd: string): Promise<void> => {
  const store = new JsonlSessionStore({ dir: bucketDir, sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 17, failed: 0, discovered: 0 } });
  await store.close();
};

/** 种子非空会话（header + user/message → firstUser 在场 = 非空壳）。 */
const seedLivedSession = async (bucketDir: string, sid: string, cwd: string): Promise<void> => {
  const store = new JsonlSessionStore({ dir: bucketDir, sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 17, failed: 0, discovered: 0 } });
  await store.append("user/message", { content: [{ kind: "text", text: "曾经聊过一轮" }] });
  await store.close();
};

describe("web T2：HostedSession 托管引擎 + HostPool + /web 交接", () => {
  const homes: string[] = [];
  const procs: ReturnType<typeof spawn>[] = [];
  let prevHome: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t2-"));
    homes.push(h);
    return h;
  };

  beforeEach(() => {
    // OROSUS_HOME 密封（main.test.ts 先例）：HostedSession 的 createHarness 缺省面（config/logs/
    // secrets/索引）与缺省 sessionsRoot 均经 orosusHome() 调用时现读 env——设在本进程即全密封
    prevHome = process.env["OROSUS_HOME"];
  });

  afterEach(() => {
    shutdownWebServer("test-cleanup"); // 幂等——失败用例兜底清退，防 SIGINT 挂钩与 server 泄漏到后续用例
    if (prevHome === undefined) delete process.env["OROSUS_HOME"];
    else process.env["OROSUS_HOME"] = prevHome;
    for (const p of procs.splice(0)) {
      try { p.kill(); } catch { /* 已退 */ }
    }
    while (homes.length > 0) {
      const h = homes.pop()!;
      try { rmSync(h, { recursive: true, force: true }); } catch { /* Windows 句柄迟到则留给系统 tmp 清理 */ }
    }
  });

  it("① fake provider 真跑一轮 turn：onEvent 收 user/assistant、onChunk 收增量、busy true→false、phase running→idle、live.json kind=web", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const hs = new HostedSession({
      cwd,
      commandUi: headlessUi,
      modules: [fakeProviderModule("fake", [[
        { type: "text/delta", text: "回答正文" },
        { type: "finish", kind: "stop" },
      ]])],
      config: { userFile: join(home, "config.toml"), projectFile: join(cwd, "no.toml"), env: {}, cliOverrides: { model: "fake/x" } },
    });
    await hs.ready;
    const types: string[] = [];
    const midTurn: { busy: boolean; phase: string }[] = [];
    hs.onEvent((e) => {
      types.push(e.type);
      if (e.type === "user/message") midTurn.push({ busy: hs.busy(), phase: hs.phase() });
    });
    const chunks: string[] = [];
    hs.onChunk((t) => chunks.push(t));

    const r = await hs.dispatch("你好");
    expect(r).toEqual({ ok: true });
    expect(types).toContain("user/message");
    expect(types).toContain("assistant/message");
    expect(chunks.join("")).toContain("回答正文");
    expect(midTurn[0]).toEqual({ busy: true, phase: "running" }); // turn 中段：busy + running
    expect(hs.busy()).toBe(false);
    expect(hs.phase()).toBe("idle");

    // live.json 落盘（presence 异步首写——轮询）：kind=web、sid 对齐
    const livePath = join(home, "sessions", hs.bucket, hs.sid, "live.json");
    await waitFor(() => existsSync(livePath));
    expect(JSON.parse(readFileSync(livePath, "utf8"))).toMatchObject({ kind: "web", sid: hs.sid });

    await hs.close();
  }, 30_000);

  it("② busy 期 dispatch → 入队 + onQueue 广播快照 + withdraw 撤回（撤回后 turn 结束不补跑）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const gated = gatedProvider();
    const hs = new HostedSession({
      cwd,
      commandUi: headlessUi,
      modules: [gated.mod],
      config: { userFile: join(home, "config.toml"), projectFile: join(cwd, "no.toml"), env: {}, cliOverrides: { model: "gated/x" } },
    });
    await hs.ready;
    const queueSnapshots: { index: number; text: string }[][] = [];
    hs.onQueue((items) => queueSnapshots.push(items.map((x) => ({ ...x }))));
    const userMsgs: string[] = [];
    hs.onEvent((e) => { if (e.type === "user/message") userMsgs.push(JSON.stringify((e as { content?: unknown }).content)); });

    const first = hs.dispatch("第一条");
    await gated.entered; // turn 已起（provider 流进入）
    expect(hs.busy()).toBe(true);

    const r2 = await hs.dispatch("排队消息");
    expect(r2).toEqual({ ok: true, queued: true, index: 0 });
    expect(queueSnapshots).toEqual([[{ index: 0, text: "排队消息" }]]); // 入队即广播整表快照

    expect(hs.withdraw(0)).toBe(true); // 撤回 → 广播空表
    expect(queueSnapshots).toEqual([[{ index: 0, text: "排队消息" }], []]);
    expect(hs.withdraw(0)).toBe(false); // 已撤再撤 = false

    gated.release();
    expect(await first).toEqual({ ok: true });
    expect(userMsgs).toHaveLength(1); // 撤回的消息不进会话（无第二条 user/message）
    await hs.close();
  }, 30_000);

  it("③ turn 错误（finish kind=error）→ phase error、busy false", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const hs = new HostedSession({
      cwd,
      commandUi: headlessUi,
      modules: [fakeProviderModule("fake", [[
        { type: "text/delta", text: "半截" },
        { type: "finish", kind: "error", errorMessage: "模拟失败" },
      ]])],
      config: { userFile: join(home, "config.toml"), projectFile: join(cwd, "no.toml"), env: {}, cliOverrides: { model: "fake/x" } },
    });
    await hs.ready;
    const r = await hs.dispatch("触发错误");
    expect(r.ok).toBe(true); // 错误带内收尾——prompt 正常返回（endKind=error 在事件面）
    expect(hs.busy()).toBe(false);
    expect(hs.phase()).toBe("error");
    await hs.close();
  }, 30_000);

  it("③补 相位结算兜底帧（2026-10-12 走查修——「消息完成仍显示工作中」根因）：turn/end 事件时点 busy() 仍 true（dispatching 占位未释——SSE 内联相位帧在该时点读出恒真的前提缺陷钉住）；done 结算后 onState 开火且末帧 busy false", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const hs = new HostedSession({
      cwd,
      commandUi: headlessUi,
      modules: [fakeProviderModule("fake", [[
        { type: "text/delta", text: "回答正文" },
        { type: "finish", kind: "stop" },
      ]])],
      config: { userFile: join(home, "config.toml"), projectFile: join(cwd, "no.toml"), env: {}, cliOverrides: { model: "fake/x" } },
    });
    await hs.ready;
    let busyAtTurnEnd: boolean | undefined;
    const statesFired: boolean[] = [];
    hs.onState(() => statesFired.push(hs.busy()));
    hs.onEvent((e) => { if (e.type === "turn/end") busyAtTurnEnd = hs.busy(); });

    const r = await hs.dispatch("你好");
    expect(r.ok).toBe(true);
    expect(busyAtTurnEnd).toBe(true); // 竞态前提：turn/end 扇出时点 dispatching 占位未释——内联帧此时读 busy 恒 true
    expect(statesFired.length).toBeGreaterThanOrEqual(1); // 结算后兜底帧开火（sse.ts onState → phase 帧归真）
    expect(statesFired[statesFired.length - 1]).toBe(false); // 末帧 busy=false——前端尾行据此落定「待命」
    await hs.close();
  }, 30_000);

  it("④ close 序 = presence dispose → h.close → purgeIfEmpty：purge 严格在 h.close 完成后（顺序探针）；空会话目录被清、活会话保留", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const bucket = join(home, "sessions", encodeCwd(cwd));

    // 空会话：header-only 种子 + 注入式 fake harness（close 起止探针看目录存否——purge 抢跑即红）
    await seedEmptySession(bucket, "s_empty_order", cwd);
    const emptyDir = join(bucket, "s_empty_order");
    const probe: string[] = [];
    const fake = makeFakeHarness("s_empty_order", {
      close: async () => {
        probe.push(existsSync(emptyDir) ? "dir@close-start" : "gone@close-start");
        await new Promise((r) => setTimeout(r, 15));
        probe.push(existsSync(emptyDir) ? "dir@close-end" : "gone@close-end");
      },
    });
    const hsEmpty = new HostedSession({ cwd, sid: "s_empty_order", commandUi: headlessUi, harness: fake.h });
    await hsEmpty.ready;
    await hsEmpty.close();
    fake.stop();
    expect(probe).toEqual(["dir@close-start", "dir@close-end"]); // close 全程目录在 = purge 未抢在 h.close 前/中
    expect(existsSync(emptyDir)).toBe(false); // close 完成后才清——空会话目录不留

    // 活会话：header + user/message（firstUser 在场）→ close 后保留
    await seedLivedSession(bucket, "s_lived_keep", cwd);
    const livedDir = join(bucket, "s_lived_keep");
    const fake2 = makeFakeHarness("s_lived_keep");
    const hsLived = new HostedSession({ cwd, sid: "s_lived_keep", commandUi: headlessUi, harness: fake2.h });
    await hsLived.ready;
    await hsLived.close();
    fake2.stop();
    expect(existsSync(livedDir)).toBe(true); // 活会话保留
  }, 30_000);

  it("⑤ 撞锁：预置 session.lock 活 pid（他进程）→ dispatch 返回 {ok:false, holder}，不进 prompt", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const bucket = join(home, "sessions", encodeCwd(cwd));
    await seedEmptySession(bucket, "s_locked", cwd);

    // 活锁持有者：真起一个驻留子进程拿活 pid（测试进程自身的 pid 会被 selfPid 排除）
    const holderProc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    procs.push(holderProc);
    await new Promise((r) => setTimeout(r, 100)); // 等子进程真正起表
    mkdirSync(join(bucket, "s_locked", "agents"), { recursive: true });
    writeFileSync(join(bucket, "s_locked", "agents", SESSION_LOCK_FILE), `${holderProc.pid}\n2026-10-11T00:00:00.000Z\n占用方标题\n`, "utf8");

    const hs = new HostedSession({ cwd, resumeSid: "s_locked", commandUi: headlessUi });
    await hs.ready;
    const r = await hs.dispatch("会被拒的消息");
    expect(r.ok).toBe(false);
    expect(r.holder).toEqual({ pid: holderProc.pid, since: "2026-10-11T00:00:00.000Z", label: "占用方标题" });
    await hs.close();
  }, 30_000);

  it("⑥ /web 交接：TUI 会话跑一轮后（busy 时先 cancel → turn/end interrupted）退出序列 → runWebSubcommand(handover) → pool 含该会话且 current() 指向它", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home); // 过 G16 引导门
    const cwd = tmpCwd();
    const root = join(home, "sessions");
    const bucket = join(root, encodeCwd(cwd));

    // TUI 会话装配（main.ts createSession 同形——含 gated provider 挂起流）
    const gated = gatedProvider();
    const h = await createHarness({
      cwd,
      builtinModules: BUILTIN_MODULES,
      modules: [gated.mod],
      commandUi: headlessUi,
      sessionsDir: bucket,
      sessionsRoot: root,
      config: { userFile: join(home, "config.toml"), projectFile: join(cwd, "no.toml"), env: {}, cliOverrides: { model: "gated/x" } },
    });
    const seen: { type: string; kind?: unknown }[] = [];
    const tuiPump = (async () => { for await (const e of h.events()) seen.push({ type: e.type, ...(e.type === "turn/end" ? { kind: (e as { kind?: unknown }).kind } : {}) }); })();
    presence.attach({ h, sessionsDir: bucket, sid: h.sessionId, kind: "line" }); // TUI 心跳挂起（main.ts 同缝）

    const sid = h.sessionId;
    // busy 期 /web（G14）：先 h.cancel()（与 /quit 族同款）
    const turnP = h.prompt("正在回答的问题");
    await gated.entered;
    h.cancel();
    await turnP.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50)); // 让 turn/end 事件泵完
    expect(seen.some((e) => e.type === "turn/end" && e.kind === "interrupted")).toBe(true);

    // 退出序列（main.ts finally 同序：presence dispose → h.close → purgeIfEmpty）
    presence.dispose();
    await h.close();
    purgeIfEmptyAt(root, sid);
    await tuiPump;
    expect(existsSync(join(bucket, sid))).toBe(true); // 非空会话保留——交接目标在盘

    // 形态衔接：runWebSubcommand(argv, io, handover)——server 起后 pool 承接
    const lines: string[] = [];
    const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
    await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
    const pool = webHostPool();
    expect(pool).toBeDefined();
    expect(pool!.host(sid)).toBeDefined(); // HostPool 含该会话
    expect(pool!.current()?.sid).toBe(sid); // current() 指向交接会话——浏览器 bootstrap 默认打开它（/api/bootstrap currentSid，T9 消费）
    await waitFor(() => existsSync(join(bucket, sid, "live.json"))); // 托管侧心跳已挂（kind=web）
    expect(JSON.parse(readFileSync(join(bucket, sid, "live.json"), "utf8"))).toMatchObject({ kind: "web", sid });

    shutdownWebServer("test");
    expect(await run).toBe(0);
    await waitFor(() => webHostPool()?.host(sid) === undefined); // 清退序 closeAll
  }, 60_000);

  it("⑦ 空会话 /web：purge 发生（目录被清）→ 交接跳过（sid 失效不传/传了也被守卫拦下）→ server 空启（pool 空、current 无）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    const root = join(home, "sessions");
    const bucket = join(root, encodeCwd(cwd));

    // TUI 侧空会话：header-only 种子（0 消息）→ 打开即退（/web 退出序列）
    await seedEmptySession(bucket, "s_empty_handover", cwd);
    const h = await createHarness({
      cwd,
      builtinModules: BUILTIN_MODULES,
      commandUi: headlessUi,
      sessionsDir: bucket,
      sessionsRoot: root,
      resume: { sessionId: "s_empty_handover" },
      config: { userFile: join(home, "config.toml"), projectFile: join(cwd, "no.toml"), env: {} },
    });
    presence.attach({ h, sessionsDir: bucket, sid: h.sessionId, kind: "line" });
    presence.dispose();
    await h.close();
    purgeIfEmptyAt(root, h.sessionId); // 退出序列收尾（main.ts finally 同序）
    expect(existsSync(join(bucket, "s_empty_handover"))).toBe(false); // purge 发生——空会话目录被清

    // 形态衔接：sid 已失效——main.ts 侧判 locate 失败不传；此处故意仍传（双保险守卫也得拦下）
    const lines: string[] = [];
    const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: "s_empty_handover", cwd });
    await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
    const pool = webHostPool();
    expect(pool).toBeDefined();
    expect(pool!.current()).toBeUndefined(); // 空启——无当前会话
    expect(pool!.host("s_empty_handover")).toBeUndefined(); // 交接被跳过（未建幽灵会话）
    shutdownWebServer("test");
    expect(await run).toBe(0);
  }, 60_000);

  it("⑧ 已有活实例（T1 ④ 场景）：退出序列后不起第二个 server，打印既有 URL，exit 0（handover 同口径）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const fakeToken = "c".repeat(64);
    const fake = createHttpServer((req, res) => {
      if (req.url === "/api/health" && req.headers["x-orosus-token"] === fakeToken) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      }
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
    const fakePort = (fake.address() as AddressInfo).port;
    writeInstance(home, { v: 1, pid: process.pid, port: fakePort, startedAt: Date.now(), token: fakeToken });

    const lines: string[] = [];
    const code = await runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: "s_any", cwd: tmpCwd() });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(`http://127.0.0.1:${fakePort}`); // 打印既有 URL
    expect(webHostPool()).toBeUndefined(); // 未起第二个 server——无 pool
    fake.close();
    fake.closeAllConnections?.();
  }, 30_000);

  it("⑨ SIGINT 清退：SSE 客户端收到 shutdown 帧（reason=sigint）、pool 内 HostedSession 全部 close、实例文件删除", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    const bucket = join(home, "sessions", encodeCwd(cwd));
    await seedEmptySession(bucket, "s_sigint", cwd);

    const lines: string[] = [];
    const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: "s_sigint", cwd });
    await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
    const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
    expect(webHostPool()?.host("s_sigint")).toBeDefined();

    // SSE 客户端连流（§3 端点形态；T2 最小面：首帧组 + shutdown 帧）
    const received: string[] = [];
    const ended = new Promise<void>((resolve) => {
      const req = httpRequest({
        host: "127.0.0.1", port: inst.port, path: "/api/sessions/s_sigint/stream",
        headers: { "x-orosus-token": inst.token },
      }, (res) => {
        res.on("data", (c) => { received.push(String(c)); });
        res.on("end", () => resolve());
      });
      req.on("error", () => resolve());
      req.end();
    });
    await waitFor(() => received.some((s) => s.includes(": connected")));

    // 触发 SIGINT 处理器同口（armShutdown 注册的 once("SIGINT") → shutdownWebServer("sigint")）
    shutdownWebServer("sigint");
    await ended;
    const stream = received.join("");
    expect(stream).toContain("retry: 3000");           // 首帧组（防中间层掐零字节空闲流）
    expect(stream).toContain("event: shutdown");       // shutdown 帧先于连接拆除断流
    expect(stream).toContain(`data: {"reason":"sigint"}`);

    await waitFor(() => webHostPool()?.host("s_sigint") === undefined); // pool 内会话全部 close（closeAll）
    expect(existsSync(join(bucket, "s_sigint"))).toBe(false); // close 序 purge-if-empty 生效（空会话被清）
    expect(existsSync(instanceFilePath(home))).toBe(false);  // 实例文件删除（T1 清退序）
    expect(await run).toBe(0);
  }, 60_000);

  it("viewer：只读 resume 不落 live.json、dispatch 拒绝；LRU 8 逐出即 close（超容后最早 viewer 关停）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const bucket = join(home, "sessions", encodeCwd(cwd));
    for (let i = 0; i < 9; i++) await seedEmptySession(bucket, `s_viewer_${i}`, cwd);
    const pool = new HostPool({ home });

    const v0 = await pool.viewer("s_viewer_0");
    expect(v0.sid).toBe("s_viewer_0");
    expect(v0.busy()).toBe(false);
    await new Promise((r) => setTimeout(r, 100)); // 若误挂 presence，live.json 首写早到了
    expect(existsSync(join(bucket, "s_viewer_0", "live.json"))).toBe(false); // 只读不开心跳（无 presence）
    const denied = await v0.dispatch("只读会话不许发");
    expect(denied.ok).toBe(false); // 不发 prompt

    for (let i = 1; i <= 8; i++) await pool.viewer(`s_viewer_${i}`); // 容量 8——v0 被逐出
    const after = await v0.dispatch("再试");
    expect(after.ok).toBe(false);
    expect(after.error).toContain("已关闭"); // 逐出即 close——被关会话拒绝
  }, 60_000);

  it("/web 形态切换 e2e（子进程真接线：行模式 /web → 退出序列 → 同进程 server 起服横幅 + 实例文件）", async () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-web-t2-e2e-"));
    homes.push(d);
    const home = join(d, "home", ".orosus");
    mkdirSync(home, { recursive: true });
    writeProviderConfig(home);
    const env = {
      ...process.env,
      USERPROFILE: join(d, "home"),
      HOME: join(d, "home"),
      OROSUS_HOME: home,
    } as Record<string, string>;
    const child = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot(), "apps/cli/src/main.ts")], {
      cwd: d, env, stdio: ["pipe", "pipe", "pipe"],
    });
    procs.push(child);
    let out = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.stderr.on("data", (c) => { out += String(c); });
    child.stdin.write("/web\n");
    // /web → 退出序列（空会话 purge → 交接跳过）→ server 起服 → URL 横幅（三行式）+ 实例文件落位
    await waitFor(() => out.includes("http://127.0.0.1"), 20_000);
    expect(out).toContain("保持本终端开启");
    await waitFor(() => existsSync(join(home, "web", "server.json")));
    expect(child.exitCode).toBe(null); // 长驻（server 存活——退出序列后形态切换而非进程退出）
  }, 40_000);
});
