/** 活体扫描器（m5-collab T3，方案 D2/D5/D15）：读出本项目桶里的活会话列表——/ps 命令、协同卡、
 *  多开提示三个消费方共用同一实现（判活、排序、容错一处）。文件名随命令 /ps（v6 改名——与
 *  packages/modules/tool-peers/ 划清：那是「其他 agent CLI 的记忆」，这是「本机兄弟会话」；
 *  函数名 scanLivePeers 保留——「兄弟会话」概念在内部符号里仍准确，九仓调研词汇同源）。
 *
 *  纪律：扫描一律只读（约束 2）——死件/坏件原地跳过不删（D15 不做删除巡逻：删别人留下的文件有
 *  并发竞态，磁盘残留几 KB 无害）；活死分家（约束 4——/sessions 纯历史不调本件）。 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isLive, pidAlive, readLiveFile, readLockHolder, SessionLockedError, SESSION_LOCK_FILE, type LiveInfo, type LockHolder } from "@orosus/core";
import { t } from "./i18n/app.ts";
import { relativeTime } from "./sessions.ts";
import * as theme from "./theme.ts";
import { padToWidth, visibleWidth } from "./tui/width.ts";

/** 过期阈值 90s（D2/D5）：= 心跳 15s × 6 拍容错，与 tool-peers isSessionLive 的 90_000 对齐——
 *  同项目一个「活」的定义（v7 定案③）。 */
export const PEER_STALE_MS = 90_000;

/** 活体条目（只吐活体——死文件/坏文件静默跳过）：LiveInfo 载荷 + stale:false 在场性标记。 */
export interface PeerEntry extends LiveInfo {
  stale: false;
}

/** 分组优先级（codex agents_overview_view「Needs you 拎最前」化用 + D3 五值）：等审批 → 等问询 →
 *  正在跑 → 上轮报错 → 闲着。 */
const PHASE_ORDER: Record<LiveInfo["phase"], number> = {
  "waiting-approval": 0,
  "waiting-input": 1,
  running: 2,
  error: 3,
  idle: 4,
};

/** 扫描桶目录吐活体列表：自身 sid 排除（调用方要含自己时自行拼）；排序 = 分组序 → 同组按
 *  lastEventAt 新到旧。opts.now/staleMs 注入供测试（生产缺省 Date.now()/90s）。 */
export function scanLivePeers(sessionsDir: string, selfSid: string, opts?: { now?: number; staleMs?: number }): PeerEntry[] {
  const now = opts?.now ?? Date.now();
  const staleMs = opts?.staleMs ?? PEER_STALE_MS;
  let entries;
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return []; // 桶目录不存在（尚无会话）——空桶语义
  }
  const out: PeerEntry[] = [];
  for (const d of entries) {
    if (!d.isDirectory() || d.name === selfSid) continue;
    const rec = readLiveFile(join(sessionsDir, d.name));
    if (rec === undefined) continue; // 无 live.json/坏件——静默跳过（历史尸体不见活人）
    if (!isLive(rec, now, staleMs)) continue; // 死件跳过（不删——D15）
    // sid 以目录名为准（扫描发现面的事实源——载荷 sid 与目录漂移时以发现位为准）
    out.push({ ...rec.info, sid: d.name, stale: false });
  }
  return out.toSorted((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || b.lastEventAt - a.lastEventAt);
}

/** /ps 数据面单点（handler 与协同卡 panelData 共用——扫描+self 装配一处）：list = scanLivePeers
 *  排序序；self = 本会话 live.json 读回（attach 失败/测试路径可缺）。 */
export function scanWithSelf(sessionsDir: string, selfSid: string): { self?: PeerEntry | undefined; list: PeerEntry[] } {
  const list = scanLivePeers(sessionsDir, selfSid);
  const rec = readLiveFile(join(sessionsDir, selfSid));
  return { ...(rec !== undefined ? { self: { ...rec.info, stale: false } } : {}), list };
}

// ---------- /ps 输出形态（T4，D16 全量键化） ----------

