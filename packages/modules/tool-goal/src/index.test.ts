import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeModule, fakeProvider } from "@orosus/testing";
import type { Chunk } from "@orosus/contracts/provider";
import type { ModuleContext } from "@orosus/contracts/module";
import type { Tool } from "@orosus/contracts/tool";
import toolGoal, { createGoalStore, goalTools, goalSectionText, OBJECTIVE_MAX, type GoalState } from "./index.ts";

let dir = "";
afterEach(() => { if (dir !== "") rmSync(dir, { recursive: true, force: true }); dir = ""; });

const noLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const exec = async (tool: Tool, input: Record<string, unknown>) => {
  const plan = await tool.resolveExecution(input);
  return plan.execute({ callId: "c1", signal: new AbortController().signal, log: noLog });
};

const mkStore = (events: (GoalState | null)[] = []) => {
  const store = createGoalStore((s) => events.push(s));
  const [create, get, update] = goalTools(store);
  return { store, create: create!, get: get!, update: update!, events };
};

describe("tool-goal 状态机与三工具（M4-3 T6）", () => {
  it("① create 成功 → state active + 变更事件快照上行（存源不存渲染）", async () => {
    const { create, store, events } = mkStore();
    const r = await exec(create, { objective: "把测试补齐到 900" });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("目标已建立");
    expect(store.current()).toMatchObject({ objective: "把测试补齐到 900", status: "active", roundsUsed: 0, blockedStreak: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "active" });
  });

  it("② 撞活目标无 replace → 报错带现状（单目标制）；replace:true → 覆盖", async () => {
    const { create, store } = mkStore();
    await exec(create, { objective: "旧目标" });
    const clash = await exec(create, { objective: "新目标" });
    expect(clash.isError).toBe(true);
    expect(clash.output).toContain("已有活动目标");
    expect(clash.output).toContain("旧目标");
    const ok = await exec(create, { objective: "新目标", replace: true });
    expect(ok.isError).toBe(false);
    expect(store.current()?.objective).toBe("新目标");
  });

  it("③ objective 超 4000 字符 → 报错指引写文件；恰好 4000 通过（SW-12）", async () => {
    const { create } = mkStore();
    const tooLong = await exec(create, { objective: "x".repeat(OBJECTIVE_MAX + 1) });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.output).toContain("4000");
    expect(tooLong.output).toContain("写入文件");
    const exact = await exec(create, { objective: "x".repeat(OBJECTIVE_MAX) });
    expect(exact.isError).toBe(false);
  });

  it("④ get 快照：roundsUsed/剩余轮数/blockedStreak 全在；无目标时空话", async () => {
    const { create, get, store } = mkStore();
    const empty = await exec(get, {});
    expect(empty.output).toContain("当前无活动目标");
    await exec(create, { objective: "g", maxRounds: 5 });
    store.spendRound();
    const r = await exec(get, {});
    const snap = JSON.parse(r.output) as Record<string, unknown>;
    expect(snap).toMatchObject({ status: "active", roundsUsed: 1, maxRounds: 5, roundsRemaining: 4, blockedStreak: 0 });
  });

  it("⑤ complete → status complete 带证据；终态后可另立新目标；终态再 update 报错", async () => {
    const { create, update, store } = mkStore();
    await exec(create, { objective: "g1" });
    const done = await exec(update, { action: "complete", reason: "全部测试通过" });
    expect(done.isError).toBe(false);
    expect(store.current()?.status).toBe("complete");
    const again = await exec(update, { action: "complete", reason: "x" });
    expect(again.isError).toBe(true);
    expect(again.output).toContain("无活动目标");
    expect((await exec(create, { objective: "g2" })).isError).toBe(false); // 终态不挡新目标
  });

  it("⑥ 无目标 update（complete/blocked）均带内报错", async () => {
    const { update } = mkStore();
    expect((await exec(update, { action: "complete", reason: "x" })).isError).toBe(true);
    expect((await exec(update, { action: "blocked", reason: "x" })).isError).toBe(false);
    const r = await exec(update, { action: "blocked", reason: "x" });
    expect(r.output).toContain("无活动目标");
  });

  it("⑦ blocked 三连：同 reason 三轮才接受（打回带 N/3 计数）；变词清零重计（qwen 加严语义）", async () => {
    const { create, update, store } = mkStore();
    await exec(create, { objective: "g" });
    const r1 = await exec(update, { action: "blocked", reason: "接口 401" });
    expect(r1.output).toContain("1/3");
    expect(store.current()?.status).toBe("active");
    const r2 = await exec(update, { action: "blocked", reason: "接口 401" });
    expect(r2.output).toContain("2/3");
    const swap = await exec(update, { action: "blocked", reason: "权限不够" }); // 变词 → 清零
    expect(swap.output).toContain("1/3");
    await exec(update, { action: "blocked", reason: "权限不够" });
    const r3 = await exec(update, { action: "blocked", reason: "权限不够" });
    expect(r3.output).toContain("已接受 blocked");
    expect(store.current()?.status).toBe("blocked");
  });

  it("⑧ 状态段：active 渲染（防注入标记 + 轮数 + 勿停指引）；无目标/终态空串过滤", async () => {
    const { create, update, store } = mkStore();
    expect(goalSectionText(store)).toBe("");
    await exec(create, { objective: "把 README 翻译成英文", maxRounds: 10 });
    const text = goalSectionText(store);
    expect(text).toContain("<untrusted_objective>把 README 翻译成英文</untrusted_objective>");
    expect(text).toContain("第 1/10 轮");
    expect(text).toContain("未达终态不要停止");
    await exec(update, { action: "complete", reason: "done" });
    expect(goalSectionText(store)).toBe(""); // 终态段消
  });

  it("⑨ spendRound 记账：active 时 roundsUsed++ 且事件上行；终态不记", async () => {
    const { create, update, store, events } = mkStore();
    await exec(create, { objective: "g" });
    store.spendRound();
    store.spendRound();
    expect(store.current()?.roundsUsed).toBe(2);
    await exec(update, { action: "complete", reason: "x" });
    const before = store.current()?.roundsUsed;
    store.spendRound();
    expect(store.current()?.roundsUsed).toBe(before);
    expect(events.length).toBeGreaterThanOrEqual(4); // create + 2 轮 + complete
  });

  it("⑩ 模块装配：注册三工具 + promptSection order 22 + 事件白名单 tool-goal/change", async () => {
    const tools: Tool[] = [];
    const sections: { order: number }[] = [];
    const appends: { type: string }[] = [];
    const ctx = {
      config: undefined, configRead: () => Promise.resolve(undefined), log: noLog,
      contribute: {
        tool: (t: Tool) => (tools.push(t), () => {}),
        command: () => () => {},
        promptSection: (s: { order: number }) => (sections.push(s), () => {}),
      },
      session: { append: (type: string) => { appends.push({ type }); } },
      events: { on: () => () => {}, emit: () => Promise.resolve() },
    } as unknown as ModuleContext;
    toolGoal.activate(ctx);
    expect(tools.map((t) => t.name)).toEqual(["tool-goal__create", "tool-goal__get", "tool-goal__update"]);
    expect(sections[0]?.order).toBe(22);
    // 白名单：append 只会是声明过的 tool-goal/change（经 create 触发一次验证）
    const plan = await tools[0]!.resolveExecution({ objective: "x" });
    await plan.execute({ callId: "c", signal: new AbortController().signal, log: noLog });
    expect(appends).toEqual([{ type: "tool-goal/change" }]);
  });

  it("⑪ harness 集成：create 后下一 turn 系统提示含目标段；complete 结清后再下一 turn 段消", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-goal-"));
    const script: Chunk[][] = [
      // turn 1：立目标
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "tool-goal__create",
          argumentsDelta: JSON.stringify({ objective: "集成走查目标" }) },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "已立" }, { type: "finish", kind: "stop" }],
      // turn 2：结清（此 turn 系统提示应含目标段——system 在 turn 开头拼一次（harness.ts:620）保缓存，
      // 首版「同 turn 含段」预期被实证修正：create 的段从下一起 turn 生效）
      [
        { type: "toolcall/argumentsDelta", callId: "c2", name: "tool-goal__update",
          argumentsDelta: JSON.stringify({ action: "complete", reason: "走查完成" }) },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "已结清" }, { type: "finish", kind: "stop" }],
      // turn 3：纯文本（段应已消）
      [{ type: "text/delta", text: "好" }, { type: "finish", kind: "stop" }],
    ];
    const fp = fakeProvider(script); // requests 捕获含 system——状态段装配的取证口
    const providerMod = fakeModule("provider-fake", { activate: (ctx) => ctx.provide("provider:fake" as never, fp.stream) });
    const mem = new InMemorySessionStore();
    const h = await createHarness({
      store: mem,
      diagDir: dir, spillDir: join(dir, "spill"),
      modules: [toolGoal, providerMod],
      config: { userFile: join(dir, "n.toml"), projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    await h.prompt("立目标");
    await h.prompt("结清");
    await h.prompt("随便聊聊");
    await h.close();
    const all = await mem.all();
    expect(fp.requests).toHaveLength(5);
    // turn 2 起始（requests[2]）系统提示含目标段 + 防注入标记
    expect(fp.requests[2]!.system).toContain("集成走查目标");
    expect(fp.requests[2]!.system).toContain("untrusted_objective");
    // turn 3（requests[4]）结清后段消
    expect(fp.requests[4]!.system).not.toContain("Current Goal");
    // 事件流落会话（存源——恢复面）
    const changes = all.filter((e) => e.type === "tool-goal/change");
    expect(changes.length).toBeGreaterThanOrEqual(2); // create + complete
    expect(all.some((e) => e.type === "tool/result" && e.callId === "c2" && String(JSON.stringify(e)).includes("已结清"))).toBe(true);
  });

  it("⑫ create 的 maxRounds 入账 + get 的剩余轮数随 spendRound 递减", async () => {
    const { create, get, store } = mkStore();
    await exec(create, { objective: "g", maxRounds: 3 });
    store.spendRound();
    store.spendRound();
    const snap = JSON.parse((await exec(get, {})).output) as Record<string, unknown>;
    expect(snap["roundsRemaining"]).toBe(1);
  });
});
