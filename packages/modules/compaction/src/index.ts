import { z } from "zod";
import { defineModule, type LlmPort } from "@orosus/contracts/module";
import type { ModelMessage } from "@orosus/contracts/provider";

const configSchema = z.object({
  thresholdTokens: z.number().int().positive().default(60_000).describe("回退阈值（窗口未知时的触发线）"),
  thresholdRatio: z.number().min(0.3).max(0.95).default(0.8).describe("窗口已知时的触发比"),
  keepRecentTokens: z.number().int().positive().default(16_000).describe("尾部保留预算（窗口已知时生效值 = min(本值, floor(窗口×0.25))）"),
  minKeepMessages: z.number().int().positive().default(2).describe("尾部最少保留条数（预算不足时的保底）"),
  summaryToolResultMaxChars: z.number().int().positive().default(2_000).describe("摘要输入中工具结果截断长度（瞬态，不落日志）"),
  summaryMaxTokens: z.number().int().positive().default(8_192).describe("摘要输出上限（窗口已知取 min(本值, max(512, 窗口/4))）"),
  pruneThresholdChars: z.number().int().positive().default(8_192).describe("工具结果超此长度且超 head+tail 的候选裁剪"),
  pruneHeadChars: z.number().int().positive().default(4_096),
  pruneTailChars: z.number().int().positive().default(1_024),
  backoffGrowthRatio: z.number().min(0).max(1).default(0.05).describe("失败退避：估算再增长此比例才重试"),
});

/** token 估算（启发式，只用于阈值触发，不进日志事实）：CJK 按近似 1:1，其余 4 字符/token。 */
export function estimateTokens(messages: ModelMessage[]): number {
  let tokens = 0;
  const textTokens = (s: string): number => {
    const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
    return cjk + Math.ceil(Math.max(0, s.length - cjk) / 4);
  };
  for (const m of messages) {
    for (const p of "content" in m ? m.content : []) { // toolResult 角色无 content 字段
      if (p.kind === "text") tokens += textTokens(p.text);
      else tokens += 1000; // image 粗估（M4-2.5 T5 设计空白）：阈值判定启发式，精确 vision 计费无契约面——留待真实账单校准
    }
    if (m.role === "assistant" && m.toolCalls !== undefined) {
      tokens += m.toolCalls.reduce((n, tc) => n + textTokens(JSON.stringify(tc.args ?? {})), 0);
    }
    if (m.role === "toolResult") tokens += textTokens(m.output ?? "");
  }
  return tokens;
}

const msgTokens = (m: ModelMessage): number => estimateTokens([m]);

/** 摘要指令（六小节结构化模板 + 语言跟随；cc-haha "All user messages" 段并入）。逐字为计划定案——测试 grep 锚定防漂移。 */
const SUMMARY_SYSTEM = `你是会话压缩器：把对话前缀压缩成一份交接摘要，供接续的模型继续工作。用对话本身的语言写（不要因为本指令是中文而切换语言）。
按以下小节输出，无内容的小节省略：
## 用户目标与约束
## 关键决策
## 文件与代码（精确路径、命令与结果）
## 错误与修复
## 用户消息记录（逐条，保留每条用户输入的原话要点）
## 待办与下一步
规则：逐字保留文件路径、命令、错误信息等标识符；不复述长输出（完整历史保存在会话日志中可查）；只输出摘要本身——不继续对话、不调用工具。`;

/** 前次摘要合并指令（dropped 头部为 [历史摘要] 时追加——pi 迭代更新语义）。 */
const MERGE_ADDENDUM = `

对话开头已有一份前次压缩摘要——把它视作已知背景，与其后内容合并成一份新摘要：保留仍有效的事实，纳入新的进展与决定，删除已被取代的内容；不要出现"前次摘要"这样的引用痕迹。`;

/** 摘要生成（D44）：失败/空产出/异常 → undefined（不装占位——宁可不压，pi/Reasonix 底线）。
 *  输入瘦身：工具结果超 maxToolChars 截断（瞬态标记，不落日志）；前次摘要检测 → 合并指令。 */
