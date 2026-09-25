import type { ZodType } from "zod";
import type { Logger } from "../module/index.ts";

/**
 * 单次工具调用的资源访问声明（§6.3）：给并发调度器与审批系统。缺省 = { kind: "all" }（独占）。
 * 四形态：文件读（fs.read + path）/文件写（fs.write + path）/网络（network + host）/子进程（subprocess）。
 * @example
 * ```ts
 * // 读一个文件 + 访一个域名
 * accesses: [Access.fsRead("/tmp/a.txt"), Access.network("api.example.com")]
 * ```
 */
export type Access =
  | { kind: "fs.read" | "fs.write"; path: string }
  | { kind: "network"; host: string }
  | { kind: "subprocess" }
  | { kind: "all" };

/** Access 四形态的便捷构造器（与上方联合类型同名导出。 */
export const Access = {
  fsRead: (path: string): Access => ({ kind: "fs.read", path }),
  fsWrite: (path: string): Access => ({ kind: "fs.write", path }),
  network: (host: string): Access => ({ kind: "network", host }),
  subprocess: (): Access => ({ kind: "subprocess" }),
  all: (): Access => ({ kind: "all" }),
} as const;

/** 工具结果统一形状（§6.3）。denied: true 表示被 waterfall 否决（此时 isError 恒为 true）。 */
export interface ToolResult {
  output: string;
  isError: boolean;
  truncated?: boolean;
  spill?: { path: string; bytes: number };
  denied?: boolean;
}

/** 工具执行期上下文。signal 供取消传播（长耗时工具必须响应）；callId 关联 tool/call 与 tool/result。 */
export interface ToolContext {
  callId: string;
  signal: AbortSignal;
  log: Logger;
}

/** 阶段一产出：声明（无副作用）+ 执行闭包（唯一产生副作用的环节）。 */
export interface ToolExecution {
  accesses?: Access[];
  /** 审批规则 pattern（数据），如 "tool-shell__bash(rm -rf*)"；缺省 = 需要审批（fail-closed）。 */
  approvalRule?: string;
  /**
   * 规则参数的工具侧语义判定；缺省 = 不匹配任何带参规则（fail-closed）。
   * @param ruleArgs - 审批规则后括号内的参数串（如 "rm -rf*"）；返回 true = 本次调用匹配该规则。
   */
  matchesRule?: (ruleArgs: string) => boolean;
  /**
   * 执行（唯一副作用点）。错误带内——不许 reject，返回 { output, isError: true }。
   * @param ctx - 执行期上下文（取消信号必须响应——长耗时工具要监听 ctx.signal；callId 关联日志；log 记过程）。
   * @returns 统一结果形状（见 ToolResult；超大输出走 spill 落盘）。
   */
  execute(ctx: ToolContext): Promise<ToolResult>;
}

/** 两阶段工具契约（§6.3）。name 强制 <module>__<tool>（规则 4）。 */
export interface Tool {
  name: string;
  description: string;
  parameters: ZodType;
  /** 人类可读显示名（2026-09-24 用户拍板）：消息窗口工具行优先呈现（如 "Web Search"）——
   *  模型面永远用 name（调用/审批/配置不受影响）；缺省 = 宿主剥 <module>__ 前缀现算（旧行为）。 */
  label?: string;
  /** 按需加载标记（M4-3 T4/D6）：真 = 该工具可被 ToolSearch 机制隐藏（schema 不进请求，
   *  目录只知名+截断描述，经 tool-search__search 搜出并 reveal 后恢复）。tool-search 关态 = 标记
   *  不生效（SW-26 联动规则——防「标了 deferred 却无 meta 工具可 reveal」永不可达组合）。 */
  deferred?: boolean;
  /** 搜索补充关键词（目录呈现与打分的补充语料——cc-haha searchHint 同款）。 */
  searchHint?: string;
  /**
   * 阶段一：声明（无副作用）——内核拿它跑并发调度与审批水缑；不许在此产生副作用。
   * @param input - 模型给的参数（已过 parameters schema 校验；自行 as 收窄类型）。
   * @returns 阶段二产出（accesses/approvalRule/execute——见 ToolExecution）。
   */
  resolveExecution(input: unknown): Promise<ToolExecution>;
}

/** ctx.tools.list 的出货形态（M4-3 T4）：目录数据源——只知名/描述/标记/reveal 态，不给 schema。 */
export interface ToolInfo {
  name: string;
  description: string;
  deferred: boolean;
  searchHint?: string | undefined;
  /** 显示名透传（宿主渲染层消费——目录段不展示）。 */
  label?: string | undefined;
  /** 已被 reveal（本轮起 schema 进请求——目录段应略过）。 */
  revealed: boolean;
  /** 注册属主模块名（MCP 桥接工具 = "mcp"——打分的 MCP 加权依据）。 */
  owner: string;
}

/** 身份函数：类型收窄与作者意图标注。
 *
 * @example
 * ```ts
 * const tool = defineTool({
   *   name: "note__add",                    // 强制 <module>__<tool>（规则 4）
   *   description: "Add a short note that persists across turns.",
   *   parameters: z.object({ text: z.string().min(1) }),
   *   label: "Note Add",                    // 可选：工具行显示名（缺省 = 宿主剥前缀）
 *   resolveExecution: async (input) => {
 *     const { text } = input as { text: string };
 *     return {
 *       accesses: [],                      // 不碰资源 = 空声明；缺省会按 kind:"all" 独占
 *       approvalRule: "note__add",
 *       execute: async () => ({ output: `Noted: ${text}`, isError: false }),
 *     };
 *   },
 * });
 * ```
 */
/**
 * @param t - 工具定义（字段含义与范围见 Tool；name 强制 <module>__<tool> 前缀）。
 * @returns 原定义对象（类型收窄 + 意图标注，不做运行期处理）。
 */
export function defineTool(t: Tool): Tool {
  return t;
}
