import { createHash } from "node:crypto";
import { z } from "zod";
import { Access, defineTool, type Access as AccessT, type Tool, type ToolResult } from "@orosus/contracts/tool";

/** server 工具的原始清单（握手结果——§6.3 清单快照的数据源）。 */
export interface ServerToolMeta {
  name: string;
  description: unknown; // 不受信输入（§8.5）——类型不定
  inputSchema?: Record<string, unknown>;
}

/** server 侧调用句柄（SDK 适配层注入；测试注入 fake）。T8 起返回面按 MCP CallToolResult 全形：
 *  content 块数组（text/image/audio/resource_link/…）+ structuredContent（结构化数据）+ isError。 */
export type ServerCall = (
  name: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<{ content?: unknown[]; structuredContent?: unknown; isError?: boolean }>;

const DESCRIPTIION_LIMIT = 4096; // §8.5 不受信消毒：4KB 截断

/** T9 隐形字符清洗（m4-3c，cc-haha 记录的真实攻击案例防御）：server 提供的描述/说明书是不可信输入，
 *  零宽字符与双向控制符能夹带人眼看不见的模型指令（Trojan Source 同款机理）。NFC 归一后删除：
 *  零宽族（U+200B-F）、双向控制族（U+202A-E / U+2066-9 / U+061C）、不可见操作符（U+2060-4）、
 *  BOM/软连字符（U+FEFF/U+00AD）、行间注记（U+FFF9-B）、C0 控制字符（保留 \n\r\t——合法排版）与 DEL。
 *  可见文字原样保留——清洗目标是「看不见的」，不是「不想看的」。 */
// oxlint-disable-next-line no-control-regex -- 清洗件的职责就是匹配控制字符，非误用
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]/g;
export function stripInvisible(raw: string): string {
  return raw.normalize("NFC").replace(INVISIBLE_RE, "");
}

/** 桥接工具名上限（MI-07）：OpenAI/Anthropic 工具名约束 ^[a-zA-Z0-9_-]{1,64}$——超长即每个请求 400。 */
const TOOL_NAME_LIMIT = 64;

/** description 不受信输入（§8.5）：非 string 归空、隐形字符清洗（T9）、超长截断、来源标记前缀（防 tool poisoning 的可见性标记）。 */
export function sanitizeToolMeta(server: string, name: string, description: unknown): { name: string; description: string } {
  const raw = typeof description === "string" ? stripInvisible(description) : "";
  const tagged = raw === "" ? `[mcp:${server}]` : `[mcp:${server}] ${raw}`;
  return { name, description: tagged.slice(0, DESCRIPTIION_LIMIT) };
}

/** server instructions 不受信输入消毒（MI-15 修复，2026-09-28 code review P3）：initialize 的 instructions 与
 *  tool description 同源同险（MCP tool poisoning 的注入通道），但旧实现原样直进系统提示段——无来源标记、
 *  无长度上限（仅外层 promptSection 32KB 段帽兜底）。对齐 sanitizeToolDescription 纪律：`[mcp:<server>]`
 *  来源前缀 + 4096 截断；非 string / 空串 → undefined（回落工具清单行，不装占位）。 */
