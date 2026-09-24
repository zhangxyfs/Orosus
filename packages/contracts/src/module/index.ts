import type { ZodType } from "zod";
import type { Tool } from "../tool/index.ts";
import type { Chunk, ModelMessage } from "../provider/index.ts";

/** 核心模块 API 主版本。核心按主版本做兼容检查（支持 N 与 N-1，见设计 §8.5）。 */
export const MODULE_API_VERSION = 1;

/** 注册即返回的注销句柄（规则 3：一切注册返回 disposer）。 */
export type Disposer = () => void | Promise<void>;

/** 模块级诊断 logger（§11.9）。code 为稳定事件码，点分路径；实现自动携带模块名。 */
export interface Logger {
  trace(code: string, msg: string, data?: Record<string, unknown>): void;
  debug(code: string, msg: string, data?: Record<string, unknown>): void;
  info(code: string, msg: string, data?: Record<string, unknown>): void;
  warn(code: string, msg: string, data?: Record<string, unknown>): void;
  error(code: string, msg: string, data?: Record<string, unknown>): void;
}

/** 能力 key 的品牌类型——公共短名只能由 contracts 包定义（规则 1）。 */
export type CapabilityKey<T> = string & { readonly __capability?: T };

/** 斜杠命令处理器：/<module>__<command>。第二参 ui 为宿主注入的交互抽象（D35）——纯函数命令可忽略。 */
export type CommandHandler = (args: string, ui: CommandUi) => Promise<string> | string;

/** 命令交互 UI 抽象（D35）：ask/choose/confirm——宿主注入 readline 实现；无头环境注入拒绝式
 *  （三方法抛"无交互环境"→ 命令带内失败，fail-closed）。多级菜单 = 命令内嵌套调用。 */
export interface CommandUi {
  ask(question: string): Promise<string>;
  /** 敏感输入（密钥等）：语义同 ask，宿主应以掩码回显（*）——headless 拒绝式实现同 ask。 */
  askSecret(question: string): Promise<string>;
  choose(title: string, items: string[]): Promise<string>;
  confirm(question: string): Promise<boolean>;
  /** 瞬时提示（2026-09-22 批⑧，可选）：「无可压缩/已切换」类一次性反馈——全屏宿主走浮动 toast（3s 自消），
   *  行模式宿主落单行。命令体应 notice(...) 后返回空串（静默约定），而不是把提示当结果文本返回。
   *  缺省/无头实现可静默丢弃——notice 是增强反馈，不承载命令语义。 */
  notice?(text: string): void;
}

/** 二级 LLM 调用口（D39）：模块的辅助模型调用（compaction 摘要、标题生成等）。
 *  复用 harness 当前 provider/model 解析（含 /model 运行期覆盖）；错误带内（finish error，不许 reject）；
 *  二级调用不带客户端工具（M4-3 T1b 修订：webSearch 声明的是服务端搜索，不是 tools——模型不可见、不进会话）。
 *  核心基础设施（与 ctx.log/session 同类）——不是能力槽、不经 services、不可 provide 替换。
 *  M3 补强三扩展（D39 修订）：stream 增可选 maxTokens（输出上限）；contextWindow/lastUsage 只读事实，getter 惰性读 holder。
 *  M4-3 T1b 扩展（SW-17）：stream 增可选 model（缺省 = 当前模型；支持 provider/model 限定形——钉非当前提供商的
 *  模型时用）与 webSearch（声明服务端原生搜索）；LlmPort 增可选 listModels（模型目录——缺省 undefined = 目录不可用，
 *  菜单据此灰显模型选择；条目统一 provider/model 限定形，跨槽聚合）。
 *
 * @example
 * ```ts
 * // 二级调用：摘要生成（compaction 同款形态）——仅运行期调用，activate 期 provider 可能未装配
 * let text = "";
 * for await (const c of ctx.llm.stream({ system: "你是摘要器", messages, maxTokens: 2048 })) {
 *   if (c.type === "text/delta") text += c.text;
 *   if (c.type === "finish" && c.kind === "error") { text = ""; break; }  // 错误带内，不许 reject
 * }
 * ```
 */
