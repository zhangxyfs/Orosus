import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeLiveFile, LIVE_FILE, type LiveInfo } from "@orosus/core";
import { bindTestLocale, t } from "./i18n/app.ts";
import { formatPsList, scanLivePeers, PEER_STALE_MS, type PeerEntry } from "./ps.ts";

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

/** formatPsList 用 entry 工厂（剥离 ANSI 断言内容——stripAnsi 走 width.ts 同族正则）。 */
const peer = (sid: string, over: Partial<LiveInfo> = {}): PeerEntry => ({
  ...good(sid, over),
  stale: false,
});
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatPsList（m5-collab T4，/ps 输出形态 + D16 键化）", () => {
  it("① 空态：无 peer → 单行空态文案（含 self 也只报「没有其他」）", () => {
    expect(formatPsList([], { now: NOW })).toHaveLength(1);
    expect(strip(formatPsList([], { now: NOW })[0]!)).toBe(t("ps.empty"));
    expect(strip(formatPsList([], { self: peer("s_me"), now: NOW })[0]!)).toBe(t("ps.empty"));
  });

  it("② 五态混排：self 置顶带标记、标题行计数含 self、各行「图标+态名+标题 · 时间 · 模型」两段式", () => {
    const peers = [
      peer("s_wa", { phase: "waiting-approval", label: "部署脚本", lastEventAt: NOW - 60_000, model: "GLM-5.3" }),
      peer("s_run", { phase: "running", label: "重构树视图", lastEventAt: NOW - 300_000, model: "GLM-5.3" }),
      peer("s_idle", { phase: "idle", label: "写方案", lastEventAt: NOW - 120_000, model: "GLM-5.3" }),
    ];
    const lines = formatPsList(peers, { self: peer("s_me", { phase: "running", label: "我这会话", lastEventAt: NOW - 5_000, model: "GLM-5.3" }), now: NOW }).map(strip);
    expect(lines[0]).toBe(t("ps.title", { n: 4 })); // 计数含 self
    expect(lines[1]).toContain(t("ps.selfMark")); // self 行标记
    expect(lines[1]).toContain("我这会话");
    expect(lines[2]).toContain("等审批".slice(0, 2)); // 态名走键（zh 缺省locale）
    expect(lines[2]).toContain("部署脚本");
    expect(lines[2]).toContain("1 分钟前"); // relativeTime 复用（sessions.rel 族）
    expect(lines[2]).toContain("GLM-5.3");
    expect(lines[3]).toContain("重构树视图");
    expect(lines[4]).toContain("写方案");
  });

  it("③ preview 在场 → dim 缩进第二行；缺省 → 无第二行（空槽不装饰）", () => {
    const withPrev = formatPsList([peer("s_a", { label: "甲", preview: "正在写测试尾巴" })], { now: NOW }).map(strip);
    expect(withPrev).toHaveLength(3); // 标题 + 主行 + preview 行
    expect(withPrev[2]).toContain("正在写测试尾巴");
    const without = formatPsList([peer("s_b", { label: "乙" })], { now: NOW });
    expect(without).toHaveLength(2);
  });

  it("④ label 缺省 → sid 前 8 位兜底；model 缺省 → 模型段省略（不裸显「?」）", () => {
    const bare = peer("s_1234567890abcdef"); // good() 本就不带 label/model——缺省路径即默认形态
    const lines = formatPsList([bare], { now: NOW }).map(strip);
    expect(lines[1]).toContain("s_123456");
    expect(lines[1]).not.toContain("?");
  });

  it("⑤ 键化 parity：三语切换渲染文案跟随（zh-CN ↔ en-US 标题/态名/空态不同）", () => {
    bindTestLocale("en-US");
    const en = formatPsList([peer("s_a", { phase: "waiting-input", label: "x" })], { now: NOW }).map(strip);
    expect(en[0]).toContain("active");
    bindTestLocale("zh-CN");
    const zh = formatPsList([peer("s_a", { phase: "waiting-input", label: "x" })], { now: NOW }).map(strip);
    expect(zh[0]).toContain("个活跃");
    expect(zh[0]).not.toBe(en[0]);
    bindTestLocale("en-US");
    const enEmpty = strip(formatPsList([], { now: NOW })[0]!);
    bindTestLocale("zh-CN");
    expect(strip(formatPsList([], { now: NOW })[0]!)).not.toBe(enEmpty);
  });

  it("⑥ ps.* 域三语键集一致（multilang parity 的批内自证——防漏键）", () => {
    const probes = ["ps.title", "ps.empty", "ps.selfMark", "ps.phase.running", "ps.phase.waitingApproval", "ps.phase.waitingInput", "ps.phase.error", "ps.phase.idle", "slash.items.ps.desc", "slash.items.ps.long"];
    for (const tag of ["zh-CN", "zh-TW", "en-US"]) {
      bindTestLocale(tag);
      for (const k of probes) {
        const v = t(k);
        expect(v, `${tag} 缺键 ${k}`).not.toBe(k); // 未命中键时 t 回落键名本身
        expect(v.length).toBeGreaterThan(0);
      }
    }
    bindTestLocale("zh-CN");
  });
});
