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
    await s.append("tool/call", { callId: "c1", name: "tool-fs__read", args: { path: "a.ts" } });
    await s.append("tool/result", { callId: "c1", output: "文件内容", isError: false });
    await s.append("turn/end", { kind: "completed" });
    const msgs = deriveMessages(await s.all());
    expect(msgs).toEqual([
      { role: "user", content: [{ kind: "text", text: "你好" }] },
      { role: "assistant", content: [{ kind: "text", text: "你好！" }], toolCalls: [{ callId: "c1", name: "tool-fs__read", args: { path: "a.ts" } }] },
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

describe("turn/prune 投影应用（M3 补强 T5/D44）", () => {
  it("① 裁剪应用：超长 toolResult 的 output 变 head+英文标记+tail（标记含原长度）；其余消息不动", async () => {
    const s = new InMemorySessionStore();
    await s.append("user/message", { content: [{ kind: "text", text: "问" }] });
    await s.append("assistant/message", { content: [] });
    await s.append("tool/call", { callId: "c1", name: "m__t", args: {} });
    const long = "A".repeat(5000) + "B".repeat(5000);
    await s.append("tool/result", { callId: "c1", output: long, isError: false });
    await s.append("turn/prune", { prunes: [{ at: 2, headChars: 4096, tailChars: 1024 }], prunedChars: 4880 });
    const msgs = deriveMessages(await s.all());
    const tr = msgs[2] as { role: string; output: string };
    expect(tr.role).toBe("toolResult");
    expect(tr.output.startsWith("A".repeat(4096))).toBe(true);
    expect(tr.output.endsWith("B".repeat(1024))).toBe(true);
    expect(tr.output).toContain("[...pruned: original 10000 chars...]");
    expect((msgs[0] as { role: string }).role).toBe("user"); // 其余消息不动
  });

  it("② 重放确定性 + 防御：同序列两次投影字节相等；at 越界/指向 user/短于 head+tail 静默跳过、负值按 0 夹紧", async () => {
    const mk = async () => {
      const s = new InMemorySessionStore();
      await s.append("user/message", { content: [{ kind: "text", text: "问" }] });
      await s.append("assistant/message", { content: [] });
      await s.append("tool/call", { callId: "c1", name: "m__t", args: {} });
      await s.append("tool/result", { callId: "c1", output: "X".repeat(100), isError: false });
      await s.append("turn/prune", { prunes: [
        { at: 99, headChars: 10, tailChars: 10 },  // 越界 → 跳过
        { at: 0, headChars: 10, tailChars: 10 },    // 指向 user → 跳过
        { at: 2, headChars: 200, tailChars: 200 },  // 短于 head+tail → 跳过（100 ≤ 400）
        { at: 2, headChars: -5, tailChars: 10 },    // 负值夹 0 → 应用为 head=0+tail=10（三轮 P2）
      ], prunedChars: 90 });
      return deriveMessages(await s.all());
    };
    const a = await mk();
    const b = await mk();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // 重放确定性（同一事件序列两次投影字节相等）
    const tr = a[2] as { output: string };
    expect(tr.output).toContain("[...pruned: original 100 chars...]");
    expect(tr.output.startsWith("\n")).toBe(true); // headChars 夹 0 → 标记前无 head
    expect(tr.output.endsWith("X".repeat(10))).toBe(true);
  });
});
