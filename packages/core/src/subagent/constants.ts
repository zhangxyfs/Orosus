/** 子代理批常量页（决策 5：写在代码常量文件里，想调整改常量即可）。
 *  依据：plans/2026-09-26-m4-5-subagent.md 决策 5/10/19/20/21。 */

/** 同时在跑的硬上限（含前台、后台、孙代理——先占 8 位之一、再排写闸，超了排队先来先服务）。 */
export const SUBAGENT_CONCURRENCY = 8;

/** 一张任务清单的最多条数（kimi Swarm 128 申报上限同款）。 */
export const SUBAGENT_LIST_MAX = 128;

/** 轮数上限（模型往返）；工种文件 maxTurns 只能更低（min 生效）。 */
export const SUBAGENT_MAX_TURNS = 40;

/** 结论保尾字符数（qwen 32K 截断保尾同款）。 */
export const SUBAGENT_CONCLUSION_TAIL = 32000;

/** 花名册在册保留的已结束条数（更早只留会话文件）。 */
export const SUBAGENT_ROSTER_KEEP = 32;

/** 花名册每条记录保留的最近动态条数（查看窗实时保留量同源）。 */
export const SUBAGENT_RECENT_EVENTS = 500;

/** 8 位编号长度（hex 小写；全系统唯一同源——决策 20，撞码重生成）。 */
export const SUBAGENT_ID_LEN = 8;
