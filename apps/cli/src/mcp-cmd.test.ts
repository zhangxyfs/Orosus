// T13（m4-3c）：/mcp 命令族——拆行守卫纯钉 + 命令处理器注入式全覆盖（写盘落临时 modules.d/mcp.toml，
// catalog 行注入；真机链（拦截/reload）由 main.test 管道冒烟覆盖）。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { splitCommandLine, runMcpCommand, type McpCmdDeps } from "./mcp-cmd.ts";
import { trustProjectServer } from "@orosus/mcp";
import type { McpCatalogRow } from "@orosus/mcp";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `orosus-mcpcmd-${tag}-`));
  dirs.push(d);
  return d;
};

const deps = (dir: string, rows?: McpCatalogRow[]): McpCmdDeps => ({
  configPath: () => join(dir, "modules.d", "mcp.toml"),
  projectPath: () => dir,
  trustFile: () => join(dir, "mcp-trust.json"),
  platform: "linux",
  ...(rows !== undefined ? { catalogRows: () => rows } : {}),
});

/** smol-toml parse 的收窄口（测试内联形状——TomlValue 联合不认 .mcp.servers 链）。 */
const serversOf = (p: string): Record<string, Record<string, unknown>> =>
  ((parse(readFileSync(p, "utf8")) as { mcp?: { servers?: Record<string, Record<string, unknown>> } }).mcp?.servers) ?? {};

const row = (name: string, state: McpCatalogRow["state"], extra: Partial<McpCatalogRow> = {}): McpCatalogRow => ({
  name, state, toolCount: 3, tools: ["a", "b", "c"], source: "config", transport: "stdio", command: "npx pkg", ...extra,
});

