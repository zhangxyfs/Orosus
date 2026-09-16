import type { ContentPart, ModelMessage } from "@orosus/contracts/provider";
import type { SessionEvent } from "../session/types.ts";

/**
 * convertToLlm：日志投影 → 模型消息（§6.1 铁律 "model-visible means logged" 的执行点）。
 * 核心固定实现，不可被模块替换（§6.2）；契约：不许抛异常——未知/不可投影类型跳过。
 */
export function deriveMessages(events: SessionEvent[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const e of events) {
    switch (e.type) {
      case "user/message":
        out.push({ role: "user", content: (e.content ?? []) as ContentPart[] });
        break;
      case "agent/steering-message": {
        const items = (e.messages ?? []) as { text: string }[];
        for (const m of items) out.push({ role: "user", content: [{ kind: "text", text: m.text }] });
        break;
      }
      case "assistant/message":
        out.push({ role: "assistant", content: (e.content ?? []) as ContentPart[] });
        break;
      case "tool/call": {
        const last = out[out.length - 1];
        if (last?.role === "assistant") {
          last.toolCalls = [
            ...(last.toolCalls ?? []),
            { callId: String(e.callId), name: String(e.name), args: e.args },
          ];
        }
        break;
      }
      case "tool/result":
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
  return out;
}
