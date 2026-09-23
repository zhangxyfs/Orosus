import { describe, it, expect } from "vitest";
import type { CommandHandler, CommandUi, LlmPort, Listener } from "@orosus/contracts/module";
import type { Chunk, ModelMessage } from "@orosus/contracts/provider";
import def, { collectRealUserMessages, configSchema, estimateTokens, isRealUserInput, selectUserMessages } from "./index.ts";

type Ctx = Parameters<NonNullable<typeof def.activate>>[0];

const u = (t: string): ModelMessage => ({ role: "user", content: [{ kind: "text", text: t }] });
const a = (t: string): ModelMessage => ({ role: "assistant", content: t === "" ? [] : [{ kind: "text", text: t }] });
const tr = (id: string, chars: number): ModelMessage => ({ role: "toolResult", callId: id, output: "x".repeat(chars), isError: false });
const su = (t: string, origin?: { kind: "steering"; sourceModule: string } | { kind: "compaction-summary" }): ModelMessage =>
  ({ role: "user", content: [{ kind: "text", text: t }], ...(origin !== undefined ? { origin } : {}) });

const notices: string[] = []; // notice 通道捕获（批⑧——纯提示类结果改走 ui.notice，不落返回串）
const stubUi: CommandUi = { ask: async () => "", askSecret: async () => "", choose: async (_t, items) => items[0]!, confirm: async () => true, notice: (t) => notices.push(t) };

// schema 全默认值的手写镜像（fake ctx 不经 zod default 管线——kernel 真链路才有）；T0 换血后 = 12 键形态
const DEFAULTS = {
  thresholdTokens: 60_000, thresholdRatio: 0.8, userMessageTokens: 20_000, userMessageHeadTokens: 2_000,
  summaryToolResultMaxChars: 2_000, summaryMaxTokens: 8_192,
  pruneThresholdChars: 8_192, pruneHeadChars: 4_096, pruneTailChars: 1_024, backoffGrowthRatio: 0.05,
  rapidRefillRounds: 3, rapidRefillLimit: 3,
};

interface Setup {
  ctx: Ctx;
  listener: Listener;
  errListener: (p: unknown) => unknown;
  command: CommandHandler;
  appended: { type: string; payload: Record<string, unknown> }[];
  llmRequests: { system?: string; messages: ModelMessage[]; maxTokens?: number }[];
  warns: { code: string }[];
  llm: LlmPort & { contextWindow?: number | undefined; lastUsage?: { totalTokens: number; atMessageCount: number } | undefined };
  setLlmChunks(chunks: Chunk[]): void;
}

function setup(opts: { config?: Record<string, unknown>; llmChunks?: Chunk[]; contextWindow?: number; coldProject?: ModelMessage[]; sessionId?: string } = {}): Setup {
  const appended: Setup["appended"] = [];
  const listeners = new Map<string, Listener>();
  let command: CommandHandler = async () => "";
  const llmRequests: Setup["llmRequests"] = [];
  let chunks: Chunk[] = opts.llmChunks ?? [{ type: "text/delta", text: "这是摘要" } as Chunk, { type: "finish", kind: "stop" } as Chunk];
  const warns: { code: string }[] = [];
  const llm: Setup["llm"] = {
    stream: (req) => {
      llmRequests.push(req);
      return (async function* () { for (const c of chunks) yield c; })();
    },
    ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
  };
  const ctx = {
    config: { ...DEFAULTS, ...opts.config },
    configRead: () => Promise.resolve(undefined),
    log: {
      trace() {}, debug() {},
      info(code: string) { warns.push({ code }); },
      warn(code: string) { warns.push({ code }); },
      error() {},
    },
    ui: stubUi,
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
      append: (type: string, payload: Record<string, unknown>) => { appended.push({ type, payload }); },
      // F5 二轮⑰ 读口夹具：coldProject 提供时模拟核心宿主的投影读口；id 可选（v3 设计空白 2 页脚）
      ...(opts.coldProject !== undefined ? { messages: async () => opts.coldProject! } : {}),
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
    appended,
    llmRequests,
    warns,
    llm,
    setLlmChunks(next: Chunk[]) { chunks = next; },
  };
}

/** 迷你重放（镜像 convert.ts 的 turn/prune + turn/compaction v3 分形应用语义——v2 载荷走 keepFrom 旧规则）——
 *  用例⑤等钉"模块侧返回值 = 核心侧重放"双写一致。 */
const replayStripImages = (m: ModelMessage): ModelMessage => {
  if (m.role !== "user" || !m.content.some((p) => p.kind === "image")) return m;
  return { ...m, content: m.content.map((p) => p.kind === "image"
    ? { kind: "text" as const, text: `[image omitted during compaction: ${p.path}]` } : p) };
};
const replayElision = (omitted: number): string =>
  `[Some messages were omitted here during compaction: ${omitted} messages between the oldest and the most recent user input are covered by the compaction summary at the end.]`;
