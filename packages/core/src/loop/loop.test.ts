import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { Chunk } from "@orosus/contracts/provider";
import { defineTool, Access } from "@orosus/contracts/tool";
import { fakeProvider } from "@orosus/testing";
import { InMemorySessionStore } from "../session/memory.ts";
import { createEventBus, CORE_POINTS } from "../kernel/bus.ts";
import { createToolRegistry } from "../tool/registry.ts";
import { agentLoop } from "./loop.ts";
import type { LoopOptions } from "./loop.ts";
import { deriveMessages } from "./convert.ts";
import type { DiagSink, DiagRecord } from "../diag/logger.ts";

const sink = (): DiagSink & { records: DiagRecord[] } => {
  const records: DiagRecord[] = [];
  return { records, write: (r) => void records.push(r), flush: () => Promise.resolve(), close: () => Promise.resolve() };
};

const setup = (script: Chunk[][], extra: Pick<LoopOptions, "networkRetryDelaysMs"> = {}) => {
  const s = sink();
  const bus = createEventBus(s);
  const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/orosus-loop-spill" });
  const session = new InMemorySessionStore();
  const provider = fakeProvider(script);
  const run = (signal = new AbortController().signal) =>
    (async () => {
      const types: string[] = [];
      for await (const e of agentLoop({ session, bus, tools, provider: provider.stream, model: "fake/m", system: "sys", signal, sink: s, ...extra })) {
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
    expect(typeof msg.durationMs).toBe("number"); // 2026-10-01 拍板 B：末次请求耗时随 message 带内（「网络·MCP」卡模型服务行数据源）
    expect(msg.durationMs as number).toBeGreaterThanOrEqual(0);
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

  it("工具结果带图（m5-media F1）：images 落 tool/result 事件 + 下一请求投影 toolResult.parts；无图结果零差异（不带 images 字段）", async () => {
    const { run, tools, provider, session } = setup([
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "m__shot", argumentsDelta: "{}" },
        { type: "toolcall/argumentsDelta", callId: "c2", name: "m__t", argumentsDelta: "{}" },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "看到了" }, { type: "finish", kind: "stop" }],
    ]);
    tools.register(defineTool({
      name: "m__shot", description: "shot", parameters: z.object({}),
      resolveExecution: async () => ({
        execute: async () => ({ output: "截图完成", isError: false, images: [{ path: "/sess/media/media-1-c1.png", mimeType: "image/png" }] }),
      }),
    }), "m");
    tools.register(defineTool({
      name: "m__t", description: "t", parameters: z.object({}),
      resolveExecution: async () => ({ execute: async () => ({ output: "纯文本", isError: false }) }),
    }), "m");
    await run();
    const all = await session.all();
    const shotResult = all.find((e) => e.type === "tool/result" && e.callId === "c1")!;
    expect(shotResult.images).toEqual([{ path: "/sess/media/media-1-c1.png", mimeType: "image/png" }]); // 路径引用落日志
    const textResult = all.find((e) => e.type === "tool/result" && e.callId === "c2")!;
    expect((textResult as { images?: unknown }).images).toBeUndefined(); // 无图零差异
    const shot = provider.requests[1]!.messages.find((m) => m.role === "toolResult" && m.callId === "c1");
    expect(shot).toMatchObject({ parts: [{ kind: "image", path: "/sess/media/media-1-c1.png", mimeType: "image/png" }] }); // 投影带图
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
  /** CL-10（2026-09-28 code review）：执行窗口记录版——并发判据用「两任务执行窗口是否重叠」替代
   *  墙钟余量断言（旧断言余量仅 ~60ms，CI 高负载/定时器漂移即与代码正确性无关地红；串行侧的
   *  ≥150ms 下限断言则恒真、不构成对称保护）。 */
  const timedTool = (windows: Record<string, { start: number; end: number }>, name: string, accesses: Access[]) =>
    defineTool({
      name, description: name, parameters: z.object({}),
      resolveExecution: async () => ({
        accesses,
        approvalRule: name,
        execute: async () => {
          const start = Date.now();
          await new Promise((r) => setTimeout(r, DELAY));
          windows[name] = { start, end: Date.now() };
          return { output: `${name}-ok`, isError: false };
        },
      }),
    });

  it("无冲突工具并行：两任务执行窗口重叠（§6.3 分组并发；CL-10 重叠判据）", async () => {
    const { run, tools, session } = setup([
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "m__a", argumentsDelta: "{}" } as Chunk,
        { type: "toolcall/argumentsDelta", callId: "c2", name: "m__b", argumentsDelta: "{}" } as Chunk,
        { type: "finish", kind: "toolUse" } as Chunk,
      ],
      [{ type: "text/delta", text: "done" }, { type: "finish", kind: "stop" }] as Chunk[],
    ]);
    const windows: Record<string, { start: number; end: number }> = {};
    tools.register(timedTool(windows, "m__a", [Access.fsRead("/a")]), "m");
    tools.register(timedTool(windows, "m__b", [Access.fsRead("/b")]), "m");
    await run();
    // 对称判据之并行侧：各自开始时刻都在对方结束之前（调度退化为串行时两条同时失败）
    expect(windows["m__a"]!.start).toBeLessThan(windows["m__b"]!.end);
    expect(windows["m__b"]!.start).toBeLessThan(windows["m__a"]!.end);
    const all = await session.all();
    expect(all.filter((e) => e.type === "tool/result" && e.output === "m__a-ok")).toHaveLength(1);
    expect(all.filter((e) => e.type === "tool/result" && e.output === "m__b-ok")).toHaveLength(1);
  });

  it("冲突工具串行（b 的开始不早于 a 的结束）；同组否决不影响其他成员（denied 与 ok 并存）", async () => {
    const { run, tools, session, bus } = setup([
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "m__a", argumentsDelta: "{}" } as Chunk,
        { type: "toolcall/argumentsDelta", callId: "c2", name: "m__b", argumentsDelta: "{}" } as Chunk,
        { type: "toolcall/argumentsDelta", callId: "c3", name: "m__c", argumentsDelta: "{}" } as Chunk,
        { type: "finish", kind: "toolUse" } as Chunk,
      ],
      [{ type: "text/delta", text: "done" }, { type: "finish", kind: "stop" }] as Chunk[],
    ]);
    const windows: Record<string, { start: number; end: number }> = {};
    tools.register(timedTool(windows, "m__a", [Access.fsWrite("/same")]), "m");
    tools.register(timedTool(windows, "m__b", [Access.fsWrite("/same")]), "m"); // 与 a 冲突 → 分组串行
    tools.register(delayedTool("m__c", [Access.fsRead("/c")]), "m");            // 与 a/b 不冲突 → 同组并行
    bus.on(CORE_POINTS.toolPreExecute, (p) => {
      const payload = p as { name?: string };
      if (payload.name === "m__c") return { deny: true, reason: "审批否决（并行组内）" };
      return undefined;
    }, "approval");
    await run();
    // 对称判据之串行侧（CL-10）：窗口不重叠——b 的开始 ≥ a 的结束（与并行侧断言互为镜像）
    expect(windows["m__b"]!.start).toBeGreaterThanOrEqual(windows["m__a"]!.end);
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

  it("④ reasoningEffort 透传（/effort 2026-09-25）：请求带字段 + request/header 记 effort；缺省不带", async () => {
    const s = sink();
    const bus = createEventBus(s);
    const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/orosus-loop-spill" });
    const session = new InMemorySessionStore();
    const provider = fakeProvider([[{ type: "text/delta", text: "x" }, { type: "finish", kind: "stop" }]]);
    for await (const _e of agentLoop({ session, bus, tools, provider: provider.stream, model: "fake/m", system: "sys", signal: new AbortController().signal, sink: s, reasoningEffort: "high" })) { void _e; }
    expect(provider.requests[0]!.reasoningEffort).toBe("high"); // 主轮请求透传（provider 翻译层落线缆参数）
    const header = (await session.all()).find((e) => e.type === "request/header") as { effort?: string };
    expect(header.effort).toBe("high"); // 审计面记档
    // 缺省路径：不传 reasoningEffort → 请求与 header 都无字段（端点默认行为）
    const session2 = new InMemorySessionStore();
    const provider2 = fakeProvider([[{ type: "finish", kind: "stop" }]]);
    for await (const _e of agentLoop({ session: session2, bus, tools, provider: provider2.stream, model: "fake/m", system: "sys", signal: new AbortController().signal, sink: s })) { void _e; }
    expect("reasoningEffort" in provider2.requests[0]!).toBe(false);
    expect(((await session2.all()).find((e) => e.type === "request/header") as { effort?: string }).effort).toBeUndefined();
  });
});

