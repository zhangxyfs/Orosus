/** HostedSession —— web 批 T2 托管引擎（每项目每会话一个 core harness 的进程内托管，全批的心脏）：
 *  - 装配：createHarness（cwd/commandUi/builtinModules/sessionsDir/sessionsRoot/resume/fork——CLI
 *    createSession 同清单面；sessionsDir = join(sessionsRoot, encodeCwd(cwd))，§4-8 一律自算桶不碰
 *    CLI 模块级 currentBucket）+ PresenceWriter 逐会话实例 attach kind:"web"（live.json 心跳）。
 *  - 唯一订阅扇出（GC3/§4-3/§5 律三）：HostedSession 是 h.events()/liveChunks() 的唯一订阅者
 *    （单订阅者 Channel——多订会瓜分事件），自持事件 ring（cap 1024——自创值登记）+ 全量 history()
 *    兜底；SSE 客户端（T3）从 onEvent/onChunk/onQueue 订阅口收扇出，禁止每连接各订。
 *  - busy/队列：busy 由 dispatch 占位 + turn/start..end 事件推算；busy 期 dispatch 入队
 *    （{ok:true,queued:true,index}——§3 send 协议同形），turn 结束自动依序补跑；withdraw 撤回即广播
 *    新快照。撞锁（他进程活锁）dispatch 直接 {ok:false, holder}（G14 前的既有纪律，ps.ts 同源判据）。
 *  - close 序 = presence dispose → h.close → purgeIfEmpty（purge 必须在 h.close 完成后——Windows 活
 *    句柄删不动，session-io.ts:36 明文；同 CLI 退出实序 main.ts「h.close 后无句柄可删」）。
 *  - viewer（§4-11）：只读 resume 装配——不发 prompt 永不写盘不撞锁、无 presence（只读打开永不锁，
 *    协同批 D6）；host 接管同会话时由 HostPool 先关只读化身。
 *  - 常驻不回收（§4-15 一期边界）：会话随 server 生命常驻，不做 idle reaper。
 *  waiting-approval/waiting-input 两相位由 T5 WebCommandUi（bridge-ui.ts）接位驱动，本任务只推算
 *  running/idle/error 三值。 */
import { dirname, join } from "node:path";
import {
  createHarness, encodeCwd, isEmptySessionHead, locateSessionFile, pidAlive,
  purgeSessionDir, readLockHolder, readSessionHead, SESSION_LOCK_FILE,
} from "@orosus/core";
import type { Harness, HarnessOptions, LiveInfo, LockHolder, SessionEvent } from "@orosus/core";
import type { CommandUi, ModuleDefinition } from "@orosus/contracts/module";
import { orosusHome } from "@orosus/contracts/home";
import { BUILTIN_MODULES } from "../builtins.ts";
import { PresenceWriter } from "../presence.ts";
import { liveSessionActive } from "../ps.ts";

/** 事件 ring 容量（自创值登记——方案 §5 表：改值先查那里）。ring 是订阅侧最近窗口缓存，完整历史走
 *  harness history()（events() Channel 零订阅者时只留最近 256 条——CH-10 同纪律）。 */
export const RING_CAP = 1024;

/** send 协议结果（§3 send 端点同形）：入队时 {ok:true,queued:true,index}；撞锁 {ok:false,holder}
 *  （holder = 锁载荷实读 {pid,since,label?}——前端 t() 组装人话，D16 口径）。 */
export interface SendResult {
  ok: boolean;
  queued?: boolean;
  index?: number;
  error?: string;
  holder?: { pid: number; since: string; label?: string };
}

/** HostedSession 装配入参（brief 签名 + 少量可选注入面——T1 先例：可选注入不破坏签名形状）：
 *  sid 单独出现（无 forkFrom）= 打开该会话（resume 同源）；与 forkFrom 并存时忽略（fork 产新 sid，
 *  真实 sid 恒以 harness 为准）。sessionsRoot 缺省构造时现读 orosusHome()（GC9——env 感知，不绑
 *  CLI session-io 的模块级常量）；HostPool 传 server home 派生值。modules/config/harness 为测试
 *  注入面（fake provider / close 顺序探针），生产装配不走。 */
