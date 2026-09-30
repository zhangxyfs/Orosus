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

/** 桥接工具名上限（MI-07）：OpenAI/Anthropic 工具名约束 ^[a-zA-Z0-9_-]{1,64}$——超长即每个请求 400。 */
const TOOL_NAME_LIMIT = 64;

/** description 不受信输入（§8.5）：非 string 归空、超长截断、来源标记前缀（防 tool poisoning 的可见性标记）。 */
export function sanitizeToolMeta(server: string, name: string, description: unknown): { name: string; description: string } {
  const raw = typeof description === "string" ? description : "";
  const tagged = raw === "" ? `[mcp:${server}]` : `[mcp:${server}] ${raw}`;
  return { name, description: tagged.slice(0, DESCRIPTIION_LIMIT) };
}

/** server instructions 不受信输入消毒（MI-15 修复，2026-09-28 code review P3）：initialize 的 instructions 与
 *  tool description 同源同险（MCP tool poisoning 的注入通道），但旧实现原样直进系统提示段——无来源标记、
 *  无长度上限（仅外层 promptSection 32KB 段帽兜底）。对齐 sanitizeToolDescription 纪律：`[mcp:<server>]`
 *  来源前缀 + 4096 截断；非 string / 空串 → undefined（回落工具清单行，不装占位）。 */
export function sanitizeServerInstructions(server: string, raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  return `[mcp:${server}] ${raw}`.slice(0, DESCRIPTIION_LIMIT);
}

/** MI-07 修复（2026-09-28 code review P2，kimi sanitizeMcpNamePart 同款）+ T4 补强（m4-3c）：server id
 *  （用户 config 键）与工具名（server 清单原样名）都是不受信输入——非法字符（./空格/CJK）或超长直拼
 *  mcp__{server}__{name} 会令 provider 拒收**每个**请求；消毒后撞名在 registry throw 则整个 mcp 模块降级。
 *  规则：[^a-zA-Z0-9_-] → `_`、连续下划线折叠成一个（T4①——替换产物 "a..b"→"a__b" 不留双杠）、
 *  空段保底 `_`。 */
export function sanitizeMcpNamePart(part: string): string {
  const clean = part.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_{2,}/g, "_");
  return clean === "" ? "_" : clean;
}

/** 桥接工具注册名（消毒后——模型面/审批规则/注册表都只见这个名；server 调用仍用原样名）。
 *  T4②（m4-3c）：凡名字被改动过（替换/折叠/空段保底）或超长，一律追加 8 位哈希后缀——哈希按**原样名**
 *  算，保证两侧都变形（server "x.y" vs "x_y"）时后缀也互不撞。旧实现只有超长截断才加后缀：「a.b」与
 *  「a_b」洗成同名只能跳过后者（少一个工具能用）；现在两个都在、各得其所。 */
export function bridgedToolName(server: string, tool: string): string {
  const full = `mcp__${sanitizeMcpNamePart(server)}__${sanitizeMcpNamePart(tool)}`;
  const raw = `mcp__${server}__${tool}`;
  if (full === raw && full.length <= TOOL_NAME_LIMIT) return full; // 原样即合法——零改动直用
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${full.slice(0, TOOL_NAME_LIMIT - 9)}_${hash}`;
}

/** server inputSchema → zod meta 透传（MI-03 修复，2026-09-28 code review P1）。
 *  契约 parameters: ZodType 强制 zod，而 zod 4.x 无 JSON-Schema 包装类型（z.jsonSchema 不存在）——但核心
 *  specs() 的 z.toJSONSchema 会把 .meta() 注册键作为 **sibling 字段**输出：properties/required 覆写空对象
 *  基线，模型因此在 tools[].parameters 里看到真实参数（不再是空参数面）。只透传这两个可见性键——
 *  additionalProperties 等会与 zod 自身输出撞键（谁赢无定义），不冒险。本地校验保持宽松 passthrough：
 *  server 侧自校验才是权威，JSON-Schema→zod 全量转换的误差可能误拒合法调用。 */
function schemaMetaOf(inputSchema: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (inputSchema === undefined || inputSchema.type !== "object") return undefined;
  const meta: Record<string, unknown> = {};
  const props = inputSchema.properties;
  if (props !== undefined && typeof props === "object" && !Array.isArray(props)) meta.properties = props;
  if (Array.isArray(inputSchema.required)) meta.required = inputSchema.required;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** server 清单 digest（§6.3 清单快照——mcp/manifest 事件载荷；确定性：名称排序后哈希）。 */
export function digest(servers: Record<string, string[]>): string {
  const normalized = Object.keys(servers).sort().map((k) => `${k}:${[...(servers[k] ?? [])].sort().join(",")}`).join(";");
  return createHash("sha256").update(normalized).digest("hex");
}

/** 桥接工具构造（§6.3 两规则）：三段名 mcp__<server>__<tool>（MI-07：两段消毒后拼装——注册/审批/模型面
 *  用注册名，server 调用用原样名）；accesses 缺省 fail-closed [all]，server 级声明可放宽。
 *  deferred（M4-3 T5）：server 级「按需加载」标记透传——tool-search 未启用时标记不生效（SW-26 联动）。 */
export function toBridgedTool(server: string, meta: ServerToolMeta, call: ServerCall, accesses?: AccessT[], deferred?: boolean): Tool {
  const clean = sanitizeToolMeta(server, meta.name, meta.description);
  const toolName = bridgedToolName(server, meta.name); // MI-07：注册名消毒（server 调用仍用 meta.name）
  // MI-03：inputSchema 有效（type:object 且带 properties/required）→ .meta() sibling 透传进 specs() 参数面；
  // 缺省/无效 → 宽松收集（server 侧自校验）。旧实现两分支同为空 object（inputSchema 两条路都丢——模型看不到参数）。
  const loose = z.object({}).passthrough();
  const schemaMeta = schemaMetaOf(meta.inputSchema);
  return defineTool({
    name: toolName,
    description: clean.description,
    ...(deferred === true ? { deferred: true } : {}),
    parameters: schemaMeta !== undefined ? loose.meta(schemaMeta) : loose,
    resolveExecution: async (input) => ({
      accesses: accesses ?? [Access.all()],
      approvalRule: toolName,
      execute: async (tctx): Promise<ToolResult> => {
        try {
          const result = await call(meta.name, input, tctx.signal);
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
