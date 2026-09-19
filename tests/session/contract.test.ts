import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore, SqliteSessionStore, sqliteAvailable, type SessionStore } from "@orosus/core";

/** 存储契约套件（M4-1 T1，dsh runPersistenceContract 借鉴）：JSONL 与 SQLite 两个后端跑同一套语义用例——
 *  append-only、seq 单调连续、重开恢复、写队列串行化——防双后端各测各的漂移（换后端不换保证）。
 *  sqlite 受 node:sqlite 可用性守卫（D42：不可用 = 环境不支持，跳过不红）。 */

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-contract-")));

const backends: { name: string; make: (d: string) => SessionStore }[] = [
  { name: "jsonl", make: (d) => new JsonlSessionStore({ dir: d, sessionId: "s" }) },
  { name: "sqlite", make: (d) => new SqliteSessionStore({ dir: d, sessionId: "s" }) },
];

for (const { name, make } of backends) {
  const suite = name === "sqlite" && !sqliteAvailable() ? describe.skip : describe;
  suite(`存储契约——${name}`, () => {
    it("① append-only 不变量：seq 1..N 单调连续、parentId 链 = 前一事件 id、信封字段不被 fields 打穿", async () => {
      const store = make(fresh());
      let prevId: string | null = null;
      for (let i = 1; i <= 5; i++) {
        const e = await store.append("test/event", { n: i, v: "evil", id: "hacked", seq: 999, parentId: "hacked", ts: "hacked" });
        expect(e.seq).toBe(i);
        expect(e.parentId).toBe(prevId);
        expect(e.v).toBe(1); // 信封字段最终生效（§6.1）——fields 打不穿 v
        expect(e.id).not.toBe("hacked");
        prevId = e.id;
      }
      expect((await store.all()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      await store.close?.();
    });

    it("② 重开恢复：close 后同 dir+sid 新实例 all() 与关闭前一致（id/seq/type 逐项相等——恢复投影的地基）", async () => {
      const store = make(fresh());
      await store.append("session/header", { cwd: "/x" });
      await store.append("user/message", { content: [{ kind: "text", text: "hi" }] });
      await store.append("assistant/message", { text: "yo" });
      const before = await store.all();
      await store.close();
      const reopened = make(dir);
      const after = await reopened.all();
      expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
      expect(after.map((e) => e.seq)).toEqual(before.map((e) => e.seq));
      expect(after.map((e) => e.type)).toEqual(before.map((e) => e.type));
      await reopened.close?.();
    });

    it("③ 快速连发 20 条：全部 resolve 后 seq 无重复无空洞（写队列串行化保证）", async () => {
      const store = make(fresh());
      await Promise.all(Array.from({ length: 20 }, (_, i) => store.append("test/burst", { i })));
      const seqs = (await store.all()).map((e) => e.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      await store.close?.();
    });
  });
}