const miniReplay = (msgs: ModelMessage[], events: { type: string; payload: Record<string, unknown> }[]): ModelMessage[] => {
  let out = msgs.map((m) => ({ ...m }));
  for (const e of events) {
    if (e.type === "turn/prune") {
      for (const p of e.payload.prunes as { at: number; headChars: number; tailChars: number }[]) {
        const m = out[p.at] as { role: string; output: string } | undefined;
        if (m === undefined || m.role !== "toolResult" || m.output.length <= p.headChars + p.tailChars) continue;
        m.output = `${m.output.slice(0, p.headChars)}\n[...pruned: original ${m.output.length} chars...]\n${m.output.slice(-p.tailChars)}`;
      }
    } else if (e.type === "turn/compaction") {
      const summary = String(e.payload.summary);
      if (e.payload.trigger === undefined) {
        out = [{ role: "user", content: [{ kind: "text", text: `[历史摘要]\n${summary}` }] }, ...out.slice(Number(e.payload.keepFrom ?? 0))];
        continue;
      }
      const summaryMsg: ModelMessage = { role: "user", content: [{ kind: "text", text: `[历史摘要]\n${summary}` }], origin: { kind: "compaction-summary" } };
      const keepUserAt = (Array.isArray(e.payload.keepUserAt) ? e.payload.keepUserAt : [])
        .map((x) => Number(x)).filter((i) => Number.isInteger(i) && i >= 0 && i < out.length).sort((x, y) => x - y);
      if (String(e.payload.trigger) === "manual" || keepUserAt.length === 0) { out = [summaryMsg]; continue; }
      const kept = keepUserAt.map((i) => replayStripImages(out[i]!));
      const keepUserHead = Math.max(0, Math.min(Number(e.payload.keepUserHead ?? 0) || 0, keepUserAt.length));
      const headKept = kept.slice(0, keepUserHead);
      const tailKept = kept.slice(keepUserHead);
      const headLastAt = keepUserHead > 0 ? keepUserAt[keepUserHead - 1]! : -1;
      const tailFirstAt = keepUserHead < keepUserAt.length ? keepUserAt[keepUserHead]! : out.length;
      const elisionMsg: ModelMessage = { role: "user", content: [{ kind: "text", text: replayElision(tailFirstAt - headLastAt - 1) }] };
      out = [...headKept, elisionMsg, ...tailKept, summaryMsg];
    }
  }
  return out;
};

const firstText = (m: unknown): string => String((m as { content: { text: string }[] }).content[0]!.text);
const ELISION_PREFIX = "[Some messages were omitted here during compaction:";