async function summarize(llm: LlmPort, dropped: ModelMessage[], opts: { maxTokens: number; maxToolChars: number }): Promise<string | undefined> {
  let system = SUMMARY_SYSTEM;
  const first = dropped[0];
  if (first?.role === "user" && first.content[0]?.kind === "text" && first.content[0]!.text.startsWith("[历史摘要]")) {
    system += MERGE_ADDENDUM;
  }
  const slimmed = dropped.map((m) => {
    if (m.role !== "toolResult" || m.output.length <= opts.maxToolChars) return m;
    return { ...m, output: `${m.output.slice(0, opts.maxToolChars)}\n[...truncated: original ${m.output.length} chars]` };
  });
  try {
    let text = "";
    let failed = false;
    for await (const c of llm.stream({ system, messages: slimmed, maxTokens: opts.maxTokens })) {
      if (c.type === "text/delta") text += c.text;
      if (c.type === "finish" && c.kind === "error") failed = true;
    }
    if (!failed && text.trim() !== "") return text.trim();
  } catch {
    // llm 口契约不许 reject（§6.4）——违约者防御性兜底
  }
  return undefined;
}

/** prune 变换（模块侧）。与 convert.ts 的 turn/prune 应用是同一变换的双写（铁律 2 下模块不得 import core——
 *  [历史摘要] 包装同型先例）；标记与裁剪参数逐字一致，模块测试钉两侧不漂移。 */
function applyPrunes(messages: ModelMessage[], cfg: { pruneThresholdChars: number; pruneHeadChars: number; pruneTailChars: number }): { messages: ModelMessage[]; prunes: { at: number; headChars: number; tailChars: number }[]; prunedChars: number } {
  const prunes: { at: number; headChars: number; tailChars: number }[] = [];
  let prunedChars = 0;
  const out = messages.map((m) => ({ ...m }));
  const minLen = Math.max(cfg.pruneThresholdChars, cfg.pruneHeadChars + cfg.pruneTailChars); // 选择条件下限（五轮 P2：防 threshold < head+tail 时空转）
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role !== "toolResult" || m.output.length <= minLen) continue;
    prunes.push({ at: i, headChars: cfg.pruneHeadChars, tailChars: cfg.pruneTailChars });
    prunedChars += m.output.length - (cfg.pruneHeadChars + cfg.pruneTailChars);
    m.output = `${m.output.slice(0, cfg.pruneHeadChars)}\n[...pruned: original ${m.output.length} chars...]\n${m.output.slice(-cfg.pruneTailChars)}`;
  }
  return { messages: out, prunes, prunedChars };
}

/** 预算切点（D44）：从尾部累计生效预算定保留区起点（minKeepMessages 保底），再推进到 user 边界
 *  ——assistant(toolCalls) 与其 toolResult 不拆开（孤儿防御）；切点推到末尾（cut>=len）由调用方放弃。 */
function safeCut(messages: ModelMessage[], budget: number, minKeep: number): number {
  let cut = messages.length;
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = msgTokens(messages[i]!);
    if (used + cost > budget && messages.length - cut >= minKeep) break; // 预算耗尽且已达保底
    used += cost;
    cut = i;
  }
  while (cut < messages.length && messages[cut]?.role !== "user") cut++;
  return cut;
}

type ForceKind = "manual" | "overflow";
type Cfg = z.infer<typeof configSchema>;
interface CompactionEvent { type: string; fields: Record<string, unknown> }
/** 退避/熔断/锚点共享状态（M4-2.5 T3 抽取：activate 闭包持有、compactOnce 就地更新——两路同一状态防行为漂移）。 */
interface CompactState {
  failPoint?: number | undefined;
  consecutiveFailures: number;
  anchorStale: boolean;
  seenAnchorAt?: number | undefined;
}
interface CompactLog {
  debug(code: string, msg: string, fields?: Record<string, unknown>): void;
  info(code: string, msg: string, fields?: Record<string, unknown>): void;
  warn(code: string, msg: string, fields?: Record<string, unknown>): void;
}

