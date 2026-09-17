import { describe, it, expect } from "vitest";
import type { CommandHandler, LlmPort, Listener } from "@orosus/contracts/module";
import type { Chunk, ModelMessage } from "@orosus/contracts/provider";
import def, { estimateTokens } from "./index.ts";

type Ctx = Parameters<NonNullable<typeof def.activate>>[0];

const u = (t: string): ModelMessage => ({ role: "user", content: [{ kind: "text", text: t }] });
const a = (t: string): ModelMessage => ({ role: "assistant", content: t === "" ? [] : [{ kind: "text", text: t }] });
const tr = (id: string): ModelMessage => ({ role: "toolResult", callId: id, output: `${id}-output`.repeat(50), isError: false });

interface Setup {
  ctx: Ctx;
  listener: Listener;
  command: CommandHandler;
  appended: { type: string; payload: Record<string, unknown> }[];
  llmRequests: { system?: string; messages: ModelMessage[] }[];
}

function setup(opts: { config?: Record<string, unknown>; llmChunks?: Chunk[] } = {}): Setup {
  const appended: Setup["appended"] = [];
  let listener: Listener = async () => undefined;
  let command: CommandHandler = async () => "";
  const llmRequests: Setup["llmRequests"] = [];
  const chunks = opts.llmChunks ?? [{ type: "text/delta", text: "这是摘要" } as Chunk, { type: "finish", kind: "stop" } as Chunk];
  const llm: LlmPort = {
    stream: (req) => {
      llmRequests.push(req);
      return (async function* () { for (const c of chunks) yield c; })();
    },
  };
  const ctx = {
    config: { thresholdTokens: 60_000, keepRecent: 12, ...opts.config },
    configRead: () => Promise.resolve(undefined),
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    ui: { ask: async () => "", choose: async (_t: string, items: string[]) => items[0]!, confirm: async () => true },
    llm,
    services: { get: () => Promise.reject(new Error("no")), getOptional: () => Promise.resolve(undefined) },
    provide: () => {},
    contribute: {
      tool: () => () => {},
      command: (name: string, handler: CommandHandler) => { void name; command = handler; return () => {}; },
      promptSection: () => () => {},
      configOverlay: () => () => {},
    },
    session: { append: (type: string, payload: Record<string, unknown>) => { appended.push({ type, payload }); } },
    events: {
      on: (_t: string, l: Listener) => { listener = l; return () => {}; },
      emit: () => Promise.resolve(),
    },
  } as unknown as Ctx;
  return {
    ctx,
    get listener() { return listener; },
    set listener(l) { listener = l; },
    get command() { return command; },
    set command(c) { command = c; },
    appended,
    llmRequests,
  };
}

