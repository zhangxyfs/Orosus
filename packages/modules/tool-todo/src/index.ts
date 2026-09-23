import { defineModule } from "@orosus/contracts/module";
import { defineTool, type Tool } from "@orosus/contracts/tool";
import { z } from "zod";

interface TodoItem { content: string; status: "pending" | "in_progress" | "done" }
export interface TodoState { todos: TodoItem[] }

const render = (todos: TodoItem[]): string =>
  todos.length === 0 ? "" : `## Current Tasks\n${todos.map((t, i) =>
    `${i + 1}. ${t.status === "done" ? "✓" : t.status === "in_progress" ? "→" : "□"} ${t.content}`).join("\n")}`;

// 使用时机引导（ROADMAP ①，2026-09-23）：工具 description 只管调用规则（整表替换/完成即标），不管「该不该用」——
// 多步先建清单、随执行更新、完成即标、单步不必（claude-code 同款口径）；英文 = 核心提示词全英文定案（M4-2 T12/B10）
const TODO_GUIDANCE = `For multi-step tasks, create a todo list with the tool-todo__todo_write tool before starting work, keep it updated as you go, and mark items done immediately after completing them.
Single-step tasks do not need a todo list.`;

/** 工厂：工具与状态同闭包——模块侧 promptSection 经 state 读最新值（tool-fs 工厂可测面同款）。 */
export function createTodoTool(onWrite?: (todos: TodoItem[]) => void): { tool: Tool; state: TodoState } {
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
          // 全完成双写分叉（2026-09-23 用户拍板「完成后别清掉，也许用户还想看」）：
          // 模型面照旧清空（提示词不背完成账——cc-haha 机理，测试③④口径不动）；
          // 日志面落全量终痕（全 ✓）——面板投影 .at(-1) 留住完成态，不被自动清空抹掉。
          // onWrite 上行是面板唯一通道（ToolContext 无 session 口——TUI 批 F4 定的回调面）
          const allDone = newTodos.length > 0 && newTodos.every((t) => t.status === "done");
          state.todos = allDone ? [] : newTodos;
          onWrite?.(allDone ? newTodos : state.todos);
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
  logEvents: ["tool-todo/write"], // 任务面板投影读口（TUI 批阶段三 F4——append 白名单前置）
  activate(ctx) {
    const { tool, state } = createTodoTool((todos) => ctx.session.append("tool-todo/write", { todos }));
    ctx.contribute.tool(tool);
    ctx.contribute.promptSection({
      order: 10, // skill=0 之后、mcp=20 之前（M4-2 批 B 分配表）
      // 引导常驻（ROADMAP ①）：旧版空清单 render 返回空串→整段被 promptSections() 过滤，模型首用前看不到任何引导；
      // 现段文本 = 引导 +（有清单时）Current Tasks 拼装。引导随模块走（模块关闭整段消失），不进核心五节
      get text() {
        const list = render(state.todos); // getter——promptSections() 聚合时读最新状态
        return list === "" ? TODO_GUIDANCE : `${TODO_GUIDANCE}\n\n${list}`;
      },
    });
  },
});
