import { describe, it, expect } from "vitest";
import type { CommandHandler, CommandUi, LlmPort, Listener } from "@orosus/contracts/module";
import type { Chunk, ModelMessage } from "@orosus/contracts/provider";
import def, { estimateTokens } from "./index.ts";

type Ctx = Parameters<NonNullable<typeof def.activate>>[0];

const u = (t: string): ModelMessage => ({ role: "user", content: [{ kind: "text", text: t }] });
const a = (t: string): ModelMessage => ({ role: "assistant", content: t === "" ? [] : [{ kind: "text", text: t }] });
const tr = (id: string, chars: number): ModelMessage => ({ role: "toolResult", callId: id, output: "x".repeat(chars), isError: false });

const stubUi: CommandUi = { ask: async () => "", askSecret: async () => "", choose: async (_t, items) => items[0]!, confirm: async () => true };

// schema 全默认值的手写镜像（fake ctx 不经 zod default 管线——kernel 真链路才有）
const DEFAULTS = {
  thresholdTokens: 60_000, thresholdRatio: 0.8, keepRecentTokens: 16_000, minKeepMessages: 2,
  summaryToolResultMaxChars: 2_000, summaryMaxTokens: 8_192,
  pruneThresholdChars: 8_192, pruneHeadChars: 4_096, pruneTailChars: 1_024, backoffGrowthRatio: 0.05,
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

function setup(opts: { config?: Record<string, unknown>; llmChunks?: Chunk[]; contextWindow?: number; coldProject?: ModelMessage[] } = {}): Setup {
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
      // F5 二轮⑰ 读口夹具：coldProject 提供时模拟核心宿主的投影读口
      ...(opts.coldProject !== undefined ? { messages: async () => opts.coldProject! } : {}),
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

/** 迷你重放（镜像 convert.ts 的 turn/prune + turn/compaction 应用语义）——用例⑤钉"模块侧返回值 = 核心侧重放"双写一致。 */
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
      out = [{ role: "user", content: [{ kind: "text", text: `[历史摘要]\n${String(e.payload.summary)}` }] }, ...out.slice(Number(e.payload.keepFrom))];
    }
  }
  return out;
};

const firstText = (m: unknown): string => String((m as { content: { text: string }[] }).content[0]!.text);

