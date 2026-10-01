import { createHash } from "node:crypto";
import type { Logger } from "@orosus/contracts/module";
import type { Chunk, ModelMessage, StreamFn } from "@orosus/contracts/provider";
import { createLogger, type DiagSink } from "../diag/logger.ts";
import { LOG_TYPES, type SessionEvent, type SessionStore } from "../session/types.ts";
import { CORE_POINTS, type EventBus } from "../kernel/bus.ts";
import type { PlannedTool, ToolRegistry } from "../tool/registry.ts";
import { scheduleByAccesses } from "../tool/schedule.ts";
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
  /** 思考投入档位（/effort 2026-09-25）：透传 ProviderRequest.reasoningEffort——provider 翻译层按协议族
   *  落线缆参数（openai reasoning_effort / anthropic thinking）。turn 内恒定（harness 在 prompt 开头捕获）。 */
  reasoningEffort?: string;
  /** 实时旁路（M4-1 T4/D45）：流式 Chunk 的内存投递口（harness liveChunks 通道）。
   *  T4 并存态：assistantChunk 照落日志 + livePush 双投；T5 断流后仅剩 livePush。 */
  livePush?: (chunk: Chunk) => void;
  /** 网络重试退避表（2026-09-30 拍板 a）：传输层失败（errorCode "network"）且本 turn 零产出时按下表
   *  延迟重发——缺省 [1s, 3s]（代理切换/瞬时抖动通常秒级回稳）；测试注入短值防拖慢。 */
  networkRetryDelaysMs?: readonly number[];
}

interface PendingToolCall {
  callId: string;
  name: string;
  argsJson: string;
}

const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** 组间串行、组内并行（D40）；tool/result 按完成序落日志并经 fan-in 队列按完成序转发。
 *  返回已产出结果的 callId 集——中止时调用方为其余 call 补 [已中止] 条（投影完整性，§6.1）。
 *  abort 语义：组边界检查（未启动的组不再执行）；在飞任务收到 signal、按工具契约快速带内返回。 */
