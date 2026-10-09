import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { writeLiveFile, LIVE_FILE, SessionLockedError, SESSION_LOCK_FILE, type LiveInfo, type LockHolder } from "@orosus/core";
import { bindTestLocale, t } from "./i18n/app.ts";
import { stripAnsi } from "./tui/width.ts";
import { createMultiOpenTip, formatLockDenied, formatPsList, lockHeldByOther, scanLivePeers, settleWithLock, PEER_STALE_MS, type PeerEntry } from "./ps.ts";

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
  const dt = new Date(mtime);
  utimesSync(join(bucket, sid, LIVE_FILE), dt, dt);
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
const strip = stripAnsi;

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

const holder = (over: Partial<LockHolder> = {}): LockHolder => ({ pid: 4321, since: "2026-10-09T14:35:42.000Z", ...over });

describe("formatLockDenied / settleWithLock（m5-collab T6 撞锁 UX——holder 结构化组装 + label 补全）", () => {

  it("① holder.label 在场 → 文案带标题段（快照优先于 live.json）", () => {
    const msg = formatLockDenied(holder({ label: "锁里快照" }), [peer("s_x", { pid: 4321, label: "live 新鲜" })]);
    expect(msg).toContain("锁里快照");
    expect(msg).not.toContain("live 新鲜");
    expect(msg).toContain("4321");
    expect(msg).toContain("14:35"); // since 截 HH:MM
  });

  it("② holder.label 缺省 → 按 pid 对 peers 查 live.json 补全（锁是抢锁时点快照、live.json 更新鲜）", () => {
    const msg = formatLockDenied(holder(), [peer("s_x", { pid: 4321, label: "隔壁的会话" }), peer("s_y", { pid: 9999, label: "别家" })]);
    expect(msg).toContain("隔壁的会话");
    expect(msg).not.toContain("别家");
  });

  it("③ 两处都无 label → 无标题段（不残留占位）；peer 无 label 同理", () => {
    const msg = formatLockDenied(holder(), [peer("s_x", { pid: 4321 })]);
    expect(msg).not.toContain("标题");
    expect(msg).toContain("4321");
    const msg2 = formatLockDenied(holder(), []);
    expect(msg2).not.toContain("标题");
  });

  it("④ 文案语义：本次输入未写入 + 可只读浏览 + 回那个窗口或等退出自动续写（CS-02 自愈背书）", () => {
    const msg = formatLockDenied(holder(), []);
    expect(msg).toContain("未写入");
    expect(msg).toContain("只读");
    expect(msg).toContain("自动续写");
  });

  it("⑤ settleWithLock 分流：SessionLockedError → notify 走 lock 文案；普通错误 → fallback 原路径", () => {
    const seen: string[] = [];
    const fallback: unknown[] = [];
    settleWithLock(new SessionLockedError(holder({ label: "甲" })), { peers: () => [], notify: (s) => seen.push(s), fallback: (e) => fallback.push(e) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("甲");
    expect(fallback).toHaveLength(0);
    const plain = new Error("别的错");
    settleWithLock(plain, { peers: () => [], notify: (s) => seen.push(s), fallback: (e) => fallback.push(e) });
    expect(fallback).toEqual([plain]); // 非锁错误不拦截——原政策件接管
    expect(seen).toHaveLength(1);
  });

  it("⑥ lock.* 域三语键集一致且文案不同（parity 自证）", () => {
    const probes = ["lock.denied", "lock.labelSeg", "lock.heldWarning"];
    const seen = new Map<string, string>();
    for (const tag of ["zh-CN", "zh-TW", "en-US"]) {
      bindTestLocale(tag);
      for (const k of probes) {
        const v = t(k, { pid: 1, since: "00:00", labelSeg: "", label: "x" });
        expect(v, `${tag} 缺键 ${k}`).not.toBe(k);
        expect(v.length).toBeGreaterThan(0);
      }
      seen.set(tag, t("lock.heldWarning", { pid: 7 }));
    }
    bindTestLocale("zh-CN");
    expect(seen.get("zh-CN")).not.toBe(seen.get("en-US"));
  });
});

const plantLock = (d: string, sid: string, pid: number): void => {
  mkdirSync(join(d, sid, "agents"), { recursive: true });
  writeFileSync(join(d, sid, "agents", SESSION_LOCK_FILE), `${pid}\n2026-10-09T01:00:00.000Z\n`);
};

describe("lockHeldByOther（T6 恢复预警探测——只读、不拦截）", () => {
  it("⑦ 活锁他 pid → 返回该 pid（预警语义：打开不拦，告知写入会被拒）", () => {
    const d = tmp();
    const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},5000)"], { stdio: "ignore" });
    try {
      plantLock(d, "s_held", sleeper.pid!);
      expect(lockHeldByOther(d, "s_held", process.pid)).toBe(sleeper.pid);
    } finally {
      sleeper.kill();
    }
  });

  it("⑧ 锁是自己的 pid → null（同进程同 sid 重开不预警）；死 pid → null（stale 不预警）；无锁 → null", () => {
    const d = tmp();
    plantLock(d, "s_mine", process.pid);
    expect(lockHeldByOther(d, "s_mine", process.pid)).toBeNull();
    const dead = spawnSync(process.execPath, ["-e", ""]);
    plantLock(d, "s_dead", dead.pid!);
    expect(lockHeldByOther(d, "s_dead", process.pid)).toBeNull();
    expect(lockHeldByOther(d, "s_none", process.pid)).toBeNull();
    expect(lockHeldByOther(join(d, "nope"), "s_none", process.pid)).toBeNull();
  });

  it("⑨ 预警文案键在场且带 pid（lock.heldWarning 三语）", () => {
    for (const tag of ["zh-CN", "zh-TW", "en-US"]) {
      bindTestLocale(tag);
      const v = t("lock.heldWarning", { pid: 4242 });
      expect(v).toContain("4242");
    }
    bindTestLocale("zh-CN");
  });
});


