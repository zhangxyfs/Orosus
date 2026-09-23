/** 全屏文档模型（TUI 批阶段三 F3——chunk/event → 块 → 行数组的投影器）。
 *  与 F2 streamview 同族（EventProjector + mdpipe 渲染），差异在消费面：streamview 自带
 *  DiffScreen 帧输出；本件只产出行数组（frameLines），渲染归 FullApp/FullScreen。
 *
 *  F5 十一轮：定格项以「原始内容条目」存储（raw/md/user/think/tool），frameLines 按调用方给的
 *  当前宽度即时渲染（md 块带宽度缓存防每帧重排）——侧栏开关改变流区宽后，历史内容
 *  下一帧即按新宽回流（旧实现渲染结果入库，宽度变化后折行定格不回流）。
 *  2026-09-23 走查批：tool 条目结构化（args/结果留存）——Edit/Write diff 与失败体 Alt+O 折叠渲染；
 *  用户消息块按流区宽折行（此前直推不折行）。 */

import { createStreamingMarkdown, renderMarkdown, type StreamingMarkdown } from "../mdpipe.ts";
import * as theme from "../theme.ts";
import { visibleWidth, wrapText } from "./width.ts";
import { TOOL_MERGE, toolCallLine } from "../render.ts";
import { toolDiffRows, toolChangeStats, writeContentFor, langForPath, errorLines, type DiffRow } from "./toolview.ts";
import { highlightLines } from "../md/highlight.ts";
import type { StreamChunk } from "./streamview.ts";

type ToolResult = { isError: boolean; output?: string | undefined; lines: number }; // output 仅失败留存（成功体可巨大）

type Entry =
	| { k: "raw"; s: string } // 工具/事件/横幅/提示行——超宽时 wrapText 兜底
	| { k: "md"; src: string; cache?: { w: number; lines: string[] } } // markdown 源——按宽度渲染（缓存）
	| { k: "user"; src: string } // 用户消息块（❯ 暖金）
	| { k: "think"; src: string } // 思考块（Alt+E 折叠态随 frameLines 当下渲染）
	| { k: "tool"; name: string; args: Record<string, unknown> | undefined; result?: ToolResult; detail?: DiffRow[] | undefined; hl?: string[] }; // 工具条目（2026-09-23 走查批：Edit/Write diff + 失败体，Alt+O 折叠态当下渲染；hl = Write 高亮缓存——帧心跳不重算）

export class DocModel {
	/** 思考块折叠态（Alt+E 全局切换——默认收起最多 2 视觉行，走查 v1.8 口径）。 */
	thinkOpen = false;
	/** 工具明细折叠态（Alt+O 全局切换——diff 默认收起，与 thinkOpen 同族不持久化）。 */
	toolOpen = false;
	/** 工具失败体折叠态（Alt+F 全局切换——二轮走查拍板：错误默认全收起、头行带提示，与 diff 分键）。 */
	errOpen = false;
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

	/** 工具调用结构化摄入（2026-09-23 走查批——args 留存供 diff 渲染；renderEvent 的一行文本形态
	 *  只服务行模式，全屏走本口）。 */
	toolCall(name: string, args: Record<string, unknown> | undefined): void {
		this.settleActive();
		this.lines.push({ k: "tool", name, args });
	}

	/** 工具结果原位合并：挂到最近一条未完结的工具条目（write() 的 TOOL_MERGE 哨兵同语义的结构化版）。 */
	toolResult(output: unknown, isError: unknown): void {
		this.settleActive();
		const text = typeof output === "string" ? output : String(output ?? "");
		let n = 0;
		for (const l of text.split("\n")) if (l.trim() !== "") n++;
		for (let i = this.lines.length - 1; i >= 0; i--) {
			const prev = this.lines[i]!;
			if (prev.k === "tool" && prev.result === undefined) {
				prev.result = { isError: isError === true, output: isError === true ? text : undefined, lines: n };
				return;
			}
			if (prev.k !== "tool") break; // 工具行不紧邻（理论不至）——不合并
		}
	}

