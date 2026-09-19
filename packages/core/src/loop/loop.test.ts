import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { Chunk } from "@orosus/contracts/provider";
import { defineTool, Access } from "@orosus/contracts/tool";
import { fakeProvider } from "@orosus/testing";
import { InMemorySessionStore } from "../session/memory.ts";
import { createEventBus, CORE_POINTS } from "../kernel/bus.ts";
import { createToolRegistry } from "../tool/registry.ts";
import { agentLoop } from "./loop.ts";
import { deriveMessages } from "./convert.ts";
import type { DiagSink, DiagRecord } from "../diag/logger.ts";

const sink = (): DiagSink & { records: DiagRecord[] } => {
  const records: DiagRecord[] = [];
  return { records, write: (r) => void records.push(r), flush: () => Promise.resolve(), close: () => Promise.resolve() };
};

const setup = (script: Chunk[][]) => {
  const s = sink();
  const bus = createEventBus(s);
  const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/orosus-loop-spill" });
  const session = new InMemorySessionStore();
  const provider = fakeProvider(script);
  const run = (signal = new AbortController().signal) =>
    (async () => {
      const types: string[] = [];
      for await (const e of agentLoop({ session, bus, tools, provider: provider.stream, model: "fake/m", system: "sys", signal, sink: s })) {
        types.push(e.type);
      }
      return types;
    })();
  return { s, bus, tools, session, provider, run };
};

describe("agentLoop（§6.2 零策略骨架）", () => {
  it("纯文本对话（T5/D45 断流）：无 assistant/chunk——完成事件一条物化 content 块（reasoning 前 text 后）+ usage", async () => {
    const { run, bus, session } = setup([[
      { type: "reasoning/delta", text: "思" },
      { type: "text/delta", text: "你" },
      { type: "text/delta", text: "好" },
      { type: "usage", input: 3, output: 2 },
      { type: "finish", kind: "stop" },
    ]]);
    const preSteps: unknown[] = [];
    bus.on(CORE_POINTS.preStep, (p) => { preSteps.push(p); }, "observer");
    const types = await run();
    expect(types).toEqual([
      "turn/start", "turn/step", "request/header",
      "assistant/message", "turn/end",
    ]);
    expect(preSteps).toEqual([{ turn: (await session.all())[0]!.id }]); // step 开始广播被驱动（§6.5）
    const all = await session.all();
    const msg = all.find((e) => e.type === "assistant/message")!;
    expect(msg.content).toEqual([{ kind: "reasoning", text: "思" }, { kind: "text", text: "你好" }]); // reasoning 首次持久化（D45）
    expect(msg.usage).toEqual({ input: 3, output: 2 }); // usage 落 message（不再只在 chunk 碎片里）
    expect(deriveMessages(all).at(-1)).toEqual({ role: "assistant", content: [{ kind: "text", text: "你好" }] }); // reasoning 不回流模型（v1 定案）
  });

  it("livePush 收到全量 chunk（断流后旁路是唯一实时面）", async () => {
    const { s, bus, tools, session, provider } = setup([[
      { type: "text/delta", text: "a" },
      { type: "finish", kind: "stop" },
    ]]);
    const pushed: string[] = [];
    for await (const _ of agentLoop({ session, bus, tools, provider: provider.stream, model: "fake/m", system: "sys", signal: new AbortController().signal, sink: s, livePush: (c) => pushed.push(c.type) })) {
      // 驱动迭代
    }
    expect(pushed).toEqual(["text/delta", "finish"]);
  });

  it("工具调用回合：tool/call → tool/result 落日志，下一请求消息含 toolResult 投影", async () => {
    const { run, tools, provider, session } = setup([
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "m__t", argumentsDelta: "{}" },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "读完了" }, { type: "finish", kind: "stop" }],
    ]);
    tools.register(defineTool({
      name: "m__t", description: "t", parameters: z.object({}),
      resolveExecution: async () => ({ execute: async () => ({ output: "文件内容", isError: false }) }),
    }), "m");
    await run();
    const second = provider.requests[1]!;
    expect(second.messages.some((m) => m.role === "toolResult" && m.output === "文件内容")).toBe(true);
    const all = await session.all();
    expect(all.some((e) => e.type === "tool/call" && e.name === "m__t")).toBe(true);
    expect(all.some((e) => e.type === "tool/result" && e.output === "文件内容")).toBe(true);
  });

  it("多工具回合：全部 tool/call 先批量落条再执行，投影不丢 call（§6.2 伪码/§6.1 铁律）", async () => {
    const { run, tools, provider } = setup([
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "m__t", argumentsDelta: "{}" },
        { type: "toolcall/argumentsDelta", callId: "c2", name: "m__t", argumentsDelta: "{}" },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "done" }, { type: "finish", kind: "stop" }],
    ]);
    tools.register(defineTool({
      name: "m__t", description: "t", parameters: z.object({}),
      resolveExecution: async () => ({ execute: async () => ({ output: "r", isError: false }) }),
    }), "m");
    await run();
    const assistant = provider.requests[1]!.messages.find((m) => m.role === "assistant");
    expect(assistant?.toolCalls?.map((t) => t.callId)).toEqual(["c1", "c2"]); // 两个 call 都附挂上——边执行边落条的旧顺序会丢 c2
    expect(provider.requests[1]!.messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
  });

  it("provider 带内错误 → turn/end{kind:error}，不重抛（§6.4/§10）", async () => {
    const { run, session } = setup([[{ type: "finish", kind: "error", errorMessage: " quota" }]]);
    await run();
    const all = await session.all();
    expect(all.some((e) => e.type === "turn/end" && e.kind === "error")).toBe(true);
  });

  it("steering 先落 agent/steering-message 再进请求（铁律推论，§6.2）", async () => {
    const { run, bus, session, provider } = setup([[{ type: "finish", kind: "stop" }]]);
    bus.on(CORE_POINTS.steering, () => [{ text: "记得喝水", sourceModule: "reminder" }], "reminder");
    await run();
    const all = await session.all();
    const steeringIdx = all.findIndex((e) => e.type === "agent/steering-message");
    const requestIdx = all.findIndex((e) => e.type === "request/header");
    expect(steeringIdx).toBeGreaterThanOrEqual(0);
    expect(steeringIdx).toBeLessThan(requestIdx);
    expect(provider.requests[0]!.messages.some((m) => m.role === "user" && (m.content[0] as { text?: string }).text === "记得喝水")).toBe(true); // M4-2.5 T5 过账：ContentPart 联合扩 image——text 经窄化断言
  });

  it("预中止的 signal → turn/end{kind:interrupted}，不发请求", async () => {
    const { run, provider } = setup([[{ type: "finish", kind: "stop" }]]);
    const c = new AbortController();
    c.abort();
    await run(c.signal);
    expect(provider.requests).toHaveLength(0);
  });
});

