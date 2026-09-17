import { z } from "zod";
import { defineModule, type ModuleContext } from "@orosus/contracts/module";
import type { Tool } from "@orosus/contracts/tool";
import { toBridgedTool, digest, type ServerToolMeta, type ServerCall } from "./bridge.ts";

export { toBridgedTool, sanitizeToolMeta, digest } from "./bridge.ts";

/** 测试与 activate 共用的连接口：listTools 一次（清单快照语义）+ callTool 按调。 */
export interface ServerConnection {
  listTools(): Promise<ServerToolMeta[]>;
  callTool: ServerCall;
}

export interface ActivateMcpOpts {
  servers: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled?: boolean; accesses?: unknown[] }>;
  connect: (name: string, cfg: { command?: string; args?: string[]; env?: Record<string, string>; url?: string }) => Promise<ServerConnection>;
  sessionAppend: (type: string, payload: Record<string, unknown>) => void;
}

export interface McpActivateOut {
  tools: Tool[];
  failedServers: string[];
}

export async function activateMcp(opts: ActivateMcpOpts): Promise<McpActivateOut> {
  const tools: Tool[] = [];
  const failedServers: string[] = [];
  const manifest: Record<string, string[]> = {};
  for (const [name, cfg] of Object.entries(opts.servers)) {
    if (cfg.enabled === false) continue;
    try {
      const conn = await opts.connect(name, cfg);
      const list = await conn.listTools(); // 清单快照：连接一次取全量（§6.3）
      manifest[name] = list.map((t) => t.name);
      for (const meta of list) {
        tools.push(toBridgedTool(name, meta, conn.callTool, cfg.accesses as never));
      }
    } catch {
      failedServers.push(name); // §10 降级粒度：单 server 失败不株连模块
    }
  }
  if (Object.keys(manifest).length > 0) {
    opts.sessionAppend("mcp/manifest", { digest: digest(manifest), servers: manifest }); // 计划补空白的 digest 落点
  }
  return { tools, failedServers };
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
    })).default({}),
  }),
  logEvents: ["mcp/manifest"],
  mounts: ["contribute:tool"],
  async activate(ctx: ModuleContext<{ servers: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled?: boolean; accesses?: unknown[] }> }>) {
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
        await client.connect(transport as never); // SDK 传输联合类型在 exactOptionalPropertyTypes 下的摩擦——运行时无歧义
        return {
          listTools: async () => {
            const res = await client.listTools({});
            return res.tools as never;
          },
          callTool: async (toolName, args, signal) => {
            const res = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> }, undefined, { signal });
            return res as never;
          },
        };
      },
      sessionAppend: (type, payload) => void ctx.session.append(type, payload),
    });
    for (const t of out.tools) ctx.contribute.tool(t);
  },
});
