import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLive, LIVE_FILE, readLiveFile, removeLiveFile, writeLiveFile, type LiveInfo } from "./live.ts";

/** 好载荷工厂：pid 默认本进程（pidAlive 恒真），时间戳默认"现在"——各用例按需覆盖。 */
const goodInfo = (over: Partial<LiveInfo> = {}): LiveInfo => ({
  v: 1,
  sid: "s_test",
  pid: process.pid,
  token: "tok-a",
  kind: "tui",
  phase: "idle",
  startedAt: 1_000,
  lastEventAt: 1_000,
  ...over,
});

const dirs: string[] = [];
const mkDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "orosus-live-test-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("live.json 读写", () => {
  it("writeLiveFile 目录不存在时 mkdir 保底，读回字段一致", () => {
    const dir = join(mkDir(), "sid-1");
    writeLiveFile(dir, goodInfo({ label: "标题", model: "GLM", preview: "尾巴" }));
    const rec = readLiveFile(dir);
    expect(rec?.info).toEqual(goodInfo({ label: "标题", model: "GLM", preview: "尾巴" }));
    expect(rec?.mtimeMs).toBeGreaterThan(0);
  });

  it("readLiveFile 坏 JSON → undefined（不炸）", () => {
    const dir = mkDir();
    writeFileSync(join(dir, LIVE_FILE), "{not json");
    expect(readLiveFile(dir)).toBeUndefined();
  });

  it("readLiveFile 缺字段（无 token）→ undefined", () => {
    const dir = mkDir();
    const { token: _drop, ...rest } = goodInfo();
    writeFileSync(join(dir, LIVE_FILE), JSON.stringify(rest));
    expect(readLiveFile(dir)).toBeUndefined();
  });

  it("readLiveFile 枚举值越界（kind/phase 不在册）→ undefined", () => {
    const dir = mkDir();
    writeFileSync(join(dir, LIVE_FILE), JSON.stringify(goodInfo({ kind: "carrier-pigeon" as never })));
    expect(readLiveFile(dir)).toBeUndefined();
    writeFileSync(join(dir, LIVE_FILE), JSON.stringify(goodInfo({ phase: "sleeping" as never })));
    expect(readLiveFile(dir)).toBeUndefined();
  });

  it("readLiveFile 文件不存在 → undefined", () => {
    expect(readLiveFile(mkDir())).toBeUndefined();
  });
});

describe("isLive 双判据（pid 存活 AND max(lastEventAt, mtime) 新鲜）", () => {
  const NOW = 1_000_000;
  const STALE = 90_000;

  it("pid 活 + lastEventAt 新鲜 → true", () => {
    expect(isLive({ info: goodInfo({ lastEventAt: NOW - 1_000 }), mtimeMs: NOW - 80_000 }, NOW, STALE)).toBe(true);
  });

  it("pid 死 → false（哪怕时间戳新鲜）", () => {
    // 极大 pid 不可能存活（pidAlive 走 process.kill 探活，无需 mock）
    expect(isLive({ info: goodInfo({ pid: 99_999_999, lastEventAt: NOW - 1_000 }), mtimeMs: NOW - 1_000 }, NOW, STALE)).toBe(false);
  });

  it("pid 活 + lastEventAt 与 mtime 都陈旧 → false", () => {
    expect(isLive({ info: goodInfo({ lastEventAt: NOW - 91_000 }), mtimeMs: NOW - 120_000 }, NOW, STALE)).toBe(false);
  });

  it("pid 活 + lastEventAt 陈旧但 mtime 新鲜 → true（心跳摸活兜住闲置会话——闲着不判死）", () => {
    expect(isLive({ info: goodInfo({ lastEventAt: NOW - 600_000 }), mtimeMs: NOW - 15_000 }, NOW, STALE)).toBe(true);
  });

  it("pid 活 + lastEventAt 新鲜但 mtime 陈旧 → true（max 取新——同秒写吞 mtime 的残余窗口兜住）", () => {
    expect(isLive({ info: goodInfo({ lastEventAt: NOW - 1_000 }), mtimeMs: NOW - 200_000 }, NOW, STALE)).toBe(true);
  });

  it("边界：恰好 staleMs 算活，超 1ms 判死", () => {
    const rec = { info: goodInfo({ lastEventAt: NOW - 90_000 }), mtimeMs: NOW - 90_000 };
    expect(isLive(rec, NOW, 90_000)).toBe(true);
    expect(isLive({ info: goodInfo({ lastEventAt: NOW - 90_001 }), mtimeMs: NOW - 90_001 }, NOW, 90_000)).toBe(false);
  });
});

describe("removeLiveFile token 校验（D15 并发安全）", () => {
  it("token 不符不删（防误删他人）、相符才删", () => {
    const dir = mkDir();
    writeLiveFile(dir, goodInfo({ token: "tok-mine" }));
    removeLiveFile(dir, "tok-other");
    expect(readLiveFile(dir)).toBeDefined(); // 他人文件原样保留
    removeLiveFile(dir, "tok-mine");
    expect(readLiveFile(dir)).toBeUndefined(); // 自家文件删掉
  });

  it("文件不存在/已损坏 → 静默返回不抛", () => {
    const dir = mkDir();
    removeLiveFile(dir, "tok-x"); // 不存在
    writeFileSync(join(dir, LIVE_FILE), "{bad");
    removeLiveFile(dir, "tok-x"); // 损坏（token 不可校验，留着不删）
    expect(statSync(join(dir, LIVE_FILE)).isFile()).toBe(true);
  });

  it("写后 mtime 新鲜度可被 utimes 倒拨（判死路径依赖 mtime 的集成验证）", () => {
    const dir = mkDir();
    const now = Date.now();
    writeLiveFile(dir, goodInfo({ lastEventAt: now - 600_000 }));
    const rec = readLiveFile(dir)!;
    expect(isLive(rec, now, 90_000)).toBe(true); // 刚写：mtime 新鲜
    const old = new Date(now - 120_000);
    utimesSync(join(dir, LIVE_FILE), old, old);
    expect(isLive(readLiveFile(dir)!, now, 90_000)).toBe(false); // mtime 倒拨后判死
    expect(JSON.parse(readFileSync(join(dir, LIVE_FILE), "utf8")).sid).toBe("s_test"); // 文件还在——判死靠跳过不靠删
  });
});