describe("agentLoop 工具并发调度（M3，§6.3/D40）", () => {
  const DELAY = 90;
  const delayedTool = (name: string, accesses: Access[]) =>
    defineTool({
      name, description: name, parameters: z.object({}),
      resolveExecution: async () => ({
        accesses,
        approvalRule: name,
        execute: async () => {
          await new Promise((r) => setTimeout(r, DELAY));
          return { output: `${name}-ok`, isError: false };
        },
      }),
    });

  it("无冲突工具并行：总耗时 ≈ max 而非 sum（§6.3 分组并发）", async () => {
    const { run, tools, session } = setup([
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "m__a", argumentsDelta: "{}" } as Chunk,
        { type: "toolcall/argumentsDelta", callId: "c2", name: "m__b", argumentsDelta: "{}" } as Chunk,
        { type: "finish", kind: "toolUse" } as Chunk,
      ],
      [{ type: "text/delta", text: "done" }, { type: "finish", kind: "stop" }] as Chunk[],
    ]);
    tools.register(delayedTool("m__a", [Access.fsRead("/a")]), "m");
    tools.register(delayedTool("m__b", [Access.fsRead("/b")]), "m");
    const t0 = Date.now();
    await run();
    expect(Date.now() - t0).toBeLessThan(DELAY * 2 - 30); // 串行 ≥ 180ms；并行 ≈ 90ms + 流水开销
    const all = await session.all();
    expect(all.filter((e) => e.type === "tool/result" && e.output === "m__a-ok")).toHaveLength(1);
    expect(all.filter((e) => e.type === "tool/result" && e.output === "m__b-ok")).toHaveLength(1);
  });

  it("冲突工具串行（耗时 ≈ sum）；同组否决不影响其他成员（denied 与 ok 并存）", async () => {
    const { run, tools, session, bus } = setup([
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "m__a", argumentsDelta: "{}" } as Chunk,
        { type: "toolcall/argumentsDelta", callId: "c2", name: "m__b", argumentsDelta: "{}" } as Chunk,
        { type: "toolcall/argumentsDelta", callId: "c3", name: "m__c", argumentsDelta: "{}" } as Chunk,
        { type: "finish", kind: "toolUse" } as Chunk,
      ],
      [{ type: "text/delta", text: "done" }, { type: "finish", kind: "stop" }] as Chunk[],
    ]);
    tools.register(delayedTool("m__a", [Access.fsWrite("/same")]), "m");
    tools.register(delayedTool("m__b", [Access.fsWrite("/same")]), "m"); // 与 a 冲突 → 分组串行
    tools.register(delayedTool("m__c", [Access.fsRead("/c")]), "m");     // 与 a/b 不冲突 → 同组并行
    bus.on(CORE_POINTS.toolPreExecute, (p) => {
      const payload = p as { name?: string };
      if (payload.name === "m__c") return { deny: true, reason: "审批否决（并行组内）" };
      return undefined;
    }, "approval");
    const t0 = Date.now();
    await run();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(DELAY * 2 - 30); // a、b 串行
    const all = await session.all();
    const results = all.filter((e) => e.type === "tool/result");
    expect(results.some((e) => e.output === "m__a-ok" && e.isError !== true)).toBe(true);
    expect(results.some((e) => e.output === "m__b-ok" && e.isError !== true)).toBe(true);
    expect(results.some((e) => e.denied === true && e.isError === true)).toBe(true); // c 被否决，同组 a/b 照常
  });

  it("abort：在飞工具响应 signal 返回带内中止；未启动组的 call 补 [已中止] 结果（§6.1）", async () => {
    const { run, tools, session } = setup([
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "m__a", argumentsDelta: "{}" } as Chunk,
        { type: "toolcall/argumentsDelta", callId: "c2", name: "m__b", argumentsDelta: "{}" } as Chunk,
        { type: "finish", kind: "toolUse" } as Chunk,
      ],
      [{ type: "text/delta", text: "done" }, { type: "finish", kind: "stop" }] as Chunk[],
    ]);
    // a、b 同路径写 → 冲突分组：a 先行，b 排队未启动；a 响应 signal（工具契约）带内中止
    tools.register(defineTool({
      name: "m__a", description: "a", parameters: z.object({}),
      resolveExecution: async () => ({
        accesses: [Access.fsWrite("/same")],
        execute: async (tctx) => {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, DELAY);
            tctx.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
          });
          return tctx.signal.aborted
            ? { output: "a-已中止", isError: true }
            : { output: "a-ok", isError: false };
        },
      }),
    }), "m");
    tools.register(delayedTool("m__b", [Access.fsWrite("/same")]), "m");
    const c = new AbortController();
    const running = run(c.signal);
    setTimeout(() => c.abort(), 40); // a 在飞时中止
    await running;
    const all = await session.all();
    expect(all.some((e) => e.type === "tool/result" && e.callId === "c1" && e.output === "a-已中止")).toBe(true);
    expect(all.some((e) => e.type === "tool/result" && e.callId === "c2" && e.isError === true && String(e.output).includes("已中止"))).toBe(true); // b 从未启动 → loop 补条
    expect(all.some((e) => e.type === "turn/end" && e.kind === "interrupted")).toBe(true);
  });
});

