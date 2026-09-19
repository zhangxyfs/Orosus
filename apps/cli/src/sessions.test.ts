import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
const { setTitle } = await import("./sessions.ts");

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
    // 命令归一化（2026-09-19 用户走查）：斜杠后空格/连续空格/首尾空白一律可解析
    expect(sessionCommand("/ exit", { sessionId: "s1" })).toEqual({ kind: "quit" });
    expect(sessionCommand("  /quit  ", { sessionId: "s1" })).toEqual({ kind: "quit" });
    expect(sessionCommand("/ resume   2", { sessionId: "s1" })).toEqual({ kind: "resume", sessionId: "2" });
    expect(sessionCommand("/  sessions", { sessionId: "s1" })).toEqual({ kind: "pick" });
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
    expect(harnessOptionsFor({ kind: "fork", parentSessionId: "s_p" }, { parentDir: "/bucket/x" })).toEqual(
      { fork: { parentSessionId: "s_p", parentDir: "/bucket/x" } },
    ); // 装配层钉子（code-review Spec P1）：fork 跨桶定位的 parentDir 透传——拿掉接线必红
  });
});

describe("/title 会话手动命名（M4-2 T0/B9 剩余——session/label 预留类型首次消费）", () => {
  it("① /title 无参 → sessionCommand 返回 {kind:'title'}（无 name/target）", () => {
    expect(sessionCommand("/title", { sessionId: "s1" })).toEqual({ kind: "title" });
    expect(sessionCommand("/rename", { sessionId: "s1" })).toEqual({ kind: "title" }); // 别名
  });

  it("② /title 名 → setTitle 落 session/label（截断 200 字符）", async () => {
    const root = fresh();
    sessionFile(root, "s_target", [ev("e1", "session/header")]);
    const r = await setTitle(root, "s_target", undefined, "我的调试会话");
    expect(r).toEqual({ sid: "s_target" });
    const lines = readFileSync(join(root, "s_target.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: "session/label", label: "我的调试会话" });
    // 截断测试
    const long = "很长的名字".repeat(50);
    await setTitle(root, "s_target", undefined, long);
    const lines2 = readFileSync(join(root, "s_target.jsonl"), "utf8").trim().split("\n");
    const last = JSON.parse(lines2[lines2.length - 1]!);
    expect(last.label.length).toBeLessThanOrEqual(200);
  });

  it("③ /title 2 名 → resolveTarget 定位第二会话追加 label", async () => {
    const root = fresh();
    sessionFile(root, "s_first", [ev("e1", "session/header")], undefined, 5); // 旧
    sessionFile(root, "s_second", [ev("e1", "session/header")]); // 新
    // listSessions 倒序 → 1=s_second 2=s_first
    const r = await setTitle(root, "s_current", "2", "指定命名");
    expect(r).toEqual({ sid: "s_first" }); // 序号 2 = 较旧的 s_first
    const lines = readFileSync(join(root, "s_first.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: "session/label", label: "指定命名" });
  });

  it("④ sessionCommand 解析 /title 有参形态（名 / 序号+名）", () => {
    expect(sessionCommand("/title 我的调试", { sessionId: "s1" }))
      .toEqual({ kind: "title", name: "我的调试" });
    expect(sessionCommand("/title 2 其他名", { sessionId: "s1" }))
      .toEqual({ kind: "title", name: "其他名", target: "2" });
  });

  it("⑤ 多枚 session/label → readTitle 取最后（手动 /title 覆盖自动标题——T0 走查实录回归钉）", () => {
    const root = fresh();
    sessionFile(root, "s_multi", [
      ev("e1", "session/header"),
      ev("e2", "user/message", { content: [{ kind: "text", text: "问" }] }),
      ev("e3", "session/label", { label: "自动标题" }),
      ev("e4", "session/label", { label: "手动命名" }),
    ]);
    expect(readTitle(join(root, "s_multi.jsonl"), "s_multi")).toBe("手动命名");
  });
});

describe("pickSessionNumber（走查定案：不选即取消——专门取消项退役）", () => {
  it("① 空输入 = 取消（undefined）；② 有效序号返回；③ 无效序号重问直到有效", async () => {
    const { pickSessionNumber } = await import("./sessions.ts");
    expect(await pickSessionNumber(async () => "", 3)).toBeUndefined();          // 直接回车 = 取消
    expect(await pickSessionNumber(async () => " 2 ", 3)).toBe(2);               // 容忍空白
    const answers = ["abc", "9", "1"];
    let i = 0;
    expect(await pickSessionNumber(async () => answers[i++]!, 3)).toBe(1);       // 无效两轮后命中
    expect(i).toBe(3);
  });
});

describe("readTitle 读取预算（M4-2.5 T2——日志调研 P5：列表不被无对话大文件拖慢）", () => {
  it("① 无 label 无对话的超大文件 → 64 行/16KB 内退化为 sid", () => {
    const root = fresh();
    const noise = Array.from({ length: 200 }, (_, i) => ev(`e${i}`, "assistant/message", { content: [{ kind: "text", text: "x".repeat(200) }] }));
    sessionFile(root, "s_noise", noise); // 无 label、无 user/message——现状要读完 200 行
    expect(readTitle(join(root, "s_noise.jsonl"), "s_noise")).toBe("s_noise"); // 预算内无命中 → sid
  });
  it("② 预算是硬上限不是软提示：label 越预算退 sid、预算内正常命中", () => {
    const root = fresh();
    // label 在第 100 行（预算外）也退 sid
    const withLabel = [...Array.from({ length: 100 }, (_, i) => ev(`e${i}`, "assistant/message", { content: [{ kind: "text", text: "x".repeat(200) }] })), ev("l", "session/label", { label: "百行之后" })];
    sessionFile(root, "s_label_late", withLabel);
    expect(readTitle(join(root, "s_label_late.jsonl"), "s_label_late")).toBe("s_label_late");
    // 对照：label 在前 64 行内 → 正常命中
    const early = [ev("e1", "session/header"), ev("e2", "session/label", { label: "早标签" })];
    sessionFile(root, "s_label_early", early);
    expect(readTitle(join(root, "s_label_early.jsonl"), "s_label_early")).toBe("早标签");
  });
});
