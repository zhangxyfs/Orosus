import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chunk } from "@orosus/contracts/provider";
import { fakeProvider, fakeProviderModule } from "@orosus/testing";
import { sqliteAvailable, setSqliteProbeForTest, SqliteSessionStore } from "./sqlite.ts";
import { verifyChain } from "./fork.ts";
import { scanBucketSessions } from "./dir.ts";
import { createHarness } from "../index.ts";
import type { SessionEvent } from "./types.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tmp = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-sqlite-")));

describe("SqliteSessionStore（M3 T7，D42）", () => {
  it.skipIf(!sqliteAvailable())("① roundtrip：append → all() 事件序列与信封字段一致、seq 单调", async () => {
    const d = tmp();
    const s = new SqliteSessionStore({ dir: d });
    await s.append("session/header", { format: 1 });
    const e2 = await s.append("user/message", { content: [{ kind: "text", text: "hi" }] });
    await s.append("turn/start", { model: "m" });
    const all = await s.all();
    expect(all.map((e) => e.type)).toEqual(["session/header", "user/message", "turn/start"]);
    expect(e2.seq).toBe(2);
    expect(e2.parentId).toBe(all[0]!.id);
    expect(all.every((e, i) => i === 0 || (e.seq === all[i - 1]!.seq + 1 && e.parentId === all[i - 1]!.id))).toBe(true);
    expect(verifyChain(all)).toEqual([]);
    await s.close();
  });

  it.skipIf(!sqliteAvailable())("② close 后重开载入（resume 路径）", async () => {
    const d = tmp();
    const s1 = new SqliteSessionStore({ dir: d });
    await s1.append("session/header", { format: 1 });
    await s1.append("user/message", { content: [] });
    const id = s1.sessionId;
    await s1.close();
    const s2 = new SqliteSessionStore({ dir: d, sessionId: id });
    expect((await s2.all()).map((e) => e.type)).toEqual(["session/header", "user/message"]);
    const next = await s2.append("user/message", { content: [] });
    expect(next.seq).toBe(3);
    expect(next.parentId).toBe((await s2.all())[1]!.id);
    await s2.close();
  });

  it.skipIf(!sqliteAvailable())("③ 并发 append 串行化：seq 无重复、parentId 链完整", async () => {
    const d = tmp();
    const s = new SqliteSessionStore({ dir: d });
    await Promise.all(Array.from({ length: 50 }, (_, i) => s.append("user/message", { content: [], i })));
    const all = await s.all();
    expect(all).toHaveLength(50);
    const seqs = new Set(all.map((e) => e.seq));
    expect(seqs.size).toBe(50);
    expect(verifyChain(all)).toEqual([]);
    await s.close();
  });

  it.skipIf(!sqliteAvailable())("④ sessionStore 配置选择：sqlite 生成 .sqlite、缺省 jsonl 不变、非法值启动失败", async () => {
    const mk = async (toml: string | undefined) => {
      const d = tmp();
      if (toml !== undefined) writeFileSync(join(d, "config.toml"), toml, "utf8");
      const fp = fakeProvider([[{ type: "text/delta", text: "ok" }, { type: "finish", kind: "stop" }] as Chunk[]]);
      const h = await createHarness({
        cwd: d,
        sessionsDir: d,
        diagDir: d,
        spillDir: join(d, "spill"),
        modules: [{ ...fakeProviderModule("fake", []), activate: (ctx) => ctx.provide("provider:fake" as never, fp.stream) }],
        secretsFile: join(d, "s.env"),
        discovery: { userDir: join(d, "m"), projectDir: join(d, "p"), trustFile: join(d, "t.json") },
        config: { userFile: join(d, "config.toml"), projectFile: join(d, "n.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      });
      return { h, d };
    };
    const a = await mk('sessionStore = "sqlite"');
    await a.h.prompt("hi");
    await a.h.close();
    // 会话树批 T3 目录化：主文件落 <桶>/<sid>/agents/——经 scanBucketSessions 枚举（s_ 前缀区分诊断日志）
    const sessionMains = (d: string): string[] => scanBucketSessions(d).filter((e) => e.id.startsWith("s_")).map((e) => e.file);
    expect(sessionMains(a.d).some((f) => f.endsWith("session.sqlite"))).toBe(true);
    const b = await mk(undefined); // 缺省 jsonl
    await b.h.prompt("hi");
    await b.h.close();
    expect(sessionMains(b.d).some((f) => f.endsWith("session.jsonl"))).toBe(true);
    await expect(mk('sessionStore = "oracle"')).rejects.toThrow(/sessionStore 配置非法/);
  });

  it("⑤ node:sqlite 不可用 → 构造抛响亮错误（注入式探测 fake）；jsonl 缺省不受影响", () => {
    setSqliteProbeForTest(() => false);
    try {
      const d = tmp();
      expect(() => new SqliteSessionStore({ dir: d })).toThrow(/node:sqlite.*不可用|不可用.*jsonl/);
      expect(existsSync(join(d, "x"))).toBe(false); // 未创建任何东西
    } finally {
      setSqliteProbeForTest(); // 复位真探测
    }
    expect(typeof sqliteAvailable()).toBe("boolean");
    void ({} as SessionEvent);
  });
});