describe("compaction 模块（M3 补强 T6/D44：锚定/窗口/prune 前置/预算切点/失败不装+退避+熔断）", () => {
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
    const s = setup({ config: { thresholdTokens: 990, keepRecentTokens: 1 } });
    s.llm.lastUsage = { totalTokens: 1000, atMessageCount: 1 }; // 新鲜锚点
    await def.activate(s.ctx);
    const msgs = [u("一"), a("答一"), u("二"), a("答二"), u("三"), a("答三"), u("四"), a("答四")];
    const r1 = (await s.listener(msgs)) as ModelMessage[];  // 锚定 1000+ > 990 触发；纯估算 < 990 不触发
    expect(s.llmRequests).toHaveLength(1);
    expect(r1).toHaveLength(3); // 摘要 + 保留 2（尾部 u四+a四，预算 1 由 minKeep 保底）
    expect(await s.listener(r1)).toBeUndefined();          // stale：压缩改写后纯估算 → 不再触发
    expect(s.llmRequests).toHaveLength(1);
    s.llm.lastUsage = { totalTokens: 2000, atMessageCount: 2 }; // 新锚点（at 变化）且长度判据满足 → 恢复锚定
    const r3 = (await s.listener(r1)) as ModelMessage[];
    expect(s.llmRequests).toHaveLength(2);
    expect(r3).toHaveLength(3);
  });

  it("③ 窗口感知：contextWindow 已知时阈值 = floor(窗口×ratio)；未知回退 thresholdTokens", async () => {
    const s = setup({ contextWindow: 1024 }); // 阈值 819；预算封顶 min(16000, 256)
    await def.activate(s.ctx);
    const msgs = [u("字".repeat(900)), a("答"), u("再问")];
    const r = (await s.listener(msgs)) as ModelMessage[]; // est 903 > 819 触发
    expect(r).toHaveLength(2);
    expect(s.appended.some((e) => e.type === "turn/compaction")).toBe(true);
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

  it("⑤ prune 后仍超 → 摘要路径：keepFrom 锚定在裁剪后投影（本地迷你重放与 reduce 返回值字节一致——双写钉子）", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 } });
    await def.activate(s.ctx);
    const msgs = [u("问"), a(""), tr("c1", 20_000), u("尾")];
    const r = (await s.listener(msgs)) as ModelMessage[];
    expect(s.appended.map((e) => e.type)).toEqual(["turn/prune", "turn/compaction"]);
    expect(JSON.stringify(miniReplay(msgs, s.appended))).toBe(JSON.stringify(r));
  });

  it("⑥ 预算切点：窗口封顶 min(keepRecentTokens, floor(窗口×0.25))——8k 窗口封顶 2048 可压缩；不封顶则预算盖过全会话 cut=0 永不压缩（五轮 P1）", async () => {
    const mk = () => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (i % 2 === 0 ? u("问".repeat(1000)) : a("答".repeat(1000))));
    const s = setup({ contextWindow: 8192 }); // 阈值 6553；封顶预算 2048
    await def.activate(s.ctx);
    const r = (await s.listener(mk())) as ModelMessage[]; // est 8000 > 6553 触发
    expect(r).toHaveLength(3); // 摘要 + 保留 2（2000 ≤ 2048，加第三条 3000 > 2048 止）
    expect(s.appended[0]!.payload).toMatchObject({ keepFrom: 6, droppedCount: 6 });
    const s2 = setup({ config: { thresholdTokens: 6_000 } }); // 窗口未知：预算 16000 盖过 est 8000
    await def.activate(s2.ctx);
    expect(await s2.listener(mk())).toBeUndefined(); // cut=0 放弃——正是封顶要修的场景
    expect(s2.appended).toEqual([]);
  });

  it("⑦ 越界防御回归（原越界三例并例）：预算盖过全会话放弃 / 尾部无 user 边界放弃 / 有边界对照正常压缩", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1_000_000 } });
    await def.activate(s.ctx);
    expect(await s.listener([u("问"), a("答"), u("新")])).toBeUndefined();
    expect(s.appended).toEqual([]);
    const s2 = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 } });
    await def.activate(s2.ctx);
    expect(await s.listener([u("问"), a("答"), a("又答")])).toBeUndefined(); // 切点推进到末尾=全删 → 放弃
    expect(s2.appended).toEqual([]);
    const s3 = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 } });
    await def.activate(s3.ctx);
    const r = (await s3.listener([u("问"), a("答"), u("新")])) as ModelMessage[];
    expect(r).toHaveLength(2);
    expect(s3.appended).toHaveLength(1);
  });

  it("⑧ 摘要输入瘦身：dropped 中超 summaryToolResultMaxChars 的工具结果截断后才进 llm（瞬态标记，不落日志）", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1, summaryToolResultMaxChars: 100 } });
    await def.activate(s.ctx);
    await s.listener([u("问"), tr("c1", 500), u("尾")]);
    const got = (s.llmRequests[0]!.messages[1] as { output: string }).output;
    expect(got.startsWith("x".repeat(100))).toBe(true);
    expect(got).toContain("[...truncated: original 500 chars]");
    expect(got.length).toBeLessThan(200);
  });

  it("⑨ 前次摘要合并：dropped[0] 为 [历史摘要] 开头 → system 含合并指令段；非摘要开头 → 不含", async () => {
    const prev: ModelMessage = { role: "user", content: [{ kind: "text", text: "[历史摘要]\n旧摘要" }] };
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 } });
    await def.activate(s.ctx);
    await s.listener([prev, u("问"), u("尾")]);
    expect(String(s.llmRequests[0]!.system)).toContain("前次压缩摘要");
    const s2 = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 } });
    await def.activate(s2.ctx);
    await s2.listener([u("问"), u("中"), u("尾")]);
    expect(String(s2.llmRequests[0]!.system)).not.toContain("前次压缩摘要");
  });

  it("⑩ 摘要调用参数：maxTokens = min(summaryMaxTokens, max(512, floor(窗口/4)))——窗口 65536→8192、1024→512、未知→8192", async () => {
    const run = async (opts: { contextWindow?: number }): Promise<number | undefined> => {
      const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 }, ...opts });
      await def.activate(s.ctx);
      await s.listener([u("问".repeat(60_000)), u("中"), u("尾")]); // 大消息确保跨过任何 ratio 阈值
      return s.llmRequests[0]!.maxTokens;
    };
    expect(await run({ contextWindow: 65_536 })).toBe(8_192);
    expect(await run({ contextWindow: 1_024 })).toBe(512);
    expect(await run({})).toBe(8_192);
  });

  it("⑪ 成功路径回归：落 turn/compaction {summary, keepFrom, droppedCount} + 返回 [摘要消息, ...kept]；摘要只喂丢弃段", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 } });
    await def.activate(s.ctx);
    const messages = [u("第一问"), a("第一答"), u("第二问"), a("第二答")];
    const r = (await s.listener(messages)) as ModelMessage[];
    expect(r).toHaveLength(3);
    expect((r[0] as { role: string }).role).toBe("user");
    expect(firstText(r[0])).toContain("[历史摘要]");
    expect(firstText(r[0])).toContain("这是摘要");
    expect(r.slice(1)).toEqual(messages.slice(2));
    expect(s.appended).toEqual([{ type: "turn/compaction", payload: { summary: "这是摘要", keepFrom: 2, droppedCount: 2 } }]);
    expect(s.llmRequests[0]!.messages).toEqual(messages.slice(0, 2));
  });

  it("⑫ llm 失败 → 不落事件、warn(compaction.summary-failed)、返回 undefined、退避置位", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 }, llmChunks: [{ type: "finish", kind: "error", errorMessage: "boom" } as Chunk] });
    await def.activate(s.ctx);
    expect(await s.listener([u("问"), u("中"), u("尾")])).toBeUndefined();
    expect(s.appended).toEqual([]);
    expect(s.warns.some((w) => w.code === "compaction.summary-failed")).toBe(true);
  });

  it("⑬ 退避：失败后估算增长不足 backoffGrowthRatio → 不再尝试；增长足够 → 重试", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 }, llmChunks: [{ type: "finish", kind: "error", errorMessage: "x" } as Chunk] });
    await def.activate(s.ctx);
    await s.listener([u("问"), u("中"), u("尾")]);                    // 失败（est≈3，failPoint=3）
    expect(await s.listener([u("问"), u("尾"), u("再")])).toBeUndefined(); // est≈3 < 3×1.05 → 退避跳过（判定先于切点）
    expect(s.llmRequests).toHaveLength(1);
    await s.listener([u("问"), u("中"), u("长".repeat(100))]);        // est>100 ≥ 3.15 → 重试（再失败）
    expect(s.llmRequests).toHaveLength(2);
  });

  it("⑭ forceOnce 旁路退避：退避活跃时 /compact 强制路径仍尝试", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 }, llmChunks: [{ type: "finish", kind: "error", errorMessage: "x" } as Chunk] });
    await def.activate(s.ctx);
    await s.listener([u("问"), u("中"), u("尾")]);                    // 失败置退避（failPoint≈3）
    expect(await s.listener([u("问"), u("尾"), u("再")])).toBeUndefined(); // est≈3 < 3.15 → 退避中
    expect((await s.command("", stubUi))).toContain("压缩");
    await s.listener([u("问"), u("尾"), u("再")]);                    // force manual 旁路退避 → 尝试
    expect(s.llmRequests).toHaveLength(2);
  });

  it("⑮ 收敛检查：fake llm 产出超长摘要（≥512 token 且大于被压段）→ 按失败处理不装", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 }, llmChunks: [{ type: "text/delta", text: "S".repeat(4_000) } as Chunk, { type: "finish", kind: "stop" } as Chunk] });
    await def.activate(s.ctx);
    expect(await s.listener([u("问"), u("中"), u("尾")])).toBeUndefined();
    expect(s.appended).toEqual([]);
    expect(s.warns.some((w) => w.code === "compaction.summary-failed")).toBe(true);
  });

  it("⑯ request-error 联动：code=context_limit → force overflow（阈值 0 + 保留区收缩至 minKeepMessages）；其他 code 不置位", async () => {
    const s = setup({ config: { thresholdTokens: 60_000 } }); // 常规永不触发
    await def.activate(s.ctx);
    s.errListener({ code: "context_limit" });
    const msgs = [u("问"), a("答"), u("再"), a("再答")];
    const r = (await s.listener(msgs)) as ModelMessage[];     // force overflow 触发；预算 0 → 只保 2 条
    expect(r).toHaveLength(3);
    expect(s.appended.filter((e) => e.type === "turn/compaction")).toHaveLength(1);
    s.errListener({ code: "auth" });                          // 其他 code 不置位
    await s.listener(msgs);
    expect(s.appended.filter((e) => e.type === "turn/compaction")).toHaveLength(1);
  });

  it("⑰ 空白产出（text 全空白）→ 失败路径（不装占位——v1 行为废止的钉子）", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 }, llmChunks: [{ type: "text/delta", text: "   \n  " } as Chunk, { type: "finish", kind: "stop" } as Chunk] });
    await def.activate(s.ctx);
    expect(await s.listener([u("问"), u("中"), u("尾")])).toBeUndefined();
    expect(s.appended).toEqual([]);
  });

  it("⑱ 结构化指令：system 含六小节模板（含用户消息记录段）与语言跟随规则（关键句锚定防漂移）", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 } });
    await def.activate(s.ctx);
    await s.listener([u("问"), u("中"), u("尾")]);
    const sys = String(s.llmRequests[0]!.system);
    for (const section of ["## 用户目标与约束", "## 关键决策", "## 文件与代码", "## 错误与修复", "## 用户消息记录", "## 待办与下一步"]) {
      expect(sys).toContain(section);
    }
    expect(sys).toContain("用对话本身的语言");
  });

  it("⑲ 熔断：连续 3 次自动失败（估算逐次增长满足退避、隔离熔断变量）→ 第 4 次超阈值不再调 llm", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 }, llmChunks: [{ type: "finish", kind: "error", errorMessage: "x" } as Chunk] });
    await def.activate(s.ctx);
    await s.listener([u("问"), u("中"), u("长".repeat(50))]);      // 失败 1（est≈53）
    await s.listener([u("问"), u("中"), u("长".repeat(120))]);     // 失败 2（est≈123 ≥ 55.65）
    await s.listener([u("问"), u("中"), u("长".repeat(300))]);     // 失败 3（est≈303 ≥ 129）→ 熔断打开
    await s.listener([u("问"), u("中"), u("长".repeat(800))]);     // est≈803 ≥ 318 重试线，但熔断先行
    expect(s.llmRequests).toHaveLength(3);
    expect(s.warns.some((w) => w.code === "compaction.breaker-open")).toBe(true);
  });

  it("⑳ 熔断期间手动 /compact（forceOnce）仍尝试（人工显式意图旁路熔断）", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 }, llmChunks: [{ type: "finish", kind: "error", errorMessage: "x" } as Chunk] });
    await def.activate(s.ctx);
    for (const n of [50, 120, 300]) await s.listener([u("问"), u("中"), u("长".repeat(n))]); // 烧满 3 败熔断
    expect(s.llmRequests).toHaveLength(3);
    await s.command("", stubUi);                                   // 手动
    await s.listener([u("问"), u("中"), u("长".repeat(400))]);
    expect(s.llmRequests).toHaveLength(4);                         // 旁路熔断仍尝试
  });

  it("㉑ 成功清零：熔断后（手动路径）成功一次 → 自动尝试恢复放行", async () => {
    const s = setup({ config: { thresholdTokens: 1, keepRecentTokens: 1 }, llmChunks: [{ type: "finish", kind: "error", errorMessage: "x" } as Chunk] });
    await def.activate(s.ctx);
    for (const n of [50, 120, 300]) await s.listener([u("问"), u("中"), u("长".repeat(n))]); // 熔断
    s.setLlmChunks([{ type: "text/delta", text: "短摘要" } as Chunk, { type: "finish", kind: "stop" } as Chunk]);
    await s.command("", stubUi);                                   // 手动重试（M4-2.5 T3 起立即执行）→ 成功 → 清零
    const r = (await s.listener([u("问"), u("中"), u("长".repeat(400))])) as ModelMessage[];
    expect(firstText(r[0])).toContain("短摘要");
    await s.listener([u("问"), u("中"), u("长".repeat(500))]);      // 自动尝试不再被熔断挡
    expect(s.llmRequests).toHaveLength(6);                         // 3 败 + 命令即时 1 + 自动 2（T3 过账：原 5——旧命令只置 force 不调 llm）
  });
});

