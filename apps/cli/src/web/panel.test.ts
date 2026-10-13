/** web 批 T10 伴生测试：面板数据 API——brief ①-⑥ 逐条。
 *  - ① GET /panel 字段齐且与 TUI 同口径（tokens = 末条 usage 分拆；ctx = used/window/pct——
 *    lastUsageOf ÷ resolveContextWindow 经 configFace 同链）；种子事件真盘 resume；
 *  - ② modules 三态（mounted/off/pendingConfirm——off 靠预写 modules.d 停用、pendingConfirm 靠
 *    未信任第三方模块目录）+ 锁定原因文案（lockReasonFor 三款——provider 锁经「槽名=模块名」实触发）；
 *  - ③ POST modules/:name/toggle 卸载可卸模块 → config enabled=false 写盘 + ReloadReport 摘要 + 回挂；
 *  - ④ 锁定模块 toggle → 409 {error: 原因文案}；未知模块 404；坏 body 400；
 *  - ⑤ tasks 从 tool-todo/write 事件投影三态（done/in_progress→active/pending）；无 todo 事件 → []；
 *  - ⑥ 缓存断言（§5 律三）：1s 缓存连续两次 GET 第二次不重算（panelComputeCount 计数）；
 *    tool-todo/write 事件到达即失效下一请求出新值；模块 toggle（reload）后即失效。
 *  - ⑦ peers 投影（2026-10-12 走查五轮）：同桶外部进程在列；本池托管同伴与跨桶活体出列
 *    （协同卡 = TUI /ps 同项目外部进程口径——全桶合并/自家托管重复列均被用户走查否）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer as createHttpServer } from "node:http";

import { encodeCwd, JsonlSessionStore } from "@orosus/core";
import { runWebSubcommand } from "./mod.ts";
import { panelComputeCount } from "./api-panel.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";
import { lockReasonFor } from "../modules-ui.ts";
import { shortenPath } from "../usage-text.ts";
import { t } from "../i18n/app.ts";

/** 轮询等待（25ms 步进；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

// ---------- 真栈工具（T4/T5/T7 同款） ----------

/** 引导门放行形态 config.toml（type = "openai"——provider-custom 槽 schema 必填协议族）。
 *  model 可指定——「provider-custom/model-x」让槽名与模块名同名（② provider 锁的实触发面）。 */
const writeProviderConfig = (home: string, baseUrl: string, model = "demo/model-x"): void => {
  const slot = model.includes("/") ? model.split("/")[0]! : model;
  writeFileSync(
    join(home, "config.toml"),
    `model = "${model}"\n\n[provider-custom.providers.${slot}]\nbaseUrl = "${baseUrl}"\ntype = "openai"\n`,
    "utf8",
  );
};

interface SeedOpts {
  label?: string;
  usage?: { input: number; output: number };
  todos?: Array<{ content: string; status: string }>;
}

/** 种子会话（真盘 jsonl——resume 后 refreshPanel 经 h.history() 现读，fabricate 事件即面板输入）。 */
const seedSession = async (home: string, cwd: string, sid: string, opts: SeedOpts = {}): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  if (opts.label !== undefined) await store.append("session/label", { label: opts.label });
  await store.append("user/message", { content: [{ kind: "text", text: "跑一下" }] });
  if (opts.usage !== undefined) {
    await store.append("assistant/message", { content: [{ kind: "text", text: "完成" }], usage: opts.usage });
  }
  if (opts.todos !== undefined) await store.append("tool-todo/write", { todos: opts.todos });
  await store.close();
};

/** 真驻留子进程（⑦ live.json fabrication 的活 pid 源——pool.test 同款）。 */
const spawnSleeper = async (): Promise<{ pid: number; kill: () => void }> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 400)); // Windows 上 pid 探活可达窗
  return { pid: child.pid!, kill: () => { try { child.kill(); } catch { /* 已退 */ } } };
};

/** fabricate live.json（会话目录根——scanLivePeers 的事实源；⑦ 外部进程协同行）。 */
const writeLive = (sessionDir: string, opts: { pid: number; phase: string; kind?: string }): void => {
  writeFileSync(join(sessionDir, "live.json"), JSON.stringify({
    v: 1, sid: basename(sessionDir), pid: opts.pid, token: "fabricate", kind: opts.kind ?? "tui",
    phase: opts.phase, startedAt: Date.now(), lastEventAt: Date.now(),
  }), "utf8");
};

