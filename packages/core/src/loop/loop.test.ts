import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { Chunk } from "@orosus/contracts/provider";
import { defineTool } from "@orosus/contracts/tool";
import { fakeProvider } from "@orosus/testing";
import { InMemorySessionStore } from "../session/memory.ts";
import { createEventBus, CORE_POINTS } from "../kernel/bus.ts";
import { createToolRegistry } from "../tool/registry.ts";
import { agentLoop } from "./loop.ts";
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
  it("纯文本对话：turn 骨架 + chunk 双写 + 物化 assistant/message + completed", async () => {
    const { run, bus, session } = setup([[
      { type: "text/delta", text: "你" },
      { type: "text/delta", text: "好" },
      { type: "finish", kind: "stop" },
    ]]);
    const preSteps: unknown[] = [];
    bus.on(CORE_POINTS.preStep, (p) => { preSteps.push(p); }, "observer");
    const types = await run();
    expect(types).toEqual([
      "turn/start", "turn/step", "request/header",
      "assistant/chunk", "assistant/chunk", "assistant/chunk",
      "assistant/message", "turn/end",
    ]);
    expect(preSteps).toEqual([{ turn: (await session.all())[0]!.id }]); // step 开始广播被驱动（§6.5：白名单 8 点全部装配）
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
    expect(provider.requests[0]!.messages.some((m) => m.role === "user" && m.content[0]!.text === "记得喝水")).toBe(true);
  });

  it("预中止的 signal → turn/end{kind:interrupted}，不发请求", async () => {
    const { run, provider } = setup([[{ type: "finish", kind: "stop" }]]);
    const c = new AbortController();
    c.abort();
    await run(c.signal);
    expect(provider.requests).toHaveLength(0);
  });
});
