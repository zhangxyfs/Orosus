import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandUi, LlmPort, ModuleDefinition } from "@orosus/contracts/module";
import type { Chunk, ModelMessage, StreamFn } from "@orosus/contracts/provider";
import { createDiagSink, createLogger } from "./diag/logger.ts";
import { hardeningNote, JsonlSessionStore } from "./session/jsonl.ts";
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
  resume?: { sessionId: string };           // 打开既有会话继续（D41/T6）：已有事件非空则不落重复 header
  fork?: { parentSessionId: string; atEntryId?: string }; // 复合存储新会话（D41/T6）：header 带 parentSession + 首事件 session/fork
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
  prompt(text: string): Promise<string | undefined>;  // 命令输入时返回命令输出（回显）；普通 turn 返回 undefined
  cancel(): void;
  /** 当前会话 id（/fork 等宿主侧会话操作的消费面，D41/T6）。 */
  readonly sessionId: string;
  /** 单订阅者（M1）：Channel 逐 waiter 派发，多订阅者会瓜分事件；广播需求出现时再升级。 */
  events(): AsyncIterable<SessionEvent>;
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

/** 转发代理：一切 append（loop/模块 ctx.session.append 一视同仁）即转发订阅端（§6.7 日志实时投影）。 */
function forwardingStore(store: SessionStore, channel: Channel<SessionEvent>): SessionStore {
  return {
    sessionId: store.sessionId,
    append: async (type, fields) => {
      const e = await store.append(type, fields);
      channel.push(e);
      return e;
    },
    all: () => store.all(),
    flush: () => store.flush(),
    close: () => store.close(),
  };
}

