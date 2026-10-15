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
 *  waiting-approval/waiting-input 两相位由 T5 WebCommandUi（bridge-ui.ts）经 setWaiting 挂点驱动；
 *  close 起点跑关停钩子（挂起 interaction fail-closed 收场）。 */
import { openSync, readSync, closeSync } from "node:fs";
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
import { t } from "../i18n/app.ts";
import { busyExecutable, commandNameOf, QUIT_CMDS, routeCommand, WEB_BUSY_BLOCK } from "./cmdrouter.ts";

/** 事件 ring 容量（自创值登记——方案 §5 表：改值先查那里）。ring 是订阅侧最近窗口缓存，完整历史走
 *  harness history()（events() Channel 零订阅者时只留最近 256 条——CH-10 同纪律）。 */
export const RING_CAP = 1024;

/** promptId admission 保留数（自创值登记——方案 §5 表「promptId admission 保留最近 256」：send 幂等
 *  键去重表的上限，防长驻 server 无界增长）。 */
const PROMPT_ID_ADMISSION_CAP = 256;

/** 宿主旁注事件（core prompt afterUserEvent 数组形态——main.ts:1232 同源消费面：@ 引用展开等
 *  「发出体 ≠ 输入原文」场景经此把原话紧随 user/message 落盘，召回/回放取原文）。 */
export type AfterUserEvent = { type: string; fields: Record<string, unknown> }[];

/** send 协议结果（§3 send 端点同形）：入队时 {ok:true,queued:true,index}；撞锁 {ok:false,holder}
 *  （holder = 锁载荷实读 {pid,since,label?}——前端 t() 组装人话，D16 口径）。T6 命令面扩两键：
 *  output = 命令输出文本（§4-4 静默命令 "" 不带键——D16 命令行不进流区，输出走 toast/浮层）；
 *  mark = 路由信号（cmdrouter.CommandMark——quit 由 server 执行，new/fork/skill/menu:model/tasks
 *  由前端消费）。 */
export interface SendResult {
  ok: boolean;
  queued?: boolean;
  index?: number;
  error?: string;
  holder?: { pid: number; since: string; label?: string };
  output?: string;
  mark?: string;
  /** 无参 /btw 归档轮次搭载（走查修 2026-10-13：回看水合进 btw 选项卡，弹窗退役——cmdrouter → 前端）。 */
  btwRounds?: { q: string; a: string }[];
}

/** btw 流帧（T6 cmdrouter 消费——SSE `event: btw` 帧源；W5 多轮化扩形）：tab = 侧问选项卡 id
 *  （多轮 per-tab 实例——帧随 tab 路由到对应选项卡；旧单轮路径固定 "btw"）；answering = 累积正文
 *  （晚开窗整段渲染）、tool = 工具查证中（前端显「查证中…」——W6 消费，本批只定帧形）、answer =
 *  终态全文、error = 失败原因；round = 问题轮序（1 起——同轮内的查证与回答同号）。旁路快问不经
 *  turn/chunk 通道（零落盘），独立帧面与主流区分（busy 期 /btw 与主 turn 并流不串台）。
 *  走查修（2026-10-13 用户报障②）：thinking = 累积思考文本（reasoning/delta 消费——与主流思考块
 *  同源；先于正文到达，answer 后仍保留展示）。 */
export interface BtwFrame {
  tab: string;
  phase: "answering" | "answer" | "error" | "tool" | "thinking";
  text: string;
  round: number;
}

/** HostedSession 装配入参（brief 签名 + 少量可选注入面——T1 先例：可选注入不破坏签名形状）：
 *  sid 单独出现（无 forkFrom）= 打开该会话（resume 同源）；与 forkFrom 并存时忽略（fork 产新 sid，
 *  真实 sid 恒以 harness 为准）。sessionsRoot 缺省构造时现读 orosusHome()（GC9——env 感知，不绑
 *  CLI session-io 的模块级常量）；HostPool 传 server home 派生值。modules/config/harness 为测试
 *  注入面（fake provider / close 顺序探针），生产装配不走。commandUi 亦可给工厂（T5：WebCommandUi
 *  需逐会话绑定 broadcast/presence/close 钩子——assemble 期以 self 解析，HostPool 透传同参）。 */
