import { describe, it, expect } from "vitest";
import * as theme from "./theme.ts";
import { stripAnsi } from "./tui/width.ts";
import { agentGroupLines, backgroundRunningCount, subagentCountHint } from "./subagent-status.ts";
import type { SubagentRosterEntry } from "@orosus/contracts/module";


const NOW = Date.parse("2026-09-27T12:00:00Z");

const T = (over: Partial<SubagentRosterEntry>): SubagentRosterEntry => ({
  id: "aaaa1111", depth: 1, label: "调研竞品", status: "running", background: false, turns: 3,
  enqueuedAt: "2026-09-27T11:59:50Z", startedAt: "2026-09-27T11:59:51Z",
  roleName: "explore", model: "glm-4.7", effort: "high", toolCalls: 5,
  usage: { input: 2000, output: 1200 },
  ...over,
} as SubagentRosterEntry);

describe("agent 组显示（2026-09-27 用户拍板格式——kimi agent-group 定式）", () => {
  it("㊿-1 首行两态：运行中无括号段；全部结束带括号统计段（Σ工具调用·Σ词元·首末时长）", () => {
    const running = agentGroupLines([
      T({ id: "aaaa1111", status: "running", startedAt: "2026-09-27T11:59:00Z", toolCalls: 4, usage: { input: 1500, output: 500 } }),
      T({ id: "bbbb2222", label: "跑测试", status: "running", startedAt: "2026-09-27T11:59:30Z", toolCalls: 2, usage: { input: 1000, output: 0 } }),
    ], NOW);
    expect(stripAnsi(running[0]!)).toBe("● 2 explore agents 运行中");
    expect(running[0]).not.toContain("（"); // 运行中无括号段（用户拍板）

    const done = agentGroupLines([
      T({ id: "aaaa1111", status: "completed", startedAt: "2026-09-27T11:58:00Z", endedAt: "2026-09-27T11:59:03Z", toolCalls: 4, usage: { input: 1500, output: 500 } }),
      T({ id: "bbbb2222", label: "跑测试", status: "completed", startedAt: "2026-09-27T11:58:10Z", endedAt: "2026-09-27T11:59:23Z", toolCalls: 2, usage: { input: 1000, output: 0 } }),
    ], NOW);
    expect(stripAnsi(done[0]!)).toBe("● 2 explore agents 完成（6 工具调用 · 3.0k 词元 · 1分23秒）"); // 括号段只在结束
    expect(done[0]).toContain(theme.fg("muted", "● 2 explore agents 完成")); // 完成灰
  });

  it("㊿-2 子行格式：连接符 + 工种 短标题 + 模型·思考·次数·时长·词元·状态；末行 └─；缺段跳过；失败红", () => {
    const lines = agentGroupLines([
      T({ id: "aaaa1111", status: "running" }),
      { id: "bbbb2222", depth: 1, label: "跑测试", status: "failed", background: false, turns: 1, enqueuedAt: "2026-09-27T11:59:50Z", startedAt: "2026-09-27T11:59:51Z", roleName: "explore", toolCalls: 2, endedAt: "2026-09-27T11:59:59Z", error: "x" } as SubagentRosterEntry,
    ], NOW);
    const plain = lines.map(stripAnsi);
    expect(plain[1]!).toBe("  ├─  explore 调研竞品  glm-4.7·high·5次·9秒·3.2k·运行中");
    expect(plain[2]!).toBe("  └─  explore 跑测试  2次·8秒·失败"); // 模型/思考/词元缺段跳过（kimi 同款）
    expect(lines[2]).toContain(theme.fg("err", "失败"));
  });

  it("㊿-3 孙代理嵌套：父行 ├─ 带后续时孙行用 │ 续接；标注等审批/后台", () => {
    const lines = agentGroupLines([
      T({ id: "aaaa1111", status: "running" }),
      T({ id: "cccc3333", depth: 2, parentId: "aaaa1111", label: "孙代任务", status: "running", background: true, pendingApproval: { callId: "c", tool: "boom__run", reason: "subprocess" } }),
      T({ id: "bbbb2222", label: "另一个父", status: "running" }),
    ], NOW);
    const plain = lines.map(stripAnsi);
    expect(plain[1]!).toContain("├─  explore 调研竞品");
    expect(plain[2]!).toContain("│  └─  explore 孙代任务"); // 父行后还有父级 → 孙行 │ 续接；孙行是同级末位 → └─
    expect(plain[2]!).toContain("运行中·等审批·后台");
    expect(plain[3]!).toContain("└─  explore 另一个父");
  });

  it("㊿-4 上限 8 分桶：运行中优先、完成殿后；超出尾行注余量", () => {
    const many: SubagentRosterEntry[] = [];
    for (let i = 0; i < 6; i++) many.push(T({ id: `c${i}00000${i}`, label: `完成${i}`, status: "completed", endedAt: "2026-09-27T11:59:00Z" }));
    for (let i = 0; i < 5; i++) many.push(T({ id: `r${i}00000${i}`, label: `在跑${i}`, status: "running" }));
    const lines = agentGroupLines(many, NOW);
    const plain = lines.map(stripAnsi);
    expect(plain[0]!).toBe("● 11 explore agents 运行中");
    const rows = plain.slice(1, 9);
    expect(rows.length).toBe(8); // 上限 8
    expect(rows.slice(0, 5).every((r) => r.includes("在跑"))).toBe(true); // 运行中优先占前 5（ZCode 分桶）
    expect(rows.slice(5).every((r) => r.includes("完成"))).toBe(true);   // 空位给完成
    expect(plain[9]!).toBe("  …还有 3 个（/tasks 看全部）"); // 6 完成 - 3 已显示 = 3 殿后
  });

  it("㊿-5 聚合三态与混合终态：全失败红；完成 M/N；混工种回落「子代理」；长标题截断", () => {
    const allFail = agentGroupLines([T({ id: "aaaa1111", status: "failed", error: "x", endedAt: "t0" }), T({ id: "bbbb2222", status: "failed", error: "y", endedAt: "t1" })], NOW);
    expect(allFail[0]).toContain(theme.fg("err", "● 2 explore agents 失败"));
    const mixed = agentGroupLines([T({ id: "aaaa1111", status: "completed", endedAt: "t0" }), T({ id: "bbbb2222", status: "failed", error: "y", endedAt: "t1" })], NOW);
    expect(stripAnsi(mixed[0]!)).toContain("完成（1/2）");
    const mixedRole = agentGroupLines([T({ id: "aaaa1111" }), T({ id: "bbbb2222", roleName: "general" })], NOW);
    expect(stripAnsi(mixedRole[0]!)).toContain("2 子代理 agents");
    const long = agentGroupLines([T({ label: "这是一个特别特别特别特别特别长的任务标题超限了" })], NOW);
    expect(stripAnsi(long[1]!)).toContain("这是一个特别特别特别特别特别长的任务标题…"); // 标题截断 20 字（拍板「标题要简短」）
  });
});

