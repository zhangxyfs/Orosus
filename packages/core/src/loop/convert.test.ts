import { describe, it, expect } from "vitest";
import { InMemorySessionStore } from "../session/memory.ts";
import { deriveMessages } from "./convert.ts";

describe("deriveMessages（model-visible ⟺ logged 的投影）", () => {
  it("user/assistant/toolResult 按序投影；turn/request 类不进投影", async () => {
    const s = new InMemorySessionStore();
    await s.append("session/header", { format: 1 });
    await s.append("user/message", { content: [{ kind: "text", text: "你好" }] });
    await s.append("turn/start");
    await s.append("request/header", { model: "m" });
    await s.append("assistant/message", { content: [{ kind: "text", text: "你好！" }] });
    await s.append("tool/result", { callId: "c1", output: "文件内容", isError: false });
    await s.append("turn/end", { kind: "completed" });
    const msgs = deriveMessages(await s.all());
    expect(msgs).toEqual([
      { role: "user", content: [{ kind: "text", text: "你好" }] },
      { role: "assistant", content: [{ kind: "text", text: "你好！" }] },
      { role: "toolResult", callId: "c1", output: "文件内容", isError: false },
    ]);
  });

  it("tool/call 附到最近一条 assistant 的 toolCalls（callId 关联）", async () => {
    const s = new InMemorySessionStore();
    await s.append("assistant/message", { content: [{ kind: "text", text: "我来读一下" }] });
    await s.append("tool/call", { callId: "c1", name: "tool-fs__read", args: { path: "a.ts" } });
    await s.append("tool/call", { callId: "c2", name: "tool-fs__read", args: { path: "b.ts" } });
    await s.append("tool/result", { callId: "c1", output: "A", isError: false });
    await s.append("tool/result", { callId: "c2", output: "B", isError: false });
    const msgs = deriveMessages(await s.all());
    expect(msgs[0]).toEqual({
      role: "assistant",
      content: [{ kind: "text", text: "我来读一下" }],
      toolCalls: [
        { callId: "c1", name: "tool-fs__read", args: { path: "a.ts" } },
        { callId: "c2", name: "tool-fs__read", args: { path: "b.ts" } },
      ],
    });
  });

  it("agent/steering-message 投影为 user 消息（先落日志再进请求，§6.2）", async () => {
    const s = new InMemorySessionStore();
    await s.append("agent/steering-message", { messages: [{ text: "记得先跑测试", sourceModule: "todo" }] });
    const msgs = deriveMessages(await s.all());
    expect(msgs).toEqual([{ role: "user", content: [{ kind: "text", text: "记得先跑测试" }] }]);
  });
});
