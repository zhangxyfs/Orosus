import { fg, dim } from "./theme.ts";
import { truncateAtWord } from "./skill-settings.ts";
import { visibleWidth } from "./tui/width.ts";
import type { McpCatalogRow } from "@orosus/mcp";

/** T17（m4-3c）：MCP 管理面纯层——列表四段行 / 详情六字段文本（skill-settings 同款模式；
 *  装配在 main.ts openMcpPanel，交互键位与窗口形态按 2026-09-30 原型四轮走查拍板）。 */

/** 状态文字（T17 原文）：四段行第四段。 */
export function mcpStateText(row: McpCatalogRow): string {
  switch (row.state) {
    case "connected": return "已连接 · 启用";
    case "idle": return "待启动 · 启用";
    case "failed": return "失败 · 启用";
    case "disabled": return "已停用";
    case "pending-confirm": return "未确认";
  }
}

/** 状态点：绿=已连接、灰=装了还没启动、红=没连上（失败/未确认/停用都算红——T17 原文）。 */
function stateDot(row: McpCatalogRow): string {
  if (row.state === "connected") return fg("accent", "●");
  if (row.state === "idle") return fg("muted", "○");
  return fg("warn", "●");
}

/** 来源标签（详情页字段）。 */
export function mcpSourceLabel(row: McpCatalogRow): string {
  if (row.source === "config") return "配置文件";
  if (row.source === "project") return "项目 .mcp.json";
  return "预装";
}

/** 传输方式标签（三档——原型走查拍板 2026-09-30，原稿两档）。 */
export function mcpTransportLabel(row: McpCatalogRow): string {
  return row.transport === "http" ? "HTTP（远程）" : "stdio 子进程";
}

/** 描述首行（catalog 未带描述时用传输/命令兜底——列表第三段不能空着）。 */
export function mcpDescLine(row: McpCatalogRow): string {
  if (row.state === "pending-confirm") return row.fingerprint !== undefined ? `待确认（指纹 ${row.fingerprint.slice(0, 8)}）` : "待确认";
  if (row.url !== undefined) return row.url;
  if (row.command !== undefined) return row.command;
  if (row.state === "connected") return `${row.toolCount ?? 0} 个工具`;
  return "";
}

/** 列表页行（四段——状态点/名字/描述首行/状态文字；词原子截断同技能列表纪律）。 */
export function mcpListRow(w: number, row: McpCatalogRow): string {
  const status = mcpStateText(row);
  const statusW = visibleWidth(status);
  const dotW = 2; // 点 + 空隙
  const nameW = Math.min(18, Math.max(8, Math.floor((w - statusW - dotW - 4) / 3)));
  const name = row.name.length > nameW ? `${row.name.slice(0, nameW - 1)}…` : row.name.padEnd(nameW);
  const descW = w - 2 - dotW - nameW - statusW - 2;
  const desc = descW >= 6 ? dim(truncateAtWord(mcpDescLine(row), descW)) : "";
  const leftW = 1 + dotW + nameW + (desc === "" ? 0 : 1 + visibleWidth(desc));
  const gap = Math.max(1, w - 1 - leftW - statusW);
  return ` ${stateDot(row)} ${name}${desc === "" ? "" : ` ${desc}`}${" ".repeat(gap)}${status}`;
}

/** 详情页文本（六字段：名称/说明/状态（失败附尾巴）/来源/传输方式/命令或 URL）。
 *  未确认详情只读指路（确认走命令族——与 T12 口径一致）。 */
export function mcpDetailText(w: number, row: McpCatalogRow): string {
  const label = (s: string) => `${fg("muted", s.padEnd(10, "　"))}`; // 标签列对齐（最长「传输方式」四字——全角补齐 10 列预算）
  const field = (name: string, value: string): string => `${label(name)}${truncateAtWord(value, w - 2 - 12)}`;
  const lines = [
    field("名称", row.name),
    field("说明", row.instructions !== undefined ? row.instructions : (mcpDescLine(row) === "" ? "（无说明）" : mcpDescLine(row))),
    field("状态", mcpStateText(row)),
    field("来源", mcpSourceLabel(row)),
    field("传输方式", mcpTransportLabel(row)),
    field(row.transport === "http" ? "URL" : "命令", row.transport === "http" ? (row.url ?? "—") : (row.command ?? "—")),
  ];
  if (row.state === "failed" && row.failReason !== undefined) {
    const tailLines = row.failReason.split("\n").filter((l) => l.trim() !== "").slice(0, 3);
    for (const l of tailLines) lines.push(dim(truncateAtWord(l, w - 4)));
    lines.push(dim("…（失败原因最多保留 4KB——完整内容见 /mcp）"));
  }
  if (row.state === "pending-confirm") {
    lines.push("", fg("muted", `未确认——核对指纹后按 t 确认连接（指纹 ${row.fingerprint?.slice(0, 8) ?? "—"}；确认一次永久可用，配置被改过会重新要求）`));
  }
  return lines.join("\n");
}
