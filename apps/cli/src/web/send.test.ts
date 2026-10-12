/** web 批 T4 伴生测试：消息发送 + 附件与 @ 引用——brief ①-⑦ 逐条（外加 promptId admission
 *  256 上限直测〔§5 自创值〕与 /api/at 数据源）。全部走真栈（runWebSubcommand + handover 托管
 *  种子会话——T2 ⑥/T3 路由层同款先例）：
 *  ①②③⑥⑦ 用死端口 provider（连接拒绝快速带内收尾——user/message 照落，202「受理即回」的
 *  断言反而干净）；⑤ busy 面经「挂起 provider」——真 provider-custom 槽指向只收不断的本地
 *  HTTP 挂起服务，openai 流悬停 = turn 不收尾 = busy 恒真。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { encodeCwd, JsonlSessionStore, type Harness, type SessionEvent } from "@orosus/core";
import type { CommandUi } from "@orosus/contracts/module";
import { runWebSubcommand, webHostPool } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";
import { HostedSession } from "./hosted.ts";

/** 轮询等待（25ms 步进；谓词可异步；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** 1x1 PNG（67 字节——宽高经 IHDR 解析 = 1×1；upload 断言 width/height 用）。 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** 引导门放行形态 config.toml（T1/T2 同款 + type = "openai"——provider-custom 槽 schema 必填
 *  协议族，缺则模块激活失败 provider 不可用〔⑤ 调试实锤〕；baseUrl/附加顶层键可覆写——⑦ 用
 *  effort+[approval]、⑤ 用挂起服务端口）。TOML 顶层标量必须在任何 [节] 之前——附加行拼在 model 后。 */
const writeProviderConfig = (home: string, opts: { baseUrl?: string; topKeys?: string[]; sections?: string[] } = {}): void => {
  const top = [`model = "demo/model-x"`, ...(opts.topKeys ?? [])].join("\n");
  const sections = [
    ...(opts.sections ?? []),
    "[provider-custom.providers.demo]",
    `baseUrl = "${opts.baseUrl ?? "http://127.0.0.1:9"}"`,
    'type = "openai"',
  ].join("\n");
  writeFileSync(join(home, "config.toml"), `${top}\n\n${sections}\n`, "utf8");
};

/** 种子会话（header-only；可选 label——⑦ status 断言用）。 */
const seedSession = async (home: string, cwd: string, sid: string, label?: string): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  if (label !== undefined) await store.append("session/label", { label });
  await store.close();
};

interface Stack {
  base: string;
  port: number;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}

/** 真栈起服 + handover 托管种子会话（T3 路由层同款）：返回 base/auth/stop。 */
const startWeb = async (home: string, cwd: string, sid: string): Promise<Stack> => {
  const lines: string[] = [];
  const run = runWebSubcommand(["web", "--no-open"], { out: (l) => lines.push(l), env: { OROSUS_HOME: home } }, { resumeSid: sid, cwd });
  await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
  const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
  return {
    base: `http://127.0.0.1:${inst.port}`,
    port: inst.port,
    auth: { "x-orosus-token": inst.token, connection: "close" }, // connection:close——每用例新 server 常复用首选端口，防 undici 池死套接字复用（fetch failed）
    stop: async () => {
      shutdownWebServer("test");
      await run;
    },
  };
};

