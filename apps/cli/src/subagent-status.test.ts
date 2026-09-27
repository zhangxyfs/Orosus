import { describe, it, expect } from "vitest";
import * as theme from "./theme.ts";
import { stripAnsi } from "./tui/width.ts";
import { subagentStatusLines } from "./subagent-status.ts";
import type { SubagentRosterEntry } from "@orosus/contracts/module";

const NOW = Date.parse("2026-09-26T12:00:00Z");
/** theme.fg 的色前缀（整行一次包色——断言用 startsWith，不带尾部 reset）。 */
const fgOpen = (c: Parameters<typeof theme.fg>[0], marker: string): string => theme.fg(c, marker).replace(/\[39m$/, "").slice(0, theme.fg(c, marker).indexOf(marker));
const T = (over: Partial<SubagentRosterEntry>): SubagentRosterEntry => ({
  id: "a3f9c2e1", depth: 1, label: "修复登录页", status: "running", background: false, turns: 3,
  enqueuedAt: "2026-09-26T11:59:48Z",
  ...over,
} as SubagentRosterEntry);

describe("主窗口子代理状态行 T10（拍板要素：首行+子行、完成括号统计段、三色、只前台）", () => {
  it("㉞ 首行形状与三色：运行中绿（编号+简述+轮数+时长感）；排队中显式；等审批标注", () => {
    const lines = subagentStatusLines([
      T({ status: "running", startedAt: "2026-09-26T11:59:50Z" }),
      T({ id: "b1c2d3e4", label: "排队的", status: "queued" }),
      T({ id: "c1c2d3e4", label: "等审批的", status: "running", pendingApproval: { callId: "c", tool: "boom__run", reason: "subprocess" } }),
    ], NOW);
    const plain = lines.map(stripAnsi);
    expect(plain[0]).toContain("◆ 子代理 a3f9c2e1 修复登录页 · 运行中 3 轮");
    expect(plain.some((l) => l.includes("b1c2d3e4 排队的 · 排队中"))).toBe(true);
    expect(plain.some((l) => l.includes("等审批"))).toBe(true);
    expect(lines[0]!.startsWith(fgOpen("accent", "◆ 子代理"))).toBe(true); // 运行中 = 青玉绿（行首色码）
  });

  it("㉟ 孙代理子行紧跟父行（└ 缩进）；孤儿孙顶层不丢", () => {
    const lines = subagentStatusLines([
      T({ status: "running", startedAt: "2026-09-26T11:59:50Z" }),
      T({ id: "b7d2f0a3", depth: 2, parentId: "a3f9c2e1", label: "跑测试", status: "running", turns: 1, startedAt: "2026-09-26T11:59:55Z" }),
      T({ id: "dddd0000", depth: 2, parentId: "gone1111", label: "孤儿孙", status: "running" }),
    ], NOW);
    const plain = lines.map(stripAnsi);
    expect(plain[0]).toContain("◆ 子代理 a3f9c2e1");
    expect(plain[1]).toContain("└ b7d2f0a3 跑测试 · 运行中 1 轮"); // 子行紧跟父行
    expect(plain[2]).toContain("◆ 孙代理 dddd0000 孤儿孙"); // 父已不在册——孙顶层显示不丢
  });

  it("㊱ 完成时括号统计段（轮数 · 时长）灰；失败红带错误首行", () => {
    const lines = subagentStatusLines([
      T({ status: "completed", turns: 8, startedAt: "2026-09-26T11:58:52Z", endedAt: "2026-09-26T11:59:55Z" }),
      T({ id: "e5f6a7b8", label: "失败的", status: "failed", turns: 2, error: "已被取消\n第二行不显示", startedAt: "2026-09-26T11:59:00Z", endedAt: "2026-09-26T11:59:55Z" }),
    ], NOW);
    const plain = lines.map(stripAnsi);
    expect(plain[0]).toContain("已完成（8 轮 · 1 分 03 秒）"); // 括号统计段
    expect(plain[1]).toContain("失败（2 轮 · 已被取消）"); // 错误首行
    expect(lines[0]!.startsWith(fgOpen("muted", "◆ 子代理"))).toBe(true); // 已完成灰
    expect(lines[1]!.startsWith(fgOpen("err", "◆ 子代理"))).toBe(true); // 失败红
  });

  it("㊲ 只统计前台：后台条目不进状态行（后台走输入行计数——T13 口径）", () => {
    const lines = subagentStatusLines([
      T({ status: "running" }),
      T({ id: "bbbb0000", label: "后台的", background: true, status: "running" }),
    ], NOW);
    expect(lines.length).toBe(1);
    expect(stripAnsi(lines[0]!)).not.toContain("后台的");
  });

  it("㊳ 已结束闪现 10 秒：窗口外不出现；空态 = 空数组（整段消失）", () => {
    const flash = subagentStatusLines([T({ status: "completed", endedAt: "2026-09-26T11:59:55Z" })], NOW);
    expect(flash.length).toBe(1); // 5 秒前结束——还在闪
    const gone = subagentStatusLines([T({ status: "completed", endedAt: "2026-09-26T11:59:00Z" })], NOW);
    expect(gone).toEqual([]); // 60 秒前——已消失
    expect(subagentStatusLines([], NOW)).toEqual([]); // 空态整段消失
  });
});
