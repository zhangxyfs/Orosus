import type { ContentPart, ModelMessage } from "@orosus/contracts/provider";
import type { SessionEvent } from "../session/types.ts";

/**
 * convertToLlm：日志投影 → 模型消息（§6.1 铁律 "model-visible means logged" 的执行点）。
 * 核心固定实现，不可被模块替换（§6.2）；契约：不许抛异常——未知/不可投影类型跳过。
 */
export function deriveMessages(events: SessionEvent[]): ModelMessage[] {
  let out: ModelMessage[] = [];
  const seenCalls = new Set<string>();
  for (const e of events) {
    switch (e.type) {
      case "user/message":
        out.push({ role: "user", content: (e.content ?? []) as ContentPart[] });
        break;
      case "agent/steering-message": {
        const items = (e.messages ?? []) as { text: string; sourceModule?: string }[];
        for (const m of items) out.push({
          role: "user",
          content: [{ kind: "text", text: m.text }],
          // v3 设计空白 1：steering 注入打标（sourceModule 丢失 → "host" 宿主缺省）——compaction 谓词消费
          origin: { kind: "steering", sourceModule: String(m.sourceModule ?? "host") },
        });
        break;
      }
      case "assistant/message": {
        // T5/D45：reasoning 块只入审计/显示面，不回流模型（现状 reasoning 本就不回流——v1 定案，思考回流属 M5+）
        const content = ((e.content ?? []) as ContentPart[]).filter((p) => (p as { kind?: string }).kind !== "reasoning");
        out.push({ role: "assistant", content });
        break;
      }      case "tool/call": {
        seenCalls.add(String(e.callId));
        const last = out[out.length - 1];
        if (last?.role === "assistant") {
          last.toolCalls = [
            ...(last.toolCalls ?? []),
            { callId: String(e.callId), name: String(e.name), args: e.args },
          ];
        }
        break;
      }
      case "turn/compaction": {
        // 投影应用（§6.1/M3）：前缀丢弃换摘要——deriveMessages 是事件的纯函数，keepFrom 计数锚定与 entry 锚定等价；
        // 重放确定性：同一事件序列两次投影字节一致
        const summary = String(e.summary ?? "");
        const keepFrom = Number(e.keepFrom ?? 0);
        out = [{ role: "user", content: [{ kind: "text", text: `[历史摘要]
${summary}` }] }, ...out.slice(keepFrom)];
        break;
      }
      case "turn/prune": {
        // 投影应用（M3 补强 D44）：工具结果中段裁剪——prunes 逐条应用，参数入事件故重放与 config 无关；
        // 与模块侧 reduce 返回值是同一变换的双写（铁律 2 下模块不得 import core——[历史摘要] 包装同型先例，模块测试钉两侧一致）
        const prunes = Array.isArray(e.prunes) ? (e.prunes as unknown[]) : [];
        for (const p of prunes) {
          const at = Number((p as { at?: unknown })?.at ?? -1);
          const m = out[at];
          if (m === undefined || m.role !== "toolResult") continue; // 防御：越界/非工具结果跳过
          const headChars = Math.max(0, Number((p as { headChars?: unknown })?.headChars ?? 0)); // 负值按 0 夹紧（三轮 P2）
          const tailChars = Math.max(0, Number((p as { tailChars?: unknown })?.tailChars ?? 0));
          if (m.output.length <= headChars + tailChars) continue; // 防御：过短跳过
          m.output = `${m.output.slice(0, headChars)}\n[...pruned: original ${m.output.length} chars...]\n${m.output.slice(-tailChars)}`;
        }
        break;
      }
      case "tool/result":
        // 孤儿防御（M3/D41）：fork 截断/损坏片段可能产生无对应 tool/call 的 result——跳过，不进请求
        if (!seenCalls.has(String(e.callId))) break;
        out.push({
          role: "toolResult",
          callId: String(e.callId),
          output: String(e.output ?? ""),
          isError: e.isError === true,
        });
        break;
      default:
        break; // session/header、turn/*、request/header、assistant/chunk、<module>/* 扩展事件不进模型投影
    }
  }
  // 尾滤（2026-09-23 实测修复）：纯 reasoning 的 assistant/message（思考期被取消会落这种）滤掉
  // reasoning 后 content 空且无 toolCalls——GLM 等 API 直接 400「assistant must not be empty」，不进投影。
  // 带 toolCalls 的空 content 保留（纯工具回合的合法形态——loop.ts「不放空 text 段」先例）
  return out.filter((m) => !(m.role === "assistant" && m.content.length === 0 && (m.toolCalls?.length ?? 0) === 0));
}