export interface HostedInit {
  cwd: string;
  sid?: string;
  resumeSid?: string;
  forkFrom?: string;
  commandUi: CommandUi | ((self: HostedSession) => CommandUi);
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

/** 会话文件头部是否含 session/fork 标记（T18 走查修——fork 子体检测）：fork 子体的盘上实形 =
 *  首行 session/header + 次行 session/fork（fork.ts 即刻落盘保证——resume 后续事件只追加在后）。
 *  本函数写实口径：读首 8KB、逐行 parse **至多前三个非空行**，任一行 type 命中即 fork（两行实形
 *  + 一行余量——resume/viewer 打开的 fork 子体无需全量装载）。读不到（文件缺席/坏行/三行内未命中）
 *  = 非 fork 视图（假阴性不炸——退回普通会话口径）。 */
const sessionFileHasForkMarker = (bucketDir: string, sid: string): boolean => {
  let fd: number;
  try {
    fd = openSync(join(bucketDir, sid, "agents", "session.jsonl"), "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    let parsed = 0;
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      if (line === "") continue;
      try {
        if ((JSON.parse(line) as { type?: string }).type === "session/fork") return true;
      } catch {
        break; // 截断行/坏行止损（标记在文件头部——预算内未命中即非）
      }
      parsed += 1;
      if (parsed >= 3) break;
    }
    return false;
  } finally {
    closeSync(fd);
  }
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
  private waiting: "approval" | "input" | null = null;
  private readonly closeHooks: (() => void)[] = [];
  private ring: SessionEvent[] = [];
  /** fork 复合视图（T18 走查修——C7/G7 浏览器可见性）：fork 会话投影 = 祖辈前缀 + 自身段，两段 seq
   *  各自从 1 起相撞；web 协议的 ev 帧 id=seq 游标 + 客户端按 seq 去重/补插在原始投影上会丢前缀/丢
   *  新事件（GET events 走 core eventsBefore 对 fork 复合视图恒空——hosted 注：前缀在祖辈文件）。
   *  fork 视图的扇出/回放/分页统一改走「重排显示 seq」：投影顺序即显示顺序，连续 1..K。TUI 对照 =
   *  forkInPlace 后 swapSessionIn 全量回显（main.ts「fork 继承父上下文——回显让继承可见」）。 */
  private forkView = false;
  /** 重排后的全投影（fork 视图专用——assembly 一次性装载 + ingest 追加；常驻内存与 §4-15 不回收同口径）。 */
  private displayAll: SessionEvent[] = [];
  private readonly displaySeqOf = new Map<string, number>(); // raw 事件 id → 显示 seq（幂等查重）
  private displaySeqNext = 0;
  private queue: { index: number; text: string; images?: string[]; afterUserEvent?: AfterUserEvent }[] = [];
  private nextIndex = 0;
  private readonly admitted = new Map<string, true>(); // promptId admission（见 admitPromptId）
  private readonly eventSubs = new Set<(e: SessionEvent) => void>();
  private readonly chunkSubs = new Set<(t: string, think: boolean) => void>();
  private readonly queueSubs = new Set<(items: { index: number; text: string }[]) => void>();
  private readonly btwSubs = new Set<(f: BtwFrame) => void>();
  private readonly stateSubs = new Set<() => void>();

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
  /** 会话目录（<root>/<bucket>/<sid>——uploads/media 媒资落位与 send 的 imageIds 解析域；装配前 undefined）。 */
  get sessionDir(): string | undefined {
    return this.currentSid === "" ? undefined : join(this.bucketDir, this.currentSid);
  }
  /** 装配完成（createHarness + presence 挂起 + 订阅泵就绪）；失败 reject 由 Pool/调用方定口径。 */
  get ready(): Promise<void> { return this.readyGate; }
  /** core harness 只读口（T6 cmdrouter 消费：命令透传 h.prompt / setLabel / fork / llm 直调；
   *  装配前/已关 = undefined——cmdrouter 按会话装配失败报错）。 */
  get core(): Harness | undefined { return this.harness; }
  /** 项目桶目录（<root>/<bucket>——T6 /ps 的 scanWithSelf 扫描基址；presence/锁同址）。 */
  get sessionsDir(): string { return this.bucketDir; }

  private async assemble(): Promise<void> {
    // T5：commandUi 工厂在此解析（self = 本会话）——WebCommandUi 的 broadcast/presence/close 钩子
    // 逐会话绑定；注入式 harness 路径同样解析（close 钩子/重放源登记不依赖真模块图）。
    const ui = typeof this.init.commandUi === "function" ? this.init.commandUi(this) : this.init.commandUi;
    let h: Harness;
    if (this.init.harness !== undefined) {
      h = this.init.harness; // 测试注入位
    } else {
      const resumeSid = this.init.resumeSid ?? (this.init.forkFrom === undefined ? this.init.sid : undefined);
      h = await createHarness({
        cwd: this.cwd,
        hostUi: "gui" as const, // web-dialog 批 T2：Web 宿主界面形态（写侧/只读化身每会话同铸同值——uiTarget 过滤判据）
        builtinModules: BUILTIN_MODULES,
        ...(this.init.modules !== undefined ? { modules: this.init.modules } : {}),
        commandUi: ui,
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
    // T18 走查修：fork 复合视图检测 + 重排基线装载（先于订阅泵起跑——ingest 的 rebase 依赖基线就位）
    this.forkView = this.init.forkFrom !== undefined || sessionFileHasForkMarker(this.bucketDir, h.sessionId);
    if (this.forkView) await this.loadDisplayProjection();
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
          const think = c.type === "reasoning/delta"; // 2026-10-12 走查：思考增量打标分路——前端折叠思考块（不再裸流成正文）
          for (const cb of Array.from(this.chunkSubs)) { // 快照迭代——回调内退订不跳元素
            try { cb(text, think); } catch { /* 订阅方异常不拦扇出 */ }
          }
        }
      } catch { /* 同上 */ }
    })();
  }