describe("网络错误重试（2026-09-30 拍板 a：传输层失败零产出重发——限次退避，代理切换/瞬时抖动兜底）", () => {
  const netErr = { type: "finish", kind: "error", errorMessage: "网络错误：fetch failed；cause: read ECONNRESET", errorCode: "network" } as const;

  it("① 首请求 network → 广播 request-error(network) → 退避后重发成功：turn completed、消息原样、不落重复 header", async () => {
    const { run, bus, provider, session } = setup([
      [netErr],
      [{ type: "text/delta", text: "好了" }, { type: "finish", kind: "stop" }],
    ], { networkRetryDelaysMs: [1] });
    await session.append("user/message", { content: [{ kind: "text", text: "hi" }] });
    const errs: unknown[] = [];
    bus.on(CORE_POINTS.requestError, (p) => { errs.push(p); }, "observer");
    const types = await run();
    expect(errs).toHaveLength(1);
    expect((errs[0] as { code: string }).code).toBe("network");
    expect(provider.requests).toHaveLength(2); // 恰重发一次
    expect(provider.requests[1]!.messages).toEqual(provider.requests[0]!.messages); // 原样重发
    expect(types.filter((t) => t === "request/header")).toHaveLength(1); // lastRequestSig 不变 → 不落重复 header
    const all = await session.all();
    expect(all.at(-1)).toMatchObject({ type: "turn/end", kind: "completed" });
  });

  it("② 恒 network → 退避表 [1,1] 用尽（1+2 次调用）终局 error，errorMessage 带重发指引", async () => {
    const { run, provider, session } = setup([[netErr]], { networkRetryDelaysMs: [1, 1] }); // fakeProvider 重复末位脚本 → 恒失败
    await run();
    expect(provider.requests).toHaveLength(3); // 首发 + 两次重发
    const end = (await session.all()).at(-1) as { type: string; kind?: string; errorMessage?: string };
    expect(end).toMatchObject({ type: "turn/end", kind: "error" });
    expect(end.errorMessage).toContain("已自动重发 2 次仍网络错误");
    expect(end.errorMessage).toContain("read ECONNRESET"); // cause 链进终局事件（拍板 b）
  });

  it("③ 部分产出防护：先流出 text 再 network → 不重试（provider 只调 1 次），半截物化 + error 终局", async () => {
    const { run, provider, session } = setup([
      [{ type: "text/delta", text: "半截" }, netErr],
    ], { networkRetryDelaysMs: [1] });
    await run();
    expect(provider.requests).toHaveLength(1);
    const all = await session.all();
    expect(all.some((e) => e.type === "assistant/message")).toBe(true); // 半截文本已物化
    expect((all.at(-1) as { kind?: string }).kind).toBe("error");
  });

  it("④ reasoning 半截同防护：思考已流出再 network → 不重试（比 context_limit 多查的口径——防两份 reasoning 先后物化）", async () => {
    const { run, provider } = setup([
      [{ type: "reasoning/delta", text: "思" }, netErr],
    ], { networkRetryDelaysMs: [1] });
    await run();
    expect(provider.requests).toHaveLength(1);
  });

  it("⑤ 退避期 abort → interrupted 收场（不打满等待、不再重发）", async () => {
    const { run, provider, session } = setup([[netErr]], { networkRetryDelaysMs: [5_000] });
    const ac = new AbortController();
    const p = run(ac.signal);
    await new Promise((r) => setTimeout(r, 5)); // 首请求已失败、退避中
    ac.abort();
    await p;
    expect(provider.requests).toHaveLength(1); // 退避被打断——未再发
    expect(((await session.all()).at(-1) as { kind?: string }).kind).toBe("interrupted");
  });
});