/** 五态渲染元数据（图标走函数现算——主题可切，导入期烤色是旧快照〔taskTick 同款教训〕；态名键化——
 *  /ps 与协同卡共用同一组键，措辞两处一致）。 ● accent 跑 / ◉ warn 等审批·等输入 / ✗ err 报错 / ○ muted 闲。 */
const PHASE_META: Record<LiveInfo["phase"], { icon: () => string; nameKey: string }> = {
  running: { icon: () => theme.fg("accent", "●"), nameKey: "ps.phase.running" },
  "waiting-approval": { icon: () => theme.fg("warn", "◉"), nameKey: "ps.phase.waitingApproval" },
  "waiting-input": { icon: () => theme.fg("warn", "◉"), nameKey: "ps.phase.waitingInput" },
  error: { icon: () => theme.fg("err", "✗"), nameKey: "ps.phase.error" },
  idle: { icon: () => theme.fg("muted", "○"), nameKey: "ps.phase.idle" },
};

/** 五态图标（/ps 与协同卡共用——单一源两处不漂移）。 */
export const phaseIcon = (p: LiveInfo["phase"]): string => PHASE_META[p].icon();

/** 五态名（键化——/ps 与协同卡共用同一组键，措辞两处一致）。 */
export const phaseName = (p: LiveInfo["phase"]): string => t(PHASE_META[p].nameKey);

/** 无标题会话的兜底显示名（2026-10-09 走查实修）：sid 前 8 位全是 ULID 时间戳段（types.ts newId
 *  布局 = 前缀+10 位时间+16 位随机）——差不多同时创建的会话前 8 位恒撞（用户实测两行同 id）。
 *  取「前缀 + … + 随机段尾 6 位」才可区分（同毫秒建的会话随机段自增错开——newId 递增条款）。 */
export const peerDisplayName = (e: LiveInfo): string => e.label ?? `${e.sid.slice(0, 2)}…${e.sid.slice(-6)}`;

/** /ps 输出行拼装：标题行（计数含 self）+ self 置顶行（本会话标记）+ peers 行（输入序 = scanLivePeers
 *  排序序）+ preview 缩进第二行（在场才出——空槽不装饰）。无 peer → 单行空态文案（「其他」语义——
 *  即便 self 在场也只报没有其他活跃会话）。行两段式：图标+态名+标题（白）+ 时间·模型（灰）。 */
export function formatPsList(peers: PeerEntry[], opts?: { self?: PeerEntry; now?: number }): string[] {
  if (peers.length === 0) return [theme.dim(t("ps.empty"))];
  const rows: { entry: PeerEntry; self: boolean }[] = [
    ...(opts?.self !== undefined ? [{ entry: opts.self, self: true }] : []),
    ...peers.map((entry) => ({ entry, self: false })),
  ];
  const names = rows.map((r) => phaseName(r.entry.phase));
  const nameW = Math.max(...names.map((n) => visibleWidth(n)));
  const lines: string[] = [t("ps.title", { n: rows.length })];
  rows.forEach((r, i) => {
    const e = r.entry;
    const title = peerDisplayName(e);
    const tail = theme.dim(` ${relativeTime(e.lastEventAt, opts?.now)}${e.model !== undefined ? ` · ${e.model}` : ""}`) + (r.self ? theme.dim(` · ${t("ps.selfMark")}`) : "");
    lines.push(` ${phaseIcon(e.phase)} ${padToWidth(names[i]!, nameW)} ${title}${tail}`);
    if (e.preview !== undefined) lines.push(theme.dim(`${" ".repeat(nameW + 4)}${e.preview}`)); // 缩进对齐标题列
  });
  return lines;
}

// ---------- 撞锁 UX（T6，D7/D16） ----------

/** 撞锁人话文案（Reasonix session_lease_keeper 模板化用）：从 SessionLockedError.holder 结构化字段
 *  t() 组装（D16：core 协议层不带最终文案，CLI 渲染层本地化）。label 取舍：锁载荷是抢锁时点快照
 *  （可能缺/陈旧——抢锁后改名不重写），缺省时按 pid 对 peers 查 live.json 补全（它随事件刷新、
 *  更新鲜）。since 显示层截 HH:MM（ISO 原串在 holder 里保留诊断价值）。 */
