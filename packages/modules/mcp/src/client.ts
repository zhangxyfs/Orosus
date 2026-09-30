import type { ServerConnection } from "./index.ts";

/** 连接超时默认值（T1，kimi 同值）：再长用户会以为死机。预装件首启另用 60s（T20）。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** 调用超时默认值（T2 自定值）：比 opencode 默认（30s）宽一档，给长任务余地；server 级 timeoutMs 可调大。 */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** 翻页页数帽（T3，opencode 同款上限）：server 恒新游标（死循环保险拦不住）时的最后防线。 */
export const MAX_LIST_PAGES = 1000;

/** 工具清单翻页（T3）：循环到 nextCursor 缺省为止。两道保险——① 同一 nextCursor 第二次出现即停
 *  （防 server 死循环：好 server 的游标单向推进，重复出现 = 环）；② 页数帽 1000（防恒新游标刷屏）。
 *  抽成独立助手：两道保险可用零开销 fake 直测（1000 页真跑要秒级）。 */
export async function collectAllPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ tools: T[]; nextCursor?: string }>,
): Promise<T[]> {
  const all: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await fetchPage(cursor);
    all.push(...res.tools);
    if (res.nextCursor === undefined) break;
    if (seenCursors.has(res.nextCursor)) break; // 环检测：同一游标二次出现
    seenCursors.add(res.nextCursor);
    cursor = res.nextCursor;
  }
  return all;
}

/** SDK 适配层选项：测试可缩时（e2e 不等 30/60 秒）。 */
export interface SdkConnectOpts {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

/** createSdkConnection 的配置面（与 activateMcp 的 server 条目同形）。
 *  headers（T5）：远程 server 鉴权头——值可写 $ENV:VAR（config 层 ENV_PLACEHOLDER 全局语法，零新码）；
 *  cwd（T5）：子进程工作目录（stdio 型）。 */
export interface SdkServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  cwd?: string;
}

/** SDK 连接实现（m4-3c T1 起从 index.ts 抽出）：stdio（command/args/env）与 HTTP（url）两 transport。
 *  行为契约（连接类任务逐个落位）：
 *  - T1：连接带超时（默认 30s）——超时/失败都 client.close() 收尾，stdio 子进程随 close 被杀不悬空；
 *    instructions 走 getInstructions（SDK 真名——旧 getServerInstructions 是不存在的方法，说明书恒空）。
 *  - T2：调用带超时（默认 60s，server 级 timeoutMs 可调）+ resetTimeoutOnProgress 与空 onprogress
 *    成对传（opencode 注释实锤：SDK 只在 onprogress 在场时才真顺延——只翻开关不传回调是死的）。
 *  SDK 保持动态 import：模块定义加载（CLI 启动）不背 SDK 包体，activate 才付这笔。 */
export async function createSdkConnection(
  name: string,
  cfg: SdkServerConfig,
  opts: SdkConnectOpts = {},
): Promise<ServerConnection> {
  const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = opts.callTimeoutMs ?? cfg.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
  const transport = cfg.url !== undefined
    ? new StreamableHTTPClientTransport(
        new URL(cfg.url),
        cfg.headers !== undefined ? { requestInit: { headers: cfg.headers } } : undefined,
      )
    : new StdioClientTransport({
        command: cfg.command!,
        args: cfg.args ?? [],
        ...(cfg.env !== undefined ? { env: cfg.env } : {}),
        ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}), // T5：子进程工作目录
      });
  const client = new Client({ name: `orosus-mcp-${name}`, version: "0.1.0" });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined; // 成功路也须清（30s 定时器悬着会拖住进程退出）
  try {
    const connecting = client.connect(transport as never); // SDK 传输联合类型在 exactOptionalPropertyTypes 下的摩擦——运行时无歧义
    connecting.catch(() => undefined); // 超时路被 close 打断的迟到拒绝不悬空（race 已由超时先 settle）
    await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`连接超时（等了 ${Math.round(timeoutMs / 1000)} 秒没握上手——server 可能没起来或卡在初始化）`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    await client.close().catch(() => undefined); // 半开连接不悬空（MI-02：连接失败/超时也收尾，close 杀 stdio 子进程）
    throw err;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
  return {
    listTools: async () => {
      // T3 翻页取全：旧实现一次 listTools 只拿首页（工具多的 server 静默少一半）
      const tools = await collectAllPages<never>(async (cursor) => {
        const res = await client.listTools(cursor !== undefined ? { cursor } : {});
        return { tools: res.tools as never[], ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}) };
      });
      return tools;
    },
    callTool: async (toolName, args, signal) => {
      try {
        const res = await client.callTool(
          { name: toolName, arguments: args as Record<string, unknown> },
          undefined,
          {
            signal,
            timeout: callTimeoutMs,
            resetTimeoutOnProgress: true,
            onprogress: () => {}, // 空回调——激活 SDK 的超时顺延（缺它翻开关无效，T2）
          },
        );
        return res as never;
      } catch (err) {
        if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
          // T2 人话文案：超时不等于失败完成——副作用可能已发生，永不自动重放（T7 同纪律）
          throw new Error(
            `调用超时（等了 ${Math.round(callTimeoutMs / 1000)} 秒）——执行可能已经完成，没有自动重试；可以把该 server 的 timeoutMs 配大`,
          );
        }
        throw err;
      }
    },
    instructions: async () => client.getInstructions(), // T1 修复：SDK 真名是 getInstructions
    close: async () => { await client.close(); }, // MI-02：stdio transport 随 close 杀子进程
  };
}
