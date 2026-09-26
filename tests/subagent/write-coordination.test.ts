import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProvider } from "@orosus/testing";
import { providerSlotKey, type Chunk, type StreamFn } from "@orosus/contracts/provider";
import { Access, defineTool } from "@orosus/contracts/tool";
import type { ModuleDefinition, SubagentOutcome, SubagentPort } from "@orosus/contracts/module";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

/** 写绑定 + 越界回执端到端（M4.5 T7 / 决策 24①⑤）：假写工具声明 fs.write 访问——
 *  报备了的子代理写报备外路径被拦（拦截尝试也进回执）；未报备跑 bash 的 = 整仓 + 命令串备查。 */

const call = (callId: string, name: string, args: string): Chunk[] => [
  { type: "toolcall/argumentsDelta", callId, name, argumentsDelta: args },
  { type: "finish", kind: "stop" },
];
const text = (t: string): Chunk[] => [{ type: "text/delta", text: t }, { type: "finish", kind: "stop" }];

interface Setup { h: Awaited<ReturnType<typeof createHarness>>; port: SubagentPort; writes: Map<string, string> }

const setup = async (script: Chunk[][]): Promise<Setup> => {
  dir = mkdtempSync(join(tmpdir(), "orosus-writecoord-"));
  const writes = new Map<string, string>();
  let port: SubagentPort | undefined;
  const provider = fakeProvider(script);
  const providerMod: ModuleDefinition = {
    name: "provider-fake", version: "0.1.0", description: "f", api: 1,
    activate(ctx) { ctx.provide(providerSlotKey("fake"), provider.stream as StreamFn); },
  };
  const consumer: ModuleDefinition = {
    name: "consumer", version: "0.1.0", description: "c", api: 1, mounts: ["subagent"],
    activate(ctx) { port = ctx.subagent; },
  };
  const saveTool: ModuleDefinition = {
    name: "w", version: "0.1.0", description: "写文件", api: 1, mounts: ["contribute:tool"],
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "w__save", description: "写文件", parameters: z.object({ path: z.string(), content: z.string() }),
        resolveExecution: (input) => {
          const { path, content } = input as { path: string; content: string };
          return Promise.resolve({
            accesses: [Access.fsWrite(path)], approvalRule: "w__save",
            execute: () => { writes.set(path, content); return Promise.resolve({ output: `写了 ${path}`, isError: false }); },
          });
        },
      }));
    },
  };
  const fakeBash: ModuleDefinition = {
    name: "tool-shell", version: "0.1.0", description: "假 bash（命令串备查用）", api: 1, mounts: ["contribute:tool"],
    activate(ctx) {
      ctx.contribute.tool(defineTool({
        name: "tool-shell__bash", description: "跑命令", parameters: z.object({ command: z.string() }),
        resolveExecution: (input) => {
          const { command } = input as { command: string };
          return Promise.resolve({
            accesses: [Access.subprocess()], approvalRule: "tool-shell__bash",
            execute: () => Promise.resolve({ output: `ran: ${command}`, isError: false }),
          });
        },
      }));
    },
  };
  const h = await createHarness({
    store: new InMemorySessionStore(),
    sessionsDir: join(dir, "sessions"),
    diagDir: dir,
    spillDir: join(dir, "spill"),
    cwd: dir,
    modules: [providerMod, consumer, saveTool, fakeBash],
    config: { userFile: join(dir, "no.toml"), projectFile: join(dir, "no2.toml"), env: {}, cliOverrides: { model: "fake/m" } },
  });
  return { h, port: port!, writes };
};

describe("写绑定与越界回执（决策 24①⑤——端到端）", () => {
  it("㉒ 报备 docs/ 的子代理：写 docs 内放行、写报备外被拦（拦的尝试也进回执）；未报备跑 bash 的 = 整仓 + 命令串备查", async () => {
    // 子代理三轮：写 docs/ok.txt（放行）→ 写 outside.txt（被拦）→ 收尾
    const s1 = await setup([
      call("c1", "w__save", JSON.stringify({ path: "docs/ok.txt", content: "A" })),
      call("c2", "w__save", JSON.stringify({ path: "outside.txt", content: "B" })),
      text("干完了"),
    ]);
    const out = (await s1.port.spawn({ label: "报备写手", prompt: "写两个文件", writePaths: ["docs/"] })) as SubagentOutcome;
    expect(out.status).toBe("completed");
    expect(s1.writes.has("docs/ok.txt")).toBe(true);   // 报备内放行
    expect(s1.writes.has("outside.txt")).toBe(false);  // 报备外被拦
    expect(out.outOfBounds).toBeDefined();
    expect(out.outOfBounds!.some((p) => p.includes("outside.txt"))).toBe(true); // 被拦尝试进回执（抓「想写别处」的意图）
    expect(out.outOfBounds!.some((p) => p.includes("ok.txt"))).toBe(false);    // 报备内不算越界
    await s1.h.close();

    // 未报备 + 工具面含 bash = 整仓（无他人报备时立即持闸）；bash 命令串原样备查
    const s2 = await setup([
      call("b1", "tool-shell__bash", JSON.stringify({ command: "npm run build" })),
      text("好了"),
    ]);
    const out2 = (await s2.port.spawn({ label: "bash 手", prompt: "跑构建" })) as SubagentOutcome;
    expect(out2.status).toBe("completed");
    expect(out2.bashCommands).toEqual(["npm run build"]); // 备查（bash 实际写不可从命令串还原）
    await s2.h.close();
  });
});
