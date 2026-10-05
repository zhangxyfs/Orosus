import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { orosusHome } from "@orosus/contracts/home";
import { scanSessionFiles, type SessionFileEntry } from "./dir.ts";
import { openDatabase, removeSqliteDbFiles, sqliteAvailable } from "./sqlite.ts";

/** 定点清行（2026-10-05 空会话清理配套）：purgeSessionDir 删会话目录时顺带删该会话索引行+stamp——
 *  防悬空行与「同 sid 删了重建」的增量错位（/new 空会话就地刷新路径）。best-effort：库不在/失败 no-op。 */
export function dropEventIndex(dbFile: string, bucket: string, sessionId: string): void {
  if (!sqliteAvailable()) return;
  try {
    const db = openEventIndexDb(dbFile, false); // 不删库重建——清行口碰瞬时锁宁可跳过（悬空行有全库 sweep 兜底）
    if (db === undefined) return;
    try {
      db.exec("BEGIN");
      db.prepare("DELETE FROM event_index WHERE bucket = ? AND session_id = ?").run(bucket, sessionId);
      db.prepare("DELETE FROM event_index_files WHERE bucket = ? AND session_id = ?").run(bucket, sessionId);
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* 已不在事务 */ }
    } finally {
      try { db.close(); } catch { /* 已坏 */ }
    }
  } catch { /* 库打不开=无行可清 */ }
}

/** 索引库缺省落点单一解析点（T11 harness 装配与 CLI 列表接线共用——两处漂移即索引分裂）。 */
export function defaultEventIndexFile(): string {
  return join(orosusHome(), "db", "event-index.sqlite");
}

/** 事件索引（m5-resume-perf T6b，D12 混合形态）：`~/.orosus/db/event-index.sqlite`（独立库——与树索引
 *  session-tree.sqlite 同目录不共库，生命周期独立：删事件索引不牵连树索引、schema 演进互不干扰）。
 *  每会话记「事件序号 → 字节偏移/长度」——jsonl 文件是唯一事实源，本库随时可删可重建（索引是缓存）。
 *  行内容只存定位不存正文；坏损 = 删库重建（只删本库文件，绝不碰树索引）。
 *
 *  信封形态注记（嗅探依据）：SessionEvent 落盘 = JSON.stringify({...fields, v, id, parentId, seq, ts, type})
 *  ——payload 键在前、信封六键（v/id/parentId/seq/ts/type）恒在尾部且 type 是末键。方案借 cc 的
 *  `{"type":"` 行首前缀嗅探对我们序列化不成立（cc 行首才是 type）——改尾部锚定：`,"type":"tok"}` 恰在
 *  行尾 + `,"seq":N` 尾部定位，lastIndexOf 恒中信封键（payload 内同形子串必在信封键之前）。 */

/** 扫描产出的单行定位（offset/length 均不含行尾 \n——pread [offset, offset+length) 即行 JSON 字节）。
 *  bytes = 行内容拷贝（T7 嗅探装载按行选择性 parse 用——扫描器 chunk 复用，yield 视图会被下块覆写，
 *  必须拷贝；建索引侧忽略此字段）。 */
export interface ScanLine {
  byteOffset: number;
  byteLength: number;
  seq: number;
  type: string;
  bytes: Buffer;
}

/** 嗅探块大小（D11：cc TRANSCRIPT_READ_CHUNK_SIZE 同值 1MB）——扫描器按此分块前向读。 */
const SCAN_CHUNK = 1024 * 1024;

/** 行嗅探（不 JSON.parse 全文——建索引不付 parse 钱）：信封尾锚定取 seq/type；失败 = null（坏行/撕裂尾，
 *  调用方跳过不炸——torn tail 修复后下次刷新补齐）。b 为单行字节（不含 \n）。 */
