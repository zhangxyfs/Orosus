import { z } from "zod";
import { defineModule, type ModuleContext } from "@orosus/contracts/module";
import type { Tool } from "@orosus/contracts/tool";
import { toBridgedTool, digest, type ServerToolMeta, type ServerCall } from "./bridge.ts";

export { toBridgedTool, sanitizeToolMeta, sanitizeMcpNamePart, bridgedToolName, digest } from "./bridge.ts";

/** 测试与 activate 共用的连接口：listTools 一次（清单快照语义）+ callTool 按调。 */
export interface ServerConnection {
  listTools(): Promise<ServerToolMeta[]>;
  callTool: ServerCall;
  /** server 指令（MCP initialize 的 instructions 字段）——M4-2 T12 promptSection 用；缺省无。 */
  instructions?(): Promise<string | undefined>;
  /** MI-02（2026-09-28 code review P1）：连接生命周期收尾——模块 dispose（reload 换代/停用）时关
   *  client（stdio transport 随之杀子进程）。缺省无（fake 连接无需）。 */
  close?(): Promise<void>;
}

export interface ActivateMcpOpts {
  servers: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled?: boolean; accesses?: unknown[]; deferred?: boolean }>;
  connect: (name: string, cfg: { command?: string; args?: string[]; env?: Record<string, string>; url?: string }) => Promise<ServerConnection>;
  sessionAppend: (type: string, payload: Record<string, unknown>) => void;
}

export interface McpActivateOut {
  tools: Tool[];
  failedServers: string[];
  /** 连接成功登记（M4-2 T12）：config 声明但未连的不列——promptSection 只写真连接。 */
  connected: { name: string; tools: string[]; instructions?: string }[];
  /** MI-07：消毒后撞名被跳过的工具（带内记录——不进 registry〔重名 throw 会降级整个模块〕）。
   *  如 server 清单同时提供 "a.b" 与 "a_b"——两段消毒后同注册名，保留首个、跳过后来者。 */
  skippedTools: { server: string; tool: string; reason: string }[];
  /** MI-02：逐个关成功建立的连接（close 缺省的 fake 连接跳过）；单个失败不株连其余。 */
  close(): Promise<void>;
}

export async function activateMcp(opts: ActivateMcpOpts): Promise<McpActivateOut> {
  const tools: Tool[] = [];
  const failedServers: string[] = [];
  const connected: { name: string; tools: string[]; instructions?: string }[] = [];
  const manifest: Record<string, string[]> = {};
  const conns: ServerConnection[] = [];
  const skippedTools: McpActivateOut["skippedTools"] = [];
  const seenNames = new Set<string>(); // 注册名去重（MI-07）：registry 对非墓碑重名 throw → 整模块降级
  const mapping: Record<string, Record<string, string>> = {}; // MI-07：消毒改名映射（原样名 → 注册名），manifest 事件可观测
  for (const [name, cfg] of Object.entries(opts.servers)) {
    if (cfg.enabled === false) continue;
    try {
      const conn = await opts.connect(name, cfg);
      const list = await conn.listTools(); // 清单快照：连接一次取全量（§6.3）
      conns.push(conn);
      manifest[name] = list.map((t) => t.name);
      for (const meta of list) {
        const tool = toBridgedTool(name, meta, conn.callTool, cfg.accesses as never, cfg.deferred === true); // server 级 deferred 透传（M4-3 T5）
        if (seenNames.has(tool.name)) {
          // MI-07 带内跳过：消毒后撞名——进 registry 会 throw（整模块降级），跳过后来者并记录
          skippedTools.push({ server: name, tool: meta.name, reason: `消毒后注册名撞车：${tool.name}` });
          continue;
        }
        seenNames.add(tool.name);
        if (tool.name !== `mcp__${name}__${meta.name}`) (mapping[name] ??= {})[meta.name] = tool.name;
        tools.push(tool);
      }
      let instructions: string | undefined;
      try {
        instructions = (await conn.instructions?.()) ?? undefined;
      } catch { /* 指令取不到不株连连接 */ }
      connected.push({ name, tools: manifest[name]!, ...(instructions !== undefined ? { instructions } : {}) });
    } catch {
      failedServers.push(name); // §10 降级粒度：单 server 失败不株连模块
    }
  }
  if (Object.keys(manifest).length > 0) {
    // 计划补空白的 digest 落点；MI-07：消毒改名映射与跳过清单随事件落盘（digest 仍按 server 原样清单算——与 server 侧可对账）
    opts.sessionAppend("mcp/manifest", {
      digest: digest(manifest),
      servers: manifest,
      ...(Object.keys(mapping).length > 0 ? { mapping } : {}),
      ...(skippedTools.length > 0 ? { skipped: skippedTools } : {}),
    });
  }
  // MI-02：close 幂等（重复调用无二次副作用）——模块 dispose 与装配失败清理都可能触达
  let closed = false;
  return {
    tools, failedServers, connected, skippedTools,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const c of conns) await c.close?.().catch(() => undefined);
    },
  };
}

