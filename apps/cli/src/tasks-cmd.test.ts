import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as theme from "./theme.ts";
import { stripAnsi, visibleWidth } from "./tui/width.ts";
import { agentEventsFromFile, createAgentViewRenderer, emptyTasksRow, loadHistoricalSubagents, openTasks, renderAgentView, sortNewestFirst, subagentUnloadBlock, taskIdOfRow, tasksListRows } from "./tasks-cmd.ts";
import type { AgentViewIO } from "./tasks-cmd.ts";
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

  it("㊸b 生成中尾行（2026-10-01 走查④拍板）：运行/排队态内容末尾挂「正在生成…」spinner 行；完成/失败态不挂", () => {
    const running = stripAnsi(renderAgentView(T({ status: "running" }), [{ type: "user/message", content: [{ kind: "text", text: "任务" }] }]));
    expect(running.split("\n").at(-1)).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 正在生成…$/);
    const queued = stripAnsi(renderAgentView(T({ status: "queued" }), []));
    expect(queued).toContain("正在生成…");
    const done = stripAnsi(renderAgentView(T({ status: "completed" }), [{ type: "user/message", content: [{ kind: "text", text: "任务" }] }]));
    expect(done).not.toContain("正在生成…");
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

describe("增量渲染器 createAgentViewRenderer（m5-agentview-perf T2：常驻模型 + mtime/size 文件判据 + 增量解析）", () => {
  // 假盘（visiongate catalogFile 同款手法）：内存文件 + mtime 版本号，readFrom/stat 计数供增量断言
  const mkIO = () => {
    const files = new Map<string, { mtimeMs: number; buf: Buffer }>();
    return {
      files,
      write(file: string, text: string, mtimeMs: number): void { files.set(file, { mtimeMs, buf: Buffer.from(text, "utf8") }); },
      io: {
        stat: (file: string) => { const f = files.get(file); return f === undefined ? undefined : { mtimeMs: f.mtimeMs, size: f.buf.length }; },
        readFrom: (file: string, offset: number) => { const f = files.get(file); return f === undefined ? "" : f.buf.subarray(offset).toString("utf8"); },
      },
    };
  };
  const evUser = (text: string): string => JSON.stringify({ v: 1, type: "user/message", content: [{ kind: "text", text }] });
  const evThink = (text: string): string => JSON.stringify({ v: 1, type: "assistant/message", content: [{ kind: "reasoning", text }] });
  // 渲染器装配：sessionsDir="s" + locate 固定；假盘 key 与生产同构 join 拼出（平台分隔符一致）
  const mkRenderer = (disk: ReturnType<typeof mkIO>, entry: SubagentRosterEntry, readEntry: () => SubagentRosterEntry) =>
    createAgentViewRenderer("s", entry, readEntry, () => ({ sid: "main", id: "a3f9c2e1" }), { io: disk.io, now: () => 1_000_000 });

  it("T2① 文件未变：二次 render 不重读盘（readFrom 计数不增）且文本全等（活体行现算、注入时钟同帧防跨秒假红）", () => {
    const disk = mkIO();
    const file = join("s", "main", "agents", "agents_a3f9c2e1", "agents", "session.jsonl");
    disk.write(file, [evUser("任务一"), evUser("任务二")].join("\n") + "\n", 1000);
    const cur = T({ status: "running" });
    const r = mkRenderer(disk, cur, () => cur);
    const a = r.render(80);
    const readsAfterFirst = r.readCount;
    expect(readsAfterFirst).toBe(1); // 首帧全量读一次
    const b = r.render(80);
    expect(r.readCount).toBe(readsAfterFirst); // 判据命中——不再碰盘
    expect(b).toBe(a); // 正文引用直拼 + 活体行同帧 → 全等
  });

  it("T2② 文件追加：只解析新增行（parseCount 恰 +2）、文本含新内容、旧内容不变", () => {
    const disk = mkIO();
    const file = join("s", "main", "agents", "agents_a3f9c2e1", "agents", "session.jsonl");
    disk.write(file, [evUser("旧内容一"), evUser("旧内容二"), evUser("旧内容三")].join("\n") + "\n", 1000);
    const cur = T({ status: "running" });
    const r = mkRenderer(disk, cur, () => cur);
    r.render(80);
    expect(r.parseCount).toBe(3); // 首帧 3 条全量
    disk.write(file, [evUser("旧内容一"), evUser("旧内容二"), evUser("旧内容三"), evUser("新内容四"), evUser("新内容五")].join("\n") + "\n", 1001);
    const text = stripAnsi(r.render(80));
    expect(r.parseCount).toBe(5); // 只解析新增 2 行
    expect(text.includes("新内容五")).toBe(true);
    expect(text.includes("旧内容一")).toBe(true); // 旧条目常驻模型保留
  });

  it("T2③ 文件重写变小（size < offset）：回退全量重建——不炸、内容为新文件、全量重解析", () => {
    const disk = mkIO();
    const file = join("s", "main", "agents", "agents_a3f9c2e1", "agents", "session.jsonl");
    disk.write(file, [evUser("长文件甲"), evUser("长文件乙"), evUser("长文件丙")].join("\n") + "\n", 1000);
    const cur = T({ status: "completed" });
    const r = mkRenderer(disk, cur, () => cur);
    r.render(80);
    disk.write(file, evUser("重写后的新内容").repeat(1) + "\n", 1001); // 重写变小——offset 越界
    const text = stripAnsi(r.render(80)); // 不炸（D3 回退全量重建）
    expect(text.includes("重写后的新内容")).toBe(true);
    expect(text.includes("长文件甲")).toBe(false); // 旧模型作废
    expect(r.parseCount).toBe(4); // 重建重解析：新文件 1 行
  });

  it("T2④ 折叠切换：内容变（thinkOpen 展开现全文）且零碰盘（readFrom 不增）；同档二次 render 文本全等", () => {
    const disk = mkIO();
    const file = join("s", "main", "agents", "agents_a3f9c2e1", "agents", "session.jsonl");
    disk.write(file, [evUser("任务"), evThink("折叠开头标记甲。" + "中间推理。".repeat(30) + "折叠结尾标记乙。")].join("\n") + "\n", 1000);
    const cur = T({ status: "completed" });
    const r = mkRenderer(disk, cur, () => cur);
    const collapsed = stripAnsi(r.render(80));
    expect(collapsed.includes("折叠开头标记甲")).toBe(false); // 默认收起
    const readsBeforeFold = r.readCount;
    r.setFold({ thinkOpen: true });
    const opened = stripAnsi(r.render(80));
    expect(opened.includes("折叠开头标记甲")).toBe(true); // D6：内容变
    expect(r.readCount).toBe(readsBeforeFold);             // 折叠不碰盘
    expect(opened).not.toBe(collapsed);
    const again = stripAnsi(r.render(80));
    expect(again).toBe(opened); // 同档二次复用
    expect(r.readCount).toBe(readsBeforeFold);
  });
});

describe("openTasks 查看窗接线增量渲染器（m5-agentview-perf T3：实时刷新/首屏/折叠键三路全走 renderer）", () => {
  it("T3① 开窗后多次触发 live：同一文件状态下只有首次真读盘（假盘 readFrom 计数钉 1），文本含会话内容", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-t3-")); // sessionsDir 空目录：无历史名册（loadHistoricalSubagents 空转）
    const file = join(dir!, "main", "agents", "agents_a3f9c2e1", "agents", "session.jsonl");
    const files = new Map<string, Buffer>([[file, Buffer.from(JSON.stringify({ v: 1, type: "user/message", content: [{ kind: "text", text: "任务正文" }] }) + "\n", "utf8")]]);
    let reads = 0;
    const viewIO: AgentViewIO = {
      stat: (f) => { const b = files.get(f); return b === undefined ? undefined : { mtimeMs: 1000, size: b.length }; },
      readFrom: (f, off) => { reads++; const b = files.get(f); return b === undefined ? "" : b.subarray(off).toString("utf8"); },
    };
    const entry = T({ status: "running" });
    const h = { sessionId: "main", subagents: () => [entry], answerSubagentApproval: () => {} } as never;
    let captured: { live?: () => string } | undefined;
    const app = {
      pickOverlay: async () => (captured === undefined ? 0 : undefined), // 第一轮选中行、查看窗关闭后 Esc 出循环
      viewText: (_t: string, _b: string, opts: { live?: () => string }) => { captured = opts; },
    } as unknown as import("./tui/fullapp.ts").FullApp;
    await openTasks(app, () => {}, { getH: () => h, sessionsDir: dir!, commandUi: {} as never, notify: () => {}, viewIO });
    expect(captured?.live).toBeDefined(); // running 态挂实时刷
    const a = captured!.live!();
    expect(reads).toBe(1); // 首次真读盘（旧全量路不走 viewIO 缝恒 0——接线前此断言即红）
    const b = captured!.live!();
    expect(reads).toBe(1); // 文件未变不重读
    expect(stripAnsi(b)).toContain("任务正文");
    expect(b).toBe(a); // 同一文件状态文本同形
  });
});
