import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { join } from "node:path";
import { orosusHome } from "@orosus/contracts/home";
import { writeNestedTable, type NestedTableValue } from "@orosus/core";
import {
  readProjectMcpJson, fingerprintServer, trustProjectServer, gateProjectServers, mcpTrustFile,
  type McpCatalogRow, type ProjectServerConfig,
} from "@orosus/mcp";
import { searchRegistry, decideInstall, REGISTRY_SHOW_LIMIT, defaultRegistryCacheFile } from "./mcp-registry.ts";

/** MCP 管理引擎（m4-3c T13/T14，2026-09-30 `/mcp` 斜杠命令随用户口令退役）：/settings → MCP
 *  管理面与行模式设置面的内部口——查看 / 添加 / 删除 / 开关 / 信任确认（t 键）/ 注册表 browse+install。
 *  写盘走 core 写入器 + mcp.catalog 服务取 live 灰度 + 写完由调用方触发 h.reload()。
 *  依赖全注入（catalog 落点/配置路径/项目路径/信任库/平台）——apps/cli 接真实现，测试接临时目录。 */

/** 整行命令拆分（守卫拍板入方案）：常见启动器开头才拆、引号开头才拆、
 *  没加引号的 Windows 路径（含反斜杠又含空格）绝不拆——拆碎了就完了。 */
const LAUNCHERS = new Set(["npx", "npm", "pnpm", "yarn", "bunx", "uvx", "pipx", "deno", "python", "python3", "docker", "node", "dotnet", "java", "go", "cargo", "ruby", "uv"]);

