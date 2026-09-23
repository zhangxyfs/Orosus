import type { ContentPart, ModelMessage } from "@orosus/contracts/provider";
import type { SessionEvent } from "../session/types.ts";

/** elision 固定模板（v3 设计空白 4，kimi buildCompactionElisionText 语义、条数口径改投影条目）。
 *  核心确定性生成（重放与 config 无关，D44）；模块侧返回值同款双写（铁律 2 两份代码，测试钉逐字一致）。 */
const COMPACTION_ELISION = (omitted: number): string =>
  `[Some messages were omitted here during compaction: ${omitted} messages between the oldest and the most recent user input are covered by the compaction summary at the end.]`;

/** 图片剥占位（v3 设计空白 7，双写——与模块侧同款逐字一致）：保留的用户消息进新投影时 image part
 *  替换为占位文本 part（保路径可 Read 捞回；provider 侧零图片开销）。 */
function stripImages(m: ModelMessage): ModelMessage {
  if (m.role !== "user" || !m.content.some((p) => p.kind === "image")) return m;
  return {
    ...m,
    content: m.content.map((p) => p.kind === "image"
      ? { kind: "text" as const, text: `[image omitted during compaction: ${p.path}]` }
      : p),
  };
}

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
        // 投影应用（§6.1/M3）：前缀丢弃换摘要——deriveMessages 是事件的纯函数；重放确定性：同一事件序列两次投影字节一致。
        // v2/v3 分界 = trigger 字段缺席（信封 v:1 后置覆盖会抹掉载荷 v 字段——版本判据改用 trigger 在场性，重放仍与 config 无关）
        const summary = String(e.summary ?? "");
        if (e.trigger === undefined) {
          // v2 旧事件（现状规则不动——旧会话重放兼容，不重写历史）：keepFrom 计数切尾、摘要置顶、无 origin
          const keepFrom = Number(e.keepFrom ?? 0);
          out = [{ role: "user", content: [{ kind: "text", text: `[历史摘要]
${summary}` }] }, ...out.slice(keepFrom)];
          break;
        }
        // v3（D57 触发分级）：摘要带 compaction-summary origin（下次压缩谓词消费，设计空白 1）
        const summaryMsg: ModelMessage = {
          role: "user",
          content: [{ kind: "text", text: `[历史摘要]
${summary}` }],
          origin: { kind: "compaction-summary" },
        };
        // 纯下标取（不重新执行谓词——判定已在落盘时固化，规格 §4）；越界/缺省防御
        const keepUserAt = (Array.isArray(e.keepUserAt) ? e.keepUserAt : [])
          .map((x) => Number(x)).filter((i) => Number.isInteger(i) && i >= 0 && i < out.length)
          .sort((a, b) => a - b);
        if (String(e.trigger) === "manual" || keepUserAt.length === 0) {
          out = [summaryMsg]; // manual 全量零保留（ZCode 形态）；auto 但无保留（用户消息全进摘要）同形
          break;
        }
        // auto/overflow：[头用户…, elision, 尾用户…, 摘要（末尾——kimi 形态：模型读到的最近内容就是交接摘要）]。
        // elision 恒在——全保留时省略的是 assistant/tool 条目，同样诚实标注（头尾分界由 keepUserHead 计数定：
        // 段内下标差 >1 常态存在〔用户消息之间隔着 assistant/tool〕，不能当分界信号）；
        // M = 尾段首下标 − 头段末下标 − 1（事件推导不落盘数字——重放与 config 无关）；头段空取 −1、尾段空 = 到投影末
        const kept = keepUserAt.map((i) => stripImages(out[i]!)); // 图片剥占位（设计空白 7 双写）
        const keepUserHead = Math.max(0, Math.min(Number(e.keepUserHead ?? 0) || 0, keepUserAt.length));
        const headKept = kept.slice(0, keepUserHead);
        const tailKept = kept.slice(keepUserHead);
        const headLastAt = keepUserHead > 0 ? keepUserAt[keepUserHead - 1]! : -1;
        const tailFirstAt = keepUserHead < keepUserAt.length ? keepUserAt[keepUserHead]! : out.length;
        const elisionMsg: ModelMessage = {
          role: "user",
          content: [{ kind: "text", text: COMPACTION_ELISION(tailFirstAt - headLastAt - 1) }],
        };
        out = [...headKept, elisionMsg, ...tailKept, summaryMsg];
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
          // 守卫判据用事件 minLen（缺陷 B 修：判据随事件落盘——模块选择判据 max(threshold, head+tail) 与
          // 重放守卫 head+tail 不是一个数，产物实长 ≈5158 > 5120 认不出「已裁过」→ 反复裁剪嵌套标记）；
          // 旧事件无 minLen 回落旧判据（head+tail）不炸
          const minLenRaw = Number((p as { minLen?: unknown })?.minLen);
          const guard = Number.isFinite(minLenRaw) && minLenRaw > 0 ? minLenRaw : headChars + tailChars;
          if (m.output.length <= guard) continue; // 防御：过短跳过
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