async function* executeGroups(
  groups: number[][],
  plans: PlannedTool[],
  parsedCalls: { call: PendingToolCall; args: unknown }[],
  opts: {
    signal: AbortSignal;
    session: SessionStore;
    bus: EventBus;
    tools: ToolRegistry;
    log: Logger;
  },
): AsyncGenerator<SessionEvent, Set<string>> {
  const executedIds = new Set<string>();
  for (const group of groups) {
    if (opts.signal.aborted) break; // 未启动的组不再执行——由调用方补条
    const queue: SessionEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const notify = (): void => { const w = wake; wake = undefined; w?.(); };
    const tasks = group.map((i) => (async () => {
      const { call } = parsedCalls[i]!;
      const planned = plans[i]!;
      opts.log.debug("loop.tool.call", "工具调用", { call: call.callId, name: call.name });
      executedIds.add(call.callId);
      // CL-01/CX-03 修复（2026-09-28 code review P1）：工具契约是「错误带内——不许 reject」，但任何旁路
      // 异常一旦穿透，旧实现任务 IIFE 无 catch——finished 永不置位（生成器 :80 死等无唤醒源）+ 漂浮
      // Promise.all 拒绝无人接（Node ≥15 默认崩进程）。兜底合成带内错误结果，保证组照常收尾。
      try {
        const result = await opts.tools.execute(planned, { signal: opts.signal });
        const e = await opts.session.append(LOG_TYPES.toolResult, {
          callId: call.callId,
          output: result.output,
          isError: result.isError,
          ...(result.denied !== undefined ? { denied: result.denied } : {}),
          ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
          ...(result.spill !== undefined ? { spill: result.spill } : {}),
          ...(Array.isArray(result.images) && result.images.length > 0 ? { images: result.images } : {}), // m5-media F1：图片附件路径引用透传（投影 → toolResult.parts）
        });
        await opts.bus.emit(CORE_POINTS.toolPostExecute, { callId: call.callId, name: call.name, result });
        queue.push(e);
      } catch (err) {
        opts.log.error("loop.tool.task-crash", "工具任务契约外抛出（兜底带内错误结果）", { call: call.callId, name: call.name, error: String(err instanceof Error ? err.message : err) });
        try {
          queue.push(await opts.session.append(LOG_TYPES.toolResult, {
            callId: call.callId,
            output: `工具执行异常（契约外抛出，已兜底）：${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          }));
        } catch { /* append 也炸——事件不可得，仅留日志（notify 仍保证组收尾） */ }
      } finally {
        notify();
      }
    })());
    const all = (async () => { await Promise.all(tasks); })()
      .catch(() => undefined) // 双保险：任务已各自兜底，此处防线防「兜底自身」失手
      .finally(() => { finished = true; notify(); });
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (finished) break;
      await new Promise<void>((r) => { wake = r; });
    }
    await all;
  }
  return executedIds;
}

/**
 * agentLoop（§6.2）：零策略骨架。一切可变行为经 bus 装配（reduce/collect/waterfall），
 * convertToLlm 固定（§6.1 铁律）。工具执行按 §6.3 冲突矩阵并发分组（M3/D40：组间串行、组内并行）。
 * 产出 = 会话日志实时投影：每 append 一条 yield 一条（§6.7；组内按完成序）。
 */
export async function* agentLoop(opts: LoopOptions): AsyncGenerator<SessionEvent> {
  const { session, bus, tools, provider, model, system, signal, sink } = opts;
  const reasoningEffort = opts.reasoningEffort;
  const networkRetryDelays = opts.networkRetryDelaysMs ?? [1_000, 3_000];
  const turnStart = await session.append(LOG_TYPES.turnStart, { model });
  await bus.emit("turn/start", { turnId: turnStart.id, model }); // m5 T9（设计空白 17）：busy 自推事件面——turn 事件上总线（此前只进 session 流，模块照方订阅永不触发）
  const log = createLogger(sink, "loop").withCtx({ sess: session.sessionId, turn: turnStart.id });
  let lastRequestSig: string | null = null;
  let overflowRetried = false; // 溢出重试每 turn 至多一次（D43：重试后仍超限即终局，防打转）
  let networkRetries = 0; // 网络重试每 turn 至多 networkRetryDelays.length 次（拍板 a：零产出才重发，限次防打转）

  async function* emit(type: string, fields?: Record<string, unknown>): AsyncGenerator<SessionEvent, SessionEvent> {
    const e = await session.append(type, fields);
    yield e;
    return e;
  }

  yield turnStart;
  log.info("loop.turn.start", "turn 开始", { model });

  let endKind: "completed" | "interrupted" | "error" = "completed";
  let endDetail: string | undefined;
  let lengthHit = false; // CL-03：本 turn 任一 step 的 finish.kind === "length"（max_tokens 截断）——turn/end 带内记档

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
    const requestSig = hash(JSON.stringify({ model, system: hash(system), tools: tools.specs().map((t) => t.name), ...(reasoningEffort !== undefined ? { effort: reasoningEffort } : {}) }));
    if (requestSig !== lastRequestSig) {
      lastRequestSig = requestSig;
      yield* emit(LOG_TYPES.requestHeader, { model, systemHash: hash(system), toolsCount: tools.specs().length, ...(reasoningEffort !== undefined ? { effort: reasoningEffort } : {}) }); // CL-05：审计口径与实际发送同源（specs 滤 ToolSearch 未 reveal 的 deferred；旧实现记 list().length——机制启用时虚报大于实发数）
    }

    log.debug("loop.provider.stream-start", "provider 流式开始", { messages: messages.length });
    // 末次请求耗时（2026-10-01 拍板 B——被动真值，不做主动健康探测）：起表 = 请求即将发出，停表 = 流终
    // （含 catch 路径）；随 assistant/message 带内落盘，resume 回放保值——「网络 · MCP」卡模型服务行消费
    const streamT0 = Date.now();
    let text = "";
    let reasoning = ""; // T5/D45：流内累积——reasoning 首次持久化（只入审计/显示面；投影跳过，模型可见性不变）
    let usage: { input: number; output: number } | undefined;
    const pending = new Map<string, PendingToolCall>();
    let finish: Extract<Chunk, { type: "finish" }> = { type: "finish", kind: "stop" };
    let sawFinish = false; // CL-02：流结束前是否收到 finish 块（provider 契约要求必有——缺块 = 截断/违约）

    try {
      for await (const chunk of provider({ model, system, messages, tools: tools.specs(), signal, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) })) {
        // 断流（T5/D45）：assistantChunk 不再落日志——实时经 livePush 旁路；完成事件 = assistant/message 一条
        opts.livePush?.(chunk);
        if (signal.aborted) {
          finish = { type: "finish", kind: "aborted" };
          break;
        }
        switch (chunk.type) {
          case "text/delta":
            text += chunk.text;
            break;
          case "reasoning/delta":
            reasoning += chunk.text;
            break;
          case "usage":
            usage = { input: chunk.input, output: chunk.output };
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
            sawFinish = true;
            break;
          default:
            break;
        }
      }
    } catch (err) {
      // provider 契约是不许 reject（§6.4）；违约者按带内错误同等处理
      finish = { type: "finish", kind: "error", errorMessage: String(err) };
    }
    const durationMs = Date.now() - streamT0;
    // CL-02 修复（2026-09-28 code review）：provider 流干净 EOF 但全程无 finish 块（经网关/代理的 SSE 被
    // 中间层干净切断的常见形态——契约要求必有 finish，缺块即截断/违约）时，旧实现沿用预置 kind:"stop"
    // 静默收尾：半截 text 物化为 assistant/message、turn/end{completed}，截断对用户不可见。现改按带内错误
    // 收尾（abort 除外——已有 interrupted 语义；provider 抛错除外——已是 error）。注：产出侧放大器
    // provider-custom/stream-anthropic.ts 干净 EOF 不补 finish 属该域，留档由其修——loop 侧先保证消费面诚实。
    if (!sawFinish && !signal.aborted && finish.kind !== "error") {
      finish = { type: "finish", kind: "error", errorMessage: "流在 finish 块前结束（响应可能被截断）" };
    }
    // CL-03 修复（2026-09-28 code review）：finish.kind "length"（max_tokens 截断）此前全仓零消费——按
    // completed 静默收尾，截断对用户与后续轮次均不可见、日志零痕迹。现带内记档：assistant/message 与
    // turn/end 落 finishKind:"length"（渲染面/后续消费可据此提示「输出达上限被截断」），诊断面同步 warn。
    // 不做自动续写（length 当可续跑信号经 followUp 注入「继续」是策略行为——零策略骨架，留给模块装配层）。
    if (finish.kind === "length") {
      lengthHit = true;
      log.warn("loop.finish.length", "输出达 max_tokens 上限被截断（finishKind=length 已落 assistant/message 与 turn/end）");
    }
    log.debug("loop.provider.stream-finish", "provider 流式结束", {
      kind: finish.kind,
      ...(finish.kind === "error" ? { errorMessage: finish.errorMessage, ...(finish.errorCode !== undefined ? { errorCode: finish.errorCode } : {}) } : {}), // 拍板 b：错误详情进诊断日志（此前只记 kind——fetch failed 真因无从查）
    });
    if (finish.kind === "error") log.warn("loop.provider.stream-error", "provider 流式失败", { errorMessage: finish.errorMessage, ...(finish.errorCode !== undefined ? { errorCode: finish.errorCode } : {}) });

    if (text !== "" || reasoning !== "" || pending.size > 0) {
      // 完成事件扩形（T5/D45）：content 块数组（reasoning 在前 text 在后）+ usage——纯工具回合 content 留空数组
      // （tool/call 随后落条附挂——不放空 text 段，Anthropic 拒收空 text block）
      yield* emit(LOG_TYPES.assistantMessage, {
        content: [
          ...(reasoning !== "" ? [{ kind: "reasoning", text: reasoning }] : []),
          ...(text !== "" ? [{ kind: "text", text }] : []),
        ],
        ...(usage !== undefined ? { usage } : {}),
        ...(finish.kind === "length" ? { finishKind: "length" } : {}), // CL-03：截断记档（per-step 精确）
        durationMs, // 2026-10-01 拍板 B：本 step 流式耗时（起表→流终，含截断/违约路径）——面板「末次耗时」数据源
      });
    }

    if (finish.kind === "aborted" || signal.aborted) {
      endKind = "interrupted";
      break;
    }
    if (finish.kind === "error") {
      // 溢出恢复（M3 补强 D43）：context_limit 且本 turn 未重试且无部分产出（防重试造成重复 assistant 投影）
      // → 广播 request-error 后重走本 step（投影 → reduce → 重发；compaction 模块监听置 forceOnce）。
      // 零策略口径：loop 只认适配器打的 errorCode，不读错误文本、不认识压缩与模块——未装时原样重发、二次失败终局
      if (finish.errorCode === "context_limit" && !overflowRetried && text === "" && pending.size === 0) {
        overflowRetried = true;
        await bus.emit(CORE_POINTS.requestError, { code: "context_limit", errorMessage: finish.errorMessage, turn: turnStart.id });
        continue outer; // 重试步注记：lastRequestSig 不变不落重复 request/header；turn/step 多落合法；steering 已排空
      }
      // 网络重试（2026-09-30 拍板 a）：传输层失败（errorCode "network"——fetch/读流抛错，适配器打码）且本 turn
      // 零产出（text/reasoning/pending 全空——防重复 assistant 投影，比 context_limit 多查 reasoning：网络错误
      // 前若已流出思考半截，重发会把两份 reasoning 先后物化进显示面）。代理切换/瞬时抖动是实锤场景
      //（2026-09-30 fetch failed 挂 150s 杀回合）。退避表耗尽即终局；退避期可被 abort 打断（不打满等待）。
      if (finish.errorCode === "network" && networkRetries < networkRetryDelays.length
          && text === "" && reasoning === "" && pending.size === 0) {
        const delay = networkRetryDelays[networkRetries]!;
        networkRetries++;
        log.warn("loop.provider.network-retry", `网络错误将重发（第 ${networkRetries}/${networkRetryDelays.length} 次，${Math.round(delay)}ms 后）`, { errorMessage: finish.errorMessage });
        await bus.emit(CORE_POINTS.requestError, { code: "network", errorMessage: finish.errorMessage, turn: turnStart.id });
        await new Promise<void>((resolve) => {
          const onAbort = (): void => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, delay);
          signal.addEventListener("abort", onAbort, { once: true }); // 计时器刻意不 unref：退避期回合在飞，进程须存活（unref 会让管道/--print 场景事件循环抽空、以「未完成顶层 await」exit 13 提前退场）；abort 即清、自然到点即已完成——无悬挂句柄
        });
        if (signal.aborted) { endKind = "interrupted"; break; }
        continue outer; // 同 context_limit 重试步注记：不落重复 header，steering 已排空
      }
      endKind = "error";
      endDetail = finish.errorCode === "context_limit"
        ? `${finish.errorMessage ?? ""}（已自动压缩重试仍超限——可 /compact 或换更大窗口模型）`
        : finish.errorCode === "network" && networkRetries > 0
          ? `${finish.errorMessage ?? ""}（已自动重发 ${networkRetries} 次仍网络错误——检查网络/代理后重试）`
          : finish.errorMessage;
      break;
    }

    const toolCalls = [...pending.values()];
    if (toolCalls.length === 0) {
      // 本可停止：follow-up collect 链（§6.2）；should-stop 走 any（布尔 OR，D29）
      const stops = await bus.any(CORE_POINTS.shouldStop);
      const followUps = await bus.collect<{ text: string; sourceModule: string }>(CORE_POINTS.followUp);
      // CL-07 修复（2026-09-28 code review）：stops=true 时旧实现把已 collect 的 followUps 静默丢弃
      //（harness 的 steerBacklog/deliveryDrain 都是 splice 式排空——排空即丢：用户插队话/子代理结论
      // 无声消失）。现照常落 agent/steering-message（内容进日志与后续投影）但不续跑（模块已喊停）。
      // 刻意不用「先判 stops 再 collect」：停止边界不排空积压会与 harness 送回轮收尾的补触发形成
      // 空转链——每轮送回立即再起一轮、积压永不被消费。
      if (followUps.length > 0) {
        yield* emit(LOG_TYPES.steeringMessage, { messages: followUps });
        if (!stops) continue;
      }
      break outer;
    }

    // 先批量落全部 tool/call，再并发执行（§6.2 伪码同款）——投影规则把 tool/call 附挂到最近的 assistant，
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
    // 并发调度（§6.3/D40）：全量 plan → 冲突矩阵贪心分组 → 组间串行、组内并行；tool/result 按完成序落日志
    const plans: import("../tool/registry.ts").PlannedTool[] = [];
    for (const { call, args } of parsedCalls) {
      plans.push(await tools.plan({ id: call.callId, name: call.name, args }));
    }
    // CX-16 留档（2026-09-28 code review P3）：scheduleByAccesses 已支持注入 cwd（相对 fs 路径锚点，
    // 缺省 process.cwd 兼容），但 LoopOptions 无 cwd 字段——harness 的注入 cwd（createHarness options.cwd）
    // 不下穿到 loop，此处无来源可传，不硬造；待 loop opts 补 cwd 后由此传入即可
    const groups = scheduleByAccesses(plans.map((p) => ({ accesses: p.ok ? p.accesses : [] })));
    const executedIds = yield* executeGroups(groups, plans, parsedCalls, { signal, session, bus, tools, log });
    // 中止时给未执行的 call 补 interrupted 结果——日志里不许出现无结果的 tool/call（投影完整性）
    for (const { call } of parsedCalls) {
      if (executedIds.has(call.callId)) continue;
      yield* emit(LOG_TYPES.toolResult, { callId: call.callId, output: "[已中止：工具未执行]", isError: true });
    }
    if (signal.aborted) {
      endKind = "interrupted";
      break outer;
    }
  }

  if (signal.aborted && endKind === "completed") endKind = "interrupted"; // 预中止（请求未发出）也记 interrupted，与流中 abort 同语义
  yield* emit(LOG_TYPES.turnEnd, {
    kind: endKind,
    ...(endDetail !== undefined ? { errorMessage: endDetail } : {}),
    ...(lengthHit ? { finishKind: "length" } : {}), // CL-03：本 turn 曾按 max_tokens 截断——终局事件带内记档（completed 语义不变）
  });
  await bus.emit("turn/end", { kind: endKind }); // m5 T9：busy 自推事件面（与 turn/start 成对）
  if (endKind === "error" && endDetail !== undefined) log.info("loop.turn.end", `turn 结束：${endKind}`, { errorMessage: endDetail }); // 拍板 b：错误终局带详情（会话日志 turn/end 同款带内）
  else log.info("loop.turn.end", `turn 结束：${endKind}`);
  await session.flush();
}
