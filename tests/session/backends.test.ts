import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, sqliteAvailable } from "@orosus/core";
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
    const h3 = await createHarness({ ...base, resume: { sessionId: h2.sessionId } });
    await h3.prompt("再继续");
    await h3.close();
    // resume 的投影含分叉前的历史（fake provider 断言）
    expect(JSON.stringify(fp.requests[fp.requests.length - 1]!.messages)).toContain("分叉继续");
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".sqlite")).map((f) => f.split(".").pop()!);
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
