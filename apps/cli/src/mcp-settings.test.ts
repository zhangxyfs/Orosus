// T17（m4-3c）：MCP 管理面纯层——四段行 / 六字段 / 状态文字 / 传输·来源标签。
import { describe, it, expect } from "vitest";
import { stripAnsi } from "./tui/width.ts";
import { mcpListRow, mcpDetailText, mcpStateText, mcpSourceLabel, mcpTransportLabel, mcpDescLine } from "./mcp-settings.ts";
import type { McpCatalogRow } from "@orosus/mcp";

const row = (name: string, state: McpCatalogRow["state"], extra: Partial<McpCatalogRow> = {}): McpCatalogRow => ({
  name, state, toolCount: 26, tools: [], source: "config", transport: "stdio", command: "npx -y pkg", ...extra,
});

describe("T17 管理面纯层（m4-3c）", () => {
  it("① 状态文字五档（T17 原文照录）", () => {
    expect(mcpStateText(row("a", "connected"))).toBe("已连接 · 启用");
    expect(mcpStateText(row("a", "idle"))).toBe("待启动 · 启用");
    expect(mcpStateText(row("a", "failed"))).toBe("失败 · 启用");
    expect(mcpStateText(row("a", "disabled"))).toBe("已停用");
    expect(mcpStateText(row("a", "pending-confirm"))).toBe("未确认");
  });

  it("② 列表四段行：状态点/名字/描述/状态文字——绿●灰○红●，超宽词原子截断", () => {
    const connected = stripAnsi(mcpListRow(60, row("mine", "connected")));
    expect(connected).toContain("●");
    expect(connected).toContain("mine");
    expect(connected).toContain("已连接 · 启用");
    const idle = stripAnsi(mcpListRow(60, row("pre", "idle", { source: "preload" })));
    expect(idle).toContain("○");
    expect(idle).toContain("待启动 · 启用");
    const failed = stripAnsi(mcpListRow(60, row("down", "failed", { failReason: "boom\n[stderr] x" })));
    expect(failed).toContain("失败 · 启用");
    const long = stripAnsi(mcpListRow(40, row("很长的名字超过列宽会被截断掉", "connected", { command: "npx -y very-long-package-name --port 9 --verbose --extra" })));
    expect(long).toContain("…");
    expect(long.length).toBeLessThanOrEqual(41); // 行宽口径 40 + 容差 1
  });

  it("③ 详情六字段：名称/说明/状态（失败附尾巴 3 行+帽注）/来源三档/传输/命令或 URL；未确认只读指路", () => {
    const text = stripAnsi(mcpDetailText(76, row("mine", "connected", { instructions: "[mcp:mine] 记住要点" })));
    expect(text).toContain("名称");
    expect(text).toContain("说明");
    expect(text).toContain("[mcp:mine] 记住要点");
    expect(text).toContain("配置文件");
    expect(text).toContain("stdio 子进程");
    expect(text).toContain("npx -y pkg");
    const failText = stripAnsi(mcpDetailText(76, row("down", "failed", { failReason: `l1\nl2\nl3\nl4\nl5` })));
    expect(failText).toContain("l1");
    expect(failText).toContain("l3");
    expect(failText).not.toContain("l4"); // 尾巴展示 3 行帽（原型）
    expect(failText).toContain("4KB");
    const proj = stripAnsi(mcpDetailText(76, row("api", "pending-confirm", { source: "project", fingerprint: "abcd1234efgh" })));
    expect(proj).toContain("项目 .mcp.json");
    expect(proj).toContain("/mcp trust api");
    expect(proj).toContain("abcd1234");
    const remote = stripAnsi(mcpTransportLabel(row("r", "connected", { transport: "http", url: "https://x/mcp" })));
    expect(remote).toBe("HTTP（远程）");
    expect(mcpSourceLabel(row("p", "idle", { source: "preload" }))).toBe("预装");
  });

  it("④ 描述首行兜底链：instructions→url→command→工具数；pending 显指纹 8 位", () => {
    expect(mcpDescLine(row("a", "connected"))).toBe("npx -y pkg");
    expect(mcpDescLine(row("a", "connected", { command: undefined, url: "https://x/mcp", transport: "http" }))).toBe("https://x/mcp");
    expect(mcpDescLine(row("a", "idle", { command: undefined }))).toBe("");
    expect(mcpDescLine(row("a", "pending-confirm", { fingerprint: "0011223344556677" }))).toContain("00112233");
  });
});
