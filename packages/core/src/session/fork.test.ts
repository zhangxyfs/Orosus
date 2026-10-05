import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chunk } from "@orosus/contracts/provider";
import { fakeProvider, fakeProviderModule } from "@orosus/testing";
import { JsonlSessionStore } from "./jsonl.ts";
import { repairFile } from "./jsonl.ts";
import { ForkedSessionStore, openSessionView, verifyChain } from "./fork.ts";
import type { SessionEvent } from "./types.ts";
import { InMemorySessionStore } from "./memory.ts";
import { createHarness } from "../index.ts";
import { deriveMessages } from "../loop/convert.ts";
import { scanBucketSessions } from "./dir.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const tmp = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-fork-")));
const script: Chunk[][] = [[{ type: "text/delta", text: "继续" }, { type: "finish", kind: "stop" }]];

/** 在 tmp 会话目录里预置一个有历史的会话，返回其 id。 */
async function seedSession(d: string): Promise<string> {
  const store = new JsonlSessionStore({ dir: d });
  await store.append("session/header", { format: 1, cwd: d, parentSession: null });
  await store.append("user/message", { content: [{ kind: "text", text: "旧问题" }] });
  await store.append("assistant/message", { content: [{ kind: "text", text: "旧回答" }] });
  await store.append("user/message", { content: [{ kind: "text", text: "第二个问题" }] });
  await store.flush();
  const id = store.sessionId;
  await store.close();
  return id;
}