export interface LlmPort {
  stream(req: { system?: string; messages: ModelMessage[]; signal?: AbortSignal; maxTokens?: number; model?: string; webSearch?: boolean }): AsyncIterable<Chunk>;
  /** 模型目录（SW-17）：跨 provider 槽聚合的可用模型（条目统一 `provider/model` 限定形——钉选值同款格式）。
   *  可选——无一槽提供目录能力时读得 undefined（显式 | undefined：exactOptionalPropertyTypes 下 getter 惰性判定合法），
   *  消费方据此隐藏模型选择项。 */
  listModels?: (() => Promise<string[]>) | undefined;
  /** 当前模型上下文窗口（token）——harness 解析（config 顶层 contextWindow > provider import 目录写入）；未知 undefined。 */
  readonly contextWindow?: number | undefined;
  /** 最近一次主循环请求的真实用量锚点：totalTokens = input+output（该次请求全上下文）、atMessageCount = 该次请求
   *  messages 条数——其后消息用估算增量（compaction 消费；锚点有效性三态规则见 M3 补强方案空白 §4）。 */
  readonly lastUsage?: { totalTokens: number; atMessageCount: number } | undefined;
}

/** 系统 prompt 段：order 决定拼接顺序（核心保留 -100 为 harness 身份），单段 ≤ 32KB。 */
export interface PromptSection {
  order: number;
  text: string;
}

/** 事件监听者。waterfall 拦截点上：返回 undefined = 通过；返回 { deny: true, reason } 或抛错 = 否决。 */
export type Listener = (payload: unknown) => unknown | Promise<unknown>;

/** 依赖声明：字符串 = 硬依赖；{ capability, optional: true } = 可选依赖（不建拓扑边）。 */
export type Dependency = string | { capability: string; optional?: boolean };

/** 模块唯一的运行时 API 面（§5.1）。L1/L2 下由宿主换成收窄版，模块代码零改动。 */
export interface ModuleContext<C = unknown> {
  /** activate 时注入的纯分层合并快照（已校验、带默认值；overlay 不作用于它）。 */
  readonly config: C;
  /** 运行期读取自身配置（无 section 参数——只能读自己的 section）。 */
  configRead(): Promise<C>;
  readonly log: Logger;
  /** 宿主注入的交互 UI（D35 M3 修订/T2）：命令处理器第二参之外，waterfall 监听者（审批询问）同样需要询问口。
   *  无头环境为拒绝式实现（三方法抛"无交互环境"）——waterfall 监听者抛错即否决，fail-closed 方向正确。 */
  readonly ui: CommandUi;
  /** 二级 LLM 调用口（D39）：运行期调用时解析当前 provider/model（activate 期经惰性 holder 注入）。
   *  compaction 摘要等消费方应仅在运行期调用（activate 期 provider 可能尚未装配）。 */
  readonly llm: LlmPort;
  readonly services: {
    /** 硬依赖能力：拓扑序保证 activate 期间必有值。
     *
     * @example
     * ```ts
     * // dependsOn: ["my-module.store"] 已声明
     * const store = await ctx.services.get(StoreKey);
     * store.set("k", "v");
     * ```
     */
    get<T>(key: CapabilityKey<T>): Promise<T>;
    /** 可选能力：调用时解析，可能 undefined（迟到绑定）。
     *
     * @example
     * ```ts
     * const fs = await ctx.services.getOptional(FS);
     * if (fs === undefined) ctx.log.warn("my.fs-miss", "无 fs 能力，走降级路径");
     * else await fs.write(path, data);
     * ```
     */
    getOptional<T>(key: CapabilityKey<T>): Promise<T | undefined>;
  };
  /** 提供能力实现（单所有者槽）；key 须 ⊆ 声明区 provides（唯一例外：核心保留槽 key）。
   *
   * @example
   * ```ts
   * ctx.provide("my-module.store", { get: () => value, set: (v) => { value = v; } });
   * // 消费方（另一模块）经 dependsOn: ["my-module.store"] + ctx.services.get 解析
   * ```
   */
  provide(key: string, impl: unknown): void;
  readonly contribute: {
    /** 注册模型可调用的工具（进请求的 tools 数组）。
     *
     * @example
     * ```ts
     * ctx.contribute.tool(defineTool({
     *   name: "note__add",
     *   description: "Add a short note that persists across turns.",
     *   parameters: z.object({ text: z.string().min(1) }),
     *   resolveExecution: async (input) => ({
     *     accesses: [],
     *     approvalRule: "note__add",
     *     execute: async () => ({ output: "Noted", isError: false }),  // 错误带内，不许 reject
     *   }),
     * }));
     * ```
     */
    tool(t: Tool): Disposer;
    /** 注册宿主命令 `/<module>__<command>`（人用的操作面，模型不可调）。
     *
     * @example
     * ```ts
     * ctx.contribute.command("clear", async (args, ui) => {
     *   notes.length = 0;
     *   await ui.notice?.("便签已清空");   // 瞬时提示（可选口）；返回空串 = 静默约定
     *   return "";
     * });
     * // 用户输入 /note__clear 触发；args 是命令后的原始参数串
     * ```
     */
    command(name: string, handler: CommandHandler): Disposer;
    /** 注册系统提示词段：order 决定拼接顺序（核心保留 -100；分配表现值 skill=0/todo=10/mcp=20，
     * AGENTS.md 等价 30 拼尾——新段领 0–29 空位）。text 为 getter 时每轮请求装配读最新值；
     * 空串段装配时被过滤——「必须注入」类内容应无条件注册且 text 永远非空。
     *
     * @example
     * ```ts
     * ctx.contribute.promptSection({
     *   order: 15,
     *   get text() { return notes.length === 0 ? "" : `## Notes\n${notes.join("\n")}`; },
     * });
     * ```
     */
    promptSection(s: PromptSection): Disposer;
    /** 配置 overlay（§6.6 读侧扩展，D2）：缺省 section = 自家；声明他人 section 须 uses 含 "config.foreign"。
     *  只作用于 configRead()（运行期复合 + owner schema 复检），不作用于 ctx.config 快照；activate 期 configRead 只保证纯分层值（v13）。
     *
     * @example
     * ```ts
     * ctx.contribute.configOverlay({
     *   read(value) {
     *     const v = value as { maxNotes?: number };
     *     return { ...v, maxNotes: Math.min(v.maxNotes ?? 20, 50) };  // 修饰读侧投影，不落盘
     *   },
     * });
     * ```
     */
    configOverlay(o: { section?: string; read(value: unknown): unknown }): Disposer;
  };
  readonly session: {
    /** 写会话日志扩展事件；type 须已在 logEvents 声明（白名单）。
     *
     * @example
     * ```ts
     * // defineModule 里先声明：logEvents: ["note/write"]
     * ctx.session.append("note/write", { notes });
     * ```
     */
    append(type: string, payload: Record<string, unknown>): void;
    /** 读当前日志的模型消息投影（M5 F5 二轮⑰——/compact 立即执行的冷投影读口）：
     *  事件 → ModelMessage[]（压缩/裁剪事件已应用，与 agentLoop 同投影）。
     *  可选——非核心宿主可不提供；消费方必须带回落路径。 */
    messages?(): Promise<ModelMessage[]>;
    /** 会话标识（v3 compaction 设计空白 2——恢复页脚标注「完整历史在哪个会话」；模型用 id +
     *  ~/.orosus/sessions/ 目录指引经 Glob 定位日志文件）。可选——拿不到就省略编号只留目录指引。 */
    readonly id?: string;
  };
  readonly events: {
    /** 订阅事件；拦截点返回 { deny: true, reason } 或抛错 = 否决（waterfall 语义，§6.5 白名单 8 个）。
     *
     * @example
     * ```ts
     * ctx.events.on("tool/pre-execute", (p) => {
     *   const { name } = p as { name: string };
     *   if (name === "note__add") return { deny: true, reason: "便签功能已冻结" };
     *   return undefined;   // undefined = 通过
     * });
     * ```
     */
    on(type: string, listener: Listener): Disposer;
    /** 模块间通知：仅限 <module>/* 命名空间；核心事件类型拒绝模块 emit。
     *
     * @example
     * ```ts
     * // 发：defineModule 里无需白名单，命名空间即边界
     * await ctx.events.emit("note/changed", { count: notes.length });
     * // 收（另一模块）：ctx.events.on("note/changed", (p) => { ... });
     * ```
     */
    emit(type: string, payload: unknown): Promise<void>;
  };
}