export function sanitizeServerInstructions(server: string, raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  return `[mcp:${server}] ${stripInvisible(raw)}`.slice(0, DESCRIPTIION_LIMIT);
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

/** T8 结果展示（m4-3c，qwen 占位形态参照）：server 返回四种内容的落地面——
 *  纯文字直收；结构化数据与文字相同则去重、不同则附后（qwen 等三家同款）；图片音频给占位行
 *  （类型+大小——工具结果通道是纯文本，图进不来〔带图通道在不做清单顺延〕）；资源链接转一行可读文字；
 *  全空明确说「没有返回内容」；不认识的块也明说一行（不静默丢——静默丢过 cc-haha 投毒案例的同款盲区）。
 *  isError 透传（server 标记的失败不再被硬编码 false 吞掉）。 */
export function renderToolResult(result: { content?: unknown[]; structuredContent?: unknown; isError?: boolean }): { output: string; isError: boolean } {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const lines: string[] = [];
  for (const b of blocks) {
    if (typeof b === "string") {
      lines.push(b); // 旧形态宽容（非 SDK 规范但历史出现过的裸字符串块）
      continue;
    }
    const blk = b as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown; uri?: unknown; name?: unknown };
    if (blk?.type === "text") {
      lines.push(typeof blk.text === "string" ? blk.text : JSON.stringify(blk.text));
    } else if (blk?.type === "image" || blk?.type === "audio") {
      const mime = typeof blk.mimeType === "string" ? blk.mimeType : "未知类型";
      const bytes = typeof blk.data === "string" ? Math.max(0, Math.floor((blk.data.length * 3) / 4)) : 0;
      const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} 字节`;
      lines.push(`（${blk.type === "image" ? "图片" : "音频"}：${mime}，约 ${size}——工具结果通道暂只支持文本，内容未带回）`);
    } else if (blk?.type === "resource_link") {
      const uri = typeof blk.uri === "string" ? blk.uri : JSON.stringify(blk.uri);
      const nm = typeof blk.name === "string" && blk.name !== "" ? blk.name : uri;
      lines.push(`资源链接：${nm} <${uri}>`);
    } else {
      const t = blk !== null && typeof blk === "object" && typeof blk.type === "string" ? `：${String(blk.type)}` : "";
      lines.push(`（未识别的内容块${t}，已跳过渲染）`);
    }
  }
  if (result.structuredContent !== undefined) {
    // 去重比对认两种序列化形态：紧凑（server 常把 structuredContent 序列化成 text 回带）与缩进（我方落盘形态）
    const compact = JSON.stringify(result.structuredContent).trim();
    const pretty = JSON.stringify(result.structuredContent, null, 2).trim();
    if (!lines.some((l) => {
      const t = l.trim();
      return t === compact || t === pretty;
    })) lines.push(pretty); // 与文字相同不重复、不同附后
  }
  const isError = result.isError === true;
  if (lines.length === 0) return { output: "（server 没有返回内容）", isError };
  return { output: lines.join("\n"), isError };
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
    searchHint: `mcp ${server}`, // T19①（m4-3c）：搜「mcp github」比搜工具全名容易命中；只参与打分不显示（cc-haha 对照实验）
    ...(deferred === true ? { deferred: true } : {}),
    parameters: schemaMeta !== undefined ? loose.meta(schemaMeta) : loose,
    resolveExecution: async (input) => ({
      accesses: accesses ?? [Access.all()],
      approvalRule: toolName,
      execute: async (tctx): Promise<ToolResult> => {
        try {
          const result = await call(meta.name, input, tctx.signal);
          return renderToolResult(result); // T8：四类内容落地 + isError 透传
        } catch (err) {
          return { output: String(err instanceof Error ? err.message : err), isError: true };
        }
      },
    }),
  });
}

/** 懒启动 schema 补丁（2026-09-30 修「模型看不到参数面」：静态清单注册的工具无 inputSchema →
 *  specs() 空参数面 → 模型瞎发参数吃 server 校验错——首连成功后拿实况 listTools 把真 schema
 *  补进已注册工具）。**就地换 parameters**：registry 条目身份/注册名/顺序全不动（tools 数组字节
 *  稳定、reveal 态按名存活、provider 缓存前缀不炸）；描述保留静态清单的策展版不动。activate 后
 *  contribute.tool 进死 stage、模块侧 disposer 是 no-op（M1 已知限制）——重注册路线走不通，这是
 *  唯一零扰动的换血口。名单漂移维持优雅降级（实况多出的名字进不来、静态名不在实况照旧 Unknown
 *  tool）——两边都带回报告供日志。 */
export function applyLiveList(tools: readonly Tool[], server: string, list: readonly ServerToolMeta[]): {
  applied: string[];
  /** 实况有、已注册集合没有——无法后补注册（进不来），仅报告 */
  liveExtra: string[];
  /** 静态清单有、实况没有——schema 维持空面，调用会吃 server 的 Unknown tool（原优雅降级） */
  stale: string[];
} {
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  const applied: string[] = [];
  const liveExtra: string[] = [];
  for (const meta of list) {
    const tool = byName.get(bridgedToolName(server, meta.name));
    if (tool === undefined) {
      liveExtra.push(meta.name);
      continue;
    }
    const schemaMeta = schemaMetaOf(meta.inputSchema);
    if (schemaMeta !== undefined) {
      (tool as { parameters: Tool["parameters"] }).parameters = z.object({}).passthrough().meta(schemaMeta);
      applied.push(meta.name);
    }
  }
  const liveRegistered = new Set(list.map((m) => bridgedToolName(server, m.name)));
  const stale = [...byName.keys()].filter((n) => n.startsWith(`mcp__${sanitizeMcpNamePart(server)}__`) && !liveRegistered.has(n));
  return { applied, liveExtra, stale };
}
