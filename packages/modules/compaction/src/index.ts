import { z } from "zod";
import { defineModule, type LlmPort } from "@orosus/contracts/module";
import type { ModelMessage } from "@orosus/contracts/provider";

const configSchema = z.object({
  thresholdTokens: z.number().int().positive().default(60_000).describe("估算 token 超过即触发压缩"),
  keepRecent: z.number().int().positive().default(12).describe("保留最近 N 条消息不压缩"),
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
    if (m.role === "toolResult") tokens += textTokens(String(m.output ?? ""));
  }
  return tokens;
}

/** 摘要生成：ctx.llm 二级调用（D39）；失败/空产出 → 确定性占位（压缩失败不阻断对话——reduce 环隔离语义）。 */
export async function summarize(llm: LlmPort, dropped: ModelMessage[]): Promise<string> {
  try {
    let text = "";
    let failed = false;
    for await (const c of llm.stream({
      system: "你是会话压缩器。用中文简洁总结以下对话：保留关键事实、已做决定与未完成事项；不要寒暄。",
      messages: dropped,
    })) {
      if (c.type === "text/delta") text += c.text;
      if (c.type === "finish" && c.kind === "error") failed = true;
    }
    if (!failed && text.trim() !== "") return text.trim();
  } catch {
    // llm 口契约不许 reject——防御性兜底
  }
  const toolResults = dropped.filter((m) => m.role === "toolResult").length;
  return `[compaction] 丢弃 ${dropped.length} 条消息（含 ${toolResults} 个工具结果）——摘要生成失败，确定性占位`;
}

/** 安全切点：丢弃段边界只落在 user 角色消息上——assistant(toolCalls) 与其 toolResult 不拆开（投影合法）。 */
function safeCut(messages: ModelMessage[], keepRecent: number): number {
  let cut = Math.max(0, messages.length - keepRecent);
  while (cut < messages.length && messages[cut]?.role !== "user") cut++;
  return cut;
}

export default defineModule({
  name: "compaction",
  version: "0.1.0",
  description: "会话压缩——transformContext 消费方：超阈值时摘要前缀并落 turn/compaction（投影应用，§6.1/§6.2）",
  api: 1,
  mounts: ["hook:agent/transform-context", "contribute:command"],
  config: configSchema,
  logEvents: ["turn/compaction"], // 模块可写核心日志类型例外（v25）：核心类型、模块写入、核心投影应用
  activate(ctx) {
    let forceOnce = false; // /compact：下一个 step 强制压缩一次（阈值置 0）

    ctx.events.on("agent/transform-context", async (value) => {
      const messages = value as ModelMessage[];
      const cfg = ctx.config as z.infer<typeof configSchema>;
      const threshold = forceOnce ? 0 : cfg.thresholdTokens;
      if (estimateTokens(messages) <= threshold) return undefined;
      forceOnce = false;
      const cut = safeCut(messages, cfg.keepRecent);
      if (cut <= 0 || cut >= messages.length) return undefined; // 无压缩空间；越界防御（四轮 P1）：切点推到末尾=全删，放弃
      const dropped = messages.slice(0, cut);
      const summary = await summarize(ctx.llm, dropped);
      // 先落日志再改值（§6.1 铁律推论 + 可重建性契约的"先落专门事件"分支）；keepFrom = 投影前缀丢弃条数
      ctx.session.append("turn/compaction", { summary, keepFrom: cut, droppedCount: dropped.length });
      ctx.log.info("compaction.applied", "已压缩", { dropped: dropped.length, kept: messages.length - cut });
      return [{ role: "user", content: [{ kind: "text", text: `[历史摘要]\n${summary}` }] }, ...messages.slice(cut)];
    });

    ctx.contribute.command("compaction__compact", async () => {
      forceOnce = true;
      return "已标记：下一个 step 强制压缩一次（阈值临时置 0，之后恢复配置阈值）";
    });
  },
});
