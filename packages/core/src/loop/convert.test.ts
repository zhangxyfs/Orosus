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

  it("agent/steering-message 投影为 user 消息（先落日志再进请求，§6.2）；v3 起带 origin 出处标记", async () => {
    const s = new InMemorySessionStore();
    await s.append("agent/steering-message", { messages: [{ text: "记得先跑测试", sourceModule: "todo" }] });
    const msgs = deriveMessages(await s.all());
    expect(msgs).toEqual([{
      role: "user", content: [{ kind: "text", text: "记得先跑测试" }],
      origin: { kind: "steering", sourceModule: "todo" },
    }]);
  });

  it("steering 缺省 sourceModule 打 host（宿主 busy 期插队话——谓词保留位）；user/message 直投不带 origin（v3 设计空白 1）", async () => {
    const s = new InMemorySessionStore();
    await s.append("agent/steering-message", { messages: [{ text: "插队" }] });
    await s.append("user/message", { content: [{ kind: "text", text: "直敲" }] });
    const msgs = deriveMessages(await s.all());
    expect(msgs[0]).toMatchObject({ origin: { kind: "steering", sourceModule: "host" } });
    expect(msgs[1]).toMatchObject({ role: "user" });
    expect((msgs[1] as { origin?: unknown }).origin).toBeUndefined();
  });

  it("纯 reasoning 的 assistant/message 投影跳过（2026-09-23 实测：思考期取消会落 reasoning-only 消息，" +
    "滤掉 reasoning 后 content 为空数组 → GLM 等 API 400『assistant must not be empty』）", async () => {
    const s = new InMemorySessionStore();
    await s.append("user/message", { content: [{ kind: "text", text: "问" }] });
    await s.append("assistant/message", { content: [{ kind: "reasoning", text: "只思考没正文" }] }); // 取消于思考期
    await s.append("assistant/message", { content: [{ kind: "reasoning", text: "思" }, { kind: "text", text: "答" }] }); // 有正文保留
    const msgs = deriveMessages(await s.all());
    expect(msgs).toEqual([
      { role: "user", content: [{ kind: "text", text: "问" }] },
      { role: "assistant", content: [{ kind: "text", text: "答" }] },
    ]);
  });

  it("reasoning-only 但带工具调用的 assistant 保留（工具链不断——tool/call 附挂）", async () => {
    const s = new InMemorySessionStore();
    await s.append("assistant/message", { content: [{ kind: "reasoning", text: "思" }] });
    await s.append("tool/call", { callId: "c1", name: "tool-fs__read", args: { path: "a" } });
    await s.append("tool/result", { callId: "c1", output: "x", isError: false });
    const msgs = deriveMessages(await s.all());
    expect(msgs[0]).toEqual({
      role: "assistant",
      content: [],
      toolCalls: [{ callId: "c1", name: "tool-fs__read", args: { path: "a" } }],
    }); // 带 toolCalls 的空 content 是合法工具回合（Anthropic 拒空 text 块由 content 留空数组先例承载）
    expect(msgs[1]).toEqual({ role: "toolResult", callId: "c1", output: "x", isError: false });
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

describe("turn/compaction v3 分形（D57：trigger 分级 + keepUserAt 下标重放 + elision 固定模板 + 图片剥占位）", () => {
  const u = (t: string) => ({ content: [{ kind: "text", text: t }] });
  const a = (t: string) => ({ content: [{ kind: "text", text: t }] });
  /** 铺 7 条投影：u0 a1 u2 a3 u4 tr5 u6（tr5 需先 tool/call 建链） */
  const setupEvents = async (): Promise<InMemorySessionStore> => {
    const s = new InMemorySessionStore();
    await s.append("user/message", u("u0"));
    await s.append("assistant/message", a("a1"));
    await s.append("user/message", u("u2"));
    await s.append("assistant/message", a("a3"));
    await s.append("user/message", u("u4"));
    await s.append("tool/call", { callId: "c1", name: "m__t", args: {} });
    await s.append("tool/result", { callId: "c1", output: "tr5", isError: false });
    await s.append("user/message", u("u6"));
    return s;
  };
  const texts = (msgs: ReturnType<typeof deriveMessages>): string[] =>
    msgs.map((m) => m.role === "user" ? String((m.content[0] as { text?: string }).text) : `(${m.role})`);

  it("① v2 旧事件（trigger 缺席）走旧规则：keepFrom 切尾、摘要置顶、无 origin（模块谓词文本兜底路径）", async () => {
    const s = await setupEvents();
    await s.append("turn/compaction", { summary: "旧摘要", keepFrom: 4, droppedCount: 4 });
    const msgs = deriveMessages(await s.all());
    expect(texts(msgs)).toEqual(["[历史摘要]\n旧摘要", "u4", "(toolResult)", "u6"]);
    expect((msgs[0] as { origin?: unknown }).origin).toBeUndefined();
  });

  it("② v3+manual → 全量零保留：仅一条摘要（ZCode 形态），带 compaction-summary origin", async () => {
    const s = await setupEvents();
    await s.append("turn/compaction", { trigger: "manual", summary: "全部摘要", keepUserAt: [], keepUserHead: 0, keepUserTail: 0, droppedCount: 8 });
    const msgs = deriveMessages(await s.all());
    expect(msgs).toHaveLength(1);
    expect(texts(msgs)).toEqual(["[历史摘要]\n全部摘要"]);
    expect((msgs[0] as { origin?: { kind?: string } }).origin).toEqual({ kind: "compaction-summary" });
  });

  it("③ v3+auto → [头, elision, 尾, 摘要]：纯下标取、assistant/tool 不进保留集、摘要置尾（kimi 形态）；M = 头末与尾首之间的投影条数", async () => {
    const s = await setupEvents();
    await s.append("turn/compaction", { trigger: "auto", summary: "S", keepUserAt: [0, 2, 6], keepUserHead: 1, keepUserTail: 2, droppedCount: 5 });
    const msgs = deriveMessages(await s.all());
    expect(texts(msgs)).toEqual(["u0", "[Some messages were omitted here during compaction: 1 messages between the oldest and the most recent user input are covered by the compaction summary at the end.]", "u2", "u6", "[历史摘要]\nS"]);
    expect(msgs.every((m) => m.role === "user")).toBe(true); // 全 user 形状
  });

  it("④ 头尾分界由 keepUserHead 计数定：头段内部下标差 >1（u0 与 u4 间隔 3 条）不得误落段内空档；M 从下标差算", async () => {
    const s = await setupEvents();
    // 头段 [0,4]（段内差 4——段内空档不是分界）、尾段 [6]；M = 6 − 4 − 1 = 1（tr5）
    await s.append("turn/compaction", { trigger: "auto", summary: "S", keepUserAt: [0, 4, 6], keepUserHead: 2, keepUserTail: 1, droppedCount: 5 });
    const msgs = deriveMessages(await s.all());
    expect(texts(msgs)).toEqual([
      "u0", "u4",
      "[Some messages were omitted here during compaction: 1 messages between the oldest and the most recent user input are covered by the compaction summary at the end.]",
      "u6", "[历史摘要]\nS",
    ]);
  });

  it("⑤ 越界/缺省防御：keepUserAt 含负值与超界被滤；keepUserHead 越界夹到段长；keepUserAt 缺省 → 仅摘要（auto 无保留同形）", async () => {
    const s = await setupEvents();
    await s.append("turn/compaction", { trigger: "auto", summary: "S", keepUserAt: [-1, 0, 99, 6], keepUserHead: 99, keepUserTail: 0, droppedCount: 6 });
    let msgs = deriveMessages(await s.all());
    expect(texts(msgs)).toEqual(["u0", "u6", "[Some messages were omitted here during compaction: 0 messages between the oldest and the most recent user input are covered by the compaction summary at the end.]", "[历史摘要]\nS"]); // head 夹到 2：头段全量、尾空、elision M=0（尾空 → 到投影末 7−6−1）
    const s2 = await setupEvents();
    await s2.append("turn/compaction", { trigger: "auto", summary: "S", droppedCount: 8 }); // keepUserAt 缺省
    msgs = deriveMessages(await s2.all());
    expect(texts(msgs)).toEqual(["[历史摘要]\nS"]);
  });

  it("⑥ 事件未知字段忽略不炸", async () => {
    const s = await setupEvents();
    await s.append("turn/compaction", { trigger: "manual", summary: "S", keepUserAt: [], keepUserHead: 0, keepUserTail: 0, droppedCount: 8, extraJunk: { x: 1 } });
    expect(deriveMessages(await s.all())).toHaveLength(1);
  });

  it("⑦ 保留消息 image part 剥为占位文本（双写核心侧——路径保留可 Read 捞回）；无图消息不动", async () => {
    const s = new InMemorySessionStore();
    await s.append("user/message", { content: [
      { kind: "text", text: "看图" },
      { kind: "image", path: "shots/a.png", mimeType: "image/png" },
    ] });
    await s.append("user/message", u("无图"));
    await s.append("turn/compaction", { trigger: "auto", summary: "S", keepUserAt: [0, 1], keepUserHead: 1, keepUserTail: 1, droppedCount: 0 });
    const msgs = deriveMessages(await s.all());
    expect((msgs[0] as { content: { kind: string; text?: string }[] }).content).toEqual([
      { kind: "text", text: "看图" },
      { kind: "text", text: "[image omitted during compaction: shots/a.png]" },
    ]);
    expect(texts(msgs)).toEqual(["看图", "[Some messages were omitted here during compaction: 0 messages between the oldest and the most recent user input are covered by the compaction summary at the end.]", "无图", "[历史摘要]\nS"]);
  });

  it("⑧ 摘要消息（v3）带 compaction-summary origin——下次压缩谓词经元数据剥离，不靠前缀", async () => {
    const s = await setupEvents();
    await s.append("turn/compaction", { trigger: "auto", summary: "S", keepUserAt: [6], keepUserHead: 0, keepUserTail: 1, droppedCount: 6 });
    const msgs = deriveMessages(await s.all());
    const last = msgs[msgs.length - 1] as { origin?: { kind?: string } };
    expect(last.origin).toEqual({ kind: "compaction-summary" });
  });

  it("⑨ 重放确定性：同序列两次投影 JSON 相等（v3 分形全路径）", async () => {
    const mk = async () => {
      const s = await setupEvents();
      await s.append("turn/prune", { prunes: [{ at: 5, headChars: 1, tailChars: 1 }], prunedChars: 1 });
      await s.append("turn/compaction", { trigger: "auto", summary: "S", keepUserAt: [0, 2, 6], keepUserHead: 2, keepUserTail: 1, droppedCount: 4 });
      return deriveMessages(await s.all());
    };
    expect(JSON.stringify(await mk())).toBe(JSON.stringify(await mk()));
  });

  it("⑩ prune 守卫用事件 minLen 判定（缺陷 B 修——判据随事件落盘）：产物 5158 ≤ minLen 5162 → 跳过不裁（旧判据 5120 会再裁）；5158 > minLen 5000 → 裁", async () => {
    const mk = async (minLen: number): Promise<string> => {
      const s = new InMemorySessionStore();
      await s.append("user/message", { content: [{ kind: "text", text: "问" }] });
      await s.append("tool/call", { callId: "c1", name: "m__t", args: {} });
      await s.append("tool/result", { callId: "c1", output: "x".repeat(5158), isError: false }); // 模拟已裁产物实长（head+tail+标记 ≈5158）
      await s.append("turn/prune", { prunes: [{ at: 1, headChars: 4096, tailChars: 1024, minLen }], prunedChars: 0 });
      const msgs = deriveMessages(await s.all());
      return (msgs[1] as { output: string }).output;
    };
    expect(await mk(5_162)).toBe("x".repeat(5158)); // ≤ minLen：认出「已裁过」，跳过
    expect(await mk(5_000)).toContain("[...pruned: original 5158 chars...]"); // > minLen：照裁
  });

  it("⑪ 旧 prune 事件（无 minLen）回落旧判据 head+tail 不炸（存量会话兼容）", async () => {
    const s = new InMemorySessionStore();
    await s.append("user/message", { content: [{ kind: "text", text: "问" }] });
    await s.append("tool/call", { callId: "c1", name: "m__t", args: {} });
    await s.append("tool/result", { callId: "c1", output: "x".repeat(5158), isError: false });
    await s.append("turn/prune", { prunes: [{ at: 1, headChars: 4096, tailChars: 1024 }], prunedChars: 0 }); // v2 旧载荷
    const msgs = deriveMessages(await s.all());
    expect((msgs[1] as { output: string }).output).toContain("[...pruned: original 5158 chars...]"); // 旧判据 5120：5158 > 5120 照裁
  });
});
