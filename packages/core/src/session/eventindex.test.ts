import { describe, it, expect, afterEach, vi } from "vitest";
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "./jsonl.ts";
import { eventsBefore, eventsFrom, lastCompaction, refreshEventIndex, scanEventLines, sniffEventLine, writeEventRows } from "./eventindex.ts";
import { openDatabase, setSqliteProbeForTest, sqliteAvailable } from "./sqlite.ts";
import type { SessionFileEntry } from "./dir.ts";

// T6b（m5-resume-perf）读位置审计：node:fs ESM 命名空间不可 spyOn——部分替换 mock 包装 readFileSync/
// readSync 记账（行为零变化；增量追平断言「只读新增尾」的数据源）。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: vi.fn(actual.readSync),
  };
});

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const tmp = (name = "evix"): string => (dir = mkdtempSync(join(tmpdir(), `orosus-${name}-`)));

/** 真实信封夹具：JsonlSessionStore 落盘（嗅探依赖信封尾键 seq/type——真实序列化保证）。 */
async function seedSession(bucketDir: string, sid: string, count: number): Promise<{ file: string; entry: SessionFileEntry }> {
  const s = new JsonlSessionStore({ dir: bucketDir, sessionId: sid });
  await s.append("session/header", { format: 1, cwd: "/r", parentSession: null });
  for (let i = 0; i < count - 1; i++) {
    await s.append(i % 2 === 0 ? "user/message" : "assistant/message", { content: [{ kind: "text", text: `m${i}` }] });
  }
  await s.flush();
  const file = join(bucketDir, sid, "agents", "session.jsonl");
  await s.close();
  const st = statSync(file);
  return { file, entry: { id: sid, file, dir: bucketDir, mtimeMs: st.mtimeMs, size: st.size, bucket: "bk" } };
}

const rowsOf = (dbFile: string): { seq: number; type: string; byte_offset: number; byte_length: number }[] => {
  const db = openDatabase(dbFile);
  try {
    return db.prepare("SELECT seq, type, byte_offset, byte_length FROM event_index ORDER BY seq").all() as unknown as { seq: number; type: string; byte_offset: number; byte_length: number }[];
  } finally {
    db.close();
  }
};

const forwardMtime = (file: string): void => {
  const future = new Date(Date.now() + 5000);
  utimesSync(file, future, future);
};

