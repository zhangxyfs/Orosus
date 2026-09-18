import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import type { CommandUi, ModuleDefinition } from "@orosus/contracts/module";
import { Access, defineTool, type Tool } from "@orosus/contracts/tool";
import type { Chunk } from "@orosus/contracts/provider";
import approval from "@orosus/approval";

/** 审批 × 调度端到端（M3 T9）：并行组内否决不影响其余成员；denied 进日志；会话记忆跨 turn。 */
describe("approval × 调度端到端", () => {
  it("并行组内一员被规则否决、其余照常执行；denied 落日志；『本会话始终允许』跨 turn 生效", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-approval-e2e-"));
    try {
      writeFileSync(
        join(dir, "config.toml"),
        ['[approval]', 'mode = "ask-risky"', '[[approval.rules]]', 'effect = "deny"', 'tool = "m__b"', ""].join("\n"),
        "utf8",
      );
      const uiCalls: string[] = [];
      const ui: CommandUi = {
        ask: async () => { throw new Error("不应 ask"); },
        askSecret: async () => { throw new Error("不应 askSecret"); },
        confirm: async () => { throw new Error("不应 confirm"); },
        choose: async (_t, items) => { uiCalls.push(items.join("|")); return "本会话始终允许"; },
      };
      const mkTool = (name: string, accesses: Access[]): Tool =>
        defineTool({
          name, description: name, parameters: z.object({}),
          resolveExecution: async () => ({
            accesses, approvalRule: name,
            execute: async () => ({ output: `${name}-done`, isError: false }),
          }),
        });
      const toolsModule: ModuleDefinition = {
        name: "m", version: "0.1.0", description: "三工具（a/b/c）", api: 1,
        activate(ctx) {
          ctx.contribute.tool(mkTool("m__a", [Access.fsRead("/a")]));
          ctx.contribute.tool(mkTool("m__b", [Access.fsRead("/b")]));
          ctx.contribute.tool(mkTool("m__c", [Access.subprocess()]));
        },
      };
      const provider: ModuleDefinition = {
        name: "provider-fake", version: "0.1.0", description: "f", api: 1,
        activate(ctx) {
          const { stream } = fakeProvider([
            [
              { type: "toolcall/argumentsDelta", callId: "c1", name: "m__a", argumentsDelta: "{}" } as Chunk,
              { type: "toolcall/argumentsDelta", callId: "c2", name: "m__b", argumentsDelta: "{}" } as Chunk,
              { type: "finish", kind: "toolUse" } as Chunk,
            ],
            [{ type: "text/delta", text: "第一轮完成" }, { type: "finish", kind: "stop" }] as Chunk[],
            [
              { type: "toolcall/argumentsDelta", callId: "c3", name: "m__c", argumentsDelta: "{}" } as Chunk,
              { type: "finish", kind: "toolUse" } as Chunk,
            ],
            [{ type: "text/delta", text: "第二轮" }, { type: "finish", kind: "stop" }] as Chunk[],
            [
              { type: "toolcall/argumentsDelta", callId: "c4", name: "m__c", argumentsDelta: "{}" } as Chunk,
              { type: "finish", kind: "toolUse" } as Chunk,
            ],
            [{ type: "text/delta", text: "第三轮" }, { type: "finish", kind: "stop" }] as Chunk[],
          ]);
          ctx.provide("provider:fake" as never, stream);
        },
      };
      const mem = new InMemorySessionStore();
      const h = await createHarness({
        cwd: dir,
        store: mem,
        diagDir: dir,
        spillDir: join(dir, "spill"),
        commandUi: ui,
        builtinModules: [approval],
        modules: [provider, toolsModule],
        secretsFile: join(dir, "s.env"),
        discovery: { userDir: join(dir, "m"), projectDir: join(dir, "p"), trustFile: join(dir, "t.json") },
        config: { userFile: join(dir, "config.toml"), projectFile: join(dir, "n.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      });
      const render = (async () => { for await (const _ of h.events()) void _; })();
      await h.prompt("第一轮：读两个文件"); // a、b 同组并行；b 被规则否决
      await h.prompt("第二轮：跑命令");      // c=subprocess → 询问 → 本会话始终允许
      await h.prompt("第三轮：再跑命令");    // 记忆命中 → 零询问
      await h.close();
      await render;
      const all = await mem.all();
      // 并行组内：a 照常执行（规则只否决 b），denied 落 tool/result
      expect(all.some((e) => e.type === "tool/result" && e.callId === "c1" && e.output === "m__a-done" && e.isError !== true)).toBe(true);
      expect(all.some((e) => e.type === "tool/result" && e.callId === "c2" && e.denied === true && e.isError === true)).toBe(true);
      // 审批事件：仅询问路径落（c 的 requested/resolved；b 的规则否决落 resolved）
      expect(all.some((e) => e.type === "approval/requested")).toBe(true);
      expect(all.some((e) => e.type === "approval/resolved" && e.decision === "allow-session")).toBe(true);
      // 会话记忆跨 turn：c 第二次执行零询问
      expect(uiCalls).toEqual(["批准一次|本会话始终允许|拒绝"]);
      expect(all.filter((e) => e.type === "tool/result" && String(e.output) === "m__c-done")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