describe("compaction 模块（§6.1 turn/compaction、§6.2 reduce 消费方，M3 T5）", () => {
  it("① 阈值未达 → reduce 返回 undefined（不改值、不落事件）", async () => {
    const s = setup({ config: { thresholdTokens: 10_000 } });
    await def.activate(s.ctx);
    const r = await s.listener([u("hi")]);
    expect(r).toBeUndefined();
    expect(s.appended).toEqual([]);
    expect(s.llmRequests).toEqual([]);
  });

  it("② 超阈值 → 返回 [摘要消息, ...keepRecent]；先落 turn/compaction { summary, keepFrom, droppedCount }", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecent: 2 } });
    await def.activate(s.ctx);
    const messages = [u("第一问"), a("第一答"), u("第二问"), a("第二答")];
    const r = (await s.listener(messages)) as ModelMessage[];
    expect(r).toHaveLength(3); // 摘要 + keepRecent 2 条
    const first = r[0] as { role: string; content: { kind: string; text: string }[] };
    expect(first.role).toBe("user");
    expect(first.content[0]!.text).toContain("[历史摘要]");
    expect(first.content[0]!.text).toContain("这是摘要");
    expect(r.slice(1)).toEqual(messages.slice(2));
    expect(s.appended).toEqual([{ type: "turn/compaction", payload: { summary: "这是摘要", keepFrom: 2, droppedCount: 2 } }]);
    expect(s.llmRequests[0]!.messages).toEqual(messages.slice(0, 2)); // 摘要只喂丢弃段
  });

  it("③ 安全切点：切点推进到 user 边界——assistant(toolCalls) 与其 toolResult 不拆开", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecent: 2 } });
    await def.activate(s.ctx);
    const withTools: ModelMessage[] = [
      u("问一"), { role: "assistant", content: [], toolCalls: [{ callId: "c1", name: "m__t", args: {} }] }, tr("c1"),
      { role: "assistant", content: [], toolCalls: [{ callId: "c2", name: "m__t", args: {} }] }, tr("c2"), u("问二"),
    ];
    const r = (await s.listener(withTools)) as ModelMessage[];
    // 原始切点 = 6-2 = 4（落在 tr(c2) 上）→ 推进到 5（user"问二"）；丢弃 5 条
    expect(s.appended[0]!.payload).toMatchObject({ keepFrom: 5, droppedCount: 5 });
    expect(r.slice(1)).toEqual([u("问二")]); // 保留段从 user 开始，无孤儿 toolResult
  });

  it("⑥ token 估算：CJK 近似 1:1、其余 4 字符/token（启发式，只触发阈值）", () => {
    expect(estimateTokens([u("你好")])).toBe(2);                       // 2 CJK
    expect(estimateTokens([u("abcd")])).toBe(1);                       // 4 latin
    expect(estimateTokens([u("你好abcd")])).toBe(3);                   // 2 + 1
    expect(estimateTokens([tr("x")])).toBeGreaterThan(0);              // 工具结果计数
    expect(estimateTokens([{ role: "assistant", content: [], toolCalls: [{ callId: "c", name: "n", args: { k: "vvvv" } }] }])).toBeGreaterThan(0);
  });

  it("⑦ /compact 命令：标记后下一 step 强制压缩（大阈值也触发）；之后恢复配置阈值", async () => {
    const s = setup({ config: { thresholdTokens: 10_000, keepRecent: 1 } });
    await def.activate(s.ctx);
    expect(await s.listener([u("hi")])).toBeUndefined(); // 阈值未达
    const msg = await s.command("", { ask: async () => "", choose: async (_t, i) => i[0]!, confirm: async () => true });
    expect(msg).toContain("强制压缩");
    const r = (await s.listener([u("hi"), a("答"), u("again")])) as ModelMessage[]; // forceOnce → 阈值 0；切点落在 user 边界
    expect(r).toHaveLength(2); // 摘要 + keepRecent 1
    expect(s.appended).toHaveLength(1);
    expect(await s.listener([u("hi")])).toBeUndefined(); // 恢复配置阈值
  });
});

describe("compaction 切点越界防御（四轮 P1）", () => {
  it("keepRecent=1 且消息尾部无 user 边界 → 放弃压缩（undefined，不落事件）", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecent: 1 } });
    await def.activate(s.ctx);
    const r = await s.listener([u("问"), a("答"), a("又答")]); // 尾部无 user——切点推进到末尾
    expect(r).toBeUndefined();
    expect(s.appended).toEqual([]);
  });

  it("keepRecent=1 尾部有 user 边界 → 正常压缩（对照）", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecent: 1 } });
    await def.activate(s.ctx);
    const r = (await s.listener([u("问"), a("答"), u("新")])) as ModelMessage[];
    expect(r).toHaveLength(2);
    expect(s.appended).toHaveLength(1);
  });

  it("估算与 /compact 标记（v1 行为回归）", async () => {
    expect(estimateTokens([u("你好")])).toBe(2);
    expect(estimateTokens([u("abcd")])).toBe(1);
    const s = setup({ config: { thresholdTokens: 100000, keepRecent: 1 } });
    await def.activate(s.ctx);
    const msg = await s.command("", { ask: async () => "", choose: async (_t, i) => i[0]!, confirm: async () => true });
    expect(msg).toContain("强制压缩");
  });
});
