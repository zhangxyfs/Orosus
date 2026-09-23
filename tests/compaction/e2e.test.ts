import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import type { Chunk } from "@orosus/contracts/provider";
import type { ModuleDefinition } from "@orosus/contracts/module";
import compaction from "@orosus/compaction";

/** T5 端到端：compaction 经 harness 全链——ctx.llm 摘要 → turn/compaction 落日志 → 投影应用进主请求。 */
describe("compaction 端到端（M3 T5/T9）", () => {
  it("压缩后主请求 messages 前缀为摘要消息，被压缩的原文不再进请求", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-compaction-"));
    try {
      writeFileSync(join(dir, "config.toml"), "[compaction]\nthresholdTokens = 1\n", "utf8");
      const big = "x".repeat(70_000); // ≈17500 token > 16000 回落预算（keepRecentTokens 已退役剥离——T0 适配夹具）
      const fp = fakeProvider([
        [{ type: "text/delta", text: "turn1" }, { type: "finish", kind: "stop" }] as Chunk[],
        [{ type: "text/delta", text: "摘要产物" }, { type: "finish", kind: "stop" }] as Chunk[],
        [{ type: "text/delta", text: "turn2" }, { type: "finish", kind: "stop" }] as Chunk[],
      ]);
      const providerModule: ModuleDefinition = {
        name: "provider-fake", version: "0.1.0", description: "f", api: 1,
        activate: (ctx) => { ctx.provide("provider:fake" as never, fp.stream); },
      };
      const h = await createHarness({
        cwd: dir,
        store: new InMemorySessionStore(),
        diagDir: dir,
        spillDir: join(dir, "spill"),
        modules: [providerModule],
        builtinModules: [compaction],
        secretsFile: join(dir, "s.env"),
        discovery: { userDir: join(dir, "m"), projectDir: join(dir, "p"), trustFile: join(dir, "t.json") },
        config: { userFile: join(dir, "config.toml"), projectFile: join(dir, "n.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      });
      await h.prompt(big);     // 历史 1 条——预算吞没全对话（len−cut < minKeep）cut=0 不压缩；主请求 #0
      await h.prompt("more");  // 历史 3 条 → 压缩：llm 摘要（请求 #1）→ 主请求 #2 前缀 = 摘要
      const last = fp.requests[2]!;
      const first = last.messages[0] as { role: string; content: { kind: string; text: string }[] };
      expect(String(first.content[0]!.text)).toContain("[历史摘要]");
      expect(String(first.content[0]!.text)).toContain("摘要产物");
      expect(JSON.stringify(last.messages)).not.toContain("x".repeat(100));
      await h.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("compaction × fork/resume（M3 T9）", () => {
  it("压缩后 fork：新会话投影保留摘要、不含被压缩原文（append-only 下 fork 与压缩正交）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-compaction-fork-"));
    try {
      writeFileSync(join(dir, "config.toml"), "[compaction]\nthresholdTokens = 1\n", "utf8");
      const big = "x".repeat(70_000); // ≈17500 token > 16000 回落预算（T0 适配夹具，同上）
      const fp = fakeProvider([
        [{ type: "text/delta", text: "turn1" }, { type: "finish", kind: "stop" }] as Chunk[],
        [{ type: "text/delta", text: "摘要产物" }, { type: "finish", kind: "stop" }] as Chunk[],
        [{ type: "text/delta", text: "turn2" }, { type: "finish", kind: "stop" }] as Chunk[],
      ]);
      const providerModule: ModuleDefinition = {
        name: "provider-fake", version: "0.1.0", description: "f", api: 1,
        activate: (ctx) => { ctx.provide("provider:fake" as never, fp.stream); },
      };
      const base = {
        cwd: dir, sessionsDir: dir, diagDir: dir, spillDir: join(dir, "spill"),
        modules: [providerModule], builtinModules: [compaction],
        secretsFile: join(dir, "s.env"),
        discovery: { userDir: join(dir, "m"), projectDir: join(dir, "p"), trustFile: join(dir, "t.json") },
        config: { userFile: join(dir, "config.toml"), projectFile: join(dir, "n.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      };
      const h1 = await createHarness(base);
      await h1.prompt(big);
      await h1.prompt("more"); // 触发压缩（llm 摘要 = 请求 #1）
      const parent = h1.sessionId;
      await h1.close();
      const h2 = await createHarness({ ...base, fork: { parentSessionId: parent } });
      await h2.prompt("分叉后");
      const msgs = fp.requests[3]!; // 分叉会话首个主请求
      expect(String((msgs.messages[0] as { content: { text: string }[] }).content[0]!.text)).toContain("[历史摘要]");
      expect(JSON.stringify(msgs.messages)).not.toContain("x".repeat(100));
      await h2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
