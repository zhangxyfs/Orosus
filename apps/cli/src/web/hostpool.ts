/** HostPool —— web 批 T2 项目池（T9 扩展为全桶数据面）：server 生命周期内的会话托管面
 *  （host 写侧 + viewer 只读 LRU）+ 左栏会话列表的全部数据面。
 *  - host（create/openSession）：写侧装配（PresenceWriter kind=web、dispatch/队列/close 序见
 *    hosted.ts）；同 resumeSid 幂等（重复 create 沿用既有托管，不重装配）；**per-key in-flight
 *    互斥**（T2 审查遗留指针——并发同 resumeSid create / 并发 viewer 会重复装配泄漏，T9 路由
 *    使其可达后必须互斥）：同键并发调用共享同一装配 Promise。
 *  - fresh 沿用（B13）：cwd 形创建先查「该项目的 fresh 空会话」（托管中 → 直接沿用；盘上 →
 *    resume 沿用 + touch 刷新排序时间），命中返回 reused:true——并发双击不落两个 fresh
 *    （per-cwd 创建锁 = 同 in-flight 键）。
 *  - viewer（§4-11）：只读 harness（createHarness({resume})——不发 prompt 永不写盘不撞锁，无
 *    presence），LRU 8（自创值登记——§5 表）逐出即 close；host 接管同会话时只读化身先关。
 *  - 全桶扫描缓存（§5 律三）：snapshot() TTL 1s（SCAN_CACHE_MS 自创值登记——多客户端共享，
 *    成本不随客户端数放大；磁盘行 + 托管无盘行合并 + 跨桶 peers 合并 + bucket→cwd 反查）。
 *    变更类动作（建会话/归档/恢复/删除）显式 invalidateScan 收口陈旧窗。
 *  - switchCurrent/current：前端「当前会话」游标（server 持——/web 交接后指向交接会话，
 *    /api/bootstrap currentSid 消费；POST /api/sessions 打开/创建即切换〔B1 跟随语义〕）。
 *  - closeAll（G15 SIGINT 清退序）：全部 host+viewer 逐个 close（幂等），清表清游标。 */
import { existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  encodeCwd, isEmptySessionHead, locateSessionFile, readSessionHead, scanBucketSessions, scanSessionFiles,
} from "@orosus/core";
import type { CommandUi } from "@orosus/contracts/module";
import { orosusHome } from "@orosus/contracts/home";
import { liveSessionActive, lockHeldByOther, scanLivePeers, type PeerEntry } from "../ps.ts";
import { HostedSession } from "./hosted.ts";
import { bucketCwd, headerCwd } from "./buckets.ts";

/** viewer 只读化身容量（自创值登记——方案 §5 表：改值先查那里）。 */
export const VIEWER_LRU = 8;

/** 全桶扫描缓存 TTL（§5 律三「扫描解析有缓存」——自创值登记：≥1s；1s 窗内多客户端共享同一份
 *  扫描结果，2s 轮询的前端在缓存过期后自然重扫）。 */
export const SCAN_CACHE_MS = 1_000;

/** 托管会话是否 fresh（B13 判据 = 无 user/message 且无 session/label——isEmptySessionHead 的
 *  事件面同源；replayAfter 在 ring 覆盖时走内存快路径，仅 resume 会话首查付一次全量读）。 */
export const freshOf = async (hs: HostedSession): Promise<boolean> => {
  try {
    const evs = await hs.replayAfter(0);
    return !evs.some((e) => e.type === "user/message" || (e.type === "session/label" && typeof e.label === "string" && e.label !== ""));
  } catch {
    return false; // 读面异常按非 fresh 处理（宁可新建不误沿用）
  }
};

/** 无头 CommandUi（core 缺省拒绝式四法同款）：未注入 commandUi 的池（测试）的缺省装配——交互式
 *  命令 fail-closed，不炸托管。生产装配（mod.ts）注入 T5 webCommandUiFactory（逐会话 WebCommandUi）。 */
const headlessUi: CommandUi = {
  ask: async () => { throw new Error("无交互环境（headless）——web 交互桥未装配（T5 接位）"); },
  askSecret: async () => { throw new Error("无交互环境（headless）——web 交互桥未装配（T5 接位）"); },
  choose: async () => { throw new Error("无交互环境（headless）——web 交互桥未装配（T5 接位）"); },
  confirm: async () => { throw new Error("无交互环境（headless）——web 交互桥未装配（T5 接位）"); },
};

/** 扫描行（磁盘行 + 托管无盘行统一形——hosted fresh 会话 header 懒写〔harness M4-1 T0〕，磁盘
 *  扫描天然不见，靠合并补进左栏；file 缺席 = 无主文件）。 */
