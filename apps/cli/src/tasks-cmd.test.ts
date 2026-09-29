import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as theme from "./theme.ts";
import { stripAnsi, visibleWidth } from "./tui/width.ts";
import { agentEventsFromFile, emptyTasksRow, loadHistoricalSubagents, renderAgentView, sortNewestFirst, subagentUnloadBlock, taskIdOfRow, tasksListRows } from "./tasks-cmd.ts";
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
describe("/tasks 空态（2026-09-27 用户拍板：无条件开列表）", () => {
  it("㊺b 空册占位行：含派活指引与送回说明；灰色；taskIdOfRow 不误认", () => {
    const row = emptyTasksRow();
    expect(row).toContain("暂无在册子代理");
    expect(row).toContain("派个子代理去");
    expect(row).toContain("自动送回");
    expect(row).toContain("[2m"); // 弱化（dim）形态——整行置灰非彩色
    expect(taskIdOfRow(row)).toBeUndefined(); // 不是任务行——选中也不进查看窗
  });
});

describe("卸载 tool-subagent 守卫（2026-09-27：在跑/排队/挂审批不许卸）", () => {
  it("㊺c 三态：在跑拦（含挂审批计数文案）；排队也拦；全结束/空册不拦", () => {
    const msg = subagentUnloadBlock([
      T({ status: "running" }),
      T({ id: "aaaa0002", label: "排队的", status: "queued" }),
      T({ id: "bbbb0003", label: "挂审批的", status: "running", background: true, pendingApproval: { callId: "c", tool: "boom__run", reason: "subprocess" } }),
      T({ id: "cccc0004", label: "完成的", status: "completed" }),
    ]);
    expect(msg).toContain("有 3 个子代理在跑（含 1 个挂起审批）");
    expect(msg).toContain("/tasks");
    expect(msg).toContain("双击 Esc");
    expect(subagentUnloadBlock([T({ id: "dddd0005", label: "只剩结束的", status: "failed", error: "x" })])).toBeUndefined();
    expect(subagentUnloadBlock([])).toBeUndefined();
  });
});
describe("查看窗折行宽度（2026-09-27 拍板：折行跟全窗口大小走）", () => {
	it("㊺e renderAgentView 的 width 生效：同一条长消息 40 宽折行数多于 100 宽", () => {
		const long = "这是一条非常长的子代理任务书文本".repeat(30); // ~450 显示宽
		const entry = T({ status: "completed" });
		const events = [{ type: "user/message", content: [{ kind: "text", text: long }] }];
		const narrow = renderAgentView(entry, events, 40).split("\n");
		const wide = renderAgentView(entry, events, 100).split("\n");
		const textLines = (ls: string[]): number => ls.filter((l) => stripAnsi(l).includes("任务书文本")).length;
		expect(textLines(narrow)).toBeGreaterThan(textLines(wide)); // 窄宽折更多
		expect(narrow.every((l) => l === "" || visibleWidth(l) <= 44)).toBe(true); // 窄宽不超框（40 + 头行前缀容差）
	});
});

