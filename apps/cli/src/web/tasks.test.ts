/** web 批 T7 伴生测试：停止与子代理面——brief ①-④ 逐条。
 *  - ① POST /cancel（挂起 provider 真栈）→ {ok} + turn/end kind=interrupted 事件回流（SSE ev 帧 +
 *    GET events 持久面双断言）+ busy 归 false；
 *  - ①钉 cancel 不清挂起的 interaction 卡（T5 既定语义钉住：turn 阻塞至卡片应答或 close——前端双击
 *    Esc 连带 POST /answer {cancelled} 是 T16 的职责，本端点不越权 fail-close）；
 *  - ② GET /tasks 活名册 ∪ 盘上历史去重（fabricate 历史 subagent jsonl——tasks-cmd.test ㊺ 同款手法；
 *    同 id 活行优先无 historical 标、历史行 historical:true、最新在最上）；
 *  - ③ pendingApproval 行 → POST subagents/:id/approval {allow:true} → 子代理继续（真子代理审批全链：
 *    OpenAI 协议假服务双轨分派——主对话派后台单 → 子代理 bash 触发 ask-risky park → 放行后工具真跑、
 *    结论轮收尾、行转 completed）；
 *  - ④ GET subagents/:id/events transcript 回放末 500 条截断（自创值——fabricate 600 行 jsonl）；
 *  - ⑤ :id 八位 hex 形态校验（终审收口）——%2F 单段穿越形态解码后 id="y/../../etc" 直拼 agents_<id>
 *    路径 → 400 拒绝（tasks-cmd 名册 [0-9a-f]{8} 同款口径）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { encodeCwd, JsonlSessionStore, type SessionEvent } from "@orosus/core";
import type { SubagentRosterEntry } from "@orosus/contracts/module";
import { runWebSubcommand } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";

/** tasks 行（§3：SubagentRosterEntry & {historical?:boolean}——历史重建行带标）。 */
type TaskRow = SubagentRosterEntry & { historical?: boolean };

/** 轮询等待（25ms 步进；谓词可异步；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

// ---------- 真栈工具（T4/T5 同款） ----------

/** 引导门放行形态 config.toml（type = "openai"——provider-custom 槽 schema 必填协议族）。 */
const writeProviderConfig = (home: string, baseUrl: string): void => {
  writeFileSync(join(home, "config.toml"), `model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "${baseUrl}"\ntype = "openai"\n`, "utf8");
};

/** 种子会话（header-only）。 */
const seedSession = async (home: string, cwd: string, sid: string): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  await store.close();
};

interface Stack {
  base: string;
  port: number;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}

/** 真栈起服 + handover 托管种子会话（T4/T5 同款）。 */
const startWeb = async (home: string, cwd: string, sid: string): Promise<Stack> => {
  const lines: string[] = [];
  const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
  await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
  const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
  return {
    base: `http://127.0.0.1:${inst.port}`,
    port: inst.port,
    auth: { "x-orosus-token": inst.token, connection: "close" }, // undici 池死套接字防护（T4 教训）
    stop: async () => {
      shutdownWebServer("test");
      await run;
    },
  };
};

/** SSE 连接收集器（帧按空行切分——ev/interaction 帧断言用）。 */
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

/** GET events 最新一页（回读断言用）。 */
const latestEvents = async (s: Stack, sid: string): Promise<SessionEvent[]> => {
  const r = await fetch(`${s.base}/api/sessions/${sid}/events`, { headers: s.auth });
  const b = (await r.json()) as { events: SessionEvent[] };
  return b.events;
};