describe("compaction 模块（v3/D57：锚定/窗口/prune 前置/触发分级/失败不装+退避+熔断）", () => {
  it("① 阈值未达（纯估算路径）→ undefined：不落事件、不调 llm", async () => {
    const s = setup({ config: { thresholdTokens: 10_000 } });
    await def.activate(s.ctx);
    expect(await s.listener([u("hi")])).toBeUndefined();
    expect(s.appended).toEqual([]);
    expect(s.llmRequests).toEqual([]);
  });

  it("② usage 锚定三态：新鲜锚定触发 / 改写后 stale 纯估算 / 新锚点恢复；并入 CJK 估算断言（原⑥语义）", async () => {
    expect(estimateTokens([u("你好")])).toBe(2);          // CJK 1:1
    expect(estimateTokens([u("abcd")])).toBe(1);          // 拉丁 4:1
    expect(estimateTokens([u("你好abcd")])).toBe(3);
    const s = setup({ config: { thresholdTokens: 990 } });
    s.llm.lastUsage = { totalTokens: 1000, atMessageCount: 1 }; // 新鲜锚点
    await def.activate(s.ctx);
    const msgs = [u("一"), a("答一"), u("二"), a("答二"), u("三"), a("答三"), u("四"), a("答四")];
    const r1 = (await s.listener(msgs)) as ModelMessage[];  // 锚定 1000+ > 990 触发；纯估算 < 990 不触发
    expect(s.llmRequests).toHaveLength(1);
    expect(r1).toHaveLength(6); // v3 auto：4 条用户消息全保留（预算内）+ elision + 摘要置尾
    expect(firstText(r1[r1.length - 1])).toContain("[历史摘要]");
    expect(await s.listener(r1)).toBeUndefined();          // stale：压缩改写后纯估算 → 不再触发
    expect(s.llmRequests).toHaveLength(1);
    s.llm.lastUsage = { totalTokens: 2000, atMessageCount: 2 }; // 新锚点（at 变化）且长度判据满足 → 恢复锚定
    const r3 = (await s.listener(r1)) as ModelMessage[];
    expect(s.llmRequests).toHaveLength(2);
    expect(r3).toHaveLength(6);
  });

  it("③ 窗口感知：contextWindow 已知时阈值 = floor(窗口×ratio)；未知回退 thresholdTokens；trigger=auto 落盘", async () => {
    const s = setup({ contextWindow: 1024 }); // 阈值 819
    await def.activate(s.ctx);
    const msgs = [u("字".repeat(900)), a("答"), u("再问")];
    const r = (await s.listener(msgs)) as ModelMessage[]; // est 903 > 819 触发
    expect(r).toHaveLength(4); // v3 auto：2 条用户消息（预算内全保留）+ elision + 摘要
    expect(s.appended.some((e) => e.type === "turn/compaction" && e.payload.trigger === "auto")).toBe(true);
    const s2 = setup({ config: {} }); // 窗口未知 → 60000 回退 → 不触发
    await def.activate(s2.ctx);
    expect(await s2.listener(msgs)).toBeUndefined();
  });

  it("④ prune 前置：超阈值且含超长工具结果 → 先落 turn/prune（不调 llm）、裁剪后低于阈值 → 返回裁剪副本（免摘要救援）", async () => {
    const s = setup({ config: { thresholdTokens: 5_000 } });
    await def.activate(s.ctx);
    const msgs = [u("问"), a(""), tr("c1", 20_000), u("尾")];
    const r = (await s.listener(msgs)) as ModelMessage[];
    expect(s.appended).toHaveLength(1);
    expect(s.appended[0]!.type).toBe("turn/prune");
    expect(s.appended[0]!.payload).toMatchObject({ prunedChars: 20_000 - (4_096 + 1_024) }); // 原长 - head - tail
    expect(s.llmRequests).toEqual([]); // 不调 llm
    expect((r[2] as { output: string }).output).toContain("[...pruned: original 20000 chars...]");
  });

  it("⑤ prune 后仍超 → 摘要路径：keepUserAt 锚定在裁剪后投影（本地迷你重放与 reduce 返回值字节一致——双写钉子）", async () => {
    const s = setup({ config: { thresholdTokens: 1 } });
    await def.activate(s.ctx);
    const msgs = [u("问"), a(""), tr("c1", 20_000), u("尾")];
    const r = (await s.listener(msgs)) as ModelMessage[];
    expect(s.appended.map((e) => e.type)).toEqual(["turn/prune", "turn/compaction"]);
    expect(JSON.stringify(miniReplay(msgs, s.appended))).toBe(JSON.stringify(r));
  });

  it("⑥ auto 用户消息头尾预算：总量超 userMessageTokens 时尾段装填（max−head）、头段装填 head、其余进摘要（v3）", async () => {
    const mk = () => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (i % 2 === 0 ? u("问".repeat(1000)) : a("答".repeat(1000))));
    const s = setup({ contextWindow: 8192, config: { userMessageTokens: 2_000, userMessageHeadTokens: 500 } });
    await def.activate(s.ctx);
    const r = (await s.listener(mk())) as ModelMessage[]; // est 8000 > 6553 触发；4 条用户各 1000：尾预算 1500 → 尾 1 条、head 500 → 头空
    expect(r).toHaveLength(3); // [elision, u6, 摘要]——头空时 elision 仍置尾段之前（设计空白 4 边界）
    expect(firstText(r[0])).toContain(ELISION_PREFIX);
    expect(firstText(r[1])).toContain("问");
    const payload = s.appended.find((e) => e.type === "turn/compaction")!.payload as { keepUserAt: number[]; keepUserHead: number; keepUserTail: number };
    expect(payload.keepUserAt).toEqual([6]);
    expect(payload.keepUserHead).toBe(0);
    expect(payload.keepUserTail).toBe(1);
  });

  it("⑦ v3 零拒绝（缺陷 A 机制退役）：预算盖过全会话 / 尾部无用户消息 → 照样压缩（用户消息全保留+摘要置尾）", async () => {
    const s = setup({ config: { thresholdTokens: 1 } });
    await def.activate(s.ctx);
    const r = (await s.listener([u("问"), a("答"), u("新")])) as ModelMessage[]; // v2 会「预算盖过全会话」放弃
    expect(r).toHaveLength(4); // [问, 新, elision, 摘要]
    expect(s.appended).toHaveLength(1);
    const s2 = setup({ config: { thresholdTokens: 1 } });
    await def.activate(s2.ctx);
    const r2 = (await s2.listener([u("问"), a("答"), a("又答")])) as ModelMessage[]; // v2 会「尾部无 user 边界」放弃
    expect(r2).toHaveLength(3); // [问, elision, 摘要]——尾部全是 agent 工具链也照压（缺陷 A 现场）
    expect(s2.appended).toHaveLength(1);
  });

  it("⑧ 摘要输入瘦身：dropped 中超 summaryToolResultMaxChars 的工具结果截断后才进 llm（瞬态标记，不落日志）", async () => {
    const s = setup({ config: { thresholdTokens: 1, summaryToolResultMaxChars: 100 } });
    await def.activate(s.ctx);
    await s.listener([u("问"), tr("c1", 500), u("尾")]);
    const got = (s.llmRequests[0]!.messages[1] as { output: string }).output;
    expect(got.startsWith("x".repeat(100))).toBe(true);
    expect(got).toContain("[...truncated: original 500 chars]");
    expect(got.length).toBeLessThan(200);
  });

  it("⑨ 前次摘要合并（v2 前缀兜底路）：dropped[0] 为 [历史摘要] 开头（无 origin）→ system 含合并指令段；非摘要开头 → 不含", async () => {
    const prev: ModelMessage = { role: "user", content: [{ kind: "text", text: "[历史摘要]\n旧摘要" }] };
    const s = setup({ config: { thresholdTokens: 1 } });
    await def.activate(s.ctx);
    await s.listener([prev, u("问"), u("尾")]);
    expect(String(s.llmRequests[0]!.system)).toContain("前次压缩摘要");
    const s2 = setup({ config: { thresholdTokens: 1 } });
    await def.activate(s2.ctx);
    await s2.listener([u("问"), u("中"), u("尾")]);
    expect(String(s2.llmRequests[0]!.system)).not.toContain("前次压缩摘要");
  });

  it("⑩ 摘要调用参数：maxTokens = min(summaryMaxTokens, max(512, floor(窗口/4)))——窗口 65536→8192、1024→512、未知→8192", async () => {
    const run = async (opts: { contextWindow?: number }): Promise<number | undefined> => {
      const s = setup({ config: { thresholdTokens: 1 }, ...opts });
      await def.activate(s.ctx);
      await s.listener([u("问".repeat(60_000)), u("中"), u("尾")]); // 大消息确保跨过任何 ratio 阈值
      return s.llmRequests[0]!.maxTokens;
    };
    expect(await run({ contextWindow: 65_536 })).toBe(8_192);
    expect(await run({ contextWindow: 1_024 })).toBe(512);
    expect(await run({})).toBe(8_192);
  });

  it("⑪ 成功路径回归（v3 载荷）：落 turn/compaction { trigger, summary(含页脚), keepUserAt, keepUserHead, keepUserTail, droppedCount } + 返回 [用户…, elision, 摘要]；摘要输入 = 全部历史（保留用户既进摘要又留原话）", async () => {
    const s = setup({ config: { thresholdTokens: 1 } });
    await def.activate(s.ctx);
    const messages = [u("第一问"), a("第一答"), u("第二问"), a("第二答")];
    const r = (await s.listener(messages)) as ModelMessage[];
    expect(r).toHaveLength(4); // [第一问, 第二问, elision, 摘要]
    expect(firstText(r[r.length - 1])).toContain("[历史摘要]");
    expect(firstText(r[r.length - 1])).toContain("这是摘要");
    expect(s.appended).toEqual([{
      type: "turn/compaction",
      payload: {
        trigger: "auto",
        summary: expect.stringContaining("这是摘要"),
        keepUserAt: [0, 2],
        keepUserHead: 2,
        keepUserTail: 2,
        droppedCount: 4,
      },
    }]);
    expect(s.llmRequests[0]!.messages).toEqual(messages); // v3：摘要输入 = 全部历史（非 v2 的丢弃段）
  });

  it("⑫ llm 失败 → 不落事件、warn(compaction.summary-failed)、返回 undefined、退避置位", async () => {
    const s = setup({ config: { thresholdTokens: 1 }, llmChunks: [{ type: "finish", kind: "error", errorMessage: "boom" } as Chunk] });
    await def.activate(s.ctx);
    expect(await s.listener([u("问"), u("中"), u("尾")])).toBeUndefined();
    expect(s.appended).toEqual([]);
    expect(s.warns.some((w) => w.code === "compaction.summary-failed")).toBe(true);
  });

  it("⑬ 退避：失败后估算增长不足 backoffGrowthRatio → 不再尝试；增长足够 → 重试", async () => {
    const s = setup({ config: { thresholdTokens: 1 }, llmChunks: [{ type: "finish", kind: "error", errorMessage: "x" } as Chunk] });
    await def.activate(s.ctx);
    await s.listener([u("问"), u("中"), u("尾")]);                    // 失败（est≈3，failPoint=3）
    expect(await s.listener([u("问"), u("尾"), u("再")])).toBeUndefined(); // est≈3 < 3×1.05 → 退避跳过
    expect(s.llmRequests).toHaveLength(1);
    await s.listener([u("问"), u("中"), u("长".repeat(100))]);        // est>100 ≥ 3.15 → 重试（再失败）
    expect(s.llmRequests).toHaveLength(2);
  });

  it("⑭ forceOnce 旁路退避：退避活跃时 /compact 强制路径仍尝试", async () => {
    const s = setup({ config: { thresholdTokens: 1 }, llmChunks: [{ type: "finish", kind: "error", errorMessage: "x" } as Chunk] });
    await def.activate(s.ctx);
    await s.listener([u("问"), u("中"), u("尾")]);                    // 失败置退避（failPoint≈3）
    expect(await s.listener([u("问"), u("尾"), u("再")])).toBeUndefined(); // est≈3 < 3.15 → 退避中
    expect((await s.command("", stubUi))).toContain("压缩");
    await s.listener([u("问"), u("尾"), u("再")]);                    // force manual 旁路退避 → 尝试
    expect(s.llmRequests).toHaveLength(2);
  });

  it("⑮ 收敛检查：fake llm 产出超长摘要（≥512 token 且大于被压段）→ 按失败处理不装", async () => {
    const s = setup({ config: { thresholdTokens: 1 }, llmChunks: [{ type: "text/delta", text: "S".repeat(4_000) } as Chunk, { type: "finish", kind: "stop" } as Chunk] });
    await def.activate(s.ctx);
    expect(await s.listener([u("问"), u("中"), u("尾")])).toBeUndefined();
    expect(s.appended).toEqual([]);
    expect(s.warns.some((w) => w.code === "compaction.summary-failed")).toBe(true);
  });

  it("⑯ request-error 联动：code=context_limit → force overflow（trigger 落盘 overflow、用户预算减半生效）；其他 code 不置位", async () => {
    const mk = () => Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? u(`问${i}${"x".repeat(400)}`) : a(`答${i}${"x".repeat(400)}`)));
    // 10 条用户各 ~101 token：auto 总预算 20000 → 全保留（keepUserAt 10 条）；overflow 减半 10000 → 仍全保留——
    // 再压低对照：显式 userMessageTokens 让 auto 全保留、overflow 装不下
    const s = setup({ config: { thresholdTokens: 60_000, userMessageTokens: 1_100, userMessageHeadTokens: 105 } });
    await def.activate(s.ctx);
    s.errListener({ code: "context_limit" });
    const r = (await s.listener(mk())) as ModelMessage[]; // overflow：max 550、head 52 → 尾预算 498 → 尾 4 条、头 0 条
    expect(r.length).toBe(6); // [尾 4 用户, elision, 摘要]
    const ev = s.appended.find((e) => e.type === "turn/compaction")!;
    expect(ev.payload.trigger).toBe("overflow");
    expect((ev.payload as { keepUserAt: number[] }).keepUserAt).toEqual([12, 14, 16, 18]); // 最新 4 条用户（尾预算 498 ≈ 4×101）
    s.errListener({ code: "auth" });                          // 其他 code 不置位
    await s.listener(mk());
    expect(s.appended.filter((e) => e.type === "turn/compaction")).toHaveLength(1);
  });

  it("⑰ 空白产出（text 全空白）→ 失败路径（不装占位——v1 行为废止的钉子）", async () => {
    const s = setup({ config: { thresholdTokens: 1 }, llmChunks: [{ type: "text/delta", text: "   \n  " } as Chunk, { type: "finish", kind: "stop" } as Chunk] });
    await def.activate(s.ctx);
    expect(await s.listener([u("问"), u("中"), u("尾")])).toBeUndefined();
    expect(s.appended).toEqual([]);
  });

  it("⑱ 结构化指令：system 含六小节模板（含用户消息记录段）与语言跟随规则（关键句锚定防漂移）", async () => {
    const s = setup({ config: { thresholdTokens: 1 } });
    await def.activate(s.ctx);
    await s.listener([u("问"), u("中"), u("尾")]);
    const sys = String(s.llmRequests[0]!.system);
    for (const section of ["## 用户目标与约束", "## 关键决策", "## 文件与代码", "## 错误与修复", "## 用户消息记录", "## 待办与下一步"]) {
      expect(sys).toContain(section);
    }
    expect(sys).toContain("用对话本身的语言");
  });

  it("⑲ 熔断：连续 3 次自动失败（估算逐次增长满足退避、隔离熔断变量）→ 第 4 次超阈值不再调 llm", async () => {
    const s = setup({ config: { thresholdTokens: 1 }, llmChunks: [{ type: "finish", kind: "error", errorMessage: "x" } as Chunk] });
    await def.activate(s.ctx);
    await s.listener([u("问"), u("中"), u("长".repeat(50))]);      // 失败 1（est≈53）
    await s.listener([u("问"), u("中"), u("长".repeat(120))]);     // 失败 2（est≈123 ≥ 55.65）
    await s.listener([u("问"), u("中"), u("长".repeat(300))]);     // 失败 3（est≈303 ≥ 129）→ 熔断打开
    await s.listener([u("问"), u("中"), u("长".repeat(800))]);     // est≈803 ≥ 318 重试线，但熔断先行
    expect(s.llmRequests).toHaveLength(3);
    expect(s.warns.some((w) => w.code === "compaction.breaker-open")).toBe(true);
  });

  it("⑳ 熔断期间手动 /compact（forceOnce）仍尝试（人工显式意图旁路熔断）", async () => {
    const s = setup({ config: { thresholdTokens: 1 }, llmChunks: [{ type: "finish", kind: "error", errorMessage: "x" } as Chunk] });
    await def.activate(s.ctx);
    for (const n of [50, 120, 300]) await s.listener([u("问"), u("中"), u("长".repeat(n))]); // 烧满 3 败熔断
    expect(s.llmRequests).toHaveLength(3);
    await s.command("", stubUi);                                   // 手动
    await s.listener([u("问"), u("中"), u("长".repeat(400))]);
    expect(s.llmRequests).toHaveLength(4);                         // 旁路熔断仍尝试
  });

  it("㉑ 成功清零：熔断后（手动路径）成功一次 → 自动尝试恢复放行", async () => {
    const s = setup({ config: { thresholdTokens: 1 }, llmChunks: [{ type: "finish", kind: "error", errorMessage: "x" } as Chunk] });
    await def.activate(s.ctx);
    for (const n of [50, 120, 300]) await s.listener([u("问"), u("中"), u("长".repeat(n))]); // 熔断
    s.setLlmChunks([{ type: "text/delta", text: "短摘要" } as Chunk, { type: "finish", kind: "stop" } as Chunk]);
    await s.command("", stubUi);                                   // 手动重试（M4-2.5 T3 起立即执行）→ 成功 → 清零
    const r = (await s.listener([u("问"), u("中"), u("长".repeat(400))])) as ModelMessage[];
    expect(firstText(r[r.length - 1])).toContain("短摘要");
    await s.listener([u("问"), u("中"), u("长".repeat(500))]);      // 自动尝试不再被熔断挡
    expect(s.llmRequests).toHaveLength(6);                         // 3 败 + 命令即时 1 + 自动 2（T3 过账：原 5——旧命令只置 force 不调 llm）
  });
});

