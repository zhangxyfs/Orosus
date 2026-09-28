import { newId, type SessionEvent, type SessionStore } from "./types.ts";

/** 测试基建 + 嵌入式默认（§12 M1 测试基建同批交付）。 */
export class InMemorySessionStore implements SessionStore {
  readonly sessionId: string;
  private events: SessionEvent[] = [];
  private closed = false; // CS-13（2026-09-28 code review）：与 jsonl/sqlite 的 store-closed 拒绝对齐——旧实现 close 后 append 照常成功，替身跑出的测试会掩盖「关闭后仍写」类 bug（测试基建与生产后端行为漂移）

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? newId("s");
  }

  append(type: string, fields: Record<string, unknown> = {}): Promise<SessionEvent> {
    if (this.closed) return Promise.reject(new Error("store closed")); // CS-13：同 jsonl.ts/sqlite.ts 的拒绝语义与文案
    const last = this.events[this.events.length - 1];
    // 信封字段最终生效（v/id/parentId/seq/ts/type 后置覆盖 fields）：调用方——含模块经
    // ctx.session.append——不得打穿 seq 单调与 parentId 链（§6.1 不变量是核心所有的）
    const event: SessionEvent = {
      ...fields,
      v: 1,
      id: newId("e"),
      parentId: last?.id ?? null,
      seq: this.events.length + 1,
      ts: new Date().toISOString(),
      type,
    };
    this.events.push(event);
    return Promise.resolve(event);
  }

  all(): Promise<SessionEvent[]> {
    return Promise.resolve([...this.events]);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true; // CS-13：幂等置位（重复 close 保持 resolve）
    return Promise.resolve();
  }
}
