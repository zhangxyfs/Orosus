import { defineModule } from "@orosus/contracts/module";
import { defineTool, type Tool } from "@orosus/contracts/tool";
import { z } from "zod";

interface TodoItem { content: string; status: "pending" | "in_progress" | "done" }
export interface TodoState { todos: TodoItem[] }

const render = (todos: TodoItem[]): string =>
  todos.length === 0 ? "" : `## Current Tasks\n${todos.map((t, i) =>
    `${i + 1}. ${t.status === "done" ? "✓" : t.status === "in_progress" ? "→" : "□"} ${t.content}`).join("\n")}`;

/** 工厂：工具与状态同闭包——模块侧 promptSection 经 state 读最新值（tool-fs 工厂可测面同款）。 */
export function createTodoTool(): { tool: Tool; state: TodoState } {
  const state: TodoState = { todos: [] };
  const tool = defineTool({
    name: "tool-todo__todo_write",
    description: `Track progress on multi-step tasks. Send the ENTIRE list every call (whole-list replacement).
You can reorder, remove, add, or modify items freely.
Omit todos to READ the current list. Send [] to clear.
Mark tasks done IMMEDIATELY (do not batch). Keep exactly one in_progress when work is underway.
Do NOT call when nothing changed — query first if unsure. Auto-cleared when ALL items are done.`,
    parameters: z.object({
      todos: z.array(z.object({
        content: z.string().min(1),
        status: z.enum(["pending", "in_progress", "done"]),
      })).optional(),
    }),
    resolveExecution: async (input) => {
      const { todos: newTodos } = input as { todos?: TodoItem[] };
      return {
        accesses: [],
        approvalRule: "tool-todo__todo_write",
        execute: async () => {
          if (newTodos === undefined) {
            return { output: render(state.todos) || "（清单为空）", isError: false };
          }
          state.todos = newTodos.every((t) => t.status === "done") ? [] : newTodos; // allDone 自动清空（cc-haha）
          return { output: state.todos.length === 0 ? "Todo list cleared." : `Todo list updated:\n${render(state.todos)}`, isError: false };
        },
      };
    },
  });
  return { tool, state };
}

export default defineModule({
  name: "tool-todo",
  version: "0.1.0",
  description: "任务清单——模型多步任务的自我跟踪",
  api: 1,
  activate(ctx) {
    const { tool, state } = createTodoTool();
    ctx.contribute.tool(tool);
    ctx.contribute.promptSection({
      order: 10, // skill=0 之后、mcp=20 之前（M4-2 批 B 分配表）
      get text() { return render(state.todos); }, // getter——promptSections() 聚合时读最新状态
    });
  },
});