/** POST send / POST cancel / POST answer / POST approval（JSON 体——T1 写方法护栏合规形态）。 */
const postJson = (s: Stack, path: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${s.base}${path}`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify(body) });

/** GET status（busy/phase 轮询锚）。 */
const getStatus = async (s: Stack, sid: string): Promise<{ phase?: string; busy?: boolean }> => {
  const r = await fetch(`${s.base}/api/sessions/${sid}/status`, { headers: s.auth });
  return (await r.json()) as { phase?: string; busy?: boolean };
};

/** status.phase 回 idle（turn 收尾轮询锚——T5 同款）。 */
const hsIdle = async (s: Stack, sid: string): Promise<boolean> => {
  const b = await getStatus(s, sid);
  return b.phase === "idle" && b.busy === false;
};

/** GET tasks → rows。 */
const getTasks = async (s: Stack, sid: string): Promise<TaskRow[]> => {
  const r = await fetch(`${s.base}/api/sessions/${sid}/tasks`, { headers: s.auth });
  expect(r.status).toBe(200);
  const b = (await r.json()) as { rows?: TaskRow[] };
  return b.rows ?? [];
};

/** 轮询 tasks 直到某行满足谓词（返回该行快照）。 */
const waitForRow = async (s: Stack, sid: string, pred: (row: TaskRow) => boolean): Promise<TaskRow> => {
  let found: TaskRow | undefined;
  await waitFor(async () => {
    const rows = await getTasks(s, sid);
    const row = rows.find(pred);
    if (row !== undefined) found = row;
    return row !== undefined;
  });
  return found!;
};

// ---------- OpenAI 协议假服务（provider-custom 真翻译层消费） ----------

const oaiText = (text: string): string =>
  JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const oaiToolCall = (callId: string, name: string, args: string): string =>
  JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: args } }] }, finish_reason: null }] });
const oaiFinish = (reason: string): string =>
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

/** 挂起 provider（① busy 面）：真 provider-custom 槽指向的本地 HTTP 服务——收下请求永不回应，
 *  流悬停 = turn 不收尾（T4 ⑤ 同款）。 */
const hangingProvider = async (): Promise<{ url: string; close: () => void }> => {
  const srv = createHttpServer(() => { /* 悬停：不回应 */ });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => { srv.close(); srv.closeAllConnections?.(); } };
};

/** 主对话审批假服务（①钉）：主对话请求 → bash toolcall（ask-risky 触发 ctx.ui.choose 挂卡）；
 *  工具后请求 → 文本收尾。 */
const fakeOpenaiMain = async (cmd: string): Promise<{ url: string; close: () => void }> => {
  let fresh = 0;
  const srv = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { /* 坏体按空 */ }
      const msgs = Array.isArray(body["messages"]) ? (body["messages"] as Array<{ role?: string }>) : [];
      const afterTool = msgs.at(-1)?.role === "tool";
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames = afterTool
        ? [oaiText("本轮完成"), oaiFinish("stop")]
        : (() => { fresh += 1; return [oaiToolCall(`c${fresh}`, "tool-shell__bash", JSON.stringify({ command: cmd })), oaiFinish("tool_calls")]; })();
      for (const f of frames) res.write(`data: ${f}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => { srv.close(); srv.closeAllConnections?.(); } };
};

/** 子代理派单假服务（② ③）：四轨分派——
 *  - 主对话首请求（无 tool 尾消息）→ tool-subagent__spawn（background:true——后台单入册即返）；
 *  - 主对话工具后请求 / 后续主请求（送回轮）→ 文本收尾（防再派单循环）；
 *  - 子代理请求（system 含 "Orosus sub-agent"——runner buildSystemPrompt 签名；system 在 wire
 *    messages[0] 而非顶层字段）：首请求 → bash toolcall（ask-risky 下 subprocess 触发 park——
 *    后台单挂 pendingApproval）、工具后请求 → 文本结论（审批放行后单子收尾）；
 *  - 标题请求（tools 空且 system 含「标题」）→ 短文本。 */