describe("compaction__compact 立即执行（M4-2.5 T3——压缩调研 P1+P3：结果反馈/手动全量/冷缓存回落/连击一致性）", () => {
  const bigMsgs = (): ModelMessage[] => Array.from({ length: 40 }, (_, i) => u(`m${i} ${"x".repeat(3600)}`));
  // 40 条 ≈ 36000 token：默认 thresholdTokens 60000 → 预热不触发自动；手动路径 threshold=0 必尝试

  it("① 立即执行：敲命令即返回「已压缩」与 token 数；事件已落盘（v3 manual：keepUserAt 空、零保留）", async () => {
    const s = setup();
    await def.activate(s.ctx);
    await s.listener(bigMsgs()); // 预热投影缓存（est < 60000 → 自动不触发、零事件）
    expect(s.appended).toHaveLength(0);
    const out = await s.command("", stubUi);
    expect(out).toMatch(/已压缩：前缀 \d+ 条 → 摘要（约 \d+ tokens，压前 \d+）/);
    expect(out).toContain("/summary");
    const ev = s.appended.find((e) => e.type === "turn/compaction")!;
    expect(ev.payload).toMatchObject({ trigger: "manual", keepUserAt: [], keepUserHead: 0, keepUserTail: 0, droppedCount: 40 });
    expect(s.llmRequests).toHaveLength(1); // 立即执行（不等下一条消息——修复前只返回「已安排」）
  });

  it("② 摘要正文在返回文案中", async () => {
    const s = setup();
    await def.activate(s.ctx);
    await s.listener(bigMsgs());
    expect(await s.command("", stubUi)).toContain("这是摘要");
  });

  it("③ 只落事件：miniReplay(原始, events) = [摘要] 单条（v3 manual 全量零保留，总量骤减——D20 投影自然应用）", async () => {
    const s = setup();
    await def.activate(s.ctx);
    const msgs = bigMsgs();
    await s.listener(msgs);
    await s.command("", stubUi);
    const replayed = miniReplay(msgs, s.appended);
    expect(replayed).toHaveLength(1);
    expect(firstText(replayed[0])).toContain("[历史摘要]");
  });

  it("④ 空投影（本会话还没有对话）→ 无可压缩文案、零事件", async () => {
    const s = setup();
    await def.activate(s.ctx);
    await s.listener([]); // 已预热但确无对话
    expect(await s.command("", stubUi)).toBe(""); // 静默空串
    expect(notices.some((t) => t.includes("无可压缩历史"))).toBe(true); // 提示走 notice
    expect(s.appended).toHaveLength(0);
  });

  it("⑤ manual 比自动压得更狠（v3 形态替代 v2 手动预算减半）：auto 保留预算内用户消息，manual 全量零保留", async () => {
    const auto = setup({ config: { thresholdTokens: 30_000 } }); // est 36000 > 30000 → 拦截器自动路径
    await def.activate(auto.ctx);
    const autoR = (await auto.listener(bigMsgs())) as ModelMessage[];
    expect(autoR.length).toBeGreaterThan(1); // auto：头 2 + 尾 19 用户 + elision + 摘要（userMessageTokens 20000）
    const man = setup(); // 默认阈值不触发自动 → 命令路径（manual 全量）
    await def.activate(man.ctx);
    await man.listener(bigMsgs());
    await man.command("", stubUi);
    const manEv = man.appended.find((e) => e.type === "turn/compaction")!.payload as { keepUserAt: number[]; droppedCount: number };
    expect(manEv.keepUserAt).toEqual([]); // manual：零保留
    expect(manEv.droppedCount).toBe(40);
  });

  it("⑥ 失败不落事件不装占位：llm 报错 → 「压缩失败」+ 零 turn/compaction", async () => {
    const s = setup({ llmChunks: [{ type: "finish", kind: "error", errorMessage: "boom" } as Chunk] });
    await def.activate(s.ctx);
    await s.listener(bigMsgs());
    expect(await s.command("", stubUi)).toContain("压缩失败");
    expect(s.appended.filter((e) => e.type === "turn/compaction")).toHaveLength(0);
  });

  it("⑦ resume 冷缓存回落：缓存未预热 → 「已安排」+ forceKind 置位（下一条消息发出前压缩）", async () => {
    const s = setup(); // 未 fire listener——lastSeenMessages undefined（ctx.session 无读口，模块拿不到冷投影）
    await def.activate(s.ctx);
    expect(await s.command("", stubUi)).toBe(""); // 静默空串
    expect(notices.some((t) => t.includes("已安排"))).toBe(true); // 提示走 notice
    expect(s.appended).toHaveLength(0);
    await s.listener(bigMsgs()); // force manual 消费：threshold=0 → 立即压缩
    expect(s.appended.filter((e) => e.type === "turn/compaction")).toHaveLength(1);
  });

  it("⑦b 冷投影读口在 → /compact 立即执行（M5 F5 二轮⑰ 用户拍板：「等下一条」语义废弃）", async () => {
    const s = setup({ coldProject: bigMsgs() }); // 模拟 resume 后核心宿主读口重建的投影
    await def.activate(s.ctx);
    const out = await s.command("", stubUi);
    expect(out).not.toContain("已安排");
    expect(out).toContain("已压缩");
    expect(s.llmRequests).toHaveLength(1);
    expect(s.appended.filter((e) => e.type === "turn/compaction")).toHaveLength(1);
    await s.command("", stubUi); // 连击：缓存已与已压投影对齐——不再重复压同前缀
    expect(s.appended.filter((e) => e.type === "turn/compaction").length).toBeLessThanOrEqual(2);
  });

  it("⑧ 连击缓存一致性：第二次 /compact 基于已压投影（v3 幂等——对摘要消息再压是合法的再总结，无同前缀双落）", async () => {
    const s = setup();
    await def.activate(s.ctx);
    const msgs = bigMsgs();
    await s.listener(msgs);
    await s.command("", stubUi);
    await s.command("", stubUi); // 连击：缓存必须是已压投影而非陈旧前缀
    const evAfter2 = s.appended.filter((e) => e.type === "turn/compaction");
    expect(evAfter2.length).toBeLessThanOrEqual(2);
    const rAll = miniReplay(msgs, s.appended);
    expect(firstText(rAll[0])).toContain("[历史摘要]");
    if (evAfter2.length === 2) {
      const [e1, e2] = evAfter2.map((e) => e.payload as { droppedCount: number });
      expect(e2.droppedCount).not.toBe(e1.droppedCount); // 第二次基于已压投影（防同前缀双落）
      expect(rAll).toHaveLength(1); // 两次 manual 全量重放后仍是单条摘要
    }
  });
});