/** 模块定义（§5.1 完整形态）。声明式：activate 之前全部静态信息可读。 */
export interface ModuleDefinition<C = unknown> {
  name: string;
  version: string;
  description: string;
  api: number;
  dependsOn?: Dependency[];
  provides?: string[];
  defaultEnabled?: boolean;
  uses?: string[];
  mounts?: string[];
  config?: ZodType<C>;
  logEvents?: string[];
  activate(ctx: ModuleContext<C>): void | { dispose?: Disposer } | Promise<void | { dispose?: Disposer }>;
}

/** 身份函数：仅做类型收窄与作者意图标注，不做运行期处理（校验在 kernel，§4.2 第 4 步）。
 *
 * @example
 * ```ts
 * export default defineModule({
 *   name: "note",                     // kebab-case，全局唯一（规则 4）
 *   version: "0.1.0",
 *   description: "会话便签——模型跨轮次的临时记事本",
 *   api: 1,
 *   config: z.object({ maxNotes: z.number().int().default(20) }),
 *   logEvents: ["note/write"],        // session.append 的白名单
 *   activate(ctx) {
 *     ctx.contribute.tool(myTool);
 *     ctx.contribute.promptSection({ order: 15, get text() { return "## Notes\n..."; } });
 *   },
 * });
 * ```
 */
export function defineModule<C>(def: ModuleDefinition<C>): ModuleDefinition<C> {
  return def;
}