export function sniffEventLine(b: Buffer): { seq: number; type: string } | undefined {
  const TYPE_MARK = ',"type":"';
  const tIdx = b.lastIndexOf(TYPE_MARK);
  if (tIdx < 0) return undefined;
  const tStart = tIdx + TYPE_MARK.length;
  const tEnd = b.indexOf(0x22 /* " */, tStart);
  if (tEnd < 0) return undefined;
  // type 必是末键：token 后紧跟 `}` 且 `}` 是行尾字节——payload 内伪形子串（后随信封真键）在此被拒
  if (tEnd + 2 !== b.length || b[tEnd + 1] !== 0x7d /* } */) return undefined;
  const SEQ_MARK = ',"seq":';
  const sIdx = b.lastIndexOf(SEQ_MARK);
  if (sIdx < 0 || sIdx > tIdx) return undefined; // seq 键在 type 前（信封序）
  let sNum = 0;
  let seen = false;
  for (let i = sIdx + SEQ_MARK.length; i < b.length; i++) {
    const c = b[i]!;
    if (c === 0x2c /* , */) break;
    if (c < 0x30 || c > 0x39) return undefined; // 非数字（引号串/对象等）——不是信封 seq
    sNum = sNum * 10 + (c - 0x30);
    seen = true;
  }
  if (!seen) return undefined;
  return { seq: sNum, type: b.toString("utf8", tStart, tEnd) };
}

/** 字节扫描器（T6b 建索引与 T7 嗅探备胎的共用件——一遍产出 (offset,length,seq,type) 流两用）：
 *  从 fromByte 起 1MB 块前向扫到 EOF，逐行（须以 \n 收尾——文件尾未闭合行不产出=撕裂尾不进流）
 *  嗅探信封尾部得 seq/type。文件打不开/读失败 = 空流（调用方容错）。 */
export function* scanEventLines(file: string, fromByte = 0): Generator<ScanLine, void, void> {
  let fd: number;
  let fileSize: number;
  try {
    fd = openSync(file, "r");
    fileSize = statSync(file).size;
  } catch {
    return;
  }
  try {
    let pos = fromByte;
    let carry = Buffer.alloc(0); // 跨块的行首半行
    let carryStart = pos; // carry 首字节的绝对位置
    const chunk = Buffer.alloc(SCAN_CHUNK);
    while (pos < fileSize) {
      const n = readSync(fd, chunk, 0, SCAN_CHUNK, pos);
      if (n <= 0) break;
      const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      const dataStart = carryStart;
      let lineStart = 0;
      let nl = data.indexOf(0x0a);
      while (nl !== -1) {
        if (nl > lineStart) { // 空行跳过（split("\n").filter(Boolean) 同口径）
          const line = data.subarray(lineStart, nl);
          const sniffed = sniffEventLine(line);
          if (sniffed !== undefined) {
            yield { byteOffset: dataStart + lineStart, byteLength: nl - lineStart, seq: sniffed.seq, type: sniffed.type, bytes: Buffer.from(line) };
          }
        }
        lineStart = nl + 1;
        nl = data.indexOf(0x0a, lineStart);
      }
      carry = Buffer.from(data.subarray(lineStart)); // 复制出剩余半行（chunk 会被下轮覆写）
      carryStart = dataStart + lineStart;
      pos += n;
    }
    // 文件尾无 \n 的半行：撕裂尾——不产出（不入索引不进备胎流；repairFile 修复后下次刷新补齐）
  } finally {
    closeSync(fd);
  }
}

/** 索引行写入侧（T7 嗅探路径「顺手建索引」的低层口：扫描流收齐后一次落库）。 */
export function writeEventRows(
  dbFile: string,
  bucket: string,
  sessionId: string,
  rows: ScanLine[],
  stamp: { mtimeMs: number; size: number; indexedBytes: number },
): void {
  if (!sqliteAvailable()) return;
  const db = openEventIndexDb(dbFile);
  if (db === undefined) return;
  try {
    db.exec("BEGIN");
    const del = db.prepare("DELETE FROM event_index WHERE bucket = ? AND session_id = ?");
    del.run(bucket, sessionId);
    const ins = db.prepare("INSERT INTO event_index (bucket, session_id, seq, type, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?, ?)");
    for (const r of rows) ins.run(bucket, sessionId, r.seq, r.type, r.byteOffset, r.byteLength);
    db.prepare("INSERT OR REPLACE INTO event_index_files (bucket, session_id, mtime_ms, size, indexed_bytes) VALUES (?, ?, ?, ?, ?)")
      .run(bucket, sessionId, stamp.mtimeMs, stamp.size, stamp.indexedBytes);
    db.exec("COMMIT");
  } catch {
    try { db.exec("ROLLBACK"); } catch { /* 已不在事务 */ }
  } finally {
    try { db.close(); } catch { /* 已坏 */ }
  }
}

/** 开库（懒建 schema；坏库 = 删本库文件重建——只删 event-index 相关文件，树索引不受牵连）。
 *  返回 undefined = 重试后仍打不开（目录不可写等）——调用方按无索引容错。 */