export interface PoolScanRow {
  sid: string;
  bucket: string;
  dir: string;
  file?: string;
  mtimeMs: number;
  label: string;
  archived: boolean;
  fresh: boolean;
}

/** 全桶扫描快照（缓存载荷）：rows = 会话行；peers = 跨桶合并的活体表（scanLivePeers 逐桶——
 *  B4/E6 协同面）；buckets = 桶→cwd（含托管-only 桶——cwd 芯片/bootstrap 全量）。 */
export interface ScanSnapshot {
  at: number;
  rows: PoolScanRow[];
  peers: Map<string, PeerEntry>;
  buckets: Map<string, string>;
}

/** 打开会话结果（B13：reused = 沿用了同项目 fresh 空会话——仅 cwd 形产生）。 */
export interface OpenResult {
  hs: HostedSession;
  reused: boolean;
}

export class HostPool {
  /** sessions 根（= join(home, "sessions")——与 CLI sessionsRoot 同形；路由存在性判据共用）。 */
  readonly root: string;
  /** server 数据根（pins.json/workspaces.json 等 web 私有数据落点——GC9）。 */
  readonly home: string;
  /** server 启动 cwd（B1 跟随回落的「无当前会话」档——POST /api/sessions 无 cwd 形缺省源）。 */
  readonly startCwd: string;
  private readonly commandUi: CommandUi | ((hs: HostedSession) => CommandUi);
  private readonly hosts = new Map<string, HostedSession>();
  private readonly viewers = new Map<string, HostedSession>();
  private viewerOrder: string[] = [];
  private currentSid: string | undefined;
  /** per-key 装配互斥（T2 审查指针：并发同键 create/viewer 重复装配泄漏）。 */
  private readonly openInFlight = new Map<string, Promise<OpenResult>>();
  private readonly viewerInFlight = new Map<string, Promise<HostedSession>>();
  /** 全桶扫描缓存（§5 律三）+ 扫描计数（⑦ 断言面）。 */
  private snapshotCache: ScanSnapshot | undefined;
  private scans = 0;

  constructor(init: { home?: string; cwd?: string; commandUi?: CommandUi | ((hs: HostedSession) => CommandUi) } = {}) {
    this.home = init.home ?? orosusHome();
    this.root = join(this.home, "sessions");
    this.startCwd = init.cwd ?? process.cwd();
    this.commandUi = init.commandUi ?? headlessUi;
  }

  /** 写侧托管查询（viewer-only 会话 = undefined）。 */
  host(sid: string): HostedSession | undefined {
    return this.hosts.get(sid);
  }

  /** 池内查询（host 或 viewer——T9 删除守卫/归档路由的「本进程托管」判据）。 */
  lookup(sid: string): HostedSession | undefined {
    return this.hosts.get(sid) ?? this.viewers.get(sid);
  }

  /** 只读打开（LRU 8）：已 host 直返 host；未在池 = 装配 viewer（会话不在盘 → 抛错）。
   *  per-key in-flight 互斥（T2 审查指针）：并发同 sid 共享一次装配。 */
  async viewer(sid: string): Promise<HostedSession> {
    const hosted = this.hosts.get(sid);
    if (hosted !== undefined) return hosted;
    const cached = this.viewers.get(sid);
    if (cached !== undefined) {
      this.touchViewer(sid);
      return cached;
    }
    const inFlight = this.viewerInFlight.get(sid);
    if (inFlight !== undefined) return inFlight;
    const p = this.doViewer(sid).finally(() => { this.viewerInFlight.delete(sid); });
    this.viewerInFlight.set(sid, p);
    return p;
  }

  private async doViewer(sid: string): Promise<HostedSession> {
    const loc = locateSessionFile(this.root, sid);
    if (loc === undefined) throw new Error(`会话 ${sid} 不存在`);
    const hs = new HostedSession({
      cwd: headerCwd(loc.file) ?? process.cwd(),
      resumeSid: sid,
      commandUi: this.commandUi,
      sessionsRoot: this.root,
      mode: "viewer",
    });
    await hs.ready;
    // 跨方法竞态收口（openSession 同 sid 并发接管 host）：装配完成时 host 已在场则弃用刚建的化身
    const hosted = this.hosts.get(sid);
    if (hosted !== undefined) {
      await hs.close().catch(() => undefined);
      return hosted;
    }
    this.viewers.set(sid, hs);
    this.touchViewer(sid);
    this.evictViewers();
    return hs;
  }

  /** 写侧装配（T2 契约薄封装——/web 交接等：fresh 沿用语义照走，reused 标志消费方自理）。 */
  async create(opts: { cwd: string; resumeSid?: string; forkFrom?: string }): Promise<HostedSession> {
    const { hs } = await this.openSession(opts);
    return hs;
  }

