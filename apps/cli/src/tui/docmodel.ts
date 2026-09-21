/** 全屏文档模型（TUI 批阶段三 F3——chunk/event → 块 → 行数组的投影器）。
 *  与 F2 streamview 同族（EventProjector + mdpipe 渲染），差异在消费面：streamview 自带
 *  DiffScreen 帧输出；本件只产出行数组（frameLines），渲染归 FullApp/FullScreen——
 *  全屏模式每帧整屏重排，行源必须可读而不是已写出。 */

import { createStreamingMarkdown, renderMarkdown, type StreamingMarkdown } from "../mdpipe.ts";
import * as theme from "../theme.ts";
import { visibleWidth, wrapText } from "./width.ts";
import type { StreamChunk } from "./streamview.ts";

export class DocModel {
	/** 思考块折叠态（Alt+E 全局切换——默认收起最多 2 视觉行，走查 v1.8 口径）。 */
	thinkOpen = false;
	// 定格行（工具/事件行 + 已固化块）。think 以 marker 存储——Alt+E 随时切换折叠态时
	// frameLines 重渲染（F5 三轮①：定稿后渲染成静态行会让 Alt+E 失效）
	private lines: (string | { think: string })[] = [];
	private mdText = "";
	private thinkText = "";
	private inThink = false;
	private mdStream: StreamingMarkdown | undefined;
	private streamWidth = -1;

	private thinkBlock(text: string, w: number): string[] {
		const raw = wrapText(text, Math.max(8, w - 2));
		if (!this.thinkOpen) {
			// 收起 = 尾部 2 视觉行 + 展开提示（F5 三轮①：流式观看语义 = 永远最新内容，slice(0,2) 是最旧的）
			const head = theme.dim("[思考] · Alt + E 展开");
			return [head, ...raw.slice(-2).map((l) => theme.dim("  " + l))];
		}
		return raw.map((l, i) => theme.dim((i === 0 ? "[思考] " : "  ") + l));
	}

	private mdRender(text: string, w: number): string[] {
		if (this.streamWidth !== w || this.mdStream === undefined) {
			this.streamWidth = w;
			this.mdStream = createStreamingMarkdown(w);
		}
		return this.mdStream.render(text);
	}

	/** 活动块固化（write/end 前）：think → dim 块先进定格行，md → 终稿渲染随后——
	 *  时序上思考恒先于正文（F5 二轮用户实测：原先 md 先沉底，思考被压到答案后面）。 */
	private settleActive(width: number): void {
		if (this.thinkText !== "") {
			this.lines.push({ think: this.thinkText }); // marker——折叠态由 frameLines 按当下渲染
			this.thinkText = "";
			this.inThink = false;
		}
		if (this.mdText !== "") {
			this.lines.push(...renderMarkdown(this.mdText, width));
			this.mdText = "";
			this.mdStream = undefined;
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

	/** 用户消息块（❯ 青玉 + 暖金加粗正文〔F5 二轮拍板：提问文字黄色〕+ 前后各空一行）。 */
	userPrompt(text: string): void {
		this.lines.push("");
		for (const l of text.split("\n")) this.lines.push(`${theme.fg("accent", "❯")} ${theme.bold(theme.fg("warn", l))}`);
		this.lines.push("");
	}

	/** 直接推一行（宿主带内输出——命令结果/提示语的流区呈现）。 */
	pushLine(s: string): void {
		for (const l of s.replace(/\n$/, "").split("\n")) this.lines.push(l);
	}

	/** 当前完整行源（定格行 + 活动块渲染）。宽度 = 流区宽（F5 三轮②③：此前按整屏宽折行，
	 *  流区只有左栏——每行尾部被截掉 = 「好多文字没显示」；pushLine 原始行也在此统一折行）。 */
	frameLines(width: number): string[] {
		const out: string[] = [];
		for (const l of this.lines) {
			if (typeof l === "string") {
				if (visibleWidth(l) > width) out.push(...wrapText(l, width));
				else out.push(l);
			} else {
				out.push(...this.thinkBlock(l.think, width));
			}
		}
		if (this.thinkText !== "") out.push(...this.thinkBlock(this.thinkText, width));
		if (this.mdText !== "") out.push(...this.mdRender(this.mdText, width));
		return out;
	}
}
