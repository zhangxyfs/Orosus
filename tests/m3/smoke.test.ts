import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import type { ModuleDefinition } from "@orosus/contracts/module";
import type { Chunk } from "@orosus/contracts/provider";
import { Access, defineTool } from "@orosus/contracts/tool";
import { z } from "zod";
import approval from "@orosus/approval";
import compaction from "@orosus/compaction";

/** M3 全链冒烟（T9）：一个 turn 同时穿过调度器（fs.read 放行组）→ 审批（ask-risky 只读放行）→ 压缩（阈值触发）。 */
describe("M3 全链冒烟", () => {
  it("内置组合（tool-fs + approval + compaction）：工具经审批放行执行、超阈值压缩、请求前缀变摘要", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-m3-smoke-"));
    try {
      writeFileSync(join(dir, "config.toml"), [
        "[compaction]",
        "thresholdTokens = 6", // turn1 est 2 不压；turn2 est 10 压（v3 无 no-space，小对话照压）；turn3 压后投影含 elision/页脚仍超 → 连环压（真实行为）
        "[approval]",
        'mode = "ask-risky"',
        "",
      ].join("\n"), "utf8");
      const fp = fakeProvider([
        [{ type: "text/delta", text: "第一轮" }, { type: "finish", kind: "stop" }] as Chunk[],
        [{ type: "text/delta", text: "工具结果摘要" }, { type: "finish", kind: "stop" }] as Chunk[],
        [
          { type: "toolcall/argumentsDelta", callId: "c1", name: "m__read", argumentsDelta: "{}" } as Chunk,
          { type: "finish", kind: "toolUse" } as Chunk,
        ],
        [{ type: "text/delta", text: "读到了" }, { type: "finish", kind: "stop" }] as Chunk[],
      ]);
      const toolsModule: ModuleDefinition = {
        name: "m", version: "0.1.0", description: "读工具", api: 1,
        activate(ctx) {
          ctx.contribute.tool(defineTool({
            name: "m__read", description: "read", parameters: z.object({}),
            resolveExecution: async () => ({
              accesses: [Access.fsRead("/x")], approvalRule: "m__read",
              execute: async () => ({ output: "文件内容", isError: false }),
            }),
          }));
        },
      };
      const providerModule: ModuleDefinition = {
        name: "provider-fake", version: "0.1.0", description: "f", api: 1,
        activate: (ctx) => { ctx.provide("provider:fake" as never, fp.stream); },
      };
      writeFileSync(join(dir, "x.txt"), "文件内容", "utf8");
      const mem = new InMemorySessionStore();
      const h = await createHarness({
        cwd: dir,
        store: mem,
        diagDir: dir,
        spillDir: join(dir, "spill"),
        builtinModules: [approval, compaction],
        modules: [providerModule, toolsModule],
        secretsFile: join(dir, "s.env"),
        discovery: { userDir: join(dir, "m"), projectDir: join(dir, "p"), trustFile: join(dir, "t.json") },
        config: { userFile: join(dir, "config.toml"), projectFile: join(dir, "n.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      });
      const render = (async () => { for await (const _ of h.events()) void _; })();
      await h.prompt(`你好`);                    // #0（est 2 ≤ 6 不压）
      await h.prompt("读一下 x.txt");             // 压缩（#1 摘要「工具结果摘要」）→ #2 工具调用（fs.read → ask-risky 放行）→ #3 step2 再压（#3 摘要「读到了」）→ #4 收尾
      await h.close();
      await render;
      const all = await mem.all();
      // 审批放行（只读不询问、无 approval/requested）且工具真执行了
      expect(all.some((e) => e.type === "tool/result" && e.callId === "c1" && e.output === "文件内容")).toBe(true);
      expect(all.some((e) => e.type === "approval/requested")).toBe(false);
      // 压缩落日志（v3 auto：首条 dropped = turn2 投影全部 3 条——用户消息既进摘要又留原话）；末请求（#4）末条是摘要
      expect(all.some((e) => e.type === "turn/compaction" && e.droppedCount === 3 && e.trigger === "auto")).toBe(true);
      const last = fp.requests[4]!;
      const lastMsg = last.messages[last.messages.length - 1] as { content: { text?: string }[] };
      expect(String(lastMsg.content[0]!.text)).toContain("[历史摘要]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
