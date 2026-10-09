/** 活体扫描器（m5-collab T3，方案 D2/D5/D15）：读出本项目桶里的活会话列表——/ps 命令、协同卡、
 *  多开提示三个消费方共用同一实现（判活、排序、容错一处）。文件名随命令 /ps（v6 改名——与
 *  packages/modules/tool-peers/ 划清：那是「其他 agent CLI 的记忆」，这是「本机兄弟会话」；
 *  函数名 scanLivePeers 保留——「兄弟会话」概念在内部符号里仍准确，九仓调研词汇同源）。
 *
 *  纪律：扫描一律只读（约束 2）——死件/坏件原地跳过不删（D15 不做删除巡逻：删别人留下的文件有
 *  并发竞态，磁盘残留几 KB 无害）；活死分家（约束 4——/sessions 纯历史不调本件）。 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isLive, readLiveFile, type LiveInfo } from "@orosus/core";
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
  return out.sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || b.lastEventAt - a.lastEventAt);
}

// ---------- /ps 输出形态（T4，D16 全量键化） ----------

/** 五态图标（● accent 跑 / ◉ warn 等审批·等输入 / ✗ err 报错 / ○ muted 闲——建议值按方案形态行）。 */
const PHASE_ICON: Record<LiveInfo["phase"], string> = {
  running: theme.fg("accent", "●"),
  "waiting-approval": theme.fg("warn", "◉"),
  "waiting-input": theme.fg("warn", "◉"),
  error: theme.fg("err", "✗"),
  idle: theme.fg("muted", "○"),
};

/** 五态名（键化——/ps 与协同卡共用同一组键，措辞两处一致）。 */
export const phaseName = (p: LiveInfo["phase"]): string =>
  t(`ps.phase.${p === "waiting-approval" ? "waitingApproval" : p === "waiting-input" ? "waitingInput" : p}`);

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
    const title = e.label ?? e.sid.slice(0, 8); // 未命名不裸显全 sid（readTitle 同款口径）
    const tail = theme.dim(` ${relativeTime(e.lastEventAt, opts?.now)}${e.model !== undefined ? ` · ${e.model}` : ""}`) + (r.self ? theme.dim(` · ${t("ps.selfMark")}`) : "");
    lines.push(` ${PHASE_ICON[e.phase]} ${padToWidth(names[i]!, nameW)} ${title}${tail}`);
    if (e.preview !== undefined) lines.push(theme.dim(`${" ".repeat(nameW + 4)}${e.preview}`)); // 缩进对齐标题列
  });
  return lines;
}
