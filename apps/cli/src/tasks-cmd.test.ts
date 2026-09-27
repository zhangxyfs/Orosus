import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as theme from "./theme.ts";
import { stripAnsi } from "./tui/width.ts";
import { agentEventsFromFile, renderAgentView, taskIdOfRow, tasksListRows } from "./tasks-cmd.ts";
import type { SubagentRosterEntry } from "@orosus/contracts/module";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const T = (over: Partial<SubagentRosterEntry>): SubagentRosterEntry => ({
  id: "a3f9c2e1", depth: 1, label: "修复登录页", status: "running", background: false, turns: 3,
  enqueuedAt: "t",
  ...over,
} as SubagentRosterEntry);

describe("/tasks 列表与查看窗 T11（决策 21/22：亲缘分组 + 三色 + 主窗口同款回放）", () => {
  it("㉴ 列表行格式（用户拍板）：[子代理]/[孙代理] 两档标签、父-孙标注、孙行紧跟父行、等审批与后台标注", () => {
    const rows = tasksListRows([
      T({ status: "running" }),
      T({ id: "b7d2f0a3", depth: 2, parentId: "a3f9c2e1", label: "跑测试", status: "running", turns: 1 }),
      T({ id: "d2b8a6f0", label: "后台调研", status: "running", background: true, pendingApproval: { callId: "c", tool: "boom__run", reason: "subprocess" } }),
    ]);
    const plain = rows.map(stripAnsi);
    expect(plain[0]).toBe("[子代理] a3f9c2e1 修复登录页 · 运行中");
    expect(plain[1]).toBe("[孙代理] a3f9c2e1 - b7d2f0a3 跑测试 · 运行中"); // 孙行紧跟父行 + 父-孙标注
    expect(plain[2]).toBe("[子代理] d2b8a6f0 后台调研 · 运行中 · 等审批 · 后台");
  });

  it("㊵ 三色（运行中绿 / 已完成灰 / 失败红）+ 孤儿孙代理顶层补位不丢", () => {
    const rows = tasksListRows([
      T({ status: "completed" }),
      T({ id: "c0ffee00", label: "败了", status: "failed", error: "已被取消" }),
      T({ id: "dddd0000", depth: 2, parentId: "gone1111", label: "孤儿孙", status: "running" }),
    ]);
    expect(rows[0]!.startsWith(theme.fg("muted", "[子代理]").replace(/\[39m$/, ""))).toBe(true); // 行首色码（整行一次包色）
    expect(rows[1]!.startsWith(theme.fg("err", "[子代理]").replace(/\[39m$/, ""))).toBe(true);
    expect(rows[2]!.startsWith(theme.fg("accent", "[孙代理]").replace(/\[39m$/, ""))).toBe(true);
    expect(stripAnsi(rows[2]!)).toContain("dddd0000 孤儿孙");
  });

  it("㊶ taskIdOfRow：子/孙两形都能解析出编号", () => {
    expect(taskIdOfRow(tasksListRows([T({})])[0]!)).toBe("a3f9c2e1");
    expect(taskIdOfRow(tasksListRows([T({ id: "b7d2f0a3", depth: 2, parentId: "a3f9c2e1" })])[0]!)).toBe("b7d2f0a3");
    expect(taskIdOfRow("不是任务行")).toBeUndefined();
  });

  it("㊷ agentEventsFromFile：按决策 19 落盘形状读会话文件；只取末 500 条动态；文件缺失 = 空数组", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-tasks-"));
    const agentDir = join(dir, "sessions", "main-sid", "agents", "agents_a3f9c2e1", "agents");
    mkdirSync(agentDir, { recursive: true });
    const events = Array.from({ length: 502 }, (_, i) => ({ v: 1, id: `e${i}`, type: i === 0 ? "session/header" : "user/message", content: [{ kind: "text", text: `m${i}` }] }));
    writeFileSync(join(agentDir, "session.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const got = agentEventsFromFile(join(dir, "sessions"), "main-sid", "a3f9c2e1");
    expect(got.length).toBe(500); // 末 500 条（查看窗实时保留量——设计空白）
    expect(got[0]!.id).toBe("e2");
    expect(agentEventsFromFile(join(dir, "sessions"), "main-sid", "deadbeef")).toEqual([]); // 缺文件 = 空
  });

  it("㊸ renderAgentView：顶栏状态行（状态+轮数+工种+后台）+ 消息流主窗口同款回放（用户/助手都出现）", () => {
    const view = renderAgentView(
      T({ status: "running", roleName: "research" }),
      [
        { type: "session/header", format: 1, cwd: "/x", parentSession: "main" },
        { type: "user/message", content: [{ kind: "text", text: "去调研竞品" }] },
        { type: "assistant/message", content: [{ kind: "text", text: "调研结论在此" }] },
      ],
    );
    const plain = stripAnsi(view).split("\n");
    expect(plain[0]).toContain("状态：运行中 · 3 轮 · 工种 research");
    expect(plain.some((l) => l.includes("去调研竞品"))).toBe(true);
    expect(plain.some((l) => l.includes("调研结论在此"))).toBe(true);
  });

  it("㊹ 失败/等审批形态：错误首行与等审批标注进顶栏；失败色红", () => {
    const failed = renderAgentView(
      T({ status: "failed", error: "已被取消（子代理被停止）\n第二行不进" }),
      [{ type: "user/message", content: [{ kind: "text", text: "任务" }] }],
    );
    expect(stripAnsi(failed).split("\n")[0]).toContain("失败 · 3 轮 · 已被取消（子代理被停止）");
    expect(failed.startsWith(theme.fg("err", "状态").replace(/\[39m$/, ""))).toBe(true); // 顶栏失败红
    const waiting = renderAgentView(T({ pendingApproval: { callId: "c", tool: "boom__run", reason: "subprocess" }, background: true }), []);
    expect(stripAnsi(waiting).split("\n")[0]).toContain("运行中 · 等审批 · 3 轮 · 后台");
  });
});
