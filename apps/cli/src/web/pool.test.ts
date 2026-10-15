/** web 批 T9 伴生测试（数据面）：跨项目会话池——brief ①-⑨ + ⑬ 逐条。全部真栈
 *  （runWebSubcommand + 可选 handover 托管种子会话——T4/T7 同款先例）；两桶三会话 fabricate
 *  （JsonlSessionStore 真盘 + live.json/锁文件 fabricate）：
 *  ① 全桶分组（组名 = basename(cwd)、行字段齐）；② pinned 置顶区 + toggle 持久化（pins.json）；
 *  ③ bucket→cwd 反查缓存命中（盘读计数不放大）；④ POST {cwd} → 新 harness bucket = encodeCwd(cwd)；
 *  ⑤ POST {resumeSid} → viewer/host 换轨；⑥ 协同 peers 跨桶合并 + 组内 /ps 序义；⑦ 扫描缓存
 *  （§5 律三：1s 窗内 5 连 GET 只扫一次、过期重扫）；⑧ 工作区显隐（B10：hide 过滤 + 找回）；
 *  ⑨ 顶栏新建跟随（B1：current 所在项目 → 显式切换 → 无 current 回落启动 cwd）；⑬ fresh 沿用
 *  （B13：同项目二次 POST 同 sid + reused:true；发过消息后新 sid）；⑭ 重命名任意会话
 *  （T15 审查补漏端点 POST /:sid/title——非托管落盘/托管不扰 host/守卫面）；⑯ fork 子会话
 *  resume 恢复 fork 视图 + ⑯补负面对照（T18 评审返工——sessionFileHasForkMarker 标记扫描分支
 *  此前零覆盖：⑮ 走 POST {forkFrom} 短路了文件检查，本件种盘上 fork 子体经 {resumeSid} 打开）。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";

import { encodeCwd, JsonlSessionStore, type SessionEvent } from "@orosus/core";
import { runWebSubcommand, webHostPool } from "./mod.ts";
import { instanceFilePath } from "./instance.ts";
import { shutdownWebServer } from "./server.ts";
import { HostPool } from "./hostpool.ts";
import { bucketCwd, bucketCwdReads } from "./buckets.ts";

/** 轮询等待（25ms 步进；谓词可异步；超时抛错）。 */
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** 引导门放行形态 config.toml（T4 同款；死端口 provider——user/message 照落、turn 快速收尾）。 */
const writeProviderConfig = (home: string): void => {
  writeFileSync(join(home, "config.toml"), `model = "demo/model-x"\n\n[provider-custom.providers.demo]\nbaseUrl = "http://127.0.0.1:9"\ntype = "openai"\n`, "utf8");
};

/** 种子会话（可带 label/user/assistant/tool 事件——fresh 判据与导出渲染测试用）。 */
const seedSession = async (
  home: string,
  cwd: string,
  sid: string,
  opts: { label?: string; user?: string; assistant?: string; tool?: { name: string; args?: Record<string, unknown> }; manifestFirst?: boolean } = {},
): Promise<void> => {
  const store = new JsonlSessionStore({ dir: join(home, "sessions", encodeCwd(cwd)), sessionId: sid });
  if (opts.manifestFirst === true) await store.append("mcp/manifest", { modules: [] }); // 真实会话实况：模块装载先于首条 header 落盘（T18 走查修的 headerCwd 回归面）
  await store.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  if (opts.label !== undefined) await store.append("session/label", { label: opts.label });
  if (opts.user !== undefined) await store.append("user/message", { content: [{ kind: "text", text: opts.user }] });
  if (opts.assistant !== undefined) await store.append("assistant/message", { content: [{ kind: "text", text: opts.assistant }] });
  if (opts.tool !== undefined) await store.append("tool/call", { name: opts.tool.name, ...(opts.tool.args !== undefined ? { args: opts.tool.args } : {}), callId: "call_seed" });
  await store.close();
};

/** 种 fork 父子会话对（⑯ 用——真盘实形参照 core harness.test.ts「fork 零 turn 也立即落盘」：子文件
 *  首行 session/header（parentSession 指父）+ 次行 session/fork（sourceEntryId = fork 时刻父尾）。 */
