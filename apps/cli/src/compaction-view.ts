import * as theme from "./theme.ts";
import { relativeTime } from "./sessions.ts";
import { wrapText } from "./tui/width.ts";

/** Ctrl+O 压缩摘要查看口的数据装配（2026-09-27 用户反馈「只显示最后一次」改全部列出）：
 *  事件流里全部 turn/compaction 逐次编号，展示最新在最上——开窗即见最近一次，旧的往下翻。
 *  头行 = 次序 / 相对时间（relativeTime 与 /sessions 同源）/ 触发方式 / 压掉条数；
 *  tokens 数字不落事件（只进命令回显文案），不编造。正文逐行包灰（viewText 按 split("\n")
 *  渲染，整段包一次会在行间丢色）。摘要长行先按 width 折行再包色（viewText 不折行、
 *  超宽行会被弹窗截断丢字——子代理查看窗按窗宽预折行同款口径）。
 *  无任何可用事件 → undefined（调用方走 toast/提示行）。 */
export function compactionSummaryView(
	events: readonly { type: string; ts?: string; [k: string]: unknown }[],
	opts: { width?: number } = {},
): { title: string; text: string } | undefined {
	const width = Math.max(20, opts.width ?? 80);
	const all = events.filter((e) => e.type === "turn/compaction") as { summary?: unknown; ts?: string; trigger?: unknown; droppedCount?: unknown }[];
	if (all.length === 0 || all.every((e) => e.summary === undefined)) return undefined;
	const sections = [...all].reverse().map((e, rev) => {
		const meta = [
			typeof e.ts === "string" ? relativeTime(new Date(e.ts).getTime()) : "",
			typeof e.trigger === "string" && e.trigger !== "" ? e.trigger : "",
			Number(e.droppedCount ?? 0) > 0 ? `${Number(e.droppedCount)} 条历史` : "",
		].filter(Boolean).join(" · ");
		const head = theme.fg("accent", `── 第 ${all.length - rev} 次压缩${meta !== "" ? ` · ${meta}` : ""} ──`);
		const body = e.summary === undefined ? [] : wrapText(String(e.summary), width).map((l) => theme.fg("muted", l));
		return [head, ...body].join("\n");
	});
	return { title: `压缩摘要${all.length > 1 ? `（共 ${all.length} 次）` : ""}`, text: sections.join("\n\n") };
}
