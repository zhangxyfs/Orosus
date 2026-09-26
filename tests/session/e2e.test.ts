import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, JsonlSessionStore, deriveMessages, verifyChain, repairFile, type SessionEvent } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import type { Chunk } from "@orosus/contracts/provider";

/** M4-1 T6：D45 新形状（message 含 reasoning 块 + usage，chunk 绝迹）下的 fork / resume 旧格式 /
 *  自修复复核——计划定案「verifyChain / repairFile 对新形状零适配即过」，逐条断言在此钉住。 */

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-t6-")));

const script: Chunk[][] = [[
  { type: "reasoning/delta", text: "想" },
  { type: "text/delta", text: "答" },
  { type: "usage", input: 5, output: 1 },
  { type: "finish", kind: "stop" },
]];
const hermetic = (d: string) => ({ userFile: join(d, "no-user.toml"), projectFile: join(d, "no-proj.toml"), env: {} });
const mk = (d: string, extra: Parameters<typeof createHarness>[0] = {}) =>
  createHarness({
    diagDir: d,
    spillDir: join(d, "spill"),
    sessionsDir: join(d, "sessions"),
    modules: [fakeProviderModule("fake", script)],
    config: { ...hermetic(d), cliOverrides: { model: "fake/m" } },
    ...extra,
  });

describe("M4-1 T6：新形状下的 fork / resume / 自修复复核", () => {
  it("① fork 无 chunk 依赖：子会话零 chunk；复合投影过滤 reasoning、正文在", async () => {
    const d = fresh();
    const hp = await mk(d);
    await hp.prompt("父问");
    await hp.close();
    const parentEvents = await new JsonlSessionStore({ dir: join(d, "sessions"), sessionId: hp.sessionId }).all();
    const hc = await mk(d, { fork: { parentSessionId: hp.sessionId, parentDir: join(d, "sessions") } });
    await hc.prompt("子问");
    await hc.close();
    const ownEvents = await new JsonlSessionStore({ dir: join(d, "sessions"), sessionId: hc.sessionId }).all();
    expect(ownEvents.some((e) => e.type === "assistant/chunk")).toBe(false); // 新会话零 chunk（断流）
    expect(parentEvents.some((e) => e.type === "assistant/chunk")).toBe(false);
    // 复合投影（parent 前缀 + own）经 deriveMessages：reasoning 被滤、正文双在
    const projection = deriveMessages([...parentEvents, ...ownEvents]);
    const texts = projection.filter((m) => m.role === "assistant").map((m) => JSON.stringify(m.content));
    expect(texts).toHaveLength(2);
    expect(texts.every((t) => !t.includes("reasoning"))).toBe(true);
    expect(texts.every((t) => t.includes("答"))).toBe(true);
  });

  it("② resume 旧格式（含 chunk 与旧 message）投影正常：chunk 被跳过、新旧 message 并存、链校验零问题", async () => {
    const d = fresh();
    const sid = "s_legacy";
    mkdirSync(join(d, "sessions", sid, "agents"), { recursive: true });
    const lines = [
      { v: 1, id: "e1", parentId: null, seq: 1, ts: "2026-09-01T00:00:00Z", type: "session/header", format: 1, cwd: "/old", parentSession: null },
      { v: 1, id: "e2", parentId: "e1", seq: 2, ts: "2026-09-01T00:00:01Z", type: "user/message", content: [{ kind: "text", text: "旧问" }] },
      { v: 1, id: "e3", parentId: "e2", seq: 3, ts: "2026-09-01T00:00:02Z", type: "assistant/chunk", chunk: { type: "usage", input: 10, output: 4 } },
      { v: 1, id: "e4", parentId: "e3", seq: 4, ts: "2026-09-01T00:00:03Z", type: "assistant/message", content: [{ kind: "text", text: "旧答" }] },
      { v: 1, id: "e5", parentId: "e4", seq: 5, ts: "2026-09-01T00:00:04Z", type: "turn/end", kind: "completed" },
    ];
    writeFileSync(join(d, "sessions", sid, "agents", "session.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const h = await mk(d, { store: new JsonlSessionStore({ dir: join(d, "sessions"), sessionId: sid }), resume: { sessionId: sid } });
    await h.prompt("续问");
    const u = await h.usage(); // 批⑤：/usage 命令退役 → 读口
    expect(u.current).toEqual({ input: 15, output: 5 }); // 双形态：旧 chunk 10/4 + 新 message 5/1
    await h.close();
    const events = await new JsonlSessionStore({ dir: join(d, "sessions"), sessionId: sid }).all();
    const projection = deriveMessages(events);
    expect(projection.filter((m) => m.role === "assistant").map((m) => JSON.stringify(m.content))).toEqual(
      ['[{"kind":"text","text":"旧答"}]', '[{"kind":"text","text":"答"}]'],
    ); // 旧 chunk 不进投影（既有语义），新旧 message 并存
    expect(verifyChain(events)).toEqual([]); // 复核留痕 ③：verifyChain 对新形状零适配即过
  });

  it("③ repairFile 对新格式撕裂尾：截断坏尾、剩余行链校验零问题（复核留痕）", () => {
    const d = fresh();
    const file = join(d, "torn.jsonl");
    const good = [
      { v: 1, id: "e1", parentId: null, seq: 1, ts: "2026-09-01T00:00:00Z", type: "session/header", format: 1, cwd: "/x", parentSession: null },
      { v: 1, id: "e2", parentId: "e1", seq: 2, ts: "2026-09-01T00:00:01Z", type: "user/message", content: [{ kind: "text", text: "q" }] },
      { v: 1, id: "e3", parentId: "e2", seq: 3, ts: "2026-09-01T00:00:02Z", type: "assistant/message", content: [{ kind: "reasoning", text: "r" }, { kind: "text", text: "a" }], usage: { input: 1, output: 1 } },
    ];
    writeFileSync(file, good.map((l) => JSON.stringify(l)).join("\n") + "\n" + '{"v":1,"id":"e4","par'); // 撕裂尾
    const r = repairFile(file);
    expect(r.truncated).toBe(true);
    const events = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent);
    expect(events).toHaveLength(3);
    expect(verifyChain(events)).toEqual([]); // 剩余好行链合法——repairFile 对新形状零适配即过
  });
});
