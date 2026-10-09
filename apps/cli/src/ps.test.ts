import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeLiveFile, LIVE_FILE, type LiveInfo } from "@orosus/core";
import { scanLivePeers, PEER_STALE_MS } from "./ps.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tmp = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-ps-test-")));

const NOW = 1_700_000_000_000;
const good = (sid: string, over: Partial<LiveInfo> = {}): LiveInfo => ({
  v: 1, sid, pid: process.pid, token: `tok-${sid}`, kind: "tui", phase: "idle",
  startedAt: NOW - 500_000, lastEventAt: NOW - 1_000,
  ...over,
});
/** 在桶里放一个 live.json（写后把 mtime 拨到 now——判活不受真实时钟摆布）。 */
const plant = (bucket: string, sid: string, info: LiveInfo, mtime: number = NOW): void => {
  writeLiveFile(join(bucket, sid), info);
  const t = new Date(mtime);
  utimesSync(join(bucket, sid, LIVE_FILE), t, t);
};
/** 在桶里放一个手写坏文件。 */
const plantRaw = (bucket: string, sid: string, content: string): void => {
  mkdirSync(join(bucket, sid), { recursive: true });
  writeFileSync(join(bucket, sid, LIVE_FILE), content);
};

describe("scanLivePeers（m5-collab T3）：活/死/坏混桶与容错", () => {
  it("① 桶目录不存在 → []", () => {
    expect(scanLivePeers(join(tmp(), "nope"), "s_self", { now: NOW })).toEqual([]);
  });

  it("② 空桶（无会话目录）→ []", () => {
    expect(scanLivePeers(tmp(), "s_self", { now: NOW })).toEqual([]);
  });

  it("③ 单一活体 → 返回完整 entry（stale:false 标记 + label/model/preview 载荷）", () => {
    const d = tmp();
    plant(d, "s_a", good("s_a", { label: "重构 session", model: "GLM", preview: "尾巴文本", phase: "running" }));
    const peers = scanLivePeers(d, "s_self", { now: NOW });
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ sid: "s_a", stale: false, label: "重构 session", model: "GLM", preview: "尾巴文本", phase: "running" });
  });

  it("④ 死 pid 文件 → 跳过（pid 死即死）", () => {
    const d = tmp();
    plant(d, "s_dead", good("s_dead", { pid: 99_999_999 }));
    expect(scanLivePeers(d, "s_self", { now: NOW })).toEqual([]);
  });

  it("⑤ lastEventAt 与 mtime 双陈旧 → 跳过（90s 判死兜底——崩溃残留）", () => {
    const d = tmp();
    plant(d, "s_stale", good("s_stale", { lastEventAt: NOW - 600_000 }), NOW - 120_000); // mtime 也倒拨过期
    expect(scanLivePeers(d, "s_self", { now: NOW })).toEqual([]);
  });

  it("⑥ lastEventAt 陈旧但 mtime 新鲜 → 判活（闲置会话不判死——闲着也是活人）", () => {
    const d = tmp();
    plant(d, "s_idle", good("s_idle", { lastEventAt: NOW - 600_000 }), NOW - 10_000);
    const peers = scanLivePeers(d, "s_self", { now: NOW });
    expect(peers.map((p) => p.sid)).toEqual(["s_idle"]);
  });

  it("⑦ 坏 JSON 文件 → 跳过不炸", () => {
    const d = tmp();
    plantRaw(d, "s_bad", "{not json");
    expect(scanLivePeers(d, "s_self", { now: NOW })).toEqual([]);
  });

  it("⑧ 缺字段文件（无 token）→ 跳过", () => {
    const d = tmp();
    const { token: _d1, ...rest } = good("s_half");
    plantRaw(d, "s_half", JSON.stringify(rest));
    expect(scanLivePeers(d, "s_self", { now: NOW })).toEqual([]);
  });

  it("⑨ 会话目录无 live.json → 跳过（历史尸体不见活人——活死分家）", () => {
    const d = tmp();
    mkdirSync(join(d, "s_corpse", "agents"), { recursive: true });
    expect(scanLivePeers(d, "s_self", { now: NOW })).toEqual([]);
  });

  it("⑩ 自身 sid 排除（调用方要含自己时自行拼）", () => {
    const d = tmp();
    plant(d, "s_self", good("s_self"));
    plant(d, "s_other", good("s_other"));
    expect(scanLivePeers(d, "s_self", { now: NOW }).map((p) => p.sid)).toEqual(["s_other"]);
  });

  it("⑪ 桶里裸文件（非目录）→ 跳过", () => {
    const d = tmp();
    writeFileSync(join(d, "stray.txt"), "x");
    plant(d, "s_a", good("s_a"));
    expect(scanLivePeers(d, "s_self", { now: NOW }).map((p) => p.sid)).toEqual(["s_a"]);
  });

  it("⑫ opts.now 注入生效（判活以注入时刻为准）", () => {
    const d = tmp();
    plant(d, "s_a", good("s_a", { lastEventAt: NOW - 80_000 }), NOW - 80_000); // 两戳同旧——max 公式的判定面
    expect(scanLivePeers(d, "s_self", { now: NOW }).length).toBe(1); // 80s < 90s 活
    expect(scanLivePeers(d, "s_self", { now: NOW + 20_000 }).length).toBe(0); // 100s > 90s 死
  });

  it("⑬ 活/死/坏混桶 → 只活者归且死件原地保留（不删他人文件——D15）", () => {
    const d = tmp();
    plant(d, "s_live", good("s_live", { phase: "running" }));
    plant(d, "s_dead", good("s_dead", { pid: 99_999_999 }));
    plantRaw(d, "s_bad", "garbage");
    const peers = scanLivePeers(d, "s_self", { now: NOW });
    expect(peers.map((p) => p.sid)).toEqual(["s_live"]);
    // 死件/坏件原地保留（扫描一律只读——约束 2，不做删除巡逻 D15）
    expect(existsSync(join(d, "s_dead", LIVE_FILE))).toBe(true);
    expect(existsSync(join(d, "s_bad", LIVE_FILE))).toBe(true);
  });
});

describe("scanLivePeers 排序（codex agents_overview 分组法 + D3 五值）", () => {
  it("⑭ 五组排序 waiting-approval → waiting-input → running → error → idle，同组按 lastEventAt 新到旧", () => {
    const d = tmp();
    plant(d, "s_idle", good("s_idle", { phase: "idle", lastEventAt: NOW - 5_000 }));
    plant(d, "s_run", good("s_run", { phase: "running", lastEventAt: NOW - 2_000 }));
    plant(d, "s_wa", good("s_wa", { phase: "waiting-approval", lastEventAt: NOW - 9_000 }));
    plant(d, "s_wi", good("s_wi", { phase: "waiting-input", lastEventAt: NOW - 1_000 }));
    plant(d, "s_err", good("s_err", { phase: "error", lastEventAt: NOW - 3_000 }));
    plant(d, "s_wa2", good("s_wa2", { phase: "waiting-approval", lastEventAt: NOW - 500 }));
    const peers = scanLivePeers(d, "s_self", { now: NOW });
    expect(peers.map((p) => p.sid)).toEqual(["s_wa2", "s_wa", "s_wi", "s_run", "s_err", "s_idle"]); // 等审批排最前；同组新到旧
  });

  it("⑮ 过期阈值常量 = 90s（D2——与 tool-peers isSessionLive 90_000 对齐，同项目一个「活」的定义）", () => {
    expect(PEER_STALE_MS).toBe(90_000);
  });
});
