import { orosusHome } from "@orosus/contracts/home";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { CommandUi, HostInfo, LlmPort, ModuleDefinition, SettingsService } from "@orosus/contracts/module";
import type { Chunk, ContentPart, ModelMessage, StreamFn } from "@orosus/contracts/provider";
import { createDiagSink, createLogger } from "./diag/logger.ts";
import { hardeningNote, JsonlSessionStore, lastUsageTotal, sumUsage } from "./session/jsonl.ts";
import { SqliteSessionStore } from "./session/sqlite.ts";
import { ForkedSessionStore, openSessionView, verifyChain } from "./session/fork.ts";
import type { SessionEvent, SessionStore } from "./session/types.ts";
import { LOG_TYPES } from "./session/types.ts";
import { locateSessionBucket } from "./session/dir.ts";
import { loadConfig, loadSecretsEnv, mergeEnvLayer } from "./config/load.ts";
import { resolveSections } from "./config/validate.ts";
import { loadModules, type ModuleGraph } from "./kernel/kernel.ts";
import { discoverModules, type DiscoveredModule } from "./kernel/discover.ts";
import { diffGraphs, type ReloadReport } from "./kernel/reload.ts";
import { loadTrustStore, checkTrust } from "./kernel/trust.ts";
import { CORE_POINTS } from "./kernel/bus.ts";
import type { EventBus } from "./kernel/bus.ts";
import { parseModel } from "./provider/resolve.ts";
import { agentLoop } from "./loop/loop.ts";

/** 扩展名 → MIME（M4-2.5 T5）：/paste 产物即 png；未知缺省 image/png。 */
function imageMimeOf(path: string): "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  const ext = path.toLowerCase().split(".").at(-1) ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

export interface HarnessOptions {
  modules?: ModuleDefinition[];
  builtinModules?: ModuleDefinition[];
  cwd?: string;
  store?: SessionStore;
  sessionsDir?: string;                     // 会话文件目录（D41/T6）：缺省 ~/.orosus/sessions——resume/fork/新会话共用；测试密封注入 tmp
  sessionsRoot?: string;                    // 会话根目录（会话树批 T1）：fork 祖先链跨桶定位兜底用（locateSessionBucket 全根扫描）；#17 封闭后新链祖先恒同桶，只为存量跨桶链只读兼容；缺省 = 只走同桶快路径
  diagDir?: string;
  spillDir?: string;
  secretsFile?: string;                     // 缺省 ~/.orosus/secrets.env（D37）；测试传 tmp 路径密封
  commandUi?: CommandUi;                   // 命令交互 UI（D35/D38）：CLI 注 readline 版；缺省拒绝式（无头 fail-closed）
  settings?: SettingsService;              // m5 T9 口子四：设置服务实现（写面）——经内核装配成 ctx.settings（mounts "settings" 白名单校验）；缺省不装（模块读 undefined 降级）
  host?: HostInfo;                         // m5 T9 读面：宿主状态快照——ctx.host 直挂无 mounts 位（决策点 24）；缺省不装
  autoTitle?: boolean;                     // 会话自动标题（M4-2 B9 拉前）：首轮 completed 后生成 session/label。核心缺省关（保守——宿主显式开；CLI 装配 true）
  resume?: { sessionId: string };           // 打开既有会话继续（D41/T6）：已有事件非空则不落重复 header
  fork?: { parentSessionId: string; atEntryId?: string; parentDir?: string }; // 复合存储新会话（D41/T6）：header 带 parentSession + 首事件 session/fork；parentDir（M4-1 T1/D46）= 父会话所在目录（跨桶/平铺 fork 时由宿主定位填入，缺省同 sessionsDir）
  discovery?: {                            // 目录扫描入口（§8.3/T11-T12）：缺省 ~/.orosus/modules 与 <cwd>/.orosus/modules
    userDir: string;
    projectDir: string;
    trustFile?: string;                    // 缺省 ~/.orosus/trust.json
  };
  config?: {
    userFile?: string;
    projectFile?: string;
    cliOverrides?: Record<string, unknown>;
    enableModules?: string[];
    disableModules?: string[];
    noModules?: boolean;
    module?: string[];                      // 纯净模式白名单（--module，仅 noModules 时生效）
    env?: Record<string, string | undefined>;
  };
}

export interface Harness {
  prompt(text: string, opts?: { images?: string[] | undefined }): Promise<string | undefined>;  // 命令输入时返回命令输出（回显）；普通 turn 返回 undefined。images = /paste 挂起图（M4-2.5 T5）
  cancel(): void;
  /** Steering 注入口（2026-09-23 消息队列批——kimi Ctrl-S 同语义，宿主键位 Ctrl+U）：turn 进行中
   *  把文本注入当前 turn——loop 下一 step 边界（steering collect 链）或停止边界（followUp 兜底，
   *  错过窗口不丢消息）作为 agent/steering-message 落日志并进上下文（投影 = user 消息）。
   *  无进行中 turn → false（调用方回退排队/直接提交）。 */
  steer(text: string): boolean;
  /** 当前会话 id（/fork 等宿主侧会话操作的消费面，D41/T6）。 */
  readonly sessionId: string;
  /** 单订阅者（M1）：Channel 逐 waiter 派发，多订阅者会瓜分事件；广播需求出现时再升级。 */
  events(): AsyncIterable<SessionEvent>;
  /** 会话历史（宿主显示面，B9 走查补）：全部持久事件（resume 回显用；含 reasoning 块——显示方自行取舍）。 */
  history(): Promise<SessionEvent[]>;
  /** 实时旁路通道（M4-1 T4/D45）：provider 流式 Chunk 的内存投递——不持久、不进 SessionEvent 流、
   *  断连即弃（无等待者的 push 直接丢，零积压）；每调用一次 = 新订阅（从当下起，无重放）。 */
  liveChunks(): AsyncIterable<Chunk>;
  /** Token 用量读口（2026-09-22 命令分级批⑤——/usage 内建命令退役，宿主 /settings 面板直调）：
   *  当前会话累计恒有；存储后端支持跨会话累计（JsonlStore）时带 lifetime。 */
  usage(): Promise<{ current: { input: number; output: number }; lifetime?: { input: number; output: number; sessions: number } }>;
  /** 运行状态读口（批⑥——/status 内建命令退役并入 /settings）：model（含运行期覆盖标记）、会话 id、模块图三计数；
   *  effort = 思考档位（/effort 2026-09-25——未设时缺省，宿主 toast diff 消费）。 */
  status(): { model: string; overridden: boolean; sessionId: string; effort?: string; modules: { active: number; failed: number; discovered: number } };
  /** 当前会话命名写口（批⑦a——/title 破链修复）：经活 store 追加 session/label（单写者纪律——
   *  旁路新建 store 写活文件会让活 store 的内存 lastId/seq 失真，后续事件 parentId 链断裂/seq 撞号）。 */
  setLabel(label: string): Promise<void>;
  /** 落盘式分叉（会话树批 T6，缝一内核半边）：以当前会话为父创建新会话文件并立即写盘（header +
   *  session/fork），当前会话原地不动——切换由宿主 switchTo 承担（决策点 8：只落盘不激活）。
   *  atEntryId 须在当前投影内，不在 = 抛错不写盘（校验在本方法——fork.ts 的「找不到 atEntryId →
   *  全量父前缀」宽松降级只属于盘上链重建，不属于活 API）。新会话日后被打开时，祖先链视图由
   *  openSessionView 递归重建（T1）。 */
  fork(opts?: { atEntryId?: string }): Promise<{ sessionId: string }>;
  /** 设置服务后端（m5 T9 口子四）：换模型——/model 同源核心动作（覆盖槽 + 写盘 + 档位跟随重解析），单一写者不双写；busy 期可调、下一轮生效。 */
  setModel(qualified: string): Promise<void>;
  /** 设置服务后端（m5 T9）：切思考档位——/effort 同源；"auto" = 回目录默认档；非法档名抛错。 */
  setEffort(level: string): void;
  /** 待确认第三方模块清单（m5 T17）：未过信任门的 local 模块（项目级 hash 门
   *  / 用户级一次性确认）——面板「待确认」桶与首挂确认弹窗的数据源（layer + 目录路径弹窗要显示）。 */
  pendingConfirms(): { name: string; version: string; layer: "user" | "project"; root: string; reason: string; entryHash: string; def: import("@orosus/contracts/module").ModuleDefinition }[];
  /** 宿主日志口（T4/S10）：宿主侧信息性事件写诊断日志——与 kernel 同一 sink 同一队列（lvl=info；
   *  Logger 契约只有五个分级方法，无裸 log）。首用 = 联动启停连带名单（host.module.cascade）。 */
  log(code: string, msg: string, data?: Record<string, unknown>): void;
  graph(): ModuleGraph;
  reload(): Promise<ReloadReport>;  // quiesce 后执行（§5.5/T15）
  close(): Promise<void>;
}

