import { defineModule } from "@orosus/contracts/module";
import { defineTool, type Tool } from "@orosus/contracts/tool";
import type { CommandUi } from "@orosus/contracts/module";
import { z } from "zod";

/** 工厂：ui 经参数注入（模块侧传 ctx.ui；测试侧传假件——tool-todo T7 可测面同款）。 */
export function askUserTool(ui: Pick<CommandUi, "ask" | "choose">): Tool {
  return defineTool({
    name: "tool-ask__ask_user",
    description: `Ask the user questions when you need their input to proceed.

WHEN TO USE: A decision genuinely belongs to the user and you cannot resolve it from the request, code, or sensible defaults.

WHEN NOT TO USE: If you can infer the answer from context, do so and continue.
Don't ask about trivial choices. Overusing this tool interrupts the user's workflow —
only ask when the user's input genuinely changes your next action.
Don't repeat a question the user didn't answer.

If the user dismisses/cancels: they chose not to answer.
Do NOT pick an option for them. Stop and wait for the user's next message.`,
    parameters: z.object({
      questions: z.array(z.object({
        text: z.string().describe("问题文本"),
        options: z.array(z.string()).min(2).max(4).optional()
          .describe("选项（省略 = 自由文本输入）"),
      })).min(1).max(4),
    }),
    resolveExecution: async (input) => {
      const { questions } = input as { questions: { text: string; options?: string[] }[] };
      return {
        accesses: [],
        approvalRule: "tool-ask__ask_user",
        execute: async () => {
          try {
            const answers: string[] = [];
            for (const q of questions) { // 串行——readline 非并发安全（M3 审批 FIFO 先例）
              if (q.options !== undefined && q.options.length >= 2) {
                answers.push(await ui.choose(q.text, q.options));
              } else {
                answers.push(await ui.ask(q.text));
              }
            }
            return { output: answers.join("\n"), isError: false };
          } catch {
            // Reasonix 回退语义：不阻塞——模型假设 + 声明 + 选最安全可逆
            return {
              output: "无交互用户——这是模型假设回退，不是用户回答。用你的最佳判断继续，声明你做的假设，选最安全的可逆选项。",
              isError: true,
            };
          }
        },
      };
    },
  });
}

export default defineModule({
  name: "tool-ask",
  version: "0.1.0",
  description: "模型向用户提问——结构化选项/确认/文本输入",
  api: 1,
  activate(ctx) {
    ctx.contribute.tool(askUserTool(ctx.ui));
  },
});
