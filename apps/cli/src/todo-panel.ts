/**
 * 任务清单面板投影（2026-09-23 实时化——用户拍板「都写到会话日志了为啥不能实时刷」）：
 * tool-todo/write 事件载荷即全量清单，onEvent 直改 panelCache（FullApp 秒 tick 自动重绘），
 * 不再只有 turn 结束 refreshPanel 一个检查点。独立成文件：main.ts 是副作用脚本不可 import，回归钉在此。
 */

/** todo/write 事件 → 面板任务行；非 todo 事件 / 载荷缺失或非数组 → undefined（调用方跳过不改）。
 *  空数组返回 []——全完成自动清空（tool-todo 模块规矩）的落点，面板同步清空是语义不是丢数据。 */
export function panelTasksFromEvent(
	e: { type: string; todos?: unknown },
): { text: string; state: "done" | "active" | "pending" }[] | undefined {
	if (e.type !== "tool-todo/write" || !Array.isArray(e.todos)) return undefined;
	return (e.todos as { content: string; status: "pending" | "in_progress" | "done" }[]).map((t) => ({
		text: t.content,
		state: t.status === "done" ? "done" : t.status === "in_progress" ? "active" : "pending",
	}));
}