describe("turn 事件上总线（m5 T9 设计空白 17——busy 自推事件面）", () => {
	it("turn/start·turn/end 广播到模块总线（此前只进 session 流——照方订阅永不触发）", async () => {
		const { bus, run } = setup([[
			{ type: "text/delta", text: "好" },
			{ type: "finish", kind: "stop" },
		]]);
		const seen: string[] = [];
		bus.on("turn/start", (p) => { seen.push(`start:${(p as { model: string }).model}`); }, "observer");
		bus.on("turn/end", (p) => { seen.push(`end:${(p as { kind: string }).kind}`); }, "observer");
		await run();
		expect(seen).toEqual(["start:fake/m", "end:completed"]); // turn 级终态 = completed（finish stop 的上层语义）
	});
});

describe("工具任务契约外抛出的兜底（CL-01/CX-03——2026-09-28 code review P1）", () => {
	it("execute reject → 组照常收尾：turn/end 照落、带内错误 toolResult、下一轮照常携带（旧实现生成器死等 + unhandledRejection 崩进程）", async () => {
		const { run, tools, session, provider } = setup([
			[
				{ type: "toolcall/argumentsDelta", callId: "c1", name: "m__t", argumentsDelta: "{}" },
				{ type: "finish", kind: "toolUse" },
			],
			[{ type: "text/delta", text: "done" }, { type: "finish", kind: "stop" }],
		]);
		tools.register(defineTool({
			name: "m__t", description: "t", parameters: z.object({}),
			resolveExecution: async () => ({ execute: async () => ({ output: "ok", isError: false }) }),
		}), "m");
		const reg = tools as unknown as { execute: (p: unknown, c: unknown) => Promise<{ output: string; isError: boolean }> };
		const orig = reg.execute.bind(tools);
		reg.execute = async (p, c) => {
			if ((p as { ok?: boolean; name?: string }).name === "m__t") throw new Error("契约外炸了");
			return orig(p, c);
		};
		const types = await run(); // 旧实现：此处永不返回（finished 永不置位）或进程崩
		expect(types).toContain("turn/end");
		const all = await session.all();
		const tr = all.find((e) => e.type === "tool/result");
		expect(tr?.isError).toBe(true);
		expect(String(tr?.output)).toContain("契约外炸了");
		expect(provider.requests[1]!.messages.some((m) => m.role === "toolResult")).toBe(true); // 模型下一轮照常拿到带内结果
	});
});