function openEventIndexDb(dbFile: string, allowRebuild = true): import("node:sqlite").DatabaseSync | undefined {
  const tryOpen = (): import("node:sqlite").DatabaseSync | undefined => {
    mkdirSync(dirname(dbFile), { recursive: true });
    const db = openDatabase(dbFile);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      db.exec(
        "CREATE TABLE IF NOT EXISTS event_index (" +
          "bucket TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL," +
          " byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL, PRIMARY KEY(bucket, session_id, seq));" +
        "CREATE INDEX IF NOT EXISTS idx_event_index_type ON event_index (bucket, session_id, type);" +
        "CREATE TABLE IF NOT EXISTS event_index_files (" +
          "bucket TEXT NOT NULL, session_id TEXT NOT NULL, mtime_ms REAL NOT NULL, size INTEGER NOT NULL," +
          " indexed_bytes INTEGER NOT NULL, PRIMARY KEY(bucket, session_id));",
      );
      return db;
    } catch (e) {
      // 坏库须先关句柄再抛——否则 Windows 下句柄泄漏挡住 rmSync、坏库删不掉（treeindex 同款实测坑）
      try { db.close(); } catch { /* 已坏 */ }
      throw e;
    }
  };
  try {
    return tryOpen();
  } catch (err) {
    // 瞬时锁（他进程写并发/检查点窗口）不删库——重建是空库，会把健康索引清零（treeindex CS-08
    // 「瞬时错误删掉健康索引」同教训）；只有真坏库（not a database 等形态错）才走删库重建
    const msg = err instanceof Error ? err.message : String(err);
    if (/busy|locked/i.test(msg)) return undefined;
    if (!allowRebuild) return undefined;
    removeSqliteDbFiles(dbFile); // 坏库重建（连 -wal/-shm——树索引同款先例；只删本库）
    try {
      return tryOpen();
    } catch {
      return undefined;
    }
  }
}

/** 增量刷新（D14 随用随补）：逐会话 mtime+size 双判——命中跳过；未命中按 indexed_bytes 续读到 EOF
 *  （文件只追加，追尾就行）；size 变小/会话首次入索引 = 重建该会话全部行；盘上消失的会话行删除。
 *  entries 缺省 = scanSessionFiles(root)（listSessions 时机全库补建的便捷口）。node:sqlite 不可用 = no-op。
 *  重建时机三分法的②（全库补建）走本口；①（装载路径单会话顺手建）在 T7 嗅探备胎里走 writeEventRows；
 *  ③（翻页单会话补建）走 indexSingleSession。 */