describe("v3 触发分级细节（T2：页脚/预收缩/图片剥占位/前次摘要 v3 路/manual 全量）", () => {
  it("① 恢复页脚两态：有 sessionId → 「会话 <id>（~/.orosus/sessions/ 目录）」；无 → 目录指引回落（设计空白 2/3）", async () => {
    const s = setup({ config: { thresholdTokens: 1 }, sessionId: "s_test123" });
    await def.activate(s.ctx);
    await s.listener([u("问"), u("中"), u("尾")]);
    const summary = String((s.appended.find((e) => e.type === "turn/compaction")!.payload as { summary: string }).summary);
    expect(summary).toContain("会话 s_test123（~/.orosus/sessions/ 目录）");
    expect(summary).toContain("被压缩 3 条消息");
    expect(summary).toContain("不要凭猜测编造");
    const s2 = setup({ config: { thresholdTokens: 1 } });
    await def.activate(s2.ctx);
    await s2.listener([u("问"), u("中"), u("尾")]);
    const summary2 = String((s2.appended.find((e) => e.type === "turn/compaction")!.payload as { summary: string }).summary);
    expect(summary2).toContain("（历史在 ~/.orosus/sessions/ 目录）");
    expect(summary2).not.toContain("会话 s_test123");
  });

  it("② 摘要输入预收缩（设计空白 10）：窗口已知且超 (窗口−窗口/8)×0.85 → 输入只留预算内最新消息、指令带截断说明；不超不裁", async () => {
    // 窗口 2048：预算 = floor((2048−256)×0.85) = 1524；历史 3 条 ≈ 2700 token（每条 900+）超预算 → 只留最新 1 条
    const s = setup({ contextWindow: 2048, config: { thresholdRatio: 0.1 } });
    await def.activate(s.ctx);
    const msgs = [u("问".repeat(900)), u("中".repeat(900)), u("尾".repeat(900))];
    await s.listener(msgs);
    expect(s.llmRequests[0]!.messages.length).toBeLessThan(msgs.length); // 裁掉最老段
    expect(s.llmRequests[0]!.messages[s.llmRequests[0]!.messages.length - 1]).toEqual(msgs[msgs.length - 1]); // 保最新
    expect(String(s.llmRequests[0]!.system)).toContain("已截去最早期部分");
    // 对照：窗口未知 → 不预收缩
    const s2 = setup({ config: { thresholdTokens: 1 } });
    await def.activate(s2.ctx);
    await s2.listener(msgs);
    expect(s2.llmRequests[0]!.messages).toEqual(msgs);
    expect(String(s2.llmRequests[0]!.system)).not.toContain("已截去最早期部分");
  });

  it("③ 图片剥占位（设计空白 7 双写模块侧）：保留的用户消息 image part → 占位文本（路径保留）；无图消息不动", async () => {
    const s = setup({ config: { thresholdTokens: 1 } });
    await def.activate(s.ctx);
    const imgUser: ModelMessage = { role: "user", content: [
      { kind: "text", text: "看这张" },
      { kind: "image", path: "shots/x.png", mimeType: "image/png" },
    ] };
    const r = (await s.listener([imgUser, u("无图"), a("答")])) as ModelMessage[];
    expect(r[0]).toEqual({ role: "user", content: [
      { kind: "text", text: "看这张" },
      { kind: "text", text: "[image omitted during compaction: shots/x.png]" },
    ] }); // origin 不加（保留的是原消息，只剥图）
    expect(r[1]).toEqual(u("无图"));
  });

  it("④ 前次摘要合并（v3 origin 路）：dropped[0] 带 compaction-summary 标 → system 含合并指令（v2 前缀路见⑨）", async () => {
    const prev: ModelMessage = { role: "user", content: [{ kind: "text", text: "[历史摘要]\n旧摘要" }], origin: { kind: "compaction-summary" } };
    const s = setup({ config: { thresholdTokens: 1 } });
    await def.activate(s.ctx);
    await s.listener([prev, u("问"), u("尾")]);
    expect(String(s.llmRequests[0]!.system)).toContain("前次压缩摘要");
  });

  it("⑤ manual 全量零保留（拦截器 force 路径）：请求后 force overflow 置位时 trigger=overflow 落盘、auto 默认 trigger=auto（trigger 三值全覆盖）", async () => {
    const s = setup({ config: { thresholdTokens: 60_000 } });
    await def.activate(s.ctx);
    await s.listener([u("问"), a("答")]); // 不触发
    expect(s.appended).toHaveLength(0);
    const s2 = setup({ config: { thresholdTokens: 1 } });
    await def.activate(s2.ctx);
    await s2.listener([u("问"), a("答")]); // auto
    expect((s2.appended[0]!.payload as { trigger: string }).trigger).toBe("auto");
    const s3 = setup({ config: { thresholdTokens: 60_000 } });
    await def.activate(s3.ctx);
    s3.errListener({ code: "context_limit" });
    await s3.listener([u("问"), a("答")]); // overflow
    expect((s3.appended[0]!.payload as { trigger: string }).trigger).toBe("overflow");
    // manual 的 trigger 落盘见命令组①（keepUserAt 空 + trigger manual）
  });
});

