import type { ZodType } from "zod";
import type { Tool } from "../tool/index.ts";

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

/** 斜杠命令处理器：/<module>__<command>。 */
export type CommandHandler = (args: string) => Promise<string> | string;

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
  readonly services: {
    /** 硬依赖能力：拓扑序保证 activate 期间必有值。 */
    get<T>(key: CapabilityKey<T>): Promise<T>;
    /** 可选能力：调用时解析，可能 undefined（迟到绑定）。 */
    getOptional<T>(key: CapabilityKey<T>): Promise<T | undefined>;
  };
  /** 提供能力实现（单所有者槽）；key 须 ⊆ 声明区 provides（唯一例外：核心保留槽 key）。 */
  provide(key: string, impl: unknown): void;
  readonly contribute: {
    tool(t: Tool): Disposer;
    command(name: string, handler: CommandHandler): Disposer;
    promptSection(s: PromptSection): Disposer;
  };
  readonly session: {
    /** 写会话日志扩展事件；type 须已在 logEvents 声明（白名单）。 */
    append(type: string, payload: Record<string, unknown>): void;
  };
  readonly events: {
    on(type: string, listener: Listener): Disposer;
    /** 模块间通知：仅限 <module>/* 命名空间；核心事件类型拒绝模块 emit。 */
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

/** 身份函数：仅做类型收窄与作者意图标注，不做运行期处理（校验在 kernel，§4.2 第 4 步）。 */
export function defineModule<C>(def: ModuleDefinition<C>): ModuleDefinition<C> {
  return def;
}