const seedForkPair = async (home: string, cwd: string, parentSid: string, childSid: string): Promise<void> => {
  const dir = join(home, "sessions", encodeCwd(cwd));
  const parent = new JsonlSessionStore({ dir, sessionId: parentSid });
  await parent.append("session/header", { format: 1, cwd, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  await parent.append("user/message", { content: [{ kind: "text", text: "父会话的用户消息" }] });
  await parent.append("assistant/message", { content: [{ kind: "text", text: "父会话的助手回复" }] });
  const tailId = (await parent.all()).at(-1)!.id;
  await parent.close();
  const child = new JsonlSessionStore({ dir, sessionId: childSid });
  await child.append("session/header", { format: 1, cwd, parentSession: parentSid, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
  await child.append("session/fork", { sourceEntryId: tailId, parentSession: parentSid });
  await child.close();
};

interface Stack {
  base: string;
  auth: Record<string, string>;
  stop: () => Promise<void>;
}

/** 真栈起服（可选 handover——不传 = 空启无当前会话）。 */
const startWeb = async (home: string, cwd?: string, sid?: string): Promise<Stack> => {
  const lines: string[] = [];
  const run = runWebSubcommand(
    ["web", "--no-open"],
    { out: (l) => lines.push(l), env: { OROSUS_HOME: home } },
    sid !== undefined && cwd !== undefined ? { resumeSid: sid, cwd } : undefined,
  );
  await waitFor(() => lines.some((l) => l.includes("http://127.0.0.1")));
  const inst = JSON.parse(readFileSync(instanceFilePath(home), "utf8")) as { port: number; token: string };
  return {
    base: `http://127.0.0.1:${inst.port}`,
    auth: { "x-orosus-token": inst.token, connection: "close" }, // undici 池死套接字防护（T4 教训）
    stop: async () => {
      shutdownWebServer("test");
      await run;
    },
  };
};

const get = (s: Stack, path: string): Promise<Response> => fetch(`${s.base}${path}`, { headers: s.auth });
const post = (s: Stack, path: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${s.base}${path}`, { method: "POST", headers: { ...s.auth, "content-type": "application/json" }, body: JSON.stringify(body) });

/** 真驻留子进程（活 pid 源——live.json/锁文件 fabrication 用；isLive 双判据的 pidAlive 侧）。 */
const spawnSleeper = async (): Promise<{ pid: number; kill: () => void }> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 400)); // Windows 上 pid 探活可达窗
  return { pid: child.pid!, kill: () => { try { child.kill(); } catch { /* 已退 */ } } };
};

/** fabricate live.json（会话目录根——scanLivePeers 的事实源）。 */
const writeLive = (sessionDir: string, opts: { pid: number; phase: string; kind?: string }): void => {
  writeFileSync(join(sessionDir, "live.json"), JSON.stringify({
    v: 1, sid: basename(sessionDir), pid: opts.pid, token: "fabricate", kind: opts.kind ?? "tui",
    phase: opts.phase, startedAt: Date.now(), lastEventAt: Date.now(),
  }), "utf8");
};

/** /api/sessions 行（§3 SessionRow——断言侧松类型）。 */
interface Row { sid: string; label?: string; relMs?: number; live?: boolean; kind?: string; phase?: string; cur?: boolean; fresh?: boolean }
interface Group { bucket: string; name: string; cwd: string; sessions: Row[] }

/** 组内取行（⑥ 断言辅助——缺行即 fail）。 */
const rowIn = (g: Group, sid: string): Row => {
  const hit = g.sessions.find((x) => x.sid === sid);
  expect(hit).toBeDefined();
  return hit!;
};

const sessionsBody = async (s: Stack): Promise<{ pinned: Row[]; groups: Group[] }> => {
  const r = await get(s, "/api/sessions");
  expect(r.status).toBe(200);
  return (await r.json()) as { pinned: Row[]; groups: Group[] };
};

describe("web T9：跨项目会话池（全桶/反查/置顶/cwd 切换/协同）", () => {
  const homes: string[] = [];
  const cwds: string[] = [];
  const killers: Array<() => void> = [];
  let prevHome: string | undefined;

  const tmpHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "orosus-web-t9-"));
    homes.push(h);
    return h;
  };
  const tmpCwd = (): string => {
    const c = mkdtempSync(join(tmpdir(), "orosus-web-t9-cwd-"));
    cwds.push(c);
    return c;
  };

  beforeEach(() => {
    prevHome = process.env["OROSUS_HOME"]; // OROSUS_HOME 密封（T2 先例）
  });

  afterEach(() => {
    shutdownWebServer("test-cleanup"); // 幂等——失败用例兜底清退
    if (prevHome === undefined) delete process.env["OROSUS_HOME"];
    else process.env["OROSUS_HOME"] = prevHome;
    for (const k of killers.splice(0)) {
      try { k(); } catch { /* 已退 */ }
    }
    for (const c of cwds.splice(0)) {
      try { rmSync(c, { recursive: true, force: true }); } catch { /* 迟到句柄留给系统 tmp */ }
    }
    while (homes.length > 0) {
      const h = homes.pop()!;
      try { rmSync(h, { recursive: true, force: true }); } catch { /* 同上 */ }
    }
  });

  it("① 全桶分组：组名 = basename(cwd)、bucket 对齐、行字段齐（sid/label/relMs/live）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    const cwdB = tmpCwd();
    await seedSession(home, cwdA, "s_a1", { label: "会话甲" });
    await seedSession(home, cwdA, "s_a2", { user: "A 的第二个会话" });
    await seedSession(home, cwdB, "s_b1", { label: "会话乙" });
    const s = await startWeb(home, cwdA, "s_a1");

    const body = await sessionsBody(s);
    expect(body.groups).toHaveLength(2);
    const gA = body.groups.find((g) => g.cwd === cwdA);
    const gB = body.groups.find((g) => g.cwd === cwdB);
    expect(gA).toBeDefined();
    expect(gB).toBeDefined();
    expect(gA!.name).toBe(basename(cwdA)); // 组名 = basename(cwd)（B3）
    expect(gB!.name).toBe(basename(cwdB));
    expect(gA!.bucket).toBe(encodeCwd(cwdA));
    expect(gB!.bucket).toBe(encodeCwd(cwdB));
    expect(gA!.sessions.map((x) => x.sid).toSorted()).toEqual(["s_a1", "s_a2"]);
    const a1 = gA!.sessions.find((x) => x.sid === "s_a1")!;
    expect(a1).toMatchObject({ live: true, kind: "web", phase: "idle", cur: true }); // handover 托管行（B4 托管实时 + B5 当前标）
    const dead = [gA!.sessions.find((x) => x.sid === "s_a2")!, ...gB!.sessions];
    for (const row of dead) {
      expect(typeof row.sid).toBe("string");
      expect(typeof row.label).toBe("string");
      expect(typeof row.relMs).toBe("number");
      expect(row.relMs!).toBeGreaterThanOrEqual(0);
      expect(row.live).toBe(false); // 死会话（fabricate 无 live.json）
      expect(row.kind).toBeUndefined(); // 死行不带 kind/phase
      expect(row.phase).toBeUndefined();
    }
    expect(a1.label).toBe("会话甲"); // session/label 优先
    expect(gA!.sessions.find((x) => x.sid === "s_a2")!.label).toBe("A 的第二个会话"); // firstUser 兜底
    expect(body.pinned).toEqual([]); // 无置顶
    await s.stop();
  }, 60_000);

  it("② pinned 置顶区独立 + toggle 持久化（pins.json 落盘 0600 形；bootstrap 同步）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    await seedSession(home, cwdA, "s_pin", { label: "置顶目标" });
    const s = await startWeb(home, cwdA, "s_pin");

    expect((await sessionsBody(s)).pinned).toEqual([]); // 初始无置顶
    const on = await post(s, "/api/sessions/s_pin/pin", {});
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true, pinned: true });

    const body = await sessionsBody(s);
    expect(body.pinned.map((x) => x.sid)).toEqual(["s_pin"]); // 置顶区独立成列
    expect(body.pinned[0]!.cur).toBe(true); // 当前会话标（handover 指向 s_pin）
    expect(body.groups.find((g) => g.cwd === cwdA)!.sessions.some((x) => x.sid === "s_pin")).toBe(true); // 组内仍在

    const raw = readFileSync(join(home, "gui", "pins.json"), "utf8"); // 持久化（B2）
    expect(JSON.parse(raw)).toEqual(["s_pin"]);
    const boot = await get(s, "/api/bootstrap");
    expect(((await boot.json()) as { pinned: string[] }).pinned).toEqual(["s_pin"]); // bootstrap 同步

    const off = await post(s, "/api/sessions/s_pin/pin", {}); // 再 toggle = 取消
    expect(await off.json()).toEqual({ ok: true, pinned: false });
    expect((await sessionsBody(s)).pinned).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, "gui", "pins.json"), "utf8"))).toEqual([]);
    await s.stop();
  }, 60_000);

  it("③ bucket→cwd 反查缓存命中：重复反查盘读计数不放大（§5 律三）", async () => {
    const home = tmpHome();
    const cwdX = tmpCwd();
    await seedSession(home, cwdX, "s_rev");
    const root = join(home, "sessions");
    const before = bucketCwdReads();
    expect(bucketCwd(root, encodeCwd(cwdX))).toBe(cwdX); // 首次反查（盘读 +1）
    expect(bucketCwdReads()).toBe(before + 1);
    for (let i = 0; i < 5; i++) expect(bucketCwd(root, encodeCwd(cwdX))).toBe(cwdX);
    expect(bucketCwdReads()).toBe(before + 1); // 缓存命中——5 连查盘读零放大
  }, 30_000);

  it("④ POST {cwd: 项目B} → 新 harness bucket = encodeCwd(项目B)", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    const cwdB = tmpCwd();
    await seedSession(home, cwdA, "s_hand", { user: "交接会话" });
    const s = await startWeb(home, cwdA, "s_hand");

    const r = await post(s, "/api/sessions", { cwd: cwdB });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { sid?: string; reused?: boolean };
    expect(typeof b.sid).toBe("string");
    expect(b.reused).toBeUndefined(); // B 桶无 fresh → 新建
    const st = await get(s, `/api/sessions/${b.sid}/status`);
    const stb = (await st.json()) as { cwd?: string; bucket?: string };
    expect(stb.cwd).toBe(cwdB);
    expect(stb.bucket).toBe(encodeCwd(cwdB)); // §4-8：web 自算桶
    await s.stop();
  }, 60_000);

  it("⑤ POST {resumeSid} → viewer/host 换轨（此前 viewer 化身 → 托管 host + current 游标切换）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    const cwdB = tmpCwd();
    await seedSession(home, cwdA, "s_hand", { user: "交接会话" });
    await seedSession(home, cwdB, "s_open", { user: "待换轨会话" });
    const s = await startWeb(home, cwdA, "s_hand");
    const pool = webHostPool()!;

    const st = await get(s, "/api/sessions/s_open/status"); // 先经只读 viewer 面（T3 resolveSession）
    expect(st.status).toBe(200);
    expect(pool.host("s_open")).toBeUndefined(); // 未托管

    const r = await post(s, "/api/sessions", { resumeSid: "s_open" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sid: "s_open" });
    expect(pool.host("s_open")).toBeDefined(); // 换轨：host 托管（viewer 化身已被先关）
    const boot = await get(s, "/api/bootstrap");
    expect(((await boot.json()) as { currentSid?: string }).currentSid).toBe("s_open"); // 游标切换
    await s.stop();
  }, 60_000);

  it("⑥ 协同 peers 跨桶合并：两桶活体行 live/phase/kind 齐 + 组内 /ps 序义（waiting → running → error → idle → 死行）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    const cwdB = tmpCwd();
    await seedSession(home, cwdA, "s_dead", { user: "死会话" });
    await seedSession(home, cwdA, "s_l1", { user: "跑着" });
    await seedSession(home, cwdA, "s_l2", { user: "等审批" });
    await seedSession(home, cwdB, "s_l3", { user: "报错" });
    const sleeper = await spawnSleeper();
    killers.push(sleeper.kill);
    writeLive(join(home, "sessions", encodeCwd(cwdA), "s_l1"), { pid: sleeper.pid, phase: "running" });
    writeLive(join(home, "sessions", encodeCwd(cwdA), "s_l2"), { pid: sleeper.pid, phase: "waiting-approval" });
    writeLive(join(home, "sessions", encodeCwd(cwdB), "s_l3"), { pid: sleeper.pid, phase: "error", kind: "line" });
    const s = await startWeb(home); // 空启（无托管——行序断言干净）

    const body = await sessionsBody(s);
    const gA = body.groups.find((g) => g.cwd === cwdA)!;
    const gB = body.groups.find((g) => g.cwd === cwdB)!;
    // 跨桶合并：两桶的 live.json 活体行都带 live/phase/kind（B4）
    expect(rowIn(gA, "s_l1")).toMatchObject({ live: true, phase: "running", kind: "tui" });
    expect(rowIn(gA, "s_l2")).toMatchObject({ live: true, phase: "waiting-approval", kind: "tui" });
    expect(rowIn(gB, "s_l3")).toMatchObject({ live: true, phase: "error", kind: "line" });
    // 组内 /ps 序义：waiting → running → 死行（ps.ts PHASE_ORDER 同序）
    const order = gA.sessions.map((x) => x.sid);
    expect(order.indexOf("s_l2")).toBeLessThan(order.indexOf("s_l1"));
    expect(order.indexOf("s_l1")).toBeLessThan(order.indexOf("s_dead"));
    expect(gB.sessions[0]!.sid).toBe("s_l3"); // 活体行（error）在死行前
    await s.stop();
  }, 60_000);

  it("⑦ 扫描缓存（§5 律三）：1s 窗内 5 连 GET（并发多客户端）→ 全桶扫描计数只 +1；过期后重扫", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    await seedSession(home, cwdA, "s_hand", { user: "交接会话" });
    const s = await startWeb(home, cwdA, "s_hand");
    const pool = webHostPool()!;

    const before = pool.sessionScanCount();
    await Promise.all(Array.from({ length: 5 }, () => get(s, "/api/sessions"))); // 多客户端并发共享缓存
    expect(pool.sessionScanCount()).toBe(before + 1); // 只扫一次

    await new Promise((r) => setTimeout(r, 1_100)); // 缓存过期（TTL 1s）
    await get(s, "/api/sessions");
    expect(pool.sessionScanCount()).toBe(before + 2); // 过期重扫
    await s.stop();
  }, 60_000);

  it("⑧ 工作区显隐（B10）：hide → groups 过滤 / bootstrap 仍含（hidden:true）/ 盘上不删；找回 = 同 cwd 建会话自动移出", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    const cwdB = tmpCwd();
    await seedSession(home, cwdA, "s_hand", { user: "交接会话" });
    await seedSession(home, cwdB, "s_b1", { user: "B 桶会话" });
    const b1File = join(home, "sessions", encodeCwd(cwdB), "s_b1", "agents", "session.jsonl");
    const s = await startWeb(home, cwdA, "s_hand");

    const hide = await post(s, "/api/workspaces/hide", { cwd: cwdB });
    expect(hide.status).toBe(200);
    expect(await hide.json()).toEqual({ ok: true });

    const body = await sessionsBody(s);
    expect(body.groups.some((g) => g.cwd === cwdB)).toBe(false); // groups 过滤 hidden 桶
    expect(body.groups.some((g) => g.cwd === cwdA)).toBe(true);
    const boot = (await (await get(s, "/api/bootstrap")).json()) as { projects: { bucket: string; cwd: string; name: string; hidden?: boolean }[] };
    const projB = boot.projects.find((p) => p.cwd === cwdB);
    expect(projB).toBeDefined(); // bootstrap projects 含 hidden 工作区全量（找回入口）
    expect(projB!.hidden).toBe(true);
    expect(boot.projects.find((p) => p.cwd === cwdA)!.hidden).toBeUndefined();
    expect(boot.projects.map((p) => p.bucket).toSorted()).toEqual([encodeCwd(cwdA), encodeCwd(cwdB)].toSorted());
    expect(JSON.parse(readFileSync(join(home, "gui", "workspaces.json"), "utf8"))).toEqual({ v: 1, hidden: [cwdB] });
    expect(existsSync(b1File)).toBe(true); // 盘上文件与会话目录未被删

    const re = await post(s, "/api/sessions", { cwd: cwdB }); // 找回：同 cwd 建会话
    expect(re.status).toBe(200);
    const created = (await re.json()) as { sid: string };
    const body2 = await sessionsBody(s);
    const gB2 = body2.groups.find((g) => g.cwd === cwdB);
    expect(gB2).toBeDefined(); // B 桶回列
    expect(gB2!.sessions.some((x) => x.sid === created.sid)).toBe(true); // 新会话行（hosted 合并——fresh 无盘文件也在列）
    expect(gB2!.sessions.some((x) => x.sid === "s_b1")).toBe(true); // 既有会话找回
    const boot2 = (await (await get(s, "/api/bootstrap")).json()) as { projects: { cwd: string; hidden?: boolean }[] };
    expect(boot2.projects.find((p) => p.cwd === cwdB)!.hidden).toBeUndefined(); // 自动移出 hidden
    expect(existsSync(b1File)).toBe(true); // 盘上仍未删
    await s.stop();
  }, 60_000);

  it("⑨ 顶栏新建跟随（B1）：无 cwd POST → current 所在项目；切换后跟随新项目；无 current → server 启动 cwd", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    const cwdB = tmpCwd();
    await seedSession(home, cwdA, "s_hand", { user: "交接会话" });
    await seedSession(home, cwdB, "s_b1", { user: "B 桶会话" });
    const s = await startWeb(home, cwdA, "s_hand"); // current = s_hand（cwd A = server 启动 cwd）
    const pool = webHostPool()!;

    const openIn = async (): Promise<{ sid: string; bucket: string }> => {
      const r = await post(s, "/api/sessions", {});
      expect(r.status).toBe(200);
      const sid = ((await r.json()) as { sid: string }).sid;
      const st = (await (await get(s, `/api/sessions/${sid}/status`)).json()) as { bucket: string };
      return { sid, bucket: st.bucket };
    };
    expect((await openIn()).bucket).toBe(encodeCwd(cwdA)); // 跟随 current（s_hand 在 A）

    const sw = await post(s, "/api/sessions", { resumeSid: "s_b1" }); // 切到项目 B 会话
    expect(sw.status).toBe(200);
    const second = await openIn();
    expect(second.bucket).toBe(encodeCwd(cwdB)); // 跟随新 current（s_b1 在 B；POST 后 current = 新会话）

    const quit = await post(s, `/api/sessions/${second.sid}/send`, { text: "/quit" }); // 关当前会话 → current 空
    expect(quit.status).toBe(202);
    await waitFor(() => pool.current() === undefined);
    expect((await openIn()).bucket).toBe(encodeCwd(cwdA)); // 无 current → server 启动 cwd（handover cwd = A）
    await s.stop();
  }, 60_000);

  it("⑬ fresh 沿用（B13）：同项目二次 POST 同 sid + reused:true；发过消息后 → 新 sid", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    await seedSession(home, cwdA, "s_hand", { user: "交接会话" });
    const s = await startWeb(home, cwdA, "s_hand");

    const r1 = await post(s, "/api/sessions", { cwd: cwdA });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { sid: string; reused?: boolean };
    expect(b1.reused).toBeUndefined(); // 首建（s_hand 非 fresh——有消息）
    const r2 = await post(s, "/api/sessions", { cwd: cwdA }); // 未发消息 → 沿用
    expect(await r2.json()).toEqual({ sid: b1.sid, reused: true });

    const send = await post(s, `/api/sessions/${b1.sid}/send`, { text: "第一条消息" }); // 解除 fresh
    expect(send.status).toBe(202);
    await waitFor(async () => {
      const ev = await get(s, `/api/sessions/${b1.sid}/events`);
      const eb = (await ev.json()) as { events: SessionEvent[] };
      return eb.events.some((e) => e.type === "user/message");
    });

    const r3 = await post(s, "/api/sessions", { cwd: cwdA }); // 发过消息 → 新 sid
    expect(r3.status).toBe(200);
    const b3 = (await r3.json()) as { sid: string; reused?: boolean };
    expect(b3.sid).not.toBe(b1.sid);
    expect(b3.reused).toBeUndefined();
    await s.stop();
  }, 60_000);

  it("⑭ 重命名任意会话（T15 审查补漏端点）：非托管会话 session/label 落盘 + 托管会话不扰 host + 守卫面", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    const cwdB = tmpCwd();
    await seedSession(home, cwdA, "s_host", { label: "托管中的会话", user: "有消息非 fresh" });
    await seedSession(home, cwdB, "s_disk", { label: "盘上非托管" }); // 他项目、未托管（无 host/viewer）
    const s = await startWeb(home, cwdA, "s_host");

    // 非托管会话（他项目、外部视角）：重命名 → 200 + session/label 落盘 + 扫描出新（不切当前会话）
    const r1 = await post(s, "/api/sessions/s_disk/title", { title: '新名"含引号"与<尖括号>' });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true });
    const disk = readFileSync(join(home, "sessions", encodeCwd(cwdB), "s_disk", "agents", "session.jsonl"), "utf8");
    const labelEv = disk.trim().split("\n")
      .map((l) => JSON.parse(l) as { type?: string; label?: string })
      .filter((e) => e.type === "session/label")
      .at(-1); // 旁路写追加的 session/label（ setTitle 同款）
    expect(labelEv?.label).toBe('新名"含引号"与<尖括号>'); // 引号/尖括号原文落盘（JSON 转义在行级）
    const body1 = await sessionsBody(s);
    const rowDisk = body1.groups.find((g) => g.cwd === cwdB)!.sessions.find((x) => x.sid === "s_disk")!;
    expect(rowDisk.label).toBe('新名"含引号"与<尖括号>'); // invalidateScan → 即时出新
    const boot1 = (await (await get(s, "/api/bootstrap")).json()) as { currentSid?: string };
    expect(boot1.currentSid).toBe("s_host"); // 重命名他项目会话不劫持当前游标

    // 托管中会话（host 在池）：重命名 → 200 + host 不扰（status 仍 200 且 sid 不变）+ 行标签出新
    const r2 = await post(s, "/api/sessions/s_host/title", { title: "托管后改名" });
    expect(r2.status).toBe(200);
    const st = await get(s, "/api/sessions/s_host/status");
    expect(st.status).toBe(200); // host 化身健在（旁路写不碰 host）
    const body2 = await sessionsBody(s);
    const rowHost = body2.groups.find((g) => g.cwd === cwdA)!.sessions.find((x) => x.sid === "s_host")!;
    expect(rowHost.label).toBe("托管后改名");
    expect(rowHost.cur).toBe(true);

    // 守卫面：空标题 / 纯空白 → 400；未知 sid → 404
    expect((await post(s, "/api/sessions/s_disk/title", { title: "" })).status).toBe(400);
    expect((await post(s, "/api/sessions/s_disk/title", { title: "   " })).status).toBe(400);
    expect((await post(s, "/api/sessions/s_none/title", { title: "x" })).status).toBe(404);
    await s.stop();
  }, 60_000);

  it("走查修⑯（2026-10-14 用户报障）：同 sid 跨桶只保留最近活动一行（跨目录 resume 落两份文件——磁盘扫描去重）", async () => {
    const home = tmpHome();
    const cwdA = tmpCwd();
    const cwdB = tmpCwd();
    const sid = "s_dupbucket";
    // A 桶：完整会话（新）／B 桶：同 sid 空壳（旧）——两条不同目录 resume 会落的盘形
    await seedSession(home, cwdA, sid, { user: "A 桶正文", label: "A 桶标题" });
    const dirB = join(home, "sessions", encodeCwd(cwdB));
    const storeB = new JsonlSessionStore({ dir: dirB, sessionId: sid });
    await storeB.append("session/header", { format: 1, cwd: cwdB, parentSession: null, moduleSummary: { active: 0, failed: 0, discovered: 0 } });
    await storeB.close();
    // 强制 mtime 差序（同毫秒写 flaky 规避——utimesSync 前移）：B 空壳推旧 60s，A 正文保持当下
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dirB, sid, "agents", "session.jsonl"), old, old);
    const pool = new HostPool({ home });
    const rows = pool.snapshot().rows.filter((r) => r.sid === sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("A 桶标题"); // 最近活动者胜（A 有正文，B 空壳让位）
    expect(rows[0]!.bucket).toBe(encodeCwd(cwdA));
    await pool.closeAll();
  }, 60_000);

  it("in-flight 互斥（T2 审查指针）：并发同 sid viewer / 并发同 cwd openSession 共享一次装配，不重复建", async () => {
    const home = tmpHome();
    const cwdX = tmpCwd();
    await seedSession(home, cwdX, "s_mutex", { user: "非 fresh（有消息）" });
    const pool = new HostPool({ home }); // 池面直测（hosted.test viewer 先例）

    const [v1, v2] = await Promise.all([pool.viewer("s_mutex"), pool.viewer("s_mutex")]);
    expect(v1).toBe(v2); // 并发同 sid 只装配一次（per-key promise 共享）

    const opens = await Promise.all([pool.openSession({ cwd: cwdX }), pool.openSession({ cwd: cwdX })]);
    expect(opens[0]!.hs.sid).toBe(opens[1]!.hs.sid); // 并发双击共享同一装配 → 同一会话（不落两个 fresh）
    expect(opens.map((o) => o.reused)).toEqual([false, false]); // 同一 in-flight 结果对象（顺序二次调用的 reused:true 由 ⑬ 盖）
    await pool.closeAll();
  }, 60_000);

  it("⑮ fork 复合视图浏览器可见性（T18 走查修——C7/G7）：重排显示 seq 后父前缀经 events/SSE/export 三面可见", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    const cwdB = tmpCwd();
    // manifestFirst = 真实会话实况（模块装载先于 header 落盘）——headerCwd 首行假设的回归面（T18 走查修）
    await seedSession(home, cwdA, "s_parent", { label: "父会话", user: "父会话的用户消息", assistant: "父会话的助手回复", manifestFirst: true });
    await seedSession(home, cwdB, "s_other", { user: "B 项目的会话" });
    const s = await startWeb(home); // 空启（fork 只需盘上父会话——locateSessionFile）
    // current 切到 B（POST {cwd} 即 switchCurrent）——fork 前有别的当前项目（修复前 headerCwd 首行
    // 读 manifest 失败 → targetCwd 回落 current().cwd → fork 落错桶 + 父前缀空）
    await post(s, "/api/sessions", { cwd: cwdB });

    // POST {forkFrom} → fork 子体托管（fork 视图检测 + 重排基线装载）；落桶 = 父所在项目（headerCwd）
    const rf = await post(s, "/api/sessions", { forkFrom: "s_parent" });
    expect(rf.status).toBe(200);
    const sidF = ((await rf.json()) as { sid: string }).sid;

    // ① GET events（修复前恒空——core eventsBefore fork 复合视图口径）：最新页含父前缀 user/assistant
    const evs = (await (await get(s, `/api/sessions/${sidF}/events`)).json()) as { events: SessionEvent[] };
    const types = evs.events.map((e) => e.type);
    expect(types).toContain("user/message");
    expect(types).toContain("assistant/message");
    expect(types).toContain("session/fork"); // 自身段标记同页可见
    // 显示 seq 升序且全局唯一（修复前：祖辈段与自身段各自从 1 起——原始投影相撞）
    const seqs = evs.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // ② SSE backfill（浏览器实路径——switchTo 先 GET events 再 after=maxSeq 续流）：父前缀 ev 帧到达
    const frames: Array<{ event: string; data: string }> = [];
    const req = httpRequest({ host: "127.0.0.1", port: Number(s.base.split(":")[2]), path: `/api/sessions/${sidF}/stream?after=0`, headers: s.auth }, (res) => {
      let buf = "";
      res.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = "message";
          const dataLines: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) ev = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
          }
          if (dataLines.length > 0) frames.push({ event: ev, data: dataLines.join("\n") });
        }
      });
    });
    req.end();
    try {
      await waitFor(() => frames.some((f) => f.event === "ev" && f.data.includes("user/message")));
      expect(frames.some((f) => f.event === "ev" && f.data.includes("父会话的用户消息"))).toBe(true);
    } finally {
      req.destroy();
    }

    // ③ export.md（replayAfter(0) 同源——导出含父前缀）
    const exp = await get(s, `/api/sessions/${sidF}/export.md`);
    expect(await exp.text()).toContain("父会话的用户消息");

    // ④ fork 内续聊：死端口 provider 快速收尾——新事件（user/message + turn 族）显示 seq 恒增不相撞
    await post(s, `/api/sessions/${sidF}/send`, { text: "fork 内续聊" });
    await waitFor(async () => {
      const e2 = (await (await get(s, `/api/sessions/${sidF}/events`)).json()) as { events: SessionEvent[] };
      return e2.events.some((e) => e.type === "user/message" && JSON.stringify(e).includes("fork 内续聊"));
    });
    const evs2 = (await (await get(s, `/api/sessions/${sidF}/events`)).json()) as { events: SessionEvent[] };
    const seqs2 = evs2.events.map((e) => e.seq);
    expect(new Set(seqs2).size).toBe(seqs2.length); // 重排空间全局唯一（live ingest 复用同一 displaySeqOf）
    expect(Math.max(...seqs2)).toBeGreaterThan(Math.max(...seqs)); // 续聊事件追加在投影尾

    // ⑤ fork 落桶 = 父所在项目（headerCwd 扫行修复后不再回落 current().cwd 落错桶）
    const groups = ((await (await get(s, "/api/sessions")).json()) as { groups: Array<{ cwd: string; sessions: Array<{ sid: string }> }> }).groups;
    expect(groups.find((g) => g.cwd === cwdA)!.sessions.some((x) => x.sid === sidF)).toBe(true);
    await s.stop();
  }, 60_000);

  it("⑯ fork 子会话 resume 恢复 fork 视图（T18 评审返工——sessionFileHasForkMarker 标记扫描面）：盘上子体经 POST {resumeSid} 打开 → 父前缀可见 + 显示 seq 重排连续", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    await seedForkPair(home, cwdA, "s_fpar", "s_fkid");
    const s = await startWeb(home); // 空启——子体只在盘上（init.forkFrom 缺席，标记扫描是唯一检测口）

    // POST {resumeSid}（无 forkFrom）→ 重开/server 重启后从列表恢复 fork 子会话的实路径：
    // assemble 期 init.forkFrom === undefined → sessionFileHasForkMarker 扫子文件前几行命中
    const r = await post(s, "/api/sessions", { resumeSid: "s_fkid" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sid: "s_fkid" }); // resume 沿用原 sid（fork 产新 sid 只在 POST {forkFrom}）

    // 标记命中 → forkView 重排投影：父前缀 3 事件 + 自身段（header/session/fork + resume 追加的
    // mcp/manifest）→ 显示 seq 连续 1..N 全局唯一（原始投影两段各自从 1 起相撞）；
    // 修复面口径：标记扫描失效时 eventsPage 走 core eventsBefore——对 ForkedSessionStore 恒 []（前缀在祖辈文件）
    const evs = (await (await get(s, "/api/sessions/s_fkid/events")).json()) as { events: SessionEvent[]; latestSeq: number };
    const blob = JSON.stringify(evs.events);
    expect(blob).toContain("父会话的用户消息"); // 父辈消息经复合视图可见
    expect(blob).toContain("父会话的助手回复");
    expect(evs.events.map((e) => e.type)).toContain("session/fork"); // 自身段标记同页可见
    const seqs = evs.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // 重排显示 seq 连续 1..N（升序即投影序）
    expect(new Set(seqs).size).toBe(seqs.length); // 全局唯一（修复前两段相撞）
    expect(evs.latestSeq).toBe(seqs.length);
    // 父前缀显示 seq 与盘上原值一致（前缀段居首、rebase 首见分配恰未变——零拷贝直返口径）
    const parentUser = evs.events.find((e) => e.type === "user/message" && JSON.stringify(e).includes("父会话的用户消息"))!;
    expect(parentUser.seq).toBe(2);
    await s.stop();
  }, 60_000);

  it("⑯补 负面对照：无标记的非 fork 会话 resume → 不重排（eventsBefore 裸读、盘上 seq 原样）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    await seedSession(home, cwdA, "s_plain", { user: "普通会话消息", assistant: "普通会话回复" }); // header 1 / user 2 / assistant 3
    const s = await startWeb(home);

    const r = await post(s, "/api/sessions", { resumeSid: "s_plain" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sid: "s_plain" });
    const evs = (await (await get(s, "/api/sessions/s_plain/events")).json()) as { events: SessionEvent[]; latestSeq: number };
    const types = evs.events.map((e) => e.type);
    const seqs = evs.events.map((e) => e.seq);
    // 盘上既有事件的 seq 原样（header 1 / user 2 / assistant 3——resume 只追加 mcp/manifest 于尾，不重排）
    expect(types).toEqual(["session/header", "user/message", "assistant/message", "mcp/manifest"]);
    expect(seqs).toEqual([1, 2, 3, 4]); // 文件原序裸读（fork 视图重排对本会话不适用——标记扫描未命中）
    expect(evs.latestSeq).toBe(4);
    expect(JSON.stringify(evs.events)).toContain("普通会话消息");
    await s.stop();
  }, 60_000);

  it("⑰ 点击切换游标同步（2026-10-12 走查修——POST /:sid/current）：纯点击切会话 → server 游标跟随 → cur 行标记 + B1 跨项目跟随（viewer 化身兜底取 cwd）", async () => {
    const home = tmpHome();
    process.env["OROSUS_HOME"] = home;
    writeProviderConfig(home);
    const cwdA = tmpCwd();
    const cwdB = tmpCwd();
    await seedSession(home, cwdA, "s_a", { user: "A 项目会话" });
    await seedSession(home, cwdB, "s_b", { label: "B 项目会话", user: "B 项目消息" });
    const s = await startWeb(home, cwdA, "s_a"); // current = s_a（host）

    // 纯点击切到 B 项目会话（前端 switchTo 实路径：GET status 经 resolveSession 装配 viewer 进池 +
    // POST /current 同步游标——不经 POST /api/sessions）
    expect((await get(s, "/api/sessions/s_b/status")).status).toBe(200);
    expect((await post(s, "/api/sessions/s_b/current", {})).status).toBe(200);

    // cur 行标记：s_b cur:true、s_a 无 cur（游标唯一）
    const body = await sessionsBody(s);
    expect(rowIn(body.groups.find((g) => g.cwd === cwdB)!, "s_b").cur).toBe(true);
    expect(rowIn(body.groups.find((g) => g.cwd === cwdA)!, "s_a").cur).toBeUndefined();

    // B1 跟随：游标指向 viewer 化身（s_b 非 host——current() 只认 hosts，经 lookup 兜底取 cwd）——
    // 无 cwd POST → 新会话落在 B 项目桶
    const r2 = await post(s, "/api/sessions", {});
    expect(r2.status).toBe(200);
    const sid2 = ((await r2.json()) as { sid: string }).sid;
    const st2 = (await (await get(s, `/api/sessions/${sid2}/status`)).json()) as { bucket: string };
    expect(st2.bucket).toBe(encodeCwd(cwdB));
    await s.stop();
  }, 60_000);
});
