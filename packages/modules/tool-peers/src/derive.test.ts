import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveRecentWrites, isSessionLive, normalizePath, parseClaims, parseToolCallLine, pidAlive, readLabel, readTailLines,
} from "./derive.ts";

const NOW = Date.parse("2026-10-06T10:00:00.000Z");
const ev = (fields: Record<string, unknown>, type: string) => JSON.stringify({ ...fields, v: 1, ts: "2026-10-06T09:59:30.000Z", type });
// 信封 type 为末键（jsonl.ts:676-684）——样例行必须手拼保持键序
const toolCall = (name: string, args: Record<string, unknown>, ts = "2026-10-06T09:59:30.000Z") =>
  `{"callId":"c1","name":${JSON.stringify(name)},"args":${JSON.stringify(args)},"v":1,"id":"e3","parentId":"e2","seq":3,"ts":${JSON.stringify(ts)},"type":"tool/call"}`;
const labelLine = (label: string) => `{"label":${JSON.stringify(label)},"v":1,"id":"e2","parentId":"e1","seq":2,"ts":"2026-10-06T09:59:00.000Z","type":"session/label"}`;

describe("parseToolCallLine", () => {
  it("parses a tool/call line", () => {
    const c = parseToolCallLine(toolCall("tool-fs__write", { path: "src/a.ts" }));
    expect(c?.name).toBe("tool-fs__write");
    expect(c?.args["path"]).toBe("src/a.ts");
  });
  it("rejects non-tool lines and bad JSON", () => {
    expect(parseToolCallLine(ev({ label: "x" }, "session/label"))).toBeUndefined();
    expect(parseToolCallLine(`{"broken":`)).toBeUndefined();
  });
});

describe("deriveRecentWrites", () => {
  const lines = [
    toolCall("tool-fs__write", { path: "src/a.ts" }),
    toolCall("tool-fs__edit", { path: "src/B.ts" }),
    toolCall("tool-shell__exec", { cmd: "echo hi > out.txt" }),   // Bash 不推导
    toolCall("tool-fs__read", { path: "src/c.ts" }),              // 读不算
    toolCall("tool-fs__write", { path: "src/old.ts" }, "2026-10-06T09:00:00.000Z"), // 窗口外
  ];
  it("derives only fresh write-tool touches", () => {
    const m = deriveRecentWrites(lines, NOW, 10 * 60_000);
    expect(m.has(normalizePath("src/a.ts"))).toBe(true);
    expect(m.has(normalizePath("src/B.ts"))).toBe(true);   // 同串命中（任意平台）
    if (process.platform === "win32") expect(m.has(normalizePath("src/b.ts"))).toBe(true);   // 大小写无关仅 win32（D3）——CI 是 ubuntu-latest，写死跨平台断言必红
    expect(m.size).toBe(2);
  });
});

describe("parseClaims", () => {
  it("keeps unexpired claims only", () => {
    const cs = parseClaims(JSON.stringify([
      { file: "src/a.ts", since: NOW - 60_000, until: NOW + 60_000 },
      { file: "src/gone.ts", since: 0, until: NOW - 1 },
    ]), NOW);
    expect(cs).toHaveLength(1);
    expect(cs[0]?.file).toBe("src/a.ts");
  });
  it("tolerates bad json", () => expect(parseClaims("not json", NOW)).toEqual([]));
});

describe("liveness", () => {
  it("own pid is alive; bogus pid is not", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(999_999_999)).toBe(false);   // 超出 pid 空间必 ESRCH（勿用 -1——POSIX 会 EPERM 误判活）
  });
  it("lock with live pid wins; no lock falls back to mtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "peers-derive-"));
    try {
      const sid = join(dir, "s_x");
      mkdirSync(join(sid, "agents"), { recursive: true });
      writeFileSync(join(sid, "agents", "session.lock"), `${process.pid}\n2026-10-06T09:00:00Z\n`);
      expect(isSessionLive(sid, NOW, 90_000)).toBe(true);
      writeFileSync(join(sid, "agents", "session.lock"), `999999999\nx\n`); // 死 pid
      expect(isSessionLive(sid, NOW, 90_000)).toBe(false);
      rmSync(join(sid, "agents", "session.lock"));
      writeFileSync(join(sid, "agents", "session.jsonl"), "{}\n");  // mtime = 现在
      expect(isSessionLive(sid, Date.now(), 90_000)).toBe(true);
      expect(isSessionLive(sid, Date.now() + 200_000, 90_000)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("readTailLines", () => {
  it("drops the partial first line when truncated", () => {
    const dir = mkdtempSync(join(tmpdir(), "peers-tail-"));
    try {
      const f = join(dir, "log.jsonl");
      writeFileSync(f, `${toolCall("tool-fs__write", { path: "a.ts" })}\n${toolCall("tool-fs__edit", { path: "b.ts" })}\n`);
      const lines = readTailLines(f, 40);   // 强制截断
      expect(lines.every(l => l.endsWith(`"type":"tool/call"}`))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("readLabel", () => {
  it("takes the last session/label line", () => {
    const lines = [labelLine("旧标题"), toolCall("tool-fs__write", { path: "a.ts" }), labelLine("重构")];
    expect(readLabel(lines, "fallback")).toBe("重构");
  });
  it("falls back when no label line", () => {
    expect(readLabel([toolCall("tool-fs__write", { path: "a.ts" })], "s_ab12cd34")).toBe("s_ab12cd34");
  });
});