  /** 打开会话（POST /api/sessions 三形态的池面）：
   *  - per-key in-flight 互斥：resumeSid 形同 sid 共享、cwd 形同 cwd 共享（并发双击一个 fresh）、
   *    forkFrom 形同 (cwd, forkFrom) 共享；
   *  - cwd 形 fresh 沿用（B13）：托管 fresh → 直接沿用；盘上 fresh（非归档、无外部活锁）→ resume
   *    沿用 + touch 刷新排序时间；否则新建。
   *  - resumeSid/forkFrom 形：幂等/新建（reused 恒 false——B13 语义只属 fresh 沿用）。 */
  async openSession(opts: { cwd: string; resumeSid?: string; forkFrom?: string }): Promise<OpenResult> {
    const key = opts.resumeSid !== undefined
      ? `r:${opts.resumeSid}`
      : opts.forkFrom !== undefined
        ? `f:${opts.forkFrom}\u0000${opts.cwd}`
        : `c:${opts.cwd}`;
    const inFlight = this.openInFlight.get(key);
    if (inFlight !== undefined) return inFlight;
    const p = this.doOpen(opts).finally(() => { this.openInFlight.delete(key); });
    this.openInFlight.set(key, p);
    return p;
  }

  private async doOpen(opts: { cwd: string; resumeSid?: string; forkFrom?: string }): Promise<OpenResult> {
    if (opts.resumeSid !== undefined) {
      const existing = this.hosts.get(opts.resumeSid);
      if (existing !== undefined) return { hs: existing, reused: false }; // 幂等沿用（T2 契约）
      return { hs: await this.assemble(opts), reused: false };
    }
    if (opts.forkFrom !== undefined) return { hs: await this.assemble(opts), reused: false };
    // cwd 形：fresh 沿用（B13）——托管 fresh 优先（新会话 header 懒写不在盘，磁盘查不见）
    for (const hs of this.hosts.values()) {
      if (hs.cwd !== opts.cwd) continue;
      if (await freshOf(hs)) return { hs, reused: true };
    }
    // 盘上 fresh（崩溃残留的空壳复用——「在该工作区新建」不重复建）
    const bucketDir = join(this.root, encodeCwd(opts.cwd));
    const diskFresh = scanBucketSessions(bucketDir)
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
      .find((e) =>
        !existsSync(join(e.dir, "agents", "archived"))
        && !liveSessionActive(e.dir, process.pid) // 外部进程正开着（空会话的占用信号是 live.json）
        && lockHeldByOther(bucketDir, e.id, process.pid) === null
        && (() => { const head = readSessionHead(e.file); return head !== undefined && isEmptySessionHead(head); })());
    if (diskFresh !== undefined) {
      const hs = await this.assemble({ cwd: opts.cwd, resumeSid: diskFresh.id });
      try { utimesSync(diskFresh.file, new Date(), new Date()); } catch { /* touch 尽力而为 */ }
      return { hs, reused: true };
    }
    return { hs: await this.assemble(opts), reused: false };
  }

  /** 装配本体（T2 create 序）：host 接管同会话的 viewer 只读化身时先关再换（免双订阅浪费）。 */
  private async assemble(opts: { cwd: string; resumeSid?: string; forkFrom?: string }): Promise<HostedSession> {
    const staleViewer = opts.resumeSid !== undefined ? this.viewers.get(opts.resumeSid) : undefined;
    const hs = new HostedSession({
      cwd: opts.cwd,
      ...(opts.resumeSid !== undefined ? { resumeSid: opts.resumeSid } : {}),
      ...(opts.forkFrom !== undefined ? { forkFrom: opts.forkFrom } : {}),
      commandUi: this.commandUi,
      sessionsRoot: this.root,
    });
    await hs.ready;
    if (staleViewer !== undefined) {
      this.viewers.delete(opts.resumeSid!);
      this.viewerOrder = this.viewerOrder.filter((s) => s !== opts.resumeSid);
      await staleViewer.close().catch(() => undefined);
    }
    this.hosts.set(hs.sid, hs);
    this.invalidateScan(); // 新托管（含 fresh 无盘行）即刻可见
    return hs;
  }

  /** 前端「当前会话」游标（server 持——/web 交接后指向交接会话；POST /api/sessions 打开即切换）。 */
  switchCurrent(sid: string): void {
    this.currentSid = sid;
  }

  current(): HostedSession | undefined {
    return this.currentSid === undefined ? undefined : this.hosts.get(this.currentSid);
  }

  // ---------- 全桶扫描缓存（§5 律三）----------

