import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** T12（m4-3c）：项目 `.mcp.json` 识别与指纹信任门（Reasonix 参照 + qwen 折叠大小写）。
 *  只认 cwd 这一层的 `.mcp.json`（不往上级找——父目录夹带防）；Claude 定的格式
 *  `{ "mcpServers": { 名字: { command/args/env 或 url/headers } } }` 是社区事实标准（四家参照产品都认）。
 *  信任门：项目带来的 server 第一次不连——指纹对上才连；换密钥不用重确认（值不进指纹），
 *  改命令/地址必须重确认（键名进指纹）。批准记录在用户目录（不进仓库——否则项目能自带「已批准」）。 */

/** 信任记录落点（用户目录——设计空白拍板：不放项目里〔项目可提交自己的批准〕、不进 modules.d〔那是配置层〕）。 */
export const mcpTrustFile = (): string => join(homedir(), ".orosus", "mcp-trust.json");

/** 项目路径折叠（qwen 同款：Windows 大小写不敏感——D:\A 与 d:\a 是同一项目）。 */
export const foldProjectPath = (p: string, platform: NodeJS.Platform = process.platform): string =>
  platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p;

/** server 配置指纹：JSON 规范化（键排序）后哈希。**值不进、键名进**——env/headers 只记键名清单
 *  （换 token 值 → 指纹不变；加一个 env 键 / 改 command / 改 args / 改 url → 指纹变）。 */
export function fingerprintServer(cfg: Record<string, unknown>): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) {
        out[k] = k === "env" || k === "headers"
          ? Object.keys(src[k] as Record<string, unknown> ?? {}).sort() // 值不进、键名进
          : canon(src[k]);
      }
      return out;
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canon(cfg))).digest("hex");
}

/** 信任存储形状：{ trusted: { <折叠后项目路径>: { <server 名>: <指纹> } } }。坏文件 = 空库重建（缓存非事实源）。 */
export interface McpTrustStore {
  trusted: Record<string, Record<string, string>>;
}

export function loadMcpTrust(file: string): McpTrustStore {
  try {
    const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as McpTrustStore;
    if (parsed !== null && typeof parsed === "object" && parsed.trusted !== null && typeof parsed.trusted === "object") {
      return { trusted: parsed.trusted };
    }
  } catch { /* 缺文件/坏文件 = 空库 */ }
  return { trusted: {} };
}

export function saveMcpTrust(file: string, store: McpTrustStore): void {
  writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
}

/** 登记/更新一条信任（按折叠项目路径 + server 名——`/mcp trust` 的写口）。 */
export function trustProjectServer(file: string, projectPath: string, platform: NodeJS.Platform, server: string, fingerprint: string): void {
  const store = loadMcpTrust(file);
  const key = foldProjectPath(projectPath, platform);
  (store.trusted[key] ??= {})[server] = fingerprint;
  saveMcpTrust(file, store);
}

/** server 条目的最小形状校验（.mcp.json 是不受信输入——类型错了整条丢弃，不做部分采纳）。 */
function validServerEntry(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  const strMap = (x: unknown): boolean => x === undefined || (x !== null && typeof x === "object" && !Array.isArray(x) && Object.values(x).every((y) => typeof y === "string"));
  return (c.command === undefined || typeof c.command === "string")
    && (c.args === undefined || (Array.isArray(c.args) && c.args.every((a) => typeof a === "string")))
    && strMap(c.env) && strMap(c.headers)
    && (c.url === undefined || typeof c.url === "string")
    && (c.cwd === undefined || typeof c.cwd === "string")
    && (c.timeoutMs === undefined || typeof c.timeoutMs === "number");
}

export type ProjectServerConfig = {
  command?: string; args?: string[]; env?: Record<string, string>; url?: string;
  headers?: Record<string, string>; cwd?: string; timeoutMs?: number;
};

/** 读项目 `.mcp.json`：缺文件/坏 JSON/根形状不对 → 空（带 reason 供宿主 warn）；条目形状错 → 丢弃该条。 */
export function readProjectMcpJson(cwd: string): { servers: Record<string, ProjectServerConfig>; warnings: string[] } {
  const file = join(cwd, ".mcp.json");
  if (!existsSync(file)) return { servers: {}, warnings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    return { servers: {}, warnings: [`.mcp.json 解析失败（${err instanceof Error ? err.message : String(err)}）——按无项目 server 运行`] };
  }
  const root = parsed as { mcpServers?: unknown };
  if (root === null || typeof root !== "object" || root.mcpServers === null || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers)) {
    return { servers: {}, warnings: [".mcp.json 形状不对（需要 { \"mcpServers\": { … } }）——按无项目 server 运行"] };
  }
  const servers: Record<string, ProjectServerConfig> = {};
  const warnings: string[] = [];
  for (const [name, entry] of Object.entries(root.mcpServers as Record<string, unknown>)) {
    if (!validServerEntry(entry)) {
      warnings.push(`.mcp.json 的 server "${name}" 条目形状不对（command/args/env/url 类型错）——丢弃`);
      continue;
    }
    servers[name] = entry as ProjectServerConfig;
  }
  return { servers, warnings };
}

/** 合并 + 信任门（activate 的消费口）：
 *  - 同名优先级 = 手写配置 > 项目 `.mcp.json`（设计空白拍板——参照家相反，但它们没有确认门）；
 *  - 未确认（无记录或指纹不符）的项目 server **不连**（fail-closed；非 TTY 管道同跳过），进 pending 供
 *    toast 与 `/mcp trust` 消费；手写 server 不走门（用户亲手写的天然可信）。
 *  - projectPath 折叠大小写后查库。 */
export function gateProjectServers(opts: {
  userServers: Record<string, Record<string, unknown>>;
  projectServers: Record<string, ProjectServerConfig>;
  trustFile: string;
  projectPath: string;
  platform?: NodeJS.Platform;
}): { servers: Record<string, Record<string, unknown>>; pending: { name: string; fingerprint: string }[] } {
  const trust = loadMcpTrust(opts.trustFile);
  const recorded = trust.trusted[foldProjectPath(opts.projectPath, opts.platform ?? process.platform)] ?? {};
  const servers: Record<string, Record<string, unknown>> = { ...opts.userServers }; // 手写赢：同名直接覆盖
  const pending: { name: string; fingerprint: string }[] = [];
  for (const [name, cfg] of Object.entries(opts.projectServers)) {
    if (name in opts.userServers) continue; // 手写配置在场——项目条目整条让位（含「停用覆盖」玩法）
    const fp = fingerprintServer(cfg as Record<string, unknown>);
    if (recorded[name] === fp) {
      servers[name] = cfg as Record<string, unknown>; // 指纹对上 → 放行
    } else {
      pending.push({ name, fingerprint: fp }); // 无记录 / 配置被改过 → 待确认，不连
    }
  }
  return { servers, pending };
}
