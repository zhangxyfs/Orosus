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