describe("CR-10 三小修：非法日期段跳过 / 同级判定按 parentId / 标题按码点截断", () => {
  it("CR-10① 非法日期串：子行时长段跳过（不显「NaN时NaN分」）；首行括号段总时长同理", () => {
    const running = agentGroupLines([T({ startedAt: "not-a-date" })], NOW);
    expect(stripAnsi(running[1]!)).toBe("  └─  explore 调研竞品  glm-4.7·high·5次·3.2k·运行中"); // 时长段缺失、其余段原样
    expect(running.join("")).not.toContain("NaN");
    const done = agentGroupLines([T({ status: "completed", endedAt: "corrupt" })], NOW);
    expect(stripAnsi(done[0]!)).toBe("● 1 explore agents 完成（5 工具调用 · 3.2k 词元）"); // 总时长段跳过
    expect(done.join("")).not.toContain("NaN");
  });

  it("CR-10② 两父各一孙：前父的孙也是其父末孙 → └─（旧判定按显示序误画 ├─）", () => {
    const lines = agentGroupLines([
      T({ id: "aaaa1111", status: "running" }),
      T({ id: "cccc3333", depth: 2, parentId: "aaaa1111", label: "孙一", status: "running" }),
      T({ id: "bbbb2222", label: "另一个父", status: "running" }),
      T({ id: "dddd4444", depth: 2, parentId: "bbbb2222", label: "孙二", status: "running" }),
    ], NOW);
    const plain = lines.map(stripAnsi);
    expect(plain[2]!).toContain("│  └─  explore 孙一"); // 同父无后续孙 → └─；父行后还有父级 → │ 续接
    expect(plain[2]!).not.toContain("├─"); // 旧缺陷形态：│  ├─（把别父的孙当同级行）
    expect(plain[4]!).toContain("   └─  explore 孙二"); // 末父的末孙：└─ + 空续接（无 │）
  });

  it("CR-10③ 标题截断按码点：代理对不切断；恰 20 码点的含 emoji 标题不截断", () => {
    const keep = agentGroupLines([T({ label: `${"a".repeat(19)}🚀` })], NOW); // 20 码点 = 上限内
    // 整行精确钉：旧 slice(0,20) 会把 🚀 切成孤立高位代理（终端显示替换符），整行必不相等
    expect(stripAnsi(keep[1]!)).toBe(`  └─  explore ${"a".repeat(19)}🚀  glm-4.7·high·5次·9秒·3.2k·运行中`);
    const cut = agentGroupLines([T({ label: `${"b".repeat(19)}🚀尾` })], NOW); // 21 码点 → 截到 20
    expect(stripAnsi(cut[1]!)).toContain(`${"b".repeat(19)}🚀…`); // emoji 整体保留 + 省略号
  });
});

describe("输入行计数 T13（只后台运行中；为零整段消失；青绿色）", () => {
  it("㊽ backgroundRunningCount 口径：只数后台·运行中——前台/排队/已结束都不算", () => {
    expect(backgroundRunningCount([
      T({ status: "running", background: true }),
      T({ id: "bbbb0001", label: "前台运行", status: "running" }),
      T({ id: "bbbb0002", label: "后台排队", background: true, status: "queued" }),
      T({ id: "bbbb0003", label: "后台完成", background: true, status: "completed" }),
      T({ id: "bbbb0004", label: "后台失败", background: true, status: "failed" }),
    ])).toBe(1);
    expect(backgroundRunningCount([])).toBe(0);
  });

  it("㊾ 文案与颜色：「N 任务正在执行」青绿；为零 = 空串整段消失", () => {
    const hint = subagentCountHint(3);
    expect(hint).toContain("3 任务正在执行");
    expect(hint).toContain(theme.fg("accent", "3 任务正在执行"));
    expect(subagentCountHint(0)).toBe("");
    expect(subagentCountHint(-1)).toBe("");
  });
});