describe("createMultiOpenTip（m5-collab T7 多开提示——cc tipRegistry 一次性节奏化用）", () => {
  it("① 首启单会话（peers=0）→ 不弹（notice 零调用）", () => {
    const tip = createMultiOpenTip();
    const seen: string[] = [];
    expect(tip([], { fullscreen: true, notice: (s) => seen.push(s) })).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("② 有 peer + TUI 形态 → 弹一次，文案带数量与 /title 指路", () => {
    const tip = createMultiOpenTip();
    const seen: string[] = [];
    expect(tip([peer("s_a"), peer("s_b")], { fullscreen: true, notice: (s) => seen.push(s) })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("2");
    expect(seen[0]).toContain("/title");
  });

  it("③ 第二次不弹（每进程一次——哪怕 peers 仍在）", () => {
    const tip = createMultiOpenTip();
    const seen: string[] = [];
    const opts = { fullscreen: true, notice: (s: string) => seen.push(s) };
    expect(tip([peer("s_a")], opts)).toBe(true);
    expect(tip([peer("s_a"), peer("s_b")], opts)).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("④ 行模式不弹（无 toast 面不打扰——D10）；notice 缺省同不弹", () => {
    const tip = createMultiOpenTip();
    const seen: string[] = [];
    expect(tip([peer("s_a")], { fullscreen: false, notice: (s) => seen.push(s) })).toBe(false);
    expect(tip([peer("s_a")], { fullscreen: true, notice: undefined })).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("⑤ parity：ps.tip.multi 三语在册带数量参数、文案不同", () => {
    const vals = new Map<string, string>();
    for (const tag of ["zh-CN", "zh-TW", "en-US"]) {
      bindTestLocale(tag);
      const v = t("ps.tip.multi", { n: 3 });
      expect(v, `${tag} 缺键 ps.tip.multi`).not.toBe("ps.tip.multi");
      expect(v).toContain("3");
      vals.set(tag, v);
    }
    bindTestLocale("zh-CN");
    expect(vals.get("zh-CN")).not.toBe(vals.get("en-US"));
  });
});