describe("compaction__compact 立即执行（M4-2.5 T3——压缩调研 P1+P3：结果反馈/手动减半/冷缓存回落/连击一致性）", () => {
  const bigMsgs = (): ModelMessage[] => Array.from({ length: 40 }, (_, i) => u(`m${i} ${"x".repeat(3600)}`));
  // 40 条 ≈ 36000 token：默认 thresholdTokens 60000 → 预热不触发自动；手动路径 threshold=0 必尝试

  it("① 立即执行：敲命令即返回「已压缩」与 token 数；事件已落盘", async () => {
    const s = setup();
    await def.activate(s.ctx);
    await s.listener(bigMsgs()); // 预热投影缓存（est < 60000 → 自动不触发、零事件）
    expect(s.appended).toHaveLength(0);
    const out = await s.command("", stubUi);
    expect(out).toMatch(/已压缩：前缀 \d+ 条 → 摘要（约 \d+ tokens，压前 \d+）/);
    expect(out).toContain("/summary");
    expect(s.appended.filter((e) => e.type === "turn/compaction")).toHaveLength(1);
    expect(s.llmRequests).toHaveLength(1); // 立即执行（不等下一条消息——修复前只返回「已安排」）
  });

  it("② 摘要正文在返回文案中", async () => {
    const s = setup();
    await def.activate(s.ctx);
    await s.listener(bigMsgs());
    expect(await s.command("", stubUi)).toContain("这是摘要");
  });

  it("③ 只落事件：miniReplay(原始, events) 首条 = [历史摘要]、总量骤减（D20 投影自然应用）", async () => {
    const s = setup();
    await def.activate(s.ctx);
    const msgs = bigMsgs();
    await s.listener(msgs);
    await s.command("", stubUi);
    const replayed = miniReplay(msgs, s.appended);
    expect(firstText(replayed[0])).toContain("[历史摘要]");
    expect(replayed.length).toBeLessThan(msgs.length);
  });

  it("④ 空投影（本会话还没有对话）→ 无可压缩文案、零事件", async () => {
    const s = setup();
    await def.activate(s.ctx);
    await s.listener([]); // 已预热但确无对话
    expect(await s.command("", stubUi)).toContain("无可压缩历史");
    expect(s.appended).toHaveLength(0);
  });

  it("⑤ 手动预算减半：同消息同配置，手动 keepFrom > 自动（尾部保更少）", async () => {
    const auto = setup({ config: { thresholdTokens: 30_000 } }); // est 36000 > 30000 → 拦截器自动路径（预算 16000）
    await def.activate(auto.ctx);
    await auto.listener(bigMsgs());
    const autoKf = (auto.appended.find((e) => e.type === "turn/compaction")!.payload as { keepFrom: number }).keepFrom;
    const man = setup(); // 默认阈值不触发自动 → 命令路径（预算 16000/2）
    await def.activate(man.ctx);
    await man.listener(bigMsgs());
    await man.command("", stubUi);
    const manKf = (man.appended.find((e) => e.type === "turn/compaction")!.payload as { keepFrom: number }).keepFrom;
    expect(manKf).toBeGreaterThan(autoKf);
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
    expect(await s.command("", stubUi)).toContain("已安排");
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

  it("⑧ 连击缓存一致性：第二次 /compact 基于已压投影——无同前缀重复事件、锚定不漂移", async () => {
    const s = setup();
    await def.activate(s.ctx);
    const msgs = bigMsgs();
    await s.listener(msgs);
    await s.command("", stubUi);
    const evAfter1 = s.appended.filter((e) => e.type === "turn/compaction");
    await s.command("", stubUi); // 连击：两次命令间无新请求——缓存必须是已压投影而非陈旧前缀
    const evAfter2 = s.appended.filter((e) => e.type === "turn/compaction");
    expect(evAfter2.length).toBeLessThanOrEqual(2);
    const rAll = miniReplay(msgs, s.appended);
    expect(firstText(rAll[0])).toContain("[历史摘要]");
    if (evAfter2.length === 2) {
      const [e1, e2] = evAfter2.map((e) => e.payload as { keepFrom: number });
      expect(e2.keepFrom).not.toBe(e1.keepFrom); // 第二次锚定在已压投影（防同前缀双落）
      expect(rAll.length).toBeLessThan(miniReplay(msgs, evAfter1).length); // 连击后总量更少（进一步压缩合法）
    }
  });
});