export function splitCommandLine(line: string): { ok: true; command: string; args: string[] } | { ok: false; error: string } {
  const trimmed = line.trim();
  if (trimmed === "") return { ok: false, error: "命令是空的——用法：/mcp add 名字 npx -y 包名（或一个 https:// URL）" };
  // 引号感知分词（"..." 内的空格不分；引号本身剥除——cmd 风格，反斜杠是字面路径成分）
  const tokens: string[] = [];
  let cur = "";
  let inQuote: '"' | "'" | undefined;
  let anyQuote = false;
  for (const ch of trimmed) {
    if (inQuote !== undefined) {
      if (ch === inQuote) inQuote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      anyQuote = true;
      if (cur !== "") { tokens.push(cur); cur = ""; } // foo"bar baz" → foo 与 bar baz 两段
    } else if (ch === " " || ch === "\t") {
      if (cur !== "") { tokens.push(cur); cur = ""; }
    } else cur += ch;
  }
  if (cur !== "") tokens.push(cur);
  const first = tokens[0]!;
  const firstIsQuoted = anyQuote && trimmed.startsWith('"') || (anyQuote && trimmed.startsWith("'"));
  const firstSpan = /^[^\s"']+/.exec(trimmed)?.[0] ?? "";
  const launcher = LAUNCHERS.has(first.replace(/\.cmd$/i, "").toLowerCase()) || firstIsQuoted;
  if (!launcher && /\\/.test(firstSpan) && trimmed.length > firstSpan.length) {
    return { ok: false, error: "命令带反斜杠又带空格还没加引号——无法安全拆分（C:\\Program Files\\x.exe 这类路径会被拆碎）；请给带空格的路径加引号后重试" };
  }
  return { ok: true, command: tokens[0]!, args: tokens.slice(1) };
}

export interface McpCmdDeps {
  /** live 目录（mcp.catalog 服务行——模块未启用时缺省，列表回落配置文件基础态） */
  catalogRows?: () => McpCatalogRow[];
  /** 用户层 modules.d/mcp.toml 落点 */
  configPath(): string;
  /** 项目路径（读 .mcp.json + 信任库折叠键） */
  projectPath(): string;
  /** 信任库落点 */
  trustFile(): string;
  platform?: NodeJS.Platform;
  /** 注册表缓存落点（T14） */
  registryCachePath?: () => string;
  /** 网络实现（T14——测试注入） */
  fetchImpl?: typeof fetch;
}

export interface McpCmdResult {
  text: string;
  /** true = 写了盘（main.ts 侧应 h.reload()） */
  wrote: boolean;
}

export function defaultMcpCmdDeps(): McpCmdDeps {
  return {
    configPath: () => join(orosusHome(), "modules.d", "mcp.toml"),
    projectPath: () => process.cwd(),
    trustFile: () => mcpTrustFile(),
    registryCachePath: () => defaultRegistryCacheFile(join(orosusHome(), "cache")),
  };
}

/** 配置文件里的既有 server 名（重名校验 + on/off 读旧值）。 */
const configuredServers = (path: string): Record<string, Record<string, unknown>> => {
  if (!existsSync(path)) return {};
  try {
    const doc = parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const mcp = doc["mcp"] as Record<string, unknown> | undefined;
    const servers = mcp?.["servers"] as Record<string, Record<string, unknown>> | undefined;
    return servers ?? {};
  } catch {
    return {}; // 坏文件：当作无既有配置（写入器自身拒写坏盘，这里只读名字）
  }
};

const STATE_TEXT: Record<McpCatalogRow["state"], string> = {
  connected: "已连接",
  idle: "待启动",
  failed: "失败",
  "pending-confirm": "未确认",
  disabled: "已停用",
};

const firstLine = (s: string): string => s.split("\n")[0]!;

/** 管理引擎主入口（面板内部口）：args 为子命令参数串（空 = 列表）。 */
export async function runMcpCommand(rawArgs: string, deps: McpCmdDeps): Promise<McpCmdResult> {
  const args = rawArgs.trim();
  const [sub = "", ...rest] = args.split(/\s+/);
  const configPath = deps.configPath();

  if (args === "" || sub === "list" || sub === "ls") {
    const rows = deps.catalogRows?.() ?? fallbackRows(deps);
    if (rows.length === 0) {
      return { text: "还没有配置任何 MCP server。\n\n- /settings → MCP 按 Alt + N 添加（手动命令或 URL，或粘 JSON）\n- 项目自带 `.mcp.json` 会自动识别（详情页按 t 确认后可用）\n- 想找更多 server：见 docs/mcp-servers.md 推荐清单", wrote: false };
    }
    const lines = rows.map((r) => {
      const tools = r.toolCount !== undefined ? `${r.toolCount} 个工具` : "—";
      const fail = r.state === "failed" && r.failReason !== undefined ? `（——${firstLine(r.failReason)}）` : "";
      const lazy = r.source === "preload" ? " · 按需启动" : "";
      return `- ${r.state === "connected" ? "●" : r.state === "idle" ? "○" : "●"} **${r.name}** ${STATE_TEXT[r.state]} · ${tools}${lazy}${fail}`;
    });
    const pending = rows.filter((r) => r.state === "pending-confirm");
    const tail = pending.length > 0 ? `\n\n未确认（项目 .mcp.json 带来）：${pending.map((p) => `\`${p.name}\`（指纹 ${p.fingerprint?.slice(0, 8)}）`).join("、")}——\`/mcp trust 名字\` 确认后连接` : "";
    return { text: `共 ${rows.length} 个 MCP server：\n${lines.join("\n")}${tail}`, wrote: false };
  }

  if (sub === "add") {
    const name = rest[0];
    const cmdline = rest.slice(1).join(" "); // rest 已按空白分词但引号保留在段内——拼回交给守卫拆分
    if (name === undefined || name === "") return { text: "用法：add 名字 npx -y 包名（或一个 https:// URL）——完整表单在 /settings → MCP 的 Alt + N 添加窗", wrote: false };
    if (cmdline === "") return { text: `缺少命令或 URL——\`/mcp add ${name} npx -y 包名\``, wrote: false };
    if (name in configuredServers(configPath)) {
      return { text: `已存在同名 server「${name}」——不覆盖别人的配置；想改它请到 /settings → MCP 用修改`, wrote: false };
    }
    let values: Record<string, NestedTableValue>;
    if (/^https?:\/\//i.test(cmdline)) {
      values = { url: cmdline }; // URL 自动识别为远程型（HTTP——SSE 由添加窗显选，原型拍板）
    } else {
      const split = splitCommandLine(cmdline);
      if (!split.ok) return { text: split.error, wrote: false };
      values = { command: split.command, ...(split.args.length > 0 ? { args: split.args } : {}) };
    }
    writeNestedTable(configPath, `mcp.servers.${name}`, values);
    return { text: `已写入 **${name}**（${deps.configPath()}）——模块图重载后生效，回 \`/mcp\` 看红绿灯`, wrote: true };
  }

  if (sub === "remove" || sub === "rm") {
    const name = rest[0];
    if (name === undefined) return { text: "用法：remove 名字（管理面详情页 d 键同款）", wrote: false };
    const rows = deps.catalogRows?.() ?? fallbackRows(deps);
    const row = rows.find((r) => r.name === name);
    if (row !== undefined && row.source !== "config") {
      return { text: `「${name}」来自${row.source === "project" ? "项目 .mcp.json" : "预装（只能停用不能删除）"}——Orosus 不改它的来源；想停用在管理面按 Alt + K`, wrote: false };
    }
    if (!(name in configuredServers(configPath)) && row === undefined) {
      return { text: `没有叫「${name}」的 server（/mcp 查看列表）`, wrote: false };
    }
    writeNestedTable(configPath, `mcp.servers.${name}`, null);
    return { text: `已删除 **${name}**——模块图重载后生效`, wrote: true };
  }

  if (sub === "on" || sub === "off") {
    const name = rest[0];
    if (name === undefined) return { text: `用法：\`/mcp ${sub} 名字\``, wrote: false };
    const existing = configuredServers(configPath);
    const rows = deps.catalogRows?.() ?? fallbackRows(deps);
    const row = rows.find((r) => r.name === name);
    const enable = sub === "on";
    if (!(name in existing) && row === undefined) {
      return { text: `没有叫「${name}」的 server（/mcp 查看列表）`, wrote: false };
    }
    // 来源分流（2026-09-30 T13 走查逻辑修正；同日二修——实机 memory 弄残事故）：**按条目内容分流，不按
    // catalog 报的来源**——off 写下的停用覆盖是无 command/url 的空壳，reload 后 catalog 会把它重报成
    // 「配置文件」来源（用户层同名即 config），旧判据据此把随后的 on 引进「表内翻转」分支 → 空壳翻成
    // enabled=true 顶掉预装启动配置（同名让位）→ server 永久起不来。新判据：条目带 command 或 url =
    // 真手写条目（表内翻转）；空壳 = 覆盖条目（on 删覆盖还原来源、off 写/保持覆盖）——off→on 任意来回
    // 恒等。模块未启用无 catalog 时同判据照判（不依赖 row）。
    const entry = existing[name] as Record<string, unknown> | undefined;
    const hasStartup = entry !== undefined && entry !== null && typeof entry === "object"
      && (typeof entry.command === "string" || typeof entry.url === "string");
    if (name in existing && hasStartup) {
      // 手写条目：表内翻转 enabled（保留其余键）
      const merged: Record<string, NestedTableValue> = {};
      for (const [k, v] of Object.entries(existing[name]!)) {
        if (k === "enabled") continue;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") merged[k] = v;
        else if (Array.isArray(v) && v.every((x) => typeof x === "string")) merged[k] = v as string[];
        else if (v !== null && typeof v === "object" && Object.values(v).every((x) => typeof x === "string")) merged[k] = v as Record<string, string>;
      }
      merged.enabled = enable;
      writeNestedTable(configPath, `mcp.servers.${name}`, merged);
      return { text: `已${enable ? "启用" : "停用"} **${name}**——模块图重载后生效`, wrote: true };
    }
    // 项目/预装条目与空壳覆盖：用户层同名覆盖（停用 = 覆盖条目；启用 = 删覆盖条目还原来源——设计空白拍板）
    if (enable) {
      writeNestedTable(configPath, `mcp.servers.${name}`, null); // 覆盖条目不在则无操作
      return { text: `已启用 **${name}**（移除用户层覆盖）——模块图重载后生效`, wrote: true };
    }
    writeNestedTable(configPath, `mcp.servers.${name}`, { enabled: false });
    return { text: `已停用 **${name}**（用户层同名覆盖——项目文件零改动）——模块图重载后生效`, wrote: true };
  }

  if (sub === "trust") {
    const project = readProjectMcpJson(deps.projectPath());
    const gated = gateProjectServers({
      userServers: configuredServers(configPath) as Record<string, Record<string, unknown>>,
      projectServers: project.servers,
      trustFile: deps.trustFile(),
      projectPath: deps.projectPath(),
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
    });
    if (gated.pending.length === 0) {
      return { text: "没有待确认的项目 server（cwd 无 .mcp.json 或全部已确认/被手写配置覆盖）", wrote: false };
    }
    const name = rest[0];
    if (name === undefined) {
      const lines = gated.pending.map((p) => `- \`${p.name}\`（指纹 ${p.fingerprint.slice(0, 8)}——${serverKind(project.servers[p.name]!)}）`);
      return { text: `项目 .mcp.json 待确认（核对指纹后 \`/mcp trust 名字\`）：\n${lines.join("\n")}`, wrote: false };
    }
    const target = gated.pending.find((p) => p.name === name);
    if (target === undefined) {
      return { text: `「${name}」不在待确认清单（/mcp trust 查看全部）`, wrote: false };
    }
    trustProjectServer(deps.trustFile(), deps.projectPath(), deps.platform ?? process.platform, name, fingerprintServer(project.servers[name] as Record<string, unknown>));
    return { text: `已确认 **${name}**（指纹 ${target.fingerprint.slice(0, 8)}）——模块图重载后连接`, wrote: true };
  }

  if (sub === "browse") {
    const query = rest.join(" ").trim();
    if (query === "") return { text: "用法：browse 关键词（管理面内部口）——搜 MCP 官方注册表（registry.modelcontextprotocol.io）", wrote: false };
    const r = await searchRegistry({
      query,
      cacheFile: deps.registryCachePath?.() ?? defaultRegistryCacheFile(join(orosusHome(), "cache")),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
    if (r.entries.length === 0) {
      return {
        text: r.offline
          ? "网络不可用且本地没有可用的注册表缓存——连上网后重试（缓存 30 天有效，断网时自动回落）"
          : `注册表里没有匹配「${query}」的 server——换个关键词，或直接 /mcp add 手写`,
        wrote: false,
      };
    }
    const shown = r.entries.slice(0, REGISTRY_SHOW_LIMIT);
    const lines = shown.map((e) => {
      const kind = e.stdio !== undefined ? "本地" : e.remote !== undefined ? "远程" : "无安装形态";
      const needs = [...(e.stdio?.requiredEnv ?? []), ...(e.remote?.requiredHeaders ?? [])];
      const needTag = needs.length > 0 ? `（需配置：${needs.join("、")}）` : "";
      const desc = e.description.split("\n")[0]!.slice(0, 60);
      return `- \`${e.name}\` ${kind}${needTag} —— ${desc}`;
    });
    const more = r.entries.length > REGISTRY_SHOW_LIMIT
      ? `\n\n（前 ${REGISTRY_SHOW_LIMIT} 条，共 ${r.entries.length} 条命中——细化关键词缩小范围）`
      : "";
    return { text: `注册表搜索「${query}」${r.offline ? "（离线——用缓存）" : ""}：\n${lines.join("\n")}${more}\n\n安装：\`/mcp install 名字\`（短名即可）`, wrote: false };
  }

  if (sub === "install") {
    const name = rest[0];
    if (name === undefined || name === "") return { text: "用法：`/mcp install 名字`——先 browse 找名字（管理面内部口）", wrote: false };
    const existing = configuredServers(configPath);
    const cacheFile = deps.registryCachePath?.() ?? defaultRegistryCacheFile(join(orosusHome(), "cache"));
    // 取全量（无关键词过滤）再精确匹配名/短名
    const r = await searchRegistry({ query: name, cacheFile, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) }); // 按名搜——空关键词只回前 N 条会漏目标
    const decision = decideInstall(r.entries, name);
    switch (decision.kind) {
      case "not-found":
        return { text: `注册表里没找到「${name}」——/mcp browse 搜一下确认名字（install 用全名或短名都行）`, wrote: false };
      case "ambiguous":
        return { text: `「${name}」命中多个条目——用全名指明：${decision.candidates.map((c) => `\`${c.name}\``).join("、")}`, wrote: false };
      case "needs-secrets":
        return {
          text: `**${decision.entry.name}** 需要密钥（${decision.missing.join("、")}）——不半自动安装（占位密钥连上也是 401）。把下面模板填好后贴进 \`${configPath}\`，再 /reload：

${decision.template}

（值可用 \`$ENV:变量名\` 引用环境变量——Orosus 不会把宿主环境自动漏给 server）`,
          wrote: false,
        };
      case "stdio": {
        if (decision.entry.shortName in existing) {
          return { text: `已存在同名 server「${decision.entry.shortName}」——不覆盖；想改它请用修改`, wrote: false };
        }
        writeNestedTable(configPath, `mcp.servers.${decision.entry.shortName}`, {
          command: decision.values.command,
          ...(decision.values.args.length > 0 ? { args: decision.values.args } : {}),
        });
        return { text: `已安装 **${decision.entry.shortName}**（来自 ${decision.entry.name} v${decision.entry.version}）——模块图重载后生效，回 \`/mcp\` 看红绿灯`, wrote: true };
      }
      case "remote": {
        if (decision.entry.shortName in existing) {
          return { text: `已存在同名 server「${decision.entry.shortName}」——不覆盖；想改它请用修改`, wrote: false };
        }
        writeNestedTable(configPath, `mcp.servers.${decision.entry.shortName}`, { url: decision.values.url });
        return { text: `已安装 **${decision.entry.shortName}**（远程，来自 ${decision.entry.name} v${decision.entry.version}）——模块图重载后生效`, wrote: true };
      }
    }
  }

    return { text: "管理面内部口（图形面走 /settings → MCP）：list · add 名字 命令或URL · remove|on|off 名字 · trust [名字] · browse 关键词 · install 名字", wrote: false };
}