/** POST send（JSON 体——content-type 头即 T1 JSON-only 护栏的客户端侧合规形态）。 */
const postSend = (s: Stack, sid: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${s.base}/api/sessions/${sid}/send`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify(body) });

/** GET events 最新一页（回读断言用）。 */
const latestEvents = async (s: Stack, sid: string): Promise<SessionEvent[]> => {
  const r = await fetch(`${s.base}/api/sessions/${sid}/events`, { headers: s.auth });
  const b = (await r.json()) as { events: SessionEvent[] };
  return b.events;
};

/** SSE 连接收集器（① 事件流断言用）：帧按空行切分（event/data/id 行）；until 轮询等待条件。 */
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

/** 挂起 provider（⑤ busy 面）：真 provider-custom 槽指向的本地 HTTP 服务——收下请求永不回应，
 *  流悬停 = turn 不收尾。 */
const hangingProvider = async (): Promise<{ url: string; close: () => void }> => {
  const srv = createHttpServer(() => { /* 悬停：不回应 */ });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => { srv.close(); srv.closeAllConnections?.(); } };
};

describe("web T4：消息发送 + 附件与 @ 引用", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  const closers: Array<() => void> = [];
  let prevHome: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t4-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-t4-cwd-"));
    cwds.push(c);
    return c;
  };

  beforeEach(() => {
    // OROSUS_HOME 密封（T2 先例）：harness 的 config/logs 缺省面经 orosusHome() 现读 env
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

  it("① send 普通文本 → 202 {ok:true}，SSE 事件流出现 user/message（turn 终值不挂 HTTP）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_plain");
    const s = await startWeb(home, cwd, "s_plain");

    const before = await latestEvents(s, "s_plain");
    const lastSeq = before.length > 0 ? before[before.length - 1]!.seq : 0;
    const sse = openSse(s, `/api/sessions/s_plain/stream?after=${lastSeq}`); // backfill 排除既有事件

    const r = await postSend(s, "s_plain", { text: "你好，web" });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ ok: true }); // 受理即回（无 queued 字段——闲时直发）

    await sse.until((fs) => fs.some((f) => f.event === "ev" && f.data.includes("user/message") && f.data.includes("你好，web")));
    sse.destroy();
    await s.stop();
  }, 60_000);

  it("② send 带 @path → resolveAtRefs 展开进 prompt（content 含 [@path] 附件块），原文经 host/input-echo 保留", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    writeFileSync(join(cwd, "notes.txt"), "行一：引用目标内容", "utf8");
    await seedSession(home, cwd, "s_at");
    const s = await startWeb(home, cwd, "s_at");

    const before = await latestEvents(s, "s_at");
    const lastSeq = before.length > 0 ? before[before.length - 1]!.seq : 0;
    const r = await postSend(s, "s_at", { text: "看下 @notes.txt" });
    expect(r.status).toBe(202);

    await waitFor(async () => (await latestEvents(s, "s_at")).some((e) => e.type === "user/message" && e.seq > lastSeq));
    const evs = (await latestEvents(s, "s_at")).filter((e) => e.seq > lastSeq);
    const userMsg = evs.toReversed().find((e) => e.type === "user/message") as { content?: { kind?: string; text?: string }[] } | undefined;
    expect(userMsg).toBeDefined();
    const text = (userMsg!.content ?? []).map((p) => (p.kind === "text" ? p.text : "")).join("");
    expect(text).toContain("[@notes.txt]"); // 附件块标记（atfile.ts 展开形）
    expect(text).toContain("行一：引用目标内容"); // 文件内容随附着
    const echo = evs.find((e) => e.type === "host/input-echo") as { text?: unknown } | undefined;
    expect(echo).toBeDefined();
    expect(echo!.text).toBe("看下 @notes.txt"); // 原文保留（main.ts:1234 对齐——上键召回取原文）
    await s.stop();
  }, 60_000);

  it("③ 上传 png → 落会话媒资库 + send imageIds → user/message content 出现 image part（护栏豁免：非 JSON 体不被 415）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_img");
    const s = await startWeb(home, cwd, "s_img");

    // 上传：二进制体 + content-type image/png（T1 JSON-only 护栏须按路径豁免——否则此处 415）
    const up = await fetch(`${s.base}/api/uploads?sid=s_img&name=shot.png`, {
      method: "POST",
      headers: { ...s.auth, "content-type": "image/png" },
      body: new Uint8Array(PNG_1X1),
    });
    expect(up.status).toBe(200);
    const uploaded = (await up.json()) as { ok?: boolean; id?: string; path?: string; width?: number; height?: number };
    expect(uploaded.ok).toBe(true);
    expect(uploaded.id).toMatch(/^web-[0-9a-f-]+\.png$/); // m5-media F8 同款落位命名
    expect(uploaded.width).toBe(1); // PNG IHDR 解析（paste.ts imageSize）
    expect(uploaded.height).toBe(1);
    const mediaDir = join(home, "sessions", encodeCwd(cwd), "s_img", "media");
    expect(uploaded.path).toBe(join(mediaDir, uploaded.id!)); // 落会话媒资库（随会话生命周期）
    expect(existsSync(uploaded.path!)).toBe(true);
    expect(Buffer.compare(readFileSync(uploaded.path!), PNG_1X1)).toBe(0); // 字节原样

    // 回显：GET /api/media → 图片字节
    const media = await fetch(`${s.base}/api/media?path=${encodeURIComponent(uploaded.path!)}`, { headers: s.auth });
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("image/png");
    expect(Buffer.compare(Buffer.from(await media.arrayBuffer()), PNG_1X1)).toBe(0);

    // 随消息发送：imageIds → prompt images 生效（core 路径引用透传——user/message image part 只存 path）
    const before = await latestEvents(s, "s_img");
    const lastSeq = before.length > 0 ? before[before.length - 1]!.seq : 0;
    const r = await postSend(s, "s_img", { text: "看这张图", imageIds: [uploaded.id!] });
    expect(r.status).toBe(202);
    await waitFor(async () => (await latestEvents(s, "s_img")).some((e) => e.type === "user/message" && e.seq > lastSeq));
    const evs = (await latestEvents(s, "s_img")).filter((e) => e.seq > lastSeq);
    const userMsg = evs.toReversed().find((e) => e.type === "user/message") as { content?: { kind?: string; path?: string; mimeType?: string }[] } | undefined;
    const imgPart = (userMsg?.content ?? []).find((p) => p.kind === "image");
    expect(imgPart).toBeDefined();
    expect(imgPart!.path).toBe(uploaded.path!);
    expect(imgPart!.mimeType).toBe("image/png");
    await s.stop();
  }, 60_000);

  it("④ /api/media 越权路径 → 403（白名单 = 会话 media 目录：root 外 / root 内非 media / 穿越归一后非 media）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_guard");
    const s = await startWeb(home, cwd, "s_guard");
    const root = join(home, "sessions");
    const mediaDir = join(root, encodeCwd(cwd), "s_guard", "media");

    // home 外（sessions root 之外）
    const r1 = await fetch(`${s.base}/api/media?path=${encodeURIComponent(join(home, "config.toml"))}`, { headers: s.auth });
    expect(r1.status).toBe(403);
    // root 内但不在 media 目录（会话主文件）
    const r2 = await fetch(`${s.base}/api/media?path=${encodeURIComponent(join(root, encodeCwd(cwd), "s_guard", "agents", "session.jsonl"))}`, { headers: s.auth });
    expect(r2.status).toBe(403);
    // 穿越形态：media/../.. 归一后落在 agents——resolve 先归一再白名单判定
    const r3 = await fetch(`${s.base}/api/media?path=${encodeURIComponent(join(mediaDir, "..", "..", "agents", "session.jsonl"))}`, { headers: s.auth });
    expect(r3.status).toBe(403);
    // 白名单内但文件不存在 → 404（不是 403——存在性与越权两码事）
    const r4 = await fetch(`${s.base}/api/media?path=${encodeURIComponent(join(mediaDir, "web-none.png"))}`, { headers: s.auth });
    expect(r4.status).toBe(404);
    // 缺参 → 400
    const r5 = await fetch(`${s.base}/api/media`, { headers: s.auth });
    expect(r5.status).toBe(400);
    await s.stop();
  }, 60_000);

  it("⑤ busy 期 send → {queued,index}；DELETE queue/:index 撤回（再撤 404）——挂起 provider 真栈 busy 面", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    const hang = await hangingProvider();
    closers.push(hang.close);
    writeProviderConfig(home, { baseUrl: hang.url });
    await seedSession(home, cwd, "s_busy");
    const s = await startWeb(home, cwd, "s_busy");

    const busyOf = async (): Promise<boolean> => {
      const r = await fetch(`${s.base}/api/sessions/s_busy/status`, { headers: s.auth });
      const b = (await r.json()) as { busy?: boolean };
      return b.busy === true;
    };
    // 第一条：受理即回（turn 悬停——202 不等整轮）
    const r1 = await postSend(s, "s_busy", { text: "第一条（挂起）" });
    expect(r1.status).toBe(202);
    expect(await r1.json()).toEqual({ ok: true });
    await waitFor(busyOf); // provider 流已起（busy 恒真）

    // busy 期第二条 → 入队
    const r2 = await postSend(s, "s_busy", { text: "排队消息" });
    expect(r2.status).toBe(202);
    expect(await r2.json()).toEqual({ ok: true, queued: true, index: 0 });

    // 撤回（DELETE 携 JSON content-type——T1 写方法护栏合规形态）
    const d1 = await fetch(`${s.base}/api/sessions/s_busy/queue/0`, { method: "DELETE", headers: { ...s.auth, "content-type": "application/json" } });
    expect(d1.status).toBe(200);
    expect(await d1.json()).toEqual({ ok: true });
    // 不在队再撤 → 404（并发撤回按 server 当前表重算）
    const d2 = await fetch(`${s.base}/api/sessions/s_busy/queue/0`, { method: "DELETE", headers: { ...s.auth, "content-type": "application/json" } });
    expect(d2.status).toBe(404);

    await s.stop(); // 清退序 abort 挂起 turn
  }, 60_000);

  it("⑥ promptId 幂等：同 promptId 重复 POST → 第二次 {ok:true,noop:true}，只产生一条 user/message", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_idem");
    const s = await startWeb(home, cwd, "s_idem");

    const before = await latestEvents(s, "s_idem");
    const lastSeq = before.length > 0 ? before[before.length - 1]!.seq : 0;

    const r1 = await postSend(s, "s_idem", { text: "幂等消息", promptId: "retry-1" });
    expect(r1.status).toBe(202);
    expect(await r1.json()).toEqual({ ok: true });
    const r2 = await postSend(s, "s_idem", { text: "幂等消息", promptId: "retry-1" }); // 网络重试同 id
    expect(r2.status).toBe(202);
    expect(await r2.json()).toEqual({ ok: true, noop: true }); // 去重受理形

    await waitFor(async () => (await latestEvents(s, "s_idem")).some((e) => e.type === "user/message" && e.seq > lastSeq));
    const evs = (await latestEvents(s, "s_idem")).filter((e) => e.seq > lastSeq);
    const hits = evs.filter((e) => e.type === "user/message" && JSON.stringify((e as { content?: unknown }).content).includes("幂等消息"));
    expect(hits).toHaveLength(1); // 只产生一条 user/message
    await s.stop();
  }, 60_000);

  it("⑦ GET status → 九字段齐（permission 读 [approval] 配置、effort 读核心顶层键、busy/phase 推算、label 读 session 头）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home, { topKeys: ['effort = "high"'], sections: ["[approval]\nmode = \"never\""] });
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_status", "状态会话");
    const s = await startWeb(home, cwd, "s_status");

    const r = await fetch(`${s.base}/api/sessions/s_status/status`, { headers: s.auth });
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, unknown>;
    // 九字段齐（键全集先断——防实现悄悄掉键）
    expect(Object.keys(b).toSorted()).toEqual(["bucket", "busy", "cwd", "effort", "label", "model", "permission", "phase", "sid"]);
    expect(b).toMatchObject({
      sid: "s_status",
      label: "状态会话", // readSessionHead（session/label）
      model: "demo/model-x", // h.status().model（config model）
      effort: "high", // h.status().effort（核心顶层 effort 键）
      permission: "never", // approval.current-mode 服务（[approval] 配置面）
      busy: false, // HostedSession 推算
      phase: "idle", // HostedSession 推算
      cwd, // HostedSession
      bucket: encodeCwd(cwd), // HostedSession（§4-8 自算桶）
    });
    // 未知 sid → 404
    const nf = await fetch(`${s.base}/api/sessions/s_none/status`, { headers: s.auth });
    expect(nf.status).toBe(404);
    await s.stop();
  }, 60_000);

  it("⑧ 浏览态写升级（2026-10-12 走查修——「viewer 会话只读（不发 prompt）」根因）：GET status 建 viewer 化身 → POST send 自动换轨 host 真发消息（user/message 落盘 + 池内 host 在册）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home); // 死端口 provider——user/message 照落、turn 快速收尾
    const cwd = tmpCwd();
    await seedSession(home, cwd, "s_view", "被浏览的会话");
    await seedSession(home, cwd, "s_main", "交接主会话"); // startWeb 的 handover 形参必填——主会话占交接位，s_view 保持池外
    const s = await startWeb(home, cwd, "s_main");

    // 先读建立 viewer 化身（前端浏览态实路径——GET status 经 resolveSession 装配 viewer 进池）
    const st = await fetch(`${s.base}/api/sessions/s_view/status`, { headers: s.auth });
    expect(st.status).toBe(200);
    expect(webHostPool()!.host("s_view")).toBeUndefined(); // 此刻仍是 viewer 化身
    expect(webHostPool()!.lookup("s_view")).toBeDefined();

    // 写意图 → 自动升级 host（不再 409 viewer 只读）→ 真发消息落盘
    const r = await postSend(s, "s_view", { text: "浏览态直接发消息" });
    expect(r.status).toBe(202);
    expect((await r.json()) as { ok: boolean }).toMatchObject({ ok: true });
    await waitFor(async () => {
      const ev = await fetch(`${s.base}/api/sessions/s_view/events`, { headers: s.auth });
      const eb = (await ev.json()) as { events: SessionEvent[] };
      return eb.events.some((e) => e.type === "user/message" && JSON.stringify(e).includes("浏览态直接发消息"));
    });
    expect(webHostPool()!.host("s_view")).toBeDefined(); // 已换轨为 host 托管
    await s.stop();
  }, 60_000);

  it("admission 上限：promptId 保留最近 256——第 257 个新 id 进门后最旧被逐（重见视为新）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    const cwd = tmpCwd();
    // 注入式 fake harness（T2 ④ 同款缝——不装配真模块图；admission 是纯 Map 面）
    let stopped = false;
    const idle = async (): Promise<void> => { for (;;) { if (stopped) return; await new Promise((r) => setTimeout(r, 10)); } };
    const fake: Harness = {
      sessionId: "s_admit",
      prompt: async () => undefined,
      cancel: () => {},
      steer: () => false,
      events: () => (async function* () { await idle(); yield* []; })(),
      history: async () => [],
      ensureHistoryFull: async () => {},
      eventsBefore: async () => [],
      liveChunks: () => (async function* () { await idle(); yield* []; })(),
      usage: async () => ({ current: { input: 0, output: 0 } }),
      status: () => ({ model: "fake/x", overridden: false, sessionId: "s_admit", modules: { active: 0, failed: 0, discovered: 0 } }),
      setLabel: async () => {},
      fork: async () => ({ sessionId: "s_admit" }),
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
    const hs = new HostedSession({ cwd, commandUi: {
      ask: async () => { throw new Error("无交互环境"); },
      askSecret: async () => { throw new Error("无交互环境"); },
      choose: async () => { throw new Error("无交互环境"); },
      confirm: async () => { throw new Error("无交互环境"); },
    } satisfies CommandUi, harness: fake, sessionsRoot: join(home, "sessions") });
    await hs.ready;
    expect(hs.admitPromptId("p0")).toBe(true);
    for (let i = 1; i <= 256; i++) expect(hs.admitPromptId(`p${i}`)).toBe(true); // 257 条 → p0 被逐
    expect(hs.admitPromptId("p1")).toBe(false); // 未被逐的仍去重（先于任何再 admission 检查——重见会刷新位次）
    expect(hs.admitPromptId("p256")).toBe(false); // 最新仍去重
    expect(hs.admitPromptId("p0")).toBe(true); // 最旧已逐——重见视为新（此步会把 p1 挤到最旧）
    await hs.close();
  }, 30_000);

  it("/api/at：目录条目（目录前置 + 码元升序 + 符号链接跟随）与前缀过滤", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwd = tmpCwd();
    writeFileSync(join(cwd, "b-file.txt"), "x", "utf8");
    writeFileSync(join(cwd, "a-file.txt"), "x", "utf8");
    const sub = join(cwd, "z-dir");
    mkdirSync(sub);
    symlinkSync(sub, join(cwd, "link-dir"), "dir"); // 符号链接跟随判定真实类型（目录）
    await seedSession(home, cwd, "s_at_menu");
    const s = await startWeb(home, cwd, "s_at_menu");

    const r = await fetch(`${s.base}/api/at?cwd=${encodeURIComponent(cwd)}`, { headers: s.auth });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { ok?: boolean; entries?: { name: string; dir: boolean }[] };
    expect(b.ok).toBe(true);
    const names = (b.entries ?? []).map((e) => `${e.dir ? "d" : "f"}:${e.name}`);
    // 目录前置（D6）：z-dir/link-dir 在全部文件前；组内码元升序
    expect(names.indexOf("d:z-dir")).toBeLessThan(names.findIndex((n) => n.startsWith("f:")));
    expect(names).toContain("d:link-dir"); // 符号链接 → 目标是目录即目录（at-menu-entries.ts:15 同款）
    expect(names).toContain("f:a-file.txt");
    expect(names).toContain("f:b-file.txt");

    // 前缀过滤（D7）+ 子目录下钻（dir 参）
    const q = await fetch(`${s.base}/api/at?cwd=${encodeURIComponent(cwd)}&q=a`, { headers: s.auth });
    const qb = (await q.json()) as { entries?: { name: string }[] };
    expect((qb.entries ?? []).map((e) => e.name)).toEqual(["a-file.txt"]);
    const miss = await fetch(`${s.base}/api/at?cwd=${encodeURIComponent(cwd)}&dir=不存在`, { headers: s.auth });
    expect(((await miss.json()) as { entries?: unknown[] }).entries).toEqual([]); // 目录不存在 → 空态不炸
    const noCwd = await fetch(`${s.base}/api/at`, { headers: s.auth });
    expect(noCwd.status).toBe(400); // 缺 cwd → 400
    await s.stop();
  }, 60_000);
});