describe.skipIf(!sqliteAvailable())("T6b m5-resume-perf: 事件索引 schema 与增量刷新", () => {
  it("a. 首建：多事件会话全量入索引——offset/length 与真实字节对得上（按索引 pread 回读逐行 JSON.parse 成功、seq/type 吻合）", async () => {
    const d = tmp();
    const dbFile = join(d, "event-index.sqlite");
    const { file, entry } = await seedSession(d, "s_a", 6);
    await refreshEventIndex(dbFile, d, [entry]);
    const rows = rowsOf(dbFile);
    expect(rows).toHaveLength(6);
    expect(rows[0]!.type).toBe("session/header");
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const fd = openSync(file, "r");
    try {
      for (const r of rows) {
        const buf = Buffer.alloc(r.byte_length);
        readSync(fd, buf, 0, r.byte_length, r.byte_offset);
        const e = JSON.parse(buf.toString("utf8")) as { seq: number; type: string };
        expect(e.seq).toBe(r.seq); // 索引定位 → 读回即整行（字节账对得上）
        expect(e.type).toBe(r.type);
      }
    } finally {
      closeSync(fd);
    }
  });

  it("b. 增量追平：append 十行后再刷只读新增尾（readSync 首位置=已索引位）且旧行不动", async () => {
    const d = tmp();
    const dbFile = join(d, "event-index.sqlite");
    const { file, entry } = await seedSession(d, "s_b", 5);
    await refreshEventIndex(dbFile, d, [entry]);
    const first = rowsOf(dbFile);
    expect(first).toHaveLength(5);
    // append 十行（真实信封——手写行保证信封尾键形态）
    for (let i = 0; i < 10; i++) {
      appendFileSync(file, JSON.stringify({ content: [], v: 1, id: `e_x${i}`, parentId: "e_prev", seq: 6 + i, ts: "t", type: "assistant/chunk" }) + "\n");
    }
    forwardMtime(file);
    const st2 = statSync(file);
    vi.mocked(readSync).mockClear();
    await refreshEventIndex(dbFile, d, [{ ...entry, mtimeMs: st2.mtimeMs, size: st2.size }]);
    // 只读新尾：本次扫描的 readSync 首位置 = 旧行末尾之后（旧行零重读）
    const calls = vi.mocked(readSync).mock.calls as unknown as unknown[][];
    const positions = calls.map((c) => c[4]).filter((v): v is number => typeof v === "number");
    expect(positions.length).toBeGreaterThan(0);
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(first[4]!.byte_offset + first[4]!.byte_length + 1);
    const second = rowsOf(dbFile);
    expect(second).toHaveLength(15); // 旧行 + 新十行
    expect(second.slice(0, 5)).toEqual(first); // 旧行不动
  });

  it("c. size 变小（截断/重写）→ 该会话行全量重建（无陈旧行残留）", async () => {
    const d = tmp();
    const dbFile = join(d, "event-index.sqlite");
    const { file, entry } = await seedSession(d, "s_c", 6);
    await refreshEventIndex(dbFile, d, [entry]);
    expect(rowsOf(dbFile)).toHaveLength(6);
    // 截断回 2 行
    const content = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, 2);
    writeFileSync(file, content.join("\n") + "\n");
    forwardMtime(file);
    const st2 = statSync(file);
    await refreshEventIndex(dbFile, d, [{ ...entry, mtimeMs: st2.mtimeMs, size: st2.size }]);
    const rows = rowsOf(dbFile);
    expect(rows).toHaveLength(2); // 重建 = 只剩新内容的行（旧 3..6 行被删）
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("d. 坏行容错：torn tail（无尾换行的半行）不入索引不炸；修复后下次刷新补齐", async () => {
    const d = tmp();
    const dbFile = join(d, "event-index.sqlite");
    const { file, entry } = await seedSession(d, "s_d", 4);
    appendFileSync(file, '{"content":[],"v":1,"id":"e_torn","parentId":"e_x","seq":5,"ts":"t","typ'); // 撕裂尾
    forwardMtime(file);
    const st1 = statSync(file);
    await refreshEventIndex(dbFile, d, [{ ...entry, mtimeMs: st1.mtimeMs, size: st1.size }]);
    expect(rowsOf(dbFile)).toHaveLength(4); // 撕裂行不入索引
    // 「修复」：截掉撕裂尾、补一条完好行
    const good = readFileSync(file, "utf8").split("\n").filter((l) => l !== "" && !l.includes("e_torn"));
    writeFileSync(file, good.join("\n") + "\n" + JSON.stringify({ kind: "completed", v: 1, id: "e_fix", parentId: "e_prev", seq: 5, ts: "t", type: "turn/end" }) + "\n");
    forwardMtime(file);
    const st2 = statSync(file);
    await refreshEventIndex(dbFile, d, [{ ...entry, mtimeMs: st2.mtimeMs, size: st2.size }]);
    const rows = rowsOf(dbFile);
    expect(rows).toHaveLength(5);
    expect(rows[4]!.type).toBe("turn/end");
  });

  it("e. 重建幂等：两次首建（删库后）行集一致", async () => {
    const d = tmp();
    const dbFile = join(d, "event-index.sqlite");
    const { entry } = await seedSession(d, "s_e", 7);
    await refreshEventIndex(dbFile, d, [entry]);
    const first = rowsOf(dbFile);
    rmSync(dbFile, { force: true });
    await refreshEventIndex(join(d, "event-index.sqlite"), d, [entry]);
    expect(rowsOf(dbFile)).toEqual(first);
  });

  it("f. 坏库重建：库文件写垃圾 → refresh 不炸、删库重建成功", async () => {
    const d = tmp();
    const dbFile = join(d, "event-index.sqlite");
    const { entry } = await seedSession(d, "s_f", 3);
    writeFileSync(dbFile, "this is not a sqlite database at all");
    await refreshEventIndex(dbFile, d, [entry]);
    expect(rowsOf(dbFile)).toHaveLength(3);
  });

  it("g. 盘上消失的会话行删除（stale sweep——仅全库形态：entries 缺省走 scanSessionFiles）", async () => {
    const d = tmp();
    const dbFile = join(d, "event-index.sqlite");
    // 双层布局（root/bucket/<sid>/agents/…）——scanSessionFiles 的真实视角
    const bucket = join(d, "bk");
    const a = await seedSession(bucket, "s_g1", 3);
    const b = await seedSession(bucket, "s_g2", 4);
    await refreshEventIndex(dbFile, d); // 全库形态：扫到两会话
    expect(rowsOf(dbFile)).toHaveLength(7);
    rmSync(join(bucket, "s_g1"), { recursive: true, force: true });
    await refreshEventIndex(dbFile, d); // 再全库——s_g1 盘上消失，行被清扫
    expect(rowsOf(dbFile)).toHaveLength(4);
  });

  it("g2. 定向刷新（显式条目）不清扫他会话——2026-10-05 用户实机「索引只剩一个会话」的根因钉", async () => {
    const d = tmp();
    const dbFile = join(d, "event-index.sqlite");
    const bucket = join(d, "bk");
    const a = await seedSession(bucket, "s_a", 3);
    const b = await seedSession(bucket, "s_b", 4);
    await refreshEventIndex(dbFile, d); // 全库：两会话都入索引
    expect(rowsOf(dbFile)).toHaveLength(7);
    // T11 装载预刷新 / 翻页追平的单会话形态：显式条目只刷自己——他会话行必须存活
    forwardMtime(a.file);
    const st = statSync(a.file);
    await refreshEventIndex(dbFile, d, [{ ...a.entry, mtimeMs: st.mtimeMs, size: st.size }]);
    expect(rowsOf(dbFile)).toHaveLength(7); // b 的 4 行没被误删（旧实现此处=3 行）
  });

  it("h. writeEventRows（T7 嗅探路径顺手建索引的低层口）：覆盖式落行 + stamp", async () => {
    const d = tmp();
    const dbFile = join(d, "event-index.sqlite");
    const { file } = await seedSession(d, "s_h", 3);
    const rows = [...scanEventLines(file)];
    expect(rows).toHaveLength(3); // 公开扫描器同口径
    writeEventRows(dbFile, "bk", "s_h", rows.slice(0, 2), { mtimeMs: 1, size: 2, indexedBytes: rows[1]!.byteOffset + rows[1]!.byteLength + 1 });
    expect(rowsOf(dbFile)).toHaveLength(2);
  });

  it("i. sqlite 不可用 → refresh no-op 不炸（probe 注入 false）", async () => {
    const d = tmp();
    const dbFile = join(d, "event-index.sqlite");
    const { entry } = await seedSession(d, "s_i", 3);
    setSqliteProbeForTest(() => false);
    try {
      await refreshEventIndex(dbFile, d, [entry]);
    } finally {
      setSqliteProbeForTest();
    }
  });
});

describe("T6b sniffEventLine（信封尾锚定嗅探——纯函数）", () => {
  it("真实信封形态（payload 前、信封六键后、type 末键）嗅出 seq/type；payload 内伪形子串被拒", () => {
    const line = Buffer.from(JSON.stringify({ content: [{ kind: "text", text: '含 ,"type":"fake"} 伪形' }], v: 1, id: "e_1", parentId: null, seq: 42, ts: "t", type: "user/message" }));
    const r = sniffEventLine(line)!;
    expect(r).toEqual({ seq: 42, type: "user/message" });
    // 无 type 键 / 半截 JSON → undefined
    expect(sniffEventLine(Buffer.from('{"a":1,"v":1}'))).toBeUndefined();
    expect(sniffEventLine(Buffer.from('{"v":1,"id":"x","parentId":null,"seq":1,"ts":"t","typ'))).toBeUndefined();
    // type 非末键（后随他键）→ undefined（信封形态破坏）
    expect(sniffEventLine(Buffer.from('{"v":1,"type":"x","extra":1}'))).toBeUndefined();
  });
});

describe.skipIf(!sqliteAvailable())("T6c m5-resume-perf: 索引查询口（压缩点定位 / 尾段取读 / 向上翻页取段）", () => {
  it("① 无压缩 → undefined；多压缩点取最后（最大 seq）且 v4 判定正确（keptUsers 在场性）", async () => {
    const d = tmp("evixc");
    const dbFile = join(d, "event-index.sqlite");
    const s = new JsonlSessionStore({ dir: d, sessionId: "s_q1" });
    await s.append("session/header", { cwd: "/r", parentSession: null });
    await s.append("user/message", { content: [{ kind: "text", text: "问" }] });
    await s.append("assistant/message", { content: [{ kind: "text", text: "答" }] });
    await s.append("turn/compaction", { trigger: "auto", summary: "旧v3", keepUserAt: [0], keepUserHead: 1, droppedCount: 3 }); // v3（无 keptUsers）
    await s.append("user/message", { content: [{ kind: "text", text: "后问" }] });
    await s.append("turn/compaction", { trigger: "auto", summary: "新v4", keepUserHead: 1, keptUsers: [{ role: "user", content: [{ kind: "text", text: "后问" }] }], elidedCount: 1, droppedCount: 5 }); // v4
    await s.append("user/message", { content: [{ kind: "text", text: "再问" }] });
    await s.flush();
    const file = join(d, "s_q1", "agents", "session.jsonl");
    await s.close();
    const st = statSync(file);
    await refreshEventIndex(dbFile, d, [{ id: "s_q1", file, dir: d, mtimeMs: st.mtimeMs, size: st.size, bucket: "bk" }]);
    // 无压缩会话 → undefined
    const other = await seedSession(d, "s_q0", 3);
    expect(lastCompaction(dbFile, "bk", "s_q0", other.file)).toBeUndefined();
    // 多压缩点取最后 + v4 在场性
    const lc = lastCompaction(dbFile, "bk", "s_q1", file)!;
    expect(lc).not.toBeUndefined();
    expect(lc.v4).toBe(true);
    expect(lc.seq).toBe(6);
    // v4 判定负例：单造一个只有 v3 的会话
    const s3 = new JsonlSessionStore({ dir: d, sessionId: "s_q3" });
    await s3.append("session/header", { cwd: "/r", parentSession: null });
    await s3.append("turn/compaction", { trigger: "auto", summary: "旧v3", keepUserAt: [0], keepUserHead: 1, droppedCount: 1 });
    await s3.flush();
    const f3 = join(d, "s_q3", "agents", "session.jsonl");
    await s3.close();
    const st3 = statSync(f3);
    await refreshEventIndex(dbFile, d, [{ id: "s_q3", file: f3, dir: d, mtimeMs: st3.mtimeMs, size: st3.size, bucket: "bk" }]);
    expect(lastCompaction(dbFile, "bk", "s_q3", f3)!.v4).toBe(false);
    // 库不在 → undefined（降级口）
    expect(lastCompaction(join(d, "nope.sqlite"), "bk", "s_q1", file)).toBeUndefined();
  });

  it("② eventsFrom：fromSeq 起到 EOF；连续行合并大段（不邻接处切段）；段字节可 pread 解析回行", async () => {
    const d = tmp("evixf");
    const dbFile = join(d, "event-index.sqlite");
    const { file, entry } = await seedSession(d, "s_f", 6);
    await refreshEventIndex(dbFile, d, [entry]);
    const segs = eventsFrom(dbFile, "bk", "s_f", 4);
    expect(segs).toHaveLength(1); // 4..6 邻接 → 一段
    expect(segs[0]!.seq).toBe(4);
    // 段字节 pread 回读 = 行 4..6
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(segs[0]!.byteLength);
    readSync(fd, buf, 0, segs[0]!.byteLength, segs[0]!.byteOffset);
    closeSync(fd);
    const seqs = buf.toString("utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toEqual([4, 5, 6]);
    expect(eventsFrom(dbFile, "bk", "s_f", 99)).toEqual([]); // 翻过头空
    // 手造间隙（writeEventRows 覆盖式）：行 1/2 邻接、行 3 跳开 → 两段
    const rows = [...scanEventLines(file)];
    const gapped = [rows[0]!, rows[1]!, { ...rows[2]!, byteOffset: rows[2]!.byteOffset + 100, byteLength: rows[2]!.byteLength }];
    writeEventRows(dbFile, "bk", "s_f", gapped, { mtimeMs: 1, size: 1, indexedBytes: 1 });
    expect(eventsFrom(dbFile, "bk", "s_f", 1)).toHaveLength(2); // 不邻接不并段
  });

  it("③ eventsBefore：seq 降序取 limit 条按升序返回；翻过头空；limit 截断边界", async () => {
    const d = tmp("evixb");
    const dbFile = join(d, "event-index.sqlite");
    const { file, entry } = await seedSession(d, "s_p", 10);
    await refreshEventIndex(dbFile, d, [entry]);
    const segs = eventsBefore(dbFile, "bk", "s_p", 8, 3);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.seq).toBe(5); // 7,6,5 降序取 3 → 升序返回从 5 起
    // 段内行数 = 3（pread 验证）
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(segs[0]!.byteLength);
    readSync(fd, buf, 0, segs[0]!.byteLength, segs[0]!.byteOffset);
    closeSync(fd);
    expect(buf.toString("utf8").split("\n").filter(Boolean)).toHaveLength(3);
    expect(eventsBefore(dbFile, "bk", "s_p", 1, 5)).toEqual([]); // 翻过头（seq<1 无行）
    const all = eventsBefore(dbFile, "bk", "s_p", 11, 100);
    expect(all).toHaveLength(1);
    expect(all[0]!.seq).toBe(1); // 全量页从 1 起
    const hit = eventsBefore(dbFile, "bk", "s_p", 4, 100);
    expect(hit[0]!.seq).toBe(1);
    expect(hit.reduce((n, sg) => n + sg.byteLength, 0)).toBeGreaterThan(0);
  });
});
