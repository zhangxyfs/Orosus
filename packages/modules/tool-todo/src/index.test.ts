import { describe, it, expect, afterEach } from "vitest";
import { createHarness, InMemorySessionStore } from "@orosus/core";
import { fakeProviderModule } from "@orosus/testing";
import type { Chunk } from "@orosus/contracts/provider";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import toolTodo, { createTodoTool } from "./index.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

// 工具单测直驱（tool-fs index.test 同款形态）：同一工厂实例经 resolveExecution + execute 驱动
const noLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const execTodo = async (steps: Record<string, unknown>[]) => {
  const { tool, state } = createTodoTool();
  let last: { output: string; isError: boolean } = { output: "", isError: false };
  let i = 0;
  for (const input of steps) {
    const plan = await tool.resolveExecution(input);
    last = await plan.execute({ callId: `c${++i}`, signal: new AbortController().signal, log: noLog });
  }
  return { last, state };
};

describe("tool-todo 单元（M4-2 T7/B15）", () => {
  it("① 整体替换 → 返回格式化清单（□/→/✓）", async () => {
    const { last } = await execTodo([{ todos: [
      { content: "读取文件", status: "pending" },
      { content: "写入修改", status: "in_progress" },
      { content: "已完成项", status: "done" },
    ] }]);
    expect(last.isError).toBe(false);
    expect(last.output).toContain("1. □ 读取文件");
    expect(last.output).toContain("2. → 写入修改");
    expect(last.output).toContain("3. ✓ 已完成项");
  });

  it("② 先写后查（同一实例两次调用）→ 查询返回清单且状态未变", async () => {
    const { last, state } = await execTodo([
      { todos: [{ content: "任务A", status: "pending" }] },
      {}, // 省略 todos = 查询
    ]);
    expect(last.output).toContain("任务A");
    expect(state.todos.length).toBe(1);
  });

  it("③ 全部 done → allDone 自动清空（状态与输出一致）", async () => {
    const { last, state } = await execTodo([{ todos: [
      { content: "A", status: "done" }, { content: "B", status: "done" },
    ] }]);
    expect(last.output).toContain("cleared");
    expect(state.todos).toEqual([]);
  });

  it("④ todos=[] → 空数组清空", async () => {
    const { state } = await execTodo([
      { todos: [{ content: "X", status: "pending" }] },
      { todos: [] },
    ]);
    expect(state.todos).toEqual([]);
  });
});

// ——集成：模块装配 + 脚本驱动工具回合 + promptSection 注入
describe("tool-todo 模块集成（M4-2 T7/B15）", () => {
  it("⑤ 脚本驱动工具回合 → promptSection 注入 Current Tasks；模块在图中", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-todo-"));
    // 两轮脚本：① 工具调用轮（toolcall/argumentsDelta + finish toolUse）② 收尾文本轮
    const script: Chunk[][] = [
      [
        { type: "toolcall/argumentsDelta", callId: "c1", name: "tool-todo__todo_write",
          argumentsDelta: JSON.stringify({ todos: [{ content: "读取文件", status: "in_progress" }, { content: "跑测试", status: "pending" }] }) },
        { type: "finish", kind: "toolUse" },
      ],
      [{ type: "text/delta", text: "清单已建立" }, { type: "finish", kind: "stop" }],
    ];
    const mem = new InMemorySessionStore();
    const h = await createHarness({
      store: mem,
      diagDir: dir, spillDir: join(dir, "spill"),
      modules: [toolTodo, fakeProviderModule("fake", script)],
      config: { userFile: join(dir, "n.toml"), projectFile: join(dir, "p.toml"), env: {}, cliOverrides: { model: "fake/m" } },
    });
    await h.prompt("帮我建清单"); // 普通 turn 返回 undefined——最终文本从会话事件断言
    const sections = h.graph().promptSections(); // close 前读——close 拆图
    await h.close();
    const all = await mem.all();
    expect(all.filter((e) => e.type === "assistant/message").map((e) => JSON.stringify(e)).join("\n")).toContain("清单已建立");
    expect(all.some((e) => e.type === "tool/result" && e.callId === "c1" && e.isError !== true)).toBe(true); // 工具真执行
    expect(sections).toContain("## Current Tasks");
    expect(sections).toContain("读取文件");
    expect(h.graph().audit().some((a) => a.name === "tool-todo")).toBe(true);
  });
});