  /** 事件摄入：ring 留窗 + busy/phase 推算 + 扇出 + turn 结束补跑队列。 */
  private ingest(e: SessionEvent): void {
    // T18 走查修：fork 视图先重排（raw id → 连续显示 seq）——ring/扇出/displayAll 三面统一重排版。
    // 已在投影内的事件（history 基线装载与 events() 通道缓冲双源重叠——fork 构造期自身段先落盘后经
    // 通道重放）按 raw id 去重直弃；「每事件唯一 id」不变量下无合法双投。
    let out = e;
    if (this.forkView) {
      if (this.displaySeqOf.has(e.id)) return;
      out = this.rebase(e);
      this.displayAll.push(out);
    }
    this.ring.push(out);
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
    if (out.type === "turn/start") {
      this.turnActive = true;
      this.endedWithError = false;
      this.waiting = null; // 等相位随 turn 边界复位（presence.ts 同款——挂起属上轮的交互不跨轮显示）
    } else if (out.type === "turn/end") {
      this.turnActive = false;
      this.waiting = null; // 同上（cancel 打断后 outlive turn 的挂起交互只剩重放帧，不再占相位）
      this.endedWithError = (out as { kind?: unknown }).kind === "error";
    }
    for (const cb of Array.from(this.eventSubs)) { // 快照迭代——回调内退订不跳元素
      try { cb(out); } catch { /* 订阅方异常不拦扇出 */ }
    }
    if (out.type === "turn/end") this.drainQueue(); // 扇出 turn/end 后再补跑（订阅方先看到本轮收尾）
  }

