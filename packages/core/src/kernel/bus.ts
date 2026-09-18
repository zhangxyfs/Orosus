import type { Disposer, Listener } from "@orosus/contracts/module";
import { createLogger, type DiagSink } from "../diag/logger.ts";

/** 拦截点白名单（§6.5）：模块不可自定义新拦截点（v1）。 */
export const CORE_POINTS = {
  preStep: "agent/pre-step",
  transformContext: "agent/transform-context", // reduce 链
  steering: "agent/steering",                  // collect 链
  followUp: "agent/follow-up",                 // collect 链
  shouldStop: "agent/should-stop",             // collect 链（任一 stop 即 stop）
  toolPreExecute: "tool/pre-execute",          // waterfall（审批模块在此，M3）
  toolPostExecute: "tool/post-execute",        // emit 广播
  uiCommand: "ui/command",                     // emit 广播（命令端口输入，含审批应答）
  requestError: "agent/request-error",         // emit 广播（M3 补强 D43：provider 请求失败观测/触发——loop 溢出重试前广播，策略在监听者）
} as const;

/** 模块 emit 拒收的类型（§6.5：防伪造核心信号）。ctx 层强制，见 activate.ts。
 *  `llm/stream` 与 `tool/execute` 是 §6.5 白名单里的预留拦截点（M1 不装配，首个消费者出现时定案）——
 *  装配可以缓，拒收不能缓：不收进本集，模块就能伪造这两个核心信号。 */
export const CORE_BUS_TYPES: ReadonlySet<string> = new Set([
  ...Object.values(CORE_POINTS),
  "turn/start", "turn/step", "turn/end", "tool/call", "tool/result",
  "session/header", "user/message", "assistant/chunk", "assistant/message",
  "agent/steering-message", "request/header", "session/fork", "session/label", "turn/compaction", "turn/prune",
  "llm/stream", "tool/execute",
]);

export interface EventBus {
  on(type: string, listener: Listener, owner: string): Disposer;
  emit(type: string, payload: unknown): Promise<void>;
  waterfall(type: string, payload: unknown): Promise<{ deny: true; reason: string } | undefined>;
  reduce<T>(type: string, value: T): Promise<T>;
  collect<T>(type: string): Promise<T[]>;   // 监听者返回数组、链序拼接（D29）
  any(type: string): Promise<boolean>;      // should-stop 例外：监听者返回布尔，全部调用后 OR、抛错跳过（D29）
}

interface Entry {
  type: string;
  listener: Listener;
  owner: string;
  seq: number; // 注册序 = 激活拓扑序（模块按拓扑序激活，activate 内注册）
}

/** 一条链、两种错误策略（§6.5）：emit 隔离继续；waterfall fail-closed 否决即终局。 */
export function createEventBus(sink: DiagSink): EventBus {
  const log = createLogger(sink, "kernel");
  const entries: Entry[] = [];
  let seq = 0;
  const chain = (type: string): Entry[] => entries.filter((e) => e.type === type).sort((a, b) => a.seq - b.seq);

  return {
    on(type, listener, owner) {
      const entry: Entry = { type, listener, owner, seq: seq++ };
      entries.push(entry);
      return () => {
        const i = entries.indexOf(entry);
        if (i >= 0) entries.splice(i, 1);
      };
    },

    async emit(type, payload) {
      for (const e of chain(type)) {
        try {
          await e.listener(payload);
        } catch (err) {
          log.error("kernel.bus.listener-error", `emit 监听者抛错被隔离`, { type, owner: e.owner, error: String(err) });
        }
      }
    },

    async waterfall(type, payload) {
      for (const e of chain(type)) {
        try {
          const r = (await e.listener(payload)) as { deny?: boolean; reason?: string } | undefined;
          if (r?.deny === true) {
            log.info("kernel.bus.veto", `waterfall 否决`, { type, owner: e.owner, reason: r.reason ?? "" });
            return { deny: true, reason: r.reason ?? "未给原因" };
          }
          log.debug("kernel.bus.waterfall-link", `waterfall 环通过`, { type, owner: e.owner }); // 每环决定打点（§11.9 关键路径）
        } catch (err) {
          // fail-closed：抛错视为否决（安全方向），首个否决即终局
          log.warn("kernel.bus.veto-by-throw", `waterfall 监听者抛错视为否决`, { type, owner: e.owner, error: String(err) });
          return { deny: true, reason: String(err instanceof Error ? err.message : err) };
        }
      }
      return undefined;
    },

    async reduce<T>(type: string, value: T): Promise<T> {
      let current = value;
      for (const e of chain(type)) {
        try {
          const r = await e.listener(current);
          if (r !== undefined) current = r as T;
        } catch (err) {
          // 改值失败丢的是优化：忽略该环、原值续传（§6.2）
          log.error("kernel.bus.reduce-error", `reduce 环抛错被忽略`, { type, owner: e.owner, error: String(err) });
        }
      }
      return current;
    },

    async collect<T>(type: string): Promise<T[]> {
      const out: T[] = [];
      for (const e of chain(type)) {
        try {
          const r = await e.listener(undefined);
          if (Array.isArray(r)) out.push(...(r as T[]));
        } catch (err) {
          log.error("kernel.bus.collect-error", `collect 监听者抛错被跳过`, { type, owner: e.owner, error: String(err) });
        }
      }
      return out;
    },

    async any(type: string): Promise<boolean> {
      // should-stop 例外（D29）：监听者返回布尔，全部调用后 OR（不短路，保错误隔离），抛错跳过该监听者
      let result = false;
      for (const e of chain(type)) {
        try {
          if ((await e.listener(undefined)) === true) result = true;
        } catch (err) {
          log.error("kernel.bus.any-error", `any 监听者抛错被跳过`, { type, owner: e.owner, error: String(err) });
        }
      }
      return result;
    },
  };
}