/** fake ctx session.append 捕获（测试用）。 */
export const appendLog = {
  capture(): Array<{ t: string; p: Record<string, unknown> }> {
    return [];
  },
};

export const collectTools = (out: McpActivateOut): Tool[] => out.tools;

export async function runTool(tool: Tool, args: unknown) {
  const exec = await tool.resolveExecution(args);
  return exec.execute({ callId: "c", signal: new AbortController().signal, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
}

export const mcpDef = defineModule({
  name: "mcp",
  version: "0.1.0",
  description: "MCP server 桥接为工具（清单快照 digest + 不受信 description 消毒 + accesses fail-closed）",
  api: 1,
  uses: ["subprocess", "network"],
  config: z.object({
    servers: z.record(z.string(), z.object({
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      url: z.string().optional(),
      enabled: z.boolean().optional(),
      accesses: z.array(z.unknown()).optional(),
      // ToolSearch 按需加载（M4-3 T5，kimi server 级开关同款边界——只有 MCP 工具可被隐藏）：
      // true = 该 server 的桥接工具全标 deferred；tool-search 未启用时标记不生效（SW-26 联动，照常全量进请求）
      deferred: z.boolean().optional(),
    })).default({}),
  }),
  logEvents: ["mcp/manifest"],
  mounts: ["contribute:tool", "contribute:promptSection"],
  async activate(ctx: ModuleContext<{ servers: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled?: boolean; accesses?: unknown[]; deferred?: boolean }> }>) {
    // M1 SDK 接线：stdio（command/args/env）与 HTTP（url）两 transport——实现期联调，测试注入 fake connect
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const out = await activateMcp({
      servers: ctx.config.servers,
      connect: async (name, cfg) => {
        const transport = cfg.url !== undefined
          ? new StreamableHTTPClientTransport(new URL(cfg.url))
          : new StdioClientTransport({ command: cfg.command!, args: cfg.args ?? [], ...(cfg.env !== undefined ? { env: cfg.env } : {}) });
        const client = new Client({ name: `orosus-mcp-${name}`, version: "0.1.0" });
        try {
          await client.connect(transport as never); // SDK 传输联合类型在 exactOptionalPropertyTypes 下的摩擦——运行时无歧义
        } catch (err) {
          await client.close().catch(() => undefined); // 半开连接不悬空（MI-02：连接失败也收尾）
          throw err;
        }
        return {
          listTools: async () => {
            const res = await client.listTools({});
            return res.tools as never;
          },
          callTool: async (toolName, args, signal) => {
            const res = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> }, undefined, { signal });
            return res as never;
          },
          instructions: async () => (client as unknown as { getServerInstructions?: () => string | undefined }).getServerInstructions?.(),
          close: async () => { await client.close(); }, // MI-02：stdio transport 随 close 杀子进程
        };
      },
      sessionAppend: (type, payload) => void ctx.session.append(type, payload),
    });
    for (const t of out.tools) ctx.contribute.tool(t);
    // MI-07：撞名跳过的带内可观测面（registry 不再因重名 throw——模块不降级，但用户须能看到少了哪些工具）
    for (const sk of out.skippedTools) ctx.log.warn("mcp.tool-skipped", `工具 "${sk.tool}"（server ${sk.server}）未注册：${sk.reason}`, { server: sk.server, tool: sk.tool });
    // server 指令节（M4-2 T12，order 20——todo=10 之后、AGENTS.md 拼尾之前）：
    // 有 instructions 用 instructions，否则列工具清单；零连接 = 空段（getter 活读——T7 起段注册保 getter）
    ctx.contribute.promptSection({
      order: 20,
      get text() {
        if (out.connected.length === 0) return "";
        return `## MCP Server Instructions\n${out.connected.map((s) =>
          `### ${s.name}\n${s.instructions ?? `Tools: ${s.tools.map((t) => t).join(", ")}`}`
        ).join("\n\n")}`;
      },
    });
    // MI-02 修复（2026-09-28 code review P1）：旧实现 activate 无 dispose——reload 换代/停用时 MCP 子进程
    // 全量泄漏（每次 reload 漏一批 stdio client）。返回 close 口挂进内核既有拆除链。
    return { dispose: () => out.close() };
  },
});
