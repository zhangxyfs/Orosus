/** 全屏文档模型（TUI 批阶段三 F3——chunk/event → 块 → 行数组的投影器）。
 *  与 F2 streamview 同族（EventProjector + mdpipe 渲染），差异在消费面：streamview 自带
 *  DiffScreen 帧输出；本件只产出行数组（frameLines），渲染归 FullApp/FullScreen——
 *  全屏模式每帧整屏重排，行源必须可读而不是已写出。 */

import { createStreamingMarkdown, renderMarkdown, type StreamingMarkdown } from "../mdpipe.ts";
import * as theme from "../theme.ts";
import { wrapText } from "./width.ts";
import type { StreamChunk } from "./streamview.ts";

export class DocModel {
	private lines: string[] = []; // 定格行（工具/事件行 + 已固化块）
	private mdText = "";
	private thinkText = "";
	private inThink = false;
	private mdStream: StreamingMarkdown | undefined;
	private streamWidth = -1;

	private thinkBlock(text: string, w: number): string[] {
		const raw = wrapText(text, Math.max(8, w - 2));
		return raw.map((l, i) => theme.dim((i === 0 ? "[思考] " : "  ") + l));
	}

	private mdRender(text: string, w: number): string[] {
		if (this.streamWidth !== w || this.mdStream === undefined) {
			this.streamWidth = w;
			this.mdStream = createStreamingMarkdown(w);
		}
		return this.mdStream.render(text);
	}

	/** 活动块固化（write/end 前）：md → 终稿渲染进定格行；think → dim 块进定格行。 */
	private settleActive(width: number): void {
		if (this.mdText !== "") {
			this.lines.push(...renderMarkdown(this.mdText, width));
			this.mdText = "";
			this.mdStream = undefined;
		}
		if (this.thinkText !== "") {
			this.lines.push(...this.thinkBlock(this.thinkText, width));
			this.thinkText = "";
			this.inThink = false;
		}
	}

	activity(c: StreamChunk, width: number): void {
		if (c.kind === "reasoning") {
			if (!this.inThink && this.mdText !== "") {
				this.lines.push(...renderMarkdown(this.mdText, width));
				this.mdText = "";
				this.mdStream = undefined;
			}
			this.inThink = true;
			this.thinkText += c.text;
		} else {
			this.inThink = false;
			this.mdText += c.text;
		}
	}

	/** 工具/事件行：活动块先固化再追加（交错序正确——streamview 同语义）。 */
	write(s: string, width: number): void {
		this.settleActive(width);
		for (const l of s.replace(/\n$/, "").split("\n")) this.lines.push(l);
	}

	/** turn 结束定格。 */
	end(width: number): void {
		this.settleActive(width);
	}

	/** 临时活动块擦除（/compact 指示行——内容不固化）。 */
	discard(): void {
		this.mdText = "";
		this.thinkText = "";
		this.inThink = false;
		this.mdStream = undefined;
	}

	/** 直接推一行（宿主带内输出——命令结果/提示语的流区呈现）。 */
	pushLine(s: string): void {
		for (const l of s.replace(/\n$/, "").split("\n")) this.lines.push(l);
	}

	/** 当前完整行源（定格行 + 活动块渲染）。 */
	frameLines(width: number): string[] {
		const out = [...this.lines];
		if (this.thinkText !== "") out.push(...this.thinkBlock(this.thinkText, width));
		if (this.mdText !== "") out.push(...this.mdRender(this.mdText, width));
		return out;
	}
}