export async function refreshEventIndex(dbFile: string, root: string, entries?: SessionFileEntry[]): Promise<void> {
  if (!sqliteAvailable()) return;
  // 全库形态（entries 缺省）才做「盘上消失清扫」——显式条目 = 定向刷新（T11 装载预刷新 / 翻页追平
  // 的单会话形态），清扫按「不在条目集 = 已消失」会把其余全会话的行误删（2026-10-05 用户实机：
  // 索引只剩一个会话——最后打开的那个）。
  const fullScan = entries === undefined;
  const list = entries ?? scanSessionFiles(root);
  const db = openEventIndexDb(dbFile);
  if (db === undefined) return;
  try {
    const stamps = new Map(
      (db.prepare("SELECT bucket, session_id, mtime_ms, size, indexed_bytes FROM event_index_files").all() as {
        bucket: string; session_id: string; mtime_ms: number; size: number; indexed_bytes: number;
      }[]).map((r) => [`${r.bucket}/${r.session_id}`, r]),
    );
    db.exec("BEGIN");
    const del = db.prepare("DELETE FROM event_index WHERE bucket = ? AND session_id = ?");
    const delStamp = db.prepare("DELETE FROM event_index_files WHERE bucket = ? AND session_id = ?");
    const ins = db.prepare("INSERT OR REPLACE INTO event_index (bucket, session_id, seq, type, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?, ?)");
    const stampUp = db.prepare("INSERT OR REPLACE INTO event_index_files (bucket, session_id, mtime_ms, size, indexed_bytes) VALUES (?, ?, ?, ?, ?)");
    const onDisk = new Set<string>();
    for (const entry of list) {
      const key = `${entry.bucket}/${entry.id}`;
      onDisk.add(key);
      const st = stamps.get(key);
      if (st !== undefined && st.mtime_ms === entry.mtimeMs && st.size === entry.size) continue; // 双判命中 → 整会话跳过
      // 首次 / mtime 变更：仅「纯增长」走增量续读（append-only 常态）；缩短（外物截断/删行）或
      // 同尺寸变动（同长度编辑——锚行不动但中段内容已换）一律该会话行全量重建
      let fromByte = st === undefined || entry.size <= st.indexed_bytes ? 0 : st.indexed_bytes;
      // 锚行校验（2026-10-05 空会话清理问答修）：增量续读前 pread 最后一行验 seq/type 与行记录一致——
      // 不符=文件被重写（同 sid 删了重建 / 外物改写）而非纯追加，从 0 重建（旧行偏移全部作废）
      if (fromByte > 0) {
        const lastRow = db.prepare(
          "SELECT seq, type, byte_offset, byte_length FROM event_index WHERE bucket = ? AND session_id = ? ORDER BY byte_offset DESC LIMIT 1",
        ).get(entry.bucket, entry.id) as { seq: number; type: string; byte_offset: number; byte_length: number } | undefined;
        let anchorOk = false;
        if (lastRow !== undefined) {
          try {
            const fd = openSync(entry.file, "r");
            try {
              const buf = Buffer.alloc(lastRow.byte_length);
              if (readSync(fd, buf, 0, lastRow.byte_length, lastRow.byte_offset) === lastRow.byte_length) {
                const sniffed = sniffEventLine(buf);
                anchorOk = sniffed !== undefined && sniffed.seq === lastRow.seq && sniffed.type === lastRow.type;
              }
            } finally {
              closeSync(fd);
            }
          } catch { anchorOk = false; }
        }
        if (!anchorOk) fromByte = 0;
      }
      if (fromByte === 0) del.run(entry.bucket, entry.id);
      let consumedTo = fromByte;
      for (const line of scanEventLines(entry.file, fromByte)) {
        ins.run(entry.bucket, entry.id, line.seq, line.type, line.byteOffset, line.byteLength);
        consumedTo = line.byteOffset + line.byteLength + 1; // +1 = 行尾 \n
      }
      stampUp.run(entry.bucket, entry.id, entry.mtimeMs, entry.size, consumedTo);
    }
    if (fullScan) {
      for (const key of stamps.keys()) {
        if (onDisk.has(key)) continue;
        const slash = key.indexOf("/");
        const bucket = key.slice(0, slash);
        const sid = key.slice(slash + 1); // bucket 是 basename 无斜杠，余段全归 sid
        del.run(bucket, sid);
        delStamp.run(bucket, sid);
      }
    }
    db.exec("COMMIT");
  } catch {
    try { db.exec("ROLLBACK"); } catch { /* 已不在事务 */ }
  } finally {
    try { db.close(); } catch { /* 已关/已坏 */ }
  }
}

/** 单会话即时补建（D14 时机③——T14 翻页恰好无索引时的一次性兜底；几百 ms 级字节扫描）。 */
export function indexSingleSession(dbFile: string, bucket: string, sessionId: string, file: string): void {
  if (!sqliteAvailable()) return;
  let st: { mtimeMs: number; size: number };
  try {
    const s = statSync(file);
    st = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return;
  }
  const rows = [...scanEventLines(file, 0)];
  const consumedTo = rows.length > 0 ? rows[rows.length - 1]!.byteOffset + rows[rows.length - 1]!.byteLength + 1 : 0;
  writeEventRows(dbFile, bucket, sessionId, rows, { ...st, indexedBytes: consumedTo });
}

// ---------- T6c 查询口（装载定位 + 翻页取段） ----------

/** 查询用只读开库：只读避免读路径写副作用（readSqliteHead 同口径）；库不在/打不开 = undefined
 *  （调用方按无索引容错——T7 降级嗅探、T14 当场补建）。 */
