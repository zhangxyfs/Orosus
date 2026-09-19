import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, formatSessions, harnessOptionsFor, relativeTime, resolveTarget, sessionCommand, readTitle } from "./sessions.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-sessions-")));

const ev = (id: string, type: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, id, parentId: null, seq: 1, ts: "2026-09-01T00:00:00Z", type, ...fields });
const sessionFile = (root: string, sid: string, lines: string[], bucket?: string, ageDays?: number): void => {
  const target = bucket === undefined ? root : join(root, bucket);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `${sid}.jsonl`), lines.join("\n") + "\n");
  if (ageDays !== undefined) {
    const t = new Date(Date.now() - ageDays * 86_400_000);
    utimesSync(join(target, `${sid}.jsonl`), t, t);
  }
};

describe("会话列表人性化（B9 拉前，2026-09-19 走查：标题/相对时间/倒序/当前高亮/无黑话）", () => {
  it("① readTitle 三级：session/label 优先 → 首问文本兜底 → sid 兜底", () => {
    const root = fresh();
    sessionFile(root, "s_labeled", [ev("e1", "session/header"), ev("e2", "user/message", { content: [{ kind: "text", text: "问个好" }] }), ev("e3", "session/label", { label: "问候测试" })]);
    sessionFile(root, "s_fallback", [ev("e1", "session/header"), ev("e2", "user/message", { content: [{ kind: "text", text: "这是一个特别长的首问文本应该被截断到二十个字符以内才对" }] })]);
    sessionFile(root, "s_empty", [ev("e1", "session/header")]);
    expect(readTitle(join(root, "s_labeled.jsonl"), "s_labeled")).toBe("问候测试");
    expect(readTitle(join(root, "s_fallback.jsonl"), "s_fallback")).toBe("这是一个特别长的首问文本应该被截断到二十");
    expect(readTitle(join(root, "s_empty.jsonl"), "s_empty")).toBe("s_empty");
  });

  it("② listSessions：双层可见、按创建时间倒序（最新在最前）、带标题", () => {
    const root = fresh();
    sessionFile(root, "s_old", [ev("e1", "session/header"), ev("e2", "user/message", { content: [{ kind: "text", text: "旧会话" }] })], undefined, 5);
    mkdirSync(join(root, "D--proj-a1b2c3d4"), { recursive: true });
    writeFileSync(join(root, "D--proj-a1b2c3d4", "s_new.jsonl"), [ev("e1", "session/header"), ev("e2", "user/message", { content: [{ kind: "text", text: "新会话" }] }), ev("e3", "session/label", { label: "新标题" })].join("\n") + "\n");
    const list = listSessions(root);
    expect(list.map((s) => s.id)).toEqual(["s_new", "s_old"]); // 最新最前（创建时间倒序）
    expect(list[0]!.title).toBe("新标题");
    expect(list[1]!.title).toBe("旧会话");
  });

  it("③ formatSessions：标题 + 相对时间；当前会话加粗青色；不再出现［平铺］等开发黑话", () => {
    const root = fresh();
    sessionFile(root, "s_cur", [ev("e1", "session/header"), ev("e2", "user/message", { content: [{ kind: "text", text: "当前" }] }), ev("e3", "session/label", { label: "当前会话标题" })]);
    sessionFile(root, "s_old", [ev("e1", "session/header")], undefined, 3);
    const out = formatSessions(root, "s_cur");
    expect(out).toContain("当前会话标题 · 刚刚");
    expect(out).toContain("3 天前");
    expect(out).toContain("\x1b[1;36m  1. 当前会话标题"); // 当前会话高亮（加粗青色开头）
    expect(out).not.toContain("平铺");
    expect(out).not.toContain("［");
  });

  it("④ relativeTime 分档：刚刚/分钟/小时/天/月/年", () => {
    const now = 1_800_000_000_000;
    expect(relativeTime(now - 30_000, now)).toBe("刚刚");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 天前");
    expect(relativeTime(now - 100 * 86_400_000, now)).toBe("3 个月前");
    expect(relativeTime(now - 800 * 86_400_000, now)).toBe("2 年前");
  });

  it("⑤ sessionCommand：/resume 无参=pick、/resume 2 与 /sessions abc=直达、既有命令不变", () => {
    expect(sessionCommand("/resume", { sessionId: "s1" })).toEqual({ kind: "pick" });
    expect(sessionCommand("/sessions", { sessionId: "s1" })).toEqual({ kind: "pick" });
    expect(sessionCommand("/resume 2", { sessionId: "s1" })).toEqual({ kind: "resume", sessionId: "2" });
    expect(sessionCommand("/sessions s_abc", { sessionId: "s1" })).toEqual({ kind: "resume", sessionId: "s_abc" });
    expect(sessionCommand("/quit", { sessionId: "s1" })).toEqual({ kind: "quit" });
    expect(sessionCommand("/new", { sessionId: "s1" })).toEqual({ kind: "new" });
    expect(sessionCommand("/fork", { sessionId: "s1", lastEventId: "e9" })).toEqual({ kind: "fork", parentSessionId: "s1", atEntryId: "e9" });
    expect(sessionCommand("hello", { sessionId: "s1" })).toEqual({ kind: "none" });
  });

  it("⑥ resolveTarget：序号按列表、sid 双层定位（不限前 10）、未命中 undefined；harnessOptionsFor resume 形状", () => {
    const root = fresh();
    sessionFile(root, "s_a", [ev("e1", "session/header")]);
    sessionFile(root, "s_b", [ev("e1", "session/header")], undefined, 1);
    expect(resolveTarget("1", root)).toBe("s_a"); // 最新最前
    expect(resolveTarget("s_b", root)).toBe("s_b");
    expect(resolveTarget("s_nope", root)).toBeUndefined();
    expect(resolveTarget("99", root)).toBeUndefined();
    expect(harnessOptionsFor({ kind: "resume", sessionId: "s_x" })).toEqual({ resume: { sessionId: "s_x" } });
  });
});
