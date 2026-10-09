import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlSessionStore } from "./jsonl.ts";
import { SqliteSessionStore, sqliteAvailable } from "./sqlite.ts";
import { readLockHolder, SessionLockedError, SESSION_LOCK_FILE } from "./wlock.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const tmp = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-wlock-")));
const lockPath = (d: string, sid: string): string => join(d, sid, "agents", SESSION_LOCK_FILE);
const lockLines = (d: string, sid: string): string[] => readFileSync(lockPath(d, sid), "utf8").split("\n").filter((l) => l !== "");

describe("SessionLockedError（m5-collab T1）：裸 Error 换结构化拒绝", () => {
  it("① holder 带 pid/since/label 三字段，message 为诊断兜底中文串（D16：core 不带最终文案）", () => {
    const err = new SessionLockedError({ pid: 1234, since: "2026-10-09T01:02:03.000Z", label: "重构 session" });
    expect(err.holder).toEqual({ pid: 1234, since: "2026-10-09T01:02:03.000Z", label: "重构 session" });
    expect(err.message).toContain("1234");
    expect(err.message).toContain("2026-10-09T01:02:03.000Z");
    expect(err.message).toContain("重构 session");
    expect(err.name).toBe("SessionLockedError");
    expect(err instanceof Error).toBe(true);
  });

  it("② 无 label 时 message 不带标题段（holder.label undefined）", () => {
    const err = new SessionLockedError({ pid: 4321, since: "2026-10-09T00:00:00.000Z" });
    expect(err.holder.label).toBeUndefined();
    expect(err.message).not.toContain("标题");
  });

  it("③ jsonl 双实例：第二实例 append reject 为 SessionLockedError、holder 指认持锁者（pid/since 实读）", async () => {
    const d = tmp();
    const a = new JsonlSessionStore({ dir: d, sessionId: "s_lk" });
    await a.append("session/header", { format: 1 }); // 首写抢锁
    const b = new JsonlSessionStore({ dir: d, sessionId: "s_lk" });
    const err = await b.append("user/message", { content: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionLockedError);
    const holder = (err as SessionLockedError).holder;
    expect(holder.pid).toBe(process.pid); // 同进程双实例：持锁者 = 本进程
    expect(Date.parse(holder.since)).not.toBeNaN();
    await b.close().catch(() => undefined); // b 未落盘，close 诚实拒绝（CS-02 语义——兜住不污染断言）
    await a.close();
  });

  it("④ 锁载荷含 label：镜像带 label 历史的 resume 首写抢锁进第三行（抢锁时点快照，事后改名不重写）", async () => {
    const d = tmp();
    const a = new JsonlSessionStore({ dir: d, sessionId: "s_lb" });
    await a.append("session/header", { format: 1 });
    await a.append("session/label", { label: "部署脚本改权限" });
    await a.close(); // a 首写在 label 之前抢锁 → 其锁为两行（快照时点无标题——live.json 补全路径的常态）
    const b = new JsonlSessionStore({ dir: d, sessionId: "s_lb" }); // resume：镜像载入 label 历史
    await b.append("user/message", { content: [] }); // b 首写抢锁 → 镜像 label 进载荷
    const lines = lockLines(d, "s_lb");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("部署脚本改权限");
    await b.append("session/label", { label: "新名字" });
    expect(lockLines(d, "s_lb")[2]).toBe("部署脚本改权限"); // 快照语义：抢锁后改名不重写锁文件
    await b.close();
  });

  it("⑤ 无 label 历史时锁载荷维持旧两行格式（向后兼容：老读者 readLockPid 不受影响）", async () => {
    const d = tmp();
    const a = new JsonlSessionStore({ dir: d, sessionId: "s_nl" });
    await a.append("session/header", { format: 1 });
    const lines = lockLines(d, "s_nl");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(String(process.pid));
    await a.close();
  });

  it("⑥ readLockHolder：两行旧锁 → label undefined；三行新锁 → label 读出；坏锁 → null", () => {
    const d = tmp();
    const p = lockPath(d, "s_rh");
    mkdirSync(join(d, "s_rh", "agents"), { recursive: true });
    writeFileSync(p, "123\n2026-10-09T01:00:00.000Z\n");
    expect(readLockHolder(p)).toEqual({ pid: 123, since: "2026-10-09T01:00:00.000Z", label: undefined });
    writeFileSync(p, "456\n2026-10-09T02:00:00.000Z\n标题在此\n");
    expect(readLockHolder(p)).toEqual({ pid: 456, since: "2026-10-09T02:00:00.000Z", label: "标题在此" });
    writeFileSync(p, "garbage\n");
    expect(readLockHolder(p)).toBeNull();
  });

  it("⑦ 死 pid 抢占回归（CS-03 语义不动）：持有者已死 → 回收重建、append 成功、锁易主", async () => {
    const d = tmp();
    const dead = spawnSync(process.execPath, ["-e", ""]);
    expect(dead.pid).toBeGreaterThan(0);
    mkdirSync(join(d, "s_st", "agents"), { recursive: true });
    writeFileSync(lockPath(d, "s_st"), `${dead.pid}\n2026-10-09T00:00:00.000Z\n旧标题\n`);
    const s = new JsonlSessionStore({ dir: d, sessionId: "s_st" });
    await s.append("session/header", { format: 1 }); // stale 回收不炸
    expect(readLockHolder(lockPath(d, "s_st"))?.pid).toBe(process.pid); // 锁已易主
    await s.close();
  });
});

describe("sqlite 后端同款锁（D6：锁语义不随后端漂移）", () => {
  it.skipIf(!sqliteAvailable())("⑧ sqlite 双实例：第二 append 撞 SessionLockedError，锁路径与 jsonl 一致（<sid>/agents/session.lock）", async () => {
    const d = tmp();
    const a = new SqliteSessionStore({ dir: d, sessionId: "s_sq" });
    await a.append("session/header", { format: 1 }); // 首写抢锁
    const b = new SqliteSessionStore({ dir: d, sessionId: "s_sq" });
    const err = await b.append("user/message", { content: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionLockedError);
    expect((err as SessionLockedError).holder.pid).toBe(process.pid);
    expect((err as SessionLockedError).holder.label).toBeUndefined(); // 无 label 历史
    await b.close();
    await a.close();
  });

  it.skipIf(!sqliteAvailable())("⑨ sqlite close 释放 → 第二实例接管；resume 首写的锁载荷带历史 label（构造期扫描镜像）", async () => {
    const d = tmp();
    const a = new SqliteSessionStore({ dir: d, sessionId: "s_sq2" });
    await a.append("session/header", { format: 1 });
    await a.append("session/label", { label: "sqlite 会话" });
    await a.close();
    const b = new SqliteSessionStore({ dir: d, sessionId: "s_sq2" });
    const e = await b.append("user/message", { content: [] }); // 释放后接管成功
    expect(e.seq).toBe(3);
    // 接管者的锁载荷从历史镜像推 label（resume 路径——label 事件在库里不在新 append 里）
    expect(lockLines(d, "s_sq2")[2]).toBe("sqlite 会话");
    await b.close();
  });

  it.skipIf(!sqliteAvailable())("⑩ sqlite stale 回收：死 pid 锁残留 → append 回收重建不炸", async () => {
    const d = tmp();
    const a = new SqliteSessionStore({ dir: d, sessionId: "s_sq3" });
    await a.append("session/header", { format: 1 });
    await a.close();
    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(lockPath(d, "s_sq3"), `${dead.pid}\n2026-10-09T00:00:00.000Z\n`);
    const b = new SqliteSessionStore({ dir: d, sessionId: "s_sq3" });
    await b.append("user/message", { content: [] }); // 不炸
    expect(readLockHolder(lockPath(d, "s_sq3"))?.pid).toBe(process.pid);
    await b.close();
  });
});