interface Stack {
  base: string;
  port: number;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}

/** 真栈起服 + handover 托管种子会话（T4/T5/T7 同款）。 */
const startWeb = async (home: string, cwd: string, sid: string): Promise<Stack> => {
  const lines: string[] = [];
  const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
  await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
  const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
  return {
    base: `http://127.0.0.1:${inst.port}`,
    port: inst.port,
    auth: { "x-orosus-token": inst.token, connection: "close" },
    stop: async () => {
      shutdownWebServer("test");
      await run;
    },
  };
};

/** SSE 连接收集器（帧按空行切分——ev 帧断言用，T7 同款）。 */
const openSse = (s: Stack, pathQ: string): {
  frames: { event?: string; data: string; id?: string }[];
  until: (pred: (fs: { event?: string; data: string; id?: string }[]) => boolean, ms?: number) => Promise<void>;
  destroy: () => void;
} => {
  const frames: { event?: string; data: string; id?: string }[] = [];
  let raw = "";
  const req = httpRequest({ host: "127.0.0.1", port: s.port, path: pathQ, headers: s.auth }, (res) => {
    res.on("data", (c) => {
      raw += String(c);
      let i: number;
      while ((i = raw.indexOf("\n\n")) >= 0) {
        const block = raw.slice(0, i);
        raw = raw.slice(i + 2);
        const f: { event?: string; data: string; id?: string } = { data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) f.event = line.slice(7);
          else if (line.startsWith("data: ")) f.data = (f.data === "" ? "" : f.data + "\n") + line.slice(6);
          else if (line.startsWith("id: ")) f.id = line.slice(4);
        }
        frames.push(f);
      }
    });
  });
  req.end();
  return {
    frames,
    until: async (pred, ms = 8_000) => {
      await waitFor(() => pred(frames), ms);
    },
    destroy: () => { req.destroy(); },
  };
};

/** GET events 最新一页（SSE after 游标起点）。 */
const latestEvents = async (s: Stack, sid: string): Promise<Array<{ seq: number }>> => {
  const r = await fetch(`${s.base}/api/sessions/${sid}/events`, { headers: s.auth });
  const b = (await r.json()) as { events: Array<{ seq: number }> };
  return b.events;
};

interface PanelModule { name: string; desc: string; state: string; locked?: boolean; lockedReason?: string }

/** GET /panel 响应体形状（§3 :232 PanelData 同形 + ok 加法键）。 */
interface PanelBody {
  ok: boolean;
  model: string;
  session: string;
  cwd: string;
  elapsedMs: number;
  tokens: { input: number; output: number; postCompaction?: boolean };
  contextWindow: number;
  ctx: { used: number; window: number; pct: number };
  modules: PanelModule[];
  tasks: Array<{ text: string; state: string }>;
  network?: { proxy: string; modelService: string; connections: unknown[] };
  peers?: { self?: { sid: string; kind: string; phase: string }; list: Array<{ sid: string; kind?: string; phase: string }> };
}

/** GET /panel → 解析体（status 断言 200）。 */
const getPanel = async (s: Stack, sid: string): Promise<PanelBody> => {
  const r = await fetch(`${s.base}/api/sessions/${sid}/panel`, { headers: s.auth });
  expect(r.status).toBe(200);
  return (await r.json()) as PanelBody;
};

