/** 全屏文档模型（TUI 批阶段三 F3——chunk/event → 块 → 行数组的投影器）。
 *  与 F2 streamview 同族（EventProjector + mdpipe 渲染），差异在消费面：streamview 自带
 *  DiffScreen 帧输出；本件只产出行数组（frameLines），渲染归 FullApp/FullScreen。
 *
 *  F5 十一轮：定格项以「原始内容条目」存储（raw/md/user/think），frameLines 按调用方给的
 *  当前宽度即时渲染（md 块带宽度缓存防每帧重排）——侧栏开关改变流区宽后，历史内容
 *  下一帧即按新宽回流（旧实现渲染结果入库，宽度变化后折行定格不回流）。 */

import { createStreamingMarkdown, renderMarkdown, type StreamingMarkdown } from "../mdpipe.ts";
import * as theme from "../theme.ts";
import { visibleWidth, wrapText } from "./width.ts";
import { TOOL_MERGE, toolCallLine } from "../render.ts";
import type { StreamChunk } from "./streamview.ts";

type Entry =
	| { k: "raw"; s: string } // 工具/事件/横幅/提示行——超宽时 wrapText 兜底
	| { k: "md"; src: string; cache?: { w: number; lines: string[] } } // markdown 源——按宽度渲染（缓存）
	| { k: "user"; src: string } // 用户消息块（❯ 暖金）
	| { k: "think"; src: string }; // 思考块（Alt+E 折叠态随 frameLines 当下渲染）

export class DocModel {
	/** 思考块折叠态（Alt+E 全局切换——默认收起最多 2 视觉行，走查 v1.8 口径）。 */
	thinkOpen = false;
	private lines: Entry[] = [];
	private mdText = "";
	private thinkText = "";
	private inThink = false;
	private mdStream: StreamingMarkdown | undefined;
	private streamWidth = -1;

