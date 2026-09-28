import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isSafeSessionId } from "./dir.ts";
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

/** 开库（会话树批 T8 起树快照读法复用——tree.ts 按主文件名分派到这里）。
 *  CS-09（2026-09-28 code review）：opts.readOnly 供只读消费方（树快照读头/用量聚合）避免读写开库的
 *  -wal/-shm 创建与恢复等写副作用；缺省保持读写（store/索引自身的开法不变）。 */
export function openDatabase(file: string, opts?: { readOnly?: boolean }): import("node:sqlite").DatabaseSync {
  const require = createRequire(import.meta.url);
  const mod = require("node:sqlite") as NodeSqlite;
  // Node 24 校验：options 显式传 undefined 也报「must be an object」——读写开不传第二参
  return opts?.readOnly === true ? new mod.DatabaseSync(file, { readOnly: true }) : new mod.DatabaseSync(file);
}

/** CS-09（2026-09-28 code review）：只读意图的会话库打开——busy_timeout 对齐 SqliteSessionStore（5000ms；
 *  旧 readSqliteHead 裸开库无超时，树刷新撞上活实例 checkpoint/恢复窗口的 SQLITE_BUSY → 该节点静默缺席）。
 *  readOnly 优先，探针查询逼出打开期错误（WAL 无 -shm 时只读开不了等）后回退读写开；任何失败 → undefined
 *  （调用方按「该会话跳过」处理——与树快照坏文件跳过同族容错）。 */
export function openSessionDbReadOnly(file: string): import("node:sqlite").DatabaseSync | undefined {
  const withTimeout = (db: import("node:sqlite").DatabaseSync): import("node:sqlite").DatabaseSync => {
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  };
  try {
    const db = openDatabase(file, { readOnly: true });
    try {
      withTimeout(db);
      db.prepare("SELECT count(*) FROM sqlite_schema").get();
      return db;
    } catch {
      try { db.close(); } catch { /* 已坏 */ }
    }
  } catch { /* readOnly 开不可用（旧 Node / WAL 只读限制）——回退读写开 */ }
  try {
    return withTimeout(openDatabase(file));
  } catch {
    return undefined;
  }
}

/** CS-08（2026-09-28 code review）：删库连带 -wal/-shm 伴生文件（SQLite 官方要求删库连同 WAL 一起——
 *  旧实现只删主库，残留 WAL 可能被重建库按 salt 链应用、混入上一化身的陈旧行）。force：不存在不炸；
 *  单个删不掉（占用等）不炸其余——调用方自有兜底。 */
export function removeSqliteDbFiles(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try { rmSync(f, { force: true }); } catch { /* 删不掉——fail-open 兜底在调用方 */ }
  }
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
    const sid = opts.sessionId ?? newId("s");
    // CS-12（2026-09-28 code review）：sessionId 直接进 join(this.dir, sid, "agents", "session.sqlite")——
    // 旧实现无格式校验，"../escaped" 类 id 构造即在桶外建目录建库（--resume 旗标无存在性闸直透此处）。不合形响亮抛错。
    if (!isSafeSessionId(sid)) throw new Error(`会话 id 非法：${JSON.stringify(sid)}（只许 [A-Za-z0-9._-] 且首字符为字母数字——防桶逃逸，CS-12）`);
    this.sessionId = sid;
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