/** POST JSON（toggle 等写方法——content-type 护栏合规形态）。 */
const postJson = (s: Stack, path: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${s.base}${path}`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify(body) });

/** GET status（busy/phase 轮询锚）。 */
const getStatus = async (s: Stack, sid: string): Promise<{ phase?: string; busy?: boolean }> => {
  const r = await fetch(`${s.base}/api/sessions/${sid}/status`, { headers: s.auth });
  return (await r.json()) as { phase?: string; busy?: boolean };
};

// ---------- OpenAI 协议假服务（⑥：todo 写入轨） ----------

const oaiText = (text: string): string =>
  JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const oaiToolCall = (callId: string, name: string, args: string): string =>
  JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: args } }] }, finish_reason: null }] });
const oaiFinish = (reason: string): string =>
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

/** todo 写入假服务：主对话首请求 → tool-todo__todo_write toolcall（accesses:[] 免审批即执行——
 *  tool-todo/write 事件落盘）；工具后请求 → 文本收尾；标题请求（tools 空）→ 短文本。 */
const fakeOpenaiTodo = async (todos: Array<{ content: string; status: string }>): Promise<{ url: string; close: () => void }> => {
  let fresh = 0;
  const srv = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { /* 坏体按空 */ }
      const msgs = Array.isArray(body["messages"]) ? (body["messages"] as Array<{ role?: string }>) : [];
      const hasTools = Array.isArray(body["tools"]) && (body["tools"] as unknown[]).length > 0;
      const afterTool = msgs.at(-1)?.role === "tool";
      res.writeHead(200, { "content-type": "text/event-stream" });
      let frames: string[];
      if (!hasTools) frames = [oaiText("任务会话"), oaiFinish("stop")]; // 标题轨
      else if (afterTool) frames = [oaiText("清单已更新"), oaiFinish("stop")];
      else {
        fresh += 1;
        frames = [oaiToolCall(`t${fresh}`, "tool-todo__todo_write", JSON.stringify({ todos })), oaiFinish("tool_calls")];
      }
      for (const f of frames) res.write(`data: ${f}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => { srv.close(); srv.closeAllConnections?.(); } };
};

/** 未信任第三方模块目录（② pendingConfirm 面：<home>/modules/<名>/index.js——jiti 加载、无 trust.json
 *  登记 → 用户层 unconfirmed → audit state "pending-confirm"）。 */