describe("v3 真实用户消息谓词（T1 设计空白 1：kimi 式 origin 元数据 + v2 文本兜底）", () => {
  it("① 直投（无 origin）保留——用户直接敲的", () => {
    expect(isRealUserInput(u("hi"))).toBe(true);
  });
  it("② host steering 保留——busy 期用户插队话（kimi inTurn 同位）", () => {
    expect(isRealUserInput(su("插队", { kind: "steering", sourceModule: "host" }))).toBe(true);
  });
  it("③ 模块注入的 steering 剥离——todo 提醒等", () => {
    expect(isRealUserInput(su("记得喝水", { kind: "steering", sourceModule: "reminder" }))).toBe(false);
  });
  it("④ compaction-summary 剥离——上次的压缩摘要", () => {
    expect(isRealUserInput(su("[历史摘要]\n旧", { kind: "compaction-summary" }))).toBe(false);
  });
  it("⑤ v2 旧投影无 origin 且 [历史摘要] 前缀 → 文本兜底剥离", () => {
    expect(isRealUserInput(u("[历史摘要]\n旧摘要"))).toBe(false);
    expect(isRealUserInput(u("[历史摘要]"))).toBe(false);
  });
  it("⑥ collectRealUserMessages 下标与输入对齐：只收真实用户消息、at 为投影下标", () => {
    const msgs = [u("问1"), a("答"), su("插队", { kind: "steering", sourceModule: "host" }), su("提醒", { kind: "steering", sourceModule: "todo" }), u("问2")];
    expect(collectRealUserMessages(msgs).map((x) => x.at)).toEqual([0, 2, 4]);
  });
});

