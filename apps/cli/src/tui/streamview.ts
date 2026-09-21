/** 滚动流流式视图（TUI 批阶段三 F2——liveview 的替换件，缺陷⑨销账）。
 *  架构：EventProjector（chunk → md/think 块）+ DiffScreen（行级 diff 渲染）——liveview 的
 *  「上移 N 行按已画视觉行数记账」是缺陷⑨根因（长文本折行下记账与终端实际行数错位累积）；
 *  本件的帧缓冲是行数组下标对齐，折行由 mdpipe/wrapText 先折成物理行再进帧，终端折行不进账
 *  （spike §四 对照实验：唯一标记全历史计数恰好 1）。
 *  帧调度 = FrameScheduler（16ms 节流 + 输入抢占——替换 liveview 的 80ms 自制节流）。
 *  语义对照 liveview：write（工具/事件行）先固化活动块再直写；discard 擦除临时活动块
 *  （/compact 指示行消费）；end 定格 turn 终稿。思考块流式独有全显 dim（回显不画——既有定案）。 */

import { createStreamingMarkdown, renderMarkdown, type StreamingMarkdown } from "../mdpipe.ts";
import * as theme from "../theme.ts";
import { wrapText } from "./width.ts";
import { DiffScreen } from "./diffscreen.ts";
import { FrameScheduler } from "./scheduler.ts";

export interface StreamChunk {
	kind: "text" | "reasoning";
	text: string;
}

export function createStreamView(io: { write(s: string): void; isTTY: boolean; columns(): number }): {
	write(s: string): void;
	activity(c: StreamChunk): void;
	discard(): void;
	end(): void;
} {
	// 非 TTY 全直通（硬保底：管道/--print 零 ANSI 零缓冲——与 liveview 同款退化形态）
	if (!io.isTTY) {
		let inR = false;
		const closeR = (): string => {
			if (!inR) return "";
			inR = false;
			return "\x1b[22m\n";
		};
		return {
			write: (s) => io.write(s),
			activity(c: StreamChunk): void {
				if (c.kind === "reasoning") {
					if (!inR) {
						inR = true;
						io.write(`\n[2m[思考] ${c.text}`);
						return;
					}
					io.write(c.text);
					return;
				}
				io.write(closeR() + c.text);
			},
			discard(): void {},
			end(): void {
				io.write(closeR());
			},
		};
	}
	const diff = new DiffScreen(io.write);
	const scheduler = new FrameScheduler(() => frame());
	const lines: string[] = []; // 定格行（工具/事件行 + 已固化块）
	let mdText = "";
	let thinkText = "";
	let inThink = false;
	let mdStream: StreamingMarkdown | undefined;
	let streamWidth = -1;

	const thinkBlock = (text: string, w: number): string[] => {
		const raw = wrapText(text, Math.max(8, w - 2));
		return raw.map((l, i) => theme.dim((i === 0 ? "[思考] " : "  ") + l));
	};

	const mdRender = (text: string, w: number): string[] => {
		if (streamWidth !== w || mdStream === undefined) {
			streamWidth = w;
			mdStream = createStreamingMarkdown(w);
		}
		return mdStream.render(text);
	};

	const frame = (): number => {
		const w = io.columns();
		const buf = [...lines];
		if (thinkText !== "") buf.push(...thinkBlock(thinkText, w));
		if (mdText !== "") buf.push(...mdRender(mdText, w));
		return diff.render(buf, w);
	};

	const requestFrame = (): void => scheduler.requestRender();

	/** 活动块固化（write/end 前）：md → 终稿渲染进定格行；think → dim 块进定格行。 */
	const settleActive = (): void => {
		const w = io.columns();
		if (mdText !== "") {
			lines.push(...renderMarkdown(mdText, w));
			mdText = "";
			mdStream = undefined; // 下一块重新冻结
		}
		if (thinkText !== "") {
			lines.push(...thinkBlock(thinkText, w));
			thinkText = "";
			inThink = false;
		}
	};

	return {
		activity(c: StreamChunk): void {
			if (c.kind === "reasoning") {
				if (!inThink && mdText !== "") {
					// 正文 → 思考的边界：正文块先固化（思考块流式独有，不与正文混排）
					const w = io.columns();
					lines.push(...renderMarkdown(mdText, w));
					mdText = "";
					mdStream = undefined;
				}
				inThink = true;
				thinkText += c.text;
			} else {
				inThink = false;
				mdText += c.text;
			}
			requestFrame();
		},
		write(s: string): void {
			settleActive(); // 工具/事件行：活动块先固化再上屏——交错序正确（liveview 同语义）
			for (const l of s.replace(/\n$/, "").split("\n")) lines.push(l);
			requestFrame();
		},
		discard(): void {
			// 临时活动块擦除（/compact 指示行——内容不固化，diff 行数收缩自然清尾）
			mdText = "";
			thinkText = "";
			inThink = false;
			mdStream = undefined;
			requestFrame();
		},
		end(): void {
			settleActive(); // turn 结束：定格终稿
			requestFrame();
		},
	};
}
