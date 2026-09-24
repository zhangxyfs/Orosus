import { createHash } from "node:crypto";
import { z } from "zod";
import { Access, defineTool, type Access as AccessT, type Tool, type ToolResult } from "@orosus/contracts/tool";

/** server 工具的原始清单（握手结果——§6.3 清单快照的数据源）。 */
export interface ServerToolMeta {
  name: string;
  description: unknown; // 不受信输入（§8.5）——类型不定
  inputSchema?: Record<string, unknown>;
}

/** server 侧调用句柄（SDK 适配层注入；测试注入 fake）。 */
export type ServerCall = (name: string, args: unknown, signal: AbortSignal) => Promise<{ content: unknown[] }>;

const DESCRIPTIION_LIMIT = 4096; // §8.5 不受信消毒：4KB 截断

/** description 不受信输入（§8.5）：非 string 归空、超长截断、来源标记前缀（防 tool poisoning 的可见性标记）。 */
export function sanitizeToolMeta(server: string, name: string, description: unknown): { name: string; description: string } {
  const raw = typeof description === "string" ? description : "";
  const tagged = raw === "" ? `[mcp:${server}]` : `[mcp:${server}] ${raw}`;
  return { name, description: tagged.slice(0, DESCRIPTIION_LIMIT) };
}

/** server 清单 digest（§6.3 清单快照——mcp/manifest 事件载荷；确定性：名称排序后哈希）。 */
export function digest(servers: Record<string, string[]>): string {
  const normalized = Object.keys(servers).sort().map((k) => `${k}:${[...(servers[k] ?? [])].sort().join(",")}`).join(";");
  return createHash("sha256").update(normalized).digest("hex");
}

/** 桥接工具构造（§6.3 两规则）：三段名 mcp__<server>__<tool>；accesses 缺省 fail-closed [all]，server 级声明可放宽。
 *  deferred（M4-3 T5）：server 级「按需加载」标记透传——tool-search 未启用时标记不生效（SW-26 联动）。 */
export function toBridgedTool(server: string, meta: ServerToolMeta, call: ServerCall, accesses?: AccessT[], deferred?: boolean): Tool {
  const clean = sanitizeToolMeta(server, meta.name, meta.description);
  const params = meta.inputSchema !== undefined && meta.inputSchema.type === "object"
    ? z.object({}).passthrough()
    : z.object({}).passthrough(); // inputSchema 透传不做强 schema（server 侧自校验；缺省宽松收集）
  return defineTool({
    name: `mcp__${server}__${clean.name}`,
    description: clean.description,
    ...(deferred === true ? { deferred: true } : {}),
    parameters: params,
    resolveExecution: async (input) => ({
      accesses: accesses ?? [Access.all()],
      approvalRule: `mcp__${server}__${clean.name}`,
      execute: async (tctx): Promise<ToolResult> => {
        try {
          const result = await call(clean.name, input, tctx.signal);
          const text = result.content
            .map((c) => (typeof c === "string" ? c : ((c as { text?: unknown }).text !== undefined ? String((c as { text: string }).text) : JSON.stringify(c))))
            .join("\n");
          return { output: text, isError: false };
        } catch (err) {
          return { output: String(err instanceof Error ? err.message : err), isError: true };
        }
      },
    }),
  });
}
