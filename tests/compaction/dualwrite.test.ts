import { describe, it, expect } from "vitest";
import { InMemorySessionStore, deriveMessages } from "@orosus/core";
import compaction from "@orosus/compaction";
import type { CommandHandler, CommandUi, LlmPort, Listener } from "@orosus/contracts/module";
import type { Chunk, ModelMessage } from "@orosus/contracts/provider";

/** v3/T7 双写一致性矩阵：模块内存投影（compactOnce 返回值）vs 核心事件重放（deriveMessages）——
 *  两条代码路径的逐字节一致（铁律 2 下两侧各写一份，本矩阵钉住不漂移；模块包内 miniReplay 是手写镜像，
 *  此处用真核心投影函数对照）。真链路顺序：原始消息事件先铺 → 模块压缩落 turn/compaction → 重放。 */

type Ctx = Parameters<NonNullable<typeof compaction.activate>>[0];

const u = (t: string): ModelMessage => ({ role: "user", content: [{ kind: "text", text: t }] });
const a = (t: string): ModelMessage => ({ role: "assistant", content: t === "" ? [] : [{ kind: "text", text: t }] });
const tr = (id: string, chars: number): ModelMessage => ({ role: "toolResult", callId: id, output: "x".repeat(chars), isError: false });

const DEFAULTS = {
  thresholdTokens: 60_000, thresholdRatio: 0.8, userMessageTokens: 20_000, userMessageHeadTokens: 2_000,
  summaryToolResultMaxChars: 2_000, summaryMaxTokens: 8_192,
  pruneThresholdChars: 8_192, pruneHeadChars: 4_096, pruneTailChars: 1_024, backoffGrowthRatio: 0.05,
  rapidRefillRounds: 3, rapidRefillLimit: 3,
};

/** 把投影消息铺成事件序列（deriveMessages(事件) === 原投影 的规范化铺法）：
 *  user 直投 → user/message；steering 注入（origin 标）→ agent/steering-message；assistant → assistant/message；
 *  toolResult → tool/call + tool/result（convert 投影要求 seenCalls 链）。 */
async function layDown(store: InMemorySessionStore, msgs: ModelMessage[]): Promise<void> {
  for (const m of msgs) {
    if (m.role === "user") {
      if (m.origin?.kind === "steering") {
        await store.append("agent/steering-message", { messages: [{ text: String(m.content[0]?.kind === "text" ? m.content[0].text : ""), sourceModule: m.origin.sourceModule }] });
      } else {
        await store.append("user/message", { content: m.content });
      }
    } else if (m.role === "assistant") {
      await store.append("assistant/message", { content: m.content });
      for (const tc of m.toolCalls ?? []) await store.append("tool/call", { callId: tc.callId, name: tc.name, args: tc.args });
    } else {
      await store.append("tool/call", { callId: m.callId, name: "m__t", args: {} });
      await store.append("tool/result", { callId: m.callId, output: m.output, isError: m.isError });
    }
  }
}

interface Harness {
  ctx: Ctx;
  listener: Listener;
  errListener: (p: unknown) => unknown;
  command: CommandHandler;
  store: InMemorySessionStore;
  llmRequests: { system?: string; messages: ModelMessage[] }[];
}

