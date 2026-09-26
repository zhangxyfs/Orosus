import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionTreeNode } from "@orosus/contracts/module";
import { scanSessionFiles } from "./dir.ts";
import { openDatabase, sqliteAvailable } from "./sqlite.ts";
import { nodeFromEntry } from "./tree.ts";

interface NodeRow {
  session_id: string;
  bucket: string;
  parent_session: string | null;
  source_entry_id: string | null;
  label: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  own_events: number;
  mtime_ms: number;
  size: number;
}

const rowToNode = (r: NodeRow): SessionTreeNode => ({
  sessionId: r.session_id,
  parentSession: r.parent_session,
  sourceEntryId: r.source_entry_id,
  ...(r.label !== null ? { label: r.label } : {}),
  createdAtMs: r.created_at_ms,
  updatedAtMs: r.updated_at_ms,
  ownEvents: r.own_events,
});

/** 树索引缓存（会话树批 T9，决策点 14）：`~/.orosus/db/session-tree.sqlite`（node:sqlite）——
 *  会话文件是唯一事实源，本库随时可删可重建（全局约束 8：索引是缓存不是事实源）。
 *  刷新 = scanSessionFiles 全扫 + 每文件 mtime+size 双判据增量（没变读缓存、变了重读该文件源——
 *  设计空白 14；「行数要真」的重复全读代价由本缓存吸收，这正是索引库的存在理由）；
 *  扫描后不在盘上的行删除；库打不开/查询报错 = 删文件重建（缓存 fail-open，绝不阻塞 tree()）；
 *  node:sqlite 不可用（probe 注入 false 或运行时缺失）= 整层跳过走纯读（设计空白 13）。
 *  决策点 17：索引全域维护（全桶建缓存）、refresh 查询按 opts.bucket 桶名过滤——换目录工作不重灌。 */
export class TreeIndex {
  private readonly file: string;
  private readonly probe: () => boolean;

  constructor(opts: { file: string; probe?: () => boolean }) {
    this.file = opts.file;
    this.probe = opts.probe ?? sqliteAvailable;
  }

  private open(): import("node:sqlite").DatabaseSync {
    mkdirSync(dirname(this.file), { recursive: true }); // ~/.orosus/db/ 首用懒建（设计空白 13）
    const db = openDatabase(this.file);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;"); // SqliteSessionStore 同款 pragma
      db.exec(
        "CREATE TABLE IF NOT EXISTS nodes (" +
          "session_id TEXT PRIMARY KEY, bucket TEXT NOT NULL, parent_session TEXT, source_entry_id TEXT, label TEXT," +
          " created_at_ms REAL NOT NULL, updated_at_ms REAL NOT NULL, own_events INTEGER NOT NULL," +
          " mtime_ms REAL NOT NULL, size INTEGER NOT NULL)",
      );
      return db;
    } catch (e) {
      // exec 炸（坏库）须先关句柄再抛——否则 Windows 下句柄泄漏挡住 rmSync、坏库删不掉（实测坑）
      try { db.close(); } catch { /* 已坏 */ }
      throw e;
    }
  }

  /** 纯读路径（probe 不可用 / 库失败兜底）：直读源出节点。 */
  private async pureRead(root: string, bucket?: string): Promise<SessionTreeNode[]> {
    const nodes: SessionTreeNode[] = [];
    for (const entry of scanSessionFiles(root)) {
      if (bucket !== undefined && entry.bucket !== bucket) continue;
      const node = nodeFromEntry(entry);
      if (node !== undefined) nodes.push(node);
    }
    return nodes;
  }

  /** 刷新缓存并返回节点清单（opts.bucket = 桶名过滤——#17 索引全域维护、查询按当前桶；缺省全量）。 */
  async refresh(root: string, opts?: { bucket?: string }): Promise<SessionTreeNode[]> {
    if (!this.probe()) return this.pureRead(root, opts?.bucket); // 设计空白 13：整层跳过
    let db: import("node:sqlite").DatabaseSync | undefined;
    try {
      db = this.open();
      const entries = scanSessionFiles(root);
      const cached = new Map(
        (db.prepare("SELECT session_id, mtime_ms, size FROM nodes").all() as { session_id: string; mtime_ms: number; size: number }[])
          .map((r) => [r.session_id, r]),
      );
      const upsert = db.prepare(
        "INSERT OR REPLACE INTO nodes (session_id, bucket, parent_session, source_entry_id, label, created_at_ms, updated_at_ms, own_events, mtime_ms, size)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const onDisk = new Set<string>();
      for (const entry of entries) {
        onDisk.add(entry.id);
        const c = cached.get(entry.id);
        if (c !== undefined && c.mtime_ms === entry.mtimeMs && c.size === entry.size) continue; // 双判据命中 → 读缓存
        const node = nodeFromEntry(entry); // 变了/新会话 → 重读源
        if (node === undefined) continue;
        upsert.run(
          node.sessionId, entry.bucket, node.parentSession, node.sourceEntryId, node.label ?? null,
          node.createdAtMs, node.updatedAtMs, node.ownEvents, entry.mtimeMs, entry.size,
        );
      }
      const stale = [...cached.keys()].filter((id) => !onDisk.has(id)); // 盘上不在 → 行删除
      if (stale.length > 0) {
        const del = db.prepare("DELETE FROM nodes WHERE session_id = ?");
        for (const id of stale) del.run(id);
      }
      const rows = db.prepare("SELECT * FROM nodes").all() as unknown as NodeRow[];
      return rows.filter((r) => opts?.bucket === undefined || r.bucket === opts.bucket).map(rowToNode);
    } catch {
      // 库打不开/查询报错 = 删文件重建（fail-open）：本次纯读返回 + 全量灌进重建库——下次 refresh 走缓存路径
      try { db?.close(); } catch { /* 已坏 */ }
      try { rmSync(this.file, { force: true }); } catch { /* 删不掉（占用等）——纯读兜底已保证返回 */ }
      const nodes = await this.pureRead(root, opts?.bucket);
      try {
        db = this.open();
        const upsert = db.prepare(
          "INSERT OR REPLACE INTO nodes (session_id, bucket, parent_session, source_entry_id, label, created_at_ms, updated_at_ms, own_events, mtime_ms, size)" +
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const entry of scanSessionFiles(root)) {
          const node = nodeFromEntry(entry);
          if (node === undefined) continue;
          upsert.run(
            node.sessionId, entry.bucket, node.parentSession, node.sourceEntryId, node.label ?? null,
            node.createdAtMs, node.updatedAtMs, node.ownEvents, entry.mtimeMs, entry.size,
          );
        }
      } catch { /* 重建/灌缓存失败（目录不可写等）——纯读兜底已保证返回 */ }
      return nodes;
    } finally {
      try { db?.close(); } catch { /* 已关/已坏 */ }
    }
  }
}