describe("溢出恢复（M3 补强 T4/D43：agent/request-error 广播 + 数据驱动重试一次）", () => {
  it("① 首请求 context_limit → 广播 request-error → 重发成功：turn completed、重发消息与首请求一致（无 compaction 在场——优雅降级）", async () => {
    const { run, bus, provider, session } = setup([
      [{ type: "finish", kind: "error", errorMessage: "HTTP 400：This model's maximum context length is 65536 tokens", errorCode: "context_limit" }],
      [{ type: "text/delta", text: "好了" }, { type: "finish", kind: "stop" }],
    ]);
    await session.append("user/message", { content: [{ kind: "text", text: "hi" }] });
    const errs: unknown[] = [];
    bus.on(CORE_POINTS.requestError, (p) => { errs.push(p); }, "observer");
    const types = await run();
    expect(errs).toHaveLength(1);
    expect((errs[0] as { code: string }).code).toBe("context_limit");
    expect(provider.requests).toHaveLength(2); // 恰重发一次
    expect(provider.requests[1]!.messages).toEqual(provider.requests[0]!.messages); // 原样重发（无监听者改写）
    expect(types.filter((t) => t === "request/header")).toHaveLength(1); // lastRequestSig 不变 → 不落重复 header（重试步注记）
    const all = await session.all();
    expect(all.at(-1)).toMatchObject({ type: "turn/end", kind: "completed" });
  });

  it("② 两次都 context_limit → 每 turn 只重试一次：provider 恰调 2 次、turn error 且 errorMessage 含指引", async () => {
    const { run, provider, session } = setup([
      [{ type: "finish", kind: "error", errorMessage: "HTTP 400：context_length_exceeded", errorCode: "context_limit" }],
    ]); // fakeProvider 重复末位脚本 → 恒失败
    await run();
    expect(provider.requests).toHaveLength(2);
    const end = (await session.all()).at(-1) as { type: string; kind?: string; errorMessage?: string };
    expect(end).toMatchObject({ type: "turn/end", kind: "error" });
    expect(end.errorMessage).toContain("已自动压缩重试仍超限");
    expect(end.errorMessage).toContain("/compact");
  });

  it("③ 部分产出防护：先流出 text 再 context_limit → 不重试（provider 只调 1 次），直接 error 终局（防重复 assistant 投影）", async () => {
    const { run, provider, session } = setup([
      [{ type: "text/delta", text: "半截" }, { type: "finish", kind: "error", errorMessage: "HTTP 400：prompt is too long", errorCode: "context_limit" }],
    ]);
    await run();
    expect(provider.requests).toHaveLength(1);
    const all = await session.all();
    expect(all.some((e) => e.type === "assistant/message")).toBe(true); // 半截文本已物化
    expect((all.at(-1) as { kind?: string }).kind).toBe("error");
  });
});