function mkHarness(opts: { config?: Record<string, unknown>; sessionId?: string } = {}): Harness {
  const store = new InMemorySessionStore();
  const listeners = new Map<string, Listener>();
  let command: CommandHandler = async () => "";
  const llmRequests: Harness["llmRequests"] = [];
  const llm: LlmPort = {
    stream: (req) => {
      llmRequests.push(req);
      return (async function* () {
        yield { type: "text/delta", text: "摘要文本" } as Chunk;
        yield { type: "finish", kind: "stop" } as Chunk;
      })();
    },
  };
  const ctx = {
    config: { ...DEFAULTS, ...opts.config },
    configRead: () => Promise.resolve(undefined),
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    ui: { ask: async () => "", askSecret: async () => "", choose: async (_t: string, items: string[]) => items[0]!, confirm: async () => true, notice() {} },
    llm,
    services: { get: () => Promise.reject(new Error("no")), getOptional: () => Promise.resolve(undefined) },
    provide: () => {},
    contribute: {
      tool: () => () => {},
      command: (name: string, handler: CommandHandler) => { void name; command = handler; return () => {}; },
      promptSection: () => () => {},
      configOverlay: () => () => {},
    },
    session: {
      append: (type: string, payload: Record<string, unknown>) => { void store.append(type, payload); },
      ...(opts.sessionId !== undefined ? { id: opts.sessionId } : {}),
    },
    events: {
      on: (type: string, l: Listener) => { listeners.set(type, l); return () => {}; },
      emit: () => Promise.resolve(),
    },
  } as unknown as Ctx;
  return {
    ctx,
    get listener() { return listeners.get("agent/transform-context")!; },
    errListener: (p: unknown) => listeners.get("agent/request-error")!(p),
    get command() { return command; },
    store,
    llmRequests,
  };
}

