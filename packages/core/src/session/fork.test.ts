import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chunk } from "@orosus/contracts/provider";
import { fakeProvider, fakeProviderModule } from "@orosus/testing";
import { JsonlSessionStore } from "./jsonl.ts";
import { repairFile } from "./jsonl.ts";
import { ForkedSessionStore, verifyChain } from "./fork.ts";
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