export function formatLockDenied(holder: LockHolder, peers: PeerEntry[]): string {
  const label = holder.label ?? peers.find((p) => p.pid === holder.pid)?.label;
  const labelSeg = label !== undefined ? t("lock.labelSeg", { label }) : "";
  return t("lock.denied", { pid: holder.pid, since: holder.since.slice(11, 16), labelSeg });
}

/** 错误分流（turn 失败收口唯一挂点——main.ts 各 catch 一处接入即覆盖全部路径）：SessionLockedError
 *  走 lock 文案 notify（TUI toast / 行模式单行——notify 自分形态），其余错误交原政策件（Esc 静默/
 *  toast 化口径不变）。注入式 deps 供测试；生产装配在 main.ts。 */
export function settleWithLock(err: unknown, deps: { peers: () => PeerEntry[]; notify: (s: string) => void; fallback: (err: unknown) => void }): void {
  if (err instanceof SessionLockedError) {
    deps.notify(formatLockDenied(err.holder, deps.peers()));
    return;
  }
  deps.fallback(err);
}

/** 恢复预警探测（T6 扩面——「打开不拦、打开时告知」）：只读探测活锁（readLockHolder + pidAlive，
 *  零成本、不上锁不拦截），活锁且持有者不是自己 → 返回持有者 pid（调用方 toast）；自己/死 pid/
 *  无锁/坏锁 → null（自己重开同 sid 不预警、stale 不预警——CS-03 回收路径兜住）。 */
export function lockHeldByOther(dir: string, sid: string, selfPid: number): number | null {
  const holder = readLockHolder(join(dir, sid, "agents", SESSION_LOCK_FILE));
  if (holder === null || holder.pid === selfPid) return null;
  return pidAlive(holder.pid) ? holder.pid : null;
}

/** 提交闸门锁档（2026-10-09 用户拍板「既然弹窗已拦截，应该直接不允许发送消息」）：他进程持写锁的
 *  会话拦自然语言消息在提交前——输入保留（submitGate 语义）、不撞盘不冒泡。命令面全放行：/fork
 *  是现成逃生门（双开行为链第 4 段）、/quit 要能退、/ps 照常看。返回拒因文案 | undefined = 放行。 */
export function lockSubmitBlock(text: string, dir: string, sid: string, selfPid: number): string | undefined {
  if (text.trim().startsWith("/")) return undefined;
  const pid = lockHeldByOther(dir, sid, selfPid);
  return pid === null ? undefined : t("lock.submitBlocked", { pid });
}

/** 会话目录有活 live.json → true（purge 护栏——空会话退出清理与本批的组合缝：B 退一个 A 正开着的
 *  空会话，原先只看锁不看心跳会把 A 的目录整个误删；锁管不到空会话〔零写零锁〕，live.json 才是空
 *  会话的占用信号）。selfPid = 调用进程自己的 pid——自己刚 dispose 完的残留不挡自己的路（/new
 *  同 sid 空档重开路径）。 */
export function liveSessionActive(dir: string, selfPid?: number): boolean {
  const rec = readLiveFile(dir);
  if (rec === undefined) return false;
  if (selfPid !== undefined && rec.info.pid === selfPid) return false;
  return isLive(rec, Date.now(), PEER_STALE_MS);
}

// ---------- 多开提示（T7，D10） ----------

/** 多开提示一次性节奏（cc tipRegistry「color-when-multi-clauding」化用）：每进程一次、TUI 形态才弹
 *  （行模式无 toast 面不打扰——D10）、≥1 个其他活会话才弹。状态在闭包里——session-io 持进程级单例，
 *  createSession 尾同缝调用（与 T6 恢复预警同族同缝）。返回 true = 本次弹了（测试断言面）。 */
export function createMultiOpenTip(): (peers: PeerEntry[], opts: { fullscreen: boolean; notice?: ((s: string) => void) | undefined }) => boolean {
  let shown = false;
  return (peers, opts) => {
    if (shown || !opts.fullscreen || peers.length === 0 || opts.notice === undefined) return false;
    shown = true;
    opts.notice(t("ps.tip.multi", { n: peers.length }));
    return true;
  };
}