/** compactOnce 结果（M4-2.5 T3）：拦截器与命令两路共用——事件由调用方落盘（先落日志再改值的可重建性契约不变）。 */
type CompactResult =
  | { kind: "none"; events: [] }                                            // 未达阈值（自动路径常态）
  | { kind: "pruned"; messages: ModelMessage[]; events: CompactionEvent[] } // prune 免摘要救援
  | { kind: "skipped"; reason: "backoff" | "breaker" | "no-space"; messages?: ModelMessage[] | undefined; events: CompactionEvent[] }
  | { kind: "failed"; reason: string; events: CompactionEvent[] }           // 摘要失败/收敛不过（不装占位）
  | { kind: "compacted"; newMessages: ModelMessage[]; events: CompactionEvent[]; stats: { dropped: number; kept: number; tokensBefore: number; summaryTokens: number; summary: string } };

/** 压缩核心（M4-2.5 T3 从拦截器体抽出）：阈值判定 → prune 前置 → 退避/熔断 → 预算切点 → 摘要 → 收敛检查。
 *  纯形状（messages → 结果 + 事件清单）；退避/熔断/锚点状态经 opts.state 由调用方持有（两路共享一份）。 */
async function compactOnce(
  messages: ModelMessage[],
  cfg: Cfg,
  opts: {
    llm: LlmPort; window?: number | undefined; force: ForceKind | undefined;
    estimate: (m: ModelMessage[]) => number; state: CompactState; log: CompactLog;
  },
): Promise<CompactResult> {
  const threshold = opts.force !== undefined ? 0 : (opts.window !== undefined ? Math.floor(opts.window * cfg.thresholdRatio) : cfg.thresholdTokens);
  let est = opts.estimate(messages);
  if (est <= threshold) return { kind: "none", events: [] };
  const events: CompactionEvent[] = [];

  // ② prune 前置（免 LLM 的第一段，dsh/Reasonix 同型）：退避/熔断不禁 prune（确定性、零成本）
  const { messages: pruned, prunes, prunedChars } = applyPrunes(messages, cfg);
  const rewrote = prunes.length > 0;
  if (rewrote) {
    events.push({ type: "turn/prune", fields: { prunes, prunedChars } }); // 先落日志再改值（可重建性契约）——事件由调用方 append
    opts.state.anchorStale = true; // prune 缩内容不减条数——长度判据测不出，锚点须显式置 stale（二轮 P1）
    est = opts.estimate(pruned);
    if (est <= threshold) {
      opts.log.info("compaction.prune-applied", "超长工具结果已裁剪（免摘要救援）", { pruned: prunes.length, savedChars: prunedChars });
      return { kind: "pruned", messages: pruned, events };
    }
  }
  const afterPrune = (): ModelMessage[] | undefined => (rewrote ? pruned : undefined);

  // ③ 退避/熔断（空白 §7/§11）：退避管短期节奏（force 旁路）；熔断管链路坏了别再烧（手动旁路、溢出受约束）
  if (opts.force !== "manual" && opts.state.consecutiveFailures >= 3) {
    opts.log.warn("compaction.breaker-open", "连续 3 次压缩失败——自动尝试停手等人工（/compact 可手动重试）", { failures: opts.state.consecutiveFailures });
    return { kind: "skipped", reason: "breaker", messages: afterPrune(), events };
  }
  if (opts.force === undefined && opts.state.failPoint !== undefined && est < opts.state.failPoint * (1 + cfg.backoffGrowthRatio)) {
    opts.log.debug("compaction.skipped-backoff", "退避中——估算增长不足不重试", { est, failPoint: opts.state.failPoint });
    return { kind: "skipped", reason: "backoff", messages: afterPrune(), events };
  }

  // ④ 预算切点：溢出 force 收缩至 minKeepMessages（dsh retainTokens=0 同型）；窗口已知时预算封顶 25%（空白 §16）；
  //    手动 /compact 预算减半（M4-2.5 T3/P3——Reasonix 手动 force 减半同款：用户主动要压，尾部保更少）
  const autoBudget = opts.window !== undefined ? Math.min(cfg.keepRecentTokens, Math.floor(opts.window * 0.25)) : cfg.keepRecentTokens;
  const budget = opts.force === "overflow" ? 0 : opts.force === "manual" ? Math.floor(autoBudget / 2) : autoBudget;
  const cut = safeCut(pruned, budget, cfg.minKeepMessages);
  if (cut <= 0 || cut >= pruned.length) return { kind: "skipped", reason: "no-space", messages: afterPrune(), events }; // 无压缩空间；越界防御（首轮 P1）

  const dropped = pruned.slice(0, cut);
  const kept = pruned.slice(cut);
  const maxTokens = opts.window !== undefined ? Math.min(cfg.summaryMaxTokens, Math.max(512, Math.floor(opts.window / 4))) : cfg.summaryMaxTokens;
  const summary = await summarize(opts.llm, dropped, { maxTokens, maxToolChars: cfg.summaryToolResultMaxChars });

  // ⑤ 收敛检查（dsh 同款 + 512 显著性门槛）：压后必须更小——但玩具尺寸对话（[历史摘要] 包装 ≈9 token）
  // 天然不满足"严格变小"，只对非平凡大摘要（≥512 token，与 maxTokens 公式的 512 下限同源）执行；
  // 超长跑飞摘要照抓。执行期修正（计划⑪与⑮的夹具张力），T8 文档登记
  const summaryMsg: ModelMessage = { role: "user", content: [{ kind: "text", text: `[历史摘要]\n${summary ?? ""}` }] };
  const summaryCost = estimateTokens([summaryMsg]);
  if (summary === undefined || (summaryCost >= estimateTokens(dropped) && summaryCost >= 512)) {
    opts.state.consecutiveFailures++;
    opts.state.failPoint = est;
    opts.log.warn("compaction.summary-failed", summary === undefined ? "摘要生成失败——不装占位（宁可不压）" : "收敛检查不过（压后未变小）——不装", { dropped: dropped.length });
    return { kind: "failed", reason: summary === undefined ? "摘要生成失败（不装占位）" : "收敛检查不过（压后未变小）", events };
  }

  opts.state.consecutiveFailures = 0; // 任一成功清零（熔断与退避同释）
  opts.state.failPoint = undefined;
  opts.state.anchorStale = true; // 压缩改写上下文 → 锚点 stale
  events.push({ type: "turn/compaction", fields: { summary, keepFrom: cut, droppedCount: dropped.length } });
  opts.log.info("compaction.applied", "已压缩", { dropped: dropped.length, kept: kept.length });
  return { kind: "compacted", newMessages: [summaryMsg, ...kept], events, stats: { dropped: dropped.length, kept: kept.length, tokensBefore: est, summaryTokens: summaryCost, summary } };
}