export interface HostedInit {
  cwd: string;
  sid?: string;
  resumeSid?: string;
  forkFrom?: string;
  commandUi: CommandUi;
  /** host（写侧，缺省）| viewer（只读）。 */
  mode?: "host" | "viewer";
  sessionsRoot?: string;
  modules?: ModuleDefinition[];
  config?: HarnessOptions["config"];
  /** 测试注入：跳过 createHarness（close 顺序断言的探针位）。 */
  harness?: Harness;
}

/** 空会话清理（session-io purgeIfEmptySession 同款判据——§4-10：live.json 活体护栏 + core
 *  isEmptySessionHead，避免 web 刷出一堆空会话）。root 显式传入——web 侧 sessionsRoot 随 server
 *  home 走。purge 前置 = store 已 close（Windows 活句柄删不动——调用方保证，HostedSession.close 序）。 */
export const purgeIfEmptyAt = (root: string, sid: string): void => {
  const loc = locateSessionFile(root, sid);
  if (loc === undefined) return;
  if (liveSessionActive(loc.dir, process.pid)) return;
  const head = readSessionHead(loc.file);
  if (head !== undefined && isEmptySessionHead(head)) purgeSessionDir(dirname(loc.dir), sid);
};

export class HostedSession {
  readonly cwd: string;
  readonly createdAt: number;
  private currentSid = "";
  private readonly bucketName: string;
  private readonly bucketDir: string;
  private readonly root: string;
  private readonly mode: "host" | "viewer";
  private readonly init: HostedInit;
  private readonly presence: PresenceWriter | undefined;
  private readonly readyGate: Promise<void>;
  private harness: Harness | undefined;
  private closed = false;
  private turnActive = false;
  private dispatching = false;
  private endedWithError = false;
  private ring: SessionEvent[] = [];
  private queue: { index: number; text: string; images?: string[] }[] = [];
  private nextIndex = 0;
  private readonly eventSubs = new Set<(e: SessionEvent) => void>();
  private readonly chunkSubs = new Set<(t: string) => void>();
  private readonly queueSubs = new Set<(items: { index: number; text: string }[]) => void>();

  constructor(init: HostedInit) {
    this.init = init;
    this.cwd = init.cwd;
    this.createdAt = Date.now();
    this.root = init.sessionsRoot ?? join(orosusHome(), "sessions"); // 构造时现读 env（GC9）
    this.bucketName = encodeCwd(init.cwd); // §4-8：一律自算桶（CLI currentBucket 绑死 process.cwd()）
    this.bucketDir = join(this.root, this.bucketName); // 完整桶路径（createHarness sessionsDir/presence/锁共用）
    this.mode = init.mode ?? "host";
    this.presence = this.mode === "host" ? new PresenceWriter() : undefined; // 逐会话实例（host 才挂心跳）
    this.readyGate = this.assemble();
  }

  /** 会话 id：resume/viewer 沿用原 sid，新会话/fork 由 harness 铸（装配完成后有值——Pool 出货前已 await ready）。 */
  get sid(): string { return this.currentSid; }
  /** 项目桶名（= encodeCwd(cwd)）。 */
  get bucket(): string { return this.bucketName; }
  /** 装配完成（createHarness + presence 挂起 + 订阅泵就绪）；失败 reject 由 Pool/调用方定口径。 */
  get ready(): Promise<void> { return this.readyGate; }

  private async assemble(): Promise<void> {
    let h: Harness;
    if (this.init.harness !== undefined) {
      h = this.init.harness; // 测试注入位
    } else {
      const resumeSid = this.init.resumeSid ?? (this.init.forkFrom === undefined ? this.init.sid : undefined);
      h = await createHarness({
        cwd: this.cwd,
        builtinModules: BUILTIN_MODULES,
        ...(this.init.modules !== undefined ? { modules: this.init.modules } : {}),
        commandUi: this.init.commandUi,
        autoTitle: true, // CLI 装配同款（首轮 completed 后自动起标题）
        sessionsDir: this.bucketDir,
        sessionsRoot: this.root,
        ...(resumeSid !== undefined ? { resume: { sessionId: resumeSid } } : {}),
        ...(this.init.forkFrom !== undefined ? { fork: { parentSessionId: this.init.forkFrom } } : {}),
        ...(this.init.config !== undefined ? { config: this.init.config } : {}),
      });
    }
    if (this.closed) {
      // close 抢在装配完成前（SIGINT 清退竞态）——就地清掉刚建好的 harness，不留孤儿
      await h.close().catch(() => undefined);
      return;
    }
    this.harness = h;
    this.currentSid = h.sessionId;
    this.presence?.attach({ h, sessionsDir: this.bucketDir, sid: h.sessionId, kind: "web" });
    this.startPumps();
  }

