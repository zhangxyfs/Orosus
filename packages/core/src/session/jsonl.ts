import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, closeSync } from "node:fs";
import { join } from "node:path";
import { newId, type SessionEvent, type SessionStore } from "./types.ts";

/** POSIX 专属硬化在 Windows 上降级（§6.1）：审计标记，不静默弱化。 */
export function hardeningNote(): string | null {
  return process.platform === "win32" ? "session-hardening: partial (windows)" : null;
}

/** 崩溃修复（§6.1）：torn tail 截断 + 未闭合 turn 补 turn/end{kind:"interrupted"}。 */
export function repairFile(path: string): { truncated: boolean; interruptedClosed: boolean } {
  if (!existsSync(path)) return { truncated: false, interruptedClosed: false };
  const raw = readFileSync(path, "utf8");
  // 崩溃切口恰好落在换行前：最后一行是合法 JSON（truncated=false）但文件缺尾 \n——不规范化的话，
  // 下一次 append 会把新旧两条记录合并到同一行，再开时按 torn tail 处理、双事件静默丢失
  const needsNewline = raw.length > 0 && !raw.endsWith("\n");
  const lines = raw.split("\n");
  const good: string[] = [];
  let truncated = false;
  for (const line of lines) {
    if (line === "") continue;
    try {
      JSON.parse(line);
      good.push(line);
    } catch {
      truncated = true;
      break; // torn tail：截掉该行及之后一切
    }
  }
  let interruptedClosed = false;
  const events = good.map((l) => JSON.parse(l) as SessionEvent);
  const lastTurnStart = events.map((e, i) => (e.type === "turn/start" ? i : -1)).filter((i) => i >= 0).pop();
  const hasTurnEndAfter = lastTurnStart !== undefined && events.slice(lastTurnStart).some((e) => e.type === "turn/end");
  if (lastTurnStart !== undefined && !hasTurnEndAfter) {
    // 未闭合 turn：先补 turn 内缺 tool/result 的 call（M3/D41——日志里不许出现无结果的 tool/call），
    // 再补 turn/end{interrupted}
    const inTurn = events.slice(lastTurnStart);
    const called = new Set(inTurn.filter((e) => e.type === "tool/call").map((e) => String(e.callId)));
    const resulted = new Set(inTurn.filter((e) => e.type === "tool/result").map((e) => String(e.callId)));
    let last = events[events.length - 1]!;
    for (const callId of called) {
      if (resulted.has(callId)) continue;
      last = {
        v: 1,
        id: newId("e"),
        parentId: last.id,
        seq: last.seq + 1,
        ts: new Date().toISOString(),
        type: "tool/result",
        callId,
        output: "[已中止：工具未执行]",
        isError: true,
      };
      events.push(last);
    }
    events.push({
      v: 1,
      id: newId("e"),
      parentId: last.id,
      seq: last.seq + 1,
      ts: new Date().toISOString(),
      type: "turn/end",
      kind: "interrupted",
    });
    interruptedClosed = true;
  }
  if (truncated || interruptedClosed || needsNewline) {
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  }
  return { truncated, interruptedClosed };
}

/** usage chunk 求和助手（lifetimeUsage 与 /usage 共用口径：assistant/chunk 里 type === "usage"）。 */
export function sumUsage(events: SessionEvent[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const e of events) {
    if (e.type !== "assistant/chunk") continue;
    const c = e.chunk as { type?: string; input?: number; output?: number } | undefined;
    if (c?.type === "usage") {
      input += c.input ?? 0;
      output += c.output ?? 0;
    }
  }
  return { input, output };
}

/** append-only JSONL 后端（§6.1 写入硬化三件套 + 每文件写队列串行化）。 */
export class JsonlSessionStore implements SessionStore {
  readonly sessionId: string;
  private readonly file: string;
  private readonly dir: string;
  private seq = 0;
  private lastId: string | null = null;
  private queue: Promise<void> = Promise.resolve(); // 每文件写队列：seq 单调的串行化保证
  private buffer: string[] = [];
  private events: SessionEvent[] = []; // 内存镜像：all() 供 loop 投影（§6.2）；重开实例时从磁盘恢复
  private closed = false;