const serverKind = (cfg: ProjectServerConfig): string => cfg.url !== undefined ? `远程 ${cfg.url}` : `本地 ${[cfg.command, ...(cfg.args ?? [])].join(" ")}`;

/** 模块未启用时的列表回落：只报配置面（连不连不知道——诚实说）。 */
function fallbackRows(deps: McpCmdDeps): McpCatalogRow[] {
  const configured = configuredServers(deps.configPath());
  const rows: McpCatalogRow[] = Object.entries(configured).map(([name, cfg]) => ({
    name,
    state: cfg.enabled === false ? "disabled" : "idle",
    toolCount: undefined,
    tools: [],
    source: "config",
    transport: typeof cfg.url === "string" ? "http" : "stdio",
    ...(typeof cfg.url === "string" ? { url: cfg.url } : {}),
    ...(cfg.url === undefined && typeof cfg.command === "string" ? { command: cfg.command } : {}),
  }));
  const project = readProjectMcpJson(deps.projectPath());
  const gated = gateProjectServers({
    userServers: configured,
    projectServers: project.servers,
    trustFile: deps.trustFile(),
    projectPath: deps.projectPath(),
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
  });
  for (const p of gated.pending) {
    rows.push({ name: p.name, state: "pending-confirm", toolCount: undefined, tools: [], fingerprint: p.fingerprint, source: "project", transport: project.servers[p.name]?.url !== undefined ? "http" : "stdio" });
  }
  return rows;
}