  /** fork 视图投影装载（T18 走查修）：history() 复合投影一次性重排（displaySeqOf 建基线）；此后
   *  ingest 追加重排——Map 按 raw id 查重幂等，history() 与 ring 双源不撞号。 */
  private async loadDisplayProjection(): Promise<void> {
    const h = this.harness;
    if (h === undefined) return;
    const all = await h.history();
    for (const e of all) this.displayAll.push(this.rebase(e));
  }

  /** 事件重排：raw id → 连续显示 seq（首见分配、重见复用）；seq 恰未变时原对象直返（零拷贝）。 */
  private rebase(e: SessionEvent): SessionEvent {
    let seq = this.displaySeqOf.get(e.id);
    if (seq === undefined) {
      this.displaySeqNext += 1;
      seq = this.displaySeqNext;
      this.displaySeqOf.set(e.id, seq);
    }
    return seq === e.seq ? e : { ...e, seq };
  }

  /** busy = dispatch 占位 || turn 活跃（dispatch 同步占位防微任务窗双发——§4-4「prompt 并发期再调抛错，
   *  send 端点内部串行化」的托管制实现）。 */
  busy(): boolean { return this.dispatching || this.turnActive; }

  /** 相位（LiveInfo 五值同源）：waiting-approval/waiting-input 由 T5 WebCommandUi 的等相位挂点驱动
   *  （setWaiting），running/idle/error 由本类推算。
   *  2026-10-12 走查修：waiting 只在 busy 期生效（presence.ts setWaiting 的 turnActive 守卫同口径）——
   *  挂起交互漏清/turn 外逸时相位不再永久 waiting-*，左栏行不再常转圈（任务停了还显示转圈的根因之一）。 */
  phase(): LiveInfo["phase"] {
    if (this.dispatching || this.turnActive) {
      if (this.waiting !== null) return this.waiting === "approval" ? "waiting-approval" : "waiting-input";
      return "running";
    }
    return this.endedWithError ? "error" : "idle";
  }

  /** 等相位挂点（T5 WebCommandUi 消费——presence.ts:121 setWaiting 同语义）：等审批/等问询两族
   *  （choose 族→approval、ask 族→input），null 清位。presence 侧仅在 turn 活性期生效（宿主菜单
   *  挂起不误报）；本类 waiting 字段供 phase() 推导（GET status / live.json 同五值一致）。 */
  setWaiting(kind: "approval" | "input" | null): void {
    this.waiting = kind;
    this.presence?.setWaiting(kind);
  }

  /** 关停钩子注册（T5 bridge-ui 消费——挂起 interaction fail-closed 等收尾面）：close() 起点同步
   *  调用（先于 readyGate 等待——SIGINT 清退不让挂起交互多等一步）。返回反注册（幂等）。 */
  onClose(hook: () => void): () => void {
    this.closeHooks.push(hook);
    return () => {
      const i = this.closeHooks.indexOf(hook);
      if (i >= 0) this.closeHooks.splice(i, 1);
    };
  }