	/** 工具条目渲染（2026-09-23 二轮走查拍板形态）：头行（Using/Used · chip，沿用 styleToolLine 配色）+ 明细体。
	 *  明细体：失败 = 解析后错误行（err 色，**默认全收起**，头行带「Alt + F 查看」提示，Alt+F 展开）；
	 *  成功且 edit/write = diff 行（行号栏暗色 + 删 err 文字 / 增 accent 文字——不铺底色；公共缩进已剥；
	 *  超宽折行续行对齐正文列）。收起态 diff 留 5 行 + 更多行提示（Alt+O 展开）。
	 *  chip：edit/write 按内容算（edit +A -D、write N 行——结果文案「已写入…」就一行，「· 1 行」误导前案）。 */
	private toolLines(e: Entry & { k: "tool" }, width: number): string[] {
		let chip = "";
		if (e.result !== undefined) {
			if (e.result.isError) chip = ` · 失败${this.errOpen ? "" : " · Alt + F 查看"}`;
			else {
				const stats = toolChangeStats(e.name, e.args);
				chip = stats === undefined ? ` · ${e.result.lines} 行` : stats.dels > 0 ? ` · +${stats.adds} -${stats.dels}` : ` · ${stats.adds} 行`;
			}
		}
		const head = toolCallLine(e.name, e.args, process.cwd()).replace("● Using ", e.result === undefined ? "● Using " : "● Used ") + chip;
		const out = [this.styleToolLine(head, e.result?.isError === true)];
		if (e.result?.isError === true) {
			if (!this.errOpen) return out;
			const body = errorLines(e.result.output).slice(0, 60);
			for (const l of body) for (const wl of wrapText(l, Math.max(8, width - 2))) out.push("  " + theme.fg("err", wl));
			if (errorLines(e.result.output).length > 60) out.push(theme.dim("  … 其余从略（完整内容在会话文件）"));
			return out;
		}
		// Write = 内容预览（kimi 形态：dim 行号 + 语法高亮正文，无 +/- 记号——高亮一次入缓存，
		// 折行按帧宽即时；wrapText 是 ANSI 感知折行，高亮序列跨行续色）
		const wc = writeContentFor(e.name, e.args);
		if (wc !== undefined) {
			if (e.hl === undefined) e.hl = highlightLines(wc.content.replace(/\n+$/, ""), langForPath(wc.path));
			const CAP = 10;
			const shown = this.toolOpen ? e.hl.slice(0, 200) : e.hl.slice(0, CAP);
			for (const [i, l] of shown.entries()) {
				const gutter = theme.dim(String(i + 1).padStart(4) + "  ");
				for (const [j, wl] of wrapText(l, Math.max(8, width - 8)).entries())
					out.push(`  ${j === 0 ? gutter : "      "}${wl}`);
			}
			const hidden = e.hl.length - shown.length;
			if (hidden > 0)
				out.push(theme.dim(this.toolOpen ? "  … 其余从略（完整内容在会话文件）" : `  … 还有 ${hidden} 行 · Alt + O 展开全部`));
			return out;
		}
		if (e.detail === undefined) e.detail = toolDiffRows(e.name, e.args);
		const rows = e.detail;
		if (rows === undefined || rows.length === 0) return out;
		const CAP = 10; // 收起帽（kimi/cc-haha/pi-write 三家同口径）
		const shown = this.toolOpen ? rows.slice(0, 200) : rows.slice(0, CAP);
		for (const r of shown) out.push(...this.diffRowLines(r, width));
		const hidden = rows.length - shown.length;
		if (hidden > 0)
			out.push(theme.dim(this.toolOpen ? `  … 其余 ${hidden} 行从略（完整内容在会话文件）` : `  … 还有 ${hidden} 行 · Alt + O 展开全部`));
		return out;
	}

