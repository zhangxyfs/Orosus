import type { ZodType } from "zod";
import type { Logger } from "../module/index.ts";

/** 单次工具调用的资源访问声明（§6.3）：给并发调度器与审批系统。缺省 = { kind: "all" }（独占）。 */
export type Access =
  | { kind: "fs.read" | "fs.write"; path: string }
  | { kind: "network"; host: string }
  | { kind: "subprocess" }
  | { kind: "all" };

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
  /** 规则参数的工具侧语义判定；缺省 = 不匹配任何带参规则（fail-closed）。 */
  matchesRule?: (ruleArgs: string) => boolean;
  execute(ctx: ToolContext): Promise<ToolResult>;
}

/** 两阶段工具契约（§6.3）。name 强制 <module>__<tool>（规则 4）。 */
export interface Tool {
  name: string;
  description: string;
  parameters: ZodType;
  /** 按需加载标记（M4-3 T4/D6）：真 = 该工具可被 ToolSearch 机制隐藏（schema 不进请求，
   *  目录只知名+截断描述，经 tool-search__search 搜出并 reveal 后恢复）。tool-search 关态 = 标记
   *  不生效（SW-26 联动规则——防「标了 deferred 却无 meta 工具可 reveal」永不可达组合）。 */
  deferred?: boolean;
  /** 搜索补充关键词（目录呈现与打分的补充语料——cc-haha searchHint 同款）。 */
  searchHint?: string;
  resolveExecution(input: unknown): Promise<ToolExecution>;
}

/** ctx.tools.list 的出货形态（M4-3 T4）：目录数据源——只知名/描述/标记/reveal 态，不给 schema。 */
export interface ToolInfo {
  name: string;
  description: string;
  deferred: boolean;
  searchHint?: string | undefined;
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
export function defineTool(t: Tool): Tool {
  return t;
}
