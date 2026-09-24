import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { defineTool, type Tool } from "@orosus/contracts/tool";
import { createGoalStore, OBJECTIVE_MAX, type GoalStore, type GoalState } from "./state.ts";

export { createGoalStore, OBJECTIVE_MAX, BLOCKED_STREAK_REQUIRED, type GoalStore, type GoalState } from "./state.ts";

const snapshotJson = (s: GoalState | null): string => {
  if (s === null) return "当前无活动目标——tool-goal__create 可立。";
  const remaining = s.maxRounds !== undefined ? Math.max(0, s.maxRounds - s.roundsUsed) : null;
  return JSON.stringify({
    objective: s.objective,
    status: s.status,
    roundsUsed: s.roundsUsed,
    ...(s.maxRounds !== undefined ? { maxRounds: s.maxRounds, roundsRemaining: remaining } : {}),
    blockedStreak: s.blockedStreak,
    ...(s.blockedReason !== undefined ? { blockedReason: s.blockedReason } : {}),
    ...(s.completeReason !== undefined ? { completeReason: s.completeReason } : {}),
    createdAt: s.createdAt,
  }, null, 2);
};

/** 三工具（dsh tool-goal index.ts:196/208/235 与 Reasonix creategoal/getgoal/updategoal 同族——
 *  kimi 的预算工具并入 create 参数，v1 不独设）。 */
export function goalTools(store: GoalStore): Tool[] {
  return [
    defineTool({
      name: "tool-goal__create",
      description: `Create the session goal (single-goal discipline: one active goal at a time).
A goal keeps you working across rounds — you will be reminded until it reaches a terminal state.
Use when the user gives a task that needs sustained multi-step work. Do NOT create for one-shot questions.`,
      parameters: z.object({
        objective: z.string().min(1).describe(`目标描述（≤${OBJECTIVE_MAX} 字符；更长请先写文件再给路径与摘要）`),
        maxRounds: z.number().int().positive().optional().describe("可选：续跑轮预算（超限自动置 blocked；缺省无限——保险丝不是门槛）"),
        replace: z.boolean().optional().describe("true = 覆盖当前活动目标（缺省撞单目标报错带现状）"),
      }),
      resolveExecution: (input) => {
        const { objective, maxRounds, replace } = input as { objective: string; maxRounds?: number; replace?: boolean };
        return Promise.resolve({
          accesses: [],
          approvalRule: "tool-goal__create",
          execute: () => {
            const r = store.create({ objective, ...(maxRounds !== undefined ? { maxRounds } : {}), ...(replace !== undefined ? { replace } : {}) });
            if (!r.ok) return Promise.resolve({ output: r.message, isError: true });
            return Promise.resolve({ output: `目标已建立：${objective.slice(0, 200)}${objective.length > 200 ? "…" : ""}——未达终态不要停止（完成报 complete，受阻三轮同因报 blocked）。`, isError: false });
          },
        });
      },
    }),
    defineTool({
      name: "tool-goal__get",
      description: "Read the current session goal snapshot (objective, status, rounds used/remaining, blocked streak).",
      parameters: z.object({}),
      resolveExecution: () => Promise.resolve({
        accesses: [],
        approvalRule: "tool-goal__get",
        execute: () => Promise.resolve({ output: snapshotJson(store.current()), isError: false }),
      }),
    }),
    defineTool({
      name: "tool-goal__update",
      description: `Update the session goal: report completion or blockage.
complete: the objective is fully achieved — state the evidence in reason.
blocked: ONLY when truly stuck — requires the SAME blocker reported on 3 consecutive continuation rounds to be accepted.`,
      parameters: z.object({
        action: z.enum(["complete", "blocked"]).describe("complete = 已完成；blocked = 无法推进（需连续三轮同一原因才受理）"),
        reason: z.string().min(1).describe("完成的证据 / 阻塞的具体原因（什么挡着你、试过什么）"),
      }),
      resolveExecution: (input) => {
        const { action, reason } = input as { action: "complete" | "blocked"; reason: string };
        return Promise.resolve({
          accesses: [],
          approvalRule: "tool-goal__update",
          execute: () => {
            if (action === "complete") {
              const r = store.complete(reason);
              return Promise.resolve({ output: r.ok ? `目标已结清为完成：${reason.slice(0, 200)}` : r.message, isError: !r.ok });
            }
            const r = store.claimBlocked(reason);
            return Promise.resolve({ output: r.message, isError: false }); // 打回不是错误——是「继续」的指引（方案 T6 接口注记）
          },
        });
      },
    }),
  ];
}