  /** 唯一订阅泵：events()/liveChunks() 各订一次，向订阅口扇出（GC3——禁止每连接各订 core 通道）。 */
  private startPumps(): void {
    const h = this.harness!;
    void (async () => {
      try {
        for await (const e of h.events()) {
          if (this.closed) break;
          this.ingest(e);
        }
      } catch { /* 订阅面异常不拦托管（close 路径通道关闭属正常） */ }
    })();
    void (async () => {
      try {
        for await (const c of h.liveChunks()) {
          if (this.closed) break;
          if (c.type !== "text/delta" && c.type !== "reasoning/delta") continue; // 只扇文本增量（§3 chunk 帧 {"text"}）
          const text = c.text;
          for (const cb of Array.from(this.chunkSubs)) { // 快照迭代——回调内退订不跳元素
            try { cb(text); } catch { /* 订阅方异常不拦扇出 */ }
          }
        }
      } catch { /* 同上 */ }
    })();
  }

  /** 事件摄入：ring 留窗 + busy/phase 推算 + 扇出 + turn 结束补跑队列。 */
  private ingest(e: SessionEvent): void {
    this.ring.push(e);
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
    if (e.type === "turn/start") {
      this.turnActive = true;
      this.endedWithError = false;
    } else if (e.type === "turn/end") {
      this.turnActive = false;
      this.endedWithError = (e as { kind?: unknown }).kind === "error";
    }
    for (const cb of Array.from(this.eventSubs)) { // 快照迭代——回调内退订不跳元素
      try { cb(e); } catch { /* 订阅方异常不拦扇出 */ }
    }
    if (e.type === "turn/end") this.drainQueue(); // 扇出 turn/end 后再补跑（订阅方先看到本轮收尾）
  }

  /** busy = dispatch 占位 || turn 活跃（dispatch 同步占位防微任务窗双发——§4-4「prompt 并发期再调抛错，
   *  send 端点内部串行化」的托管制实现）。 */
  busy(): boolean { return this.dispatching || this.turnActive; }

  /** 相位（LiveInfo 五值同源）：running/idle/error 本任务推算；waiting-approval/waiting-input 由
   *  T5 WebCommandUi 的 interaction 桥驱动（本任务不实现——YAGNI）。 */
  phase(): LiveInfo["phase"] {
    if (this.dispatching || this.turnActive) return "running";
    return this.endedWithError ? "error" : "idle";
  }

  /** 入队（busy 期 dispatch 的去处）：index 单调不复用（§3 DELETE /queue/:index 以最近快照为准）。 */
  enqueue(text: string, images?: string[]): number {
    const index = this.nextIndex++;
    this.queue.push({ index, text, ...(images !== undefined && images.length > 0 ? { images } : {}) });
    this.broadcastQueue();
    return index;
  }