describe("fork/resume（M3 T6，D41）", () => {
  it("① resume：既有会话继续——不落重复 header、prompt 投影含全部历史", async () => {
    const d = tmp();
    const sid = await seedSession(d);
    const fp = fakeProvider(script);
    const h = await createHarness({
      cwd: d,
      resume: { sessionId: sid },
      sessionsDir: d,
      diagDir: d,
      spillDir: join(d, "spill"),
      modules: [{ ...fakeProviderModule("fake", []), activate: (ctx) => ctx.provide("provider:fake" as never, fp.stream) }],
      config: { userFile: join(d, "u.toml"), projectFile: join(d, "p.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      discovery: { userDir: join(d, "m"), projectDir: join(d, "pm"), trustFile: join(d, "t.json") },
      secretsFile: join(d, "s.env"),
    });
    expect(h.sessionId).toBe(sid);
    await h.prompt("新输入");
    const own = new JsonlSessionStore({ dir: d, sessionId: sid });
    const headers = (await own.all()).filter((e) => e.type === "session/header");
    expect(headers).toHaveLength(1); // 不落重复 header
    expect(fp.requests[0]!.messages.map((m) => (m.role === "user" && m.content[0] ? (m.content[0] as { text?: string }).text : ""))).toContain("旧问题"); // M4-2.5 T5 过账：同上
    await h.close();
    await own.close();
  });

  it("② ForkedSessionStore：all() = 父前缀（atEntryId 截断，含）+ own；append 只进 own", async () => {
    const parent = new InMemorySessionStore();
    await parent.append("session/header", {});
    const e2 = await parent.append("user/message", { content: [{ kind: "text", text: "a" }] });
    await parent.append("user/message", { content: [{ kind: "text", text: "b" }] });
    const own = new InMemorySessionStore();
    const forked = new ForkedSessionStore({ parent, atEntryId: e2.id, own });
    await forked.append("user/message", { content: [{ kind: "text", text: "c" }] });
    const all = await forked.all();
    expect(all.map((e) => e.type)).toEqual(["session/header", "user/message", "user/message"]); // 父截断（2）+ own（1）
    expect((await own.all()).map((e) => String((e.content as { text?: string }[] | undefined)?.[0]?.text))).toEqual(["c"]);
    expect(forked.sessionId).toBe(own.sessionId);
  });

  it("③ fork harness：header 带 parentSession、首事件 session/fork{sourceEntryId}；投影含父前缀", async () => {
    const d = tmp();
    const sid = await seedSession(d);
    const fp = fakeProvider(script);
    const h = await createHarness({
      cwd: d,
      fork: { parentSessionId: sid },
      sessionsDir: d,
      diagDir: d,
      spillDir: join(d, "spill"),
      modules: [{ ...fakeProviderModule("fake", []), activate: (ctx) => ctx.provide("provider:fake" as never, fp.stream) }],
      config: { userFile: join(d, "u.toml"), projectFile: join(d, "p.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      discovery: { userDir: join(d, "m"), projectDir: join(d, "pm"), trustFile: join(d, "t.json") },
      secretsFile: join(d, "s.env"),
    });
    expect(h.sessionId).not.toBe(sid);
    await h.prompt("分叉后的问题");
    const own = new JsonlSessionStore({ dir: d, sessionId: h.sessionId });
    const events = await own.all();
    const header = events.find((e) => e.type === "session/header");
    expect(header?.parentSession).toBe(sid);
    const forkEvent = events.find((e) => e.type === "session/fork");
    expect(forkEvent).toBeDefined();
    // 投影 = 父全部 + 自己（sourceEntryId 缺省 = 父最后一条）
    expect(fp.requests[0]!.messages.some((m) => m.role === "user" && m.content[0]?.kind === "text" && m.content[0].text === "旧问题")).toBe(true);
    await h.close();
    await own.close();
  });

  it("④ atEntryId 截断：fork 自历史中点 → 投影只含前缀（后续历史不进请求）", async () => {
    const d = tmp();
    const sid = await seedSession(d);
    const parent = new JsonlSessionStore({ dir: d, sessionId: sid });
    const events = await parent.all();
    const cut = events.find((e) => e.type === "assistant/message")!.id; // 第一条 user 之后
    await parent.close();
    const fp = fakeProvider(script);
    const h = await createHarness({
      cwd: d,
      fork: { parentSessionId: sid, atEntryId: cut },
      sessionsDir: d,
      diagDir: d, spillDir: join(d, "spill"),
      modules: [{ ...fakeProviderModule("fake", []), activate: (ctx) => ctx.provide("provider:fake" as never, fp.stream) }],
      config: { userFile: join(d, "u.toml"), projectFile: join(d, "p.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      discovery: { userDir: join(d, "m"), projectDir: join(d, "pm"), trustFile: join(d, "t.json") },
      secretsFile: join(d, "s.env"),
    });
    await h.prompt("继续");
    const texts = JSON.stringify(fp.requests[0]!.messages);
    expect(texts).toContain("旧问题");
    expect(texts).not.toContain("第二个问题"); // 截断点之后的历史不进
    await h.close();
  });

  it("⑤ verifyChain：parentId 断裂/seq 回退/孤儿 result/未闭合 call 四类检出；健康链零问题", async () => {
    const s = new InMemorySessionStore();
    await s.append("session/header", {});
    await s.append("user/message", { content: [] });
    expect(verifyChain(await s.all())).toEqual([]);
    // 人为构造四类问题
    const broken = [
      { v: 1, id: "e1", parentId: null, seq: 1, ts: "", type: "session/header" },
      { v: 1, id: "e2", parentId: "eX", seq: 1, ts: "", type: "user/message" },       // parentId 断裂 + seq 回退
      { v: 1, id: "e3", parentId: "e2", seq: 3, ts: "", type: "tool/result", callId: "ghost" }, // 孤儿 result
      { v: 1, id: "e4", parentId: "e3", seq: 4, ts: "", type: "tool/call", callId: "c1" },      // 未闭合 call
    ] as never;
    const issues = verifyChain(broken);
    expect(issues.some((i) => i.includes("parentId 链断裂"))).toBe(true);
    expect(issues.some((i) => i.includes("seq 非单调"))).toBe(true);
    expect(issues.some((i) => i.includes("孤儿 tool/result"))).toBe(true);
    expect(issues.some((i) => i.includes("未闭合 tool/call"))).toBe(true);
    // 复合投影分段校验（首轮 P1）：fork 的 all() = parent + own（各自 seq 从 1、首条 parentId=null）——零误报
    const forkView = [
      { v: 1, id: "p0", parentId: null, seq: 1, ts: "t", type: "session/header" },
      { v: 1, id: "p1", parentId: "p0", seq: 2, ts: "t", type: "user/message" },
      { v: 1, id: "o0", parentId: null, seq: 1, ts: "t", type: "session/header" },
      { v: 1, id: "o1", parentId: "o0", seq: 2, ts: "t", type: "user/message" },
    ] as never;
    expect(verifyChain(forkView)).toEqual([]); // 段间 seq 重置不报、根事件开新段
  });

  it("⑥ repairFile 扩展：撕裂尾部含未闭合 tool/call → 补 [已中止] 结果后补 turn/end", () => {
    const d = tmp();
    const file = join(d, "s.jsonl");
    const lines = [
      JSON.stringify({ v: 1, id: "e1", parentId: null, seq: 1, ts: "t", type: "session/header" }),
      JSON.stringify({ v: 1, id: "e2", parentId: "e1", seq: 2, ts: "t", type: "turn/start", model: "m" }),
      JSON.stringify({ v: 1, id: "e3", parentId: "e2", seq: 3, ts: "t", type: "tool/call", callId: "c1", name: "m__t", args: {} }),
      JSON.stringify({ v: 1, id: "e4", parentId: "e3", seq: 4, ts: "t", type: "tool/call", callId: "c2", name: "m__t", args: {} }),
      JSON.stringify({ v: 1, id: "e5", parentId: "e4", seq: 5, ts: "t", type: "tool/result", callId: "c1", output: "ok", isError: false }),
      '{"v":1,"id":"e6","pare', // 撕裂尾部
    ];
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    const r = repairFile(file);
    expect(r.truncated).toBe(true);
    expect(r.interruptedClosed).toBe(true);
    const repaired = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(repaired.some((e) => e.type === "tool/result" && e.callId === "c2" && String(e.output).includes("已中止"))).toBe(true);
    expect(repaired.some((e) => e.type === "turn/end" && e.kind === "interrupted")).toBe(true);
    // 修复后投影合法：deriveMessages 无孤儿、无缺对
    expect(verifyChain(repaired as never).filter((i) => i.includes("tool"))).toEqual([]);
    expect(deriveMessages(repaired as never).some((m) => m.role === "toolResult")).toBe(true);
  });
});

describe("链式 fork 断代修复（会话树批 T1）", () => {
  /** 种一个根会话：header + 一问。返回 { id, tail }（tail = 自己段最后事件 id，作子层分叉点）。 */
  const seedRoot = async (d: string, tag: string): Promise<{ id: string; tail: string }> => {
    const s = new JsonlSessionStore({ dir: d });
    await s.append("session/header", { format: 1, cwd: d, parentSession: null });
    const q = await s.append("user/message", { content: [{ kind: "text", text: tag }] });
    await s.flush();
    const id = s.sessionId;
    await s.close();
    return { id, tail: q.id };
  };

  /** 种一个 fork 子体文件：header{parentSession} + session/fork{sourceEntryId} + 一问。 */
  const seedForkChild = async (d: string, parentId: string, atEntryId: string, tag: string): Promise<{ id: string; tail: string }> => {
    const s = new JsonlSessionStore({ dir: d });
    await s.append("session/header", { format: 1, cwd: d, parentSession: parentId });
    await s.append("session/fork", { sourceEntryId: atEntryId, parentSession: parentId });
    const q = await s.append("user/message", { content: [{ kind: "text", text: tag }] });
    await s.flush();
    const id = s.sessionId;
    await s.close();
    return { id, tail: q.id };
  };

  const makeJsonl = (sessionId: string, bucket: string): JsonlSessionStore => new JsonlSessionStore({ dir: bucket, sessionId });
  const sameBucketLocate = (d: string) => (sid: string) => (sid === "s-missing" ? undefined : { bucket: d });

  it("① 孙代投影含祖代前缀——B.all() = R 段 + A 段 + B 段，逐 id 断言（回归钉）", async () => {
    const d = tmp();
    const root = await seedRoot(d, "祖代问");
    const a = await seedForkChild(d, root.id, root.tail, "子代问");
    const b = await seedForkChild(d, a.id, a.tail, "孙代问");
    const view = await openSessionView({ sessionId: b.id, bucket: d, makeStore: makeJsonl, locate: sameBucketLocate(d) });
    const all = await view.store.all();
    expect(all.map((e) => (e.content as { text?: string }[] | undefined)?.[0]?.text ?? e.type)).toEqual([
      "session/header", "祖代问",           // R 段（2）
      "session/header", "session/fork", "子代问", // A 段（3）
      "session/header", "session/fork", "孙代问", // B 段（3）
    ]);
    expect(view.chain).toEqual([root.id, a.id, b.id]); // 自上而下祖先链
    await view.store.close();
  });

  it("② 四代链投影四段齐——最深层的视图含全部祖先段", async () => {
    const d = tmp();
    const r = await seedRoot(d, "一代");
    const a = await seedForkChild(d, r.id, r.tail, "二代");
    const b = await seedForkChild(d, a.id, a.tail, "三代");
    const c = await seedForkChild(d, b.id, b.tail, "四代");
    const view = await openSessionView({ sessionId: c.id, bucket: d, makeStore: makeJsonl, locate: sameBucketLocate(d) });
    const all = await view.store.all();
    expect(all.filter((e) => e.type === "user/message")).toHaveLength(4);
    expect(view.chain).toEqual([r.id, a.id, b.id, c.id]);
    await view.store.close();
  });

  it("③ 祖先文件缺失 = 就地截断（最近可得段）+ warn 报告缺口", async () => {
    const d = tmp();
    const root = await seedRoot(d, "祖代问");
    await seedForkChild(d, root.id, root.tail, "子代问");
    // B 的父指向不存在的 s-missing——locate 落空 → 截断
    const b = await seedForkChild(d, "s-missing", "e-void", "孙代问");
    const warns: string[] = [];
    const view = await openSessionView({
      sessionId: b.id, bucket: d, makeStore: makeJsonl, locate: sameBucketLocate(d),
      sink: { warn: (code) => warns.push(code) },
    });
    const all = await view.store.all();
    expect(all.map((e) => (e.content as { text?: string }[] | undefined)?.[0]?.text ?? e.type)).toEqual([
      "session/header", "session/fork", "孙代问", // 只剩 B 自己段
    ]);
    expect(view.chain).toEqual([b.id]);
    expect(warns).toContain("session.fork-parent-missing");
    await view.store.close();
  });

  it("④a 祖先链成环 = visited 拦截止断 + warn", async () => {
    const d = tmp();
    // 手工构造 A ↔ B 互指环：A.parentSession=B、B.parentSession=A（新形态：会话目录内 agents/session.jsonl）
    const mk = (id: string, parent: string, at: string, tag: string): void => {
      const agents = join(d, id, "agents");
      mkdirSync(agents, { recursive: true });
      const lines = [
        JSON.stringify({ v: 1, id: `${id}-h`, parentId: null, seq: 1, ts: "t", type: "session/header", parentSession: parent }),
        JSON.stringify({ v: 1, id: `${id}-f`, parentId: `${id}-h`, seq: 2, ts: "t", type: "session/fork", sourceEntryId: at, parentSession: parent }),
        JSON.stringify({ v: 1, id: `${id}-q`, parentId: `${id}-f`, seq: 3, ts: "t", type: "user/message", content: [{ kind: "text", text: tag }] }),
      ];
      writeFileSync(join(agents, "session.jsonl"), lines.join("\n") + "\n", "utf8");
    };
    mk("sa", "sb", "sb-q", "环甲");
    mk("sb", "sa", "sa-q", "环乙");
    const warns: string[] = [];
    const view = await openSessionView({
      sessionId: "sa", bucket: d, makeStore: makeJsonl, locate: sameBucketLocate(d),
      sink: { warn: (code) => warns.push(code) },
    });
    const all = await view.store.all();
    expect(all.filter((e) => e.type === "user/message").map((e) => (e.content as { text: string }[])[0]!.text).length).toBeLessThanOrEqual(2); // 截断——不无限展开
    expect(warns.some((c) => c === "session.fork-chain-truncated")).toBe(true);
    await view.store.close();
  });

  it("④b 祖先链深超 32 = 就地截断 + warn（最近 32 层可用）", async () => {
    const d = tmp();
    const r = await seedRoot(d, "顶");
    let prev = r;
    for (let i = 0; i < 34; i++) prev = await seedForkChild(d, prev.id, prev.tail, `层${i}`);
    const warns: string[] = [];
    const view = await openSessionView({
      sessionId: prev.id, bucket: d, makeStore: makeJsonl, locate: sameBucketLocate(d),
      sink: { warn: (code) => warns.push(code) },
    });
    expect(warns.some((c) => c === "session.fork-chain-truncated")).toBe(true);
    // 深度上限 32：视图含 32 层（最深 32 个祖先段 + …）——链总长 35，截去最顶几层
    expect(view.chain.length).toBe(33); // 自身 + 32 代祖先
    await view.store.close();
  });

  it("⑤ 非 fork 会话原样返回裸 store（不包复合存储）", async () => {
    const d = tmp();
    const root = await seedRoot(d, "根问");
    const view = await openSessionView({ sessionId: root.id, bucket: d, makeStore: makeJsonl, locate: sameBucketLocate(d) });
    expect(view.store).toBeInstanceOf(JsonlSessionStore);
    expect(view.store).not.toBeInstanceOf(ForkedSessionStore);
    expect(view.chain).toEqual([root.id]);
    await view.store.close();
  });

  it("⑥ harness 端到端：fork 自「fork 子体」→ 请求投影含祖辈对话（现状 bug 的回归钉）", async () => {
    const d = tmp();
    const root = await seedRoot(d, "祖代问");
    const a = await seedForkChild(d, root.id, root.tail, "子代问");
    const fp = fakeProvider(script);
    const h = await createHarness({
      cwd: d,
      fork: { parentSessionId: a.id },
      sessionsDir: d,
      diagDir: d,
      spillDir: join(d, "spill"),
      modules: [{ ...fakeProviderModule("fake", []), activate: (ctx) => ctx.provide("provider:fake" as never, fp.stream) }],
      config: { userFile: join(d, "u.toml"), projectFile: join(d, "p.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      discovery: { userDir: join(d, "m"), projectDir: join(d, "pm"), trustFile: join(d, "t.json") },
      secretsFile: join(d, "s.env"),
    });
    await h.prompt("孙代新问");
    const texts = JSON.stringify(fp.requests[0]!.messages);
    expect(texts).toContain("祖代问"); // 断代修复主断言：祖辈前缀不再丢
    expect(texts).toContain("子代问"); // 父自己段照常在
    await h.close();
  });

  it("⑦ CS-04 崩溃窗口子体（header{parentSession} 在场、session/fork 缺席）→ 仍按子体上溯：全量父前缀 + warn（旧实现当根会话，父前缀静默丢失且 verifyChain 不报）", async () => {
    const d = tmp();
    const root = await seedRoot(d, "祖代问");
    // 模拟崩溃窗口：header 与 session/fork 是两次独立 append（两次 drain 批次间崩溃，或撕裂尾切断
    // session/fork 行被 repairFile 截掉）——手工落「有 header{parentSession}、无 session/fork」的子体文件
    const s = new JsonlSessionStore({ dir: d });
    await s.append("session/header", { format: 1, cwd: d, parentSession: root.id });
    await s.append("user/message", { content: [{ kind: "text", text: "残缺子代问" }] });
    const childId = s.sessionId;
    await s.flush();
    await s.close();
    const warns: string[] = [];
    const view = await openSessionView({
      sessionId: childId, bucket: d, makeStore: makeJsonl, locate: sameBucketLocate(d),
      sink: { warn: (code) => warns.push(code) },
    });
    const texts = (await view.store.all()).map((e) => (e.content as { text?: string }[] | undefined)?.[0]?.text ?? e.type);
    expect(texts).toContain("祖代问"); // 父前缀在（旧实现：判据四条不全中 → 当根会话，只剩自身段）
    expect(texts).toContain("残缺子代问");
    expect(view.chain).toEqual([root.id, childId]); // 上溯发生——与树视图（header.parentSession）口径一致
    expect(warns).toContain("session.fork-event-missing"); // 显式留痕：fork 事件缺失 + 全量前缀降级
    await view.store.close();
  });
});

describe("CS-05 两出口校验对称（2026-09-28 code review）：atEntryId 缺席降级显式化——默认 throw，盘上链重建显式 fullPrefix", () => {
  const mkStore = (sessionId: string, bucket: string): JsonlSessionStore => new JsonlSessionStore({ dir: bucket, sessionId });
  const seedRootLocal = async (d: string): Promise<string> => {
    const s = new JsonlSessionStore({ dir: d });
    await s.append("session/header", { format: 1, cwd: d, parentSession: null });
    await s.append("user/message", { content: [{ kind: "text", text: "祖代问" }] });
    const id = s.sessionId;
    await s.flush();
    await s.close();
    return id;
  };

  it("① 默认（活 API 口径）：atEntryId 不在父投影 → all() reject，不再静默全量父前缀（旧实现无条件宽松降级）", async () => {
    const parent = new InMemorySessionStore();
    await parent.append("session/header", {});
    await parent.append("user/message", { content: [] });
    const own = new InMemorySessionStore();
    const forked = new ForkedSessionStore({ parent, atEntryId: "e-nonexistent", own });
    await expect(forked.all()).rejects.toThrow(/分叉点不在父会话投影内/);
  });

  it("② onMissing:\"fullPrefix\"（显式选择）：缺席 → 全量父前缀（旧宽松语义只留给点名要它的调用方）", async () => {
    const parent = new InMemorySessionStore();
    await parent.append("session/header", {});
    await parent.append("user/message", { content: [{ kind: "text", text: "a" }] });
    const own = new InMemorySessionStore();
    const forked = new ForkedSessionStore({ parent, atEntryId: "e-nonexistent", onMissing: "fullPrefix", own });
    const all = await forked.all();
    expect(all).toHaveLength(2); // 父全量（2）+ own 空
  });

  it("③ 启动期出口（createHarness fork 分支）坏 atEntryId 响亮拒绝——与 h.fork（下节 ④）口径对称（旧实现：坏分叉点静默变全量父前缀、session/fork.sourceEntryId 落一条不在父链上的 id）", async () => {
    const d = tmp();
    const sid = await seedSession(d);
    const fp = fakeProvider(script);
    await expect(createHarness({
      cwd: d,
      fork: { parentSessionId: sid, atEntryId: "e-nonexistent" },
      sessionsDir: d,
      diagDir: d,
      spillDir: join(d, "spill"),
      modules: [{ ...fakeProviderModule("fake", []), activate: (ctx) => ctx.provide("provider:fake" as never, fp.stream) }],
      config: { userFile: join(d, "u.toml"), projectFile: join(d, "p.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      discovery: { userDir: join(d, "m"), projectDir: join(d, "pm"), trustFile: join(d, "t.json") },
      secretsFile: join(d, "s.env"),
    })).rejects.toThrow(/分叉点/);
  });

  it("④ openSessionView 读路径（盘上链重建）：sourceEntryId 已被撕裂/截断移出父投影 → 全量父前缀投影、不抛（宽容降级只属读侧）", async () => {
    const d = tmp();
    const rootId = await seedRootLocal(d);
    const s = new JsonlSessionStore({ dir: d });
    await s.append("session/header", { format: 1, cwd: d, parentSession: rootId });
    await s.append("session/fork", { sourceEntryId: "e-gone", parentSession: rootId }); // 指向不存在的事件（模拟撕裂截断后的失配）
    await s.append("user/message", { content: [{ kind: "text", text: "子代问" }] });
    const childId = s.sessionId;
    await s.flush();
    await s.close();
    const view = await openSessionView({ sessionId: childId, bucket: d, makeStore: mkStore, locate: () => ({ bucket: d }) });
    const texts = (await view.store.all()).map((e) => (e.content as { text?: string }[] | undefined)?.[0]?.text ?? e.type);
    expect(texts).toContain("祖代问"); // 全量父前缀——读侧宽容（不因 sourceEntryId 失配让会话打不开）
    await view.store.close();
  });
});

describe("CS-10 ForkedSessionStore 透传 lifetimeUsage（2026-09-28 code review）：活 fork 会话 /usage 不再缺 lifetime 行", () => {
  it("① own=jsonl（带跨会话口径）：方法在场且口径 = 子体跳过 + 父按兄弟计入（旧实现：不透传——存活期间恒 undefined，退出 resume 又出现）", async () => {
    const d = tmp();
    const parent = new JsonlSessionStore({ dir: d, sessionId: "s_p" });
    await parent.append("session/header", { format: 1, cwd: d, parentSession: null });
    await parent.append("assistant/message", { content: [{ kind: "text", text: "答" }], usage: { input: 10, output: 4 } });
    await parent.close();
    const child = new JsonlSessionStore({ dir: d, sessionId: "s_c" });
    await child.append("session/header", { format: 1, cwd: d, parentSession: "s_p" });
    await child.append("assistant/message", { content: [{ kind: "text", text: "答" }], usage: { input: 5, output: 1 } });
    const forked = new ForkedSessionStore({ parent, own: child });
    expect(forked.lifetimeUsage).toBeDefined(); // 旧实现：缺省不挂
    expect(await forked.lifetimeUsage!()).toEqual({ input: 10, output: 4, sessions: 1 }); // 子体自身 5/1 跳过（lineage 以父计）、父 10/4 按兄弟计入
    await forked.close();
  });

  it("② own=InMemory（无跨会话口径后端）：照旧缺省不挂（不假装有 lifetime——调用方回退当前会话口径）", async () => {
    const parent = new InMemorySessionStore();
    await parent.append("session/header", {});
    const own = new InMemorySessionStore();
    const forked = new ForkedSessionStore({ parent, own });
    expect(forked.lifetimeUsage).toBeUndefined();
  });
});

describe("CS-12 祖先指针格式闸（2026-09-28 code review）：header.parentSession 出自文件内容——非法形态不进路径 join", () => {
  it("parentSession 含 \"../\" → warn + 按找不到祖先就地截断（自身段照常、桶外零创建）", async () => {
    const d = tmp();
    // 合法根落桶（证明截断不是「桶空」造成），子体父指针却指向 ../evil-cs12
    const root = new JsonlSessionStore({ dir: d });
    await root.append("session/header", { format: 1, cwd: d, parentSession: null });
    await root.flush();
    await root.close();
    const s = new JsonlSessionStore({ dir: d });
    await s.append("session/header", { format: 1, cwd: d, parentSession: "../evil-cs12" });
    await s.append("user/message", { content: [{ kind: "text", text: "子代问" }] });
    const childId = s.sessionId;
    await s.flush();
    await s.close();
    const warns: string[] = [];
    // locate 直返（不走 sessionFileExists 出口闸）——验证 openFrom 内的格式闸独立于 locate 生效
    const view = await openSessionView({
      sessionId: childId, bucket: d,
      makeStore: (sid, bucket) => new JsonlSessionStore({ dir: bucket, sessionId: sid }),
      locate: () => ({ bucket: d }),
      sink: { warn: (code) => warns.push(code) },
    });
    const texts = (await view.store.all()).map((e) => (e.content as { text?: string }[] | undefined)?.[0]?.text ?? e.type);
    expect(texts).toEqual(["session/header", "子代问"]); // 只剩自身段（截断）
    expect(warns).toContain("session.fork-parent-invalid");
    expect(existsSync(join(d, "..", "evil-cs12"))).toBe(false); // 桶外零逃逸（旧实现会把 ../evil-cs12 喂进 makeStore 的 join）
    await view.store.close();
  });
});

describe("h.fork 落盘式分叉出口（会话树批 T6——缝一内核半边）", () => {
  const mkHarness = async (d: string) => {
    const fp = fakeProvider(script);
    const h = await createHarness({
      cwd: d,
      sessionsDir: d,
      diagDir: d,
      spillDir: join(d, "spill"),
      modules: [{ ...fakeProviderModule("fake", []), activate: (ctx) => ctx.provide("provider:fake" as never, fp.stream) }],
      config: { userFile: join(d, "u.toml"), projectFile: join(d, "p.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      discovery: { userDir: join(d, "m"), projectDir: join(d, "pm"), trustFile: join(d, "t.json") },
      secretsFile: join(d, "s.env"),
    });
    return { h, fp };
  };
  const readOwn = async (d: string, sid: string) =>
    (await new JsonlSessionStore({ dir: d, sessionId: sid }).all());

  it("① fork 落盘不激活：当前会话文件不变、新文件前两行 = header{parentSession} + session/fork{sourceEntryId=缺省尾}", async () => {
    const d = tmp();
    const { h, fp } = await mkHarness(d);
    await h.prompt("第一问");
    const before = await readOwn(d, h.sessionId);
    const { sessionId } = await h.fork();
    expect(sessionId).not.toBe(h.sessionId);
    const after = await readOwn(d, h.sessionId);
    expect(after).toHaveLength(before.length); // 当前会话原地不动
    const own = await readOwn(d, sessionId);
    expect(own[0]).toMatchObject({ type: "session/header", parentSession: h.sessionId });
    expect(own[1]).toMatchObject({ type: "session/fork", sourceEntryId: before[before.length - 1]!.id, parentSession: h.sessionId });
    expect(fp.requests).toHaveLength(1); // fork 不发请求、不切换
    await h.close();
  });

  it("② 指定 atEntryId = 分叉点；连续 fork 两次出两枝（互不影响）", async () => {
    const d = tmp();
    const { h } = await mkHarness(d);
    await h.prompt("问一");
    const events = await h.history();
    const cut = events.find((e) => e.type === "user/message")!.id;
    const b1 = await h.fork({ atEntryId: cut });
    const b2 = await h.fork(); // 缺省 = 投影尾
    const o1 = await readOwn(d, b1.sessionId);
    const o2 = await readOwn(d, b2.sessionId);
    expect(o1[1]).toMatchObject({ type: "session/fork", sourceEntryId: cut });
    expect(o2[1]!.sourceEntryId).not.toBe(cut);
    expect(b1.sessionId).not.toBe(b2.sessionId);
    await h.close();
  });

  it("③ 新会话在扫描面可见（/sessions 能列出——落盘即树成员）", async () => {
    const d = tmp();
    const { h } = await mkHarness(d);
    await h.prompt("问一");
    const { sessionId } = await h.fork();
    // scanSessionFiles(root) 的 root = 桶父目录；这里 sessionsDir=d 本身是桶——直接扫桶
        const ids = scanBucketSessions(d).map((e) => e.id);
    expect(ids).toContain(h.sessionId);
    expect(ids).toContain(sessionId);
    await h.close();
  });

  it("④ atEntryId 不在当前投影 = 抛错且不写盘（防 fork.ts 宽松降级静默变全量前缀——T12 b 键兜底）", async () => {
    const d = tmp();
    const { h } = await mkHarness(d);
    await h.prompt("问一");
    const before = scanBucketSessions(d).length;
    await expect(h.fork({ atEntryId: "e-nonexistent" })).rejects.toThrow(/分叉点/);
    const after = scanBucketSessions(d).length;
    expect(after).toBe(before); // 抛错路径零写盘
    await h.close();
  });
});

describe("T5 m5-resume-perf: verifyChain 窗口头感知（窗口镜像装载的误报豁免）", () => {
  /** 窗口镜像形态：种子（header/label——文件头预算读）+ 窗口（压缩事件起——首条 parentId 指向窗外合法 id）。 */
  const windowed = (): SessionEvent[] => [
    { v: 1, id: "e_1", parentId: null, seq: 1, ts: "t", type: "session/header" },
    { v: 1, id: "e_2", parentId: "e_1", seq: 2, ts: "t", type: "session/label" },
    { v: 1, id: "e_90", parentId: "e_89", seq: 90, ts: "t", type: "turn/compaction" }, // parentId 指向窗外（e_89 不在镜像内）
    { v: 1, id: "e_91", parentId: "e_90", seq: 91, ts: "t", type: "user/message" },
  ];

  it("① 窗口头：接缝（种子尾→窗口首 parentId 越窗）豁免零 issue；缺省调用照报（现状钉）", () => {
    expect(verifyChain(windowed(), { windowedHead: true })).toEqual([]);
    const issues = verifyChain(windowed());
    expect(issues.some((i) => i.includes("parentId 链断裂"))).toBe(true);
  });

  it("② 豁免只给接缝一处：窗口体内的真断链照报（窗口化不等于免检）", () => {
    const events = windowed();
    events[3] = { ...events[3]!, parentId: "e_other" }; // 窗口体内第二处断链
    const issues = verifyChain(events, { windowedHead: true });
    expect(issues.some((i) => i.includes("parentId 链断裂"))).toBe(true);
  });

  it("③ 段内 seq 单调与孤儿配对不受豁免影响：窗口体 seq 回退照报", () => {
    const events = windowed();
    events[3] = { ...events[3]!, seq: 50 }; // 窗口体内 seq 回退
    const issues = verifyChain(events, { windowedHead: true });
    expect(issues.some((i) => i.includes("seq 非单调"))).toBe(true);
  });

  it("④ 链式多段（fork 投影 = 父段 + 子段，各自窗口装载）：每段各有一条接缝可豁免（T11 祖先链同窗口的行为前提）", () => {
    const parentSeg = windowed(); // 父段：seed + 窗口（e_1/e_2/e_90/e_91）
    const ownSeg: SessionEvent[] = [
      { v: 1, id: "f_1", parentId: null, seq: 1, ts: "t", type: "session/header" },
      { v: 1, id: "f_2", parentId: "f_1", seq: 2, ts: "t", type: "session/fork" },
      { v: 1, id: "f_70", parentId: "f_69", seq: 70, ts: "t", type: "turn/compaction" }, // 子段自己的接缝
      { v: 1, id: "f_71", parentId: "f_70", seq: 71, ts: "t", type: "user/message" },
    ];
    expect(verifyChain([...parentSeg, ...ownSeg], { windowedHead: true })).toEqual([]);
  });
});
