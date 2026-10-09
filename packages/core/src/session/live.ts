/** live.json 活体心跳纯函数件（m5-collab T0，方案 D1/D3/D4/D5/D12/D15）：
 *  每个运行中的 CLI 进程在自己会话目录（<桶>/<sid>/）根写 live.json——跨进程互见的统一事实源
 *  （消费者：/ps 命令、侧栏协同卡、多开提示；将来 web 看板与 tool-peers 活性对齐〔顺延台账〕）。
 *  纯文件方案零网络（全局约束 1）；只写自己的文件、扫描一律只读（约束 2）；崩溃残留靠过期判死
 *  兜住，不做删除巡逻（D15——removeLiveFile 仅删自家且 token 校验防误删）。
 *
 *  活性双判据（D5）：pid 存活 AND max(lastEventAt, 文件 mtime) ≤ staleMs。
 *  - pid 死即死（pidAlive 复用 jsonl.ts CS-03 已导出件，EPERM 视为活）；
 *  - lastEventAt = 最后真实活动（turn 事件/等待变化驱动）——展示「多久前活动」与 hang 检测的数据源，
 *    心跳摸活**不**刷新它（刷新则闲置会话恒显「刚刚」、hang 检测失效）；
 *  - 文件 mtime = 心跳新鲜度——写器每 15s 摸活重写本文件，mtime 恒新即「进程还在正常转」，
 *    闲着（无真实活动）的会话因此不判死；同秒写吞 mtime 的残余窗口由 max() 另一侧兜住。
 *  pid 复用残余风险接受（Windows 无 /proc/boot-id 三重防，窗口极小，方案 D5 注记）。 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./wlock.ts";
import type { SessionEvent } from "./types.ts";

/** live.json 载荷 schema（v:1——版本字段留着将来加列不炸旧读者）。 */
export interface LiveInfo {
  v: 1;
  sid: string;
  pid: number;
  /** 本进程实例 token（uuid）——删文件时校验，防 stale 进程误删新化身的文件（D15）。 */
  token: string;
  /** web 为预留值（web 前瞻 D12）——本批仅枚举收位不写入。 */
  kind: "tui" | "line" | "web";
  /** D3 五值状态机：running / waiting-approval（等审批）/ waiting-input（等问询）/ idle / error
   *  （上轮报错，信号 = turn/end kind=error，下个 turn/start 清）。 */
  phase: "running" | "waiting-approval" | "waiting-input" | "idle" | "error";
  /** 进程（会话化身）启动时刻 epoch ms。 */
  startedAt: number;
  /** 最后真实活动 epoch ms（事件驱动写的时刻）——心跳不刷新，见文件头注。 */
  lastEventAt: number;
  /** 会话标题（session/label 事件缓存，存储层截 60 对齐标题帽；显示层各取 40——D4 两层口径）。 */
  label?: string;
  /** 摸活时现读 h.status() 的模型名。 */
  model?: string;
  /** turn/end 冻结的 assistant 文本尾 40 字（ZCode lastAssistantPreview 先例化用）。 */
  preview?: string;
}

export const LIVE_FILE = "live.json";

/** 读侧记录：载荷 + 文件 mtime（活性第二判据的新鲜度源——不进载荷，盘上 schema 不受读侧污染）。 */
export interface LiveRecord {
  info: LiveInfo;
  mtimeMs: number;
}

const KINDS: ReadonlySet<string> = new Set(["tui", "line", "web"]);
const PHASES: ReadonlySet<string> = new Set(["running", "waiting-approval", "waiting-input", "idle", "error"]);

/** 载荷形状校验（坏 JSON/缺字段/枚举越界 → undefined——他进程的伴生件不许炸本进程扫描）。 */
const parseLiveInfo = (raw: string): LiveInfo | undefined => {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof o !== "object" || o === null) return undefined;
  const p = o as Record<string, unknown>;
  if (p.v !== 1) return undefined;
  if (typeof p.sid !== "string" || p.sid === "") return undefined;
  if (typeof p.pid !== "number" || !Number.isInteger(p.pid) || p.pid <= 0) return undefined;
  if (typeof p.token !== "string" || p.token === "") return undefined;
  if (typeof p.kind !== "string" || !KINDS.has(p.kind)) return undefined;
  if (typeof p.phase !== "string" || !PHASES.has(p.phase)) return undefined;
  if (typeof p.startedAt !== "number" || typeof p.lastEventAt !== "number") return undefined;
  if (p.label !== undefined && typeof p.label !== "string") return undefined;
  if (p.model !== undefined && typeof p.model !== "string") return undefined;
  if (p.preview !== undefined && typeof p.preview !== "string") return undefined;
  return o as LiveInfo;
};

/** 活性判定（D5 双判据取交）：pid 存活 AND max(lastEventAt, mtime) ≤ staleMs；pid 死即死。 */
export function isLive(rec: LiveRecord, now: number, staleMs: number): boolean {
  return pidAlive(rec.info.pid) && now - Math.max(rec.info.lastEventAt, rec.mtimeMs) <= staleMs;
}

/** 读 live.json（只读——扫描方纪律）：文件不在/读不出/坏 JSON/缺字段 → undefined（调用方跳过不炸）。 */
export function readLiveFile(dir: string): LiveRecord | undefined {
  const file = join(dir, LIVE_FILE);
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(file, "utf8");
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const info = parseLiveInfo(raw);
  return info === undefined ? undefined : { info, mtimeMs };
}

/** 写 live.json（只写自己目录——单写者语义由「只写自己」保证，无需锁）。内含目录 mkdir 保底：
 *  全新会话首 turn 前会话目录可能还没建（jsonl 懒建语义 D46——心跳不能等首次落盘才上岗）。 */
export function writeLiveFile(dir: string, info: LiveInfo): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LIVE_FILE), JSON.stringify(info), { mode: 0o600 });
}

/** 删 live.json（退出/释放时仅删自家文件）：token 不符不删——stale 进程晚退时不许误删
 *  同 sid 新化身的文件（D15 并发安全）；文件不存在/损坏（token 不可校验）静默返回。 */
export function removeLiveFile(dir: string, token: string): void {
  const file = join(dir, LIVE_FILE);
  if (!existsSync(file)) return;
  const rec = readLiveFile(dir);
  if (rec === undefined || rec.info.token !== token) return;
  try {
    rmSync(file, { force: true });
  } catch { /* 删不掉留档：过期判死兜底（D15） */ }
}

/** 镜像倒扫末条 session/label 的标题（label 事件载荷 { label }；窗口装载的头种子含 label——
 *  resume 路径不缺）。无 label 历史 = undefined。单源：jsonl 锁载荷快照 / sqlite 锁载荷 / presence
 *  心跳 label 派生共用（code-review 轮抽出的三处重复）。 */
export function lastSessionLabel(events: SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "session/label") continue;
    const v = (e as { label?: unknown }).label;
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}
