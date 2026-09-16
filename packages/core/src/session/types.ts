/** 会话日志记录（§6.1）。append-only；parentId 构成树；seq 单调。 */
export interface SessionEvent {
  v: 1;
  id: string;
  parentId: string | null;
  seq: number;
  ts: string;
  type: string;
  [k: string]: unknown;
}

/** SessionStore 接缝（§7.2 层 2）：JSONL 默认、SQLite 预留。 */
export interface SessionStore {
  readonly sessionId: string;
  /** 追加一条：自动补 v/id/seq/ts，parentId 默认 = 上一条记录 id（首条为 null）。 */
  append(type: string, fields?: Record<string, unknown>): Promise<SessionEvent>;
  /** 按 seq 全量读出（M1 投影与测试用；分页留待需要时）。 */
  all(): Promise<SessionEvent[]>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** 核心日志事件类型词汇（§6.1 表；模块扩展类型为 <module>/*，经 logEvents 声明）。 */
export const LOG_TYPES = {
  sessionHeader: "session/header",
  userMessage: "user/message",
  assistantChunk: "assistant/chunk",
  assistantMessage: "assistant/message",
  steeringMessage: "agent/steering-message",
  turnStart: "turn/start",
  turnStep: "turn/step",
  turnEnd: "turn/end",
  toolCall: "tool/call",
  toolResult: "tool/result",
  requestHeader: "request/header",
} as const;

/** ULID 风格 id：48bit 时间 + 80bit 随机，base32，字典序 = 时间序（单调可排序）。 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastMs = 0;
let lastRand: number[] = [];
export function newId(prefix: string): string {
  const ms = Date.now();
  let rand: number[];
  if (ms === lastMs) {
    rand = lastRand;
    for (let i = rand.length - 1; i >= 0; i--) {
      if (++rand[i]! < 32) break;
      rand[i] = 0;
    }
  } else {
    rand = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
    lastMs = ms;
    lastRand = rand;
  }
  let ts = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  return `${prefix}_${ts}${rand.map((r) => CROCKFORD[r]).join("")}`;
}