  /** 撤回：命中即删 + 广播新快照；不在队 = false。 */
  withdraw(index: number): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((x) => x.index !== index);
    if (this.queue.length === before) return false;
    this.broadcastQueue();
    return true;
  }

  private broadcastQueue(): void {
    const items = this.queue.map((x) => ({ index: x.index, text: x.text }));
    for (const cb of Array.from(this.queueSubs)) { // 快照迭代——回调内退订不跳元素
      try { cb(items); } catch { /* 订阅方异常不拦扇出 */ }
    }
  }

  /** cmdrouter 分流后的执行口（prompt/命令——T6 消费）：busy → 入队；撞他进程活锁 → {ok:false,holder}；
   *  其余 h.prompt 闭环。命令返回文本不在此透出（命令面走事件/toast——§4-4）。 */
  async dispatch(text: string, images?: string[]): Promise<SendResult> {
    if (this.closed) return { ok: false, error: "会话已关闭" };
    if (this.mode === "viewer") return { ok: false, error: "viewer 会话只读（不发 prompt）" };
    if (this.busy()) {
      const index = this.enqueue(text, images);
      return { ok: true, queued: true, index };
    }
    this.dispatching = true; // 同步占位（先于任何 await）——微任务窗内第二个 dispatch 只能入队
    try {
      await this.readyGate;
      const h = this.harness;
      if (h === undefined) return { ok: false, error: "会话装配失败" };
      const holder = this.foreignLockHolder();
      if (holder !== undefined) {
        return {
          ok: false,
          error: `会话正被另一个 Orosus 进程使用（pid ${holder.pid}）`,
          holder: { pid: holder.pid, since: holder.since, ...(holder.label !== undefined ? { label: holder.label } : {}) },
        };
      }
      await h.prompt(text, images !== undefined && images.length > 0 ? { images } : {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.dispatching = false;
      this.drainQueue(); // 命令类 dispatch 不产 turn/end——收尾处统一补跑队列
    }
  }

  /** 他进程活锁探测（ps.ts lockHeldByOther 同源判据，取全量载荷供 holder 字段）：自己/死 pid/无锁 = 放行。 */
  private foreignLockHolder(): LockHolder | undefined {
    if (this.currentSid === "") return undefined;
    const holder = readLockHolder(join(this.bucketDir, this.currentSid, "agents", SESSION_LOCK_FILE));
    if (holder === null || holder.pid === process.pid) return undefined;
    return pidAlive(holder.pid) ? holder : undefined;
  }

  /** turn 结束/命令收尾后的队列补跑：非 busy 且有队首 → 依序执行下一条（§3 send 排队语义）。 */
  private drainQueue(): void {
    if (this.closed || this.busy()) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.broadcastQueue();
    void this.dispatch(next.text, next.images);
  }

  /** Esc×2 同款全停（§3 POST /cancel）：h.cancel + stopAllSubagents（挂起审批自动按拒绝收场）。 */
  cancel(): void {
    this.harness?.cancel();
    this.harness?.stopAllSubagents();
  }

  /** 事件扇出订阅口（T3 SSE 的 ev 帧源）。返回退订函数。 */
  onEvent(cb: (e: SessionEvent) => void): () => void {
    this.eventSubs.add(cb);
    return () => { this.eventSubs.delete(cb); };
  }

  /** 流式增量扇出口（T3 SSE 的 chunk 帧源——50ms 合批在彼处，本口只转发）。 */
  onChunk(cb: (t: string) => void): () => void {
    this.chunkSubs.add(cb);
    return () => { this.chunkSubs.delete(cb); };
  }

  /** 队列整表快照广播口（§3 queue 帧——多标签一致性）。 */
  onQueue(cb: (items: { index: number; text: string }[]) => void): () => void {
    this.queueSubs.add(cb);
    return () => { this.queueSubs.delete(cb); };
  }

  /** 回放段（T3 SSE 首屏补齐/重连 backfill 源——「事件订阅自持 ring（cap 1024）+ 全量 history() 兜底」
   *  语义）：seq > after 的事件升序。ring 覆盖（首元素 seq ≤ after+1——(after, ring 尾] 全在 ring）走
   *  内存快路径；ring 空或不覆盖（resume 会话的历史前缀不在 ring——pump 只收订阅后事件）→ 全量
   *  history() 兜底。 */
  async replayAfter(after: number): Promise<SessionEvent[]> {
    if (this.ring.length > 0 && this.ring[0]!.seq <= after + 1) {
      return this.ring.filter((e) => e.seq > after);
    }
    const h = this.harness;
    if (h === undefined) return this.ring.filter((e) => e.seq > after);
    const all = await h.history();
    return all.filter((e) => e.seq > after);
  }

  /** 分页回放（T3 GET events 端点消费——core eventsBefore 透传：索引查段 + pread，首屏有界 §5 律三；
   *  fork 复合视图恒空是 core 口径）。 */
  eventsPage(beforeSeq: number, limit: number): Promise<SessionEvent[]> {
    const h = this.harness;
    if (h === undefined) return Promise.resolve([]);
    return h.eventsBefore(this.currentSid, beforeSeq, limit);
  }

  /** 关停序（brief 定档）：presence dispose → h.close → purgeIfEmpty（purge 必须在 h.close 完成**后**——
   *  Windows 活句柄删不动，session-io.ts:36 明文；同 CLI 退出实序）。幂等；viewer 无 presence、不 purge
   *  （只读化身不拥有会话——清理归 host/退出漏斗）。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.readyGate.catch(() => undefined); // 装配失败也继续（harness 缺席则跳过对应步）
    this.presence?.dispose();
    if (this.harness !== undefined) await this.harness.close();
    if (this.mode === "host" && this.currentSid !== "") purgeIfEmptyAt(this.root, this.currentSid);
  }
}
