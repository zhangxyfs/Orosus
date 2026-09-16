import { createHash } from "node:crypto";
import type { Chunk, ModelMessage, StreamFn } from "@orosus/contracts/provider";
import { createLogger, type DiagSink } from "../diag/logger.ts";
import { LOG_TYPES, type SessionEvent, type SessionStore } from "../session/types.ts";
import { CORE_POINTS, type EventBus } from "../kernel/bus.ts";
import type { ToolRegistry } from "../tool/registry.ts";
import { deriveMessages } from "./convert.ts";

export interface LoopOptions {
  session: SessionStore;
  bus: EventBus;
  tools: ToolRegistry;
  provider: StreamFn;
  model: string;
  system: string;
  signal: AbortSignal;
  sink: DiagSink;
}

interface PendingToolCall {
  callId: string;
  name: string;
  argsJson: string;
}

const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * agentLoop（§6.2）：零策略骨架。一切可变行为经 bus 装配（reduce/collect/waterfall），
 * convertToLlm 固定（§6.1 铁律）。M1 工具按 call 顺序全串行（§12；调度器 M3）。
 * 产出 = 会话日志实时投影：每 append 一条 yield 一条（§6.7）。
 */
export async function* agentLoop(opts: LoopOptions): AsyncGenerator<SessionEvent> {
  const { session, bus, tools, provider, model, system, signal, sink } = opts;
  const turnStart = await session.append(LOG_TYPES.turnStart, { model });
  const log = createLogger(sink, "loop").withCtx({ sess: session.sessionId, turn: turnStart.id });
  let lastRequestSig: string | null = null;

  async function* emit(type: string, fields?: Record<string, unknown>): AsyncGenerator<SessionEvent, SessionEvent> {
    const e = await session.append(type, fields);
    yield e;
    return e;
  }

  yield turnStart;
  log.info("loop.turn.start", "turn 开始", { model });

  let endKind: "completed" | "interrupted" | "error" = "completed";
  let endDetail: string | undefined;

  outer: while (!signal.aborted) {
    yield* emit(LOG_TYPES.turnStep);
    await bus.emit(CORE_POINTS.preStep, { turn: turnStart.id }); // step 开始广播（§6.5 拦截点——观测类模块挂点，emit 模式；turn 关联 id 语义同 §6.1）
    log.debug("loop.step", "step 开始");

    // steering：先落日志再进请求（§6.2 collect 链 + §6.1 铁律推论）
    const steering = await bus.collect<{ text: string; sourceModule: string }>(CORE_POINTS.steering);
    if (steering.length > 0) {
      yield* emit(LOG_TYPES.steeringMessage, { messages: steering });
    }

    // 投影 → transformContext reduce 链（可重建性契约由监听者自担）→ 发请求。
    // M1 每 step 全量重读重投影（O(n²) 增长）——增量投影与 compaction（M3）留待真实负载出现再定
    const claimed: ModelMessage[] = deriveMessages(await session.all());
    const messages = await bus.reduce<ModelMessage[]>(CORE_POINTS.transformContext, claimed);

    // request/header 变化检测的作用域 = 本 turn（lastRequestSig 是 loop 局部量）：同 turn 内 tools/system 稳定只落
    // 一条；跨 turn 恒落一条（新 turn 即新请求序列）。tools 以名称近似"字节稳定"（§6.3）——M1 无热更新，足够
    const requestSig = hash(JSON.stringify({ model, system: hash(system), tools: tools.specs().map((t) => t.name) }));
    if (requestSig !== lastRequestSig) {
      lastRequestSig = requestSig;
      yield* emit(LOG_TYPES.requestHeader, { model, systemHash: hash(system), toolsCount: tools.list().length });
    }

    log.debug("loop.provider.stream-start", "provider 流式开始", { messages: messages.length });
    let text = "";
    const pending = new Map<string, PendingToolCall>();
    let finish: Extract<Chunk, { type: "finish" }> = { type: "finish", kind: "stop" };

    try {
      for await (const chunk of provider({ model, system, messages, tools: tools.specs(), signal })) {
        yield* emit(LOG_TYPES.assistantChunk, { chunk });
        if (signal.aborted) {
          finish = { type: "finish", kind: "aborted" };
          break;
        }
        switch (chunk.type) {
          case "text/delta":
            text += chunk.text;
            break;
          case "toolcall/argumentsDelta": {
            const p = pending.get(chunk.callId) ?? { callId: chunk.callId, name: "", argsJson: "" };
            if (chunk.name) p.name = chunk.name;
            p.argsJson += chunk.argumentsDelta;
            pending.set(chunk.callId, p);
            break;
          }
          case "finish":
            finish = chunk;
            break;
          default:
            break; // reasoning/usage：已落日志，骨架不消费
        }
      }
    } catch (err) {
      // provider 契约是不许 reject（§6.4）；违约者按带内错误同等处理
      finish = { type: "finish", kind: "error", errorMessage: String(err) };
    }
    log.debug("loop.provider.stream-finish", "provider 流式结束", { kind: finish.kind });

    if (text !== "" || pending.size > 0) {
      // 纯工具回合无文本：content 留空数组（tool/call 随后落条附挂到这条 assistant）——不放空 text 段，Anthropic 拒收空 text block
      yield* emit(LOG_TYPES.assistantMessage, { content: text !== "" ? [{ kind: "text", text }] : [] });
    }

    if (finish.kind === "aborted" || signal.aborted) {
      endKind = "interrupted";
      break;
    }
    if (finish.kind === "error") {
      endKind = "error";
      endDetail = finish.errorMessage;
      break;
    }

    const toolCalls = [...pending.values()];
    if (toolCalls.length === 0) {
      // 本可停止：follow-up collect 链（§6.2）；should-stop 走 any（布尔 OR，D29）
      const stops = await bus.any(CORE_POINTS.shouldStop);
      const followUps = await bus.collect<{ text: string; sourceModule: string }>(CORE_POINTS.followUp);
      if (followUps.length > 0 && !stops) {
        yield* emit(LOG_TYPES.steeringMessage, { messages: followUps });
        continue;
      }
      break outer;
    }

    // 先批量落全部 tool/call，再串行执行（§6.2 伪码同款）——投影规则把 tool/call 附挂到最近的 assistant，
    // 边执行边落条会让第二个 call 的前一条变成 tool/result 而被投影静默丢弃（model-visible means logged，§6.1 铁律）
    const parsedCalls = toolCalls.map((call) => {
      let args: unknown = {};
      try {
        args = JSON.parse(call.argsJson || "{}");
      } catch {
        args = { _rawArguments: call.argsJson };
      }
      return { call, args };
    });
    for (const { call, args } of parsedCalls) {
      yield* emit(LOG_TYPES.toolCall, { callId: call.callId, name: call.name, args });
    }
    let executed = 0;
    for (const { call, args } of parsedCalls) {
      if (signal.aborted) break;
      log.debug("loop.tool.call", "工具调用", { call: call.callId, name: call.name });
      const result = await tools.run({ id: call.callId, name: call.name, args }, { signal });
      executed++;
      yield* emit(LOG_TYPES.toolResult, {
        callId: call.callId,
        output: result.output,
        isError: result.isError,
        ...(result.denied !== undefined ? { denied: result.denied } : {}),
        ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
        ...(result.spill !== undefined ? { spill: result.spill } : {}),
      });
      await bus.emit(CORE_POINTS.toolPostExecute, { callId: call.callId, name: call.name, result });
    }
    // 中止时给未执行的 call 补 interrupted 结果——日志里不许出现无结果的 tool/call（投影完整性）
    for (const { call } of parsedCalls.slice(executed)) {
      yield* emit(LOG_TYPES.toolResult, { callId: call.callId, output: "[已中止：工具未执行]", isError: true });
    }
    if (signal.aborted) {
      endKind = "interrupted";
      break outer;
    }
  }

  if (signal.aborted && endKind === "completed") endKind = "interrupted"; // 预中止（请求未发出）也记 interrupted，与流中 abort 同语义
  yield* emit(LOG_TYPES.turnEnd, { kind: endKind, ...(endDetail !== undefined ? { errorMessage: endDetail } : {}) });
  log.info("loop.turn.end", `turn 结束：${endKind}`);
  await session.flush();
}
