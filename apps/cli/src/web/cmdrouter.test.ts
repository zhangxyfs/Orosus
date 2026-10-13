/** web 批 T6 伴生测试：命令路由 cmdrouter——brief ①-⑩ 逐条 + BUSY 两表形状 + /skill 注入 + /quit 端到端。
 *  分层：①②③④⑥⑦⑨⑩e2e 走真栈（runWebSubcommand + handover 托管——T4 send.test 同款；命令不调
 *  provider，死端口 config 即可）；⑤⑧⑩直连 HostedSession（注入 modules——T2 hosted.test 同款缝：
 *  ⑤ 需 fake provider 跑真压缩、⑧ 需请求捕获 + onBtw 帧、⑩ 需挂起 provider 的 busy 面）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeCwd, JsonlSessionStore, type SessionEvent } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import { MODULE_API_VERSION, type CommandUi, type ModuleDefinition } from "@orosus/contracts/module";
import { providerSlotKey, type Chunk, type ProviderRequest, type StreamFn } from "@orosus/contracts/provider";
import { runWebSubcommand, webHostPool } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";
import { HostedSession } from "./hosted.ts";
import { WEB_BUSY_BLOCK, WEB_BUSY_EXEC } from "./cmdrouter.ts";
import { askBtw } from "./btw-service.ts";

/** 轮询等待（25ms 步进；谓词可异步；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** 引导门放行形态 config.toml（T4 同款：type = "openai" 必填——provider-custom 槽 schema）。 */
const writeProviderConfig = (home: string): void => {
  writeFileSync(join(home, "config.toml"), [
    'model = "demo/model-x"',
    "",
    "[provider-custom.providers.demo]",
    'baseUrl = "http://127.0.0.1:9"',
    'type = "openai"',
    "",
  ].join("\n"), "utf8");
};

/** 种子会话（header-only；可选 label）。 */
const seedSession = async (home: string, cwd: string, sid: string, label?: string): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  if (label !== undefined) await store.append("session/label", { label });
  await store.close();
};

/** 无头 CommandUi（T2 同款——本批命令面无交互，fail-closed 即可）。 */
const headlessUi: CommandUi = {
  ask: async () => { throw new Error("无交互环境"); },
  askSecret: async () => { throw new Error("无交互环境"); },
  choose: async () => { throw new Error("无交互环境"); },
  confirm: async () => { throw new Error("无交互环境"); },
};

/** 请求捕获型 fake provider 模块（⑧ /btw 的 llm 请求断言用——fakeProvider 自带 requests 收集）。 */
const captureProvider = (name: string, script: Chunk[][]): { mod: ModuleDefinition; requests: ProviderRequest[] } => {
  const { stream, requests } = fakeProvider(script);
  const mod: ModuleDefinition = {
    name: `provider-${name}`, version: "0.1.0", description: `fake provider ${name}`, api: MODULE_API_VERSION,
    activate(ctx) { ctx.provide(providerSlotKey(name), stream); },
  };
  return { mod, requests };
};

/** 挂起 provider（⑩ busy 面——T2 gatedProvider 同款：entered 后闸门不放，turn 悬停 = busy 恒真；
 *  abort 与闸门赛跑——真适配器 abort 即收流，gate 单独 await 会让 cancel 永远唤不醒悬停流）。 */