describe("v3 头尾预算选择（T1：kimi selectCompactionUserMessages 改编——整条粒度、下标集输出）", () => {
  const big = (n: number): ModelMessage => u("x".repeat(n * 4)); // 拉丁 4:1 → 整 n token
  it("① 总量不超预算 → 全保留、无 elision", () => {
    const users = [big(10), big(10), big(10)].map((m, at) => ({ at, m }));
    const sel = selectUserMessages(users, { max: 40, head: 5, totalEntries: 3 });
    expect(sel).toMatchObject({ keepUserAt: [0, 1, 2], keepUserHead: 3, keepUserTail: 3, elided: false });
  });
  it("② 超限尾部整条装填：从最新往回、装不下整条就停（不截断）", () => {
    const users = [big(10), big(10), big(10), big(10)].map((m, at) => ({ at, m }));
    const sel = selectUserMessages(users, { max: 25, head: 5, totalEntries: 5 }); // tailBudget 20 → 尾 2 条
    expect(sel.keepUserAt).toEqual([2, 3]);
    expect(sel.keepUserHead).toBe(0); // 头预算 5 < 单条 10 → 头空（末下标 −1）
    expect(sel.elided).toBe(true);
    expect(sel.omittedEntries).toBe(2); // 尾段首 2 − 头段末 (−1) − 1
  });
  it("③ 头部装填：从最老往新装 head 预算", () => {
    const users = [big(3), big(3), big(3), big(3)].map((m, at) => ({ at, m }));
    const sel = selectUserMessages(users, { max: 8, head: 4, totalEntries: 4 }); // tailBudget 4 → 尾 1 条；head 4 → 头 1 条
    expect(sel.keepUserAt).toEqual([0, 3]);
    expect(sel).toMatchObject({ keepUserHead: 1, keepUserTail: 1, elided: true, omittedEntries: 2 }); // 3 − 0 − 1
  });
  it("④ 整条粒度边界：单条超全部预算 → 不进任何段（全进摘要），省略段到投影末", () => {
    const users = [{ at: 0, m: big(100) }];
    const sel = selectUserMessages(users, { max: 50, head: 10, totalEntries: 6 });
    expect(sel.keepUserAt).toEqual([]);
    expect(sel.omittedEntries).toBe(6); // 尾空 → totalEntries − (−1) − 1
    expect(sel.elided).toBe(true);
  });
  it("⑤ 图片按 1000 token/张占位估算（estimateTokens 同口径）", () => {
    const imgUser: ModelMessage = { role: "user", content: [
      { kind: "text", text: "abcd" },
      { kind: "image", path: "a.png", mimeType: "image/png" },
      { kind: "image", path: "b.png", mimeType: "image/png" },
    ] };
    expect(estimateTokens([imgUser])).toBe(2001); // 1 + 2×1000
    const users = [{ at: 0, m: imgUser }, { at: 1, m: big(1) }];
    const sel = selectUserMessages(users, { max: 2002, head: 0, totalEntries: 2 });
    expect(sel.keepUserAt).toEqual([0, 1]); // 2001 + 1 ≤ 2002 全保留
  });
  it("⑥ 下标集升序且为投影下标（非用户序号）——隔着 assistant/tool 也不受影响", () => {
    const msgs = [u("问1"), a("答1"), u("问2"), tr("c1", 10), u("问3")];
    const users = collectRealUserMessages(msgs);
    const sel = selectUserMessages(users, { max: 999, head: 10, totalEntries: msgs.length });
    expect(sel.keepUserAt).toEqual([0, 2, 4]);
  });
});

describe("v3 配置换血（T0：退役两键、新增四键、版本 0.4.0——规格 §2）", () => {
  it("新四键默认值 + 版本号：userMessageTokens=20000 / userMessageHeadTokens=2000 / rapidRefillRounds=3 / rapidRefillLimit=3", () => {
    const cfg = configSchema.parse({});
    expect(cfg.userMessageTokens).toBe(20_000);
    expect(cfg.userMessageHeadTokens).toBe(2_000);
    expect(cfg.rapidRefillRounds).toBe(3);
    expect(cfg.rapidRefillLimit).toBe(3);
    expect(def.version).toBe("0.4.0");
  });

  it("新键阈值校验：非正整数拒绝", () => {
    expect(configSchema.safeParse({ rapidRefillRounds: 0 }).success).toBe(false);
    expect(configSchema.safeParse({ userMessageTokens: 0.5 }).success).toBe(false);
  });

  it("退役键静默剥离：keepRecentTokens/minKeepMessages 传入不报错且不出现在解析结果", () => {
    const r = configSchema.safeParse({ keepRecentTokens: 123, minKeepMessages: 5 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect("keepRecentTokens" in r.data).toBe(false);
      expect("minKeepMessages" in r.data).toBe(false);
    }
  });
});
