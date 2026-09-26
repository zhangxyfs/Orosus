import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { newId, type SessionEvent, type SessionStore } from "./types.ts";

type NodeSqlite = typeof import("node:sqlite");

/** node:sqlite 可用性探测（D42）：核心模块走 createRequire 同步加载（ESM 无同步 import）。
 *  测试可注入 fake 探测（setSqliteProbeForTest）覆盖"不可用"分支。 */
const defaultProbe = (): boolean => {
  try {
    createRequire(import.meta.url)("node:sqlite") as NodeSqlite;
    return true;
  } catch {
    return false;
  }
};

let probe: () => boolean = defaultProbe;
export function sqliteAvailable(): boolean {
  return probe();
}
export function setSqliteProbeForTest(p?: () => boolean): void {
  probe = p ?? defaultProbe;
}

function openDatabase(file: string): import("node:sqlite").DatabaseSync {
  const require = createRequire(import.meta.url);
  const mod = require("node:sqlite") as NodeSqlite;
  return new mod.DatabaseSync(file);
}

/** SQLite 后端（§7.2，D42）：Node 内置 node:sqlite、零原生依赖；WAL；同步事务（无写队列——
 *  事务原子性使撕裂尾部不可达，torn-tail 修复为 jsonl 特有；未闭合 turn 的问题经 verifyChain 报告）。 */
export class SqliteSessionStore implements SessionStore {
  readonly sessionId: string;
  private readonly db: import("node:sqlite").DatabaseSync;
  private seq = 0;
  private lastId: string | null = null;
  private closed = false;

  constructor(opts: { dir: string; sessionId?: string }) {
    if (!sqliteAvailable()) {
      throw new Error("SQLite 后端需要 Node ≥22.5 的 node:sqlite（当前运行时不可用）——请用默认 jsonl 后端（sessionStore 配置，§7.2/D42）");
    }
    mkdirSync(opts.dir, { recursive: true }); // 桶目录（D46 既有语义）
    this.sessionId = opts.sessionId ?? newId("s");
    // 会话树批 T3 目录化：每会话一目录——库文件落 <桶>/<sid>/agents/session.sqlite（决策点 4/16，与 jsonl 对称）。
    // 构造期直建（本后端无懒建语义）；WAL 伴生 -wal/-shm 文件天然收进会话目录。目录权限 0o700（决策点 5，Windows 跳过）。
    const sessionDir = join(opts.dir, this.sessionId, "agents");
    mkdirSync(sessionDir, { recursive: true });
    if (process.platform !== "win32") {
      chmodSync(sessionDir, 0o700);
      chmodSync(join(opts.dir, this.sessionId), 0o700);
    }
    const db = openDatabase(join(sessionDir, "session.sqlite"));
    this.db = db;
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(
      "CREATE TABLE IF NOT EXISTS events (" +
        "id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL)",
    );
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_seq ON events (session_id, seq)");
    for (const row of db.prepare("SELECT json FROM events WHERE session_id = ? ORDER BY seq").all(this.sessionId) as { json: string }[]) {
      const e = JSON.parse(row.json) as SessionEvent;
      this.seq = e.seq;
      this.lastId = e.id;
    }
  }

  append(type: string, fields: Record<string, unknown> = {}): Promise<SessionEvent> {
    if (this.closed) return Promise.reject(new Error("store closed"));
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
    this.db
      .prepare("INSERT INTO events (id, session_id, seq, ts, type, json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, this.sessionId, event.seq, event.ts, type, JSON.stringify(event));
    return Promise.resolve(event);
  }

  all(): Promise<SessionEvent[]> {
    const rows = this.db.prepare("SELECT json FROM events WHERE session_id = ? ORDER BY seq").all(this.sessionId) as { json: string }[];
    return Promise.resolve(rows.map((r) => JSON.parse(r.json) as SessionEvent));
  }

  flush(): Promise<void> {
    return Promise.resolve(); // 同步事务——落盘在 append 内完成
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
    return Promise.resolve();
  }
}
