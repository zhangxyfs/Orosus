import { orosusHome } from "@orosus/contracts/home";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { CommandUi, HostInfo, LlmPort, ModuleDefinition, SettingsService } from "@orosus/contracts/module";
import type { Chunk, ContentPart, ModelMessage, StreamFn } from "@orosus/contracts/provider";
import { createDiagSink, createLogger } from "./diag/logger.ts";
import { hardeningNote, JsonlSessionStore, lastUsageTotal, sumUsage } from "./session/jsonl.ts";
import { SqliteSessionStore, sqliteAvailable } from "./session/sqlite.ts";
import { ForkedSessionStore, openSessionView, verifyChain, type SessionLoadInfo } from "./session/fork.ts";
import { refreshEventIndex } from "./session/eventindex.ts";
import { defaultEventIndexFile, eventsBefore as eventsBeforeQuery, indexSingleSession } from "./session/eventindex.ts";
import type { SessionEvent, SessionStore } from "./session/types.ts";
import { LOG_TYPES } from "./session/types.ts";
import { locateSessionBucket } from "./session/dir.ts";
import { TreeIndex } from "./session/treeindex.ts";
import { loadConfig, loadSecretsEnv, mergeEnvLayer, modelsDevCacheFile, resolveContextWindow } from "./config/load.ts";
import { resolveSections } from "./config/validate.ts";
import { loadModules, type ModuleGraph } from "./kernel/kernel.ts";
import { discoverModules, type DiscoveredModule } from "./kernel/discover.ts";
import { diffGraphs, stableStringify, type ReloadReport } from "./kernel/reload.ts";
import { loadTrustStore, checkTrust, atomicWriteTextSync } from "./kernel/trust.ts";
import { unassignedLlm } from "./kernel/activate.ts";
import { CORE_POINTS } from "./kernel/bus.ts";
import type { EventBus } from "./kernel/bus.ts";
import { parseModel } from "./provider/resolve.ts";
import { agentLoop } from "./loop/loop.ts";
import { createSubagentRunner } from "./subagent/runner.ts";
import { kernelT, setKernelLocale } from "./kernel/i18n.ts";

/** 扩展名 → MIME（M4-2.5 T5）：/paste 产物即 png；未知缺省 image/png。 */
function imageMimeOf(path: string): "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  const ext = path.toLowerCase().split(".").at(-1) ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

/** TOML 基本串写侧转义（CH-08 修复）：模型名/档位可能来自端点清单（网络数据）或 listModels 失败时的
 *  手输（任意文本）——裸拼进 `provider = "..."` 会在值含引号/换行时写坏 user config，下次启动 SW-20
 *  降级跳过整个用户层（approval/provider 等全部静默丢失）。控制字符统一 \uXXXX，其余按 TOML 规范短转义。 */
function tomlBasicString(v: string): string {
  let out = "";
  for (const ch of v) {
    switch (ch) {
      case "\\": out += "\\\\"; break;
      case '"': out += '\\"'; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      case "\b": out += "\\b"; break;
      case "\f": out += "\\f"; break;
      default:
        out += ch < " " || ch === "\u007f" ? `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}` : ch;
    }
  }
  return `"${out}"`;
}

export interface HarnessOptions {
  modules?: ModuleDefinition[];
  builtinModules?: ModuleDefinition[];
  cwd?: string;
  dateSource?: () => Date;                   // m4-6 T7：日期源可注入（测同日不重复/跨日再注入）；核心 Environment 节已无 date——日期走消息位系统行
  store?: SessionStore;
  sessionsDir?: string;                     // 会话文件目录（D41/T6）：缺省 ~/.orosus/sessions——resume/fork/新会话共用；测试密封注入 tmp
  sessionsRoot?: string;                    // 会话根目录（会话树批 T1）：fork 祖先链跨桶定位兜底用（locateSessionBucket 全根扫描）；#17 封闭后新链祖先恒同桶，只为存量跨桶链只读兼容；缺省 = 只走同桶快路径
  treeIndexFile?: string;                   // 会话树批 T9：树索引库落点（缺省 ~/.orosus/db/session-tree.sqlite——索引是缓存可删可重建）；测试密封注入 tmp
  /** T11（m5-resume-perf）：事件索引库落点（缺省 ~/.orosus/db/event-index.sqlite——独立库与树索引
   *  生命周期互不牵连，索引是缓存可删可重建）；测试密封注入 tmp。 */
  eventIndexFile?: string;
  /** T11：会话装载模式（缺省窗口；env OROSUS_SESSION_LOAD=full 逃生阀；行模式由 CLI 装配层显式传
   *  full——echoHistory 只翻已载入行，窗口化会让更早历史在行模式看不到，零回归原则）。子代理 store
   *  恒全量（runner 接线显式传 full——文件受双保险丝天然有界，风险节钦点不窗口化）。 */
  sessionLoad?: "window" | "full";
  sessionSwitch?: (sessionId: string) => Promise<boolean>; // 会话树批 T10/T11 缝三：宿主切换缝（CLI 注入 switchTo 链路 + 桶闸；立即返回语义——决策点 9）；缺省不装（ctx.session.switchTo = undefined）
  diagDir?: string;
  spillDir?: string;
  mediaDir?: string;   // m5-media F2：会话媒资库显式注入（缺省 <sid>/media）
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
    userModulesDir?: string;                // modules.d 目录层（m4-8）——缺省 ~/.orosus/modules.d/
    projectModulesDir?: string;             // 缺省 <cwd>/.orosus/modules.d/
    catalogCacheFile?: string;              // models-dev 盘上缓存落点（contextWindow 兜底链，2026-09-29）——缺省 ~/.orosus/cache/models-dev.json；测试注入 tmp 密封
    cliOverrides?: Record<string, unknown>;
    enableModules?: string[];
    disableModules?: string[];
    noModules?: boolean;
    module?: string[];                      // 纯净模式白名单（--module，仅 noModules 时生效）
    env?: Record<string, string | undefined>;
  };
}

export interface Harness {
  prompt(text: string, opts?: { images?: string[] | undefined; /** 宿主旁注事件（m5-media F14 走查四）：紧随
   *  user/message 原子落盘——回放行序「用户消息→旁注→回答」由落盘顺序保证（外部先 append 会抢在
   *  user/message 前）。类型建议 host/ 前缀：deriveMessages 未知类型跳过 = 不进上下文，只服务回放渲染。
   *  可传多条（2026-10-03 输入召回批：转述旁注与输入召回旁注共存——数组序即落盘序）。
   *  单条形态向后兼容（旧调用不动）。 */
    afterUserEvent?: { type: string; fields: Record<string, unknown> } | { type: string; fields: Record<string, unknown> }[] | undefined }): Promise<string | undefined>;  // 命令输入时返回命令输出（回显）；普通 turn 返回 undefined。images = /paste 挂起图（M4-2.5 T5）
  cancel(): void;
  /** Steering 注入口（2026-09-23 消息队列批——kimi Ctrl-S 同语义，宿主键位 Ctrl+U）：turn 进行中
   *  把文本注入当前 turn——loop 下一 step 边界（steering collect 链）或停止边界（followUp 兜底，
   *  错过窗口不丢消息）作为 agent/steering-message 落日志并进上下文（投影 = user 消息）。
   *  无进行中 turn → false（调用方回退排队/直接提交）。 */
  steer(text: string): boolean;
  /** 当前会话 id（/fork 等宿主侧会话操作的消费面，D41/T6）。 */
  readonly sessionId: string;
  /** 单订阅者（M1）：Channel 逐 waiter 派发，多订阅者会瓜分事件；广播需求出现时再升级。
   *  CH-10：不订阅不无界占用内存——缓冲只保留最近 256 条（drop-oldest），完整历史走 history()。 */
  events(): AsyncIterable<SessionEvent>;
  /** 会话历史（宿主显示面，B9 走查补）：全部持久事件（resume 回显用；含 reasoning 块——显示方自行取舍）。 */
  history(): Promise<SessionEvent[]>;
  /** T10（m5-resume-perf）历史全量升级口：窗口装载（T7）的镜像按需整读全量——全量消费者兜底
   *  （label 预算外等显示面缺数据时）；全量后端 noop。幂等。 */
  ensureHistoryFull(): Promise<void>;
  /** T14（m5-resume-perf）懒分页取段口：索引查 beforeSeq 之前的 limitEvents 条（升序）——pread
   *  逐行 parse、纯查看用不进内存镜像；不设压缩边界（D13：翻页可跨压缩行取压缩前原文——取数走
   *  文件索引，与内存装了哪段无关）。空返 = 到会话开头。fork 复合视图恒空（前缀在祖辈文件——分页
   *  属后续增强）。 */
  eventsBefore(sessionId: string, beforeSeq: number, limitEvents?: number): Promise<SessionEvent[]>;
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
  /** 当前项目桶全量树快照（会话树批 T7，缝二内核半边）：扫描 + 预算读元数据，现读现建——
   *  委托 buildSessionTree（jsonl 读法 T7 / sqlite T8 / 索引缓存 T9）。孤立节点原样返回。 */
  tree(): Promise<import("@orosus/contracts/module").SessionTreeNode[]>;
  /** 设置服务后端（m5 T9 口子四）：换模型——/model 同源核心动作（覆盖槽 + 写盘 + 档位跟随重解析），单一写者不双写；busy 期可调、下一轮生效。 */
  setModel(qualified: string): Promise<void>;
  /** 配置语言键读取（m5-i18n T3）：顶层 language 键原文；未设置返回 undefined（宿主走系统检测缺省）。 */
  configuredLanguage(): string | undefined;
  /** 切语言（m5-i18n T3）：行级写顶层 language 键 + 内核地板 t 对齐（failReason 新事件跟随新语言）。 */
  setLanguage(tag: string): Promise<void>;
  /** 设置服务后端（m5 T9）：切思考档位——/effort 同源；"auto" = 回目录默认档；非法档名抛错。 */
  setEffort(level: string): void;
  /** 待确认第三方模块清单（m5 T17）：未过信任门的 local 模块（项目级 hash 门
   *  / 用户级一次性确认）——面板「待确认」桶与首挂确认弹窗的数据源（layer + 目录路径弹窗要显示）。 */
  /** 子代理花名册快照（M4.5 T8/T10/T11——界面三件套数据口）：子+孙同册（孙带 parentId），
   *  进行中全列 + 已结束保留最近 32 条；pendingApproval = 后台 Ask 档挂起的审批（answerSubagentApproval 应答）。 */
  subagents(): import("@orosus/contracts/module").SubagentRosterEntry[];
  /** 应答后台子代理的挂起审批（M4.5 T8/决策 3）：不抢占的问——用户有空再批；会话关闭/停止自动按拒绝。 */
  answerSubagentApproval(agentId: string, allow: boolean): boolean;
  /** 双击 Esc 全停（M4.5 T14/决策 12）：停止全部子代理（在跑/排队），未答审批自动按拒绝收场。 */
  stopAllSubagents(): void;
  /** 宿主二级调用口（m5-btw T1，/btw 直调用）：返回 llmHolder.impl——模块 ctx.llm 转发的同一实现体（D39）。
   *  调用时解析当前 provider/model（含 /model 覆盖）、内建 tools:[]、全程零落盘（不经 store/loop）。 */
  llm(): LlmPort;
  pendingConfirms(): { name: string; version: string; layer: "user" | "project"; root: string; reason: string; entryHash: string; def: import("@orosus/contracts/module").ModuleDefinition }[];
  /** 宿主日志口（T4/S10）：宿主侧信息性事件写诊断日志——与 kernel 同一 sink 同一队列（lvl=info；
   *  Logger 契约只有五个分级方法，无裸 log）。首用 = 联动启停连带名单（host.module.cascade）。 */
  log(code: string, msg: string, data?: Record<string, unknown>): void;
  /** 宿主翻译口注入（m5-i18n T2）：替换模块 ctx.t 的活实现（默认内核地板 t）；宿主 store 就绪/语言切换时调用。 */
  setModuleT(t: (key: string, params?: Record<string, string | number | boolean | undefined | null>, fallback?: string) => string): void;
  graph(): ModuleGraph;
  reload(): Promise<ReloadReport>;  // quiesce 后执行（§5.5/T15）
  close(): Promise<void>;
}

