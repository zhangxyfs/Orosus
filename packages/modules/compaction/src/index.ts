import { z } from "zod";
import { defineModule, type LlmPort } from "@orosus/contracts/module";
import type { ModelMessage } from "@orosus/contracts/provider";

export const configSchema = z.object({
  thresholdTokens: z.number().int().positive().default(60_000).describe("回退阈值（窗口未知时的触发线）"),
  thresholdRatio: z.number().min(0.3).max(0.95).default(0.8).describe("窗口已知时的触发比"),
  userMessageTokens: z.number().int().positive().default(20_000).describe("auto：保留用户消息总预算（kimi 同值）"),
  userMessageHeadTokens: z.number().int().positive().default(2_000).describe("auto：头部预算（尾 = 总 − 头，kimi 同值）"),
  summaryToolResultMaxChars: z.number().int().positive().default(2_000).describe("摘要输入中工具结果截断长度（瞬态，不落日志）"),
  summaryMaxTokens: z.number().int().positive().default(8_192).describe("摘要输出上限（窗口已知取 min(本值, max(512, 窗口/4))）"),
  pruneThresholdChars: z.number().int().positive().default(8_192).describe("工具结果超此长度且超 head+tail 的候选裁剪"),
  pruneHeadChars: z.number().int().positive().default(4_096),
  pruneTailChars: z.number().int().positive().default(1_024),
  backoffGrowthRatio: z.number().min(0).max(1).default(0.05).describe("失败退避：估算再增长此比例才重试"),
  rapidRefillRounds: z.number().int().positive().default(3).describe("双熔断②：压缩后不足 N 个工具轮即再超阈 = refill"),
  rapidRefillLimit: z.number().int().positive().default(3).describe("refill 连续 N 次 → 自动压缩本会话停手"),
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

/** 预收缩截断说明（v3 设计空白 10）：摘要输入被裁掉最老段时追加——不装作涵盖了全部历史。 */
const PRESHRUNK_ADDENDUM = `

注意：由于输入超出摘要预算，你看到的对话已截去最早期部分——不要声称本摘要涵盖了全部历史。`;

/** elision 固定模板（v3 设计空白 4，kimi buildCompactionElisionText 语义、条数口径改投影条目）——
 *  与核心 convert.ts 同款双写（铁律 2 两份代码），测试钉两侧逐字一致。 */
const COMPACTION_ELISION = (omitted: number): string =>
  `[Some messages were omitted here during compaction: ${omitted} messages between the oldest and the most recent user input are covered by the compaction summary at the end.]`;

/** 图片剥占位（v3 设计空白 7，双写——与核心 convert.ts 同款逐字一致）：保留的用户消息进新投影时
 *  image part 替换为占位文本 part（保路径可 Read 捞回；provider 侧零图片开销）。 */
function stripImages(m: ModelMessage): ModelMessage {
  if (m.role !== "user" || !m.content.some((p) => p.kind === "image")) return m;
  return {
    ...m,
    content: m.content.map((p) => p.kind === "image"
      ? { kind: "text" as const, text: `[image omitted during compaction: ${p.path}]` }
      : p),
  };
}

/** 恢复页脚（v3 设计空白 3——模块确定性拼进 summary 尾部：页脚进事件 summary 字段本身，重放与 /summary
 *  天然一致，不为页脚单开双写面）。id 缺省只去编号、保留目录指引（D46 一级桶目录下模块拼路径不可靠）。 */
function recoveryFooter(droppedCount: number, sessionId: string | undefined): string {
  const where = sessionId !== undefined ? `会话 ${sessionId}（~/.orosus/sessions/ 目录）` : "（历史在 ~/.orosus/sessions/ 目录）";
  return `\n\n完整历史在会话日志（append-only）：被压缩 ${droppedCount} 条消息；用 Grep/Read 工具检索会话文件捞回细节。${where}，需要细节时去日志查证，不要凭猜测编造。`;
}

/** 摘要输入预收缩（v3 设计空白 10，kimi preShrinkHistoryToWindowBudget :818-842 吸收）：窗口已知且 dropped
 *  估算超 (窗口 − 窗口/8) × 0.85 时，摘要输入只保留该预算内最新消息（输出预留 = 窗口/8、安全比 0.85）——
 *  manual 全量送 200k 历史会把摘要请求自己撑爆，这是保命闸。 */
function preShrinkSummaryInput(dropped: ModelMessage[], window: number | undefined): { input: ModelMessage[]; truncated: boolean } {
  if (window === undefined) return { input: dropped, truncated: false };
  const budget = Math.floor((window - window / 8) * 0.85);
  if (estimateTokens(dropped) <= budget) return { input: dropped, truncated: false };
  const input: ModelMessage[] = [];
  let used = 0;
  for (let i = dropped.length - 1; i >= 0; i--) {
    const cost = msgTokens(dropped[i]!);
    if (used + cost > budget) break;
    used += cost;
    input.unshift(dropped[i]!);
  }
  return { input, truncated: true };
}

/** 摘要生成（D44）：失败/空产出/异常 → { error }（不装占位——宁可不压，pi/Reasonix 底线）；
 *  成功 → { text }。error 带详情（可观测性——实机首例诊断曾因吞掉 errorMessage 抓瞎）。
 *  输入瘦身：工具结果超 maxToolChars 截断（瞬态标记，不落日志）；前次摘要检测（v3 origin 标 + v2 前缀兜底
 *  双路）→ 合并指令；预收缩截断 → 说明追加；focus（manual 命令路径）→ 指令尾「可选用户指令」块（kimi
 *  compactionInstruction.ts:9-15 同款）。
 *  尾部指令消息（2026-09-23 实机首例根因修复，kimi fullCompaction 原生形态——指令作最后一条 user 消息）：
 *  摘要输入常以 assistant 消息结尾（对话在 agent 回复后被打断/完成），openai 端点对此形态会忽略 system
 *  摘要指令、把请求当「继续自己的话」（实测 kimi coding 端点 13~35 token 碎片即停/空产出）——末尾补一条
 *  显式 user 指令消息后同输入稳定产出完整摘要（710 token 实测对照）。 */
async function summarize(llm: LlmPort, dropped: ModelMessage[], opts: { maxTokens: number; maxToolChars: number; focus?: string | undefined; truncated?: boolean }): Promise<{ text?: string; error?: string }> {
  let system = SUMMARY_SYSTEM;
  const first = dropped[0];
  const wasPrevSummary = first?.role === "user" && (
    first.origin?.kind === "compaction-summary"
    || (first.content[0]?.kind === "text" && first.content[0]!.text.startsWith("[历史摘要]"))
  );
  if (wasPrevSummary) system += MERGE_ADDENDUM;
  if (opts.truncated) system += PRESHRUNK_ADDENDUM;
  if (opts.focus !== undefined && opts.focus !== "") system += `\n可选用户指令：\n${opts.focus}`;
  const slimmed = dropped.map((m) => {
    if (m.role !== "toolResult" || m.output.length <= opts.maxToolChars) return m;
    return { ...m, output: `${m.output.slice(0, opts.maxToolChars)}\n[...truncated: original ${m.output.length} chars]` };
  });
  const request: ModelMessage[] = [...slimmed, { role: "user", content: [{ kind: "text", text: "请输出上述对话的交接摘要。" }] }];
  try {
    let text = "";
    let error: string | undefined;
    for await (const c of llm.stream({ system, messages: request, maxTokens: opts.maxTokens })) {
      if (c.type === "text/delta") text += c.text;
      if (c.type === "finish" && c.kind === "error") error = c.errorMessage ?? "流以 error 结束（无详情）";
    }
    if (error !== undefined) return { error };
    if (text.trim() === "") return { error: "空产出（模型未返回正文）" };
    return { text: text.trim() };
  } catch (err) {
    // llm 口契约不许 reject（§6.4）——违约者防御性兜底
    return { error: `流异常：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** prune 变换（模块侧）。与 convert.ts 的 turn/prune 应用是同一变换的双写（铁律 2 下模块不得 import core——
 *  [历史摘要] 包装同型先例）；标记与裁剪参数逐字一致，模块测试钉两侧不漂移。
 *  prunes 条目带 minLen（缺陷 B 修：选择判据随事件落盘——核心重放守卫用它，防「产物 5158 > head+tail 5120
 *  认不出已裁过」的反复裁剪）。 */
function applyPrunes(messages: ModelMessage[], cfg: { pruneThresholdChars: number; pruneHeadChars: number; pruneTailChars: number }): { messages: ModelMessage[]; prunes: { at: number; headChars: number; tailChars: number; minLen: number }[]; prunedChars: number } {
  const prunes: { at: number; headChars: number; tailChars: number; minLen: number }[] = [];
  let prunedChars = 0;
  const out = messages.map((m) => ({ ...m }));
  const minLen = Math.max(cfg.pruneThresholdChars, cfg.pruneHeadChars + cfg.pruneTailChars); // 选择条件下限（五轮 P2：防 threshold < head+tail 时空转）
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role !== "toolResult" || m.output.length <= minLen) continue;
    prunes.push({ at: i, headChars: cfg.pruneHeadChars, tailChars: cfg.pruneTailChars, minLen });
    prunedChars += m.output.length - (cfg.pruneHeadChars + cfg.pruneTailChars);
    m.output = `${m.output.slice(0, cfg.pruneHeadChars)}\n[...pruned: original ${m.output.length} chars...]\n${m.output.slice(-cfg.pruneTailChars)}`;
  }
  return { messages: out, prunes, prunedChars };
}

type ForceKind = "manual" | "overflow";
type Cfg = z.infer<typeof configSchema>;
interface CompactionEvent { type: string; fields: Record<string, unknown> }
/** 退避/熔断/锚点/rapid-refill 共享状态（M4-2.5 T3 抽取：activate 闭包持有、compactOnce 就地更新——两路同一状态防行为漂移）。 */
interface CompactState {
  failPoint?: number | undefined;
  consecutiveFailures: number;
  anchorStale: boolean;
  seenAnchorAt?: number | undefined;
  toolResultsTotal?: number | undefined;   // 上次投影的 toolResult 总数（计数基；首轮只见基线不计增量）
  toolResultsSinceCompact: number;        // 自上次成功压缩起新增的 toolResult 条数（T3——ZCode recordCompletedToolBatch 的批量等价）
  consecutiveRapidRefills: number;        // 连续 refill 次数（≥ rapidRefillLimit → 自动路径停手）
  compactedEver: boolean;                 // 首次成功压缩前不判 refill——无「压缩后迅速填满」语义（执行期补）
}

const countToolResults = (messages: ModelMessage[]): number => messages.reduce((n, m) => n + (m.role === "toolResult" ? 1 : 0), 0);
interface CompactLog {
  debug(code: string, msg: string, fields?: Record<string, unknown>): void;
  info(code: string, msg: string, fields?: Record<string, unknown>): void;
  warn(code: string, msg: string, fields?: Record<string, unknown>): void;
}

/** 真实用户消息判定（v3 设计空白 1，kimi compactionUserMessageDisposition 同型——origin 缺省保守保留）：
 *  直敲（无 origin）保留；宿主插队（steering + sourceModule==="host"，busy 期你敲的话）保留；
 *  模块注入的 steering 提醒、压缩摘要（compaction-summary）剥离；v2 旧投影无 origin 且 [历史摘要]
 *  前缀 → 文本兜底剥离（ZCode 冷恢复同款）；v3 elision 模板前缀同款兜底（重放产物是裸 user 文本无 origin，
 *  不剥则二次压缩误占用户预算——执行期发现）。谓词只在模块侧执行一次（规格 §4），判定结果以事件下标集固化。 */
export function isRealUserInput(m: ModelMessage): boolean {
  if (m.role !== "user") return false;
  if (m.origin === undefined) {
    const first = m.content[0];
    if (first?.kind === "text") {
      if (first.text.startsWith("[历史摘要]")) return false;
      if (first.text.startsWith("[Some messages were omitted here during compaction:")) return false;
    }
    return true;
  }
  return m.origin.kind === "steering" && m.origin.sourceModule === "host";
}

/** 收集真实用户消息（kimi collectCompactableUserMessages :170-174 同型）——带投影下标（keepUserAt 重放锚的基）。 */
export function collectRealUserMessages(messages: ModelMessage[]): { at: number; m: ModelMessage }[] {
  const out: { at: number; m: ModelMessage }[] = [];
  messages.forEach((m, at) => { if (isRealUserInput(m)) out.push({ at, m }); });
  return out;
}

/** 头尾预算选择结果（v3）：keepUserAt 为重放锚（升序投影下标集）；keepUserHead 兼任重放期头尾分界锚
 *  （keepUserAt 相邻下标差 >1 在段内也常态存在——用户消息之间天然隔着 assistant/tool 条目，分界必须由计数定）。 */
export interface UserSelection {
  keepUserAt: number[];
  keepUserHead: number;
  keepUserTail: number;
  elided: boolean;
  omittedEntries: number; // 省略的投影条目数 = 尾段首下标 − 头段末下标 − 1（头段空取 −1；尾段空 = 到投影末）
}

/** 头尾预算选择（kimi selectCompactionUserMessages :234-297 改编；差异 = 输出下标集、整条粒度不截断——
 *  keepUserAt 下标锚定容不得截断形态，设计空白 7）。总量不超预算全保留无 elision；超限则尾段从最新
 *  往回整条装填（max − head）、头段从最老往新整条装填 head。头尾数学上不重叠（ΣH ≤ head、
 *  ΣT ≤ max − head < total）。totalEntries = 投影条目总数（尾段空时省略段算到投影末）。 */
export function selectUserMessages(
  users: { at: number; m: ModelMessage }[],
  cfg: { max: number; head: number; totalEntries: number },
): UserSelection {
  const total = users.reduce((n, x) => n + msgTokens(x.m), 0);
  if (users.length === 0 || total <= cfg.max) {
    return { keepUserAt: users.map((x) => x.at), keepUserHead: users.length, keepUserTail: users.length, elided: false, omittedEntries: 0 };
  }
  const tailBudget = Math.max(0, cfg.max - cfg.head);
  const tail: { at: number; m: ModelMessage }[] = [];
  let used = 0;
  for (let i = users.length - 1; i >= 0; i--) {
    const cost = msgTokens(users[i]!.m);
    if (used + cost > tailBudget) break;
    used += cost;
    tail.unshift(users[i]!);
  }
  const head: { at: number; m: ModelMessage }[] = [];
  used = 0;
  for (let i = 0; i < users.length; i++) {
    const cost = msgTokens(users[i]!.m);
    if (used + cost > cfg.head) break;
    used += cost;
    head.push(users[i]!);
  }
  const keepUserAt = [...head, ...tail].map((x) => x.at).sort((a, b) => a - b);
  const headLastAt = head.length > 0 ? head[head.length - 1]!.at : -1;
  const omittedEntries = (tail.length > 0 ? tail[0]!.at : cfg.totalEntries) - headLastAt - 1;
  return { keepUserAt, keepUserHead: head.length, keepUserTail: tail.length, elided: true, omittedEntries };
}

/** compactOnce 结果（M4-2.5 T3）：拦截器与命令两路共用——事件由调用方落盘（先落日志再改值的可重建性契约不变）。
 *  v3（D57）：no-space 拒绝路径废除（缺陷 A 机制载体）——manual 全量、auto 保用户消息，不存在「没有可压缩空间」。 */
type CompactResult =
  | { kind: "none"; events: [] }                                            // 未达阈值（自动路径常态）
  | { kind: "pruned"; messages: ModelMessage[]; events: CompactionEvent[] } // prune 免摘要救援
  | { kind: "skipped"; reason: "backoff" | "breaker" | "rapid-refill"; messages?: ModelMessage[] | undefined; events: CompactionEvent[] }
  | { kind: "failed"; reason: string; messages?: ModelMessage[] | undefined; events: CompactionEvent[] } // 摘要失败/收敛不过（不装占位；缺陷 B 修：带回 prune 后投影供缓存回写——prune 已真实执行）
  | { kind: "compacted"; newMessages: ModelMessage[]; events: CompactionEvent[]; stats: { dropped: number; kept: number; tokensBefore: number; tokensAfter: number; summaryTokens: number; summary: string } };

/** 压缩核心（v3/D57 触发分级重写）：阈值判定 → prune 前置 → 退避/熔断 → 分级保留（manual 全量零保留〔ZCode〕
 *  / auto 真实用户消息头尾预算〔kimi〕/ overflow 预算减半）→ 摘要（+预收缩保命闸）→ 收敛检查 → 页脚 → 落事件。
 *  纯形状（messages → 结果 + 事件清单）；退避/熔断/锚点状态经 opts.state 由调用方持有（两路共享一份）。 */
async function compactOnce(
  messages: ModelMessage[],
  cfg: Cfg,
  opts: {
    llm: LlmPort; window?: number | undefined; force: ForceKind | undefined;
    estimate: (m: ModelMessage[]) => number; state: CompactState; log: CompactLog;
    sessionId?: string | undefined; focus?: string | undefined;
  },
): Promise<CompactResult> {
  const trigger = opts.force ?? "auto";
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

  // ③b rapid-refill 熔断（v3/T3，ZCode turn-loop-state 状态机形状——规格决策 9）：压缩成功后不足
  //     rapidRefillRounds 个工具轮（= 新增 toolResult 条数，设计空白 6）又超阈值 = 一次 refill；
  //     连续 rapidRefillLimit 次 → 本会话自动压缩停手 + warn（ZCode 是 throw 打断 turn——我们取停手不打断）。
  //     manual 全旁路；换来 ≥ rounds 条跑道 → 清零（ZCode evaluateRapidRefill :154-168 同型）
  if (opts.force !== "manual") {
    if (opts.state.compactedEver && opts.state.toolResultsSinceCompact < cfg.rapidRefillRounds) {
      opts.state.consecutiveRapidRefills++;
      if (opts.state.consecutiveRapidRefills >= cfg.rapidRefillLimit) {
        opts.log.warn("compaction.rapid-refill", "压缩后上下文被迅速重新填满——建议 /compact 手动深压或 /new 开新会话", { sinceCompact: opts.state.toolResultsSinceCompact, consecutive: opts.state.consecutiveRapidRefills });
        return { kind: "skipped", reason: "rapid-refill", messages: afterPrune(), events };
      }
    } else if (opts.state.toolResultsSinceCompact >= cfg.rapidRefillRounds) {
      opts.state.consecutiveRapidRefills = 0;
    }
  }

  // ④ v3 分级保留（D57）：manual 全量零保留（ZCode shouldPreserveRecent 仅 Auto/Reactive）；auto 真实用户
  //    消息头尾预算（kimi selectCompactionUserMessages 改编）；overflow 同 auto、总/头预算均减半（设计空白 5）。
  //    dropped = 全部历史：保留的用户消息既进摘要（供总结）又以原话留在上下文（保意图）——assistant/tool 边界
  //    问题天然消失（保留集全是 user 角色，v2 的切点安全考量整体退役）
  const maxUser = trigger === "overflow" ? Math.floor(cfg.userMessageTokens / 2) : cfg.userMessageTokens;
  const headUser = trigger === "overflow" ? Math.floor(cfg.userMessageHeadTokens / 2) : cfg.userMessageHeadTokens;
  const users = trigger === "manual" ? [] : collectRealUserMessages(pruned);
  const sel = selectUserMessages(users, { max: maxUser, head: headUser, totalEntries: pruned.length });
  const dropped = pruned;

  // ⑤ 摘要输入预收缩（设计空白 10——kimi preShrink 吸收；manual 全量路径的保命闸）
  const { input: summaryInput, truncated } = preShrinkSummaryInput(dropped, opts.window);

  // ⑥ 摘要：六小节模板 + 前次合并（v3 标/v2 前缀双路）+ 截断说明 + focus（kimi compactionInstruction 同款）
  const maxTokens = opts.window !== undefined ? Math.min(cfg.summaryMaxTokens, Math.max(512, Math.floor(opts.window / 4))) : cfg.summaryMaxTokens;
  const summaryResult = await summarize(opts.llm, summaryInput, { maxTokens, maxToolChars: cfg.summaryToolResultMaxChars, focus: opts.focus, truncated });

  // ⑦ 收敛检查（dsh 同款 + 512 显著性门槛）：压后必须更小——但玩具尺寸对话（[历史摘要] 包装 ≈9 token）
  // 天然不满足"严格变小"，只对非平凡大摘要（≥512 token，与 maxTokens 公式的 512 下限同源）执行；
  // 超长跑飞摘要照抓。执行期修正（计划⑪与⑮的夹具张力），T8 文档登记
  if (summaryResult.error !== undefined || summaryResult.text === undefined) {
    opts.state.consecutiveFailures++;
    opts.state.failPoint = est;
    const error = summaryResult.error ?? "未知失败";
    opts.log.warn("compaction.summary-failed", "摘要生成失败——不装占位（宁可不压）", { dropped: dropped.length, error });
    return { kind: "failed", reason: `摘要生成失败：${error}`, messages: afterPrune(), events };
  }
  const summary = summaryResult.text;
  const fullSummary = summary + recoveryFooter(dropped.length, opts.sessionId); // ⑧ 页脚进 summary 字段（设计空白 3）
  const summaryMsg: ModelMessage = {
    role: "user",
    content: [{ kind: "text", text: `[历史摘要]\n${fullSummary}` }],
    origin: { kind: "compaction-summary" }, // 设计空白 1：摘要带标（下次压缩谓词元数据消费）
  };
  const summaryCost = estimateTokens([summaryMsg]);
  if (summaryCost >= estimateTokens(dropped) && summaryCost >= 512) {
    opts.state.consecutiveFailures++;
    opts.state.failPoint = est;
    opts.log.warn("compaction.summary-failed", "收敛检查不过（压后未变小）——不装", { dropped: dropped.length });
    return { kind: "failed", reason: "收敛检查不过（压后未变小）", messages: afterPrune(), events };
  }

  opts.state.consecutiveFailures = 0; // 任一成功清零（熔断与退避同释）
  opts.state.failPoint = undefined;
  opts.state.anchorStale = true; // 压缩改写上下文 → 锚点 stale
  events.push({ type: "turn/compaction", fields: { trigger, summary: fullSummary, keepUserAt: sel.keepUserAt, keepUserHead: sel.keepUserHead, keepUserTail: sel.keepUserTail, droppedCount: dropped.length } });

  // 新投影（与核心 convert.ts v3 分形同款双写——测试钉两侧逐字节一致）：manual/[摘要]；
  // auto/overflow [头(剥图)…, elision, 尾(剥图)…, 摘要（末尾——kimi 形态：模型读到的最近内容就是交接摘要）]。
  // elision 恒在——全保留时省略的是 assistant/tool 条目，同样诚实标注
  let newMessages: ModelMessage[];
  if (sel.keepUserAt.length === 0) {
    newMessages = [summaryMsg];
  } else {
    const kept = sel.keepUserAt.map((i) => stripImages(pruned[i]!));
    const headKept = kept.slice(0, sel.keepUserHead);
    const tailKept = kept.slice(sel.keepUserHead);
    const headLastAt = sel.keepUserHead > 0 ? sel.keepUserAt[sel.keepUserHead - 1]! : -1;
    const tailFirstAt = sel.keepUserHead < sel.keepUserAt.length ? sel.keepUserAt[sel.keepUserHead]! : pruned.length;
    const elisionMsg: ModelMessage = { role: "user", content: [{ kind: "text", text: COMPACTION_ELISION(tailFirstAt - headLastAt - 1) }] };
    newMessages = [...headKept, elisionMsg, ...tailKept, summaryMsg];
  }
  // rapid-refill 计数基重置（ZCode recordCompactSuccess :170-178 同点）：漏重置 total 则压缩后投影 toolResult
  // 骤降（如 100→0），下轮差值 = 大负数——计数基中毒：sinceCompact 长期为负、跑道判据失灵且 refill 误计
  opts.state.compactedEver = true;
  opts.state.toolResultsSinceCompact = 0;
  opts.state.toolResultsTotal = countToolResults(newMessages);
  opts.log.info("compaction.applied", "已压缩", { trigger, dropped: dropped.length, kept: sel.keepUserAt.length });
  return { kind: "compacted", newMessages, events, stats: { dropped: dropped.length, kept: sel.keepUserAt.length, tokensBefore: est, tokensAfter: estimateTokens(newMessages), summaryTokens: summaryCost, summary: fullSummary } };
}

export default defineModule({
  name: "compaction",
  version: "0.4.0",
  description: "会话压缩——触发分级（manual 全量 / auto 保留用户消息+恢复指针 / overflow 收紧）+ prune 前置 + 双熔断 + 失败不装+退避（D44）",
  api: 1,
  mounts: ["hook:agent/transform-context", "hook:agent/request-error", "contribute:command"],
  config: configSchema,
  logEvents: ["turn/compaction", "turn/prune"], // 模块可写核心日志类型（owner 制例外两枚）
  activate(ctx) {
    const state: CompactState = { consecutiveFailures: 0, anchorStale: false, toolResultsSinceCompact: 0, consecutiveRapidRefills: 0, compactedEver: false }; // 退避/熔断/锚点/rapid-refill（两路共享）
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
      // rapid-refill 工具轮累计（设计空白 6：投影无批次边界，新增 toolResult 条数为口径——两次投影对比差值）
      const nowToolResults = countToolResults(messages);
      if (state.toolResultsTotal === undefined) state.toolResultsTotal = nowToolResults; // 首轮只立基线
      else {
        state.toolResultsSinceCompact += nowToolResults - state.toolResultsTotal;
        state.toolResultsTotal = nowToolResults;
      }
      const force = forceKind;
      forceKind = undefined; // 消费即复位（手动一次、溢出一次）
      const r = await compactOnce(messages, cfg, { llm: ctx.llm, window: ctx.llm.contextWindow, force, estimate, state, log: ctx.log, sessionId: ctx.session.id });
      for (const e of r.events) ctx.session.append(e.type, e.fields);
      const out = r.kind === "compacted" ? r.newMessages : (r.kind === "pruned" || r.kind === "skipped" || r.kind === "failed") ? r.messages : undefined; // failed 亦回写/返回 prune 后投影（缺陷 B 修——prune 已真实执行）
      lastSeenMessages = out ?? messages; // 缓存跟踪变换后结果（v1.4 审修补）
      return out;
    });

    ctx.events.on("agent/request-error", (p) => {
      if ((p as { code?: string })?.code === "context_limit") forceKind = "overflow";
    });

    ctx.contribute.command("compaction__compact", async (args, ui) => {
      // 纯提示类结果走 ui.notice（批⑧：toast 浮动窗/行模式单行，不落流区）+ 返回空串（静默约定）；
      // 有实质内容的（摘要本文/失败详情/裁剪结果）仍走流区。
      // args = focus 焦点指令（v3/T6，kimi/ZCode 两家同款：/compact 后剩余文本追加进摘要指令尾）
      if (lastSeenMessages === undefined) {
        // 冷投影重建（M5 F5 二轮⑰ 用户拍板：/compact 必须立即执行，「等下一条」语义废弃）——
        // ctx.session.messages 读口（契约扩展，与 agentLoop 同投影）；宿主无读口才回落旧延期语义
        const projected = await ctx.session.messages?.();
        if (projected === undefined) {
          forceKind = "manual";
          ui.notice?.("已安排：下一条消息发出前压缩（宿主无投影读口——发一条消息预热投影，之后 /compact 即时执行）");
          return "";
        }
        lastSeenMessages = projected;
      }
      if (lastSeenMessages.length === 0) { ui.notice?.("无可压缩历史（本会话还没有对话）"); return ""; }
      const focus = args.trim();
      const r = await compactOnce(lastSeenMessages, cfg, { llm: ctx.llm, window: ctx.llm.contextWindow, force: "manual", estimate, state, log: ctx.log, sessionId: ctx.session.id, focus: focus !== "" ? focus : undefined });
      for (const e of r.events) ctx.session.append(e.type, e.fields); // 只落事件——下一次请求的投影自然应用（D20）
      switch (r.kind) {
        case "none": ui.notice?.("无可压缩历史（本会话还没有对话）"); return "";
        case "pruned":
          lastSeenMessages = r.messages;
          return `已裁剪 ${(r.events[0]!.fields.prunes as unknown[]).length} 个超长工具结果（免摘要救援）——体积已降，未做摘要压缩`;
        case "skipped":
          if (r.messages !== undefined) lastSeenMessages = r.messages; // 缺陷 B 修：prune 后退避/熔断/rapid-refill 跳过也回写（下次不再拿旧投影重裁）
          ui.notice?.(`已跳过：${r.reason === "backoff" ? "退避中（估算增长不足）" : r.reason === "rapid-refill" ? "压缩后上下文被迅速重新填满（建议 /new 开新会话或稍后再试）" : "连续失败熔断保护"}`);
          return "";
        case "failed":
          if (r.messages !== undefined) lastSeenMessages = r.messages; // 缺陷 B 修：失败也回写 prune 后投影（prune 已真实执行、事件已落）
          return `压缩失败：${r.reason}——${r.messages !== undefined ? "超长工具结果已裁剪（事件已落），" : ""}未产生摘要变更（可重试 /compact）`;
        case "compacted":
          lastSeenMessages = r.newMessages; // 缓存与已落事件对齐——防连击拿陈旧前缀双落事件（机制要点 1）
          // v3 文案（2026-09-23 用户拍板 UI 形态）：单行完成反馈（数字回落立现），摘要本文不再进流区
          // （经 Ctrl+O 查看——/summary 命令同批退役）；双色渲染（正文石青/括号灰）由 CLI 侧按括号段拆分
          return `上下文压缩完成 (${r.stats.tokensBefore} → ${r.stats.tokensAfter} tokens) (Ctrl+O 显示压缩摘要)`;
      }
    });
  },
});