function openEventIndexQuery(dbFile: string): import("node:sqlite").DatabaseSync | undefined {
  if (!sqliteAvailable()) return undefined;
  try {
    const db = openDatabase(dbFile, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  } catch {
    return undefined;
  }
}

export interface IndexedSegment {
  byteOffset: number;
  byteLength: number;
  /** 段首行 seq（段内行可由调用方 split 后自增）。 */
  seq: number;
}

/** 行序列 → 连续字节段（qwen readSegmentRecords 同款手法：相邻行 offset 邻接则并成大段，减少 pread
 *  次数）。byteLength 含段内行尾 \n（pread 后 split("\\n") 即行集）；不邻接处（跳过的坏行/间隙）切段。 */
function mergeSegments(rows: { seq: number; byte_offset: number; byte_length: number }[]): IndexedSegment[] {
  const segs: IndexedSegment[] = [];
  for (const r of rows) {
    const last = segs[segs.length - 1];
    if (last !== undefined && r.byte_offset === last.byteOffset + last.byteLength) {
      last.byteLength += r.byte_length + 1; // +1 = 该行尾 \n
    } else {
      segs.push({ byteOffset: r.byte_offset, byteLength: r.byte_length + 1, seq: r.seq });
    }
  }
  return segs;
}

/** 最后压缩点（T7 索引路径的窗口定位口）：type='turn/compaction' 取最大 seq 行 + pread 该单行判
 *  keptUsers 在场性得 v4（在场性判版本——v:1 后置覆盖坑在档）。file = 会话 jsonl 路径（索引只存
 *  bucket/sid 不存路径——调用方装载时本来就持有）。无压缩/库不可用/单行读失败/parse 失败 = undefined
 *  （调用方降级：索引 miss 走前向嗅探备胎——索引漂移的 pread 坏行同样落此，装载永不因索引坏而死）。 */
export function lastCompaction(dbFile: string, bucket: string, sessionId: string, file: string): { byteOffset: number; seq: number; v4: boolean } | undefined {
  const db = openEventIndexQuery(dbFile);
  if (db === undefined) return undefined;
  try {
    const row = db.prepare(
      "SELECT seq, byte_offset, byte_length FROM event_index WHERE bucket = ? AND session_id = ? AND type = 'turn/compaction' ORDER BY seq DESC LIMIT 1",
    ).get(bucket, sessionId) as { seq: number; byte_offset: number; byte_length: number } | undefined;
    if (row === undefined) return undefined;
    try {
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(row.byte_length);
        const n = readSync(fd, buf, 0, row.byte_length, row.byte_offset);
        if (n !== row.byte_length) return undefined; // 文件变短 = 索引漂移
        const parsed = JSON.parse(buf.toString("utf8")) as { type?: string; keptUsers?: unknown };
        if (parsed.type !== "turn/compaction") return undefined; // 行内容与索引类型不符 = 漂移
        return { byteOffset: row.byte_offset, seq: row.seq, v4: Array.isArray(parsed.keptUsers) };
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
  } finally {
    try { db.close(); } catch { /* 已关 */ }
  }
}

/** 尾段取读（T7 索引路径的装载口）：fromSeq 起到 EOF 的行按连续字节段返回（相邻行合并成大段减少
 *  pread 次数——qwen reader 同款）。索引不可用/会话无行 = 空数组（调用方降级）。 */
export function eventsFrom(dbFile: string, bucket: string, sessionId: string, fromSeq: number): IndexedSegment[] {
  const db = openEventIndexQuery(dbFile);
  if (db === undefined) return [];
  try {
    const rows = db.prepare(
      "SELECT seq, byte_offset, byte_length FROM event_index WHERE bucket = ? AND session_id = ? AND seq >= ? ORDER BY seq",
    ).all(bucket, sessionId, fromSeq) as unknown as { seq: number; byte_offset: number; byte_length: number }[];
    return mergeSegments(rows);
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* 已关 */ }
  }
}

/** 向上翻页取段（T14 懒分页口）：seq < beforeSeq 降序取 limitEvents 条、按升序返回（头部插页序），
 *  同样合并连续段。翻过头（beforeSeq 之前无行）= 空数组 = 「已到会话开头」。不设压缩边界——
 *  D13 定案：翻页可跨压缩行取压缩前原文。 */
export function eventsBefore(dbFile: string, bucket: string, sessionId: string, beforeSeq: number, limitEvents: number): IndexedSegment[] {
  const db = openEventIndexQuery(dbFile);
  if (db === undefined) return [];
  try {
    const rows = (db.prepare(
      "SELECT seq, byte_offset, byte_length FROM event_index WHERE bucket = ? AND session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
    ).all(bucket, sessionId, beforeSeq, limitEvents) as unknown as { seq: number; byte_offset: number; byte_length: number }[]).reverse();
    return mergeSegments(rows);
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* 已关 */ }
  }
}
