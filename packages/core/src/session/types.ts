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
  /** 跨会话累计用量（/usage 口径）：同存储域全部会话的 usage chunk 求和；sessions = 有用量的会话数。
   *  可选——内存/SQLite 后端可缺省，调用方回退当前会话口径。 */
  lifetimeUsage?(): Promise<{ input: number; output: number; sessions: number }>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** 核心日志事件类型词汇（§6.1 表；模块扩展类型为 <module>/*，经 logEvents 声明）。 */
export const LOG_TYPES = {
  sessionHeader: "session/header",
  userMessage: "user/message",
  assistantChunk: "assistant/chunk", // T5/D45 后 legacy：新会话不再产生（delta 不落盘）——存量文件读取/汇总保留（双形态）
  assistantMessage: "assistant/message",
  steeringMessage: "agent/steering-message",
  turnStart: "turn/start",
  turnStep: "turn/step",
  turnEnd: "turn/end",
  toolCall: "tool/call",
  toolResult: "tool/result",
  requestHeader: "request/header",
  turnCompaction: "turn/compaction",   // §6.1 压缩：{ summary, keepFrom, droppedCount }——compaction 模块写入（owner 制例外），投影应用
  turnPrune: "turn/prune",             // §6.1 裁剪（M3 补强 D44）：{ prunes: [{ at, headChars, tailChars }], prunedChars }——compaction 模块写入（owner 制例外第二枚），投影应用
  sessionFork: "session/fork",         // §6.1 结构：fork 记录源 entry id——harness 直写（M3/T6）
  sessionLabel: "session/label",       // §6.1 结构：会话标签——harness 直写（M3/T6 预留）
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