  /** 入队（busy 期 dispatch 的去处）：index 单调不复用（§3 DELETE /queue/:index 以最近快照为准）。
   *  旁注（afterUserEvent）随队列项保留——排队消息的 @ 展开原文补跑时不丢。 */
  enqueue(text: string, images?: string[], afterUserEvent?: AfterUserEvent): number {
    const index = this.nextIndex++;
    this.queue.push({
      index,
      text,
      ...(images !== undefined && images.length > 0 ? { images } : {}),
      ...(afterUserEvent !== undefined ? { afterUserEvent } : {}),
    });
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

  /** send 端点的受理口（§3 POST send → 202 Accepted 语义）：受理即回——busy 入队同步定形
   *  {ok:true,queued,index}；闲时同步占位 + 锁检后即回 {ok:true}，turn 终值不挂 HTTP（事件流/
   *  相位帧是反馈面），done 带后台 turn 终值（dispatch 消费；内部自捕获不产生未处理拒绝）。
   *  撞他进程活锁 {ok:false,holder}（409 形）与 viewer/已关拒绝同在此定形。命令面（"/" 开头）
   *  走 routeCommand 分流（T6 cmdrouter——图片/旁注对命令无意义，不透传）。 */
  async accept(text: string, images?: string[], afterUserEvent?: AfterUserEvent): Promise<{ result: SendResult; done?: Promise<SendResult> }> {
    if (this.closed) return { result: { ok: false, error: "会话已关闭" } };
    if (this.mode === "viewer") return { result: { ok: false, error: "viewer 会话只读（不发 prompt）" } };
    if (text.startsWith("/")) return this.routeCommand(text); // 命令分流点（T6 cmdrouter）
    return this.runText(text, images, afterUserEvent);
  }

  /** 命令分流点（T6 cmdrouter 接位——D15 busy 分级 + 表驱动路由）：
   *  - /quit 族 busy 特例：先 cancel（立即打断当前 turn）再交 mark:"quit" 由 server 侧关当前会话；
   *  - BLOCK 表（/new /fork）busy 期 → {ok:false,error}（409 语义——拦截提示保留输入）；
   *  - EXEC 表 + `__` 模块命令 busy 期立即执行（core 命令路由在单并发守卫之前 harness.ts:1275，
   *    不入队不占 dispatching——命令不建 turn）；
   *  - 两表外默认档 = 与消息同队（busy 入队，出队再走本分流）；
   *  - 闲时经 cmdrouter.routeCommand：host 命令自写 / 模块命令透传 h.prompt；命令输出与路由信号
   *    随 result 定形（output/mark）；命令错误（含未知命令）折为 output（toast 面，D16）——错误
   *    不是失败受理（ok 恒 true，区别于 BLOCK 拦截形）。/skill 合成体（submit）以消息路径重新
   *  提交——runText 的排队/占位/锁检语义全套保留（CLI 递归管线的 web 同构）。 */
  private async routeCommand(text: string): Promise<{ result: SendResult; done?: Promise<SendResult> }> {
    const { name } = commandNameOf(text);
    if (this.busy()) {
      if (QUIT_CMDS.has(name)) {
        this.cancel(); // D15 特例：busy 期先 cancel 再关（turn/end interrupted 回流）
        return { result: { ok: true, mark: "quit" } };
      }
      if (WEB_BUSY_BLOCK.has(name)) {
        return { result: { ok: false, error: t("main.busy.note", { cmd: name }) } }; // 409 语义
      }
      if (!busyExecutable(name)) return this.runText(text); // 默认档：与消息同队（busy → 入队）
      // EXEC/__：立即执行——下落与闲时同径（命令不建 turn，无并发面）
    }
    await this.readyGate.catch(() => undefined);
    if (this.harness === undefined) return { result: { ok: false, error: "会话装配失败" } };
    try {
      const r = await routeCommand(this, text);
      if (r.submit !== undefined) {
        const rt = await this.runText(r.submit);
        const mark = r.mark; // 闭包内窄化保持（属性窄化不跨闭包——const 局部承接）
        if (mark !== undefined && rt.result.ok) {
          rt.result = { ...rt.result, mark };
          if (rt.done !== undefined) rt.done = rt.done.then((d): SendResult => (d.ok ? { ...d, mark } : d)); // dispatch 面同形
        }
        return rt;
      }
      return {
        result: {
          ok: true,
          ...(r.output !== "" ? { output: r.output } : {}),
          ...(r.mark !== undefined ? { mark: r.mark } : {}),
          ...(r.btwRounds !== undefined ? { btwRounds: r.btwRounds } : {}), // 无参 /btw 回看搭载（走查修）
        },
      };
    } catch (err) {
      // 命令错误面 = toast（D16）：未知命令/路由失败文案即输出（TUI settleSessionError 同政策）
      return { result: { ok: true, output: err instanceof Error ? err.message : String(err) } };
    }
  }

  /** 消息路径：busy → 入队；闲 → 同步占位（先于任何 await——并发 accept 只能入队，§4-4「send 端点
   *  内部串行化」的托管制实现）→ 锁检 → 起跑不等待。 */
  private async runText(text: string, images?: string[], afterUserEvent?: AfterUserEvent): Promise<{ result: SendResult; done?: Promise<SendResult> }> {
    if (this.busy()) {
      const index = this.enqueue(text, images, afterUserEvent);
      return { result: { ok: true, queued: true, index } };
    }
    this.dispatching = true; // 同步占位（先于任何 await）——微任务窗内第二个 accept 只能入队
    await this.readyGate.catch(() => undefined); // Pool 出货前已 await（resolved 微任务让出；并发面已被占位封死）；装配失败面走下方 harness 缺席分支
    const h = this.harness;
    if (h === undefined) {
      this.dispatching = false;
      return { result: { ok: false, error: "会话装配失败" } };
    }
    const holder = this.foreignLockHolder();
    if (holder !== undefined) {
      this.dispatching = false;
      return {
        result: {
          ok: false,
          error: `会话正被另一个 Orosus 进程使用（pid ${holder.pid}）`,
          holder: { pid: holder.pid, since: holder.since, ...(holder.label !== undefined ? { label: holder.label } : {}) },
        },
      };
    }
    const done = (async (): Promise<SendResult> => {
      try {
        const opts: { images?: string[]; afterUserEvent?: AfterUserEvent } = {};
        if (images !== undefined && images.length > 0) opts.images = images;
        if (afterUserEvent !== undefined) opts.afterUserEvent = afterUserEvent;
        await h.prompt(text, Object.keys(opts).length > 0 ? opts : undefined);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        this.dispatching = false;
        this.drainQueue(); // 命令类 dispatch 不产 turn/end——收尾处统一补跑队列
        /* 终态相位兜底（2026-10-12 走查修——「消息已完成但仍显示工作中」根因）：turn/end 事件扇出
         *  时 dispatching 占位未释（本 finally 在 prompt() 结算后才跑）——事件监听侧彼时读 busy()
         *  恒 true，相位帧把前端尾行卡在「工作中」。结算后相位归真，补一帧终态（队列入题已起跑时
         *  busy 仍 true——drainQueue 先行，本帧如实反映「下一轮进行中」）。 */
        this.emitState();
      }
    })();
    return { result: { ok: true }, done };
  }

  /** 旧入口（T2 契约——turn 终值等待形）：accept + await done（busy 入队/撞锁/拒绝形无 done 即返）。
   *  T6 cmdrouter 的模块命令透传消费口。 */
  async dispatch(text: string, images?: string[], afterUserEvent?: AfterUserEvent): Promise<SendResult> {
    const { result, done } = await this.accept(text, images, afterUserEvent);
    return done === undefined ? result : await done;
  }

  /** promptId admission（§3 send 幂等键；保留最近 256——自创值登记〔方案 §5 表〕防无界增长）：
   *  Map 插入序即淘汰序（重见刷新位次）；首见 true（放行并登记），重见 false（端点回 {ok,noop:true}）。
   *  受理即登记（含入队形）——网络重试的去重窗从第一次受理起算。 */
  admitPromptId(promptId: string): boolean {
    if (this.admitted.has(promptId)) {
      this.admitted.delete(promptId);
      this.admitted.set(promptId, true); // 刷新 LRU 位次
      return false;
    }
    this.admitted.set(promptId, true);
    if (this.admitted.size > PROMPT_ID_ADMISSION_CAP) {
      const oldest = this.admitted.keys().next().value;
      if (oldest !== undefined) this.admitted.delete(oldest);
    }
    return true;
  }

  /** h.status() 透传（§4-18 装配口径：实返仅 {model,overridden,sessionId,effort?,modules}——
   *  busy/phase 由本类推算、permission 走 [approval] 服务面、sid/label/cwd/bucket 由端点侧装配）。
   *  装配前/已关 = undefined（GET status 端点兜底空串）。 */
  coreStatus(): { model: string; overridden: boolean; sessionId: string; effort?: string; modules: { active: number; failed: number; discovered: number } } | undefined {
    return this.harness?.status();
  }

  /** permission 装配（§4-18：读 [approval] 配置 + 会话 override）：approval 模块服务
   *  approval.current-mode（= state.modeOverride ?? cfg.mode 同源——subagent/runner.ts:90 同款消费，
   *  运行期 /permission 切档即时可见）；服务缺席/坏值（模块未装/注入测试 harness）回落 ask-risky
   *  （模块 schema 出厂默认）。 */
  async permissionMode(): Promise<"ask-always" | "ask-risky" | "never"> {
    const h = this.harness;
    if (h === undefined) return "ask-risky";
    try {
      const svc = await h.graph().services.getOptional("approval.current-mode" as never);
      const mode = typeof svc === "function" ? (svc as () => unknown)() : undefined;
      if (mode === "ask-always" || mode === "ask-risky" || mode === "never") return mode;
    } catch { /* 服务面异常——出厂默认兜底 */ }
    return "ask-risky";
  }

  /** 他进程活锁探测（ps.ts lockHeldByOther 同源判据，取全量载荷供 holder 字段）：自己/死 pid/无锁 = 放行。 */
  private foreignLockHolder(): LockHolder | undefined {
    if (this.currentSid === "") return undefined;
    const holder = readLockHolder(join(this.bucketDir, this.currentSid, "agents", SESSION_LOCK_FILE));
    if (holder === null || holder.pid === process.pid) return undefined;
    return pidAlive(holder.pid) ? holder : undefined;
  }

  /** turn 结束/命令收尾后的队列补跑：非 busy 且有队首 → 依序执行下一条（§3 send 排队语义；
   *  旁注随队列项透传——排队消息的原文补跑不丢）。 */
  private drainQueue(): void {
    if (this.closed || this.busy()) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.broadcastQueue();
    void this.dispatch(next.text, next.images, next.afterUserEvent);
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

  /** 流式增量扇出口（T3 SSE 的 chunk 帧源——50ms 合批在彼处，本口只转发）。
   *  think 形参 = 思考增量分路标（:169 Set 元素型/:257 发射点本就两参——签名面补齐，零行为变化）。 */
  onChunk(cb: (t: string, think: boolean) => void): () => void {
    this.chunkSubs.add(cb);
    return () => { this.chunkSubs.delete(cb); };
  }

  /** 队列整表快照广播口（§3 queue 帧——多标签一致性）。 */
  onQueue(cb: (items: { index: number; text: string }[]) => void): () => void {
    this.queueSubs.add(cb);
    return () => { this.queueSubs.delete(cb); };
  }

  /** 相位变化订阅（SSE phase 帧补充源——turn/start|end 事件内联帧之外的「结算后归真」兜底）。
   *  返回退订函数。 */
  onState(cb: () => void): () => void {
    this.stateSubs.add(cb);
    return () => { this.stateSubs.delete(cb); };
  }

  /** 相位扇出（busy/phase 推算值归真后通知——订阅方自重读 phase()/busy()）。 */
  private emitState(): void {
    for (const cb of Array.from(this.stateSubs)) { // 快照迭代——回调内退订不跳元素
      try { cb(); } catch { /* 订阅方异常不拦扇出 */ }
    }
  }

  /** btw 流状态扇出口（T6 cmdrouter 消费——SSE `event: btw` 帧源；W5：帧带 tab/round）：旁路快问
   *  不经 turn/chunk 通道（零落盘），独立帧面与主流区分（busy 期 /btw 与主 turn 并流不串台）。
   *  返回退订函数。 */
  onBtw(cb: (f: BtwFrame) => void): () => void {
    this.btwSubs.add(cb);
    return () => { this.btwSubs.delete(cb); };
  }

  /** btw 流状态广播（T6 runBtw / W5 btw-service 收流转发——answering 累积式 / tool 查证 /
   *  answer/error 终态；帧随 tab 路由）。 */
  emitBtw(f: BtwFrame): void {
    for (const cb of Array.from(this.btwSubs)) { // 快照迭代——回调内退订不跳元素
      try { cb(f); } catch { /* 订阅方异常不拦扇出 */ }
    }
  }

  /** 回放段（T3 SSE 首屏补齐/重连 backfill 源——「事件订阅自持 ring（cap 1024）+ 全量 history() 兜底」
   *  语义）：seq > after 的事件升序。ring 覆盖（首元素 seq ≤ after+1——(after, ring 尾] 全在 ring）走
   *  内存快路径；ring 空或不覆盖（resume 会话的历史前缀不在 ring——pump 只收订阅后事件）→ 全量
   *  history() 兜底。 */
  async replayAfter(after: number): Promise<SessionEvent[]> {
    if (this.forkView) return this.displayAll.filter((e) => e.seq > after); // T18：fork 视图前缀不在 ring——恒走重排投影
    if (this.ring.length > 0 && this.ring[0]!.seq <= after + 1) {
      return this.ring.filter((e) => e.seq > after);
    }
    const h = this.harness;
    if (h === undefined) return this.ring.filter((e) => e.seq > after);
    const all = await h.history();
    return all.filter((e) => e.seq > after);
  }

  /** 分页回放（T3 GET events 端点消费——core eventsBefore 透传：索引查段 + pread，首屏有界 §5 律三；
   *  fork 复合视图恒空是 core 口径）。T18 走查修：fork 视图改走重排投影内存切片（displayAll——分页
   *  与回放同源，显示 seq 连续无相撞）。 */
  eventsPage(beforeSeq: number, limit: number): Promise<SessionEvent[]> {
    if (this.forkView) {
      const page = this.displayAll.filter((e) => e.seq < beforeSeq);
      return Promise.resolve(page.slice(Math.max(0, page.length - limit)));
    }
    const h = this.harness;
    if (h === undefined) return Promise.resolve([]);
    return h.eventsBefore(this.currentSid, beforeSeq, limit);
  }

  /** 关停序（brief 定档）：presence dispose → h.close → purgeIfEmpty（purge 必须在 h.close 完成**后**——
   *  Windows 活句柄删不动，session-io.ts:36 明文；同 CLI 退出实序）。幂等；viewer 无 presence、不 purge
   *  （只读化身不拥有会话——清理归 host/退出漏斗）。T5：close 起点先清等相位 + 跑关停钩子（挂起
   *  interaction fail-closed——「已取消（Esc）」语义，confirm 折 false；重放源摘除防死卡重放）。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.setWaiting(null);
    this.turnActive = false; // 关停即终局——相位不再报 running/waiting（idle/error 由 endedWithError 推导）
    this.dispatching = false;
    for (const hook of this.closeHooks.splice(0)) {
      try { hook(); } catch { /* 钩子异常不拦关停 */ }
    }
    await this.readyGate.catch(() => undefined); // 装配失败也继续（harness 缺席则跳过对应步）
    this.presence?.dispose();
    if (this.harness !== undefined) await this.harness.close();
    if (this.mode === "host" && this.currentSid !== "") purgeIfEmptyAt(this.root, this.currentSid);
  }
}
