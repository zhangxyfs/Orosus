import { newId, type SessionEvent, type SessionStore } from "./types.ts";

/** 测试基建 + 嵌入式默认（§12 M1 测试基建同批交付）。 */
export class InMemorySessionStore implements SessionStore {
  readonly sessionId: string;
  private events: SessionEvent[] = [];

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? newId("s");
  }

  append(type: string, fields: Record<string, unknown> = {}): Promise<SessionEvent> {
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
    return Promise.resolve();
  }
}
