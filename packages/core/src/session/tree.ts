import { readFileSync, statSync } from "node:fs";
import type { SessionTreeNode } from "@orosus/contracts/module";
import { scanBucketSessions } from "./dir.ts";
import { openDatabase, sqliteAvailable } from "./sqlite.ts";

/** 预算读件（会话树批 T7 从 apps/cli/sessions.ts readTitle 下沉 core——core 禁反向 import apps，
 *  树构建与 CLI 列表共用同一实现）：64 行或 16KB 先到先赢（M4-2.5 T2 日志调研 P5——标题尽力而为、
 *  列表速度优先）。ownLines 恒为全文件非空行真值（设计空白 8：行数要真，与预算独立——大文件的重复
 *  全读代价由 T9 索引的 mtime+size 增量刷新吸收）。 */
const HEAD_MAX_LINES = 64;
const HEAD_MAX_BYTES = 16 * 1024;

export interface SessionHead {
  /** 会话名（最后一个 session/label；未命名 = undefined——树快照契约「显示侧自定」）。 */
  label?: string;
  /** 首个 user/message 文本截断（标题兜底；≤20 字符）。 */
  firstUser?: string;
  /** header.parentSession（根会话 = null；文件无 header = undefined——坏文件跳过用）。 */
  parentSession?: string | null;
  /** session/fork.sourceEntryId（fork 子体的分叉点；根会话 = null）。 */
  sourceEntryId?: string | null;
  /** 全文件非空行数（自身事件条数真值）。 */
  ownLines: number;
}

/** 读会话文件头部元数据（jsonl 读法，T7）：一次读全文，元数据解析限预算内、行数恒真。
 *  文件不可读（不存在/损坏）= undefined。 */
export function readSessionHead(file: string): SessionHead | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const allLines = raw.split("\n").filter((l) => l !== "");
  const head: SessionHead = { ownLines: allLines.length, sourceEntryId: null }; // 无 session/fork（根会话）= null；有则覆盖
  let lines = 0;
  let bytes = 0;
  for (const line of allLines) {
    lines++;
    bytes += line.length;
    if (lines > HEAD_MAX_LINES || bytes > HEAD_MAX_BYTES) break; // 元数据解析预算硬上限（行数已在上面取真值）
    let e: { type?: string; label?: unknown; content?: unknown; parentSession?: unknown; sourceEntryId?: unknown };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue; // torn tail 坏行跳过
    }
    if (e.type === "session/header") {
      if (head.parentSession === undefined) head.parentSession = typeof e.parentSession === "string" ? e.parentSession : null;
    }
    if (e.type === "session/fork") head.sourceEntryId = typeof e.sourceEntryId === "string" ? e.sourceEntryId : null;
    if (e.type === "session/label" && typeof e.label === "string" && e.label !== "") head.label = e.label;
    if (head.firstUser === undefined && e.type === "user/message") {
      const parts = (e.content ?? []) as { kind?: string; text?: string }[];
      const text = parts.filter((p) => p.kind !== "reasoning").map((p) => p.text ?? "").join("").replace(/\s+/g, " ").trim();
      if (text !== "") head.firstUser = text.slice(0, 20);
    }
  }
  return head;
}

/** sqlite 读法（会话树批 T8，决策点 15）：开库四查——header（parentSession）/ session/fork
 *  （sourceEntryId）/ 末条 session/label / COUNT(*)（自身事件数）。库打不开/表不存在/查询报错 =
 *  undefined（该节点跳过 + 与「孤立节点保留」同族口径——不炸整体）。 */