  /** 扫描计数（⑦ 断言面：1s 窗内多客户端只 +1）。 */
  sessionScanCount(): number {
    return this.scans;
  }

  /** 变更后显式失效（建会话/归档/恢复/删除——把陈旧窗从 ≤TTL 收口到即时）。 */
  invalidateScan(): void {
    this.snapshotCache = undefined;
  }

  /** 全桶扫描快照（TTL 内共享；同步构建——单线程内检查-构建原子，并发请求自然单飞）。 */
  snapshot(): ScanSnapshot {
    if (this.snapshotCache !== undefined && Date.now() - this.snapshotCache.at < SCAN_CACHE_MS) {
      return this.snapshotCache;
    }
    this.scans++;
    const snap = this.buildSnapshot();
    this.snapshotCache = snap;
    return snap;
  }

  private buildSnapshot(): ScanSnapshot {
    const rows: PoolScanRow[] = [];
    const peers = new Map<string, PeerEntry>();
    const buckets = new Map<string, string>();
    const entries = scanSessionFiles(this.root); // mtime 倒序
    for (const e of entries) {
      if (!buckets.has(e.bucket)) buckets.set(e.bucket, bucketCwd(this.root, e.bucket) ?? "");
      const head = readSessionHead(e.file);
      rows.push({
        sid: e.id,
        bucket: e.bucket,
        dir: e.dir,
        file: e.file,
        mtimeMs: e.mtimeMs,
        label: head?.label ?? head?.firstUser ?? "",
        archived: existsSync(join(e.dir, "agents", "archived")),
        fresh: head !== undefined && isEmptySessionHead(head),
      });
    }
    // 跨桶 peers 合并（B4/E6：scanLivePeers 逐桶——sid 目录名为准，Map 键天然去重）
    for (const bucket of buckets.keys()) {
      for (const p of scanLivePeers(join(this.root, bucket), "")) peers.set(p.sid, p);
    }
    // 托管无盘行合并（fresh 新会话 header 懒写不在磁盘扫描集——左栏即时可见；托管-only 桶进 buckets）
    for (const hs of this.hosts.values()) {
      // T18 走查修：托管 cwd 覆盖空反查（fresh 桶盘上只有 manifest——bucketCwd miss 得 ""；
      // 托管会话的 cwd 是权威值：组名/B10 显隐/B8 tooltip 全靠它）
      if (buckets.get(hs.bucket) === undefined || buckets.get(hs.bucket) === "") buckets.set(hs.bucket, hs.cwd);
      if (!rows.some((r) => r.sid === hs.sid)) {
        rows.push({
          sid: hs.sid,
          bucket: hs.bucket,
          dir: hs.sessionDir ?? join(this.root, hs.bucket, hs.sid),
          mtimeMs: hs.createdAt,
          label: "",
          archived: false,
          fresh: true,
        });
      }
    }
    return { at: Date.now(), rows, peers, buckets };
  }

  /** 全部关停（G15 SIGINT 清退序——T1 onShutdown 注册位消费）：先清表（host 查询即刻失效）再逐个
   *  close（close 序见 HostedSession.close）。幂等。 */
  async closeAll(): Promise<void> {
    const all = [...this.hosts.values(), ...this.viewers.values()];
    this.hosts.clear();
    this.viewers.clear();
    this.viewerOrder = [];
    this.currentSid = undefined;
    await Promise.all(all.map((hs) => hs.close().catch(() => undefined)));
  }

  /** 关停并摘除单个会话（T6 /quit 与 T9 删除守卫共用——G10 web 语义：关当前会话，server 常驻）：
   *  先清表（host 查询即刻失效——后续请求按盘上会话走 viewer 只读化身）再 close（closeAll 同序）。
   *  幂等（不在池 = no-op）。 */
  async remove(sid: string): Promise<void> {
    const hs = this.hosts.get(sid) ?? this.viewers.get(sid);
    this.hosts.delete(sid);
    this.viewers.delete(sid);
    this.viewerOrder = this.viewerOrder.filter((s) => s !== sid);
    if (this.currentSid === sid) this.currentSid = undefined;
    await hs?.close().catch(() => undefined);
    this.invalidateScan();
  }

  private touchViewer(sid: string): void {
    this.viewerOrder = this.viewerOrder.filter((s) => s !== sid);
    this.viewerOrder.push(sid);
  }

  private evictViewers(): void {
    while (this.viewers.size > VIEWER_LRU) {
      const victim = this.viewerOrder.shift();
      if (victim === undefined) break;
      const hs = this.viewers.get(victim);
      this.viewers.delete(victim);
      if (hs !== undefined) void hs.close().catch(() => undefined); // LRU 逐出即 close（§4-11）
    }
  }
}
