import { orosusHome } from "@orosus/contracts/home";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { CommandUi, LlmPort, ModuleDefinition } from "@orosus/contracts/module";
import type { Chunk, ContentPart, ModelMessage, StreamFn } from "@orosus/contracts/provider";
import { createDiagSink, createLogger } from "./diag/logger.ts";
import { hardeningNote, JsonlSessionStore, lastUsageTotal, sumUsage } from "./session/jsonl.ts";
import { SqliteSessionStore } from "./session/sqlite.ts";
import { ForkedSessionStore, verifyChain } from "./session/fork.ts";
import type { SessionEvent, SessionStore } from "./session/types.ts";
import { LOG_TYPES } from "./session/types.ts";
import { loadConfig, loadSecretsEnv, mergeEnvLayer } from "./config/load.ts";
import { loadModules, type ModuleGraph } from "./kernel/kernel.ts";
import { discoverModules, type DiscoveredModule } from "./kernel/discover.ts";
import { diffGraphs, type ReloadReport } from "./kernel/reload.ts";
import { loadTrustStore, checkTrust } from "./kernel/trust.ts";
import { CORE_POINTS } from "./kernel/bus.ts";
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
  diagDir?: string;
  spillDir?: string;
  secretsFile?: string;                     // 缺省 ~/.orosus/secrets.env（D37）；测试传 tmp 路径密封
  commandUi?: CommandUi;                   // 命令交互 UI（D35/D38）：CLI 注 readline 版；缺省拒绝式（无头 fail-closed）
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
  /** 当前会话 id（/fork 等宿主侧会话操作的消费面，D41/T6）。 */
  readonly sessionId: string;
  /** 单订阅者（M1）：Channel 逐 waiter 派发，多订阅者会瓜分事件；广播需求出现时再升级。 */
  events(): AsyncIterable<SessionEvent>;
  /** 会话历史（宿主显示面，B9 走查补）：全部持久事件（resume 回显用；含 reasoning 块——显示方自行取舍）。 */
  history(): Promise<SessionEvent[]>;
  /** 实时旁路通道（M4-1 T4/D45）：provider 流式 Chunk 的内存投递——不持久、不进 SessionEvent 流、
   *  断连即弃（无等待者的 push 直接丢，零积压）；每调用一次 = 新订阅（从当下起，无重放）。 */
  liveChunks(): AsyncIterable<Chunk>;
  /** Token 用量读口（2026-09-22 命令分级批⑤——/usage 内建命令退役，宿主 /other 面板直调）：
   *  当前会话累计恒有；存储后端支持跨会话累计（JsonlStore）时带 lifetime。 */
  usage(): Promise<{ current: { input: number; output: number }; lifetime?: { input: number; output: number; sessions: number } }>;
  /** 运行状态读口（批⑥——/status 内建命令退役并入 /other）：model（含运行期覆盖标记）、会话 id、模块图三计数。 */
  status(): { model: string; overridden: boolean; sessionId: string; modules: { active: number; failed: number; discovered: number } };
  /** 当前会话命名写口（批⑦a——/title 破链修复）：经活 store 追加 session/label（单写者纪律——
   *  旁路新建 store 写活文件会让活 store 的内存 lastId/seq 失真，后续事件 parentId 链断裂/seq 撞号）。 */
  setLabel(label: string): Promise<void>;
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
    baseStore = new ForkedSessionStore({
      // 父会话定位（T1/D46）：parentDir 缺省同桶（REPL /fork 同会话目录）；跨桶/平铺父由宿主经 locateSessionFile 定位后填入
      parent: makeStore(options.fork.parentSessionId, options.fork.parentDir ?? sessionsDir),
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

  const defs: { def: ModuleDefinition; source: "builtin" | "inline" | "local" }[] = [
    ...(options.builtinModules ?? []).map((def) => ({ def, source: "builtin" as const })),
    ...(options.modules ?? []).map((def) => ({ def, source: "inline" as const })),
  ];
  // 目录扫描 + 项目级信任门（§8.3/§8.5/T11-T12）：通过者并入 defs（source local），未过者 blocked（failed untrusted，不激活）
  const blocked: { def: import("@orosus/contracts/module").ModuleDefinition; source: string; reason: string }[] = [];
  {
    const userDir = options.discovery?.userDir ?? join(home, "modules");
    const projectDir = options.discovery?.projectDir ?? join(options.cwd ?? process.cwd(), ".orosus", "modules");
    const discovered: DiscoveredModule[] = await discoverModules({ userDir, projectDir, ...(options.config?.userFile !== undefined ? { userFile: options.config.userFile } : {}), sink });
    const trustFile = options.discovery?.trustFile ?? join(home, "trust.json");
    const trustStore = loadTrustStore(trustFile);
    for (const m of discovered) {
      const t = checkTrust({ layer: m.layer, root: m.root, entryHash: m.entryHash, store: trustStore });
      if (t.ok) {
        defs.push({ def: m.def, source: "local" as const });
      } else {
        blocked.push({ def: m.def, source: "local", reason: t.reason === "unconfirmed" ? "untrusted（项目级模块未确认——运行 orosus module trust <name> 后重启生效，§8.5）" : "untrusted（项目级模块内容 hash 已变化，须重新确认，§8.5/MCPoison）" });
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
    ...(blocked.length > 0 ? { blocked } : {}),
  });

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
      modelOverride = next;
      // 持久化（2026-09-22 用户拍板，推翻 T14/D38「显式确认才写盘」）：选定即写盘永久生效——
      // 「要不要永久」是工具该自己处理的琐事，不该问用户。行级写 user config 顶层 provider 键
      // （无 TOML 库；不复用 provider-custom setModel——模块层装配闭包，core↛模块违铁律 3）
      const before = existsSync(userConfigFile) ? readFileSync(userConfigFile, "utf8") : "";
      // TOML 顶层锚定（2026-09-22 启动阻断实证：裸键追加在文件末尾会落进最后一个 [节]——approval strict 校验
      // 直接拒启动）。节区感知：顶层区 = 首个节头之前；旧 model/provider 行只在顶层区清除，新键写到顶层区末尾
      const cfgLines = before.split("\n");
      const firstSection = cfgLines.findIndex((l) => /^\s*\[/.test(l));
      const headEnd = firstSection === -1 ? cfgLines.length : firstSection;
      const head = cfgLines.slice(0, headEnd).filter((l) => !/^\s*(model|provider)\s*=/.test(l));
      while (head.length > 0 && head[head.length - 1]!.trim() === "") head.pop(); // 尾空行收拢
      head.push(`provider = "${next}"`); // F5 十轮：键名 provider（值保留 slot/model 全形）；旧 model 行已随上方过滤清除
      const after = [...head, "", ...cfgLines.slice(headEnd)].join("\n").replace(/\n{3,}/g, "\n\n");
      mkdirSync(dirname(userConfigFile), { recursive: true }); // 目录缺省即建（批⑧确认制废除后写盘无条件化——宿主/测试自定义路径不得 ENOENT）
      writeFileSync(userConfigFile, after, "utf8");
      // 静默返回（2026-09-22 用户拍板：切换反馈由宿主侧浮动 toast 承担——diff h.status() 前后值得知；
      // 空串 = 不落流区的管线约定，同 /permission /yolo）
      return "";
    }],
    ["/help", async () => {
      const lines = ["内建命令：", "  /model /help /reload"]; // 批⑤⑥：/usage /status 退役（宿主读口 h.usage()/h.status() 取代，CLI 并入 /other 面板）
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
      return `reload 完成：added ${r.added.join(",") || "无"} / removed ${r.removed.join(",") || "无"} / reloaded ${r.reloaded.join(",") || "无"} / unchanged ${r.unchanged.length}`;
    }],
    ["/context", async () => {
      // 三行余量（M4-2 T20/B20）：窗口 = 核心顶层 contextWindow（D44）；已用 = usage 锚点（D39 修订透出），
      // 进程内还没有模型往返（新会话/resume 后）时回退 store 末条 usage——否则 resume 会话恒显 ~0（2026-09-20 用户实测）
      const modelNow = modelOverride ?? (typeof cfgModelValue() === "string" ? (cfgModelValue() as string) : "（未配置）");
      const used = usageAnchor?.totalTokens ?? lastUsageTotal(await store.all()) ?? 0;
      const pct = contextWindow !== undefined ? Math.round((used / contextWindow) * 100) : undefined;
      return `模型: ${modelNow}\n窗口: ${contextWindow !== undefined ? `${contextWindow} tokens` : "未知（/provider import --model 可写入）"}\n已用: ~${used} tokens${pct !== undefined ? `（${pct}%）` : ""}`;
    }],
    ["/summary", async () => {
      // 压缩摘要查看口（M4-2.5 T4——压缩调研 P2：六家独一份的「摘要不可见」补齐）——直读最近 turn/compaction 事件
      const compactions = (await store.all()).filter((e) => e.type === "turn/compaction");
      const last = compactions.at(-1) as { summary?: string; droppedCount?: number } | undefined;
      if (last === undefined) {
        // 纯提示走 notice（批⑧：toast 浮动窗/行模式单行，不落流区）+ 空串静默
        commandUi.notice?.("本会话尚未压缩过——上下文增长到阈值会自动压缩，或随时 /compact 手动压缩");
        return "";
      }
      return `[压缩摘要（本会话第 ${compactions.length} 次，压前缀 ${last.droppedCount ?? "?"} 条）]\n\n${String(last.summary ?? "")}`;
    }],
  ]);

  // F5 十轮：核心顶层键名 provider（旧 model 键兼容读——分层合并两键都在时 provider 胜）
  const cfgModelValue = (): unknown => config.core.provider ?? config.core.model;
  const resolveProvider = (): { stream: StreamFn; model: string } => {
    const modelValue = modelOverride ?? cfgModelValue();
    if (typeof modelValue !== "string" || modelValue === "") {
      throw new Error(`未配置 model（核心顶层 key，格式 <provider>/<model> 或裸 <provider>，§6.6/D32）——请在 config.toml 或 CLI 指定`);
    }
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

  // ctx.llm 实现（D39/T4 + 补强 T3 三扩展）：调用时解析当前 provider/model（含 /model 覆盖、reload 后的新图）；错误带内
  llmHolder.impl = {
    stream: (req: { system?: string; messages: ModelMessage[]; signal?: AbortSignal; maxTokens?: number }) =>
      (async function* (): AsyncGenerator<Chunk> {
        let resolved: { stream: StreamFn; model: string };
        try {
          resolved = resolveProvider();
        } catch (err) {
          yield { type: "finish", kind: "error", errorMessage: `llm 口解析失败：${err instanceof Error ? err.message : String(err)}` };
          return;
        }
        yield* resolved.stream({
          model: resolved.model,
          system: req.system ?? "",
          messages: req.messages,
          tools: [], // 二级调用不带工具（D39）
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
          signal: req.signal ?? new AbortController().signal,
        });
      })(),
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
      return {
        model: modelOverride ?? configured,
        overridden: modelOverride !== undefined,
        sessionId: store.sessionId,
        modules: {
          active: audit.filter((a) => a.state === "active").length,
          failed: audit.filter((a) => a.state === "failed").length,
          discovered: audit.filter((a) => a.state === "discovered").length,
        },
      };
    },

    // 批⑦a：/title 当前会话改名走活 store（单写者——旁路新建 store 写活文件会破 parentId 链/seq 单调）。
    // append 后立即 flush（2026-09-22 用户实测：label 滞留写缓冲时 /sessions 读盘看不到新名——改名必须即落盘）
    async setLabel(label: string) {
      await ensureHeader(); // 命名先于首个 turn 也不出断头文件（/title 新政同 fork 走查批）
      await store.append(LOG_TYPES.sessionLabel, { label: label.slice(0, 200) });
      await store.flush();
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
      config = config2; // 核心顶层 key（model 等）同步更新——修复：reload 后 model/contextWindow 等仍读旧值（走查缺陷③：向导写 model + /reload 后 resolveProvider 仍读旧 config.core.model = undefined → "未配置 model"）
      const defs2: { def: ModuleDefinition; source: "builtin" | "inline" | "local"; entryHash?: string }[] = [
        ...(options.builtinModules ?? []).map((def) => ({ def, source: "builtin" as const })),
        ...(options.modules ?? []).map((def) => ({ def, source: "inline" as const })),
      ];
      {
        const userDir = options.discovery?.userDir ?? join(home2, "modules");
        const projectDir = options.discovery?.projectDir ?? join(options.cwd ?? process.cwd(), ".orosus", "modules");
        const discovered = await discoverModules({ userDir, projectDir, ...(options.config?.userFile !== undefined ? { userFile: options.config.userFile } : {}), sink });
        const trustStore = loadTrustStore(options.discovery?.trustFile ?? join(home2, "trust.json"));
        for (const m of discovered) {
          const t = checkTrust({ layer: m.layer, root: m.root, entryHash: m.entryHash, store: trustStore });
          if (t.ok) defs2.push({ def: m.def, source: "local", ...(m.entryHash !== undefined ? { entryHash: m.entryHash } : {}) });
        }
      }
      // diff 粗判（§5.5 Reloaded 判据：entryHash / def 引用 / 配置自有 key 有效值——三者任一变化即重载）
      const newNames = new Set(defs2.map((d) => d.def.name));
      const removedOrChanged = new Set<string>();
      const newConfigValue = (name: string): unknown => {
        const next = defs2.find((d) => d.def.name === name);
        if (next === undefined) return undefined;
        const section = { ...config2.sections.get(name) };
        for (const k of ["enabled", "source", "required"]) delete section[k];
        const parsed = next.def.config?.safeParse(section);
        return parsed?.success ? parsed.data : undefined;
      };
      for (const g of oldDefs) {
        if (!newNames.has(g.def.name)) { removedOrChanged.add(g.def.name); continue; }
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
      const d = diffGraphs(oldDefs, newGraph.defs());
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