/** 状态段文本（getter 活读——active 提醒；无目标/终态空串被过滤不占预算；objective 包防注入标记
 *  ZCode <untrusted_objective> target.ts:131 同款）。 */
export function goalSectionText(store: GoalStore): string {
  const s = store.current();
  if (s === null || s.status !== "active") return "";
  const rounds = s.maxRounds !== undefined ? `第 ${s.roundsUsed + 1}/${s.maxRounds} 轮` : `第 ${s.roundsUsed + 1} 轮`;
  return `## Current Goal
当前目标（续跑 ${rounds}）：<untrusted_objective>${s.objective}</untrusted_objective>
未达终态不要停止——完成用 tool-goal__update 报 complete；确无法推进报 blocked（连续三轮同一阻塞才受理）。`;
}

/** followUp 续跑轮（M4-3 T7/D7——Goal 与 todo 的分水岭）：模型无工具调用欲停时，目标未达终态且预算未尽
 *  → 注入续跑消息继续循环（loop.ts:213-216 collect 缝；dsh <goal-round> 信封同款，dsh/ZCode 刻意走用户
 *  消息位保 system 缓存——steering 正是用户位）。预算尽 → 不再注入，自动停轮并置 blocked 提示超预算
 *  （kimi 超预算置 blocked goalService.ts:942 同款）。零内核改动。 */
export function goalFollowUp(store: GoalStore): { text: string; sourceModule: string }[] {
  const s = store.current();
  if (s === null || s.status !== "active") return [];
  if (store.exhaustBudget()) {
    return [{
      text: `目标续跑预算已耗尽（${s.roundsUsed}/${s.maxRounds} 轮）——已自动结清为受阻态（blocked）。向用户说明进展与卡点。`,
      sourceModule: "tool-goal",
    }];
  }
  store.spendRound(); // 本轮记账（事件上行——dsh goal-round-driver 逐轮持久同款）
  const n = s.roundsUsed + 1;
  return [{
    text: `<goal-round 第 ${n} 轮>当前目标：<untrusted_objective>${s.objective}</untrusted_objective>。
继续推进；若确已无法推进，用 tool-goal__update 报 blocked 并给出具体阻塞。
若已完成，用 tool-goal__update 报 complete。`,
    sourceModule: "tool-goal",
  }];
}

export default defineModule({
  name: "tool-goal",
  version: "0.1.0",
  description: "Goal 工具族——贯穿会话的单目标状态（create/get/update + 状态段）",
  api: 1,
  logEvents: ["tool-goal/change"], // 变更事件流（存源不存渲染——fold 重建的恢复面顺延：ModuleContext 无会话事件读口，T8 登记）
  activate(ctx) {
    const store = createGoalStore((s) => ctx.session.append("tool-goal/change", { goal: s }));
    for (const t of goalTools(store)) ctx.contribute.tool(t);
    ctx.contribute.promptSection({ order: 22, get text() { return goalSectionText(store); } }); // tool-search 目录段 21 之后的空位（kernel 分配表）
    ctx.events.on("agent/follow-up", () => goalFollowUp(store)); // 续跑轮（T7——collect 缝订阅，模型欲停即续）
  },
});
