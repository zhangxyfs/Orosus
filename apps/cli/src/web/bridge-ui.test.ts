/** web 批 T5 伴生测试：WebCommandUi 交互桥——brief ①-⑧ 逐条 + 真栈集成。
 *  - 单元件（①-⑦ + 形状面）：直挂 broadcast/presence 探针（帧形状 / 等相位 / settle 纪律 / 幂等 / fail-closed）。
 *  - ⑧（close fail-closed）：HostedSession 注入式 fake harness + webCommandUiFactory（T2 ④ 同款缝）——
 *    close 钩子、等相位驱动（phase() waiting-*）与重放源清空的真实装配面。
 *  - 集成（真栈）：runWebSubcommand + handover 托管 + OpenAI 协议假服务（provider-custom 真翻译层消费——
 *    T4 ⑤ 挂起服务进阶为应答式）：tool-shell__bash(echo …) 在 ask-risky 出厂档触发 ctx.ui.choose →
 *    SSE interaction 帧 → POST /answer 回传 → tool/result 放行 + approval/requested|resolved 落流；
 *    同 id 再答 noop 幂等；晚连客户端经 pending 重放源见卡（T3 ⑨ 联动的真源接线）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { encodeCwd, JsonlSessionStore, type Harness, type SessionEvent } from "@orosus/core";
import { HostedSession } from "./hosted.ts";
import { WebCommandUi, webCommandUiFactory, webCommandUiOf, type InteractionFrame } from "./bridge-ui.ts";
import { ESC_CANCELLED } from "../i18n/protocol-strings.ts";
import { runWebSubcommand } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";

/** 轮询等待（25ms 步进；谓词可异步；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** 微任务让步（hang 的 Promise 体同步执行——broadcast 已可见即可）。 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---------- 单元件工具 ----------

/** 直挂探针的 WebCommandUi（帧序列 + setWaiting 调用序列全量可断言）。 */
const makeUi = (): { ui: WebCommandUi; frames: InteractionFrame[]; waiting: Array<"approval" | "input" | null> } => {
  const frames: InteractionFrame[] = [];
  const waiting: Array<"approval" | "input" | null> = [];
  const ui = new WebCommandUi({ broadcast: (f) => frames.push(f), presence: { setWaiting: (k) => waiting.push(k) } });
  return { ui, frames, waiting };
};

/** 注入式 fake harness（T2 ④ 同款缝——⑧ 的 close 钩子面不装配真模块图）。
 *  events 首吐一条 turn/start（2026-10-12 走查修适配：phase() 的 waiting 相位只在 busy 期生效——
 *  ⑧ 的「挂起期 waiting-approval」断言须有活 turn 承载，与生产路径同构）。 */
const makeFakeHarness = (sid: string): Harness => {
  let stopped = false;
  const idle = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return {
    sessionId: sid,
    prompt: async () => undefined,
    cancel: () => {},
    steer: () => false,
    events: () => (async function* () {
      yield { v: 1, id: "fake-turn-1", parentId: null, seq: 1, ts: new Date().toISOString(), type: "turn/start" };
      await idle();
      yield* [];
    })(),
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
  };
};

// ---------- 真栈工具（T4 send.test.ts 同款） ----------

/** 引导门放行形态 config.toml（type = "openai"——provider-custom 槽 schema 必填协议族；baseUrl 指向假服务）。 */
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

/** 真栈起服 + handover 托管种子会话（T4 同款）。 */
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

/** SSE 连接收集器（帧按空行切分——interaction/ev 帧断言用）。 */
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

/** POST answer（JSON 体——T1 写方法护栏合规形态）。 */
const postAnswer = (s: Stack, sid: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${s.base}/api/sessions/${sid}/answer`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify(body) });

/** POST send（同口径）。 */
const postSend = (s: Stack, sid: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${s.base}/api/sessions/${sid}/send`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify(body) });

// ---------- OpenAI 协议假服务（provider-custom 真翻译层消费） ----------

