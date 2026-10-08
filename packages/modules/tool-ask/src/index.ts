import { defineModule } from "@orosus/contracts/module";
import { defineTool, type Tool } from "@orosus/contracts/tool";
import type { CommandUi } from "@orosus/contracts/module";
import { z } from "zod";

/** 工厂：ui 经参数注入（模块侧传 ctx.ui；测试侧传假件——tool-todo T7 可测面同款）。
 *  m5-ask-multi：chooseEx 为可选成员（老宿主假件不带即走降级路——D12 判空纪律）。 */
export function askUserTool(ui: Pick<CommandUi, "ask" | "choose" | "chooseEx">): Tool {
  return defineTool({
    name: "tool-ask__ask_user",
    description: `Ask the user questions when you need their input to proceed.

WHEN TO USE: A decision genuinely belongs to the user and you cannot resolve it from the request, code, or sensible defaults.

WHEN NOT TO USE: If you can infer the answer from context, do so and continue.
Don't ask about trivial choices. Overusing this tool interrupts the user's workflow —
only ask when the user's input genuinely changes your next action.
Don't repeat a question the user didn't answer.

If you have a recommended option, put it first and append "(Recommended)" to its label.

If the user dismisses/cancels: they chose not to answer.
Do NOT pick an option for them. Stop and wait for the user's next message.`,
    parameters: z.object({
      questions: z.array(z.object({
        text: z.string().describe("The complete question to ask the user"),
        options: z.array(z.string()).min(2).max(4).optional()
          .describe("The available choices for this question (omit for free-text input). "
            + "There should be no \"Other\" option, that will be provided automatically. "
            + "If multiSelect is true, phrase it accordingly"),
        multiSelect: z.boolean().optional()
          .describe("Whether the user may select multiple choices for this question "
            + "(only meaningful when options are given; an \"Other\" free-input choice is always appended by the UI)"),
      })).min(1).max(4),
    }),
    resolveExecution: async (input) => {
      const { questions } = input as { questions: { text: string; options?: string[]; multiSelect?: boolean }[] };
      return {
        accesses: [],
        approvalRule: "tool-ask__ask_user",
        execute: async () => {
          try {
            // 输出 = 题号行式（D10：cc/qwen 平文本回传同族——多选多行同题号；单选行同样带
            // `N: ` 前缀，防只有多选加编号的半吊子形态）
            const answers: string[] = [];
            for (let qi = 0; qi < questions.length; qi++) { // 串行——readline 非并发安全（M3 审批 FIFO 先例）
              const q = questions[qi]!;
              if (q.options !== undefined && q.options.length >= 2) {
                if (ui.chooseEx !== undefined) {
                  const picked = await ui.chooseEx(q.text, q.options, q.multiSelect === true ? { multi: true } : undefined);
                  for (const a of picked) answers.push(`${qi + 1}: ${a}`);
                } else if (q.multiSelect === true) {
                  // 老宿主降级（D12）：多选退 ask——提示选项与逗号分隔口径，答案原样单行带回
                  answers.push(`${qi + 1}: ${await ui.ask(`${q.text}（选项 ${q.options.join("/")}，可多选，逗号分隔）`)}`);
                } else {
                  // 老宿主降级：单选退老 choose（无「其他」行——纯损耗可接受，CLI 宿主同仓发布实际不遇）
                  answers.push(`${qi + 1}: ${await ui.choose(q.text, q.options)}`);
                }
              } else {
                answers.push(`${qi + 1}: ${await ui.ask(q.text)}`); // optionless 照旧（dsh 同款既有形态）
              }
            }
            return { output: answers.join("\n"), isError: false };
          } catch (err) {
            // MB-08（2026-09-28 code review）：取消 ≠ 无头，不能共用一个回退——
            // 宿主面 Esc 按 D35 约定抛「已取消（Esc）」（apps/cli menu/picker 已钉死该文案）：
            // 与 description「Stop and wait」对齐，取消 = 用户拒绝作答，不替用户选、停下等指示。
            if (err instanceof Error && err.message.includes("已取消")) {
              return {
                output: "用户取消了本次提问（Esc）——这不是回答：不要自行假设答案或替用户选选项，停下等用户的下一步指示。",
                isError: true,
              };
            }
            // 真无头（环境不可用）才走 Reasonix 回退语义：不阻塞——模型假设 + 声明 + 选最安全可逆
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
