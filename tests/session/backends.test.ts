import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, scanBucketSessions, sqliteAvailable } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import type { ModuleDefinition } from "@orosus/contracts/module";
import type { Chunk } from "@orosus/contracts/provider";

/** 双后端 fork/resume 冒烟（M3 T9）：sessionStore 配置切换后端，fork/resume 语义不随后端变化。 */
describe("双后端 fork/resume 冒烟", () => {
  const run = async (dir: string, toml: string | undefined) => {
    const fp = fakeProvider([[{ type: "text/delta", text: "ok" }, { type: "finish", kind: "stop" }] as Chunk[]]);
    const providerModule: ModuleDefinition = {
      name: "provider-fake", version: "0.1.0", description: "f", api: 1,
      activate: (ctx) => { ctx.provide("provider:fake" as never, fp.stream); },
    };
    const base = {
      cwd: dir, sessionsDir: dir, diagDir: join(dir, "logs"), spillDir: join(dir, "spill"),
      modules: [providerModule],
      secretsFile: join(dir, "s.env"),
      discovery: { userDir: join(dir, "m"), projectDir: join(dir, "p"), trustFile: join(dir, "t.json") },
      config: { userFile: join(dir, "config.toml"), projectFile: join(dir, "n.toml"), env: {}, cliOverrides: { model: "fake/x" } },
    };
    if (toml !== undefined) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "config.toml"), toml, "utf8");
    }
    const h1 = await createHarness(base);
    await h1.prompt("第一轮");
    const parent = h1.sessionId;
    await h1.close();
    const h2 = await createHarness({ ...base, fork: { parentSessionId: parent } });
    await h2.prompt("分叉继续");
    await h2.close(); // CS-03 同步（2026-09-28 code review）：单写者锁纪律——h2 活着时 h3 resume 同 sid 会撞锁
    const h3 = await createHarness({ ...base, resume: { sessionId: h2.sessionId } });
    await h3.prompt("再继续");
    await h3.close();
    // resume 的投影含分叉前的历史（fake provider 断言）——CS-01 回归钉（2026-09-28 code review P0）：
    // h2 是 fork 子体，resume(h2) 的投影必须带祖辈段「第一轮」（旧实现平铺打开子体自己那份文件，
    // 祖辈历史全丢——只含「分叉继续」）
    const msgs = JSON.stringify(fp.requests[fp.requests.length - 1]!.messages);
    expect(msgs).toContain("分叉继续");
    expect(msgs).toContain("第一轮");
    // TS-02 修复（2026-09-28 code review）：旧断言 readdirSync(dir) 顶层收 .jsonl/.sqlite——目录化（会话树批
    // T3）后会话文件在 <sid>/agents/ 下，顶层只见 sid 目录名 → exts 恒 [] → every() 恒真（后端被换/落盘
    // 失败照样绿）。改走核心扫描口 scanBucketSessions（<sid>/agents/session.* 形态、tests/subagent 同款），
    // 并加空数组护栏——空 every 恒真是所有 every 断言的通用反钉。
    const exts = scanBucketSessions(dir).map((e) => e.file.split(".").pop()!);
    expect(exts.length).toBeGreaterThan(0); // 空数组护栏：防扫描形态再漂移时 every 又恒真
    return exts;
  };

  it("jsonl（缺省）：fork → resume 链路", async () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-be-jsonl-"));
    try {
      const exts = await run(d, undefined);
      expect(exts.every((e) => e === "jsonl")).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it.skipIf(!sqliteAvailable())("sqlite：同一链路语义不变（.sqlite 会话文件）", async () => {
    const d = mkdtempSync(join(tmpdir(), "orosus-be-sqlite-"));
    try {
      const exts = await run(d, 'sessionStore = "sqlite"');
      expect(exts.every((e) => e === "sqlite")).toBe(true);
    } finally {
      // Windows：WAL/-shm 句柄释放有延迟，清理 best-effort（tmpdir 兜底）
      try { rmSync(d, { recursive: true, force: true }); } catch { /* EPERM 重试一次 */ await new Promise((r) => setTimeout(r, 100)); try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统 tmp 清理 */ } }
    }
  });
});