export default defineModule({
  name: "compaction",
  version: "0.3.0",
  description: "会话压缩——transformContext 消费方：锚定估算/窗口感知阈值/prune 前置/预算切点/结构化摘要/失败不装+退避+熔断/溢出联动（M3 补强 D44）；/compact 立即执行+结果反馈+手动预算减半（M4-2.5 T3——compactOnce 两路共用、投影缓存零契约）",
  api: 1,
  mounts: ["hook:agent/transform-context", "hook:agent/request-error", "contribute:command"],
  config: configSchema,
  logEvents: ["turn/compaction", "turn/prune"], // 模块可写核心日志类型（owner 制例外两枚）
  activate(ctx) {
    const state: CompactState = { consecutiveFailures: 0, anchorStale: false }; // 退避/熔断/锚点（两路共享）
    let forceKind: ForceKind | undefined; // /compact（manual）与溢出触发（overflow）：旁路退避；manual 另旁路熔断
    const cfg = ctx.config as Cfg;

    const estimate = (messages: ModelMessage[]): number => {
      const a = ctx.llm.lastUsage;
      if (a === undefined || a.totalTokens <= 0) return estimateTokens(messages);
      const lengthOk = messages.length >= a.atMessageCount + 1;
      if (a.atMessageCount !== state.seenAnchorAt && lengthOk) state.anchorStale = false; // 新锚点到达且长度判据满足 → 清 stale
      state.seenAnchorAt = a.atMessageCount;
      if (!state.anchorStale && lengthOk) return a.totalTokens + estimateTokens(messages.slice(a.atMessageCount + 1));
      return estimateTokens(messages); // stale / 长度判据不过（压缩后变短） → 纯估算
    };

    // 投影缓存（M4-2.5 T3）：transform-context 每轮刷新、且跟踪变换后结果（缓存一致性——自动压缩后缓存不得
    // 停留压缩前投影，否则后续 /compact 拿陈旧前缀再压、同前缀双落事件致投影错乱）。
    let lastSeenMessages: ModelMessage[] | undefined;

    ctx.events.on("agent/transform-context", async (value) => {
      const messages = value as ModelMessage[];
      const force = forceKind;
      forceKind = undefined; // 消费即复位（手动一次、溢出一次）
      const r = await compactOnce(messages, cfg, { llm: ctx.llm, window: ctx.llm.contextWindow, force, estimate, state, log: ctx.log });
      for (const e of r.events) ctx.session.append(e.type, e.fields);
      const out = r.kind === "compacted" ? r.newMessages : (r.kind === "pruned" || r.kind === "skipped") ? r.messages : undefined;
      lastSeenMessages = out ?? messages; // 缓存跟踪变换后结果（v1.4 审修补）
      return out;
    });

    ctx.events.on("agent/request-error", (p) => {
      if ((p as { code?: string })?.code === "context_limit") forceKind = "overflow";
    });

    ctx.contribute.command("compaction__compact", async () => {
      if (lastSeenMessages === undefined) {
        // 冷投影重建（M5 F5 二轮⑰ 用户拍板：/compact 必须立即执行，「等下一条」语义废弃）——
        // ctx.session.messages 读口（契约扩展，与 agentLoop 同投影）；宿主无读口才回落旧延期语义
        const projected = await ctx.session.messages?.();
        if (projected === undefined) {
          forceKind = "manual";
          return "已安排：下一条消息发出前压缩（宿主无投影读口——发一条消息预热投影，之后 /compact 即时执行）";
        }
        lastSeenMessages = projected;
      }
      if (lastSeenMessages.length === 0) return "无可压缩历史（本会话还没有对话）";
      const r = await compactOnce(lastSeenMessages, cfg, { llm: ctx.llm, window: ctx.llm.contextWindow, force: "manual", estimate, state, log: ctx.log });
      for (const e of r.events) ctx.session.append(e.type, e.fields); // 只落事件——下一次请求的投影自然应用（D20）
      switch (r.kind) {
        case "none": return "无可压缩历史（本会话还没有对话）";
        case "pruned":
          lastSeenMessages = r.messages;
          return `已裁剪 ${(r.events[0]!.fields.prunes as unknown[]).length} 个超长工具结果（免摘要救援）——体积已降，未做摘要压缩`;
        case "skipped":
          return r.reason === "no-space"
            ? "无可压缩空间：对话尚短，尾部保留区已覆盖全部内容"
            : `已跳过：${r.reason === "backoff" ? "退避中（估算增长不足）" : "连续失败熔断保护"}`;
        case "failed":
          return `压缩失败：${r.reason}——未产生任何变更（可重试 /compact）`;
        case "compacted":
          lastSeenMessages = r.newMessages; // 缓存与已落事件对齐——防连击拿陈旧前缀双落事件（机制要点 1）
          return `已压缩：前缀 ${r.stats.dropped} 条 → 摘要（约 ${r.stats.summaryTokens} tokens，压前 ${r.stats.tokensBefore}）\n\n${r.stats.summary}\n\n（保留尾部 ${r.stats.kept} 条原文——/summary 随时可看本摘要）`;
      }
    });
  },
});