describe("流终止帧缺失 / max_tokens 截断（CL-02/CL-03——2026-09-28 code review）", () => {
	it("CL-02 provider 干净 EOF 无 finish 块 → turn/end{kind:error} 且 errorMessage 指明截断（旧实现沿用预置 kind:\"stop\" 静默收尾，半截回答被当完整答案）", async () => {
		const { run, session } = setup([[{ type: "text/delta", text: "半截" }]]); // 剧本刻意无 finish 块——流干净结束
		const types = await run();
		expect(types).toContain("assistant/message"); // 半截产出仍物化（诚实保留，不因收尾改判而丢弃）
		const end = (await session.all()).at(-1) as { type: string; kind?: string; errorMessage?: string };
		expect(end).toMatchObject({ type: "turn/end", kind: "error" }); // 旧实现：kind:"completed"、零截断痕迹
		expect(end.errorMessage).toContain("截断");
	});

	it("CL-02 对照：正常 stop（finish 块在场）不受影响——不误报截断", async () => {
		const { run, session } = setup([[{ type: "text/delta", text: "完整" }, { type: "finish", kind: "stop" }]]);
		await run();
		const end = (await session.all()).at(-1) as { kind?: string; errorMessage?: string; finishKind?: string };
		expect(end.kind).toBe("completed");
		expect(end.errorMessage).toBeUndefined();
		expect(end.finishKind).toBeUndefined();
	});

	it("CL-03 finish kind:length → assistant/message 与 turn/end 落 finishKind:\"length\" 带内记档（completed 语义不变；旧实现全仓零 length 消费、截断不可见）", async () => {
		const { run, session } = setup([[{ type: "text/delta", text: "被切断的" }, { type: "finish", kind: "length" }]]);
		await run();
		const all = await session.all();
		const msg = all.find((e) => e.type === "assistant/message") as { finishKind?: string };
		expect(msg?.finishKind).toBe("length"); // per-step 精确记档（中间步骤截断也可见）
		const end = all.at(-1) as { type: string; kind?: string; finishKind?: string };
		expect(end).toMatchObject({ type: "turn/end", kind: "completed", finishKind: "length" }); // turn 正常完成，但截断留痕
	});
});

