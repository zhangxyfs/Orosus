/** 分桶注记（批次一 T3 / 问题3病灶1）：子代理 goal 仅为记录——子代理系统提示为 spawn 定格文本、
 *  不消费主图 promptSections，其 loop 用独立 bus（runner.ts:496），故子代理桶无提示段/续跑注入
 *  （拍板目标 = 主对话不被劫持，此为其必然形态）。桶选择与落盘路由见 activate 内 storeOf。 */
import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { defineTool, type Tool, type ToolContext } from "@orosus/contracts/tool";
import { createGoalStore, OBJECTIVE_MAX, BLOCKED_STREAK_REQUIRED, type GoalStore, type GoalState } from "./state.ts";

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
 *  kimi 的预算工具并入 create 参数，v1 不独设）。
 *  桶选择（批次一 T3）：入参既收恒定单桶（既有调用面——单测直配/旧接线，行为不变），也收按执行身份
 *  取桶的 resolve 函数（activate 装配面）——同一批 Tool 实例被主图与子代理 registry 双注册（runner.ts:515
 *  全量抄走），身份只能在 execute 期按 ctx 辨。 */
export function goalTools(selection: GoalStore | ((ctx: ToolContext) => GoalStore)): Tool[] {
  const storeOf = (ctx: ToolContext): GoalStore => (typeof selection === "function" ? selection(ctx) : selection);
  return [
    defineTool({
      name: "tool-goal__create",
      description: `Create the session goal (single-goal discipline: one active goal at a time).
A goal keeps you working across rounds — you will be reminded until it reaches a terminal state.
Use when the user gives a task that needs sustained multi-step work. Do NOT create for one-shot questions.`,
      parameters: z.object({
        objective: z.string().min(1).describe(`Objective (≤${OBJECTIVE_MAX} chars; if longer, write it to a file first and pass the path plus a summary)`),
        maxRounds: z.number().int().positive().optional().describe("Optional positive limit on continuation rounds (exceeding it sets blocked automatically; default unlimited — a fuse, not a gate)"),
        replace: z.boolean().optional().describe("Set to true to replace the current active goal (by default, colliding with the single active goal errors and reports the current state)"),
      }),
      resolveExecution: (input) => {
        const { objective, maxRounds, replace } = input as { objective: string; maxRounds?: number; replace?: boolean };
        return Promise.resolve({
          accesses: [],
          approvalRule: "tool-goal__create",
          execute: (ctx) => {
            const store = storeOf(ctx);
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
        execute: (ctx) => Promise.resolve({ output: snapshotJson(storeOf(ctx).current()), isError: false }),
      }),
    }),
    defineTool({
      name: "tool-goal__update",
      description: `Update the session goal: report completion or blockage.
complete: the objective is fully achieved — state the evidence in reason.
blocked: ONLY when truly stuck — requires the SAME blocker reported on 3 consecutive continuation rounds to be accepted.`,
      parameters: z.object({
        action: z.enum(["complete", "blocked"]).describe(`"complete" = done; "blocked" = cannot proceed (accepted only after the same blocking condition persists for ${BLOCKED_STREAK_REQUIRED} consecutive rounds — difficulty or merely unfinished work is not blocked)`),
        reason: z.string().min(1).describe("Evidence of completion / the concrete blocking condition (what is stopping you, what you have tried)"),
      }),
      resolveExecution: (input) => {
        const { action, reason } = input as { action: "complete" | "blocked"; reason: string };
        return Promise.resolve({
          accesses: [],
          approvalRule: "tool-goal__update",
          execute: (ctx) => {
            const store = storeOf(ctx);
            if (action === "complete") {
              const r = store.complete(reason);
              return Promise.resolve({ output: r.ok ? `目标已结清为完成：${reason.slice(0, 200)}` : r.message, isError: !r.ok });
            }
            const r = store.claimBlocked(reason);
            // MV-06：streak 未满的打回不是错误——是「继续」的指引（方案 T6 接口注记）；但「无活动目标」
            // 是前置条件失败（与 complete 路径同构的时序错误），豁免不再无差别覆盖到它
            return Promise.resolve({ output: r.message, isError: r.noActiveGoal === true });
          },
        });
      },
    }),
  ];
}

/** 状态段文本（getter 活读——active 提醒；无目标/终态空串被过滤不占预算；objective 包防注入标记
 *  ZCode <untrusted_objective> target.ts:131 同款）。m4-6 T6：段内不带轮次计数——目标活跃期段恒定，
 *  前缀缓存不每轮击穿；轮次随每轮 <goal-round> 消息注入（goalFollowUp，消息位）。 */
export function goalSectionText(store: GoalStore): string {
  const s = store.current();
  if (s === null || s.status !== "active") return "";
  return `## Current Goal
Current objective (continuation): <untrusted_objective>${s.objective}</untrusted_objective>
Do not stop before reaching a terminal state — report complete via tool-goal__update when done; report blocked only if you truly cannot proceed (accepted after the same blocking condition persists for ${BLOCKED_STREAK_REQUIRED} consecutive rounds).`;
}

/** followUp 续跑轮（M4-3 T7/D7——Goal 与 todo 的分水岭）：模型无工具调用欲停时，目标未达终态且预算未尽
 *  → 注入续跑消息继续循环（loop.ts:213-216 collect 缝；dsh <goal-round> 信封同款，dsh/ZCode 刻意走用户
 *  消息位保 system 缓存——steering 正是用户位）。预算尽 → 不再注入，自动停轮并置 blocked 提示超预算
 *  （kimi 超预算置 blocked goalService.ts:942 同款）。零内核改动。 */
export function goalFollowUp(store: GoalStore): { text: string; sourceModule: string }[] {
  const s = store.current();
  if (s === null || s.status !== "active") return [];
  if (store.exhaustBudget()) {
    // [非用户输入] 头同 goal-round 续跑轮（同批对照修——System Messages 节声明的合成行族）
    return [{
      text: `[非用户输入] 目标续跑预算已耗尽（${s.roundsUsed}/${s.maxRounds} 轮）——已自动结清为受阻态（blocked）。向用户说明进展与卡点。`,
      sourceModule: "tool-goal",
    }];
  }
  store.spendRound(); // 本轮记账（事件上行——dsh goal-round-driver 逐轮持久同款）
  const n = s.roundsUsed + 1;
  // [非用户输入] 头（2026-10-03 对照修）：核心 System Messages 节（kernel.ts）声明三类合成行——后台子代理结论、
  // goal round reminders、日期提醒——都以 `[非用户输入]` 开头；本行原先只有 <goal-round> 自有信封，声明头缺席
  // （防伪造教育的覆盖面有洞——模型模仿 <goal-round> 行不在禁令内）。头在最前、信封保留；消息位注入不伤前缀缓存。
  return [{
    text: `[非用户输入] <goal-round 第 ${n} 轮>当前目标：<untrusted_objective>${s.objective}</untrusted_objective>。
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
    // 分桶（批次一 T3 / 问题3病灶1）：Map 按执行身份持桶（键 = ctx.agent?.agentId ?? "main"，批次一统一约定）。
    // 主桶落盘走 activate 期白名单通道（现状不变）；子代理桶经 T1 ctx.sessionAppend 落自己的 session.jsonl
    // （载荷带 agentId 归属，同 T2 路由口径——sessionAppend 每 spawn 一次构造，桶创建期捕获即稳态）。
    const buckets = new Map<string, GoalStore>();
    const main = createGoalStore((s) => ctx.session.append("tool-goal/change", { goal: s }));
    buckets.set("main", main); // 预置主桶——下行 promptSection/续跑订阅钉死读它
    const storeOf = (tctx: ToolContext): GoalStore => {
      const key = tctx.agent?.agentId ?? "main";
      let b = buckets.get(key);
      if (b === undefined) {
        b = createGoalStore((s) => tctx.sessionAppend?.("tool-goal/change", { goal: s, agentId: key }));
        buckets.set(key, b);
      }
      return b;
    };
    for (const t of goalTools(storeOf)) ctx.contribute.tool(t);
    // 钉死 main 桶（病灶 1 修复核心）：子代理目标改不了主提示段、劫持不了主循环续跑——
    // 子代理本就无此二缝（见文件头注记），主对话只消费自己的目标
    ctx.contribute.promptSection({ order: 22, get text() { return goalSectionText(main); } }); // tool-search 目录段 21 之后的空位（kernel 分配表）
    ctx.events.on("agent/follow-up", () => goalFollowUp(main)); // 续跑轮（T7——collect 缝订阅，模型欲停即续）
  },
});