/** 无锁异步通道：events() 订阅端与 turn 生产端的缓冲。 */
class Channel<T> {
  private buf: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.buf.push(v);
  }
  close(): void {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  async *iterate(): AsyncGenerator<T> {
    for (;;) {
      const v = this.buf.shift();
      if (v !== undefined) {
        yield v;
        continue;
      }
      if (this.done) return;
      const r = await new Promise<IteratorResult<T>>((res) => this.waiters.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

/** 实时旁路通道（M4-1 T4/D45）：内存 Chunk 通道——零缓冲多订阅者；无等待者的 push 直接丢弃
 *  （断连即弃、零积压——实时显示丢帧可接受，与 §6.7「UI 可见性不构成持久化承诺」同向；
 *  事实源是完成事件，不是这里）。 */
class LiveChannel {
  private waiters = new Set<(r: IteratorResult<Chunk>) => void>();
  private closed = false;
  push(c: Chunk): void {
    // 删除的恰为当前遍历元素（Set 迭代安全），无需拷贝快照
    for (const w of this.waiters) {
      this.waiters.delete(w);
      w({ value: c, done: false });
    }
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters) {
      this.waiters.delete(w);
      w({ value: undefined as never, done: true });
    }
  }
  async *iterate(): AsyncGenerator<Chunk> {
    for (;;) {
      if (this.closed) return;
      const r = await new Promise<IteratorResult<Chunk>>((res) => this.waiters.add(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

/** 转发代理：一切 append（loop/模块 ctx.session.append 一视同仁）即转发订阅端（§6.7 日志实时投影）。
 *  可选能力透传（lifetimeUsage）——缺省后端自然不挂。 */
function forwardingStore(store: SessionStore, channel: Channel<SessionEvent>): SessionStore {
  return {
    sessionId: store.sessionId,
    append: async (type, fields) => {
      const e = await store.append(type, fields);
      channel.push(e);
      return e;
    },
    all: () => store.all(),
    ...(store.lifetimeUsage !== undefined ? { lifetimeUsage: () => store.lifetimeUsage!() } : {}),
    flush: () => store.flush(),
    close: () => store.close(),
  };
}

/** §4.2 启动序列的编程式形态。CLI 只是本入口的配置驱动薄壳（§8.1）。 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const home = orosusHome();
  const sink = createDiagSink({ dir: options.diagDir ?? join(home, "logs") });

  const note = hardeningNote();
  if (note) createLogger(sink, "kernel").warn("kernel.session.hardening", note);

  // 交互 UI（D35/D38）：CLI 注 readline 版；缺省拒绝式（无头 fail-closed）。M3/T2 起经 ctx.ui 同时注入 waterfall 侧（审批询问）
  // m5 T2 注：可选 UI 口（viewText/insertText/attachImage/dialog、notice 扩参）不在拒绝式四法里——缺省不存在即
  // 静默丢弃（契约「可选口缺省 undefined」语义，模块判空降级）；核心四法（ask/askSecret/choose/confirm）仍 fail-closed。
  const commandUi: CommandUi = options.commandUi ?? {
    ask: async () => { throw new Error("无交互环境（headless）——交互式命令不可用（D35 fail-closed）"); },
    askSecret: async () => { throw new Error("无交互环境（headless）——交互式命令不可用（D35 fail-closed）"); },
    choose: async () => { throw new Error("无交互环境（headless）——交互式命令不可用（D35 fail-closed）"); },
    confirm: async () => { throw new Error("无交互环境（headless）——交互式命令不可用（D35 fail-closed）"); },
  };

  const secretsLoad = loadSecretsEnv(options.secretsFile ?? join(home, "secrets.env"));
  let secrets = secretsLoad.vars; // reload 需重读（向导等运行期写入 secrets.env 后 reload 须看到新值——修复：启动快照导致 $ENV 占位符解析不到 → 字面量当 key → 401）
  if (secretsLoad.badLines > 0) createLogger(sink, "kernel").warn("kernel.secrets.badline", "secrets.env 坏行被跳过（KEY=VALUE 格式）", { badLines: secretsLoad.badLines });
  const userConfigFile = options.config?.userFile ?? join(home, "config.toml"); // /model 持久化落点（M4-2 T14）
  let config = loadConfig({
    userFile: userConfigFile,
    projectFile: options.config?.projectFile ?? join(options.cwd ?? process.cwd(), ".orosus", "config.toml"),
    ...(options.config?.cliOverrides !== undefined ? { cliOverrides: options.config.cliOverrides } : {}),
    // D37 优先级：显式 env 参数 > process.env > secrets.env——显式环境是用户当下意图，secrets 只补缺
    env: options.config?.env ?? mergeEnvLayer(process.env, secrets),
  });
  // SW-20：解析失败降级进 warnings——落地即弃可惜，diag 留痕（引导触发判定在 CLI preflight，不靠此路）
  for (const w of config.warnings) createLogger(sink, "kernel").warn("kernel.config.load-warning", w, {});

  // 存储构造分支（D41/T6 + D42/T7）：显式 store > resume > fork > 全新；后端按核心顶层 key sessionStore 选择（缺省 jsonl）
  const sessionsDir = options.sessionsDir ?? join(home, "sessions");
  const makeStore = (sessionId?: string, dir: string = sessionsDir): SessionStore => {
    const backend = String(config.core.sessionStore ?? "jsonl");
    const withId = sessionId !== undefined ? { sessionId } : {};
    if (backend === "sqlite") return new SqliteSessionStore({ dir, ...withId });
    if (backend === "jsonl") return new JsonlSessionStore({ dir, ...withId });
    throw new Error(`sessionStore 配置非法："${backend}"（合法值 jsonl | sqlite，核心顶层 key，§7.2/D42）`);
  };
  let baseStore: SessionStore;
  if (options.store !== undefined) {
    baseStore = options.store;
  } else if (options.resume !== undefined) {
    baseStore = makeStore(options.resume.sessionId);
  } else if (options.fork !== undefined) {
    // 会话树批 T1 断代修复：父视图经 openSessionView 递归拼装——父若是 fork 子体，其投影含祖辈段
    //（旧实现平铺打开父自己那份文件，孙代丢祖辈前缀）。parentDir 缺省同桶（REPL /fork）；跨桶父由宿主定位后填入（D46）。
    const forkBucket = options.fork.parentDir ?? sessionsDir;
    const parentView = await openSessionView({
      sessionId: options.fork.parentSessionId,
      bucket: forkBucket,
      makeStore,
      locate: (sid) => {
        const b = locateSessionBucket(options.sessionsRoot, sid, forkBucket);
        return b === undefined ? undefined : { bucket: b };
      },
    });
    baseStore = new ForkedSessionStore({
      parent: parentView.store,
      ...(options.fork.atEntryId !== undefined ? { atEntryId: options.fork.atEntryId } : {}),
      own: makeStore(),
    });
  } else {
    baseStore = makeStore();
  }
  const channel = new Channel<SessionEvent>();
  const live = new LiveChannel(); // 实时旁路（T4/D45）：Chunk 级内存投递，断连即弃
  const store = forwardingStore(baseStore, channel);

  // header 兜底面（2026-09-22 fork 走查连带实证：/yolo /title 等事件先于首个 turn 落盘 → 无 header 的
  // 「断头文件」污染 /sessions 且 verifyChain 无根可校验）：经模块面（loadModules 的 session 参）的 append
  // 一律先补 header。holder 占位 = 直通（loadModules 激活期 header 依赖图未就绪——现状无模块在激活期落事件）；
  // header 本体由 ensureHeader 经裸 store.append 写，不经此面（防递归）
  const ensureHeaderHolder: { fn: () => Promise<void> } = { fn: async () => undefined };
  const sessionGuarded: SessionStore = {
    sessionId: store.sessionId,
    append: async (type, fields) => {
      await ensureHeaderHolder.fn();
      return store.append(type, fields);
    },
    all: () => store.all(),
    ...(store.lifetimeUsage !== undefined ? { lifetimeUsage: () => store.lifetimeUsage!() } : {}),
    flush: () => store.flush(),
    close: () => store.close(),
  };

  // 窗口语义（M3 补强空白 §5）：核心顶层 contextWindow——正整数才生效；非法/≤0 忽略 + warn（三轮 P2：0 窗口会把阈值打成 0）
  const readContextWindow = (core: Record<string, unknown>): number | undefined => {
    const v = core.contextWindow;
    if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
    if (v !== undefined) createLogger(sink, "kernel").warn("kernel.config.contextwindow", `contextWindow 配置非法（${String(v)}）——须为正整数，已忽略`);
    return undefined;
  };
  let contextWindow = readContextWindow(config.core);
  let usageAnchor: { totalTokens: number; atMessageCount: number } | undefined; // usage 锚点（空白 §4）：主循环 stream 包装记录，二级调用不更新

  const defs: { def: ModuleDefinition; source: "builtin" | "inline" | "local"; root?: string; layer?: "user" | "project" }[] = [
    ...(options.builtinModules ?? []).map((def) => ({ def, source: "builtin" as const })),
    ...(options.modules ?? []).map((def) => ({ def, source: "inline" as const })),
  ];
  // 目录扫描 + 项目级信任门（§8.3/§8.5/T11-T12）：通过者并入 defs（source local），未过者 blocked（failed untrusted，不激活）
  // 待确认第三方桶（m5 T17，决策点 25/设计空白 19/20）：项目级 hash 门 + 用户级一次性确认——
  // 未过信任门的 local 模块不激活、不进 failed 计数（进「待确认」态），面板可见 + 回车弹确认窗；
  // reload 重跑发现与信任判定（确认 → h.reload() 即挂载的链路口）。内建/inline 模块不经此环（永免）。
  let blocked: { def: import("@orosus/contracts/module").ModuleDefinition; source: string; reason: string; layer?: "user" | "project"; root?: string; entryHash?: string }[] = [];
  {
    const userDir = options.discovery?.userDir ?? join(home, "modules");
    const projectDir = options.discovery?.projectDir ?? join(options.cwd ?? process.cwd(), ".orosus", "modules");
    const discovered: DiscoveredModule[] = await discoverModules({ userDir, projectDir, ...(options.config?.userFile !== undefined ? { userFile: options.config.userFile } : {}), sink });
    const trustFile = options.discovery?.trustFile ?? join(home, "trust.json");
    const trustStore = loadTrustStore(trustFile);
    for (const m of discovered) {
      const t = checkTrust({ layer: m.layer, root: m.root, entryHash: m.entryHash, store: trustStore });
      if (t.ok) {
        defs.push({ def: m.def, source: "local" as const, root: m.root, layer: m.layer }); // root/layer 透传（T7：failed 事件来源标识）
      } else {
        blocked.push({
          def: m.def,
          source: "local",
          layer: m.layer,
          ...(m.root !== undefined ? { root: m.root } : {}),
          ...(m.entryHash !== undefined ? { entryHash: m.entryHash } : {}),
          reason:
            m.layer === "project" && t.reason === "hash-changed"
              ? "untrusted（项目级模块代码已变更，须重新确认，§8.5/MCPoison）"
              : m.layer === "project"
                ? "untrusted（项目级模块未确认，§8.5）"
                : "unconfirmed（用户级模块首次挂载待确认）",
        });
      }
    }
  }
  const cliInput = {
    ...(options.config?.enableModules !== undefined ? { enable: options.config.enableModules } : {}),
    ...(options.config?.disableModules !== undefined ? { disable: options.config.disableModules } : {}),
    ...(options.config?.noModules !== undefined ? { noModules: options.config.noModules } : {}),
    ...(options.config?.module !== undefined ? { module: options.config.module } : {}),
  };
  const spillDirUsed = options.spillDir ?? join(sessionsDir, store.sessionId, "spill");
  const llmHolder: { impl?: LlmPort } = {}; // D39/T4：loadModules 后装配——Unchanged 模块的旧闭包经同一 holder 读到新解析
  let graph = await loadModules({
    defs,
    cli: cliInput,
    sections: config.sections,
    session: sessionGuarded, // header 兜底面——模块事件先于首个 turn 落盘时先补 header（断头文件实证修复）
    sink,
    spillDir: spillDirUsed,
    cwd: options.cwd ?? process.cwd(),
    commandUi,
    llm: llmHolder,
    ...(options.settings !== undefined ? { settings: options.settings } : {}), // m5 T9：设置服务写面（ctx.settings 装配）
    ...(options.host !== undefined ? { host: options.host } : {}),               // m5 T9：宿主状态读面（ctx.host 直挂）
    ...(blocked.length > 0 ? { blocked } : {}),
  });

  // steering 宿主口（2026-09-23 消息队列批）：backlog 挂 collect 链——steering 在每个 step 首排空，
  // followUp 在停止边界兜底（错过窗口的消息仍进本 turn，不丢）。reload 复用同一 bus（reuse），
  // WeakSet 防重注册；owner 记 "host"（非模块——宿主直挂核心口）
  const steerBacklog: string[] = [];
  const steerHooked = new WeakSet<object>();
  const ensureSteerHook = (bus: EventBus): void => {
    if (steerHooked.has(bus)) return;
    steerHooked.add(bus);
    const drain = (): { text: string; sourceModule: string }[] => steerBacklog.splice(0).map((text) => ({ text, sourceModule: "host" }));
    bus.on(CORE_POINTS.steering, drain, "host");
    bus.on(CORE_POINTS.followUp, drain, "host");
  };
  ensureSteerHook(graph.bus);

  // header 懒写（M4-1 T0/D46 止血）：构造期零落盘——临时会话（CLI 启动即退 / --dump-modules / 引导后未聊）
  // 不再各留一个空壳文件（走查垃圾场 1147 文件的主源头）。首次真实 turn 前补写（命令派发不触发——
  // onboarding 的 /provider、/reload 不落盘），保持 §6.1「文件首行 = session/header」不变量；
  // resume 的既有文件已带 header（不重复落）；模块图摘要取写入时刻的图（onboarding 在首聊前 /reload，
  // 捕获的是会话真正开工时的图——比构造期快照更真）。fork 的 sourceEntryId 仍在 fork 时刻取父尾（语义不变）。
  const existingEvents = await store.all();
  let headerPending = options.resume === undefined || existingEvents.length === 0;
  const pendingForkSourceEntryId = headerPending && options.fork !== undefined
    ? options.fork.atEntryId ?? existingEvents[existingEvents.length - 1]?.id
    : undefined;
  const ensureHeader = async (): Promise<void> => {
    if (!headerPending) return;
    headerPending = false;
    await store.append(LOG_TYPES.sessionHeader, {
      format: 1,
      cwd: options.cwd ?? process.cwd(),
      parentSession: options.fork?.parentSessionId ?? null,
      moduleSummary: { // M4-1 T3 瘦身：模块图全列表（661B/会话）→ 三计数——全图运行期经 graph().audit() / --dump-modules
        active: graph.records.filter((r) => r.state === "active").length,
        failed: graph.records.filter((r) => r.state === "failed").length,
        discovered: graph.records.filter((r) => r.state === "discovered").length,
      },
    });
    if (options.fork !== undefined) {
      await store.append(LOG_TYPES.sessionFork, { sourceEntryId: pendingForkSourceEntryId ?? null, parentSession: options.fork.parentSessionId });
    }
  };
  ensureHeaderHolder.fn = ensureHeader; // 模块面 header 兜底激活（loadModules 已过、图就绪——holder 占位期无人落事件）

  // fork 即刻落盘（2026-09-22 用户实测：fork 走懒写 → 零 turn 时 /sessions 看不到子会话、观感同 /new）——
  // fork 是显式用户动作，不是 D46 懒写要挡的临时空壳：header + session/fork 立即写并刷盘
  if (options.fork !== undefined) {
    await ensureHeader();
    await store.flush();
  }

  // 会话自动标题（M4-2 B9 用户拉前，2026-09-19 走查）：首轮 completed 后经主 provider 生成 ≤16 字标题，
  // 落 session/label（M3/T6 预留类型首次消费）；LLM 失败/空产出 → 兜底 = 首问文本截断。已有 label（resume）跳过。
  const maybeTitle = async (): Promise<void> => {
    const events = await store.all();
    if (events.some((e) => e.type === LOG_TYPES.sessionLabel)) return;
    const textOf = (e: SessionEvent): string =>
      ((e.content ?? []) as { kind?: string; text?: string }[]).filter((p) => p.kind !== "reasoning").map((p) => p.text ?? "").join("");
    const q = events.filter((e) => e.type === "user/message").at(-1);
    const a = events.filter((e) => e.type === "assistant/message").at(-1);
    if (q === undefined || a === undefined) return;
    const qText = textOf(q);
    const aText = textOf(a);
    if (qText === "" || aText === "") return;
    let label = qText.replace(/\s+/g, " ").slice(0, 20); // 兜底：首问截断
    try {
      const { stream, model } = resolveProvider();
      let t = "";
      for await (const c of stream({
        model,
        system: "根据这组问答生成一个不超过 16 字的会话标题：与对话同语言、直接输出标题本身（无引号无解释）。",
        messages: [
          { role: "user", content: [{ kind: "text", text: qText.slice(0, 400) }] },
          { role: "assistant", content: [{ kind: "text", text: aText.slice(0, 400) }] },
        ],
        tools: [],
        signal: new AbortController().signal,
        maxTokens: 32,
      })) {
        if (c.type === "text/delta") t += c.text;
        else if (c.type === "finish" && c.kind === "error") t = "";
      }
      const trimmed = t.trim().replace(/^["'“”「『]+|["'“”」』]+$/g, "");
      if (trimmed !== "") label = trimmed.slice(0, 24);
    } catch { /* 兜底：首问截断 */ }
    await store.append(LOG_TYPES.sessionLabel, { label });
  };
  // 读侧自修复 pass（§6.1/D41）：resume/fork 打开既有历史时做链校验（根分段——复合投影零误报），问题逐条进诊断
  if (options.resume !== undefined || options.fork !== undefined) {
    for (const issue of verifyChain(await store.all())) {
      createLogger(sink, "session").warn("session.chain.issue", issue);
    }
  }

  let currentTurn: { controller: AbortController; done: Promise<void> } | null = null;
  let closed = false;
  let modelOverride: string | undefined; // /model 运行期覆盖（D38：会话内存态不落盘）
  let effortOverride: string | undefined; // /effort 运行期覆盖（/model 同款双轨：会话内存 + 写盘）；未设 = 跟随配置，配置也没有 = 目录默认档（kimi「从不不指定」——effort 型模型恒有解析值）

  // 行级写 user config 顶层键（/model 2026-09-25 抽取共用，/effort 同款落点）：无 TOML 库的节区感知写
  //（2026-09-22 启动阻断实证：裸键追加在文件末尾会落进最后一个 [节]——approval strict 校验直接拒启动）。
  // 顶层区 = 首个节头之前；filterRe 命中的旧键行只在顶层区清除；kv 给定则新行写顶层区末尾（缺省 = 只删不写）。
  const upsertTopLevelKey = (filterRe: RegExp, kv?: { line: string }): void => {
    const before = existsSync(userConfigFile) ? readFileSync(userConfigFile, "utf8") : "";
    const cfgLines = before.split("\n");
    const firstSection = cfgLines.findIndex((l) => /^\s*\[/.test(l));
    const headEnd = firstSection === -1 ? cfgLines.length : firstSection;
    const head = cfgLines.slice(0, headEnd).filter((l) => !filterRe.test(l));
    while (head.length > 0 && head[head.length - 1]!.trim() === "") head.pop(); // 尾空行收拢
    if (kv !== undefined) head.push(kv.line);
    const after = [...head, "", ...cfgLines.slice(headEnd)].join("\n").replace(/\n{3,}/g, "\n\n");
    mkdirSync(dirname(userConfigFile), { recursive: true }); // 目录缺省即建（批⑧确认制废除后写盘无条件化——宿主/测试自定义路径不得 ENOENT）
    writeFileSync(userConfigFile, after, "utf8");
  };

  // ---- /model //effort 核心动作（m5 T9 抽共用）：命令与设置服务（ctx.settings）同源——单一写者，不双写 ----

  /** /model 核心：覆盖槽 + 写盘 + 档位跟随重解析（2026-09-25 二轮 kimi draftFor 对齐）。 */
  const applyModelOverride = async (next: string): Promise<void> => {
    const prevModelValue = modelOverride ?? (typeof cfgModelValue() === "string" ? (cfgModelValue() as string) : undefined);
    modelOverride = next;
    // 持久化（2026-09-22 用户拍板）：选定即写盘永久生效。行级写 user config 顶层 provider 键
    // （无 TOML 库；不复用 provider-custom setModel——模块层装配闭包，core↮模块违铁律 3）
    // F5 十轮：键名 provider（值保留 slot/model 全形）；旧 model 行随过滤清除
    upsertTopLevelKey(/^\s*(model|provider)\s*=/, { line: `provider = "${next}"` });
    // 档位跟随重解析：已设档且换了模型 → 新模型 segments 含旧档 → 保留（「设置过就尊重」）；
    // 不含 → 落默认档（kimi middleOf 取法）；目录不认识新模型 → lenient 保留原样发（端点 400 自证）。
    // 未设档不动作——effective 自动 = 新模型默认档（解析链天然跟随）。重选原模型不触发。
    const prevEffort = effortOverride ?? cfgEffortValue();
    if (prevEffort !== undefined && next !== prevModelValue) {
      const { provider: nextSlot, model: nextExplicit } = parseModel(next);
      const nextAdapter = graph.services.provider(nextSlot);
      const nextBare = nextExplicit ?? nextAdapter?.defaultModel ?? next;
      const info = await thinkingInfoOf(nextSlot, nextBare);
      if (info !== undefined && !segmentsOf(info).includes(prevEffort)) {
        const reEffort = defaultEffortOf(info);
        effortOverride = reEffort;
        upsertTopLevelKey(/^\s*effort\s*=/, { line: `effort = "${reEffort}"` });
      }
    }
  };

  /** /effort 核心：覆盖 + 写盘；"auto" = 清覆盖清盘行回目录默认。非法档名抛错（设置服务同规）。 */
  const applyEffortOverride = (level: string): void => {
    if (!/^[a-z0-9._-]+$/.test(level)) throw new Error(`档位名 "${level}" 不合法（仅限字母数字与 . _ -）`);
    if (level === "auto") {
      effortOverride = undefined;
      upsertTopLevelKey(/^\s*effort\s*=/);
    } else {
      effortOverride = level;
      upsertTopLevelKey(/^\s*effort\s*=/, { line: `effort = "${level}"` });
    }
  };

  // 内建别名表（D38）：短名 → 模块命令名；目标不存在提示安装对应模块
  const COMMAND_ALIASES: Record<string, string> = {
    provider: "provider-custom__provider",
    permission: "approval__permission", // M3 随审批模块落地
    compact: "compaction__compact",    // M3 补强 T8 runbook 走查发现：M3 起短名从未路由（注册名是全名）——补齐
    yolo: "approval__yolo",            // 用户走查 2026-09-19：一键从不询问（never——2026-09-22 起全自动含危险命令，kimi auto 语义）
    auto: "approval__auto",            // 2026-09-22 用户拍板：一键回日常默认档（ask-risky——/yolo 镜像）
  };

  const builtinCommands = new Map<string, (args: string) => Promise<string>>([
    ["/model", async () => {
      const slots = graph.services.listProviders();
      // 一级只列带默认模型的槽——顶级「手动输入全名」入口已砍（2026-09-20 用户实测：没有用）；
      // 手输仍可达于槽内端点清单末位「手动输入…」，且槽语境裸名自动补 <slot>/ 前缀（原顶级手输的
      // 走查缺陷②逻辑内移——槽已选定，多槽歧义报错随之消失）
      const candidates = slots.filter((x) => x.defaultModel !== undefined);
      if (candidates.length === 0) return "无可切换的平台——先用 /provider 添加平台（含默认模型）";
      // 单槽直达（F5 用户实测：只有一个平台时还问「选哪个」是废问——/model 语义是换模型不是换平台）
      const slotName = candidates.length === 1
        ? candidates[0]!.name
        : (await commandUi.choose("选择平台", candidates.map((x) => `${x.name}（默认 ${x.defaultModel}，裸名即用）`))).split("（")[0]!;
      let next = slotName;
      const slot = graph.services.provider(slotName); // 消费路径（一轮 P2③）：listProviders 不透传槽值额外字段，经 provider() 取
      if (slot?.listModels !== undefined) {
        let models: string[] = [];
        try {
          models = await slot.listModels();
        } catch (err) {
          createLogger(sink, "kernel").debug("kernel.model.listmodels-failed", "端点模型清单拉取失败——回退手输", { slot: slotName, error: String(err) });
          const manual = (await commandUi.ask(`model（端点清单拉取失败：${err instanceof Error ? err.message : String(err)}——输入全名，或回车用默认 ${slot.defaultModel ?? "未设"}）`)).trim();
          if (manual !== "") next = manual;
        }
        // choose 在 try 外：Esc 的「已取消（Esc）」带内抛错必须穿透——曾在兜底 catch 内被吞成「拉取失败」
        // 而回落手输（2026-09-22 用户实测：Esc 后仍问模型名）。清单来源随槽值目录优选（provider-custom），标题不标注来源
        if (models.length > 0) {
          // 清单 = 纯模型项（2026-09-22 用户拍板：「手动输入…」项退役——清单就是全部可达路径；
          // 手输兜底只剩 listModels 失败时的 catch 分支）。当前模型勾标（与 /permission 二级列表 ✓ 当前值同族）：
          // 全名取尾段比对；裸槽名值经槽 defaultModel 解析（面板同口径）
          const curRaw = modelOverride ?? (typeof cfgModelValue() === "string" && cfgModelValue() !== "" ? (cfgModelValue() as string) : undefined);
          const curBare = curRaw === undefined ? undefined
            : curRaw.includes("/") ? curRaw.split("/").pop()
            : curRaw === slotName ? slot.defaultModel
            : curRaw;
          const mpick = await commandUi.choose(`选择模型（${slotName}）`, models.map((m) => (m === curBare ? `${m} ✓` : m)));
          next = `${slotName}/${mpick.replace(/ ✓$/, "")}`;
        }
      }
      // 批①：busy 期可执行、下一轮生效——主 turn 的 provider/model 在 prompt 开头一次性捕获（下方 resolveProvider），
      // 中途覆盖本轮无感。已知接受的泄漏面：ctx.llm 调用时解析（turn 内 compaction 二级调用会吃新模型）。
      await applyModelOverride(next); // m5 T9：核心动作抽共用——命令与设置服务同源（不双写）
      return "";
    }],
    ["/effort", async (args: string) => {
      // 思考投入档位（2026-09-25）：档位清单 = 当前槽 provider 适配器的模型目录（provider-custom 读
      // models.dev reasoning_options——契约 ProviderAdapter.listThinking，槽名/端点/主机三级匹配）。
      // 选定即写盘 + 会话内存覆盖（/model 同款双轨）；下发 = 主轮请求 reasoningEffort（provider 翻译层
      // 落线缆参数：openai 族 reasoning_effort〔on/off = silent〕、anthropic 族 thinking 映射）。二级调用
      // （ctx.llm）不带档位——辅助面（压缩/搜索/标题）不吃重思考档。菜单 = kimi segments（off/…档位，
      // always-on 才省 off）；未设档 = 默认档（中位）——kimi「从不不指定」；/effort auto = 回默认档。
      const parts = currentModelParts();
      if (parts === undefined) return "未配置模型——先用 /model 或 /provider 选模型";
      const { slotName, bare } = parts;
      const info = await thinkingInfoOf(slotName, bare);
      const current = await resolveStoredEffort();
      const arg = args.trim().toLowerCase();
      if (arg !== "") {
        // 直达形态 /effort <档位>：不查 segments（自定义端点模型可不在目录）——原样收；auto = 回默认档
        //（清覆盖 + 清盘上 effort 行，effective 回落目录默认——kimi 无此态，Orosus 保留为「跟随目录默认」口）
        if (!/^[a-z0-9._-]+$/.test(arg)) return `档位名 "${arg}" 不合法（仅限字母数字与 . _ -）`;
        applyEffortOverride(arg); // m5 T9：核心动作抽共用（auto = 清覆盖回目录默认）
        return ""; // 静默：反馈由宿主 toast diff h.status().effort（/model 同约）
      }
      if (info === undefined) {
        const capable = graph.services.provider(slotName)?.listThinking !== undefined;
        return capable
          ? `模型 ${bare} 无思考档位信息（目录未声明 effort 档——开关型思考或不支持）——可直敲 /effort <档位> 手动指定`
          : `平台 ${slotName} 不提供思考档位目录——可直敲 /effort <档位> 手动指定（原样发送）`;
      }
      const segments = segmentsOf(info);
      const items = segments.map((v) => (v === current ? `${v} ✓` : v)); // 当前值勾标（/model /permission 二级列表同族）
      // choose 在 try 外：Esc 的「已取消（Esc）」带内抛错穿透（/model 同款定案）
      // 标题带当前档（2026-09-25 用户拍板：菜单要体现当前是什么档——含目录外手设档的 lenient 情形也能看到）
      const pick = (await commandUi.choose(`选择思考档位（${bare}${current !== undefined ? ` · 当前 ${current}` : ""}）`, items)).replace(/ ✓$/, "");
      if (pick !== current) applyEffortOverride(pick);
      return ""; // 原样重选当前档 = 无操作零反馈（host diff 不变即无 toast）
    }],
    ["/help", async () => {
      const lines = ["内建命令：", "  /model /effort /help /reload"]; // 批⑤⑥：/usage /status 退役（宿主读口 h.usage()/h.status() 取代，CLI 并入 /settings 面板）；2026-09-25 /effort 入列
      lines.push("别名命令：");
      for (const [short, full] of Object.entries(COMMAND_ALIASES)) {
        const present = graph.commands.some((c) => c.name === full);
        lines.push(`  /${short} → ${full}${present ? "" : "（未安装对应模块）"}`);
      }
      lines.push("模块命令：");
      const cmds = graph.commands.map((c) => c.name);
      lines.push(cmds.length > 0 ? `  /${cmds.join(" /")}` : "  （无）");
      return lines.join("\n");
    }],
    ["/reload", async () => {
      const r = await harnessImpl.reload();
      // failed 段（T2 修谎）：回显报失败清单——失败模块明说原因首行，不再只报四段计数
      const failedText = r.failed.length === 0
        ? " 无"
        : `：${r.failed.map((f) => `${f.name}（${f.reason.split("\n")[0] ?? f.reason}）`).join("、")}`;
      return `reload 完成：added ${r.added.join(",") || "无"} / removed ${r.removed.join(",") || "无"} / reloaded ${r.reloaded.join(",") || "无"} / unchanged ${r.unchanged.length} / failed${failedText}`;
    }],
    ["/context", async () => {
      // 三行余量（M4-2 T20/B20）：窗口 = 核心顶层 contextWindow（D44）；已用 = usage 锚点（D39 修订透出），
      // 进程内还没有模型往返（新会话/resume 后）时回退 store 末条 usage——否则 resume 会话恒显 ~0（2026-09-20 用户实测）
      const modelNow = modelOverride ?? (typeof cfgModelValue() === "string" ? (cfgModelValue() as string) : "（未配置）");
      const used = usageAnchor?.totalTokens ?? lastUsageTotal(await store.all()) ?? 0;
      const pct = contextWindow !== undefined ? Math.round((used / contextWindow) * 100) : undefined;
      return `模型: ${modelNow}\n窗口: ${contextWindow !== undefined ? `${contextWindow} tokens` : "未知（/provider import --model 可写入）"}\n已用: ~${used} tokens${pct !== undefined ? `（${pct}%）` : ""}`;
    }],
    // /summary 已退役（2026-09-23 用户拍板）：查看口改 CLI Ctrl+O（直读最近 turn/compaction 的
    // summary——h.history() 读口开放，零契约损失；/usage /status 退役抽读口同先例）
  ]);

  // F5 十轮：核心顶层键名 provider（旧 model 键兼容读——分层合并两键都在时 provider 胜）
  const cfgModelValue = (): unknown => config.core.provider ?? config.core.model;
  // /effort 配置读口：核心顶层 effort 键（/effort 命令写盘；OROSUS_EFFORT 环境层免费生效——§6.6 核心顶层命名）
  const cfgEffortValue = (): string | undefined => {
    const v = config.core.effort;
    return typeof v === "string" && v !== "" ? v : undefined;
  };

  // ---- 思考档位解析链（2026-09-25 三轮，kimi-code 对齐：segmentsFor / defaultThinkingEffortForModel /
  // resolveThinkingEffort 三件同构）----
  // 目录声明（契约 ProviderAdapter.listThinking）会话内 memo——disk-first 目录读毫秒级但仍按 (槽,模型) 记忆，
  // 免去每 turn 重读 1.6MB JSON；目录新鲜度由 /provider 在线链路 + /reload（重建 harness）负责
  type ThinkingInfo = { efforts: string[]; offEffort?: string; hasToggle: boolean };
  const thinkingMemo = new Map<string, ThinkingInfo | undefined>();
  const currentModelParts = (): { slotName: string; bare: string } | undefined => {
    const mv = modelOverride ?? (typeof cfgModelValue() === "string" && cfgModelValue() !== "" ? (cfgModelValue() as string) : undefined);
    if (mv === undefined || mv === "") return undefined;
    const { provider: slotName, model: explicit } = parseModel(mv);
    const bare = explicit ?? graph.services.provider(slotName)?.defaultModel ?? mv;
    return { slotName, bare };
  };
  const thinkingInfoOf = async (slotName: string, bare: string): Promise<ThinkingInfo | undefined> => {
    const key = `${slotName}/${bare}`;
    if (thinkingMemo.has(key)) return thinkingMemo.get(key);
    let info: ThinkingInfo | undefined;
    try {
      info = (await graph.services.provider(slotName)?.listThinking?.(bare)) ?? undefined;
    } catch { info = undefined; } // 目录读失败 = 无信息（lenient 面）
    thinkingMemo.set(key, info);
    return info;
  };
  const middleOf = (values: readonly string[]): string => values[Math.floor(values.length / 2)]!; // kimi middleOf——GLM 双档 [high,max] 中位即 max
  // kimi segmentsFor（models.dev 口径）：有档位 → always-on（有档无 toggle 无 none）只列档位；否则前面加 off；
  // 纯 toggle 型 → on/off 开关两项
  const segmentsOf = (info: ThinkingInfo): string[] =>
    info.efforts.length > 0
      ? (info.offEffort === undefined && !info.hasToggle ? [...info.efforts] : ["off", ...info.efforts])
      : ["on", "off"];
  // kimi defaultThinkingEffortForModel：声明 defaultEffort 优先（models.dev 不携带）→ 缺省中位；toggle 型默认 on
  const defaultEffortOf = (info: ThinkingInfo): string => (info.efforts.length > 0 ? middleOf(info.efforts) : "on");
  let effortDefaultMemo: string | undefined; // 最近一次解析的默认档（status() 同步读口用；prompt//effort 路径填充）
  // 用户视角的当前档（未设 → 配置 → 目录默认档；目录无信息 → undefined = 不指定，lenient 面）
  const resolveStoredEffort = async (): Promise<string | undefined> => {
    const stored = effortOverride ?? cfgEffortValue();
    if (stored !== undefined) return stored;
    const parts = currentModelParts();
    if (parts === undefined) return undefined;
    const info = await thinkingInfoOf(parts.slotName, parts.bare);
    if (info === undefined) return undefined;
    const d = defaultEffortOf(info);
    effortDefaultMemo = d;
    return d;
  };
  // 线缆语义值（kimi resolveThinkingEffort）：'on' 原样传（openai 面 silent/anthropic 面 enabled）；
  // 'off' 有 offEffort 声明 → 发该值（恒 "none"），否则原样 'off'（openai 面 silent）
  const resolveEffortForWire = async (): Promise<string | undefined> => {
    const stored = await resolveStoredEffort();
    if (stored === undefined) return undefined;
    if (stored !== "off") return stored;
    const parts = currentModelParts();
    const info = parts !== undefined ? await thinkingInfoOf(parts.slotName, parts.bare) : undefined;
    return info?.offEffort ?? "off";
  };
  void resolveStoredEffort().catch(() => undefined); // 预热默认档 memo——status() 同步读口在首次 turn 前即可见
  const resolveModelValue = (modelValue: string): { stream: StreamFn; model: string } => {
    const { provider, model: explicitModel } = parseModel(modelValue);
    const adapter = graph.services.provider(provider);
    if (!adapter) {
      const available = graph.records.filter((r) => r.state === "active").map((r) => r.name).join("、") || "（无）";
      throw new Error(`provider "${provider}" 不可用（model "${modelValue}"）。已激活模块：${available}`);
    }
    const model = explicitModel ?? adapter.defaultModel;
    if (model === undefined) {
      // 裸名报错须列出可用 provider 及各自 defaultModel（计划补空白登记项）
      const listing = graph.records
        .filter((r) => r.state === "active")
        .map((r) => {
          const a = graph.services.provider(r.name);
          return a?.defaultModel !== undefined ? `${r.name}（默认 ${a.defaultModel}）` : `${r.name}（无默认，需写全名）`;
        })
        .join("、") || "（无）";
      throw new Error(`provider "${provider}" 未声明 defaultModel——请写全名 "<provider>/<model>"。可用 provider：${listing}`);
    }
    return { stream: adapter.stream, model };
  };
  const resolveProvider = (): { stream: StreamFn; model: string } => {
    const modelValue = modelOverride ?? cfgModelValue();
    if (typeof modelValue !== "string" || modelValue === "") {
      throw new Error(`未配置 model（核心顶层 key，格式 <provider>/<model> 或裸 <provider>，§6.6/D32）——请在 config.toml 或 CLI 指定`);
    }
    return resolveModelValue(modelValue);
  };

  // ctx.llm 实现（D39/T4 + 补强 T3 三扩展 + M4-3 T1b model/webSearch/listModels 扩展）：
  // 调用时解析当前 provider/model（含 /model 覆盖、reload 后的新图）；错误带内
  llmHolder.impl = {
    stream: (req: { system?: string; messages: ModelMessage[]; signal?: AbortSignal; maxTokens?: number; model?: string; webSearch?: boolean }) =>
      (async function* (): AsyncGenerator<Chunk> {
        let resolved: { stream: StreamFn; model: string };
        try {
          // SW-17 model 覆盖：provider/model 限定形走全解析（可钉非当前槽）；裸值 = 当前槽上换模型（不换槽）
          resolved = req.model === undefined ? resolveProvider()
            : req.model.includes("/") ? resolveModelValue(req.model)
            : { stream: resolveProvider().stream, model: req.model };
        } catch (err) {
          yield { type: "finish", kind: "error", errorMessage: `llm 口解析失败：${err instanceof Error ? err.message : String(err)}` };
          return;
        }
        yield* resolved.stream({
          model: resolved.model,
          system: req.system ?? "",
          messages: req.messages,
          tools: [], // 二级调用不带客户端工具（D39）——webSearch 是服务端搜索声明，与 tools 正交（M4-3 T1b）
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
          ...(req.webSearch !== undefined ? { webSearch: req.webSearch } : {}),
          signal: req.signal ?? new AbortController().signal,
        });
      })(),
    // SW-17 模型目录：无一槽提供目录能力时方法缺省（undefined——菜单据此灰显模型选择）；
    // 有能力则跨槽聚合，条目统一 provider/model 限定形（钉选值同款格式）。getter 惰性——reload 后按新图重判
    get listModels(): LlmPort["listModels"] {
      const capable = graph.services.listProviders().some((s) => graph.services.provider(s.name)?.listModels !== undefined);
      if (!capable) return undefined;
      return async (): Promise<string[]> => {
        const out: string[] = [];
        for (const s of graph.services.listProviders()) {
          const slot = graph.services.provider(s.name);
          if (slot?.listModels === undefined) continue;
          try {
            for (const m of await slot.listModels()) out.push(`${s.name}/${m}`);
          } catch { /* 单槽目录拉取失败跳过——聚合是尽力面 */ }
        }
        return out;
      };
    },
    get contextWindow() { return contextWindow; }, // getter：reload 后读新值（空白 §5）
    get lastUsage() { return usageAnchor; }, // usage 锚点只读透出（空白 §4）——锚点在 harness 主循环包装，loop 骨架不消费
  };

  const harnessImpl: Harness = {
    sessionId: store.sessionId,

    async prompt(text, opts) {
      if (closed) throw new Error("harness 已关闭");
      // 命令路由（D38 三层：CLI 拦截在宿主侧；此处内建表 > 别名 > 模块注册）。命令不触发 agentLoop、不落会话日志
      // 命令归一化（2026-09-19 用户走查）：`/ status`、`/compact  `、` /model ` 一律可解析——
      // 斜杠后空格抹除 + 连续空白折叠（不认就当聊天发出是缺陷；与 CLI 拦截层 sessionCommand 同款规则）
      // 批①②：命令路由先于单并发守卫——命令不创建 turn，busy 期可执行（/model /permission /yolo 等）；
      // 守卫只挡聊天消息。注意：core 不设 busy 白名单——「哪些命令 turn 安全」是宿主分级职责（/compact 这类改历史的仍须排队）
      const cmdText = text.trim().replace(/^\/\s+/, "/").replace(/\s+/g, " ");
      if (cmdText.startsWith("/")) {
        const m = /^\/([a-z0-9][a-z0-9-]*(?:__[a-z0-9-]+)?)(?:\s([\s\S]*))?$/.exec(cmdText);
        const name = m?.[1];
        const args = (m?.[2] ?? "").trim();
        if (name === undefined) throw new Error(`无法解析命令 "${text}"——输入 /help 查看可用命令`);
        const builtin = builtinCommands.get(`/${name}`);
        if (builtin !== undefined) return builtin(args);
        const alias = COMMAND_ALIASES[name];
        const target = alias ?? name;
        const cmd = graph.commands.find((c) => c.name === target);
        if (cmd === undefined) {
          if (alias !== undefined) throw new Error(`命令 /${name} 需要 ${alias.split("__")[0]} 模块——请安装/启用对应模块后重试（/help 查看可用命令）`);
          throw new Error(`未知命令 "/${name}"——输入 /help 查看可用命令`);
        }
        return await cmd.handler(args, commandUi);
      }
      if (currentTurn) throw new Error("已有进行中的 turn（M1 单并发；取消请调 cancel()）");
      const controller = new AbortController();
      let settle!: () => void;
      const done = new Promise<void>((resolve) => { settle = resolve; });
      // 同步占坑再 await：否则并发 prompt 会在首个 await 前双双通过守卫（TOCTOU），
      // close()/cancel() 在窗口期也拿不到真句柄。deferred done 让 close() 任何时刻等到的都是同一个 promise
      currentTurn = { controller, done };
      try {
        const { stream, model } = resolveProvider();
        // 思考档位（/effort）：turn 开头一次性捕获（/model 同款——busy 期切档下一轮生效）。
        // 未设档 → 目录默认档（kimi「从不不指定」——effort 型模型恒发解析值；目录无信息 → 不带字段）
        const effort = await resolveEffortForWire();
        // usage 锚点（补强 T3/空白 §4）：包装主循环 stream 记录最近一次真实用量——loop 骨架仍不消费 usage（零策略口径闭合）
        const trackedStream: StreamFn = (req) => (async function* () {
          for await (const c of stream(req)) {
            if (c.type === "usage") usageAnchor = { totalTokens: c.input + c.output, atMessageCount: req.messages.length };
            yield c;
          }
        })();
        await graph.bus.emit(CORE_POINTS.uiCommand, { kind: "prompt", text });
        await ensureHeader(); // 首个持久事件前补 header（T0 懒写——命令派发已在上方原路返回，不会触发）
        // user/message content 构造（M4-2.5 T5）：text part 在前、image part 引用形态在后（日志只存路径）
        const content: ContentPart[] = [
          ...(text !== "" ? [{ kind: "text", text } as const] : []),
          ...(opts?.images ?? []).map((p) => ({ kind: "image" as const, path: p, mimeType: imageMimeOf(p) })),
        ];
        await store.append(LOG_TYPES.userMessage, { content: content.length > 0 ? content : [{ kind: "text", text: "" }] });
        try {
        let lastTurnEvent: SessionEvent | undefined;
        for await (const e of agentLoop({
            session: store, bus: graph.bus, tools: graph.tools,
            provider: trackedStream, model, system: graph.promptSections(),
            ...(effort !== undefined ? { reasoningEffort: effort } : {}),
            signal: controller.signal, sink,
            livePush: (c) => live.push(c), // 双投并存（T4/D45）：落日志（assistantChunk）+ 旁路——T5 断流后仅旁路
          })) {
          lastTurnEvent = e;
          // 事件经 forwardingStore 在 append 时即转发，此处仅驱动迭代
        }
        // 会话自动标题（M4-2 B9 用户拉前，2026-09-19 走查）：首轮问答完成后总结短标题落 session/label
        // （M3/T6 预留类型首次消费）；LLM 失败兜底 = 首问文本截断。宿主显式 opt-in（核心缺省关）。
        if (options.autoTitle === true && lastTurnEvent?.type === "turn/end" && (lastTurnEvent as { kind?: string }).kind === "completed") {
          await maybeTitle();
        }
        } finally {
          currentTurn = null;
          settle();
        }
      } catch (err) {
        currentTurn = null;
        settle();
        throw err;
      }
    },

    cancel() {
      currentTurn?.controller.abort();
    },

    steer(text) {
      if (!currentTurn) return false; // 无进行中 turn——调用方回退排队/直接提交
      steerBacklog.push(text);
      return true;
    },

    events() {
      return channel.iterate();
    },

    history() {
      return store.all(); // 内存镜像（含未 drain 的 buffer）——与投影同源
    },

    liveChunks() {
      // §11.9 纪律（T4）：订阅/断开记 klog——实时通道可观测性（无订阅者期间 push 全弃属设计行为）
      const klog = createLogger(sink, "kernel");
      const gen = live.iterate();
      return (async function* () {
        klog.debug("kernel.live.subscribe", "liveChunks 订阅", { sess: store.sessionId });
        try {
          yield* gen;
        } finally {
          klog.debug("kernel.live.disconnect", "liveChunks 断开", { sess: store.sessionId });
        }
      })();
    },

    graph() {
      return graph;
    },

    // 批⑤：/usage 内建命令退役后的宿主读口（双口径不变——会话级恒有、项目级随存储后端）
    async usage() {
      const cur = sumUsage(await store.all());
      const lt = store.lifetimeUsage !== undefined ? await store.lifetimeUsage() : undefined;
      return { current: cur, ...(lt !== undefined ? { lifetime: lt } : {}) };
    },

    // 批⑥：/status 内建命令退役后的宿主读口（model 未配置显示「（未配置）」——M2 补账口径保留）
    status() {
      const audit = graph.audit();
      const configured = typeof cfgModelValue() === "string" && cfgModelValue() !== "" ? (cfgModelValue() as string) : "（未配置）";
      const effort = effortOverride ?? cfgEffortValue() ?? effortDefaultMemo; // /effort 读口（宿主 toast diff 与运行状态卡消费；memo 默认档由 prompt//effort 路径预热）
      return {
        model: modelOverride ?? configured,
        overridden: modelOverride !== undefined,
        sessionId: store.sessionId,
        ...(effort !== undefined ? { effort } : {}),
        modules: {
          active: audit.filter((a) => a.state === "active").length,
          failed: audit.filter((a) => a.state === "failed").length,
          discovered: audit.filter((a) => a.state === "discovered").length,
        },
      };
    },

    // 批⑦a：/title 当前会话改名走活 store（单写者——旁路新建 store 写活文件会破 parentId 链/seq 单调）。
    // append 后立即 flush（2026-09-22 用户实测：label 滞留写缓冲时 /sessions 读盘看不到新名——改名必须即落盘）
    // m5 T17：待确认桶读口（blocked 随 reload 重算——返回当前态）
    pendingConfirms() {
      return blocked.map((b) => ({
        name: b.def.name,
        version: b.def.version,
        layer: b.layer ?? "project",
        root: b.root ?? "",
        reason: b.reason,
        entryHash: b.entryHash ?? "",
        def: b.def, // 声明面数据源（provides/dependsOn/mounts/uses——activate 之前全部静态可读）
      }));
    },
    // m5 T9：设置服务后端出口（命令同源核心动作）——CLI 在 main.ts 拼 SettingsService 后经本接口转发
    async setModel(qualified: string) {
      await applyModelOverride(qualified);
    },
    setEffort(level: string) {
      applyEffortOverride(level);
    },

    async setLabel(label: string) {
      await ensureHeader(); // 命名先于首个 turn 也不出断头文件（/title 新政同 fork 走查批）
      await store.append(LOG_TYPES.sessionLabel, { label: label.slice(0, 200) });
      await store.flush();
    },

    // 会话树批 T6：落盘式分叉出口——独立 own store 写 header + session/fork 即刻落盘，全程不触碰当前活
    // store（不能拿 ForkedSessionStore 包活 store——它的 close() 会连父一起关，把活会话关了）
    async fork(forkOpts?: { atEntryId?: string }) {
      const events = await store.all();
      const at = forkOpts?.atEntryId ?? events[events.length - 1]?.id;
      if (at === undefined || !events.some((e) => e.id === at)) {
        throw new Error(`fork 分叉点不在当前投影内：${String(forkOpts?.atEntryId ?? "（投影为空，无缺省分叉点）")}`);
      }
      const own = makeStore();
      try {
        await own.append(LOG_TYPES.sessionHeader, {
          format: 1,
          cwd: options.cwd ?? process.cwd(),
          parentSession: store.sessionId,
          moduleSummary: { // 照 ensureHeader 现口径（三计数）
            active: graph.records.filter((r) => r.state === "active").length,
            failed: graph.records.filter((r) => r.state === "failed").length,
            discovered: graph.records.filter((r) => r.state === "discovered").length,
          },
        });
        await own.append(LOG_TYPES.sessionFork, { sourceEntryId: at, parentSession: store.sessionId });
        await own.flush();
        return { sessionId: own.sessionId };
      } finally {
        await own.close();
      }
    },

    // 宿主日志口（T4/S10）：createLogger 每次新建实例无妨——写盘队列挂在 sink 闭包上，多 logger 天然共享
    log(code: string, msg: string, data?: Record<string, unknown>) {
      createLogger(sink, "host").info(code, msg, data);
    },

    async reload() {
      if (closed) throw new Error("harness 已关闭");
      // quiesce（§5.5，无超时定案——挂死 turn 由用户 cancel()/Ctrl-C 中止，中止即达边界）
      if (currentTurn !== null) await currentTurn.done.catch(() => undefined);
      const oldGraph = graph;
      const oldDefs = oldGraph.defs();
      // 重新执行配置分层合并 → 发现 → 信任 →（同一代码路径；§5.5）
      const home2 = orosusHome();
      secrets = loadSecretsEnv(options.secretsFile ?? join(home2, "secrets.env")).vars; // 重读 secrets（向导等运行期写入后 reload 必须看到）
      const config2 = loadConfig({
        userFile: options.config?.userFile ?? join(home2, "config.toml"),
        projectFile: join(options.cwd ?? process.cwd(), ".orosus", "config.toml"),
        ...(options.config?.cliOverrides !== undefined ? { cliOverrides: options.config.cliOverrides } : {}),
        env: options.config?.env ?? mergeEnvLayer(process.env, secrets),
      });
      contextWindow = readContextWindow(config2.core); // reload 读新值——getter 形态下模块侧立即生效（空白 §5）
      const oldResolution = resolveSections(config.sections, oldDefs.map((g) => g.def), cliInput); // 旧配置启停解析——config 覆盖前留存（热插拔修复 T1：启停翻转算进变更）
      config = config2; // 核心顶层 key（model 等）同步更新——修复：reload 后 model/contextWindow 等仍读旧值（走查缺陷③：向导写 model + /reload 后 resolveProvider 仍读旧 config.core.model = undefined → "未配置 model"）
      const defs2: { def: ModuleDefinition; source: "builtin" | "inline" | "local"; entryHash?: string; root?: string; layer?: "user" | "project" }[] = [
        ...(options.builtinModules ?? []).map((def) => ({ def, source: "builtin" as const })),
        ...(options.modules ?? []).map((def) => ({ def, source: "inline" as const })),
      ];
      {
        const userDir = options.discovery?.userDir ?? join(home2, "modules");
        const projectDir = options.discovery?.projectDir ?? join(options.cwd ?? process.cwd(), ".orosus", "modules");
        const discovered = await discoverModules({ userDir, projectDir, ...(options.config?.userFile !== undefined ? { userFile: options.config.userFile } : {}), sink });
        const trustStore = loadTrustStore(options.discovery?.trustFile ?? join(home2, "trust.json"));
        blocked = []; // m5 T17：待确认桶随 reload 重算（确认→reload 即出桶挂载；入口文件变更→回桶重问）
        for (const m of discovered) {
          const t = checkTrust({ layer: m.layer, root: m.root, entryHash: m.entryHash, store: trustStore });
          if (t.ok) defs2.push({ def: m.def, source: "local", root: m.root, layer: m.layer, ...(m.entryHash !== undefined ? { entryHash: m.entryHash } : {}) });
          else
            blocked.push({
              def: m.def,
              source: "local",
              layer: m.layer,
              ...(m.root !== undefined ? { root: m.root } : {}),
          ...(m.entryHash !== undefined ? { entryHash: m.entryHash } : {}),
              reason:
                m.layer === "project" && t.reason === "hash-changed"
                  ? "untrusted（项目级模块代码已变更，须重新确认，§8.5/MCPoison）"
                  : m.layer === "project"
                    ? "untrusted（项目级模块未确认，§8.5）"
                    : "unconfirmed（用户级模块首次挂载待确认）",
            });
        }
      }
      // 启停翻转算进变更（热插拔修复 T1）：diff 两侧按 resolveSections 各自配置过滤出有效集——
      // 卸载半圈（有效→停用）走既有移除通路（墓碑 + 拆除旧实例），重挂半圈走既有新增通路（干净激活、墓碑位原位复活）。
      // 过滤只影响 diff 判定，loadModules 仍喂全量 defs2（停用模块保持「进 records/audit、状态 discovered」语义，§5/§5.4）。
      const newResolution = resolveSections(config2.sections, defs2.map((d) => d.def), cliInput);
      const oldEff = oldDefs.filter((g) => oldResolution.isEnabled(g.def));
      const newEffNames = new Set(defs2.filter((d) => newResolution.isEnabled(d.def)).map((d) => d.def.name));
      // diff 粗判（§5.5 Reloaded 判据：entryHash / def 引用 / 配置自有 key 有效值——三者任一变化即重载）
      const removedOrChanged = new Set<string>();
      const newConfigValue = (name: string): unknown => {
        const next = defs2.find((d) => d.def.name === name);
        if (next === undefined) return undefined;
        const section = { ...config2.sections.get(name) };
        for (const k of ["enabled", "source", "required"]) delete section[k];
        const parsed = next.def.config?.safeParse(section);
        return parsed?.success ? parsed.data : undefined;
      };
      for (const g of oldEff) {
        if (!newEffNames.has(g.def.name)) { removedOrChanged.add(g.def.name); continue; }
        const next = defs2.find((d) => d.def.name === g.def.name)!;
        if (g.entryHash !== next.entryHash || g.def !== next.def) { removedOrChanged.add(g.def.name); continue; }
        // 配置自有 key 有效值 deepEqual 失败 → Reloaded（M3 修复：粗判此前漏配置变化——preserved 误含已变模块，
        // required 模块的坏配置在 reload 中被静默沿用旧实例，安全护栏失效）
        if (JSON.stringify(g.configValue) !== JSON.stringify(newConfigValue(g.def.name))) removedOrChanged.add(g.def.name);
      }
      const preserved = new Map([...oldGraph.preservable()].filter(([name]) => !removedOrChanged.has(name)));
      const generations = new Map(oldGraph.records.map((r) => [r.name, r.generation]));
      // 会话连续性（§5.5，时序走查修正）：墓碑在**新图激活前**打——共享注册表上 Reloaded 模块重注册原位
      // 复活墓碑槽；激活后打会把复活的新工具再杀一次。失败路径：changed 模块工具保持墓碑（带内报错，§5.5 语义）
      for (const name of removedOrChanged) {
        for (const tn of oldGraph.tools.namesByOwner(name)) oldGraph.tools.tombstone(tn);
      }
      let newGraph: ModuleGraph;
      try {
        newGraph = await loadModules({
          defs: defs2,
          cli: cliInput,
          sections: config2.sections,
          session: store,
          sink,
          spillDir: spillDirUsed,
          cwd: options.cwd ?? process.cwd(),
          commandUi,
          llm: llmHolder,
          ...(options.settings !== undefined ? { settings: options.settings } : {}), // m5 T9：reload 同款透传（新图 ctx 装配不缺件）
          ...(options.host !== undefined ? { host: options.host } : {}),
          ...(blocked.length > 0 ? { blocked } : {}), // m5 T17：待确认桶随新图可见（重算后的 blocked）
          reuse: { bus: oldGraph.bus, tools: oldGraph.tools },
          preserved,
          generations,
        });
      } catch (err) {
        // 图级失败（required 护栏等）：新图整体废除、旧图继续运行（§5.5 事务性）——reuse 注册表上的新激活已被 loadModules 内部回滚
        throw new Error(`reload 失败，旧图继续运行：${err instanceof Error ? err.message : String(err)}`);
      }
      // 换下实例选择性拆除（走查修复）：旧实例 disposers 摘共享 bus 上的旧监听（否则 Reloaded 模块监听双份）、
      // disposeFn 清理资源——preserved 实例不经此路（句柄被新图沿用）
      await oldGraph.disposeOwners([...removedOrChanged]);
      graph = newGraph;
      ensureSteerHook(graph.bus); // reuse 同 bus 时 WeakSet 短路；新 bus 兜底重挂
      const d = diffGraphs(oldEff, newGraph.defs().filter((g) => newEffNames.has(g.def.name))); // 有效集口径——added/removed 如实含启停翻转（toast/回显消费，T2）
      const failed = newGraph.records.filter((r) => r.state === "failed").map((r) => ({ name: r.name, reason: r.failReason ?? "未知" }));
      const report: ReloadReport = { added: d.added, removed: d.removed, reloaded: d.reloaded, unchanged: d.unchanged, failed };
      createLogger(sink, "kernel").info("kernel.reload.done", "reload 完成", { added: d.added.length, removed: d.removed.length, reloaded: d.reloaded.length, unchanged: d.unchanged.length });
      return report;
    },

    async close() {
      if (closed) return; // 幂等
      closed = true;
      currentTurn?.controller.abort();
      await currentTurn?.done.catch(() => undefined);
      await graph.dispose();
      await store.close();
      live.close();
      await sink.flush();
      await sink.close();
      channel.close();
    },
  };
  return harnessImpl;
}