	private thinkBlock(text: string, w: number): string[] {
		const raw = wrapText(text, Math.max(8, w - 2));
		if (!this.thinkOpen) {
			// 收起 = 尾部 2 视觉行 + 展开提示（F5 三轮①：流式观看语义 = 永远最新内容）
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

	/** 活动块固化（write/end 前）：think → marker 先入列（时序恒先于正文——F5 三轮①）；
	 *  md → 源文本入列（渲染归 frameLines，宽度变化可回流）。 */
	private settleActive(): void {
		if (this.thinkText !== "") {
			this.lines.push({ k: "think", src: this.thinkText });
			this.thinkText = "";
			this.inThink = false;
		}
		if (this.mdText !== "") {
			this.lines.push({ k: "md", src: this.mdText });
			this.mdText = "";
			this.mdStream = undefined;
		}
	}

	activity(c: StreamChunk, _width: number): void {
		if (c.kind === "reasoning") {
			if (!this.inThink && this.mdText !== "") {
				this.lines.push({ k: "md", src: this.mdText });
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

	/** 工具/事件行：活动块先固化再追加（交错序正确——streamview 同语义）。
	 *  结果哨兵行（GS 前缀，F5 五轮①）原位合并进最近一条 ● 工具行：Using→Used + 行数 chip。 */
	write(s: string, _width: number): void {
		this.settleActive();
		for (const l of s.replace(/\n$/, "").split("\n")) {
			if (l.startsWith(TOOL_MERGE)) {
				const chip = l.slice(TOOL_MERGE.length);
				for (let i = this.lines.length - 1; i >= 0; i--) {
					const prev = this.lines[i]!;
					if (prev.k === "raw" && prev.s.startsWith("● Using ")) {
						this.lines[i] = { k: "raw", s: `● Used ${prev.s.slice(8)} · ${chip}` };
						break;
					}
					if (prev.k === "raw" && prev.s.trim() !== "") break; // 工具行不紧邻（理论不至）——不合并
				}
				continue;
			}
			this.lines.push({ k: "raw", s: l });
		}
	}

	/** turn 结束定格。 */
	end(_width: number): void {
		this.settleActive();
	}

	/** 临时活动块擦除（/compact 指示行——内容不固化）。 */
	discard(): void {
		this.mdText = "";
		this.thinkText = "";
		this.inThink = false;
		this.mdStream = undefined;
	}

	/** 历史结构化摄入（F5 五轮②③④）：与实时流同形（暖金提问/md 渲染/think marker/工具 Used 行）。 */
	historyFrom(events: { type: string; [k: string]: unknown }[], width: number): void {
		for (const e of events) {
			if (e.type === "user/message") {
				const parts = (e.content ?? []) as { kind?: string; text?: string }[];
				const text = parts.filter((p) => p.kind === "text").map((p) => p.text ?? "").join("");
				const imgs = parts.filter((p) => p.kind === "image").length;
				if (text !== "" || imgs > 0) this.userPrompt(text + (imgs > 0 ? `  [图片${imgs > 1 ? `×${imgs}` : ""}]` : ""));
			} else if (e.type === "assistant/message") {
				const parts = (e.content ?? []) as { kind?: string; text?: string }[];
				const think = parts.filter((p) => p.kind === "reasoning").map((p) => p.text ?? "").join("");
				if (think !== "") {
					this.settleActive();
					this.lines.push({ k: "think", src: think });
				}
				const text = parts.filter((p) => p.kind === "text").map((p) => p.text ?? "").join("");
				if (text !== "") {
					this.settleActive();
					this.lines.push({ k: "md", src: text });
				}
			} else if (e.type === "tool/call") {
				this.settleActive();
				this.lines.push({ k: "raw", s: toolCallLine(String(e.name), e.args as Record<string, unknown> | undefined, process.cwd()) });
			} else if (e.type === "tool/result") {
				this.settleActive();
				const n = String(e.output ?? "").split("\n").filter((l) => l.trim() !== "").length;
				this.write(TOOL_MERGE + (e.isError === true ? "失败" : `${n} 行`), width);
			} else if (e.type === "turn/compaction") {
				this.settleActive();
				this.lines.push({ k: "raw", s: `  [已压缩：前缀 ${Number(e.droppedCount ?? 0)} 条 → 摘要（/summary 查看）]` });
			}
		}
		this.settleActive();
	}

	/** 用户消息块（❯ 青玉 + 暖金加粗正文 + 前后各空一行）。 */
	userPrompt(text: string): void {
		this.lines.push({ k: "user", src: text });
	}

	/** markdown 渲染推入（F5 六轮②）：命令结果通道——/compact /summary 等输出含 md。 */
	pushMd(text: string, _width: number): void {
		this.settleActive();
		this.lines.push({ k: "md", src: text });
	}

	/** 直接推一行（宿主带内输出——横幅/提示语的流区呈现；超宽由 frameLines 折行兜底）。 */
	pushLine(s: string): void {
		for (const l of s.replace(/\n$/, "").split("\n")) this.lines.push({ k: "raw", s: l });
	}

	/** 工具行配色（F5 六轮① 用户拍板；2026-09-22 再拍板：动词 Using/Used 白色）：
	 *  ● 与工具名青玉、动词白、参数/行数灰。 */
	private styleToolLine(l: string): string {
		const m = /^(●) (Using |Used )([^ ]+)(.*)$/.exec(l);
		if (m === null) return l;
		return theme.fg("accent", m[1]!) + theme.fg("fg", " " + m[2]!) + theme.fg("accent", m[3]!) + theme.dim(m[4]!);
	}

	/** 当前完整行源（定格条目 + 活动块）——按调用方当前宽度渲染：宽度变化即回流（F5 十一轮）。 */
	frameLines(width: number): string[] {
		const out: string[] = [];
		for (const e of this.lines) {
			if (e.k === "think") {
				out.push(...this.thinkBlock(e.src, width));
			} else if (e.k === "user") {
				out.push("");
				for (const l of e.src.split("\n")) out.push(`${theme.fg("accent", "❯")} ${theme.bold(theme.fg("warn", l))}`);
				out.push("");
			} else if (e.k === "md") {
				if (e.cache?.w !== width) e.cache = { w: width, lines: renderMarkdown(e.src, width) };
				out.push(...e.cache.lines);
			} else {
				const shown = e.s.startsWith("● ") ? this.styleToolLine(e.s) : e.s; // 工具行渲染期上色（存储留纯文本供合并）
				if (visibleWidth(shown) > width) out.push(...wrapText(shown, width));
				else out.push(shown);
			}
		}
		if (this.thinkText !== "") out.push(...this.thinkBlock(this.thinkText, width));
		if (this.mdText !== "") out.push(...this.mdRender(this.mdText, width));
		return out;
	}
}