describe("历史子代理名册（2026-09-27 拍板：不删旧数据就得能查看——盘上重建 + 最新在最上）", () => {
	it("㊺f 从 agents/ 目录重建：状态按 turn/end 推断、轮数/工具数/词元/起止时间齐、简述/后台/工种从主会话 spawn 调用回查、孙代带 parentId", () => {
		dir = mkdtempSync(join(tmpdir(), "orosus-hist-"));
		const sid = "s_main01";
		const mkAgent = (id: string, parentSession: string | null, endKind: string, steps: number): void => {
			mkdirSync(join(dir!, "sessions", sid, "agents", `agents_${id}`, "agents"), { recursive: true });
			const evs = [
				{ v: 1, id: "e1", ts: "2026-09-27T10:00:00.000Z", type: "session/header", parentSession },
				{ v: 1, id: "e2", ts: "2026-09-27T10:00:01.000Z", type: "user/message", content: [{ kind: "text", text: "任务" }] },
				...Array.from({ length: steps }, (_, i) => ({ v: 1, id: `s${i}`, ts: `2026-09-27T10:00:0${2 + i}.000Z`, type: "turn/step" })),
				{ v: 1, id: "e3", ts: "2026-09-27T10:00:30.000Z", type: "tool/call", callId: "t1", name: "tool-fs__read", args: {} },
				{ v: 1, id: "e4", ts: "2026-09-27T10:01:00.000Z", type: "assistant/message", content: [{ kind: "text", text: "结论" }], usage: { input: 100, output: 50 } },
				{ v: 1, id: "e5", ts: "2026-09-27T10:01:01.000Z", type: "turn/end", kind: endKind },
			];
			writeFileSync(join(dir!, "sessions", sid, "agents", `agents_${id}`, "agents", "session.jsonl"), evs.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
		};
		mkAgent("aaaa0001", null, "completed", 3);
		mkAgent("bbbb0002", null, "interrupted", 2);
		mkAgent("cccc0003", "agents_aaaa0001", "completed", 1);
		// 主会话：spawn 调用 + 结果（前台结论含 id / 后台入册含 id 两形态）
		const main = [
			{ v: 1, id: "m1", ts: "t0", type: "tool/call", callId: "c1", name: "tool-subagent__spawn", args: { description: "调研竞品", role: "research" } },
			{ v: 1, id: "m2", ts: "t0", type: "tool/result", callId: "c1", output: "子代理完成（1/1）：\n- aaaa0001 · 完成 · 3 轮\n结论：好" },
			{ v: 1, id: "m3", ts: "t0", type: "tool/call", callId: "c2", name: "tool-subagent__spawn", args: { description: "后台跑测", background: true } },
			{ v: 1, id: "m4", ts: "t0", type: "tool/result", callId: "c2", output: "后台已入册（1 个，跑完自动送回）：bbbb0002" },
		];
		mkdirSync(join(dir!, "sessions", sid, "agents"), { recursive: true });
		writeFileSync(join(dir!, "sessions", sid, "agents", "session.jsonl"), main.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
		const hist = loadHistoricalSubagents(join(dir, "sessions"), sid);
		expect(hist.length).toBe(3);
		const a = hist.find((e) => e.id === "aaaa0001")!;
		expect(a.status).toBe("completed");
		expect(a.turns).toBe(3);
		expect(a.toolCalls).toBe(1);
		expect(a.usage).toEqual({ input: 100, output: 50 });
		expect(a.label).toBe("调研竞品");
		expect(a.roleName).toBe("research");
		expect(a.depth).toBe(1);
		expect(a.endedAt).toBe("2026-09-27T10:01:01.000Z");
		const b = hist.find((e) => e.id === "bbbb0002")!;
		expect(b.status).toBe("failed"); // interrupted → 失败（历史推断口径）
		expect(b.background).toBe(true);
		expect(b.label).toBe("后台跑测");
		const c = hist.find((e) => e.id === "cccc0003")!;
		expect(c.depth).toBe(2);
		expect(c.parentId).toBe("aaaa0001");
	});

	it("㊺g 排序最新在最上 + 查看窗可进（历史条目喂 renderAgentView 走同一渲染）", () => {
		const entries = sortNewestFirst([
			T({ id: "aaaa0001", label: "旧的", enqueuedAt: "2026-09-27T10:00:00Z", startedAt: "2026-09-27T10:00:01Z" }),
			T({ id: "bbbb0002", label: "新的", enqueuedAt: "2026-09-27T11:00:00Z", startedAt: "2026-09-27T11:00:01Z" }),
			T({ id: "cccc0003", label: "最新的", enqueuedAt: "2026-09-27T12:00:00Z", startedAt: "2026-09-27T12:00:01Z" }),
		]);
		expect(entries.map((e) => e.id)).toEqual(["cccc0003", "bbbb0002", "aaaa0001"]); // 最新在最上（用户拍板）
		// 历史条目（含 endedAt 的终态）进查看窗：顶栏照常渲染
		const view = renderAgentView(T({ id: "dddd0004", status: "completed", endedAt: "2026-09-27T12:30:00Z" }), [{ type: "user/message", content: [{ kind: "text", text: "历史任务" }] }]);
		expect(stripAnsi(view).split("\n")[0]).toContain("完成");
	});
});

});

  it("走查④：fold 折叠态参——Alt+E/O/F 与主窗一致（think 收起→展开全文、tool/err 折叠切换），缺省不传 = 全收起现状", () => {
    const events = [
      { type: "session/header", format: 1, cwd: "/x", parentSession: "main" },
      { type: "user/message", content: [{ kind: "text", text: "任务" }] },
      { type: "assistant/message", content: [{ kind: "reasoning", text: "思考开头标记甲。" + "中间推理内容。".repeat(30) + "思考结尾标记乙。" }, { kind: "text", text: "结论" }] },
      { type: "tool/call", name: "tool-fs__read", args: { path: "src/a.ts" } },
      { type: "tool/result", output: "x\ny", isError: false },
    ];
    const collapsed = renderAgentView(T({ status: "completed" }), events, 80);
    expect(stripAnsi(collapsed)).toContain("[思考]"); // 收起态头行
    const collapsedPlain = stripAnsi(collapsed);
    expect(collapsedPlain.includes("思考开头标记甲")).toBe(false); // 默认收起只显尾 2 行（头部不在）
    expect(collapsedPlain.includes("思考结尾标记乙")).toBe(true); // 尾 2 行在（流式观看语义 = 永远最新）
    const opened = renderAgentView(T({ status: "completed" }), events, 80, { thinkOpen: true, toolOpen: false, errOpen: false });
    expect(stripAnsi(opened)).toContain("思考开头标记甲"); // Alt+E 展开全文
  });
