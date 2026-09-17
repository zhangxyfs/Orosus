import { homedir } from "node:os";
import { join } from "node:path";
import type { ModuleDefinition } from "@orosus/contracts/module";
import type { StreamFn } from "@orosus/contracts/provider";
import { createDiagSink, createLogger } from "./diag/logger.ts";
import { hardeningNote, JsonlSessionStore } from "./session/jsonl.ts";
import type { SessionEvent, SessionStore } from "./session/types.ts";
import { LOG_TYPES } from "./session/types.ts";
import { loadConfig, loadSecretsEnv, mergeEnvLayer } from "./config/load.ts";
import { loadModules, type ModuleGraph } from "./kernel/kernel.ts";
import { CORE_POINTS } from "./kernel/bus.ts";
import { parseModel } from "./provider/resolve.ts";
import { agentLoop } from "./loop/loop.ts";

export interface HarnessOptions {
  modules?: ModuleDefinition[];
  builtinModules?: ModuleDefinition[];
  cwd?: string;
  store?: SessionStore;
  diagDir?: string;
  spillDir?: string;
  secretsFile?: string;                     // 缺省 ~/.orosus/secrets.env（D37）；测试传 tmp 路径密封
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
  prompt(text: string): Promise<void>;
  cancel(): void;
  /** 单订阅者（M1）：Channel 逐 waiter 派发，多订阅者会瓜分事件；广播需求出现时再升级。 */
  events(): AsyncIterable<SessionEvent>;
  graph(): ModuleGraph;
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
  const baseStore = options.store ?? new JsonlSessionStore({ dir: join(home, "sessions") });
  const channel = new Channel<SessionEvent>();
  const store = forwardingStore(baseStore, channel);

  const note = hardeningNote();
  if (note) createLogger(sink, "kernel").warn("kernel.session.hardening", note);

  const { vars: secrets, badLines } = loadSecretsEnv(options.secretsFile ?? join(home, "secrets.env"));
  if (badLines > 0) createLogger(sink, "kernel").warn("kernel.secrets.badline", "secrets.env 坏行被跳过（KEY=VALUE 格式）", { badLines });
  const config = loadConfig({
    userFile: options.config?.userFile ?? join(home, "config.toml"),
    projectFile: options.config?.projectFile ?? join(options.cwd ?? process.cwd(), ".orosus", "config.toml"),
    ...(options.config?.cliOverrides !== undefined ? { cliOverrides: options.config.cliOverrides } : {}),
    // D37 优先级：显式 env 参数 > process.env > secrets.env——显式环境是用户当下意图，secrets 只补缺
    env: options.config?.env ?? mergeEnvLayer(process.env, secrets),
  });

  const defs = [
    ...(options.builtinModules ?? []).map((def) => ({ def, source: "builtin" as const })),
    ...(options.modules ?? []).map((def) => ({ def, source: "inline" as const })),
  ];
  const graph = await loadModules({
    defs,
    cli: {
      ...(options.config?.enableModules !== undefined ? { enable: options.config.enableModules } : {}),
      ...(options.config?.disableModules !== undefined ? { disable: options.config.disableModules } : {}),
      ...(options.config?.noModules !== undefined ? { noModules: options.config.noModules } : {}),
      ...(options.config?.module !== undefined ? { module: options.config.module } : {}),
    },
    sections: config.sections,
    session: store,
    sink,
    spillDir: options.spillDir ?? join(home, "sessions", store.sessionId, "spill"),
  });

  await store.append(LOG_TYPES.sessionHeader, {
    format: 1,
    cwd: options.cwd ?? process.cwd(),
    parentSession: null,
    moduleGraph: {
      active: graph.records.filter((r) => r.state === "active").map((r) => r.name),
      degraded: graph.records.filter((r) => r.state === "failed").map((r) => `${r.name}: ${r.failReason}`),
    },
  });

  let currentTurn: { controller: AbortController; done: Promise<void> } | null = null;
  let closed = false;

  const resolveProvider = (): { stream: StreamFn; model: string } => {
    const modelValue = config.core.model;
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

  return {
    async prompt(text) {
      if (closed) throw new Error("harness 已关闭");
      if (currentTurn) throw new Error("已有进行中的 turn（M1 单并发；取消请调 cancel()）");
      const controller = new AbortController();
      let settle!: () => void;
      const done = new Promise<void>((resolve) => { settle = resolve; });
      // 同步占坑再 await：否则并发 prompt 会在首个 await 前双双通过守卫（TOCTOU），
      // close()/cancel() 在窗口期也拿不到真句柄。deferred done 让 close() 任何时刻等到的都是同一个 promise
      currentTurn = { controller, done };
      try {
        const { stream, model } = resolveProvider();
        await graph.bus.emit(CORE_POINTS.uiCommand, { kind: "prompt", text });
        await store.append(LOG_TYPES.userMessage, { content: [{ kind: "text", text }] });
        try {
          for await (const _ of agentLoop({
            session: store, bus: graph.bus, tools: graph.tools,
            provider: stream, model, system: graph.promptSections(),
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
}
