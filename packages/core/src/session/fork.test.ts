import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chunk } from "@orosus/contracts/provider";
import { fakeProvider, fakeProviderModule } from "@orosus/testing";
import { JsonlSessionStore } from "./jsonl.ts";
import { repairFile } from "./jsonl.ts";
import { ForkedSessionStore, openSessionView, verifyChain } from "./fork.ts";
import { InMemorySessionStore } from "./memory.ts";
import { createHarness } from "../index.ts";
import { deriveMessages } from "../loop/convert.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
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
});
