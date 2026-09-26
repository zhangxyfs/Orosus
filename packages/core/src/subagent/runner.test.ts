import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Chunk } from "@orosus/contracts/provider";
import { defineTool } from "@orosus/contracts/tool";
import type { ModuleDefinition, SubagentOutcome, SubagentPort } from "@orosus/contracts/module";
import { fakeModule, fakeProviderModule } from "@orosus/testing";
import { InMemorySessionStore } from "../session/memory.ts";
import { createHarness } from "../index.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const hermetic = (d: string) => ({ userFile: join(d, "no-user.toml"), projectFile: join(d, "no-proj.toml"), env: {} });

const textChunk = (text: string): Chunk[] => [{ type: "text/delta", text }, { type: "finish", kind: "stop" }];

let port: SubagentPort | undefined;
/** 消费者模块：声明 mounts ["subagent"]，把内核缝捕获进测试作用域。 */
const consumer = (): ModuleDefinition => fakeModule("consumer", {
  mounts: ["subagent"],
  activate(ctx) { port = ctx.subagent; },
});

interface SetupOpts {
  script?: Chunk[][];
  extraModules?: ModuleDefinition[];
  configToml?: string;
}
const setup = async (opts: SetupOpts = {}) => {
  dir = mkdtempSync(join(tmpdir(), "orosus-subagent-"));
  const userFile = join(dir, "user.toml");
  if (opts.configToml !== undefined) writeFileSync(userFile, opts.configToml, "utf8");
  const h = await createHarness({
    store: new InMemorySessionStore(),
    sessionsDir: join(dir, "sessions"),
    diagDir: dir,
    spillDir: join(dir, "spill"),
    modules: [fakeProviderModule("fake", opts.script ?? [textChunk("子代理结论")]), fakeProviderModule("fake2", [textChunk("二号模型结论")]), consumer(), ...(opts.extraModules ?? [])],
    config: { ...hermetic(dir), userFile, cliOverrides: { model: "fake/m" } },
  });
  return h;
};

/** 读子代理会话文件（决策 19 落盘形状：<桶>/<主sid>/agents/agents_<编号>/agents/session.jsonl）。 */
const agentFile = (h: { sessionId: string }, id: string): string =>
  readFileSync(join(dir, "sessions", h.sessionId, "agents", `agents_${id}`, "agents", "session.jsonl"), "utf8");