/** events() 缓冲上限（CH-10）：零订阅者时只保留最近 N 条（drop-oldest）——旧实现无界 push，
 *  嵌入式宿主（只用 prompt/history、从不订阅 events()）整个会话历史（含完整消息体）在 channel.buf
 *  里再存一份、进程级累积。与 LiveChannel「断连即弃」同纪律：旁路通道不承担无限回放，完整历史走
 *  history()/会话文件（events() 迟订阅最多拿到最近 N 条，JSDoc 已注明）。 */
const EVENTS_CHANNEL_CAP = 256;

/** 无锁异步通道：events() 订阅端与 turn 生产端的缓冲（单订阅者，M1）。 */
class Channel<T> {
  private buf: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;
  private overflowWarned = false;
  // 显式字段赋值，刻意不用 constructor 参数属性：参数属性是非可擦除语法，node --experimental-strip-types
  // （CLI 的运行方式）加载即抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX；vitest 走 esbuild 全转换测不出（tool-fs 同款注记）
  private readonly cap: number;
  private readonly onOverflow: ((total: number) => void) | undefined;
  constructor(cap: number, onOverflow?: (total: number) => void) {
    this.cap = cap;
    this.onOverflow = onOverflow;
  }
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) {
      w({ value: v, done: false });
      return;
    }
    if (this.buf.length >= this.cap) {
      this.buf.shift(); // CH-10：无等待者且满——丢最旧（迟订阅者拿最近 cap 条，新事件永不因满被拒）
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        this.onOverflow?.(1);
      }
    }
    this.buf.push(v);
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
    // T10/T11（m5-resume-perf）：ensureFull 条件转发（lifetimeUsage 同款挂法）——窗口镜像的懒升级口
    // 经包装层透出，usage()/fork 校验/h.ensureHistoryFull 才够得着 JsonlSessionStore 的真身
    ...(store.ensureFull !== undefined ? { ensureFull: () => store.ensureFull!() } : {}),
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
  const projectConfigFile = options.config?.projectFile ?? join(options.cwd ?? process.cwd(), ".orosus", "config.toml");
  let config = loadConfig({
    userFile: userConfigFile,
    projectFile: projectConfigFile,
    // modules.d 目录层（m4-8）：缺省 = 各配置文件同级的 modules.d/（注入可覆盖——测试密封）。
    // 缺省按「实际生效的配置文件」取同级目录而非裸 home：生产默认路径下两者同值（~/.orosus/modules.d），
    // 但测试注入 tmpdir userFile/projectFile 时同级目录落在 tmpdir——密封不被架空（2026-09-30 修：
    // 旧实现裸 join(home, "modules.d") 令密封了 config 文件的测试仍读到真实用户 modules.d——
    // tool-search 被用户真实配置置 enabled，三颗关态断言全红）
    userModulesDir: options.config?.userModulesDir ?? join(dirname(userConfigFile), "modules.d"),
    projectModulesDir: options.config?.projectModulesDir ?? join(dirname(projectConfigFile), "modules.d"),
    ...(options.config?.cliOverrides !== undefined ? { cliOverrides: options.config.cliOverrides } : {}),
    // D37 优先级：显式 env 参数 > process.env > secrets.env——显式环境是用户当下意图，secrets 只补缺
    env: options.config?.env ?? mergeEnvLayer(process.env, secrets),
  });
  // SW-20：解析失败降级进 warnings——落地即弃可惜，diag 留痕（引导触发判定在 CLI preflight，不靠此路）
  for (const w of config.warnings) createLogger(sink, "kernel").warn("kernel.config.load-warning", w, {});
  // 窗口兜底链数据源（2026-09-29 用户拍板）：config 顶层显式值缺省/非法时按槽·模型查 models-dev 盘上缓存
  const catalogCacheFile = options.config?.catalogCacheFile ?? modelsDevCacheFile(home);

  // 存储构造分支（D41/T6 + D42/T7）：显式 store > resume > fork > 全新；后端按核心顶层 key sessionStore 选择（缺省 jsonl）
  const sessionsDir = options.sessionsDir ?? join(home, "sessions");
  // T11（m5-resume-perf）装载装配链：缺省窗口；env OROSUS_SESSION_LOAD=full 逃生阀（cc kill switch
  // 同形）；子代理经 runner 接线显式传 {load:"full"}。窗口注入 index（bucket=目录名——事件索引
  // (bucket,sid) 主键；索引可用性由装配层判定：resume 前先增量刷新）。
  const sessionLoad: "window" | "full" = options.sessionLoad ?? (process.env.OROSUS_SESSION_LOAD === "full" ? "full" : "window");
  const eventIndexFile = options.eventIndexFile ?? defaultEventIndexFile();
  const makeStore = (sessionId?: string, dir: string = sessionsDir, opts?: { load?: "window" | "full" }): SessionStore => {
    const backend = String(config.core.sessionStore ?? "jsonl");
    const withId = sessionId !== undefined ? { sessionId } : {};
    if (backend === "sqlite") return new SqliteSessionStore({ dir, ...withId }); // v2 撤项：sqlite 会话后端维持现状（全量装载）不再投资
    if (backend === "jsonl") {
      const load = opts?.load ?? sessionLoad;
      return new JsonlSessionStore({ dir, ...withId, ...(load === "window" ? { load: "window" as const, index: { dbFile: eventIndexFile, bucket: basename(dir) } } : {}) });
    }
    throw new Error(`sessionStore 配置非法："${backend}"（合法值 jsonl | sqlite，核心顶层 key，§7.2/D42）`);
  };
  let baseStore: SessionStore;
  let resumeLoads: SessionLoadInfo[] = []; // T11：装载路径口径（verifyChain windowedHead 判据与埋点数据源）
  if (options.store !== undefined) {
    baseStore = options.store;
  } else if (options.resume !== undefined) {
    // CS-01 修复（2026-09-28 code review P0）：resume 的会话可能是 fork 子体——旧实现平铺打开自己那份
    // 文件，投影丢掉全部父辈历史（/sessions 回车、switchTo、--resume 三条入口全命中）。统一经
    // openSessionView：普通会话 = 裸 store（与旧 makeStore 语义一致），子体 = 递归拼装祖辈前缀（同 fork 分支）。
    // T11：①装载前增量刷事件索引（D14——mtime+size 双判命中零成本跳过；首开建行走 T7 嗅探备胎顺手建，
    // 本次备胎下次索引）；②耗时埋点 session.load.resumed（cc tengu_session_resumed 同款——mode 取
    // loadPath 三态）；③祖先链各层同窗口（makeStore 同参注入）。
    const tResume0 = Date.now();
    const rb = locateSessionBucket(options.sessionsRoot, options.resume.sessionId, sessionsDir);
    if (rb !== undefined && sqliteAvailable()) {
      try {
        const rfile = join(rb, options.resume.sessionId, "agents", "session.jsonl");
        const rst = statSync(rfile);
        await refreshEventIndex(eventIndexFile, options.sessionsRoot ?? dirname(sessionsDir), [{ id: options.resume.sessionId, file: rfile, dir: rb, mtimeMs: rst.mtimeMs, size: rst.size, bucket: basename(rb) }]);
      } catch { /* 索引 best-effort：失败走嗅探备胎 */ }
    }
    const resumeView = await openSessionView({
      sessionId: options.resume.sessionId,
      bucket: sessionsDir,
      makeStore,
      locate: (sid) => {
        const b = locateSessionBucket(options.sessionsRoot, sid, sessionsDir);
        return b === undefined ? undefined : { bucket: b };
      },
      sink: { warn: (code, msg, data) => createLogger(sink, "session").warn(code, msg, data ?? {}) },
    });
    baseStore = resumeView.store;
    resumeLoads = resumeView.loads;
    // mode 取首个窗口态层的 path（fork 子体 resume 时 loads[0] 是子体自身小文件 full——代表不了
    // 祖先链的窗口路径；全 full 时回落 loads[0]）
    const leaf = resumeView.loads.find((l) => l.mode === "window") ?? resumeView.loads[0];
    createLogger(sink, "session").info("session.load.resumed", "会话装载完成", {
      duration_ms: Date.now() - tResume0,
      mode: leaf?.path ?? "full",
      ...(leaf?.fallback !== undefined ? { fallback: leaf.fallback } : {}),
    });
    // T7③ 方案点名 diag（2026-10-05 全量对账补）：窗口装载降级留 warn 痕——老格式/无压缩/索引漂移
    for (const l of resumeView.loads) {
      if (l.fallback !== undefined) {
        createLogger(sink, "session").warn("session.load.window-fallback", "窗口装载降级回退全量", { fallback: l.fallback, mode: l.path });
      }
    }
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
      sink: { warn: (code, msg, data) => createLogger(sink, "session").warn(code, msg, data ?? {}) },
    });
    resumeLoads = parentView.loads; // T11：fork 父链同窗口装载（分叉安全判据在 openSessionView 内层）
    baseStore = new ForkedSessionStore({
      parent: parentView.store,
      ...(options.fork.atEntryId !== undefined ? { atEntryId: options.fork.atEntryId } : {}),
      own: makeStore(),
    });
  } else {
    baseStore = makeStore();
  }
  const channel = new Channel<SessionEvent>(EVENTS_CHANNEL_CAP, () => {
    createLogger(sink, "kernel").warn("kernel.events.dropped", `events() 无订阅者且缓冲已满（上限 ${EVENTS_CHANNEL_CAP}）——最旧事件被丢弃，完整历史走 history()`); // 首次溢出留痕一次（后续照丢不再刷日志）
  });
  const treeIndexHolder: { index?: TreeIndex } = {}; // 会话树批 T9：树索引懒持有（首次 tree() 建实例——避免构造期碰 ~/.orosus/db/）
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

  // 窗口语义（M3 补强空白 §5 + 2026-09-29 兜底链）：核心顶层 contextWindow 显式值优先——正整数才生效，
  // 非法/≤0 忽略 + warn（三轮 P2：0 窗口会把阈值打成 0）；缺省/非法时按槽·模型查 models-dev 盘上缓存兜底
  // （sections 透传：裸槽名经 [provider-custom] defaultModel 解出真模型再查表——2026-10-08 修，详见
  //  resolveContextWindow 头注）
  const readContextWindow = (core: Record<string, unknown>, sections: Map<string, Record<string, unknown>>): number | undefined =>
    resolveContextWindow(core, {
      catalogFile: catalogCacheFile,
      sections,
      onIllegal: (raw) => createLogger(sink, "kernel").warn("kernel.config.contextwindow", `contextWindow 配置非法（${String(raw)}）——须为正整数，已忽略`),
    });
  let contextWindow = readContextWindow(config.core, config.sections);
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
        // CH-05 修复：entryHash 与 reload 侧（defs2 组装）同款透传——旧实现启动 defs 不带 hash，
        // 首次 /reload 因 undefined≠hash 把全部信任 local 模块误判 Reloaded（副作用重跑/内存态丢失）
        defs.push({ def: m.def, source: "local" as const, root: m.root, layer: m.layer, ...(m.entryHash !== undefined ? { entryHash: m.entryHash } : {}) }); // root/layer 透传（T7：failed 事件来源标识）
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
  // m5-media F2/F8：会话媒资库（<sid>/media/——spill 同层惯例，随桶清理）；显式注入优先（测试密封）
  const mediaDirUsed = options.mediaDir ?? join(sessionsDir, store.sessionId, "media");
  const llmHolder: { impl?: LlmPort } = {}; // D39/T4：loadModules 后装配——Unchanged 模块的旧闭包经同一 holder 读到新解析
  const i18nHolder: { t: NonNullable<import("./kernel/activate.ts").I18nHolder["t"]> } = { t: (key, params, fallback) => kernelT(key, params, fallback) }; // m5-i18n T2：宿主翻译口 holder（缺省地板；store 就绪后 setModuleT 替换——reload 沿用）
  // 会话树批 T6/T10：三缝内核半边提取为独立函数——harness 返回对象与 ctx.session 装配（loadModules
  // 转发）共用同一实现。graph 是 loadModules 的返回值、闭包捕获 let 变量（调用期读最新值）——activate
  // 期调 fork 会拿 undefined，与 llm「运行期调」同纪律（activate 期 provider 可能未装配同款）。
  const sessionForkFn = async (forkOpts?: { atEntryId?: string }): Promise<{ sessionId: string }> => {
    // T10（m5-resume-perf）：分叉点校验按全量投影语义——窗外 atEntryId 合法（「分叉点不在当前投影内」
    // 的语义 = 全量投影语义，窗口是读路径优化不缩小分叉面）
    if (store.ensureFull !== undefined) await store.ensureFull();
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
  };
  const treeFn = (): Promise<import("@orosus/contracts/module").SessionTreeNode[]> => {
    treeIndexHolder.index ??= new TreeIndex({ file: options.treeIndexFile ?? join(orosusHome(), "db", "session-tree.sqlite") });
    return treeIndexHolder.index.refresh(options.sessionsRoot ?? dirname(sessionsDir), { bucket: basename(sessionsDir) });
  };
  // M4.5 子代理批 T1：内核派单执行口（开子会话 + 跑循环 + 取结论）——deps 全闭包引用（graph/config
  // 是 let、resolve* 是后置 const——调用期读最新值，与 sessionForkFn 同纪律）
  // M4.5 T9 送回回调：后台单子收场 → 积压行 + 闲时自动开送回轮（忙时由主 turn 停止边界收）
  const pushDelivery = (line: string): void => {
    deliveryBacklog.push(line);
    deliverSubagentTurn();
  };
  const subagentRunner = createSubagentRunner({
    mainStore: store,
    sessionsDir,
    sink,
    cwd: options.cwd ?? process.cwd(),
    makeStore: (sid, dir) => makeStore(sid, dir, { load: "full" }), // T11：子代理 store 恒全量——文件受双保险丝天然有界，不窗口化（风险节钦点）
    graph: () => graph,
    configSections: () => config.sections,
    resolveParentModel: () => resolveProvider(),
    resolveModel: (v) => resolveModelValue(v),
    onBackgroundDelivery: pushDelivery,
    resolveEffort: () => resolveEffortForWire(), // M4.5：子代理跟随 /effort 档（agent 组 <思考> 段）
  });
  // CH-01 修复（2026-09-28 code review P1）：装配中段失败零清理——loadModules 抛 / 激活后 store.all() 读到
  // 坏行抛时，store 句柄（sqlite 已开库）、已激活模块（含 MCP 子进程）、diag sink 全悬空到进程死。
  // 镜像 close() 序列对「构造期已存在的件」best-effort 拆除后原样上抛（清理失败不掩盖原始异常）。
  const cleanupStartup = async (g: { dispose(): Promise<void> } | undefined): Promise<void> => {
    try {
      if (g !== undefined) await g.dispose();
      await store.close();
      live.close();
      await sink.flush();
      await sink.close();
      channel.close();
    } catch { /* 清理失败不掩盖原始装配异常 */ }
  };
  let graph = await (async () => {
    try {
      return await loadModules({
        defs,
        cli: cliInput,
        sections: config.sections,
        session: sessionGuarded, // header 兜底面——模块事件先于首个 turn 落盘时先补 header（断头文件实证修复）
        sink,
        spillDir: spillDirUsed,
        mediaDir: mediaDirUsed, // m5-media F2：媒资库注入（reload 新图同款）
        cwd: options.cwd ?? process.cwd(),
        commandUi,
        llm: llmHolder,
        i18n: i18nHolder,
        sessionForkOut: sessionForkFn, // 会话树批 T10：ctx.session.fork 装配（mounts "session.fork" 门）
        treeOut: treeFn,               // 会话树批 T10：ctx.session.tree 装配（只读无门）
        subagent: subagentRunner,      // M4.5 子代理批：ctx.subagent 装配（mounts "subagent" 门）
        ...(options.settings !== undefined ? { settings: options.settings } : {}), // m5 T9：设置服务写面（ctx.settings 装配）
        ...(options.host !== undefined ? { host: options.host } : {}),               // m5 T9：宿主状态读面（ctx.host 直挂）
        ...(options.sessionSwitch !== undefined ? { sessionSwitch: options.sessionSwitch } : {}), // 会话树批 T10/T11：宿主切换缝
        ...(blocked.length > 0 ? { blocked } : {}),
      });
    } catch (err) {
      await cleanupStartup(undefined); // 图未成（required 失败时 kernel 已自行 disposeAll——这里补 store/sink 面）
      throw err;
    }
  })();

  // steering 宿主口（2026-09-23 消息队列批）：backlog 挂 collect 链——steering 在每个 step 首排空，
  // followUp 在停止边界兜底（错过窗口的消息仍进本 turn，不丢）。reload 复用同一 bus（reuse），
  // WeakSet 防重注册；owner 记 "host"（非模块——宿主直挂核心口）
  const steerBacklog: { text: string; sourceModule: string }[] = [];
  const steerHooked = new WeakSet<object>();
  const ensureSteerHook = (bus: EventBus): void => {
    if (steerHooked.has(bus)) return;
    steerHooked.add(bus);
    const drain = (): { text: string; sourceModule: string }[] => steerBacklog.splice(0);
    bus.on(CORE_POINTS.steering, drain, "host");
    bus.on(CORE_POINTS.followUp, drain, "host");
  };
  ensureSteerHook(graph.bus);

  // 日期系统行（m4-6 T7，kimi/cc/qwen 缓存友好派）：核心节去 date 后模型仍需知道今天几号——轮首比对，
  // 首轮或跨日往宿主 steering backlog 推一行（每步首排空、先落 session 再投影——消息位不伤请求前缀缓存；
  // host/date 源顺带获得压缩保留语义）。同日不重复；子代理侧不走这里（它的提示词 spawn 时自带定格 date）。
  // sourceModule 用独立 "host/date"（非 "host"）：宿主注入的系统行 ≠ 用户 steer——回放渲染与输入召回
  // 历史据此跳过（2026-09-28 修复：resume 回放曾把它当用户块显示）；压缩保留谓词两值同认。
  const dateSource = options.dateSource ?? ((): Date => new Date());
  let lastSteeredDate: string | undefined;
  const maybeSteerDateLine = (): void => {
    const today = dateSource().toISOString().slice(0, 10);
    if (today !== lastSteeredDate) {
      lastSteeredDate = today;
      steerBacklog.push({ text: `[非用户输入] 系统提醒：今天是 ${today}。`, sourceModule: "host/date" });
    }
  };

  // 主对话写预约（M4.5 T7 / 决策 24②尾）：主对话自己要写文件时对子代理写报备做同样检查——
  // 不占子代理的并发位，撞了立即让那一步失败重试而不是干等。子代理转发的载荷不进此门（它的报备已占闸）。
  graph.bus.on(CORE_POINTS.toolPreExecute, async (payload) => {
    const p = payload as { accesses?: { kind: string; path?: string }[]; subagent?: unknown };
    if (p.subagent !== undefined) return undefined;
    const accesses = p.accesses ?? [];
    const writes = accesses.filter((a): a is { kind: string; path: string } => a.kind === "fs.write" && typeof a.path === "string").map((a) => a.path);
    // CX-09 修复（2026-09-28 code review P1）：subprocess / all = 不透明执行（bash 无法预知会写哪）——
    // 按整仓过闸，与子代理侧「bash 一律算写整仓」（runner WRITE_CAPABLE_TOOLS）对称；旧实现只过滤
    // fs.write，主对话 npm install / git checkout . 与子代理写报备零检查并发。checkMainWrite 空数组
    // 即整仓语义（writegate rawPaths.length === 0 → wholeRepo）；只读 accesses（fs.read/network/空）不进闸
    const opaque = accesses.some((a) => a.kind === "subprocess" || a.kind === "all");
    if (writes.length === 0 && !opaque) return undefined;
    const chk = subagentRunner.gate.checkMainWrite(opaque ? [] : writes);
    return chk.ok ? undefined : { deny: true, reason: chk.error };
  }, "host");

  // header 懒写（M4-1 T0/D46 止血）：构造期零落盘——临时会话（CLI 启动即退 / --dump-modules / 引导后未聊）
  // 不再各留一个空壳文件（走查垃圾场 1147 文件的主源头）。首次真实 turn 前补写（命令派发不触发——
  // onboarding 的 /provider、/reload 不落盘），保持 §6.1「文件首行 = session/header」不变量；
  // resume 的既有文件已带 header（不重复落）；模块图摘要取写入时刻的图（onboarding 在首聊前 /reload，
  // 捕获的是会话真正开工时的图——比构造期快照更真）。fork 的 sourceEntryId 仍在 fork 时刻取父尾（语义不变）。
  let existingEvents = await (async () => {
    try {
      return await store.all();
    } catch (err) {
      // CH-01：激活成功后读侧炸（jsonl 坏行 JSON.parse / sqlite 坏库）——模块已激活（含 MCP 子进程），
      // 旧实现全部悬空。拆图 + store/sink 面后原样上抛。
      await cleanupStartup(graph);
      throw err;
    }
  })();
  let headerPending = options.resume === undefined || existingEvents.length === 0;
  // T10（m5-resume-perf）：启动 fork 显式 atEntryId 落在窗口头之前时（父压缩点早于分叉点）先全量升级
  // ——ForkedSessionStore 的切片校验按全量投影语义；existingEvents 随升级重读（捕获的是旧数组引用）
  if (options.fork?.atEntryId !== undefined && !existingEvents.some((e) => e.id === options.fork!.atEntryId)
      && options.fork.atEntryId !== (existingEvents[existingEvents.length - 1]?.id)) {
    if (store.ensureFull !== undefined) await store.ensureFull();
    existingEvents = await store.all();
  }
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

  // 会话起点广播（m5-hooks T3）：session/start emit（不可阻断；SessionStart 钩子位）。source 三态——
  // fork 在上方落位点发，此处只发 startup/resume。transcript_path = 主文件推导路径：CLI 装配恒传桶目录
  //（options.sessionsDir = sessionsRoot/<encodeCwd(cwd)>，resume 也传定位桶），core 缺省口径同构——
  // 模块侧缓存此值（ctx.session 无路径口，T0-② 取证）。
  const sessionStartEmit = (source: "startup" | "resume" | "fork"): Promise<void> => {
    const backendFile = String(config.core.sessionStore ?? "jsonl") === "sqlite" ? "session.sqlite" : "session.jsonl";
    return graph.bus.emit("session/start", {
      source,
      session_id: store.sessionId,
      transcript_path: join(sessionsDir, store.sessionId, "agents", backendFile),
      cwd: options.cwd ?? process.cwd(),
    });
  };
  if (options.fork !== undefined) await sessionStartEmit("fork");
  else await sessionStartEmit(options.resume !== undefined ? "resume" : "startup");

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
  // 读侧自修复 pass（§6.1/D41）：resume/fork 打开既有历史时做链校验（根分段——复合投影零误报），问题逐条进诊断。
  // 模型/档位随会话恢复（2026-10-03 用户拍板「不同会话模型/effort 不一样，这两个信息随会话记」）：
  // turn/start 每 turn 落 model（effort 同日起带值才落）——尾部最后一条 = 本会话最后用的组合。
  // /model /effort 的写盘是全局 user config（语义 = 「以后新会话的默认」，最后设置者赢）——不恢复则
  // 本会话身份会被其他会话的切换顶掉（A 用 X/high → B 切 Y/low → 回 A 成 Y/low）。恢复只占内存
  // override、不回写全局盘（新会话默认语义不动）、不走换模型的档位重解析（恢复的组合当时一起用过，
  // 天然有效）。provider 已删即整个组合回退 config（见下方判定注——2026-10-03 二次拍板推翻首轮
  // 「lenient 保留报错自证」口径）。fork 同吃：ForkedSessionStore.all() 截到分叉点，恢复的
  // 恰是分叉点组合。老会话 effort 字段缺席 = 只恢复模型；无 turn/start（空会话）= 零恢复。
  // model provider 在图判定（统一口径）：parseModel 取 provider 段（全形 "p/m" → "p"；裸名 → 自身）
  // 查 services.provider（与 resolveModelValue 同一解析路径；graph.records 的 r.name 是模块名
  // 〔provider-fake〕不是 slot 名 fake）。不通过 = 两类场景一并放弃恢复（2026-10-03 用户拍板「提供商
  // 被删除 → 用 config 默认模型，effort 同理」——组合整体回退，不 lenient 硬留等请求期报错）：
  // ① 恢复模型的 provider 模块已删/停用；② 2026-10-03 前老会话落的是剥掉 provider 的裸模型名
  // （请求线缆口径，塞 override 会被 parseModel 当 provider 名解析、请求必炸——实测
  // 「provider "m" 不可用」）。放弃 = 模型+档位都跟全局 config（拍板前行为，无回归）。
  let resumedRunState: { model: string; effort?: string } | undefined;
  if (options.resume !== undefined || options.fork !== undefined) {
    const resumedEvents = await store.all();
    // T11：窗口装载的接缝豁免（T5 口）——链上任一层窗口化则每段允许一处种子→窗口接缝
    for (const issue of verifyChain(resumedEvents, { windowedHead: resumeLoads.some((l) => l.mode === "window") })) {
      createLogger(sink, "session").warn("session.chain.issue", issue);
    }
    const lastTurnStart = [...resumedEvents].reverse().find((e) => e.type === "turn/start");
    if (
      lastTurnStart !== undefined && typeof lastTurnStart.model === "string" && lastTurnStart.model !== "" &&
      graph.services.provider(parseModel(lastTurnStart.model).provider) !== undefined
    ) {
      resumedRunState = { model: lastTurnStart.model };
      if (typeof lastTurnStart.effort === "string" && lastTurnStart.effort !== "") resumedRunState.effort = lastTurnStart.effort;
    }
  }

  let currentTurn: { controller: AbortController; done: Promise<void>; internal?: boolean } | null = null;
  let closed = false;
  // reload 互斥（CK-06/CH-09 修复，2026-09-28 code review P1）：in-flight promise——并发 reload 折叠为
  // 同一次执行（双跑会在共享 bus/tools 上双激活 + 监听器双挂 + 工具注册冲突降级）；prompt 起 turn 前
  // 与后台送回轮同以它排队（quiesce 只排水不关门——reload 进行中的新 prompt 不再吃墓碑/中途换图）
  let reloadInFlight: Promise<ReloadReport> | undefined;
  let modelOverride: string | undefined = resumedRunState?.model; // /model 运行期覆盖（D38：会话内存态不落盘）；resume/fork 初始 = 会话尾部恢复值（2026-10-03 拍板，提取见上方 resumedRunState）——status/请求链经 resolveProvider 的 override 优先天然生效，不回写全局盘
  let effortOverride: string | undefined = resumedRunState?.effort; // /effort 运行期覆盖（/model 同款双轨：会话内存 + 写盘）；未设 = 跟随配置，配置也没有 = 目录默认档（kimi「从不不指定」——effort 型模型恒有解析值）；resume/fork 初始 = 会话尾部恢复值（同上）

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
    atomicWriteTextSync(userConfigFile, after); // CH-08：tmp+rename 原子写（崩溃不留半截文件——SW-20 兜底是跳过整层，代价太大）
  };

  // ---- /model //effort 核心动作（m5 T9 抽共用）：命令与设置服务（ctx.settings）同源——单一写者，不双写 ----

  /** /model 核心：覆盖槽 + 写盘 + 档位跟随重解析（2026-09-25 二轮 kimi draftFor 对齐）。 */
  const applyModelOverride = async (next: string): Promise<void> => {
    const prevModelValue = modelOverride ?? (typeof cfgModelValue() === "string" ? (cfgModelValue() as string) : undefined);
    modelOverride = next;
    // 持久化（2026-09-22 用户拍板）：选定即写盘永久生效。行级写 user config 顶层 provider 键
    // （无 TOML 库；不复用 provider-custom setModel——模块层装配闭包，core↮模块违铁律 3）
    // F5 十轮：键名 provider（值保留 slot/model 全形）；旧 model 行随过滤清除
    // CH-08：tomlBasicString 写侧转义（next 可能是端点清单/手输的任意文本）
    upsertTopLevelKey(/^\s*(model|provider)\s*=/, { line: `provider = ${tomlBasicString(next)}` });
    // 窗口跟随换模型（2026-10-09 用户拍板①）：/model 不走 reload——contextWindow 闭包会停在旧模型的
    // 窗口直到重启。此刻按新值重解析（条目级 > 目录；fake-core 形态 { provider: next } 绕开顶层旧钉值
    // ——那是对旧模型的描述）；查到 → 内存 + 顶层键同步落盘（重启一致，import 链同落点）；查不到 →
    // 不动（私有模型的手钉 contextWindow / 无目录数据场景保留原值）。仅实际变更时执行（重选同模型
    // 不覆盖手钉值——与下方 effort 跟随同判据）。
    if (next !== prevModelValue) {
      const w = resolveContextWindow({ provider: next }, { catalogFile: catalogCacheFile, sections: config.sections });
      if (w !== undefined && w !== contextWindow) {
        contextWindow = w;
        upsertTopLevelKey(/^\s*contextWindow\s*=/, { line: `contextWindow = ${w}` });
      }
    }
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
        upsertTopLevelKey(/^\s*effort\s*=/, { line: `effort = ${tomlBasicString(reEffort)}` }); // CH-08：目录数据同走转义
      }
    }
  };

  /** /effort 核心：覆盖 + 写盘；"auto" = 清覆盖清盘行回目录默认。非法档名抛错（设置服务同规）。 */
  const applyEffortOverride = (level: string): void => {
    if (!/^[a-z0-9._-]+$/.test(level)) throw new Error(`档位名 "${level}" 不合法（仅限字母数字与 . _ -）`);
    if (level === "auto") {
      effortOverride = undefined;
      upsertTopLevelKey(/^\s*effort\s*=/);
      // CH-03：内存快照同步清——cfgEffortValue 读的是启动/reload 固化的 config.core.effort；
      // 不清则配置层来源的档位在 auto 后仍滞留（「回目录默认档」静默失效）
      delete config.core.effort;
    } else {
      effortOverride = level;
      upsertTopLevelKey(/^\s*effort\s*=/, { line: `effort = ${tomlBasicString(level)}` }); // level 有正则闸（上方），转义兜底统一出口
      config.core.effort = level; // CH-03：双轨一致（盘上与内存快照同值）
    }
  };

  // m5-i18n T3：语言切换核心动作（/locale 与 SettingsService 同源——单一写者）
  const applyLanguageOverride = async (tag: string): Promise<void> => {
    upsertTopLevelKey(/^\s*language\s*=/, { line: `language = ${tomlBasicString(tag)}` });
    setKernelLocale(tag); // core 自渲染面（failReason 族）跟随新语言——旧账保持原语言（D5）
  };

  // 内建别名表（D38）：短名 → 模块命令名；目标不存在提示安装对应模块
  const COMMAND_ALIASES: Record<string, string> = {
    provider: "provider-custom__provider",
    permission: "approval__permission", // M3 随审批模块落地
    compact: "compaction__compact",    // M3 补强 T8 runbook 走查发现：M3 起短名从未路由（注册名是全名）——补齐
    yolo: "approval__yolo",            // 2026-09-26 拍板 D2、2026-09-28 落地：一键需要时候询问（ask-risky，与 /auto 交叉互换）
    auto: "approval__auto",            // 2026-09-26 拍板 D1、2026-09-28 落地：一键从不询问（never，kimi auto 语义）
  };

  const builtinCommands = new Map<string, (args: string) => Promise<string>>([
    ["/model", async () => {
      const slots = graph.services.listProviders();
      // 一级只列带默认模型的槽——顶级「手动输入全名」入口已砍（2026-09-20 用户实测：没有用）；
      // 手输仍可达于槽内端点清单末位「手动输入…」，且槽语境裸名自动补 <slot>/ 前缀（原顶级手输的
      // 走查缺陷②逻辑内移——槽已选定，多槽歧义报错随之消失）
      const candidates = slots.filter((x) => x.defaultModel !== undefined);
      if (candidates.length === 0) return "无可切换的平台——先用 /provider 添加平台（含默认模型）";
      // 两段选循环（2026-09-28 用户拍板「子菜单 Esc 返回上一级」）：模型列表 Esc → 回平台列表；
      // 平台列表（根）的 Esc 照旧穿透——整条取消。单槽直达（F5 用户实测：只有一个平台时还问
      // 「选哪个」是废问——/model 语义是换模型不是换平台）：无上级可回，模型列表 Esc 同样穿透取消
      // （2026-10-01 批 E 修正：原「Esc 后直接重列模型」在单槽下是死循环——见下方 catch 注释）
      for (;;) {
        const slotName = candidates.length === 1
          ? candidates[0]!.name
          : (await commandUi.choose("选择平台", candidates.map((x) => `${x.name}（默认 ${x.defaultModel}，裸名即用）`))).split("（")[0]!;
        let next = slotName;
        let sideEffort: string | undefined; // 同窗横选档位（2026-10-09）：本轮选定档——applyModelOverride 后落位
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
            // 全名取首斜杠后模型段比对；裸槽名值经槽 defaultModel 解析（面板同口径）
            const curRaw = modelOverride ?? (typeof cfgModelValue() === "string" && cfgModelValue() !== "" ? (cfgModelValue() as string) : undefined);
            // CT-02（2026-09-28 code review P3）：模型段切分改首斜杠（indexOf("/") 前段 = 槽名、其余整体 = 模型 id，
            // 与 contracts CT-02 新口径、parseModel 同口径）——嵌套 id deepseek/openai/gpt 旧取尾段 .pop() 得 "gpt"，
            // 与清单项 "openai/gpt" 永不相等，勾标永不点亮
            const curBare = curRaw === undefined ? undefined
              : curRaw.includes("/") ? curRaw.slice(curRaw.indexOf("/") + 1)
              : curRaw === slotName ? slot.defaultModel
              : curRaw;
            // 思考档位预取（2026-10-09 用户拍板：选模型同窗选档——kimi 形态 Orosus 样式）：清单全模型并查
            // 目录（thinkingInfoOf memoized 盘读毫秒级）；无档模型 valuesOf → undefined（行降级「——」）。
            // 全清单无一家有档 = 不起横选面（老 choose 零变化——宿主无 chooseSide 口同路）
            const effortsByModel = new Map<string, string[]>();
            await Promise.all(models.map(async (m) => {
              const info = await thinkingInfoOf(slotName, m);
              if (info !== undefined) effortsByModel.set(m, segmentsOf(info));
            }));
            const dispItems = models.map((m) => (m === curBare ? `${m} ✓` : m));
            let mpick: string;
            try {
              if (commandUi.chooseSide !== undefined && effortsByModel.size > 0) {
                // 初值口径（/effort 跟随链同源）：已设档在清单内 = 沿用（「设置过就尊重」）；未设/不在 = 该模型
                // 目录默认档（middleOf 中位——defaultEffortOf 同式）
                const storedEffort = effortOverride ?? cfgEffortValue();
                const r = await commandUi.chooseSide(`选择模型（${slotName}）`, dispItems, {
                  side: {
                    label: "思考档位",
                    valuesOf: (it) => effortsByModel.get(it.replace(/ ✓$/, "")),
                    initialOf: (it) => {
                      const segs = effortsByModel.get(it.replace(/ ✓$/, ""));
                      if (segs === undefined) return undefined;
                      if (storedEffort !== undefined && segs.includes(storedEffort)) return storedEffort;
                      return segs[Math.floor(segs.length / 2)] ?? segs[0];
                    },
                  },
                });
                mpick = r.item;
                sideEffort = r.value; // undefined = 项无档/宿主降级——档位跟随模型解析不动
              } else {
                mpick = await commandUi.choose(`选择模型（${slotName}）`, dispItems);
              }
            } catch (err) {
              // Esc → 回平台列表（2026-09-28 拍板「子菜单 Esc 返回上一级」）。单槽直达时模型清单即根——
              // 无上级可回，Esc 穿透取消（2026-10-01 批 E 修正：原无条件 continue 在单槽下无限重列——
              // 真人 UI 菜单关不掉，测试假 UI 瞬抛成纯微任务自旋〔100% CPU、免疫 testTimeout 与 worker
              // 强杀〕→ harness.test 全量套件永不退，两小时挂树实锤）
              if (err instanceof Error && err.message === "已取消（Esc）" && candidates.length > 1) continue;
              throw err;
            }
            next = `${slotName}/${mpick.replace(/ ✓$/, "")}`;
          }
        }
        // 批①：busy 期可执行、下一轮生效——主 turn 的 provider/model 在 prompt 开头一次性捕获（下方 resolveProvider），
        // 中途覆盖本轮无感。已知接受的泄漏面：ctx.llm 调用时解析（turn 内 compaction 二级调用会吃新模型）。
        await applyModelOverride(next); // m5 T9：核心动作抽共用——命令与设置服务同源（不双写）
        // 同窗横选档位落位（2026-10-09）：显式选定（≠ 换模型后的有效档）才写——applyEffortOverride 双轨
        //（内存 + 盘，/effort 同源出口）；值恒为横选所示（Enter 未动 = 初值 = 已设档或该模型默认）
        if (sideEffort !== undefined) {
          const nowEffort = await resolveStoredEffort();
          if (sideEffort !== nowEffort) applyEffortOverride(sideEffort);
        }
        return "";
      }
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
  // m5-i18n T3：核心顶层 language 键读口（未设置 = undefined → 宿主系统检测缺省）
  const cfgLanguageValue = (): string | undefined => {
    const v = config.core.language;
    return typeof v === "string" && v !== "" ? v : undefined;
  };
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
      // 裸名报错须列出可用 provider 及各自 defaultModel（计划补空白登记项）。
      // 2026-10-07 修：旧版遍历 graph.records（模块记录）——列出的是 approval/compaction 等模块名而非
      // provider 槽，用户实机裸名报错收到一墙模块名；改遍历 listProviders() 槽清单（name+defaultModel）
      const listing = graph.services
        .listProviders()
        .map((s) => (s.defaultModel !== undefined ? `${s.name}（默认 ${s.defaultModel}）` : `${s.name}（无默认，需写全名）`))
        .join("、") || "（无）";
      throw new Error(`provider "${provider}" 未声明 defaultModel——请写全名 "<provider>/<model>"。可用 provider：${listing}`);
    }
    return { stream: adapter.stream, model };
  };
  // modelValue = 解析前的全形（provider/model 或裸 provider 名）——2026-10-03 起随返回值带出：
  // driveTurn 落 turn/start 用全形（模型随会话恢复链，见 loop.ts modelFull 注）
  const resolveProvider = (): { stream: StreamFn; model: string; modelValue: string } => {
    const modelValue = modelOverride ?? cfgModelValue();
    if (typeof modelValue !== "string" || modelValue === "") {
      throw new Error(`未配置 model（核心顶层 key，格式 <provider>/<model> 或裸 <provider>，§6.6/D32）——请在 config.toml 或 CLI 指定`);
    }
    return { ...resolveModelValue(modelValue), modelValue };
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

  // ---- M4.5 T9：后台子代理结论送回（决策 17——followUp 缝 + 忙时排队 + 闲时自动续跑） ----
  // 送回积压：忙时由主 turn 停止边界经 bus followUp collect 注入（Goal 续跑同缝）；闲时自动开一轮
  // 无用户消息的「送回轮」消费（loop 首 step 的 steering collect 收积压 → 注入 → 模型接话）。
  // 送回行 sourceModule = "tool-subagent"——渲染层据此走灰色系统行（非用户块），行文带 [非用户输入] 头防伪装。
  const deliveryBacklog: string[] = [];
  const deliveryDrain = (): { text: string; sourceModule: string }[] =>
    deliveryBacklog.splice(0).map((text) => ({ text, sourceModule: "tool-subagent" }));
  const deliveryHooked = new WeakSet<object>();
  const hookDelivery = (bus: EventBus): void => {
    if (deliveryHooked.has(bus)) return;
    deliveryHooked.add(bus);
    bus.on(CORE_POINTS.followUp, deliveryDrain, "host");
  };
  hookDelivery(graph.bus);

  /** 共通 turn 驱动（M4.5 T9 从 prompt 抽出）：usage 锚点/档位捕获/事件循环同款——用户轮与送回轮共用。 */
  const driveTurn = async (controller: AbortController): Promise<SessionEvent | undefined> => {
    maybeSteerDateLine(); // 日期系统行（m4-6 T7）：本轮首步 steering 排空时进请求
    const { stream, model, modelValue } = resolveProvider();
    // 思考档位（/effort）：turn 开头一次性捕获（/model 同款——busy 期切档下一轮生效）
    const effort = await resolveEffortForWire();
    // usage 锚点（补强 T3/空白 §4）：包装主循环 stream 记录最近一次真实用量——loop 骨架仍不消费 usage
    const trackedStream: StreamFn = (req) => (async function* () {
      for await (const c of stream(req)) {
        if (c.type === "usage") usageAnchor = { totalTokens: c.input + c.output, atMessageCount: req.messages.length };
        yield c;
      }
    })();
    let lastTurnEvent: SessionEvent | undefined;
    for await (const e of agentLoop({
      session: store, bus: graph.bus, tools: graph.tools,
      provider: trackedStream, model, system: graph.promptSections(),
      modelFull: modelValue, // turn/start 落全形（2026-10-03 模型随会话恢复——裸名恢复会被当 provider 名解析炸请求）
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
      signal: controller.signal, sink,
      livePush: (c) => live.push(c), // 双投并存（T4/D45）：旁路投递——T5 断流后仅旁路
    })) {
      lastTurnEvent = e; // 事件经 forwardingStore 在 append 时即转发，此处仅驱动迭代
    }
    return lastTurnEvent;
  };

  // CH-12②（2026-09-28 code review）：等待内部轮/reload 的用户 prompt 计数 + 宏任务补触发。旧实现
  // 送回轮 finally 里同步再占坑——后台子代理密集完成（或送回反复失败）时，等待中的用户 prompt 要
  // 串行等完每一轮送回（失败链上永不轮到）。现双管：①有等待者即让位（积压不丢——由用户轮停止边界
  // 的 followUp collect 收口，与「忙时由主 turn 停止边界收」同路径）；②补触发走 setTimeout(0) 宏任务
  //（失败链旧形态是纯微任务自旋——送回轮反复失败时事件循环被饿死，等待中的 prompt 永远进不了守卫）。
  let waitingUserPrompts = 0;
  const retryDelivery = (): void => {
    if (waitingUserPrompts > 0) return; // 有 prompt 在等——不抢坑
    setTimeout(() => { if (!closed) deliverSubagentTurn(); }, 0);
  };

  /** 闲时送回轮（决策 17 自动送回）：无用户消息自动续跑；用户轮进行中让位（忙时由其停止边界收）。 */
  const deliverSubagentTurn = (): void => {
    // CH-09：reload 进行中不让路给送回轮（同 turn 排队——收尾由 reload 的 finally 补触发）
    if (closed || reloadInFlight !== undefined || currentTurn !== null || deliveryBacklog.length === 0) return;
    const controller = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    currentTurn = { controller, done, internal: true };
    void (async () => {
      try {
        await ensureHeader();
        await driveTurn(controller);
      } catch (err) {
        // CH-12①（2026-09-28 code review）：旧实现空 catch 零留痕——积压已消费但落盘/模型调用失败
        //（盘满/断网/配额）时送回无声丢失（花名册有记录、对话面永远缺这条送回）。补 diag warn；
        // 「不抛出」语义保持（下一条用户消息照常），未消费积压由 finally 的补触发重试。
        createLogger(sink, "kernel").warn("kernel.subagent.delivery-failed", "后台子代理结论送回轮失败——未消费积压保留待重试", { error: err instanceof Error ? err.message : String(err) });
      }
      finally {
        currentTurn = null;
        settle();
        if (deliveryBacklog.length > 0) retryDelivery(); // 排队中的下一批（CH-12②：有等待者让位 + 宏任务）
      }
    })();
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
        // 命令词忽略大小写（2026-09-27 用户走查拍板）：正则收 A-Z、name 归一小写后查表——
        // 参数部分原样（/title 名字 不大写化）
        const m = /^\/([a-zA-Z0-9][a-zA-Z0-9-]*(?:__[a-zA-Z0-9-]+)?)(?:\s([\s\S]*))?$/.exec(cmdText);
        const name = m?.[1]?.toLowerCase();
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
      // 送回轮让路（M4.5 T9）：内部送回轮进行中 = 等它收尾紧接进（不打断打字）；用户轮进行中照旧抛。
      // CH-09 ②：reload 进行中同锁排队——起 turn 前等它收尾（循环重查而非一次性 await：并发等待者
      // 依次醒来后须重新过单并发守卫，否则会越过先醒者直接覆盖 currentTurn 占坑）
      // CH-12②：等待期间计数（waitingUserPrompts）——送回轮收尾的补触发据此让位：等待有界（最多
      // 等完当前这轮送回），积压不丢（本 turn 停止边界 followUp collect 收口）
      for (;;) {
        if (currentTurn !== null) {
          if (currentTurn.internal !== true) throw new Error("已有进行中的 turn（M1 单并发；取消请调 cancel()）");
          waitingUserPrompts++;
          try { await currentTurn.done.catch(() => undefined); } finally { waitingUserPrompts--; }
          continue;
        }
        if (reloadInFlight !== undefined) {
          waitingUserPrompts++;
          try { await reloadInFlight.catch(() => undefined); } finally { waitingUserPrompts--; }
          continue;
        }
        break;
      }
      const controller = new AbortController();
      let settle!: () => void;
      const done = new Promise<void>((resolve) => { settle = resolve; });
      // 同步占坑再 await：否则并发 prompt 会在首个 await 前双双通过守卫（TOCTOU），
      // close()/cancel() 在窗口期也拿不到真句柄。deferred done 让 close() 任何时刻等到的都是同一个 promise
      currentTurn = { controller, done };
      try {
        // 提交门（m5-hooks T2）：user/prompt-submit waterfall——用户消息落日志之前的 UserPromptSubmit 钩子位。
        // 占坑之后首个 await（守卫与占坑间零 await 窗口，TOCTOU 注释钉死勿前移）；deny 走带因 throw——
        // catch 路无条件 settle（「消息被拒」≠「turn 取消」，文案与 AbortError 区分，CLI 按 message 显示拦截理由）；
        // contextNotes 逐条进 steering backlog（sourceModule host/hook——仿 host/date：召回跳过/压缩保留）。
        const promptPayload: { text: string; images?: string[]; contextNotes: string[] } = {
          text,
          ...(opts?.images !== undefined && opts.images.length > 0 ? { images: opts.images } : {}),
          contextNotes: [],
        };
        const promptVeto = await graph.bus.waterfall(CORE_POINTS.promptSubmit, promptPayload);
        if (promptVeto) throw new Error(promptVeto.reason); // 模块侧已组完整文案（T11 钩子名+原文摘要）——宿主不再叠前缀
        await graph.bus.emit(CORE_POINTS.uiCommand, { kind: "prompt", text });
        await ensureHeader(); // 首个持久事件前补 header（T0 懒写——命令派发已在上方原路返回，不会触发）
        // user/message content 构造（M4-2.5 T5）：text part 在前、image part 引用形态在后（日志只存路径）
        const content: ContentPart[] = [
          ...(text !== "" ? [{ kind: "text", text } as const] : []),
          ...(opts?.images ?? []).map((p) => ({ kind: "image" as const, path: p, mimeType: imageMimeOf(p) })),
        ];
        await store.append(LOG_TYPES.userMessage, { content: content.length > 0 ? content : [{ kind: "text", text: "" }] });
        for (const note of promptPayload.contextNotes) {
          steerBacklog.push({ text: note, sourceModule: "host/hook" }); // 钩子注入走旁路（不伪装用户输入），下个 step 首排空
        }
        // 宿主旁注（m5-media F14 走查四）：紧随 user/message 落盘——行序保障见接口注释；
        // 数组形态按序逐条（2026-10-03 输入召回批）
        if (opts?.afterUserEvent !== undefined) {
          for (const hostNote of Array.isArray(opts.afterUserEvent) ? opts.afterUserEvent : [opts.afterUserEvent]) {
            await store.append(hostNote.type, hostNote.fields);
          }
        }
        try {
        // turn 机械（M4.5 T9 抽 driveTurn 共用——用户轮与送回轮同款 usage 锚点/档位/事件循环）
        const lastTurnEvent = await driveTurn(controller);
        // 会话自动标题（M4-2 B9 用户拉前，2026-09-19 走查）：首轮问答完成后总结短标题落 session/label
        // （M3/T6 预留类型首次消费）；LLM 失败兜底 = 首问截断。宿主显式 opt-in（核心缺省关）。
        if (options.autoTitle === true && lastTurnEvent?.type === "turn/end" && (lastTurnEvent as { kind?: string }).kind === "completed") {
          await maybeTitle();
        }
        } finally {
          currentTurn = null;
          settle();
          // M4.5 T9 竞态兜底：送回若落在「停止边界已收过、currentTurn 未清」的窗口里进来，此处补触发
          if (deliveryBacklog.length > 0) deliverSubagentTurn();
        }
      } catch (err) {
        currentTurn = null;
        settle();
        if (deliveryBacklog.length > 0) deliverSubagentTurn();
        throw err;
      }
    },

    cancel() {
      currentTurn?.controller.abort();
    },

    steer(text) {
      if (!currentTurn) return false; // 无进行中 turn——调用方回退排队/直接提交
      steerBacklog.push({ text, sourceModule: "host" }); // 用户插队 = host 源（压缩保留 + 回放按用户块回显）
      return true;
    },

    events() {
      return channel.iterate();
    },

    history() {
      return store.all(); // 内存镜像（含未 drain 的 buffer）——与投影同源
    },

    // T10（m5-resume-perf）：窗口镜像懒升级读口——D4 全量消费兜底（store 缺省不带 = noop）
    async ensureHistoryFull() {
      if (store.ensureFull !== undefined) await store.ensureFull();
    },

    // T14（m5-resume-perf）：懒分页取段——事件索引查段 + pread 逐行 parse（纯查看，不动镜像）
    async eventsBefore(sessionId: string, beforeSeq: number, limitEvents = 500): Promise<SessionEvent[]> {
      if (baseStore instanceof ForkedSessionStore || !sqliteAvailable()) return []; // fork 复合视图：前缀在祖辈文件，本口恒空
      const file = join(sessionsDir, sessionId, "agents", "session.jsonl");
      // 索引新鲜度追平（2026-10-05 走查问答修）：活会话持续追加后索引落后——翻页锚可能落在未索引
      // 区间（轮次滑窗裁掉的新轮），查旧索引会跳段取更旧内容。mtime+size 双判命中零成本跳过、
      // 落后增量追平（D14「随用随补」的翻页时机形态；失败走下方查空的 ③ 单会话补建兜底）。
      try {
        const st = statSync(file);
        await refreshEventIndex(eventIndexFile, options.sessionsRoot ?? dirname(sessionsDir),
          [{ id: sessionId, file, dir: sessionsDir, mtimeMs: st.mtimeMs, size: st.size, bucket: basename(sessionsDir) }]);
      } catch { /* best-effort */ }
      let segs = eventsBeforeQuery(eventIndexFile, basename(sessionsDir), sessionId, beforeSeq, limitEvents);
      if (segs.length === 0) {
        // D14 ③（2026-10-05 补接线）：翻页恰好无索引（会话从未入索引——<5MB 全量装载不走嗅探建行）
        // → 单会话即时字节扫补建后重查（几百 ms 一次性；建行只扫字节不 parse）。补建后仍空 = 到头
        indexSingleSession(eventIndexFile, basename(sessionsDir), sessionId, file);
        segs = eventsBeforeQuery(eventIndexFile, basename(sessionsDir), sessionId, beforeSeq, limitEvents);
      }
      if (segs.length === 0) return [];
      let fd: number;
      try {
        fd = openSync(file, "r");
      } catch {
        return [];
      }
      const out: SessionEvent[] = [];
      try {
        for (const seg of segs) {
          const buf = Buffer.alloc(seg.byteLength);
          if (readSync(fd, buf, 0, seg.byteLength, seg.byteOffset) !== seg.byteLength) return out; // 文件变短：已取到的先给
          for (const line of buf.toString("utf8").split("\n")) {
            if (line === "") continue;
            try {
              out.push(JSON.parse(line) as SessionEvent);
            } catch {
              return out; // 坏行止损：页面截到好行
            }
          }
        }
      } finally {
        closeSync(fd);
      }
      return out;
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

    setModuleT(t) {
      i18nHolder.t = t;
    },
    graph() {
      return graph;
    },

    // 批⑤：/usage 内建命令退役后的宿主读口（双口径不变——会话级恒有、项目级随存储后端）
    async usage() {
      // T10（m5-resume-perf）：窗口镜像全量升级——当前会话累计按全量口径（兄弟聚合有 T3 缓存托底）
      if (store.ensureFull !== undefined) await store.ensureFull();
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
    // M4.5 T8：花名册读口 + 挂起审批应答口（界面三件套 / /tasks 的数据源）
    subagents() {
      return subagentRunner.list();
    },
    answerSubagentApproval(agentId: string, allow: boolean) {
      return subagentRunner.answerApproval(agentId, allow);
    },
    stopAllSubagents() {
      subagentRunner.stopAll();
    },
    // m5-btw T1：宿主二级调用口——llmHolder.impl 即模块 ctx.llm 惰性转发的同一实现体（activate.ts 同一 holder）。
    // 构造期无条件装配，?? 兜底只在装配前窗口成立——unassignedLlm 带内错误（activate.ts 导出复用）
    llm(): LlmPort {
      return llmHolder.impl ?? unassignedLlm;
    },
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
    configuredLanguage: () => cfgLanguageValue(),
    async setLanguage(tag: string) {
      await applyLanguageOverride(tag);
    },
    setEffort(level: string) {
      applyEffortOverride(level);
    },

    async setLabel(label: string) {
      await ensureHeader(); // 命名先于首个 turn 也不出断头文件（/title 新政同 fork 走查批）
      await store.append(LOG_TYPES.sessionLabel, { label: label.slice(0, 200) });
      await store.flush();
    },

    // 会话树批 T6/T10：落盘式分叉出口（实现提取为 sessionForkFn——与 ctx.session.fork 装配共用）
    fork: sessionForkFn,

    // 宿主日志口（T4/S10）：createLogger 每次新建实例无妨——写盘队列挂在 sink 闭包上，多 logger 天然共享
    log(code: string, msg: string, data?: Record<string, unknown>) {
      createLogger(sink, "host").info(code, msg, data);
    },

    // 会话树批 T7/T9/T10：树快照出口（实现提取为 treeFn——与 ctx.session.tree 装配共用；索引缓存路径）
    tree: treeFn,

    async reload() {
      if (closed) throw new Error("harness 已关闭");
      // CK-06/CH-09 修复：in-flight 折叠——并发 reload（/reload 连击、确认→自动 reload 链路）共享同一次
      // 执行。旧实现双跑：共享 bus/tools 上双激活 + 监听器双挂 + 工具注册冲突降级（且 last-wins 丢前轮
      // 监听器）；收尾补触发让路中的送回轮
      if (reloadInFlight !== undefined) return reloadInFlight;
      const p = doReload().finally(() => {
        reloadInFlight = undefined;
        if (deliveryBacklog.length > 0) retryDelivery(); // CH-09：reload 期间让路的送回轮补触发（CH-12②：有等待者让位 + 宏任务）
      });
      reloadInFlight = p;
      return p;
    },

    async close() {
      if (closed) return; // 幂等
      closed = true;
      subagentRunner.stopAll(); // 会话关闭全停（决策 12）：子代理在跑/排队/挂起审批全部收场
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

  /** reload 本体（CK-06/CH-09）：由 harnessImpl.reload 以 in-flight 互斥调用——不直接暴露。 */
  const doReload = async (): Promise<ReloadReport> => {
      // quiesce（§5.5，无超时定案——挂死 turn 由用户 cancel()/Ctrl-C 中止，中止即达边界）
      if (currentTurn !== null) await currentTurn.done.catch(() => undefined);
      const oldGraph = graph;
      const oldDefs = oldGraph.defs();
      // 重新执行配置分层合并 → 发现 → 信任 →（同一代码路径；§5.5）
      const home2 = orosusHome();
      secrets = loadSecretsEnv(options.secretsFile ?? join(home2, "secrets.env")).vars; // 重读 secrets（向导等运行期写入后 reload 必须看到）
      const config2 = loadConfig({
        userFile: options.config?.userFile ?? join(home2, "config.toml"),
        // modules.d 缺省与启动路径同口径：实际生效配置文件的同级目录（测试密封——见启动路径处注释）
        userModulesDir: options.config?.userModulesDir ?? join(dirname(options.config?.userFile ?? join(home2, "config.toml")), "modules.d"),
        projectModulesDir: options.config?.projectModulesDir ?? join(dirname(options.config?.projectFile ?? join(options.cwd ?? process.cwd(), ".orosus", "config.toml")), "modules.d"),
        // CH-02：与启动路径（228 行）对齐——尊重注入的 projectFile；旧实现硬编码 cwd 缺省路径，
        // reload 后项目层整层静默丢失 + 误读不该读的真实 cwd 文件（测试密封性/嵌入式宿主隔离被打破）
        projectFile: options.config?.projectFile ?? join(options.cwd ?? process.cwd(), ".orosus", "config.toml"),
        ...(options.config?.cliOverrides !== undefined ? { cliOverrides: options.config.cliOverrides } : {}),
        env: options.config?.env ?? mergeEnvLayer(process.env, secrets),
      });
      contextWindow = readContextWindow(config2.core, config2.sections); // reload 读新值——getter 形态下模块侧立即生效（空白 §5）
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
        // CH-05：def 引用判据对 local 无意义（jiti moduleCache:false 逐次新对象——引用恒不等），
        // local 侧代码变化由 entryHash（整目录 hash）承载，退化为来源层比较（与 kernel/reload.ts diffGraphs 同口径）
        const defChanged = g.source === "local" || next.source === "local" ? g.source !== next.source : g.def !== next.def;
        if (g.entryHash !== next.entryHash || defChanged) { removedOrChanged.add(g.def.name); continue; }
        // 配置自有 key 有效值 deepEqual 失败 → Reloaded（M3 修复：粗判此前漏配置变化——preserved 误含已变模块，
        // required 模块的坏配置在 reload 中被静默沿用旧实例，安全护栏失效）。
        // CK-08（2026-09-28 code review P3）：比较基座改 stableStringify（kernel/reload.ts 全链同一实现）——
        // 旧 JSON.stringify 对 key 序敏感，z.record/.passthrough() 类保留输入 key 序的 schema 在用户
        // 重排配置 key 序（无语义变化）时误判 Reloaded：模块无谓重激活、generation 虚增
        if (stableStringify(g.configValue) !== stableStringify(newConfigValue(g.def.name))) removedOrChanged.add(g.def.name);
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
          mediaDir: mediaDirUsed, // m5-media F2：媒资库注入（reload 新图同款）
          spillDir: spillDirUsed,
          cwd: options.cwd ?? process.cwd(),
          commandUi,
          llm: llmHolder,
          i18n: i18nHolder, // m5-i18n T2：reload 沿用同一 holder（Unchanged 旧闭包同读新 t）
          ...(options.settings !== undefined ? { settings: options.settings } : {}), // m5 T9：reload 同款透传（新图 ctx 装配不缺件）
          ...(options.host !== undefined ? { host: options.host } : {}),
          subagent: subagentRunner, // M4.5 子代理批：reload 后重激活模块的 ctx.subagent 不缺件
          ...(blocked.length > 0 ? { blocked } : {}), // m5 T17：待确认桶随新图可见（重算后的 blocked）
          reuse: { bus: oldGraph.bus, tools: oldGraph.tools, overlays: oldGraph.overlays }, // overlays 跨代共享（CK-04：换下模块的 overlay 摘除对所有代 ctx 生效）
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
      hookDelivery(graph.bus);    // M4.5 T9：送回 followUp drain 同款防重挂
      const d = diffGraphs(oldEff, newGraph.defs().filter((g) => newEffNames.has(g.def.name))); // 有效集口径——added/removed 如实含启停翻转（toast/回显消费，T2）
      const failed = newGraph.records.filter((r) => r.state === "failed").map((r) => ({ name: r.name, reason: r.failReason ?? "未知" }));
      const report: ReloadReport = { added: d.added, removed: d.removed, reloaded: d.reloaded, unchanged: d.unchanged, failed };
      createLogger(sink, "kernel").info("kernel.reload.done", "reload 完成", { added: d.added.length, removed: d.removed.length, reloaded: d.reloaded.length, unchanged: d.unchanged.length });
      return report;
  };
  return harnessImpl;
}