describe("compaction v3 双写一致性矩阵（T7：模块返回值 = deriveMessages 重放，两份代码逐字节一致）", () => {
  it("① manual：模块返回 [摘要] 单条 = 核心重放（含页脚与 compaction-summary origin）", async () => {
    const h = mkHarness();
    await compaction.activate(h.ctx);
    const msgs = [u("问1"), a("答1"), tr("c1", 30), u("问2")];
    await layDown(h.store, msgs);
    await h.command("", { notice() {} } as unknown as CommandUi); // fake ctx 无冷读口 → forceKind=manual 置位（下一条消息前压缩）
    const moduleOut = (await h.listener(msgs)) as ModelMessage[]; // force manual 消费：全量零保留
    expect(moduleOut).toHaveLength(1);
    expect(String((moduleOut[0] as { content: { text: string }[] }).content[0]!.text)).toContain("[历史摘要]");
    const replayed = deriveMessages(await h.store.all());
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(moduleOut)); // 双写一致的核心断言
    expect((replayed[0] as { origin?: { kind?: string } }).origin).toEqual({ kind: "compaction-summary" });
  });

  it("② auto（图片剥占位 + steering 注入剥离 + elision 恒插）：模块返回值 = 重放逐字节（JSON 相等）", async () => {
    const h = mkHarness({ config: { thresholdTokens: 1, userMessageTokens: 1_200, userMessageHeadTokens: 100, pruneThresholdChars: 99_999 } });
    await compaction.activate(h.ctx);
    const imgUser: ModelMessage = { role: "user", content: [
      { kind: "text", text: "看图" },
      { kind: "image", path: "shots/p.png", mimeType: "image/png" },
    ] }; // ≈1002 token（图 1000/张 + 文本 2）
    const msgs: ModelMessage[] = [
      u("第一问"),                                                        // at 0
      a("中间回答"),
      { role: "user", content: [{ kind: "text", text: "模块注入的提醒" }], origin: { kind: "steering", sourceModule: "todo" } }, // at 2（谓词剥离——不进保留集）
      imgUser,                                                            // at 3（图片剥占位双写点）
      u("尾部最新问题".repeat(20)),                                        // at 4（≈140 token；users 总量 ≈1145 ≤ 1200 全保留）
    ];
    await layDown(h.store, msgs);
    const moduleOut = (await h.listener(msgs)) as ModelMessage[];
    expect(moduleOut.length).toBeGreaterThan(1);
    const replayed = deriveMessages(await h.store.all());
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(moduleOut)); // 双写一致的核心断言
    // 形状要点：steering 注入不在保留集（谓词只在模块侧跑一次）；图片占位在（两侧同款模板）
    expect(JSON.stringify(moduleOut)).not.toContain("模块注入的提醒");
    expect(JSON.stringify(moduleOut)).toContain("[image omitted during compaction: shots/p.png]");
    expect(JSON.stringify(moduleOut)).toContain("[Some messages were omitted here during compaction:");
  });

  it("③ overflow（预算减半）：模块返回值 = 重放逐字节", async () => {
    const h = mkHarness({ config: { thresholdTokens: 1, userMessageTokens: 700, userMessageHeadTokens: 100 } });
    await compaction.activate(h.ctx);
    const msgs = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? u(`问题${i}${"字".repeat(60)}`) : a(`答${i}`)));
    await layDown(h.store, msgs);
    h.errListener({ code: "context_limit" });
    const moduleOut = (await h.listener(msgs)) as ModelMessage[];
    const ev = (await h.store.all()).find((e) => e.type === "turn/compaction")!;
    expect(ev.trigger).toBe("overflow");
    const replayed = deriveMessages(await h.store.all());
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(moduleOut));
  });

  it("④ 谓词只执行一次（keepUserAt 下标锚定的意义）：重放不重新判定——模块判过的保留集原样取、剥过的不回流", async () => {
    // 夹具：v2 旧摘要前缀的直投（无 origin）——模块谓词按前缀剥离；重放若重新按 role 收会分叉，
    // 对照相等证明重放纯按下标取。再钉 steering host 保留位经下标入集。
    const h = mkHarness({ config: { thresholdTokens: 1 } });
    await compaction.activate(h.ctx);
    const msgs: ModelMessage[] = [
      u("[历史摘要]\n旧会话摘要文本"),                                    // 前缀兜底剥离（若重放重判会误收）
      { role: "user", content: [{ kind: "text", text: "busy 期插队" }], origin: { kind: "steering", sourceModule: "host" } }, // 保留
      a("答"),
      u("普通直投"),
    ];
    await layDown(h.store, msgs);
    const moduleOut = (await h.listener(msgs)) as ModelMessage[];
    const replayed = deriveMessages(await h.store.all());
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(moduleOut));
    expect(JSON.stringify(moduleOut)).not.toContain("旧会话摘要文本"); // 前次摘要进 dropped、不留在投影
    expect(JSON.stringify(moduleOut)).toContain("busy 期插队");       // host 插队话保留
  });

  it("⑤ 二次压缩幂等（规格决策 4）：auto 保留的用户消息再次超预算时头尾预算再截——保留集单调收缩", async () => {
    const h = mkHarness({ config: { thresholdTokens: 1, userMessageTokens: 500, userMessageHeadTokens: 50 } });
    await compaction.activate(h.ctx);
    const msgs = Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? u(`用户问题${i}${"内".repeat(80)}`) : a(`答${i}`))); // 8 条用户各 ≈85 token（总 ≈680 > 500）
    await layDown(h.store, msgs);
    const first = (await h.listener(msgs)) as ModelMessage[];
    const firstUsers = first.filter((m) => m.role === "user" && !String((m.content[0] as { text?: string })?.text ?? "").startsWith("[Some messages")).length;
    expect(firstUsers).toBeLessThan(8); // 头尾预算生效（非全保留）
    // 第二次：对已压投影再压（用户消息仍是那批原话——elision/摘要被谓词剥掉）
    const second = (await h.listener(first)) as ModelMessage[];
    expect(second.length).toBeLessThanOrEqual(first.length); // 幂等收缩、不再腐蚀
    const replayed1 = deriveMessages(await h.store.all());
    expect(JSON.stringify(replayed1)).toBe(JSON.stringify(second)); // 第二次事件也双写一致
  });

  it("⑥ prune 双写沿用（minLen 落盘后两侧仍一致）：prune + 摘要同轮发生", async () => {
    const h = mkHarness({ config: { thresholdTokens: 1 } });
    await compaction.activate(h.ctx);
    const msgs = [u("问"), tr("c1", 20_000), u("尾")];
    await layDown(h.store, msgs);
    const moduleOut = (await h.listener(msgs)) as ModelMessage[];
    const types = (await h.store.all()).filter((e) => e.type === "turn/prune" || e.type === "turn/compaction").map((e) => e.type);
    expect(types).toContain("turn/prune");
    const replayed = deriveMessages(await h.store.all());
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(moduleOut));
  });
});