  constructor(opts: { dir: string; sessionId?: string }) {
    mkdirSync(opts.dir, { recursive: true });
    this.sessionId = opts.sessionId ?? newId("s");
    this.dir = opts.dir;
    this.file = join(opts.dir, `${this.sessionId}.jsonl`);
    repairFile(this.file);
    if (existsSync(this.file)) {
      const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const e = JSON.parse(line) as SessionEvent;
        this.seq = e.seq;
        this.lastId = e.id;
        this.events.push(e);
      }
    } else {
      const fd = openSync(this.file, "a", 0o600);
      closeSync(fd);
      if (process.platform !== "win32") chmodSync(this.file, 0o600);
    }
    if (process.platform !== "win32" && existsSync(this.file)) {
      const st = statSync(this.file);
      if ((st.mode & 0o777) !== 0o600) chmodSync(this.file, 0o600);
      // dev/ino 身份校验：记录打开时的身份，防符号链接替换（POSIX 语义）
      this.devIno = `${st.dev}:${st.ino}`;
    }
  }

  private devIno: string | null = null;

  append(type: string, fields: Record<string, unknown> = {}): Promise<SessionEvent> {
    if (this.closed) return Promise.reject(new Error("store closed"));
    // 信封字段最终生效（同 InMemory：fields 不得打穿 v/id/parentId/seq/ts/type）
    const event: SessionEvent = {
      ...fields,
      v: 1,
      id: newId("e"),
      parentId: this.lastId,
      seq: ++this.seq,
      ts: new Date().toISOString(),
      type,
    };
    this.lastId = event.id;
    this.events.push(event);
    this.buffer.push(JSON.stringify(event) + "\n");
    this.queue = this.queue.then(() => this.drain());
    return Promise.resolve(event); // 转发先于 drain（§6.7：UI 可见性不构成持久化承诺）
  }

  private drain(): void {
    if (this.buffer.length === 0) return;
    if (this.devIno !== null && process.platform !== "win32") {
      const st = statSync(this.file);
      if (`${st.dev}:${st.ino}` !== this.devIno) throw new Error("log file replaced (symlink attack?)");
    }
    appendFileSync(this.file, this.buffer.join(""));
    this.buffer = [];
  }

  all(): Promise<SessionEvent[]> {
    return Promise.resolve([...this.events]);
  }

  /** 跨会话累计（/usage 口径修复：重启后此前会话的用量不归零）。当前会话取内存镜像——
   *  buffer 可能未 drain；其余会话读盘，坏行（torn tail）跳过不炸。会话数按文件计（有用量才算）。 */
  async lifetimeUsage(): Promise<{ input: number; output: number; sessions: number }> {
    let input = 0;
    let output = 0;
    let sessions = 0;
    for (const name of readdirSync(this.dir).filter((n) => n.endsWith(".jsonl")).toSorted((a, b) => a.localeCompare(b))) {
      if (name === `${this.sessionId}.jsonl`) {
        const u = sumUsage(this.events);
        input += u.input;
        output += u.output;
        if (u.input > 0 || u.output > 0) sessions++;
        continue;
      }
      let fileInput = 0;
      let fileOutput = 0;
      for (const line of readFileSync(join(this.dir, name), "utf8").split("\n")) {
        if (line === "") continue;
        let e: SessionEvent;
        try {
          e = JSON.parse(line) as SessionEvent;
        } catch {
          continue; // 他会话 torn tail：累计值不因坏行中断
        }
        if (e.type !== "assistant/chunk") continue;
        const c = e.chunk as { type?: string; input?: number; output?: number } | undefined;
        if (c?.type === "usage") {
          fileInput += c.input ?? 0;
          fileOutput += c.output ?? 0;
        }
      }
      input += fileInput;
      output += fileOutput;
      if (fileInput > 0 || fileOutput > 0) sessions++;
    }
    return { input, output, sessions };
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}
