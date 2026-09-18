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

export default defineModule({
  name: "compaction",
  version: "0.2.0",
  description: "会话压缩——transformContext 消费方：锚定估算/窗口感知阈值/prune 前置/预算切点/结构化摘要/失败不装+退避+熔断/溢出联动（M3 补强 D44）",
  api: 1,
  mounts: ["hook:agent/transform-context", "hook:agent/request-error", "contribute:command"],
  config: configSchema,
  logEvents: ["turn/compaction", "turn/prune"], // 模块可写核心日志类型（owner 制例外两枚）
  activate(ctx) {
    let forceKind: ForceKind | undefined; // /compact（manual）与溢出触发（overflow）：旁路退避；manual 另旁路熔断
    let failPoint: number | undefined;    // 退避点：失败时的估算值——再增长 backoffGrowthRatio 才重试
    let consecutiveFailures = 0;          // 熔断计数（非手动路径失败累计，任一成功清零——cc-haha 同款，硬编码 3）
    let anchorStale = false;              // 锚点 stale（空白 §4 三态）：本模块改写上下文后置位
    let seenAnchorAt: number | undefined; // 观察到的最近锚点 atMessageCount——变化即新锚点

    const estimate = (messages: ModelMessage[]): number => {
      const a = ctx.llm.lastUsage;
      if (a === undefined || a.totalTokens <= 0) return estimateTokens(messages);
      const lengthOk = messages.length >= a.atMessageCount + 1;
      if (a.atMessageCount !== seenAnchorAt && lengthOk) anchorStale = false; // 新锚点到达且长度判据满足 → 清 stale
      seenAnchorAt = a.atMessageCount;
      if (!anchorStale && lengthOk) return a.totalTokens + estimateTokens(messages.slice(a.atMessageCount + 1));
      return estimateTokens(messages); // stale / 长度判据不过（压缩后变短） → 纯估算
    };

    ctx.events.on("agent/transform-context", async (value) => {
      const messages = value as ModelMessage[];
      const cfg = ctx.config as z.infer<typeof configSchema>;
      const force = forceKind;
      forceKind = undefined; // 消费即复位（手动一次、溢出一次）
      const window = ctx.llm.contextWindow;
      const threshold = force !== undefined ? 0 : (window !== undefined ? Math.floor(window * cfg.thresholdRatio) : cfg.thresholdTokens);
      let est = estimate(messages);
      if (est <= threshold) return undefined;

      // ② prune 前置（免 LLM 的第一段，dsh/Reasonix 同型）：退避/熔断不禁 prune（确定性、零成本）
      const { messages: pruned, prunes, prunedChars } = applyPrunes(messages, cfg);
      const rewrote = prunes.length > 0;
      if (rewrote) {
        ctx.session.append("turn/prune", { prunes, prunedChars }); // 先落日志再改值（可重建性契约）
        anchorStale = true; // prune 缩内容不减条数——长度判据测不出，锚点须显式置 stale（二轮 P1）
        est = estimate(pruned);
        if (est <= threshold) {
          ctx.log.info("compaction.prune-applied", "超长工具结果已裁剪（免摘要救援）", { pruned: prunes.length, savedChars: prunedChars });
          return pruned;
        }
      }
      const afterPrune = (): ModelMessage[] | undefined => (rewrote ? pruned : undefined);

      // ③ 退避/熔断（空白 §7/§11）：退避管短期节奏（force 旁路）；熔断管链路坏了别再烧（手动旁路、溢出受约束）
      if (force !== "manual" && consecutiveFailures >= 3) {
        ctx.log.warn("compaction.breaker-open", "连续 3 次压缩失败——自动尝试停手等人工（/compact 可手动重试）", { failures: consecutiveFailures });
        return afterPrune();
      }
      if (force === undefined && failPoint !== undefined && est < failPoint * (1 + cfg.backoffGrowthRatio)) {
        ctx.log.debug("compaction.skipped-backoff", "退避中——估算增长不足不重试", { est, failPoint });
        return afterPrune();
      }

      // ④ 预算切点：溢出 force 收缩至 minKeepMessages（dsh retainTokens=0 同型）；窗口已知时预算封顶 25%（空白 §16——防小窗口 cut=0 永不压缩）
      const budget = force === "overflow" ? 0 : (window !== undefined ? Math.min(cfg.keepRecentTokens, Math.floor(window * 0.25)) : cfg.keepRecentTokens);
      const cut = safeCut(pruned, budget, cfg.minKeepMessages);
      if (cut <= 0 || cut >= pruned.length) return afterPrune(); // 无压缩空间；越界防御（首轮 P1：切点推到末尾=全删，放弃）

      const dropped = pruned.slice(0, cut);
      const kept = pruned.slice(cut);
      const maxTokens = window !== undefined ? Math.min(cfg.summaryMaxTokens, Math.max(512, Math.floor(window / 4))) : cfg.summaryMaxTokens;
      const summary = await summarize(ctx.llm, dropped, { maxTokens, maxToolChars: cfg.summaryToolResultMaxChars });

      // ⑤ 收敛检查（dsh 同款 + 512 显著性门槛）：压后必须更小——但玩具尺寸对话（[历史摘要] 包装 ≈9 token）
      // 天然不满足"严格变小"，只对非平凡大摘要（≥512 token，与 maxTokens 公式的 512 下限同源）执行；
      // 超长跑飞摘要照抓。执行期修正（计划⑪与⑮的夹具张力），T8 文档登记
      const summaryMsg: ModelMessage = { role: "user", content: [{ kind: "text", text: `[历史摘要]\n${summary ?? ""}` }] };
      const summaryCost = estimateTokens([summaryMsg]);
      if (summary === undefined || (summaryCost >= estimateTokens(dropped) && summaryCost >= 512)) {
        consecutiveFailures++;
        failPoint = est;
        ctx.log.warn("compaction.summary-failed", summary === undefined ? "摘要生成失败——不装占位（宁可不压）" : "收敛检查不过（压后未变小）——不装", { dropped: dropped.length });
        return afterPrune();
      }

      consecutiveFailures = 0; // 任一成功清零（熔断与退避同释）
      failPoint = undefined;
      anchorStale = true; // 压缩改写上下文 → 锚点 stale
      ctx.session.append("turn/compaction", { summary, keepFrom: cut, droppedCount: dropped.length });
      ctx.log.info("compaction.applied", "已压缩", { dropped: dropped.length, kept: kept.length });
      return [summaryMsg, ...kept];
    });

    ctx.events.on("agent/request-error", (p) => {
      if ((p as { code?: string })?.code === "context_limit") forceKind = "overflow";
    });

    ctx.contribute.command("compaction__compact", async () => {
      forceKind = "manual";
      return "已安排压缩：下一条消息发出前执行。成功时界面会显示一行压缩提示；若未出现且对话异常增长，请查诊断日志后重试 /compact";
    });
  },
});