const eventsOf = (raw: string): Record<string, unknown>[] =>
  raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("子代理内核缝 T1（开子会话 + 跑循环 + 取结论 + 8 位编号）", () => {
  it("① 文件头亲缘 + 编号同源：会话文件嵌主会话目录，header.parentSession = 主会话，首条 user/message = 任务书，编号 = 8 位 hex 与文件夹名同一串", async () => {
    const h = await setup();
    const out = (await port!.spawn({ label: "测试", prompt: "去把这件事办了" })) as SubagentOutcome;
    expect(out.status).toBe("completed");
    expect(out.id).toMatch(/^[0-9a-f]{8}$/);
    const events = eventsOf(agentFile(h, out.id));
    expect(events[0]!.type).toBe("session/header");
    expect(events[0]!.parentSession).toBe(h.sessionId);
    const userMsg = events.find((e) => e.type === "user/message");
    expect(((userMsg!.content as { kind: string; text: string }[])[0]!).text).toBe("去把这件事办了");
    expect(events.some((e) => e.type === "turn/end")).toBe(true);
    await h.close();
  });

  it("② 取文本：多轮工具往返后，结论 = 最后一条 assistant 回复文本", async () => {
    let toolRan = false;
    const echo = fakeModule("echo", {
      mounts: ["contribute:tool"],
      activate(ctx) {
        ctx.contribute.tool(defineTool({
          name: "echo__hi",
          description: "回声",
          parameters: z.object({}),
          resolveExecution: () => Promise.resolve({
            accesses: [],
            approvalRule: "echo__hi",
            execute: () => { toolRan = true; return Promise.resolve({ output: "hi", isError: false }); },
          }),
        }));
      },
    });
    const h = await setup({
      script: [
        [{ type: "toolcall/argumentsDelta", callId: "c1", name: "echo__hi", argumentsDelta: "{}" }, { type: "finish", kind: "stop" }],
        [{ type: "toolcall/argumentsDelta", callId: "c2", name: "echo__hi", argumentsDelta: "{}" }, { type: "finish", kind: "stop" }],
        textChunk("最终结论在这里"),
      ],
      extraModules: [echo],
    });
    const out = (await port!.spawn({ label: "多轮", prompt: "干活" })) as SubagentOutcome;
    expect(toolRan).toBe(true); // 主对话注册的工具被抄进子代理工具面
    expect(out.status).toBe("completed");
    expect(out.conclusion).toBe("最终结论在这里");
    expect(out.turns).toBe(3);
    await h.close();
  });

  it("③ 取消：前台跟调用方取消信号走——signal 打断后按失败收场，会话文件落 interrupted", async () => {
    let toolStarted!: () => void;
    const started = new Promise<void>((r) => { toolStarted = r; });
    const gate = fakeModule("gate", {
      mounts: ["contribute:tool"],
      activate(ctx) {
        ctx.contribute.tool(defineTool({
          name: "gate__wait",
          description: "挂起等信号",
          parameters: z.object({}),
          resolveExecution: () => Promise.resolve({
            accesses: [],
            approvalRule: "gate__wait",
            execute: (tc) => new Promise((res) => {
              toolStarted();
              if (tc.signal.aborted) { res({ output: "[已中止]", isError: true }); return; }
              tc.signal.addEventListener("abort", () => res({ output: "[已中止]", isError: true }), { once: true });
            }),
          }),
        }));
      },
    });
    const h = await setup({
      script: [[{ type: "toolcall/argumentsDelta", callId: "c1", name: "gate__wait", argumentsDelta: "{}" }, { type: "finish", kind: "stop" }]],
      extraModules: [gate],
    });
    const ctl = new AbortController();
    const p = port!.spawn({ label: "取消", prompt: "等着" }, { signal: ctl.signal }) as Promise<SubagentOutcome>;
    await started;
    ctl.abort();
    const out = await p;
    expect(out.status).toBe("failed");
    expect(out.error).toContain("取消");
    const end = eventsOf(agentFile(h, out.id)).find((e) => e.type === "turn/end");
    expect(end!.kind).toBe("interrupted");
    await h.close();
  });

  it("④ 模型三来源优先级：settings 配置 > 工种声明 > 跟父——turn/start 的 model 字段逐路验证", async () => {
    const h = await setup({ configToml: "[tool-subagent]\nmodel = \"fake2/m2\"\n" });
    const modelOf = async (req: Parameters<SubagentPort["spawn"]>[0]): Promise<unknown> => {
      const out = (await port!.spawn(req)) as SubagentOutcome;
      const ts = eventsOf(agentFile(h, out.id)).find((e) => e.type === "turn/start");
      return ts!.model;
    };
    expect(await modelOf({ label: "跟父", prompt: "a" })).toBe("m2"); // settings 在场即压过一切
    expect(await modelOf({ label: "工种声明被压", prompt: "b", model: "fake/m" })).toBe("m2");
    await h.close();

    const h2 = await setup(); // 无 [tool-subagent] 配置
    const modelOf2 = async (req: Parameters<SubagentPort["spawn"]>[0]): Promise<unknown> => {
      const out = (await port!.spawn(req)) as SubagentOutcome;
      const ts = eventsOf(agentFile(h2, out.id)).find((e) => e.type === "turn/start");
      return ts!.model;
    };
    expect(await modelOf2({ label: "跟父", prompt: "a" })).toBe("m"); // 父 = cliOverrides fake/m
    expect(await modelOf2({ label: "工种声明", prompt: "b", model: "fake2/m2" })).toBe("m2");
    await h2.close();
  });
});
