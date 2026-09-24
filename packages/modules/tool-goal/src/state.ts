/** Goal 状态机（M4-3 T6/D7）：单目标 + active/blocked/complete 三态（五家 FSM 公共子集——paused 顺延 /goal 命令批）。
 *  纯逻辑件（不碰工具契约）——create/complete/claimBlocked/spendRound 全部带内返回，不抛错。 */

export interface GoalState {
  objective: string;
  status: "active" | "blocked" | "complete";
  /** 已消耗的续跑轮（T7 followUp 注入一轮记一次）。 */
  roundsUsed: number;
  /** 轮数预算（SW-12 缺省无限——预算是保险丝不是门槛）。 */
  maxRounds?: number | undefined;
  /** 连续同一阻塞声明的轮数（三连判定账本——dsh blockedAfterConsecutiveRounds=3 同款，同 reason 加严取 qwen 语义）。 */
  blockedStreak: number;
  blockedReason?: string | undefined;
  completeReason?: string | undefined;
  createdAt: string;
}

export const OBJECTIVE_MAX = 4000; // SW-12：kimi goalService.ts:84 / ZCode target.ts:18（qwen 1500，取宽值）
export const BLOCKED_STREAK_REQUIRED = 3; // dsh :33 / Reasonix goal_lifecycle_owner.go:14 / kimi「≥3 consecutive」指引

export interface GoalStore {
  current(): GoalState | null;
  create(input: { objective: string; maxRounds?: number | undefined; replace?: boolean | undefined }): { ok: true } | { ok: false; message: string };
  complete(reason: string): { ok: true } | { ok: false; message: string };
  claimBlocked(reason: string): { accepted: boolean; streak: number; message: string };
  /** T7 续跑轮记账：active 时 roundsUsed++（预算尽由 T7 判定停轮，本件只记账）。 */
  spendRound(): void;
  /** T7 预算耗尽处置（kimi 超预算置 blocked goalService.ts:942 同款）：active 且轮数尽 → 置 blocked；
     *  返回 true = 本次触发（幂等——已终态/无预算/未尽返回 false）。 */
  exhaustBudget(): boolean;
}

/** 工厂：onChange = 变更上行口（模块侧 ctx.session.append("tool-goal/change", snapshot)——存源不存渲染）。 */
export function createGoalStore(onChange?: (s: GoalState | null) => void): GoalStore {
  let state: GoalState | null = null;
  const emit = () => onChange?.(state === null ? null : { ...state });
  return {
    current: () => (state === null ? null : { ...state }),

    create(input) {
      const objective = input.objective.trim();
      if (objective === "") return { ok: false, message: "objective 不能为空——给一句可达成的目标描述" };
      if (objective.length > OBJECTIVE_MAX) {
        return { ok: false, message: `objective 超过 ${OBJECTIVE_MAX} 字符上限（当前 ${objective.length}）——先写入文件，再把路径与摘要作为 objective（kimi goalService.ts:84 同款指引）` };
      }
      if (state !== null && state.status === "active" && input.replace !== true) {
        return { ok: false, message: `已有活动目标（单目标制——dsh GOAL_ALREADY_EXISTS 同款）：「${state.objective.slice(0, 120)}」。完成/放弃它，或带 replace: true 覆盖` };
      }
      state = {
        objective,
        status: "active",
        roundsUsed: 0,
        ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
        blockedStreak: 0,
        createdAt: new Date().toISOString(),
      };
      emit();
      return { ok: true };
    },

    complete(reason) {
      if (state === null || state.status !== "active") {
        return { ok: false, message: `当前无活动目标（状态：${state?.status ?? "无"}）——先 tool-goal__create 立目标` };
      }
      state = { ...state, status: "complete", completeReason: reason };
      emit();
      return { ok: true };
    },

    claimBlocked(reason) {
      if (state === null || state.status !== "active") {
        return { accepted: false, streak: 0, message: `当前无活动目标（状态：${state?.status ?? "无"}）` };
      }
      const r = reason.trim();
      if (r === "") return { accepted: false, streak: state.blockedStreak, message: "blocked 需要具体阻塞原因（什么挡着你、试过什么）" };
      // 三连判定：同 reason 计数 +1，变词清零重计（qwen 同 reason 加严语义——SW 映射表 Goal 节）
      if (state.blockedReason === r) state.blockedStreak += 1;
      else { state = { ...state, blockedReason: r, blockedStreak: 1 }; }
      if (state.blockedStreak >= BLOCKED_STREAK_REQUIRED) {
        state = { ...state, status: "blocked" };
        emit();
        return { accepted: true, streak: state.blockedStreak, message: `已接受 blocked（连续 ${state.blockedStreak} 轮同一阻塞）——目标结清为受阻态` };
      }
      emit(); // streak 账也上行（dsh goal/change 逐变更新同款）
      return {
        accepted: false,
        streak: state.blockedStreak,
        message: `阻塞证据不足（第 ${state.blockedStreak}/${BLOCKED_STREAK_REQUIRED} 轮同一原因）——继续推进；确无法推进时下一续跑轮再以同一原因报 blocked`,
      };
    },

    spendRound() {
      if (state !== null && state.status === "active") {
        state = { ...state, roundsUsed: state.roundsUsed + 1 };
        emit();
      }
    },

    exhaustBudget() {
      if (state === null || state.status !== "active") return false;
      if (state.maxRounds === undefined || state.roundsUsed < state.maxRounds) return false;
      state = { ...state, status: "blocked", blockedReason: `续跑轮预算耗尽（${state.roundsUsed}/${state.maxRounds}）` };
      emit();
      return true;
    },
  };
}