const gatedProvider = (): { mod: ModuleDefinition; entered: Promise<void>; release: () => void } => {
  let resolveEnter!: () => void;
  const entered = new Promise<void>((r) => { resolveEnter = r; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const stream: StreamFn = (req) => (async function* () {
    resolveEnter();
    yield { type: "text/delta", text: "部分输出" } as Chunk;
    await Promise.race([
      gate,
      new Promise<void>((r) => {
        if (req.signal.aborted) { r(); return; }
        req.signal.addEventListener("abort", () => r(), { once: true });
      }),
    ]);
    if (req.signal.aborted) {
      yield { type: "finish", kind: "aborted" } as Chunk;
      return;
    }
    yield { type: "finish", kind: "stop" } as Chunk;
  })();
  const mod: ModuleDefinition = {
    name: "provider-gated", version: "0.1.0", description: "gated", api: MODULE_API_VERSION,
    activate(ctx) { ctx.provide(providerSlotKey("gated"), stream); },
  };
  return { mod, entered, release };
};

interface Stack {
  base: string;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}

/** 真栈起服 + handover 托管种子会话（T4 同款）。 */
const startWeb = async (home: string, cwd: string, sid: string): Promise<Stack> => {
  const lines: string[] = [];
  const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
  await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
  const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
  return {
    base: `http://127.0.0.1:${inst.port}`,
    auth: { "x-orosus-token": inst.token, connection: "close" },
    stop: async () => {
      shutdownWebServer("test");
      await run;
    },
  };
};

/** POST send（命令文本——content-type 即 T1 护栏合规形态）。 */
const postSend = (s: Stack, sid: string, text: string): Promise<Response> =>
  fetch(`${s.base}/api/sessions/${sid}/send`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify({ text }) });

/** GET events 最新一页。 */
const latestEvents = async (s: Stack, sid: string): Promise<SessionEvent[]> => {
  const r = await fetch(`${s.base}/api/sessions/${sid}/events`, { headers: s.auth });
  const b = (await r.json()) as { events: SessionEvent[] };
  return b.events;
};

/** GET status。 */
const statusOf = async (s: Stack, sid: string): Promise<Record<string, unknown>> => {
  const r = await fetch(`${s.base}/api/sessions/${sid}/status`, { headers: s.auth });
  return (await r.json()) as Record<string, unknown>;
};

describe("web T6：命令路由 cmdrouter", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  let prevHome: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t6-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-t6-cwd-"));
    cwds.push(c);
    return c;
  };

  beforeEach(() => {
    prevHome = process.env["OROSUS_HOME"];
  });

  afterEach(() => {
    shutdownWebServer("test-cleanup"); // 幂等——失败用例兜底清退
    if (prevHome === undefined) delete process.env["OROSUS_HOME"];
    else process.env["OROSUS_HOME"] = prevHome;
    for (const c of cwds.splice(0)) {
      try { rmSync(c, { recursive: true, force: true }); } catch { /* 迟到句柄留给系统 tmp */ }
    }
    while (homes.length > 0) {
      const h = homes.pop()!;
      try { rmSync(h, { recursive: true, force: true }); } catch { /* 同上 */ }
    }
  });

  it("BUSY 两表形状：EXEC = 原型十命令、BLOCK = /new /fork（D15 逐字）", () => {
    expect([...WEB_BUSY_EXEC].toSorted()).toEqual(["/auto", "/btw", "/effort", "/model", "/ps", "/rename", "/task", "/tasks", "/title", "/yolo"]);
    expect([...WEB_BUSY_BLOCK].toSorted()).toEqual(["/fork", "/new"]);
  });

  it("① /permission never → 写盘 [approval] mode + approval/policy 事件 + 返回静默（toast 层）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_perm");
    const s = await startWeb(home, cwd, "s_perm");

    const r = await postSend(s, "s_perm", "/permission never");
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ ok: true }); // 静默命令 ""（§4-4）——无 output 键

    await waitFor(async () => (await latestEvents(s, "s_perm")).some((e) => e.type === "approval/policy"));
    const ev = (await latestEvents(s, "s_perm")).toReversed().find((e) => e.type === "approval/policy") as { mode?: unknown };
    expect(ev.mode).toBe("never"); // 切换落日志（approval 模块）
    expect(readFileSync(join(home, "config.toml"), "utf8")).toMatch(/mode = "never"/); // 写盘（生效层持久化）
    expect(await (async () => (await statusOf(s, "s_perm"))["permission"])()).toBe("never"); // 运行期即时可见
    await s.stop();
  }, 60_000);

  it("② /yolo → ask-risky；③ /auto → never（别名表路由，policy 事件 + 配置面）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_quick");
    const s = await startWeb(home, cwd, "s_quick");

    const r1 = await postSend(s, "s_quick", "/yolo");
    expect(r1.status).toBe(202);
    expect(await r1.json()).toEqual({ ok: true });
    await waitFor(async () => (await statusOf(s, "s_quick"))["permission"] === "ask-risky");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toMatch(/mode = "ask-risky"/);

    const r2 = await postSend(s, "s_quick", "/auto");
    expect(r2.status).toBe(202);
    await waitFor(async () => (await statusOf(s, "s_quick"))["permission"] === "never");
    await s.stop();
  }, 60_000);

  it("④ /effort high → 核心顶层 effort 键写盘 + status.effort 变化", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_eff");
    const s = await startWeb(home, cwd, "s_eff");

    const r = await postSend(s, "s_eff", "/effort high");
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ ok: true }); // 静默（宿主 toast diff——status 面即反馈）
    expect(readFileSync(join(home, "config.toml"), "utf8")).toMatch(/^effort = "high"$/m); // 顶层键
    await waitFor(async () => (await statusOf(s, "s_eff"))["effort"] === "high");
    await s.stop();
  }, 60_000);

  it("⑤ /compact → turn/compaction 事件落流（fake provider 真跑压缩链）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    // 脚本三段：①主轮回答 ②自动标题（autoTitle——首轮完成后触发） ③压缩摘要
    const { mod } = captureProvider("fake", [
      [{ type: "text/delta", text: "第一轮回答正文" }, { type: "finish", kind: "stop" }],
      [{ type: "text/delta", text: "短标题" }, { type: "finish", kind: "stop" }],
      [{ type: "text/delta", text: "这是摘要：对话很短。" }, { type: "finish", kind: "stop" }],
    ]);
    const hs = new HostedSession({
      cwd,
      commandUi: headlessUi,
      modules: [mod],
      config: { userFile: join(home, "config.toml"), projectFile: join(cwd, "no.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      sessionsRoot: join(home, "sessions"),
    });
    await hs.ready;
    await hs.dispatch("讲个长故事"); // 预热对话（manual 压缩需非空投影）

    const r = await hs.dispatch("/compact");
    expect(r).toMatchObject({ ok: true });
    expect(r.output ?? "").toContain("上下文压缩完成"); // 完成反馈（toast/浮层面）
    await waitFor(async () => (await hs.replayAfter(0)).some((e) => e.type === "turn/compaction")); // 泵异步摄入——轮询锚
    const evs = await hs.replayAfter(0);
    const comp = evs.find((e) => e.type === "turn/compaction");
    expect(comp).toBeDefined(); // 事件回流（标记行渲染源）
    expect((comp as { trigger?: unknown }).trigger).toBe("manual");
    await hs.close();
  }, 60_000);

  it("⑥ /title 名字 → session/label 事件 + 确认文案（h.setLabel 活写口）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_title");
    const s = await startWeb(home, cwd, "s_title");

    const r = await postSend(s, "s_title", "/title 网页侧会话");
    expect(r.status).toBe(202);
    const b = (await r.json()) as { ok?: boolean; output?: string };
    expect(b.ok).toBe(true);
    expect(b.output ?? "").toContain("网页侧会话"); // 命名确认（t 键同族）

    await waitFor(async () => (await latestEvents(s, "s_title")).some((e) => e.type === "session/label"));
    const ev = (await latestEvents(s, "s_title")).toReversed().find((e) => e.type === "session/label") as { label?: unknown };
    expect(ev.label).toBe("网页侧会话");
    await s.stop();
  }, 60_000);

  it("⑦ /ps → 输出含 peers 行与 self 置顶（scanWithSelf 文本、无 ANSI）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_ps");
    // 桶内种一个假同伴（live.json 新鲜 = 活体；ps.ts 判活同源）
    const peerDir = join(home, "sessions", encodeCwd(cwd), "s_peer");
    mkdirSync(peerDir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(peerDir, "live.json"), JSON.stringify({
      v: 1, sid: "s_peer", pid: process.pid, token: "t-peer", kind: "line", phase: "idle",
      startedAt: now, lastEventAt: now, label: "隔壁同伴", model: "demo/model-x",
    }), "utf8");
    const s = await startWeb(home, cwd, "s_ps");
    await waitFor(() => existsSync(join(home, "sessions", encodeCwd(cwd), "s_ps", "live.json"))); // self 的 presence 首写

    const r = await postSend(s, "s_ps", "/ps");
    expect(r.status).toBe(202);
    const b = (await r.json()) as { ok?: boolean; output?: string };
    expect(b.ok).toBe(true);
    const out = b.output ?? "";
    expect(out).toContain("会话协同 · 本项目 2 个活跃"); // 标题行（计数含 self）
    expect(out).toContain("本会话"); // self 置顶标记（ps.selfMark）
    expect(out).toContain("隔壁同伴"); // peers 行（label）
    // oxlint-disable-next-line no-control-regex -- 断言对象是转义序列本身（ansi-guard 同款豁免）
    expect(out).not.toMatch(/\x1b\[/); // ANSI 剥离（web 输出面是 HTML——不透传终端色码）
    await s.stop();
  }, 60_000);

  it("⑧ /btw 带参 → {output:'',mark:'btw'} 受理即回（W6 前端开 tab 自行 POST /btw——旧 runBtw 单轮直调下线：零 llm 请求零自扇帧）；askBtw 归档后无参回看 rounds 文本 + mark 同发", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const { mod, requests } = captureProvider("fake", [
      [{ type: "text/delta", text: "侧问" }, { type: "text/delta", text: "答案" }, { type: "finish", kind: "stop" }],
    ]);
    const hs = new HostedSession({
      cwd,
      commandUi: headlessUi,
      modules: [mod],
      config: { userFile: join(home, "config.toml"), projectFile: join(cwd, "no.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      sessionsRoot: join(home, "sessions"),
    });
    await hs.ready;
    const frames: { tab: string; phase: string; text: string; round: number }[] = [];
    hs.onBtw((f) => frames.push({ ...f }));

    // 带参：受理即回 mark:btw——routeCommand 层 {output:"", mark:"btw"}（空 output 不上 SendResult 面，
    // hosted.ts 分流点省略空串）。问答本体由前端 POST /btw {tab,q} → askBtw 承接（W5 数据面）。
    const r = await hs.dispatch("/btw 这是什么");
    expect(r).toEqual({ ok: true, mark: "btw" });
    await new Promise((res) => setTimeout(res, 150)); // 微任务窗——旧 runBtw 若残留会现形（llm 请求/自扇帧）
    expect(requests.length).toBe(0); // 旧单轮直调已下线：本路径不再发 llm 请求
    expect(frames).toHaveLength(0); // 也不再自行扇帧——帧面归 POST /btw（askBtw）
    expect((await hs.replayAfter(0)).filter((e) => e.type === "user/message")).toHaveLength(0); // 零落盘不变（D5/D6）

    // 选项卡数据面（POST /btw 真身）经 askBtw 完成归档后：无参回看走 rounds 归档文本 + mark:btw 同发
    // （前端开或复用空草稿 btw tab——v2 cmdBtw 无参分支「无参直接打开侧问选项卡」）
    askBtw(hs, "btw-1", "这是什么");
    await waitFor(() => frames.some((f) => f.phase === "answer" && f.tab === "btw-1"));
    expect(frames.some((f) => f.phase === "answering" && f.text === "侧问" && f.tab === "btw-1" && f.round === 1)).toBe(true);
    expect(frames.some((f) => f.phase === "answer" && f.text === "侧问答案" && f.tab === "btw-1" && f.round === 1)).toBe(true);
    const back = await hs.dispatch("/btw");
    expect(back.output ?? "").toContain("这是什么");
    expect(back.output ?? "").toContain("侧问答案");
    expect(back.mark).toBe("btw");
    await hs.close();
  }, 60_000);

  it("⑨ 未知 /xxx → 输出未知命令文案（toast 面）；/settings /sessions 键入报未知（G1 分家——web 不自写）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_unk");
    const s = await startWeb(home, cwd, "s_unk");

    const r = await postSend(s, "s_unk", "/definitely-not-a-command");
    expect(r.status).toBe(202); // 命令错误面 = toast（D16）——不是 409
    const b = (await r.json()) as { ok?: boolean; output?: string };
    expect(b.ok).toBe(true);
    expect(b.output ?? "").toContain('未知命令 "/definitely-not-a-command"'); // 与 core 文案同族（透传错误带回）

    const r2 = await postSend(s, "s_unk", "/settings");
    const b2 = (await r2.json()) as { output?: string };
    expect(b2.output ?? "").toContain('未知命令 "/settings"'); // CLI 宿主拦截件——web 键入即未知
    const r3 = await postSend(s, "s_unk", "/sessions");
    const b3 = (await r3.json()) as { output?: string };
    expect(b3.output ?? "").toContain('未知命令 "/sessions"');
    await s.stop();
  }, 60_000);

  it("⑨补 /web 入表空转（2026-10-12 走查口径）：web 内打 /web → 202 + 已是 Web 界面指引文案（不未知、不关会话）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_web");
    const s = await startWeb(home, cwd, "s_web");

    const r = await postSend(s, "s_web", "/web");
    expect(r.status).toBe(202);
    const b = (await r.json()) as { ok?: boolean; output?: string; mark?: string };
    expect(b.ok).toBe(true);
    expect(b.output ?? "").toContain("Web"); // web.alreadyWeb（三语键——zh-CN「当前已是 Web 界面…」）
    expect(b.mark).toBeUndefined(); // 不关会话（/quit 族语义不沾）
    const st = await fetch(`${s.base}/api/sessions/s_web/status`, { headers: s.auth });
    expect(st.status).toBe(200); // 会话健在
    await s.stop();
  }, 60_000);

  it("⑩ busy 三档：/model（EXEC）立即可发 / /title（EXEC）立即执行 / /new（BLOCK）409 语义 / /compact（两表外）入队 / /quit 先 cancel 再关", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const gated = gatedProvider();
    const hs = new HostedSession({
      cwd,
      commandUi: headlessUi,
      modules: [gated.mod],
      config: { userFile: join(home, "config.toml"), projectFile: join(cwd, "no.toml"), env: {}, cliOverrides: { model: "gated/x" } },
      sessionsRoot: join(home, "sessions"),
    });
    await hs.ready;
    const types: string[] = [];
    hs.onEvent((e) => types.push(e.type));

    // 占位消息起 busy（挂起 provider——turn 悬停）
    const msg = await hs.accept("占位消息");
    expect(msg.result).toEqual({ ok: true });
    await gated.entered;
    await waitFor(() => hs.busy());

    // EXEC：/model 立即可发（菜单信号——不入队）
    const m = await hs.accept("/model");
    expect(m.result).toMatchObject({ ok: true, mark: "menu:model" });
    // EXEC 真执行：/title 忙时命名立即生效（session/label 事件 + 确认输出）
    const t = await hs.accept("/title 忙时命名");
    expect(t.result.ok).toBe(true);
    expect((t.result as { output?: string }).output ?? "").toContain("忙时命名");
    await waitFor(() => types.includes("session/label"));
    // BLOCK：/new → 409 语义（{ok:false,error}——拦截提示保留输入）
    const n = await hs.accept("/new");
    expect(n.result.ok).toBe(false);
    expect((n.result as { error?: string }).error ?? "").toContain("/new 本轮不可执行");
    // 两表外默认档：/compact → 与消息同队（入队）
    const c = await hs.accept("/compact");
    expect(c.result).toEqual({ ok: true, queued: true, index: 0 });
    expect(hs.withdraw(0)).toBe(true); // 撤队防 drain 补跑（本用例聚焦分级不聚焦补跑）
    // /quit 族 busy 特例：先 cancel（turn/end interrupted）再关当前会话（mark 由 server 执行）
    const q = await hs.accept("/quit");
    expect(q.result).toMatchObject({ ok: true, mark: "quit" });
    await waitFor(() => types.some((x) => x === "turn/end"));
    const end = (await hs.replayAfter(0)).toReversed().find((e) => e.type === "turn/end") as { kind?: unknown };
    expect(end.kind).toBe("interrupted"); // cancel 实证（不是等 turn 自然收尾）
    gated.release();
    await hs.close();
  }, 60_000);

  it("/quit 端到端：POST /quit → 202 {ok,mark:quit} → server 关当前会话（池摘除，server 常驻）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_quit", "退场会话");
    const s = await startWeb(home, cwd, "s_quit");

    const r = await postSend(s, "s_quit", "/quit");
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ ok: true, mark: "quit" });
    // server 侧执行：HostedSession 关停 + 出池（50ms 延迟窗后）；server 本身常驻（health 仍活）
    await waitFor(() => webHostPool()?.host("s_quit") === undefined);
    const health = await fetch(`${s.base}/api/health`, { headers: s.auth });
    expect(health.status).toBe(200);
    await s.stop();
  }, 60_000);

  it("/skill : 名 → 目录解析 + 标记行合成体走消息路径（busy 排队语义保留）+ notFound 面", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    // 用户轨技能（~/.orosus/skills/<名>/SKILL.md = 密封 home 下的 home/skills——frontmatter name 必需。
    // 项目轨在多项目托管下解析自 process.cwd()〔§4-1 已知边界〕，测试取用户轨保确定性）
    const skillDir = join(home, "skills", "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo-skill\ndescription: 演示技能\n---\n技能正文内容。\n", "utf8");
    const { mod } = captureProvider("fake", [
      [{ type: "text/delta", text: "好的。" }, { type: "finish", kind: "stop" }],
    ]);
    const hs = new HostedSession({
      cwd,
      commandUi: headlessUi,
      modules: [mod],
      config: { userFile: join(home, "config.toml"), projectFile: join(cwd, "no.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      sessionsRoot: join(home, "sessions"),
    });
    await hs.ready;

    const r = await hs.dispatch("/skill : demo-skill");
    expect(r.ok).toBe(true);
    expect((r as { mark?: string }).mark).toBe("skill");
    await waitFor(async () => (await hs.replayAfter(0)).some((e) => e.type === "user/message"));
    const evs = await hs.replayAfter(0);
    const userMsg = evs.find((e) => e.type === "user/message") as { content?: { kind?: string; text?: string }[] };
    const text = (userMsg?.content ?? []).map((p) => (p.kind === "text" ? p.text : "")).join("");
    expect(text).toContain("（用户通过菜单手动加载技能"); // 标记行（SKILL_MARK_PREFIX 同源形态）
    expect(text).toContain("技能正文内容。"); // 正文剥 frontmatter 后进 <skill> 块
    expect(text).toContain("</skill>");

    // 未知名：notFound 文案（toast 面）
    const nf = await hs.dispatch("/skill : 不存在的技能");
    expect(nf.ok).toBe(true);
    expect((nf as { output?: string }).output ?? "").toContain("不存在的技能");
    await hs.close();
  }, 60_000);
});