describe("停止边界 followUp 处理（CL-07——2026-09-28 code review）", () => {
	it("CL-07 回归钉：stops=true 时 followUps 照常落 agent/steering-message 但不续跑（旧实现 collect 后静默丢弃——splice 式 drain 排空即丢，用户插队话/子代理结论无声消失）", async () => {
		const { run, bus, session, provider } = setup([[{ type: "text/delta", text: "答" }, { type: "finish", kind: "stop" }]]);
		let drained = 0;
		bus.on(CORE_POINTS.shouldStop, () => true, "stopper");
		bus.on(CORE_POINTS.followUp, () => { drained++; return [{ text: "插队话", sourceModule: "m" }]; }, "m");
		await run();
		expect(drained).toBe(1); // 停止边界确实 collect（排空——积压不滞留，防与送回轮补触发形成空转链）
		const all = await session.all();
		expect(all.some((e) => e.type === "agent/steering-message" && JSON.stringify(e).includes("插队话"))).toBe(true); // 内容落日志（进后续投影）——旧实现零痕迹
		expect(provider.requests).toHaveLength(1); // 未续跑（模块已喊停）
		expect(all.at(-1)).toMatchObject({ type: "turn/end", kind: "completed" }); // 终局语义不变
	});

	it("CL-07 对照：无 shouldStop（或 false）→ followUp 续跑一轮（既有行为不变；监听器 splice 式一次性排空——真实 drain 语义，非恒产出）", async () => {
		const { run, bus, provider } = setup([
			[{ type: "text/delta", text: "答" }, { type: "finish", kind: "stop" }],
			[{ type: "text/delta", text: "续" }, { type: "finish", kind: "stop" }],
		]);
		const backlog = [{ text: "插队话", sourceModule: "m" }];
		bus.on(CORE_POINTS.shouldStop, () => false, "stopper");
		bus.on(CORE_POINTS.followUp, () => backlog.splice(0), "m");
		await run();
		expect(provider.requests).toHaveLength(2); // 续跑一轮
		expect(provider.requests[1]!.messages.some((m) => m.role === "user" && (m.content[0] as { text?: string }).text === "插队话")).toBe(true);
	});
});

describe("request/header 审计口径（CL-05——2026-09-28 code review）", () => {
	it("CL-05 回归钉：toolsCount 与实际发送同源（specs——ToolSearch 藏 deferred 未 reveal 时不虚报；旧实现记 list().length）", async () => {
		const s = sink();
		const bus = createEventBus(s);
		const tools = createToolRegistry({ bus, sink: s, spillDir: "/tmp/orosus-loop-spill" });
		const session = new InMemorySessionStore();
		const provider = fakeProvider([[{ type: "text/delta", text: "x" }, { type: "finish", kind: "stop" }]]);
		tools.register(defineTool({
			name: "m__plain", description: "p", parameters: z.object({}),
			resolveExecution: async () => ({ execute: async () => ({ output: "ok", isError: false }) }),
		}), "m");
		tools.register(defineTool({
			name: "m__lazy", description: "l", deferred: true, parameters: z.object({}),
			resolveExecution: async () => ({ execute: async () => ({ output: "ok", isError: false }) }),
		}), "m");
		tools.setDeferredEnabled(true);
		expect(tools.list()).toHaveLength(2); // list 不过滤（目录口径）——制造两数分歧
		expect(tools.specs()).toHaveLength(1); // specs 滤 hidden（发送口径）
        for await (const e of agentLoop({ session, bus, tools, provider: provider.stream, model: "fake/m", system: "sys", signal: new AbortController().signal, sink: s })) { void e; }
		expect(provider.requests[0]!.tools).toHaveLength(1); // 实际发送 = specs
		const header = (await session.all()).find((e) => e.type === "request/header") as { toolsCount?: number };
		expect(header.toolsCount).toBe(1); // 旧实现记 list().length = 2——审计口径与实发数失真
	});
});