const oaiText = (text: string): string =>
  JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const oaiToolCall = (callId: string, name: string, args: string): string =>
  JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: args } }] }, finish_reason: null }] });
const oaiFinish = (reason: string): string =>
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

/** 应答式 OpenAI 假服务：主对话请求（无 tool 尾消息）→ 回 toolcall（tool-shell__bash cmd）；
 *  工具结果后请求（wire role "tool"——translate-openai.ts:77 投影形）→ 回文本收尾；autoTitle 请求
 *  （system 含「标题」）→ 回短文本。requests 收集供断言。 */
const fakeOpenai = async (cmd: string): Promise<{ url: string; requests: Array<Record<string, unknown>>; close: () => void }> => {
  const requests: Array<Record<string, unknown>> = [];
  let fresh = 0;
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { /* 坏体按空 */ }
      requests.push(body);
      const msgs = Array.isArray(body["messages"]) ? (body["messages"] as Array<{ role?: string; content?: unknown }>) : [];
      // system 在 wire messages[0] 而非顶层字段（translate-openai.ts:60 投影形——fakeOpenaiSub 同读法；
      // 顶层 body["system"] 恒空，isTitle 分支曾因此不可达）
      const sys = msgs[0]?.role === "system" && typeof msgs[0]?.content === "string" ? msgs[0].content : "";
      const hasTools = Array.isArray(body["tools"]) && (body["tools"] as unknown[]).length > 0;
      const last = msgs.at(-1);
      const isTitle = !hasTools && sys.includes("标题");
      const afterTool = last?.role === "tool";
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames = isTitle || afterTool
        ? [oaiText(isTitle ? "测试会话" : "本轮完成"), oaiFinish("stop")]
        : (() => { fresh += 1; return [oaiToolCall(`c${fresh}`, "tool-shell__bash", JSON.stringify({ command: cmd })), oaiFinish("tool_calls")]; })();
      for (const f of frames) res.write(`data: ${f}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => { srv.close(); srv.closeAllConnections?.(); } };
};

describe("web T5：WebCommandUi 交互桥（单元件）", () => {
  it("① choose 挂起 → 广播 interaction 帧（kind/title/items/id）→ answer 回传选中项原文 resolve", async () => {
    const { ui, frames } = makeUi();
    const p = ui.choose("工具执行确认", ["批准一次", "拒绝"]);
    await tick();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "choose", title: "工具执行确认", items: ["批准一次", "拒绝"] });
    expect(typeof frames[0]!.id).toBe("string");
    expect(ui.answer(frames[0]!.id, "批准一次")).toBe(true);
    await expect(p).resolves.toBe("批准一次"); // 选中项原文（§3 choose 应答形态）
  });

  it("② cancel → reject「已取消（Esc）」（approval 拒绝路径同 TUI Esc）；confirm 的 cancel 按契约折 false；再 cancel 同 id 幂等", async () => {
    const { ui, frames } = makeUi();
    const pChoose = ui.choose("确认", ["a", "b"]);
    await tick();
    ui.cancel(frames[0]!.id);
    await expect(pChoose).rejects.toThrow(ESC_CANCELLED);
    expect(() => ui.cancel(frames[0]!.id)).not.toThrow(); // 已 settle 的 id 再 cancel = noop
    // confirm 取消 = false（契约：Esc 折为 false——语义内 fail-closed 不抛错，menu.ts confirm 同款）
    const pConfirm = ui.confirm("执行吗");
    await tick();
    ui.cancel(frames[1]!.id);
    await expect(pConfirm).resolves.toBe(false);
  });

  it("③ askSecret 帧带 secret:true；ask 帧无 secret 键（明文问询不误标）", async () => {
    const { ui, frames } = makeUi();
    void ui.ask("叫什么");
    void ui.askSecret("密钥");
    await tick();
    expect(frames[0]).toMatchObject({ kind: "ask", title: "叫什么" });
    expect("secret" in frames[0]!).toBe(false);
    expect(frames[1]).toMatchObject({ kind: "askSecret", title: "密钥", secret: true });
  });

  it("④ confirm answer \"false\" → false；\"true\" → true（§3 字符串形态归一）", async () => {
    const { ui, frames } = makeUi();
    const p1 = ui.confirm("第一问");
    await tick();
    ui.answer(frames[0]!.id, "false");
    await expect(p1).resolves.toBe(false);
    const p2 = ui.confirm("第二问");
    await tick();
    ui.answer(frames[1]!.id, "true");
    await expect(p2).resolves.toBe(true);
  });

  it("⑤ chooseEx：帧带 items+multi（单选不带 multi 键）；answer 多选数组 resolve", async () => {
    const { ui, frames } = makeUi();
    const p = ui.chooseEx("发布前检查", ["lint", "test"], { multi: true });
    await tick();
    expect(frames[0]).toMatchObject({ kind: "chooseEx", title: "发布前检查", items: ["lint", "test"], multi: true });
    ui.answer(frames[0]!.id, ["lint", "test"]);
    await expect(p).resolves.toEqual(["lint", "test"]);
    const pSingle = ui.chooseEx("单选检查", ["甲", "乙"]);
    await tick();
    expect("multi" in frames[1]!).toBe(false);
    ui.answer(frames[1]!.id, ["乙"]);
    await expect(pSingle).resolves.toEqual(["乙"]);
  });

  it("⑥ 挂起期间 presence.setWaiting 被调（choose→approval、ask→input），应答后清 null（presence.ts:119 语义）", async () => {
    const { ui, frames, waiting } = makeUi();
    const pC = ui.choose("审批", ["允许", "拒绝"]);
    await tick();
    expect(waiting).toEqual(["approval"]);
    ui.answer(frames[0]!.id, "允许");
    await pC;
    expect(waiting).toEqual(["approval", null]);
    const pA = ui.ask("说句话");
    await tick();
    expect(waiting).toEqual(["approval", null, "input"]);
    ui.answer(frames[1]!.id, "文本回答");
    await pA;
    expect(waiting).toEqual(["approval", null, "input", null]);
  });

  it("⑦ answer 幂等：已 settle 的 id 再 answer → false（noop）不抛、不二次投递；未知 id 同 noop", async () => {
    const { ui, frames } = makeUi();
    const p = ui.choose("幂等", ["x", "y"]);
    await tick();
    expect(ui.answer(frames[0]!.id, "x")).toBe(true);
    await expect(p).resolves.toBe("x");
    expect(ui.answer(frames[0]!.id, "y")).toBe(false); // 晚到/重复应答——先到先得
    expect(ui.answer("从不存在", "x")).toBe(false); // 未知 id 同形 noop
    await expect(p).resolves.toBe("x"); // 仍是首答值（Map 项已删——settle 纪律防重入双投递）
  });

  it("⑧ HostedSession.close() → 全部挂起 interaction fail-closed（choose/ask reject 已取消（Esc）、confirm 折 false）+ 等相位清位 + 重放源清空；close 幂等", async () => {
    const home = mkdtempSync(join(tmpdir(), "orosus-web-t5-ui-"));
    process.env["OROSUS_HOME"] = home;
    try {
      const hs = new HostedSession({ cwd: home, commandUi: webCommandUiFactory, harness: makeFakeHarness("s_close"), sessionsRoot: join(home, "sessions") });
      await hs.ready;
      await tick(); // events 泵先吞 fake turn/start（turnActive 置位——等相位须在 turn 内；后挂交互避免被 turn/start 复位）
      const ui = webCommandUiOf(hs);
      expect(ui).toBeInstanceOf(WebCommandUi);
      const pChoose = ui!.choose("审批卡", ["批准一次", "拒绝"]);
      const pAsk = ui!.ask("问询卡");
      const pConfirm = ui!.confirm("确认卡");
      await tick();
      expect(ui!.pendingFrames()).toHaveLength(3); // 挂起序 = 重放序
      expect(hs.phase()).toBe("waiting-approval"); // 等相位驱动（最后挂起 = confirm → approval 族）
      await hs.close();
      await expect(pChoose).rejects.toThrow(ESC_CANCELLED);
      await expect(pAsk).rejects.toThrow(ESC_CANCELLED);
      await expect(pConfirm).resolves.toBe(false); // fail-closed 语义内（confirm 折 false）
      expect(ui!.pendingFrames()).toEqual([]); // 重放源已清——重连不再重放死卡
      expect(hs.phase()).toBe("idle"); // 等相位清位
      await hs.close(); // 幂等（第二次不重复 reject）
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows 句柄迟到留给系统 tmp */ }
    }
  }, 30_000);

  it("形状面：choose 应答不在候选清单 → fail-closed reject（不静默放行）；viewText/notice 单向帧即完成（不进 pending、应答 noop）", async () => {
    const { ui, frames } = makeUi();
    const p = ui.choose("校验", ["甲", "乙"]);
    await tick();
    ui.answer(frames[0]!.id, "伪造项");
    await expect(p).rejects.toThrow("候选清单"); // 契约硬校验——choose 返回值 ∈ items
    ui.viewText("便签", "内容一行", { markdown: true });
    ui.notice("已导出 3 条便签", { durationMs: 8000 });
    await tick();
    expect(frames[1]).toMatchObject({ kind: "viewText", title: "便签", text: "内容一行", markdown: true });
    expect(frames[2]).toMatchObject({ kind: "notice", text: "已导出 3 条便签", durationMs: 8000 }); // 契约 [1000,30000] 钳位
    expect(ui.pendingFrames()).toEqual([]); // 单向帧不挂起
    expect(ui.answer(frames[1]!.id, "x")).toBe(false); // 应答单向帧 = noop
  });

  it("形状面：chooseSide 帧带 items+values+sideLabel；answer {item,value} 对 resolve；空表入口即拒（CR-05 同款）", async () => {
    const { ui, frames } = makeUi();
    const p = ui.chooseSide("选模型", ["a-低配", "b-高配"], {
      side: { label: "思考", valuesOf: (item) => (item.startsWith("a-") ? ["低", "高"] : undefined) },
    });
    await tick();
    expect(frames[0]).toMatchObject({
      kind: "chooseSide", title: "选模型", items: ["a-低配", "b-高配"],
      values: { "a-低配": ["低", "高"] }, sideLabel: "思考", // 无横选项不进 values（行降级显「——」）
    });
    ui.answer(frames[0]!.id, { item: "a-低配", value: "高" });
    await expect(p).resolves.toEqual({ item: "a-低配", value: "高" }); // 契约返回形 {item,value}
    await expect(ui.choose("空表", [])).rejects.toThrow("无可选项"); // 空表 = 不可答的挂死卡，入口即拒
    await expect(ui.chooseEx("空表", [])).rejects.toThrow("无可选项");
  });
});

describe("web T5：审批全链路（真栈 + OpenAI 协议假服务）", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  const closers: Array<() => void> = [];
  let prevHome: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t5-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-t5-cwd-"));
    cwds.push(c);
    return c;
  };

  beforeEach(() => {
    prevHome = process.env["OROSUS_HOME"];
  });

  afterEach(() => {
    shutdownWebServer("test-cleanup");
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

  it("集成（放行链）：ask-risky 触发 ctx.ui.choose → SSE interaction 帧 → POST answer 批准一次 → tool/result 放行 + approval 事件落流；晚连客户端重放见卡；同 id 再答 noop", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const prov = await fakeOpenai("echo web-t5-ok");
    closers.push(prov.close);
    writeProviderConfig(home, prov.url);
    await seedSession(home, cwd, "s_appr");
    const s = await startWeb(home, cwd, "s_appr");

    const before = await latestEvents(s, "s_appr");
    const lastSeq = before.length > 0 ? before[before.length - 1]!.seq : 0;
    const sse = openSse(s, `/api/sessions/s_appr/stream?after=${lastSeq}`);

    const r = await postSend(s, "s_appr", { text: "跑一下命令" });
    expect(r.status).toBe(202);

    // interaction 帧到达（approval 弹窗四行标题 + 四选项，ask-risky 出厂档）
    await sse.until((fs) => fs.some((f) => f.event === "interaction"));
    const frame = JSON.parse(sse.frames.find((f) => f.event === "interaction")!.data) as { id: string; kind: string; title: string; items: string[] };
    expect(frame.kind).toBe("choose");
    expect(frame.title).toContain("tool-shell__bash"); // 规则行（approvalRule）
    expect(frame.items).toContain("批准一次");
    expect(frame.items).toContain("拒绝");

    // 挂起期 status.phase = waiting-approval（等相位驱动——presence 同五值）
    const st = await fetch(`${s.base}/api/sessions/s_appr/status`, { headers: s.auth });
    expect(((await st.json()) as { phase?: string }).phase).toBe("waiting-approval");

    // 晚连客户端：pending 重放源（断连/刷新后审批卡还在——id 复用）
    const sse2 = openSse(s, `/api/sessions/s_appr/stream?after=${lastSeq}`);
    await sse2.until((fs) => fs.some((f) => f.event === "interaction" && f.data.includes(frame.id)));

    // 批准一次 → tool/result 放行 + approval/resolved(allow-once) 落流
    const a = await postAnswer(s, "s_appr", { id: frame.id, value: "批准一次" });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    await sse.until((fs) => fs.some((f) => f.event === "ev" && f.data.includes("approval/resolved") && f.data.includes("allow-once")));
    await sse.until((fs) => fs.some((f) => f.event === "ev" && f.data.includes("tool/result") && f.data.includes("web-t5-ok")));

    // 同 id 再答 → noop 幂等（多端抢答先到先得）
    const a2 = await postAnswer(s, "s_appr", { id: frame.id, value: "拒绝" });
    expect(a2.status).toBe(200);
    expect(await a2.json()).toEqual({ ok: true, noop: true });

    // 事件面复核（GET events）：approval/requested 在前、resolved(allow-once)、tool/result 非错
    const evs = (await latestEvents(s, "s_appr")).filter((e) => e.seq > lastSeq);
    expect(evs.some((e) => e.type === "approval/requested")).toBe(true);
    const resolved = evs.find((e) => e.type === "approval/resolved") as { decision?: string } | undefined;
    expect(resolved?.decision).toBe("allow-once");
    const tr = evs.find((e) => e.type === "tool/result") as { output?: string; isError?: boolean } | undefined;
    expect(tr?.output).toContain("web-t5-ok"); // 命令真跑（echo 输出）
    expect(tr?.isError).toBe(false);
    await waitFor(async () => hsIdle(s, "s_appr"));

    sse.destroy();
    sse2.destroy();
    await s.stop();
  }, 120_000);

  it("集成（拒绝链 + 路由面）：cancelled:true → tool denied + approval/resolved(deny)；缺 id/坏 JSON 400、未知 sid 404、未知 id noop", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const prov = await fakeOpenai("echo deny-me");
    closers.push(prov.close);
    writeProviderConfig(home, prov.url);
    await seedSession(home, cwd, "s_deny");
    const s = await startWeb(home, cwd, "s_deny");

    // 路由守卫（无需挂起交互）：
    const noId = await postAnswer(s, "s_deny", { value: "x" });
    expect(noId.status).toBe(400);
    const bad = await fetch(`${s.base}/api/sessions/s_deny/answer`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: "不是 json" });
    expect(bad.status).toBe(400);
    const nf = await fetch(`${s.base}/api/sessions/s_none/answer`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify({ id: "w1" }) });
    expect(nf.status).toBe(404);
    const unknown = await postAnswer(s, "s_deny", { id: "w999", value: "x" });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: true, noop: true });

    // 拒绝链：Esc 语义（cancelled:true → server 侧 throw 已取消（Esc）→ waterfall 否决 → tool denied）
    const before = await latestEvents(s, "s_deny");
    const lastSeq = before.length > 0 ? before[before.length - 1]!.seq : 0;
    const sse = openSse(s, `/api/sessions/s_deny/stream?after=${lastSeq}`);
    const r = await postSend(s, "s_deny", { text: "再跑一次" });
    expect(r.status).toBe(202);
    await sse.until((fs) => fs.some((f) => f.event === "interaction"));
    const frame = JSON.parse(sse.frames.find((f) => f.event === "interaction")!.data) as { id: string };

    const a = await postAnswer(s, "s_deny", { id: frame.id, cancelled: true });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    // Esc 语义：choose reject「已取消（Esc）」→ waterfall 监听者抛错视为否决 → tool/result denied 带内
    await sse.until((fs) => fs.some((f) => f.event === "ev" && f.data.includes("tool/result") && f.data.includes("已取消")));

    const evs = (await latestEvents(s, "s_deny")).filter((e) => e.seq > lastSeq);
    const tr = evs.find((e) => e.type === "tool/result") as { output?: string; isError?: boolean; denied?: boolean } | undefined;
    expect(tr?.isError).toBe(true); // 否决形（fail-closed）
    expect(tr?.denied).toBe(true);
    expect(tr?.output).toContain(ESC_CANCELLED); // Esc 字面量随否决理由带内
    // approval 模块的 Esc 路径不落 approval/resolved（choose 抛错先于 append——上游既有语义，TUI Esc 同形；
    // resolved 事件只在选项路径〔批准一次/拒绝〕发生，见放行链用例）
    expect(evs.some((e) => e.type === "approval/resolved")).toBe(false);
    await waitFor(async () => hsIdle(s, "s_deny"));

    sse.destroy();
    await s.stop();
  }, 120_000);
});

/** status.phase 回 idle（turn 收尾轮询锚）。 */
const hsIdle = async (s: Stack, sid: string): Promise<boolean> => {
  const r = await fetch(`${s.base}/api/sessions/${sid}/status`, { headers: s.auth });
  const b = (await r.json()) as { phase?: string; busy?: boolean };
  return b.phase === "idle" && b.busy === false;
};

describe("web dialog T4：WebCommandUi.dialog 桥接（设计 12.1-6/7/8 桥面）", () => {
  it("① dialog 是自有属性：描述符拷贝后可用；owner 经 spec 注入贯通 relay（ownerTagUi 包装同机制）", () => {
    const { ui } = makeUi();
    expect(Object.getOwnPropertyDescriptor(ui, "dialog")?.value).toBe(ui.dialog); // 自有属性非原型方法
    const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(ui)) as typeof ui;
    expect(typeof copy.dialog).toBe("function"); // ownerTagUi 的描述符拷贝路径后不丢
    copy.dialog({ title: "窗", widgets: [{ id: "l", kind: "list", interactive: true, items: ["a"] }], owner: "mod-x" }); // ownerTagUi 机制 = {...spec, owner}
    expect(ui.dialogRelay.snapshotFrame()).toMatchObject({ op: "open" });
    ui.dialogRelay.closeByOwner("mod-x"); // owner 贯通到 relay record（卸载关窗判据）
    expect(ui.dialogRelay.snapshotFrame()).toBeUndefined();
  });

  it("② viewText supersede：dialog → viewText 帧序 [open, close, viewText]；帧带真实 title 与 layout（缺省无 layout 键零回归）", () => {
    const { ui, frames } = makeUi();
    ui.dialog({ title: "列表窗", widgets: [{ id: "l", kind: "list", interactive: true, items: ["a"] }] });
    ui.viewText("记忆 · 索引", "# 正文", { markdown: true, layout: "full" });
    expect(frames.map((f) => f.kind)).toEqual(["dialog", "dialog", "viewText"]); // open → close（supersede）→ viewText
    expect(frames[1]).toMatchObject({ op: "close" });
    expect(frames[2]).toMatchObject({ title: "记忆 · 索引", markdown: true, layout: "full" }); // 布局保留 + 真实标题（设计 §9）
    expect(ui.dialogRelay.snapshotFrame()).toBeUndefined();
    frames.length = 0;
    ui.viewText("帮助", "纯文本"); // 缺省：无 layout 键（dock 行为零回归）
    expect("layout" in frames[0]!).toBe(false);
  });

  it("③ 可答交互 supersede、notice 不动 dialog：ask 前关窗；notice 后窗仍在", async () => {
    const { ui, frames } = makeUi();
    ui.dialog({ title: "窗", widgets: [{ id: "l", kind: "list", interactive: true, items: ["a"] }] });
    frames.length = 0;
    const p = ui.ask("问询");
    p.catch(() => {}); // cancel 清场 = fail-closed reject——预挂吞咽防 unhandled rejection
    await tick();
    expect(frames.map((f) => f.kind)).toEqual(["dialog", "ask"]); // close（supersede）+ ask
    expect(frames[0]).toMatchObject({ op: "close" });
    ui.cancel(frames[1]!.id); // 清挂起（不留在 pending 影响后续用例）
    await tick();
    frames.length = 0;
    ui.dialog({ title: "窗2", widgets: [{ id: "l", kind: "list", interactive: true, items: ["a"] }] });
    ui.notice("提示");
    expect(ui.dialogRelay.snapshotFrame()).toBeDefined(); // notice 只是 toast 不关窗（设计 §5.1）
    expect(frames.some((f) => f.op === "close")).toBe(false);
    ui.dialogRelay.closeActive();
  });

  it("④ pendingFrames：挂起交互在前、活跃 dialog 快照在后（最新 revision）；关窗后不含", async () => {
    const { ui } = makeUi();
    const p = ui.choose("选", ["甲", "乙"]);
    p.catch(() => {}); // cancel 清场 = fail-closed reject——预挂吞咽防 unhandled rejection
    await tick();
    const h = ui.dialog({ title: "窗", widgets: [{ id: "l", kind: "list", interactive: true, items: ["a"] }] })!;
    h.update([{ id: "l", kind: "list", interactive: true, items: ["a", "b"] }]);
    const frames = ui.pendingFrames();
    expect(frames[0]).toMatchObject({ kind: "choose" }); // 挂起在前
    expect(frames[1]).toMatchObject({ kind: "dialog", op: "open", revision: 2 }); // 快照在后、revision 最新（设计 §6.1）
    h.close();
    expect(ui.pendingFrames()).toHaveLength(1); // 关窗后重放源不含 dialog
    ui.cancel((frames[0] as { id: string }).id);
    await tick();
  });

  it("⑤ 工厂 close 钩子：会话销毁走服务端关窗路径（relay 关窗 + harness 引用摘除防悬挂）", async () => {
    const home = mkdtempSync(join(tmpdir(), "orosus-web-t5-dlg-"));
    process.env["OROSUS_HOME"] = home;
    try {
      const hs = new HostedSession({ cwd: home, commandUi: webCommandUiFactory, harness: makeFakeHarness("s_dlg"), sessionsRoot: join(home, "sessions") });
      await hs.ready;
      await tick();
      const ui = webCommandUiOf(hs)!;
      ui.dialog({ title: "窗", widgets: [{ id: "l", kind: "list", interactive: true, items: ["a"] }] });
      expect(ui.dialogRelay.snapshotFrame()).toBeDefined();
      await hs.close();
      expect(ui.dialogRelay.snapshotFrame()).toBeUndefined(); // close 钩子：relay 关窗（broadcast 对已断流无人收——设计 §6.3）
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows 句柄迟到留给系统 tmp */ }
    }
  }, 30_000);
});
