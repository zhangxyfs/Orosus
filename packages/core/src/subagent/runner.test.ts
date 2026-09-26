import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Chunk, ProviderRequest, StreamFn } from "@orosus/contracts/provider";
import { providerSlotKey } from "@orosus/contracts/provider";
import { defineTool } from "@orosus/contracts/tool";
import type { ModuleDefinition, SubagentOutcome, SubagentPort } from "@orosus/contracts/module";
import { fakeModule, fakeProvider, fakeProviderModule } from "@orosus/testing";
import { InMemorySessionStore } from "../session/memory.ts";
import { createHarness } from "../index.ts";
import { isSpawnClassTool, spawnAllowedAtDepth } from "./runner.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const hermetic = (d: string) => ({ userFile: join(d, "no-user.toml"), projectFile: join(d, "no-proj.toml"), env: {} });

const textChunk = (text: string): Chunk[] => [{ type: "text/delta", text }, { type: "finish", kind: "stop" }];
const toolCallChunk = (callId: string, name: string): Chunk[] => [
  { type: "toolcall/argumentsDelta", callId, name, argumentsDelta: "{}" },
  { type: "finish", kind: "stop" },
];

let port: SubagentPort | undefined;
/** 消费者模块：声明 mounts ["subagent"]，把内核缝捕获进测试作用域。 */
const consumer = (): ModuleDefinition => fakeModule("consumer", {
  mounts: ["subagent"],
  activate(ctx) { port = ctx.subagent; },
});

/** 捕获型 provider 模块（占 "fake" 槽）：requests 收集全部请求——子代理的工具面从这里断言。 */
let lastRequests: ProviderRequest[] = [];
const providerModuleOf = (name: string, stream: StreamFn): ModuleDefinition =>
  fakeModule(`provider-${name}`, { activate(ctx) { ctx.provide(providerSlotKey(name), stream); } });