const fabricateThirdModule = (home: string, name: string): void => {
  const dir = join(home, "modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), `export default { name: ${JSON.stringify(name)}, version: "0.1.0", description: "演示第三方模块", api: 1, activate() {} };\n`, "utf8");
};

describe("web T10：面板数据 API", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  const closers: Array<() => void> = [];
  let prevHome: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t10-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-t10-cwd-"));
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
    for (const c of closers.splice(0)) {
      try { c(); } catch { /* 已关 */ }
    }
    for (const c of cwds.splice(0)) {
      try { rmSync(c, { recursive: true, force: true }); } catch { /* 迟到句柄留给系统 tmp */ }
    }
    while (homes.length > 0) {
      const h = homes.pop()!;
      try { rmSync(h, { recursive: true, force: true }); } catch { /* 同上 */ }
    }
  });

  it("① GET /panel：字段齐且与 TUI 同口径（tokens=末条 usage；ctx=used/window/pct）+ network/peers 面 + 未知 sid 404", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    writeProviderConfig(home, "http://127.0.0.1:9", "provider-custom/model-x"); // 死端口——本用例不发 prompt
    await seedSession(home, cwd, "s_panel1", { label: "面板会话", usage: { input: 90_000, output: 1_200 } });
    const s = await startWeb(home, cwd, "s_panel1");

    const p = await getPanel(s, "s_panel1");
    // kv 面：模型（裸槽名→槽内模型段——provider-custom 的 defaultModel 缺席回落尾段）与会话标题
    expect(p.ok).toBe(true);
    expect(p.model).toBe("model-x");
    expect(p.session).toBe("面板会话");
    expect(p.cwd).toBe(shortenPath(cwd, 26)); // 会话 cwd（hosted.cwd）——非 server 进程 cwd
    expect(p.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(p.elapsedMs).toBeLessThan(60_000);
    // tokens = 末条 usage 分拆（lastUsageOf 同口径）
    expect(p.tokens).toEqual({ input: 90_000, output: 1_200 });
    // ctx = used/window/pct（E3：lastUsageOf ÷ resolveContextWindow——configFace 同链，无显式配置回落 200k）
    expect(p.contextWindow).toBe(200_000);
    expect(p.ctx).toEqual({ used: 90_000, window: 200_000, pct: 45 });
    // modules/tasks 结构面（②⑤细断言）
    expect(p.modules.length).toBeGreaterThan(0);
    for (const m of p.modules) {
      expect(typeof m.name).toBe("string");
      expect(typeof m.desc).toBe("string");
      expect(["mounted", "loading", "off", "pendingConfirm"]).toContain(m.state);
    }
    expect(Array.isArray(p.tasks)).toBe(true);
    // network 面（refreshPanel 预取：proxy/modelService 串；connections = mcp.catalog 投影——T11 填充，
    // 本用例无 MCP 配置：预装懒启动件 idle 行）
    expect(typeof p.network?.proxy).toBe("string");
    expect(p.network!.proxy.length).toBeGreaterThan(0);
    expect(typeof p.network?.modelService).toBe("string");
    expect(p.network!.connections.length).toBeGreaterThan(0);
    for (const c of p.network!.connections) {
      const row = c as { name: string; state: string; desc: string };
      expect(typeof row.name).toBe("string");
      expect(["connected", "idle", "failed", "pending-confirm", "disabled"]).toContain(row.state);
      expect(row.desc.length).toBeGreaterThan(0);
    }
    // peers 面（E6 + 走查五轮修订：self 置顶——host 会话 presence kind=web；list = 同桶外部进程——⑦ 细断言）
    expect(p.peers?.self?.sid).toBe("s_panel1");
    expect(p.peers?.self?.kind).toBe("web");
    expect(Array.isArray(p.peers?.list)).toBe(true);
    // 未知 sid → 404
    const nf = await fetch(`${s.base}/api/sessions/s_none/panel`, { headers: s.auth });
    expect(nf.status).toBe(404);

    await s.stop();
  }, 60_000);

  it("② modules 三态（mounted/off/pendingConfirm）+ 锁定原因文案（approval/provider 实触发 + lockReasonFor 三款直核）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    writeProviderConfig(home, "http://127.0.0.1:9", "provider-custom/model-x"); // 槽名=模块名 → provider 锁实触发
    // off 态：预写 modules.d 停用（用户层模块节路由——writeSectionKey 产物同形）
    mkdirSync(join(home, "modules.d"), { recursive: true });
    writeFileSync(join(home, "modules.d", "tool-web.toml"), "[tool-web]\nenabled = false\n", "utf8");
    // pendingConfirm 态：未信任第三方模块（用户层 unconfirmed → pending-confirm）
    fabricateThirdModule(home, "demo-third");
    await seedSession(home, cwd, "s_mods2");
    const s = await startWeb(home, cwd, "s_mods2");

    const p = await getPanel(s, "s_mods2");
    const byName = new Map(p.modules.map((m) => [m.name, m]));
    // 三态齐（mounted=approval、off=tool-web、pendingConfirm=demo-third）
    const approval = byName.get("approval");
    expect(approval?.state).toBe("mounted");
    expect(approval?.locked).toBe(true);
    expect(approval?.lockedReason).toBe(t("mod.lock.approval"));
    const toolWeb = byName.get("tool-web");
    expect(toolWeb?.state).toBe("off");
    expect(toolWeb?.locked).toBeFalsy();
    const third = byName.get("demo-third");
    expect(third?.state).toBe("pendingConfirm");
    // provider 锁（当前活跃 provider 模块——model 槽名与模块名同款命中）
    const prov = byName.get("provider-custom");
    expect(prov?.state).toBe("mounted");
    expect(prov?.locked).toBe(true);
    expect(prov?.lockedReason).toBe(t("mod.lock.provider"));
    // 三款锁因直核（core 分支无 orosus-core 伪模块审计行——图面不可达，锁文案单口核验）
    expect(lockReasonFor("orosus-core")).toBe(t("mod.lock.core"));
    expect(lockReasonFor("approval")).toBe(t("mod.lock.approval"));
    expect(lockReasonFor("provider-custom")).toBe(t("mod.lock.provider"));

    await s.stop();
  }, 60_000);

  it("③ POST modules/:name/toggle：卸载可卸模块 → config enabled=false 写盘 + ReloadReport 摘要 + toast；回挂同链；未知模块 404", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    writeProviderConfig(home, "http://127.0.0.1:9");
    await seedSession(home, cwd, "s_tog3");
    const s = await startWeb(home, cwd, "s_tog3");

    // 卸载 tool-web（无依赖者——闭包单成员）
    const off = await postJson(s, "/api/sessions/s_tog3/modules/tool-web/toggle", {});
    expect(off.status).toBe(200);
    const offBody = (await off.json()) as { ok: boolean; action: string; name: string; report: { added: string[]; removed: string[]; failed: unknown[] }; toast: string };
    expect(offBody.ok).toBe(true);
    expect(offBody.action).toBe("unmount");
    expect(offBody.name).toBe("tool-web");
    expect(offBody.report.removed).toContain("tool-web");
    expect(offBody.report.failed).toEqual([]);
    expect(offBody.toast).toContain("已卸载");
    // 写盘断言：modules.d/tool-web.toml enabled = false
    const cfg = readFileSync(join(home, "modules.d", "tool-web.toml"), "utf8");
    expect(cfg).toContain("enabled = false");
    // panel 即刻出新值（toggle 显式失效缓存）
    const p1 = await getPanel(s, "s_tog3");
    expect(p1.modules.find((m) => m.name === "tool-web")?.state).toBe("off");

    // 回挂（enabled 显式方向）
    const on = await postJson(s, "/api/sessions/s_tog3/modules/tool-web/toggle", { enabled: true });
    expect(on.status).toBe(200);
    const onBody = (await on.json()) as { ok: boolean; action: string; report: { added: string[] }; toast: string };
    expect(onBody.action).toBe("mount");
    expect(onBody.report.added).toContain("tool-web");
    expect(onBody.toast).toContain("已挂载");
    expect(readFileSync(join(home, "modules.d", "tool-web.toml"), "utf8")).toContain("enabled = true");
    const p2 = await getPanel(s, "s_tog3");
    expect(p2.modules.find((m) => m.name === "tool-web")?.state).toBe("mounted");

    // 未知模块 → 404；未知 sid → 404
    const unknown = await postJson(s, "/api/sessions/s_tog3/modules/no-such-module/toggle", {});
    expect(unknown.status).toBe(404);
    const nf = await postJson(s, "/api/sessions/s_none/modules/tool-web/toggle", {});
    expect(nf.status).toBe(404);

    await s.stop();
  }, 60_000);

  it("④ 锁定模块 toggle → 409 {error: 原因文案}；非布尔 enabled → 400", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    writeProviderConfig(home, "http://127.0.0.1:9", "provider-custom/model-x");
    await seedSession(home, cwd, "s_lock4");
    const s = await startWeb(home, cwd, "s_lock4");

    const appr = await postJson(s, "/api/sessions/s_lock4/modules/approval/toggle", {});
    expect(appr.status).toBe(409);
    expect(await appr.json()).toEqual({ ok: false, error: t("mod.lock.approval") });
    const prov = await postJson(s, "/api/sessions/s_lock4/modules/provider-custom/toggle", {});
    expect(prov.status).toBe(409);
    expect(await prov.json()).toEqual({ ok: false, error: t("mod.lock.provider") });
    // 配置未被写动（锁定路径零副作用）
    expect(() => readFileSync(join(home, "modules.d", "approval.toml")) ).toThrow();
    // 非布尔 enabled → 400
    const bad = await postJson(s, "/api/sessions/s_lock4/modules/tool-web/toggle", { enabled: "yes" });
    expect(bad.status).toBe(400);

    await s.stop();
  }, 60_000);

  it("⑤ tasks 从 tool-todo/write 事件投影三态（done/in_progress→active/pending）；无 todo 事件 → []", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    writeProviderConfig(home, "http://127.0.0.1:9");
    await seedSession(home, cwd, "s_todo5", {
      todos: [
        { content: "任务甲", status: "done" },
        { content: "任务乙", status: "in_progress" },
        { content: "任务丙", status: "pending" },
      ],
    });
    await seedSession(home, cwd, "s_todo5b"); // 无 todo 事件
    const s = await startWeb(home, cwd, "s_todo5");

    const p = await getPanel(s, "s_todo5");
    expect(p.tasks).toEqual([
      { text: "任务甲", state: "done" },
      { text: "任务乙", state: "active" },
      { text: "任务丙", state: "pending" },
    ]);
    const p2 = await getPanel(s, "s_todo5b");
    expect(p2.tasks).toEqual([]);

    await s.stop();
  }, 60_000);

  it("⑥ 缓存断言（§5 律三）：1s 内连续两次 GET 第二次不重算（计数）；tool-todo/write 事件到达即失效出新值；模块 toggle 后即失效", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const prov = await fakeOpenaiTodo([{ content: "新任务A", status: "in_progress" }]);
    closers.push(prov.close);
    writeProviderConfig(home, prov.url);
    await seedSession(home, cwd, "s_cache6");
    const s = await startWeb(home, cwd, "s_cache6");

    const before = await latestEvents(s, "s_cache6");
    const lastSeq = before.length > 0 ? before[before.length - 1]!.seq : 0;
    const sse = openSse(s, `/api/sessions/s_cache6/stream?after=${lastSeq}`);

    // 两次 GET：1s 缓存——第二次不重算 refreshPanel（计数器只 +1）
    const c0 = panelComputeCount();
    const p1 = await getPanel(s, "s_cache6");
    expect(p1.tasks).toEqual([]);
    expect(panelComputeCount()).toBe(c0 + 1);
    await getPanel(s, "s_cache6");
    expect(panelComputeCount()).toBe(c0 + 1);

    // 发消息 → tool-todo__todo_write 真跑（免审批）→ tool-todo/write 事件到达即失效
    const r = await postJson(s, "/api/sessions/s_cache6/send", { text: "更新任务清单" });
    expect(r.status).toBe(202);
    await sse.until((fs) => fs.some((f) => f.event === "ev" && f.data.includes("tool-todo/write")));
    const p2 = await getPanel(s, "s_cache6");
    expect(panelComputeCount()).toBe(c0 + 2); // 事件失效 → 重算
    expect(p2.tasks).toEqual([{ text: "新任务A", state: "active" }]); // 出新值
    await getPanel(s, "s_cache6");
    expect(panelComputeCount()).toBe(c0 + 2); // 又回缓存

    // 模块 toggle（reload）即失效：下一 GET 重算出模块新态
    await waitFor(async () => {
      const st = await getStatus(s, "s_cache6");
      return st.phase === "idle" && st.busy === false;
    });
    const c3 = panelComputeCount();
    const tog = await postJson(s, "/api/sessions/s_cache6/modules/tool-todo/toggle", {});
    expect(tog.status).toBe(200);
    expect(((await tog.json()) as { action: string }).action).toBe("unmount");
    const p3 = await getPanel(s, "s_cache6");
    expect(panelComputeCount()).toBe(c3 + 1); // reload 失效 → 重算
    expect(p3.modules.find((m) => m.name === "tool-todo")?.state).toBe("off");
    // tasks 是事件流投影（末条 tool-todo/write）——与模块挂载态正交，卸载后仍投出末条清单
    expect(p3.tasks).toEqual([{ text: "新任务A", state: "active" }]);

    sse.destroy();
    await s.stop();
  }, 120_000);

  it("⑦ peers 投影（2026-10-12 走查五轮口径）：同桶外部进程在列；本池托管同伴出列；跨桶活体出列", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home, "http://127.0.0.1:9"); // 死端口——本用例不发 prompt
    const cwd1 = tmpCwd(), cwd2 = tmpCwd(); // 双桶（同项目/他项目）
    await seedSession(home, cwd1, "s_p1", { label: "当前" });
    await seedSession(home, cwd1, "s_sib", { label: "托管同伴" });
    await seedSession(home, cwd1, "s_ext", { label: "同桶外进程" });
    await seedSession(home, cwd2, "s_far", { label: "他桶外进程" });
    const s = await startWeb(home, cwd1, "s_p1");
    // 本池第二托管（kind=web presence——协同卡须出列的面）
    const open = await postJson(s, "/api/sessions", { resumeSid: "s_sib" });
    expect(open.status).toBe(200);
    // 外部活体（live.json + 真 pid）：同桶 s_ext / 他桶 s_far
    const sleeper = await spawnSleeper();
    try {
      writeLive(join(home, "sessions", encodeCwd(cwd1), "s_ext"), { pid: sleeper.pid, phase: "idle", kind: "tui" });
      writeLive(join(home, "sessions", encodeCwd(cwd2), "s_far"), { pid: sleeper.pid, phase: "idle", kind: "tui" });
      await new Promise((r) => setTimeout(r, 1_100)); // 快照缓存 1s TTL 出窗（open 期已建快照）
      const p = await getPanel(s, "s_p1");
      expect(p.peers?.self?.sid).toBe("s_p1");
      const sids = (p.peers?.list ?? []).map((x) => x.sid);
      expect(sids).toContain("s_ext"); // 同桶外部 TUI 进程——协同面有效信息（TUI /ps 同项目口径）
      expect(sids).not.toContain("s_sib"); // 本池托管同伴——左栏可切，协同卡不重复列（走查五轮）
      expect(sids).not.toContain("s_far"); // 跨桶活体——全桶合并面废弃
      expect(sids).not.toContain("s_p1"); // self 置顶不重复入列
    } finally {
      sleeper.kill();
      await s.stop();
    }
  }, 60_000);
});