const fakeOpenaiSub = async (cmd: string): Promise<{ url: string; close: () => void }> => {
  let mainFresh = 0;
  let subFresh = 0;
  const srv = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { /* 坏体按空 */ }
      const msgs = Array.isArray(body["messages"]) ? (body["messages"] as Array<{ role?: string; content?: unknown }>) : [];
      const sys = msgs[0]?.role === "system" && typeof msgs[0]?.content === "string" ? msgs[0].content : "";
      const hasTools = Array.isArray(body["tools"]) && (body["tools"] as unknown[]).length > 0;
      const isSub = sys.includes("Orosus sub-agent");
      const isTitle = !hasTools && sys.includes("标题");
      const afterTool = msgs.at(-1)?.role === "tool";
      res.writeHead(200, { "content-type": "text/event-stream" });
      let frames: string[];
      if (isTitle) frames = [oaiText("派单会话"), oaiFinish("stop")];
      else if (isSub) frames = afterTool
        ? [oaiText("子代理结论：命令已执行"), oaiFinish("stop")]
        : (() => { subFresh += 1; return [oaiToolCall(`s${subFresh}`, "tool-shell__bash", JSON.stringify({ command: cmd })), oaiFinish("tool_calls")]; })();
      else if (afterTool) frames = [oaiText("已派出后台子代理"), oaiFinish("stop")];
      else frames = (() => {
        mainFresh += 1;
        return mainFresh === 1
          ? [oaiToolCall("m1", "tool-subagent__spawn", JSON.stringify({ description: "后台跑数", prompt: "执行指定命令并报告输出", background: true })), oaiFinish("tool_calls")]
          : [oaiText("收到"), oaiFinish("stop")];
      })();
      for (const f of frames) res.write(`data: ${f}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => { srv.close(); srv.closeAllConnections?.(); } };
};

/** fabricate 盘上历史子代理 jsonl（tasks-cmd.test ㊺ 同款手法）：路径形状
 *  <sessionsDir>/<sid>/agents/agents_<id>/agents/session.jsonl。 */
const fabricateAgentJsonl = (home: string, cwd: string, sid: string, id: string, events: Array<Record<string, unknown>>): void => {
  const dir = join(home, "sessions", encodeCwd(cwd), sid, "agents", `agents_${id}`, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
};

describe("web T7：停止与子代理面", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  const closers: Array<() => void> = [];
  let prevHome: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t7-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-t7-cwd-"));
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

  it("① POST /cancel → {ok:true}；turn/end kind=interrupted 事件回流（SSE ev 帧 + GET events 双面）+ busy 归 false；未知 sid 404", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const hang = await hangingProvider();
    closers.push(hang.close);
    writeProviderConfig(home, hang.url);
    await seedSession(home, cwd, "s_cancel");
    const s = await startWeb(home, cwd, "s_cancel");

    const before = await latestEvents(s, "s_cancel");
    const lastSeq = before.length > 0 ? before[before.length - 1]!.seq : 0;
    const sse = openSse(s, `/api/sessions/s_cancel/stream?after=${lastSeq}`);

    const r0 = await postJson(s, "/api/sessions/s_cancel/send", { text: "慢慢想" });
    expect(r0.status).toBe(202);
    await waitFor(async () => (await getStatus(s, "s_cancel")).busy === true); // 挂起 provider：turn 起不收尾

    const c = await postJson(s, "/api/sessions/s_cancel/cancel", {});
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual({ ok: true });
    const nf = await postJson(s, "/api/sessions/s_none/cancel", {});
    expect(nf.status).toBe(404);

    // turn/end kind=interrupted 回流（SSE ev 帧——D11 stop 键 / D12 双击 Esc 的回流面）
    await sse.until((fs) => fs.some((f) => f.event === "ev" && f.data.includes("turn/end") && f.data.includes("interrupted")));
    await waitFor(async () => hsIdle(s, "s_cancel"));
    // 持久面复核（GET events）：interrupted 终局落盘
    const evs = (await latestEvents(s, "s_cancel")).filter((e) => e.seq > lastSeq);
    expect(evs.some((e) => e.type === "turn/end" && (e as { kind?: string }).kind === "interrupted")).toBe(true);

    sse.destroy();
    await s.stop();
  }, 60_000);

  it("①钉 POST /cancel 不 resolve 挂起的 interaction 卡（T5 既定语义——turn 阻塞至卡片应答；双击 Esc 连带 answer 是 T16 职责）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const prov = await fakeOpenaiMain("echo pin-card");
    closers.push(prov.close);
    writeProviderConfig(home, prov.url);
    await seedSession(home, cwd, "s_pincard");
    const s = await startWeb(home, cwd, "s_pincard");

    const before = await latestEvents(s, "s_pincard");
    const lastSeq = before.length > 0 ? before[before.length - 1]!.seq : 0;
    const sse = openSse(s, `/api/sessions/s_pincard/stream?after=${lastSeq}`);
    const r = await postJson(s, "/api/sessions/s_pincard/send", { text: "跑一下命令" });
    expect(r.status).toBe(202);
    await sse.until((fs) => fs.some((f) => f.event === "interaction"));
    const frame = JSON.parse(sse.frames.find((f) => f.event === "interaction")!.data) as { id: string; kind: string };
    expect(frame.kind).toBe("choose");

    // cancel 受理——但卡不被清（phase 仍 waiting-approval、busy 仍 true：turn 卡在工具等待）
    const c = await postJson(s, "/api/sessions/s_pincard/cancel", {});
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual({ ok: true });
    const st = await getStatus(s, "s_pincard");
    expect(st.phase).toBe("waiting-approval");
    expect(st.busy).toBe(true);

    // 晚连客户端经 pending 重放源见卡（cancel 后卡还在——刷新/断连面同形）
    const sse2 = openSse(s, `/api/sessions/s_pincard/stream?after=${lastSeq}`);
    await sse2.until((fs) => fs.some((f) => f.event === "interaction" && f.data.includes(frame.id)));

    // 卡片照常可答（T16 双击 Esc = POST /answer {cancelled} 的服务端前提）；答后 turn 以 interrupted 收场
    const a = await postJson(s, "/api/sessions/s_pincard/answer", { id: frame.id, cancelled: true });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    await sse.until((fs) => fs.some((f) => f.event === "ev" && f.data.includes("tool/result") && f.data.includes("已取消")));
    await waitFor(async () => hsIdle(s, "s_pincard"));

    sse.destroy();
    sse2.destroy();
    await s.stop();
  }, 120_000);

  it("② GET /tasks：活名册 ∪ 盘上历史去重（同 id 活行优先无 historical 标）+ 历史行 historical:true + 最新在最上", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const prov = await fakeOpenaiSub("echo roster-ok");
    closers.push(prov.close);
    writeProviderConfig(home, prov.url);
    await seedSession(home, cwd, "s_roster");
    const s = await startWeb(home, cwd, "s_roster");

    const r = await postJson(s, "/api/sessions/s_roster/send", { text: "派个后台单" });
    expect(r.status).toBe(202);
    // 活行挂审批（后台单 bash 触发 park）
    const live = await waitForRow(s, "s_roster", (row) => row.pendingApproval !== undefined);
    expect(live.status).toBe("running");
    expect(live.background).toBe(true);
    expect(live.label).toBe("后台跑数");

    // fabricate 盘上历史（旧单 completed——活单的盘上文件同在，去重面由此覆盖）
    fabricateAgentJsonl(home, cwd, "s_roster", "aaaa0042", [
      { v: 1, id: "h1", ts: "2026-01-01T00:00:00.000Z", type: "session/header", parentSession: null },
      { v: 1, id: "h2", ts: "2026-01-01T00:00:01.000Z", type: "user/message", content: [{ kind: "text", text: "旧任务" }] },
      { v: 1, id: "h3", ts: "2026-01-01T00:00:02.000Z", type: "turn/step" },
      { v: 1, id: "h4", ts: "2026-01-01T00:01:00.000Z", type: "turn/end", kind: "completed" },
    ]);

    const rows = await getTasks(s, "s_roster");
    // 去重：活 id 恰一行（盘上同名目录的历史重建行被滤——活名册优先，状态新鲜带 pendingApproval）
    expect(rows.filter((x) => x.id === live.id)).toHaveLength(1);
    const liveOut = rows.find((x) => x.id === live.id)!;
    expect("historical" in liveOut).toBe(false);
    expect(liveOut.pendingApproval?.tool).toBe("tool-shell__bash");
    // 历史行带标 + 状态按 turn/end 推断
    const hist = rows.find((x) => x.id === "aaaa0042");
    expect(hist?.historical).toBe(true);
    expect(hist?.status).toBe("completed");
    // 最新在最上（活行 now > 历史 2026-01-01）
    expect(rows[0]!.id).toBe(live.id);
    // 未知 sid → 404
    const nf = await fetch(`${s.base}/api/sessions/s_none/tasks`, { headers: s.auth });
    expect(nf.status).toBe(404);

    await s.stop();
  }, 120_000);

  it("③ pendingApproval 行 → POST subagents/:id/approval {allow:true} → 子代理继续（bash 放行真跑 → 行转 completed → transcript 落 tool/result）；幂等 noop/400/404 面", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const prov = await fakeOpenaiSub("echo approve-ok");
    closers.push(prov.close);
    writeProviderConfig(home, prov.url);
    await seedSession(home, cwd, "s_appr3");
    const s = await startWeb(home, cwd, "s_appr3");

    const r = await postJson(s, "/api/sessions/s_appr3/send", { text: "派个后台单" });
    expect(r.status).toBe(202);
    const row = await waitForRow(s, "s_appr3", (x) => x.pendingApproval !== undefined);
    expect(row.pendingApproval?.tool).toBe("tool-shell__bash");
    expect(row.pendingApproval?.reason).toContain("subprocess"); // ask-risky 出厂档：subprocess 需确认

    // 放行 → 子代理继续（park resolve(true) → 工具真跑 → 结论轮收尾 → 行转 completed）
    const a = await postJson(s, `/api/sessions/s_appr3/subagents/${row.id}/approval`, { allow: true });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    const done = await waitForRow(s, "s_appr3", (x) => x.id === row.id && x.status === "completed");
    expect(done.pendingApproval).toBeUndefined();
    expect(done.endedAt).toBeDefined();

    // transcript 回放：tool/result 带 echo 输出（子代理继续的实证——工具真跑了）
    const ev = await fetch(`${s.base}/api/sessions/s_appr3/subagents/${row.id}/events`, { headers: s.auth });
    expect(ev.status).toBe(200);
    const eb = (await ev.json()) as { events: Array<{ type: string; output?: unknown }> };
    expect(eb.events.some((e) => e.type === "tool/result" && String(e.output).includes("approve-ok"))).toBe(true);

    // 幂等：已答/无挂起审批（未知 id）→ noop 形
    const a2 = await postJson(s, `/api/sessions/s_appr3/subagents/${row.id}/approval`, { allow: true });
    expect(a2.status).toBe(200);
    expect(await a2.json()).toEqual({ ok: true, noop: true });
    const a3 = await postJson(s, "/api/sessions/s_appr3/subagents/00000000/approval", { allow: true });
    expect(a3.status).toBe(200);
    expect(await a3.json()).toEqual({ ok: true, noop: true });
    // 缺 allow / 非布尔 → 400；未知 sid → 404；坏 JSON → 400
    const noAllow = await postJson(s, `/api/sessions/s_appr3/subagents/${row.id}/approval`, {});
    expect(noAllow.status).toBe(400);
    const badAllow = await postJson(s, `/api/sessions/s_appr3/subagents/${row.id}/approval`, { allow: "yes" });
    expect(badAllow.status).toBe(400);
    const nf = await postJson(s, "/api/sessions/s_none/subagents/00000000/approval", { allow: true });
    expect(nf.status).toBe(404);
    const bad = await fetch(`${s.base}/api/sessions/s_appr3/subagents/${row.id}/approval`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: "不是 json" });
    expect(bad.status).toBe(400);

    await s.stop();
  }, 120_000);

  it("④ GET subagents/:id/events：transcript 回放末 500 条截断（自创值）+ 路由面（未知 sid 404、未知 id 空 events）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home, "http://127.0.0.1:9"); // 引导门放行（死端口——本用例不发 prompt）
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_ev04");
    // fabricate 600 行子代理 jsonl（agentEventsFromFile 末 500 截断的确定性输入）
    fabricateAgentJsonl(home, cwd, "s_ev04", "eeee0400", Array.from({ length: 600 }, (_, i) => ({
      v: 1, id: `e${i}`, ts: `2026-01-01T00:00:00.000Z`, type: "assistant/message", content: [{ kind: "text", text: `行${i}` }],
    })));
    const s = await startWeb(home, cwd, "s_ev04");

    const r = await fetch(`${s.base}/api/sessions/s_ev04/subagents/eeee0400/events`, { headers: s.auth });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { events: Array<{ id?: string }> };
    expect(b.events).toHaveLength(500); // 末 500（e100..e599——更早去会话文件翻，tasks-cmd 同口径）
    expect(b.events[0]!.id).toBe("e100");
    expect(b.events[b.events.length - 1]!.id).toBe("e599");

    // 未知 sid → 404；未知 id → 空 events（没有可回放的 ≠ 错误）
    const nf = await fetch(`${s.base}/api/sessions/s_none/subagents/eeee0400/events`, { headers: s.auth });
    expect(nf.status).toBe(404);
    const none = await fetch(`${s.base}/api/sessions/s_ev04/subagents/00000000/events`, { headers: s.auth });
    expect(none.status).toBe(200);
    expect(((await none.json()) as { events: unknown[] }).events).toEqual([]);

    // 该 fabricated 单在 /tasks 为历史行（historical:true——无活名册时的纯历史形态）
    const rows = await getTasks(s, "s_ev04");
    expect(rows.some((x) => x.id === "eeee0400" && x.historical === true)).toBe(true);

    await s.stop();
  }, 60_000);

  it("⑤ GET subagents/:id/events 路径面：:id 非 8 位 hex → 400（%2F 单段穿越形态——终审 93d12907 收口）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home, "http://127.0.0.1:9"); // 引导门放行（死端口——本用例不发 prompt）
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_ev05");
    const s = await startWeb(home, cwd, "s_ev05");

    // %2F 在单段内存活分段（server.ts 分段→逐段 decodeURIComponent）→ 解码后 id="y/../../etc"——
    // id 直拼 agents_<id> 文件路径的穿越面，端点入口形态校验拦为 400
    const bad = await fetch(`${s.base}/api/sessions/s_ev05/subagents/y%2F..%2F..%2Fetc/events`, { headers: s.auth });
    expect(bad.status).toBe(400);
    const b = (await bad.json()) as { ok: boolean };
    expect(b.ok).toBe(false);

    await s.stop();
  }, 60_000);
});