export function readSqliteHead(file: string): SessionHead | undefined {
  if (!sqliteAvailable()) return undefined;
  try {
    const db = openDatabase(file);
    try {
      const query = (sql: string): Record<string, unknown> | undefined =>
        db.prepare(sql).get() as Record<string, unknown> | undefined;
      const header = query("SELECT json FROM events WHERE type = 'session/header' ORDER BY seq LIMIT 1");
      if (header === undefined) return undefined; // 无 header = 坏库/空库，与 jsonl 坏文件同跳过
      const h = JSON.parse(String(header.json)) as { parentSession?: unknown };
      const fork = query("SELECT json FROM events WHERE type = 'session/fork' ORDER BY seq LIMIT 1");
      const forkFields = fork !== undefined ? JSON.parse(String(fork.json)) as { sourceEntryId?: unknown } : undefined;
      const labelRow = query("SELECT json FROM events WHERE type = 'session/label' ORDER BY seq DESC LIMIT 1");
      const labelFields = labelRow !== undefined ? JSON.parse(String(labelRow.json)) as { label?: unknown } : undefined;
      const userRow = query("SELECT json FROM events WHERE type = 'user/message' ORDER BY seq LIMIT 1");
      const userFields = userRow !== undefined ? JSON.parse(String(userRow.json)) as { content?: unknown } : undefined;
      const count = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
      let firstUser: string | undefined;
      if (userFields !== undefined) {
        const parts = (userFields.content ?? []) as { kind?: string; text?: string }[];
        const text = parts.filter((p) => p.kind !== "reasoning").map((p) => p.text ?? "").join("").replace(/\s+/g, " ").trim();
        if (text !== "") firstUser = text.slice(0, 20);
      }
      return {
        ...(labelFields !== undefined && typeof labelFields.label === "string" && labelFields.label !== "" ? { label: labelFields.label } : {}),
        ...(firstUser !== undefined ? { firstUser } : {}),
        parentSession: typeof h.parentSession === "string" ? h.parentSession : null,
        sourceEntryId: forkFields !== undefined && typeof forkFields.sourceEntryId === "string" ? forkFields.sourceEntryId : null,
        ownLines: count.n,
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined; // 库打不开/表不存在/损坏——该节点跳过（缓存 fail-open 同族口径）
  }
}

/** 由扫描条目构造树节点（会话树批 T9 抽出——buildSessionTree 与 TreeIndex 的重读源/纯读兜底共用）。
 *  读法按主文件名分派（T8）：session.jsonl 文本行读 / session.sqlite 开库查询；坏文件 = undefined 跳过。 */
export function nodeFromEntry(entry: { id: string; file: string; mtimeMs: number }): SessionTreeNode | undefined {
  const head = entry.file.endsWith(".sqlite") ? readSqliteHead(entry.file) : readSessionHead(entry.file);
  if (head === undefined || head.parentSession === undefined) return undefined;
  let createdAtMs = entry.mtimeMs;
  try {
    const b = statSync(entry.file).birthtimeMs; // listSessions 手法：min(birth, mtime)——「创建早于一切修改」
    if (b > 0 && Number.isFinite(b)) createdAtMs = Math.min(b, entry.mtimeMs);
  } catch { /* mtime 回退 */ }
  return {
    sessionId: entry.id,
    parentSession: head.parentSession,
    sourceEntryId: head.sourceEntryId ?? null,
    ...(head.label !== undefined ? { label: head.label } : {}),
    createdAtMs,
    updatedAtMs: entry.mtimeMs,
    ownEvents: head.ownLines,
  };
}

/** 构建当前项目桶的全量树快照（会话树批 T7——缝二内核半边）：扫描 + 每会话读元数据，现读现建。
 *  会话文件是唯一事实源；孤立节点（parentSession 指向的会话不在扫描集——含存量跨桶链的他桶父）
 *  原样返回不修复不剔除（树视图标记「根缺失」）。只扫传入桶（#17 项目内封闭——调用方传当前项目桶）。
 *  读法按主文件名分派（T8）：session.jsonl 文本行读 / session.sqlite 开库查询；坏文件跳过。 */
export async function buildSessionTree(bucketDir: string): Promise<SessionTreeNode[]> {
  const nodes: SessionTreeNode[] = [];
  for (const entry of scanBucketSessions(bucketDir)) {
    const node = nodeFromEntry(entry);
    if (node !== undefined) nodes.push(node);
  }
  return nodes;
}