/** §4.2 启动序列的编程式形态。CLI 只是本入口的配置驱动薄壳（§8.1）。 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const home = join(homedir(), ".orosus");
  const sink = createDiagSink({ dir: options.diagDir ?? join(home, "logs") });

  const note = hardeningNote();
  if (note) createLogger(sink, "kernel").warn("kernel.session.hardening", note);

  // 交互 UI（D35/D38）：CLI 注 readline 版；缺省拒绝式（无头 fail-closed）。M3/T2 起经 ctx.ui 同时注入 waterfall 侧（审批询问）
  const commandUi: CommandUi = options.commandUi ?? {
    ask: async () => { throw new Error("无交互环境（headless）——交互式命令不可用（D35 fail-closed）"); },
    choose: async () => { throw new Error("无交互环境（headless）——交互式命令不可用（D35 fail-closed）"); },
    confirm: async () => { throw new Error("无交互环境（headless）——交互式命令不可用（D35 fail-closed）"); },
  };

  const secretsLoad = loadSecretsEnv(options.secretsFile ?? join(home, "secrets.env"));
  const secrets = secretsLoad.vars; // reload 复用（同一合并语义）
  if (secretsLoad.badLines > 0) createLogger(sink, "kernel").warn("kernel.secrets.badline", "secrets.env 坏行被跳过（KEY=VALUE 格式）", { badLines: secretsLoad.badLines });
  const config = loadConfig({
    userFile: options.config?.userFile ?? join(home, "config.toml"),
    projectFile: options.config?.projectFile ?? join(options.cwd ?? process.cwd(), ".orosus", "config.toml"),
    ...(options.config?.cliOverrides !== undefined ? { cliOverrides: options.config.cliOverrides } : {}),
    // D37 优先级：显式 env 参数 > process.env > secrets.env——显式环境是用户当下意图，secrets 只补缺
    env: options.config?.env ?? mergeEnvLayer(process.env, secrets),
  });

  // 存储构造分支（D41/T6 + D42/T7）：显式 store > resume > fork > 全新；后端按核心顶层 key sessionStore 选择（缺省 jsonl）
  const sessionsDir = options.sessionsDir ?? join(home, "sessions");
  const makeStore = (sessionId?: string): SessionStore => {
    const backend = String(config.core.sessionStore ?? "jsonl");
    const withId = sessionId !== undefined ? { sessionId } : {};
    if (backend === "sqlite") return new SqliteSessionStore({ dir: sessionsDir, ...withId });
    if (backend === "jsonl") return new JsonlSessionStore({ dir: sessionsDir, ...withId });
    throw new Error(`sessionStore 配置非法："${backend}"（合法值 jsonl | sqlite，核心顶层 key，§7.2/D42）`);
  };
  let baseStore: SessionStore;
  if (options.store !== undefined) {
    baseStore = options.store;
  } else if (options.resume !== undefined) {
    baseStore = makeStore(options.resume.sessionId);
  } else if (options.fork !== undefined) {
    baseStore = new ForkedSessionStore({
      parent: makeStore(options.fork.parentSessionId),
      ...(options.fork.atEntryId !== undefined ? { atEntryId: options.fork.atEntryId } : {}),
      own: makeStore(),
    });
  } else {
    baseStore = makeStore();
  }
  const channel = new Channel<SessionEvent>();
  const store = forwardingStore(baseStore, channel);

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
    session: store,
    sink,
    spillDir: spillDirUsed,
    commandUi,
    llm: llmHolder,
    ...(blocked.length > 0 ? { blocked } : {}),
  });

  // header 分支（D41/T6）：resume 的既有文件已带 header（不重复落）；fork 落新 header（parentSession）+ session/fork 首事件
  const existingEvents = await store.all();
  if (options.resume === undefined || existingEvents.length === 0) {
    let sourceEntryId: string | undefined;
    if (options.fork !== undefined) {
      sourceEntryId = options.fork.atEntryId ?? existingEvents[existingEvents.length - 1]?.id;
    }
    await store.append(LOG_TYPES.sessionHeader, {
      format: 1,
      cwd: options.cwd ?? process.cwd(),
      parentSession: options.fork?.parentSessionId ?? null,
      moduleGraph: {
        active: graph.records.filter((r) => r.state === "active").map((r) => r.name),
        degraded: graph.records.filter((r) => r.state === "failed").map((r) => `${r.name}: ${r.failReason}`),
      },
    });
    if (options.fork !== undefined) {
      await store.append(LOG_TYPES.sessionFork, { sourceEntryId: sourceEntryId ?? null, parentSession: options.fork.parentSessionId });
    }
  }
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
  };

  const builtinCommands = new Map<string, (args: string) => Promise<string>>([
    ["/model", async () => {
      const slots = graph.services.listProviders();
      const items = [
        ...slots.filter((x) => x.defaultModel !== undefined).map((x) => `${x.name}（默认 ${x.defaultModel}，裸名即用）`),
        "手动输入 model 全名（<provider>/<model>）",
      ];
      const picked = await commandUi.choose("选择模型", items);
      const next = picked.includes("手动输入") ? (await commandUi.ask("model")).trim() : picked.split("（")[0]!;
      if (next === "") return "已取消（空输入）";
      modelOverride = next;
      return `model 已切换：${next}（下个 turn 生效，request/header 将落新条目）`;
    }],
    ["/help", async () => {
      const lines = ["内建命令：", "  /model /help /status /usage /reload"]; // M2 补账：/reload 是内建表第五成员，原清单漏列
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
    ["/status", async () => {
      const audit = graph.audit();
      const active = audit.filter((a) => a.state === "active").length;
      const failed = audit.filter((a) => a.state === "failed").length;
      const discovered = audit.filter((a) => a.state === "discovered").length;
      // model 未配置时显示「（未配置）」而非字面量 undefined（M2 补账：走查发现）
      const modelNow = modelOverride ?? (typeof config.core.model === "string" && config.core.model !== "" ? config.core.model : "（未配置）");
      return `model: ${modelNow}${modelOverride !== undefined ? "（运行期覆盖）" : ""}
session: ${store.sessionId}
模块图: active ${active} / failed ${failed} / discovered ${discovered}`;
    }],
    ["/reload", async () => {
      const r = await harnessImpl.reload();
      return `reload 完成：added ${r.added.join(",") || "无"} / removed ${r.removed.join(",") || "无"} / reloaded ${r.reloaded.join(",") || "无"} / unchanged ${r.unchanged.length}`;
    }],
    ["/usage", async () => {
      const events = await store.all();
      let input = 0;
      let output = 0;
      for (const e of events) {
        if (e.type !== "assistant/chunk") continue;
        const c = e.chunk as { type?: string; input?: number; output?: number };
        if (c?.type === "usage") {
          input += c.input ?? 0;
          output += c.output ?? 0;
        }
      }
      return `累计用量：input ${input} / output ${output} tokens`;
    }],
  ]);

  const resolveProvider = (): { stream: StreamFn; model: string } => {
    const modelValue = modelOverride ?? (config.core.model as unknown);
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

    async prompt(text) {
      if (closed) throw new Error("harness 已关闭");
      if (currentTurn) throw new Error("已有进行中的 turn（M1 单并发；取消请调 cancel()）");
      // 命令路由（D38 三层：CLI 拦截在宿主侧；此处内建表 > 别名 > 模块注册）。命令不触发 agentLoop、不落会话日志
      if (text.startsWith("/")) {
        const m = /^\/([a-z0-9][a-z0-9-]*(?:__[a-z0-9-]+)?)(?:\s([\s\S]*))?$/.exec(text);
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
        await store.append(LOG_TYPES.userMessage, { content: [{ kind: "text", text }] });
        try {
          for await (const _ of agentLoop({
            session: store, bus: graph.bus, tools: graph.tools,
            provider: trackedStream, model, system: graph.promptSections(),
            signal: controller.signal, sink,
          })) {
            // 事件经 forwardingStore 在 append 时即转发，此处仅驱动迭代
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

    graph() {
      return graph;
    },

    async reload() {
      if (closed) throw new Error("harness 已关闭");
      // quiesce（§5.5，无超时定案——挂死 turn 由用户 cancel()/Ctrl-C 中止，中止即达边界）
      if (currentTurn !== null) await currentTurn.done.catch(() => undefined);
      const oldGraph = graph;
      const oldDefs = oldGraph.defs();
      // 重新执行配置分层合并 → 发现 → 信任 →（同一代码路径；§5.5）
      const home2 = join(homedir(), ".orosus");
      const config2 = loadConfig({
        userFile: options.config?.userFile ?? join(home2, "config.toml"),
        projectFile: join(options.cwd ?? process.cwd(), ".orosus", "config.toml"),
        ...(options.config?.cliOverrides !== undefined ? { cliOverrides: options.config.cliOverrides } : {}),
        env: options.config?.env ?? mergeEnvLayer(process.env, secrets),
      });
      contextWindow = readContextWindow(config2.core); // reload 读新值——getter 形态下模块侧立即生效（空白 §5）
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
      let newGraph: ModuleGraph;
      try {
        newGraph = await loadModules({
          defs: defs2,
          cli: cliInput,
          sections: config2.sections,
          session: store,
          sink,
          spillDir: spillDirUsed,
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
      // 会话连续性（§5.5）：Removed/Reloaded 模块的工具 soft 墓碑（tools 数组字节稳定；Reloaded 重注册自动顶掉墓碑）
      for (const name of removedOrChanged) {
        for (const tn of oldGraph.tools.namesByOwner(name)) newGraph.tools.tombstone(tn);
      }
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
      await sink.flush();
      await sink.close();
      channel.close();
    },
  };
  return harnessImpl;
}