describe("T13 拆行守卫（/mcp add 与添加窗共用）", () => {
  it("① 启动器开头才拆：npx/node/python/docker 拆成命令+参数数组", () => {
    expect(splitCommandLine("npx -y @modelcontextprotocol/server-github")).toEqual({ ok: true, command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
    expect(splitCommandLine("python server.py --port 9")).toEqual({ ok: true, command: "python", args: ["server.py", "--port", "9"] });
  });

  it("② 引号开头的才拆：带空格的 Windows 路径整段保住、引号剥除", () => {
    const r = splitCommandLine('"C:\\Program Files\\xxx.exe" --port 9');
    expect(r).toEqual({ ok: true, command: "C:\\Program Files\\xxx.exe", args: ["--port", "9"] });
  });

  it("③ 没加引号的 Windows 路径（反斜杠+空格）绝不拆——明确拒绝并指路加引号", () => {
    const r = splitCommandLine("C:\\Program Files\\xxx.exe --port 9");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("加引号");
  });

  it("④ 边界：空行拒绝；无反斜杠的非启动器命令照常拆", () => {
    expect(splitCommandLine("").ok).toBe(false);
    expect(splitCommandLine("my-server --port 9")).toEqual({ ok: true, command: "my-server", args: ["--port", "9"] });
  });
});

describe("T13 /mcp 命令族（注入式）", () => {
  it("① 列表：四档状态 + 工具数 + 失败原因首行 + 待确认指纹 8 位；空态指路 docs/mcp-servers.md", async () => {
    const d = tmp("list");
    const rows = [
      row("mine", "connected"),
      row("down", "failed", { failReason: "spawn ENOENT\n[stderr] boom 尾巴" }),
      row("proj", "pending-confirm", { source: "project", fingerprint: "abcd1234efgh5678" }),
    ];
    const r = await runMcpCommand("", deps(d, rows));
    expect(r.wrote).toBe(false);
    expect(r.text).toContain("共 3 个 MCP server");
    expect(r.text).toContain("**mine** 已连接 · 3 个工具");
    expect(r.text).toContain("**down** 失败 · 3 个工具（——spawn ENOENT）"); // 尾巴首行
    expect(r.text).not.toContain("boom 尾巴");
    expect(r.text).toContain("`proj`（指纹 abcd1234）");
    expect(r.text).toContain("trust 名字");
    const empty = await runMcpCommand("", deps(d, []));
    expect(empty.text).toContain("docs/mcp-servers.md");
  });

  it("② add：命令行形态写 command+args、URL 形态写 url；重名拒绝不覆盖；守卫错误透传", async () => {
    const d = tmp("add");
    const dp = deps(d);
    const r1 = await runMcpCommand("add gh npx -y @modelcontextprotocol/server-github", dp);
    expect(r1.wrote).toBe(true);
    const r2 = await runMcpCommand("add api https://mcp.example.com/mcp", dp);
    expect(r2.wrote).toBe(true);
    const doc = parse(readFileSync(dp.configPath(), "utf8")) as { mcp: { servers: Record<string, Record<string, unknown>> } };
    expect(doc.mcp.servers.gh).toEqual({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
    expect(doc.mcp.servers.api).toEqual({ url: "https://mcp.example.com/mcp" });
    const dup = await runMcpCommand("add gh npx -y other", dp);
    expect(dup.wrote).toBe(false);
    expect(dup.text).toContain("已存在同名");
    const guard = await runMcpCommand("add bad C:\\Program Files\\x.exe --p", dp);
    expect(guard.wrote).toBe(false);
    expect(guard.text).toContain("加引号");
    expect(serversOf(dp.configPath())).toHaveProperty("gh"); // 未被污染
  });

  it("③ remove：手写条目删表；项目/预装来源拒绝（指路 off）；未知名提示", async () => {
    const d = tmp("rm");
    await runMcpCommand("add gh npx -y p", deps(d));
    const rows = [row("gh", "connected"), row("proj", "connected", { source: "project" }), row("memory", "idle", { source: "preload" })];
    const dp = deps(d, rows);
    const r = await runMcpCommand("remove gh", dp);
    expect(r.wrote).toBe(true);
    expect(parse(readFileSync(dp.configPath(), "utf8"))).toEqual({}); // 唯一表删净——空文件
    const proj = await runMcpCommand("remove proj", dp);
    expect(proj.wrote).toBe(false);
    expect(proj.text).toContain("项目 .mcp.json");
    expect(proj.text).toContain("off proj");
    const pre = await runMcpCommand("remove memory", dp);
    expect(pre.text).toContain("预装");
    const unknown = await runMcpCommand("remove ghost", dp);
    expect(unknown.text).toContain("没有叫");
  });

  it("④ on/off：手写条目翻转 enabled 保其余键；项目条目 off 写覆盖 / on 删覆盖（来源零改动）", async () => {
    const d = tmp("toggle");
    await runMcpCommand("add gh npx -y p", deps(d));
    const dp = deps(d, [row("gh", "connected"), row("proj", "connected", { source: "project" })]);
    const off = await runMcpCommand("off gh", dp);
    expect(off.wrote).toBe(true);
    expect(serversOf(dp.configPath()).gh).toEqual({ command: "npx", args: ["-y", "p"], enabled: false });
    const projOff = await runMcpCommand("off proj", dp);
    expect(projOff.wrote).toBe(true);
    expect(serversOf(dp.configPath()).proj).toEqual({ enabled: false }); // 覆盖条目
    const onR = await runMcpCommand("on gh", dp);
    expect(onR.wrote).toBe(true);
    expect(serversOf(dp.configPath()).gh).toEqual({ command: "npx", args: ["-y", "p"], enabled: true });
    const projOn = await runMcpCommand("on proj", dp);
    expect(projOn.wrote).toBe(true);
    expect(serversOf(dp.configPath()).proj).toBeUndefined(); // 覆盖条目删除——还原来源
  });

  it("⑤ trust：无待确认明说；清单显指纹；trust 名字登记 + wrote=true", async () => {
    const d = tmp("trust");
    const dp = deps(d);
    writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { "proj-api": { command: "node", args: ["s.mjs"], env: { TOKEN: "t" } } } }), "utf8");
    const none = await runMcpCommand("trust", dp);
    expect(none.wrote).toBe(false);
    expect(none.text).toContain("待确认");
    const list = await runMcpCommand("trust", dp);
    expect(list.text).toContain("proj-api");
    expect(list.text).toMatch(/指纹 [0-9a-f]{8}/);
    const bad = await runMcpCommand("trust ghost", dp);
    expect(bad.text).toContain("不在待确认清单");
    const ok = await runMcpCommand("trust proj-api", dp);
    expect(ok.wrote).toBe(true);
    expect(ok.text).toMatch(/已确认 \*\*proj-api\*\*（指纹 [0-9a-f]{8}）/);
    // 登记后再列——无待确认
    const after = await runMcpCommand("trust", dp);
    expect(after.text).toContain("没有待确认");
    // 手写同名覆盖优先：项目条目被覆盖时不进待确认
    await runMcpCommand("add proj-api node s.mjs", dp);
    expect((await runMcpCommand("trust", dp)).text).toContain("没有待确认");
  });

  it("⑥ fallback：模块未启用（无 catalog 服务）——列表回落配置面 + 待确认（诚实报「待启动/停用」）", async () => {
    const d = tmp("fallback");
    const dp = deps(d); // 无 catalogRows
    await runMcpCommand("add gh npx -y p", dp);
    writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { evil: { url: "https://e/mcp" } } }), "utf8");
    const r = await runMcpCommand("", dp);
    expect(r.text).toContain("**gh** 待启动 · —");
    expect(r.text).toContain("`evil`（指纹");
  });

  it("⑦ 用法兜底：未知子命令给用法行（管理面内部口口径）", async () => {
    const r = await runMcpCommand("frobnicate", deps(tmp("usage")));
    expect(r.wrote).toBe(false);
    expect(r.text).toContain("管理面内部口");
    expect(r.text).toContain("/settings → MCP");
  });
});

describe("T13 信任库真机落点（defaultMcpCmdDeps 只组装不触盘）", () => {
  it("deps 默认值指向约定路径（不读不写）", async () => {
    const { defaultMcpCmdDeps } = await import("./mcp-cmd.ts");
    const dp = defaultMcpCmdDeps();
    expect(dp.configPath().replace(/\\/g, "/")).toMatch(/modules\.d\/mcp\.toml$/);
    expect(dp.trustFile().replace(/\\/g, "/")).toContain("mcp-trust.json");
    expect(existsSync(dp.projectPath())).toBe(true); // cwd 恒在
    void trustProjectServer; // 引用面
    void mkdirSync;
  });
});