interface SetupOpts {
  script?: Chunk[][];
  extraModules?: ModuleDefinition[];
  configToml?: string;
}
const setup = async (opts: SetupOpts = {}) => {
  dir = mkdtempSync(join(tmpdir(), "orosus-subagent-"));
  const userFile = join(dir, "user.toml");
  if (opts.configToml !== undefined) writeFileSync(userFile, opts.configToml, "utf8");
  const provider = fakeProvider(opts.script ?? [textChunk("子代理结论")]);
  lastRequests = provider.requests;
  const h = await createHarness({
    store: new InMemorySessionStore(),
    sessionsDir: join(dir, "sessions"),
    diagDir: dir,
    spillDir: join(dir, "spill"),
    modules: [providerModuleOf("fake", provider.stream), fakeProviderModule("fake2", [textChunk("二号模型结论")]), consumer(), ...(opts.extraModules ?? [])],
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

describe("子代理 T2（工具过滤：按工种减 + 到顶剥 + 双层门控）", () => {
  const mkTool = (name: string, onRun?: () => void, result = "ok") =>
    defineTool({
      name, description: name, parameters: z.object({}),
      resolveExecution: () => Promise.resolve({
        accesses: [], approvalRule: name,
        execute: () => { onRun?.(); return Promise.resolve({ output: result, isError: false }); },
      }),
    });

  it("⑤ 工种过滤：allowedTools 只留白名单（未知名静默无效——只能减不能加）；disallowedTools 再减", async () => {
    const h = await setup({
      extraModules: [
        fakeModule("echo", { mounts: ["contribute:tool"], activate(ctx) { ctx.contribute.tool(mkTool("echo__hi")); } }),
        fakeModule("gate", { mounts: ["contribute:tool"], activate(ctx) { ctx.contribute.tool(mkTool("gate__wait")); } }),
      ],
    });
    await port!.spawn({ label: "白名单", prompt: "go", allowedTools: ["echo__hi", "nope__x"] });
    expect(lastRequests[0]!.tools.map((t) => t.name)).toEqual(["echo__hi"]); // nope__x 静默无效
    await port!.spawn({ label: "黑名单", prompt: "go2", disallowedTools: ["echo__hi"] });
    expect(lastRequests.at(-1)!.tools.map((t) => t.name)).toEqual(["gate__wait"]);
    await h.close();
  });

  it("⑥ 到顶剥（双层门控同一函数）：子代理面含派活类工具，孙代理面剥净；亲缘 header 挂父代理编号；谓词两态", async () => {
    expect(spawnAllowedAtDepth(1)).toBe(true);
    expect(spawnAllowedAtDepth(2)).toBe(false);
    expect(isSpawnClassTool("tool-subagent__spawn")).toBe(true);
    expect(isSpawnClassTool("tool-fs__read")).toBe(false);

    let grandId: string | undefined;
    let grandConclusion = "";
    const fakeSpawnModule = fakeModule("tool-subagent", { // 假派活类工具（T6 前占位）——注册面到顶剥的对象
      mounts: ["contribute:tool"],
      activate(ctx) { ctx.contribute.tool(mkTool("tool-subagent__spawn", undefined, "spawned")); },
    });
    const spawner = fakeModule("spawner", { // 从子代理循环内派孙代理（深度自证走 ALS）
      mounts: ["contribute:tool", "subagent"],
      activate(ctx) {
        const p = ctx.subagent!;
        ctx.contribute.tool(defineTool({
          name: "spawner__go", description: "派孙", parameters: z.object({}),
          resolveExecution: () => Promise.resolve({
            accesses: [], approvalRule: "spawner__go",
            execute: () => {
              const r = p.spawn({ label: "孙代理", prompt: "孙代任务" }) as Promise<SubagentOutcome>;
              return r.then((out) => { grandId = out.id; grandConclusion = out.conclusion; return { output: `孙代理 ${out.id}：${out.conclusion}`, isError: false }; });
            },
          }),
        }));
      },
    });
    const h = await setup({
      script: [toolCallChunk("c1", "spawner__go"), textChunk("父代结论")],
      extraModules: [fakeSpawnModule, spawner],
    });
    const out = (await port!.spawn({ label: "父代", prompt: "go" })) as SubagentOutcome;
    expect(out.status).toBe("completed");
    expect(out.conclusion).toBe("父代结论");
    expect(grandId).toMatch(/^[0-9a-f]{8}$/);
    expect(grandConclusion).toBe("父代结论"); // 孙代理跑完取末条文本（脚本耗尽重复末条）
    // 子代理（depth 1）工具面：含派活类 + spawner；孙代理（depth 2）面：派活类剥净
    const parentFace = lastRequests[0]!.tools.map((t) => t.name);
    expect(parentFace).toContain("tool-subagent__spawn");
    expect(parentFace).toContain("spawner__go");
    const grandFace = lastRequests.filter((r) => !r.tools.some((t) => t.name === "tool-subagent__spawn")).map((r) => r.tools.map((t) => t.name)).at(-1);
    expect(grandFace).toBeDefined();
    expect(grandFace).not.toContain("tool-subagent__spawn");
    expect(grandFace).toContain("spawner__go"); // 只剥派活类——孙代理干活能力完整（决策 4）
    // 亲缘：孙代理会话文件 header.parentSession = 父代理编号（决策 19 同册同理）
    const grandHeader = eventsOf(agentFile(h, grandId!))[0]!;
    expect(grandHeader.parentSession).toBe(`agents_${out.id}`);
    await h.close();
  });
});

describe("子代理 T5（带聊天记录开局 forkFrom——决策 6）", () => {
  it("⑩ forkFrom：子代理首个请求含主对话历史（前半段）+ 任务书末位；own 文件带 session/fork 记分叉点", async () => {
    // 剧本：script[0] = 主对话一轮（"你好" → "主对话回复"）；script[1] = 子代理一轮
    const h = await setup({
      script: [textChunk("主对话回复"), textChunk("子代理结论")],
    });
    await h.prompt("你好");
    const history = await h.history();
    const at = history[history.length - 1]!.id;
    const out = (await port!.spawn({ label: "带历史", prompt: "照上面聊的做 X", forkFromEntryId: at })) as SubagentOutcome;
    expect(out.status).toBe("completed");
    expect(out.conclusion).toBe("子代理结论");
    // 子代理首个请求（requests[0] = 主对话那轮）：messages = 主对话历史 + 任务书末位
    const agentReq = lastRequests[1]!;
    const roles = agentReq.messages.map((m) => `${m.role}:${("content" in m ? (m.content as { kind?: string; text?: string }[]) : []).map((p) => p.text ?? "").join("")}`);
    expect(roles[0]).toContain("你好");
    expect(roles[1]).toContain("主对话回复");
    expect(roles.at(-1)).toContain("照上面聊的做 X");
    // own 文件：header → session/fork（sourceEntryId = 分叉点）→ user/message 任务书
    const events = eventsOf(agentFile(h, out.id));
    expect(events[0]!.type).toBe("session/header");
    expect(events[1]!.type).toBe("session/fork");
    expect(events[1]!.sourceEntryId).toBe(at);
    await h.close();
  });

  it("⑪ forkFrom 分叉点不在主会话投影内 → spawn 抛错（活 API 严校验，不走盘上链重建的宽松降级）", async () => {
    const h = await setup();
    await expect(port!.spawn({ label: "坏分叉", prompt: "x", forkFromEntryId: "e_不存在" })).rejects.toThrow("投影");
    await h.close();
  });

  it("⑫ 空白开局对照（决策 6 默认）：不带 forkFrom 的子代理只见任务书，主对话历史不泄漏", async () => {
    const h = await setup({ script: [textChunk("主对话回复"), textChunk("子代理结论")] });
    await h.prompt("你好");
    await port!.spawn({ label: "空白", prompt: "独立任务" });
    const agentReq = lastRequests[1]!;
    expect(agentReq.messages.length).toBe(1);
    expect(JSON.stringify(agentReq.messages)).not.toContain("你好");
    expect(JSON.stringify(agentReq.messages)).not.toContain("主对话回复");
    await h.close();
  });
});