	/** diff 行 → 物理行（kimi/pi 同族形态：暗色行号栏右对齐 3 列 + 着色 ± 记号 + 正文；
	 *  不铺底色；超宽折行，续行空行号栏对齐正文列）。 */
	private diffRowLines(r: DiffRow, width: number): string[] {
		if (r.tag === "gap") return [theme.dim(`       ${r.text}`)];
		const gutter = theme.dim(String(r.no).padStart(4)); // kimi 同口径 4 位右对齐
		const color = r.tag === "del" ? "diffDel" : r.tag === "add" ? "diffAdd" : "muted"; // 删/增专属红绿（theme diffDel/diffAdd——赭石 err 降级偏橙前案）
		const sign = r.tag === "del" ? "-" : r.tag === "add" ? "+" : " ";
		const contentW = Math.max(8, width - 9); // 「  」2 + 行号 4 + 「 」1 + 记号 1 + 「 」1
		const wrapped = wrapText(r.text, contentW);
		return wrapped.map(
			(wl, i) => `  ${i === 0 ? gutter : "    "} ${theme.fg(color, `${i === 0 ? sign : " "} ${wl}`)}`,
		);
	}

	/** 临时活动块擦除（/compact 指示行——内容不固化）。 */
	discard(): void {
		this.mdText = "";
		this.thinkText = "";
		this.inThink = false;
		this.mdStream = undefined;
	}

	/** 历史结构化摄入（F5 五轮②③④）：与实时流同形（暖金提问/md 渲染/think marker/工具 Used 行）。 */
	historyFrom(events: { type: string; [k: string]: unknown }[], _width: number): void {
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
				this.toolCall(String(e.name), e.args as Record<string, unknown> | undefined);
			} else if (e.type === "tool/result") {
				this.toolResult(e.output, e.isError);
			} else if (e.type === "agent/steering-message") {
				// steer 注入的消息回显（2026-09 队列批——投影 = user 消息，回显同形暖金提问块）
				const msgs = (e.messages ?? []) as { text?: string }[];
				for (const m of msgs) if (typeof m.text === "string" && m.text !== "") this.userPrompt(m.text);
			} else if (e.type === "turn/compaction") {
				this.settleActive();
				this.lines.push({ k: "raw", s: `  [已压缩：${Number(e.droppedCount ?? 0)} 条历史 → 摘要（/summary 查看）]` });
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
	 *  ● 与工具名青玉、动词白、参数/行数灰；failed = ● 与 chip 转 err 红（kimi ✗ 形态——
	 *  失败卡在流区一眼可辨）。 */
	private styleToolLine(l: string, failed = false): string {
		const m = /^(●) (Using |Used )([^ ]+)(.*)$/.exec(l);
		if (m === null) return l;
		if (failed) return theme.fg("err", m[1]!) + theme.fg("fg", " " + m[2]!) + theme.fg("accent", m[3]!) + theme.fg("err", m[4]!);
		return theme.fg("accent", m[1]!) + theme.fg("fg", " " + m[2]!) + theme.fg("accent", m[3]!) + theme.dim(m[4]!);
	}

	/** 当前完整行源（定格条目 + 活动块）——按调用方当前宽度渲染：宽度变化即回流（F5 十一轮）。 */
	frameLines(width: number): string[] {
		const out: string[] = [];
		for (const e of this.lines) {
			if (e.k === "think") {
				out.push(...this.thinkBlock(e.src, width));
			} else if (e.k === "user") {
				// 用户消息折行（2026-09-23 走查批①：此前逐逻辑行直推不折行，长提问被终端硬截）
				out.push("");
				const uw = Math.max(8, width - 2); // 「❯ 」前缀 2 列计入折行宽
				for (const l of e.src.split("\n")) {
					for (const [i, wl] of wrapText(l, uw).entries())
						out.push(i === 0 ? `${theme.fg("accent", "❯")} ${theme.bold(theme.fg("warn", wl))}` : `  ${theme.bold(theme.fg("warn", wl))}`);
				}
				out.push("");
			} else if (e.k === "tool") {
				out.push(...this.toolLines(e, width));
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
