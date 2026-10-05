/** 全屏文档模型（TUI 批阶段三 F3——chunk/event → 块 → 行数组的投影器）。
 *  与 F2 streamview 同族（EventProjector + mdpipe 渲染），差异在消费面：streamview 自带
 *  DiffScreen 帧输出；本件只产出行数组（frameLines），渲染归 FullApp/FullScreen。
 *
 *  F5 十一轮：定格项以「原始内容条目」存储（raw/md/user/think/tool），frameLines 按调用方给的
 *  当前宽度即时渲染（md 块带宽度缓存防每帧重排）——侧栏开关改变流区宽后，历史内容
 *  下一帧即按新宽回流（旧实现渲染结果入库，宽度变化后折行定格不回流）。
 *  2026-09-23 走查批：tool 条目结构化（args/结果留存）——Edit/Write diff 与失败体 Alt+O 折叠渲染；
 *  用户消息块按流区宽折行（此前直推不折行）。
 *  2026-09-28 卡顿批 A：定格条目全部宽度级缓存（此前仅 md）——frameLines 单帧成本从 O(会话文本)
 *  降为拼引用；kimi「字符串引用没变复用上帧结果」的条目级等价物（见 LineCache 注释）。 */

import { statSync } from "node:fs";
import { createStreamingMarkdown, renderMarkdown, type StreamingMarkdown } from "../mdpipe.ts";
import { stripDangerEsc } from "../ansi-guard.ts";
import { agentGroupLines } from "../subagent-status.ts";
import { spawnIdsIn } from "../tasks-cmd.ts";
import { injectionFoldLabel } from "../render.ts";
import type { SubagentRosterEntry } from "@orosus/contracts/module";
import * as theme from "../theme.ts";
import { visibleWidth, wrapText } from "./width.ts";
import { LiveWrap } from "./live-wrap.ts";
import { TOOL_MERGE, toolCallLine, toolDisplayName } from "../render.ts";
import { toolDiffRows, toolChangeStats, writeContentFor, langForPath, errorLines, type DiffRow } from "./toolview.ts";

/** 只读探索类工具最小集（2026-09-30 用户拍板：连续同名聚合只对纯查询开——写/执行/网络永不并组，
 *  kimi/cc-haha/codex/qwen 四家共识）；v1 只并同名紧邻（read+grep 相邻各自成行，kimi 同款）。 */
const COLLAPSIBLE_TOOLS = new Set(["tool-fs__read", "tool-fs__grep", "tool-fs__glob"]);
import { highlightLines } from "../md/highlight.ts";
import type { StreamChunk } from "./streamview.ts";

type ToolResult = { isError: boolean; output?: string | undefined; lines: number; /** 图片附件（m5-media F4）：路径引用——头行 chip「附 N 图」+ Alt+O 展开逐图行（不渲染像素）。 */ images?: { path: string; mime: string; bytes: number }[] }; // output 仅失败留存（成功体可巨大）

/** 定格条目渲染缓存（bash 卡顿批 A，2026-09-28）：frameLines 每帧跑、单帧成本曾 = O(会话文本)
 *  （think 收起态照付全文 wrapText），busy 心跳 10Hz 全帧叠上 bash 子进程抢 CPU 即用户可感的卡顿。
 *  键 = 宽度 + 折叠态 + result 在场——命中即拼引用不重排；宽度变化（Ctrl+T/resize）/开关切换/
 *  result 挂上/条目替换（write 的 TOOL_MERGE 换新对象，不带旧缓存）天然击穿。主题切换不击穿
 *  （历史行旧色不重刷 = m5 T12 已披露口径，缓存后行为反而一致）。活动块（流式中的 think/md）不缓存。 */
type LineCache = { w: number; lines: string[] };

type Entry =
	| { k: "raw"; s: string; cache?: LineCache } // 工具/事件/横幅/提示行——超宽时 wrapText 兜底（宽度级缓存）
	| { k: "md"; src: string; cache?: LineCache } // markdown 源——按宽度渲染（缓存）
	| { k: "user"; src: string; cache?: LineCache } // 用户消息块（❯ 暖金）——宽度级缓存
	| { k: "think"; src: string; cache?: { w: number; open: boolean; lines: string[] } } // 思考块——键含 thinkOpen（收起态旧口径每帧付全文 wrapText）
	| { k: "tool"; name: string; args: Record<string, unknown> | undefined; callId?: string; result?: ToolResult; detail?: DiffRow[] | undefined; hl?: string[]; errLines?: string[]; cache?: { w: number; open: boolean; err: boolean; done: boolean; lines: string[] }; group?: { name: string; items: { args: Record<string, unknown> | undefined; callId?: string; result?: ToolResult }[] } } // 工具条目（2026-09-23 走查批：Edit/Write diff + 失败体，Alt+O 折叠态当下渲染；hl = Write 高亮缓存、errLines = 失败体错误行缓存——帧心跳不重算〔CTW-09〕；callId = 结果精确配对键〔2026-09-25 错配修复——并发乱序不再交叉挂错〕；cache 键含 toolOpen/errOpen/result 在场——整行缓存；group = 连续同名只读工具聚合〔2026-09-30 用户拍板抄 cc-haha 计数行〕：第 2 个紧邻同名调用并进宿主条目就地成组〔kimi in-place 同款〕，条目下标与账本不动、callId 配对下钻 items——宿主自身 args/callId/result 自成组起停用）
	| { k: "group"; ids: string[] } // 子代理 agent 组（2026-09-27 用户拍板格式）：spawn 工具行合并体——每帧从 roster 现算不缓存（活体行：状态/时长随心跳自更；kimi agent-group 定式：连续 spawn 并一组、非 spawn 断组）
	| { k: "skill"; name: string } // 技能手动加载行（2026-09-28 用户拍板：正文不打印进对话流）——单行紧凑标记，kimi「Activated skill」/pi「[skill] name」同款；全文只进模型上下文（单行静态拼接，无缓存必要）
	| { k: "vision"; model: string; state: "running" | "done" | "failed" | "aborted"; text?: string; since?: number; cache?: { w: number; open: boolean; lines: string[] } } // 视觉转述行（m5-media 走查四 2026-10-02 拍板）：◐ 转述中 → ● 结果两态原位翻转（下标稳定——frameWindow 账本要求）；done 正文**默认折叠 Alt+E 展开**（全量转述可达 1200 字——2026-10-02 拍板，与主思考共键 thinkOpen）；aborted 恒 live-only（未发送不落日志）。since = 开始时刻——running 态活体行（1s 心跳重绘现算已耗时，group 行同先例；流式增量另走转述活动块 activeTail）
	| { k: "fold"; turns: number } // 滑窗折叠行（m5-render-perf T7——D12）：被裁轮次的原地单行提示（dim 色），每次裁剪重建（先移除旧 fold 再插头部）
	| { k: "fold-step"; hidden: Entry[] }; // 轮内步级折叠行（m5-resume-perf T9——D9/kimi KEEP_RECENT_STEPS=30 同款）：本轮前序步骤条目合并体（hidden 持原条目，Alt+S 展开时 splice 回原位——下标稳定账本 splice 重算）

export class DocModel {
	/** 思考块折叠态（Alt+E 全局切换——默认收起最多 2 视觉行，走查 v1.8 口径）。 */
	thinkOpen = false;
	/** 工具明细折叠态（Alt+O 全局切换——diff 默认收起，与 thinkOpen 同族不持久化）。 */
	toolOpen = false;
	/** 工具失败体折叠态（Alt+F 全局切换——二轮走查拍板：错误默认全收起、头行带提示，与 diff 分键）。 */
	errOpen = false;
	/** 轮内步级折叠态（m5-resume-perf T9——Alt+S 全局切换，与 thinkOpen/toolOpen/errOpen 同族不持久化；
	 *  D9 拍板独立键不挂 Alt+O——「内容详略」与「步骤多少」正交维度分键管）。 */
	stepsOpen = false;
	/** 轮内保留步数（D9：kimi TRANSCRIPT_KEEP_RECENT_STEPS=30 同值；env OROSUS_TUI_KEEP_STEPS 覆盖、
	 *  0 = 不折常开——OROSUS_TUI_MAX_TURNS 同款读法）。 */
	private get stepsKeep(): number {
		const keep = Number(process.env.OROSUS_TUI_KEEP_STEPS ?? 30);
		return Number.isFinite(keep) && keep > 0 ? keep : 0;
	}
	/** 步骤条目判据：tool 条目 + 「●」头工具 raw 行（聚合组/工具结果哨兵行都以此头标记——非步骤
	 *  raw（横幅/提示/注入折叠行）不以 ● 开头，天然分离）。 */
	private isStepEntry(e: Entry): boolean {
		return e.k === "tool" || (e.k === "raw" && e.s.startsWith("●"));
	}
	/** 花名册现读口（agent 组条目每帧取数——main.ts 注入 h.subagents()；无 = 组条目退化空）。 */
	agentProvider: (() => readonly SubagentRosterEntry[]) | undefined = undefined;
	/** 静默调用集（2026-09-27 拍板：tasks 纯查询行收进 agent 组）：tasks 的 call/result 整对吞掉——
	 *  记 callId 供 result 侧精确丢弃；旧日志无 callId 用位置感知旗标兜（仅吞摄入流中紧随静默 call
	 *  的结果——防孤儿结果错挂到别的工具行，乱序日志不吞错〔CTW-10〕）。 */
	private ghostCalls = new Set<string>();
	// CTW-10（2026-09-28）：记静默 call 时刻的条目序（lines.length），结果到达时序不变才吞。
	// 旧一次性布尔旗标不校验归属：乱序旧日志（tasks call → bash call → bash result → tasks result）
	// 把 bash 的结果吞掉、tasks 的孤儿结果再错挂到 bash 行——吞错 + 错挂双重错位
	private ghostNoIdAt: number | undefined;
	/** 回放期 spawn 配对（重载后 agent 组重建）：callId → 组条目引用——result 到场时把编号抠进组。
	 *  回放专用状态（实时路走 claimAgents 末组认领，不用精确配对）。 */
	private pendingSpawnResults = new Map<string, { k: "group"; ids: string[] }>();
	/** 回放期当前 spawn 组（m5-agentview-perf T1 可重入化）：跨 historyFrom 调用存活，user/assistant
	 *  消息边界清空——分批喂入与一次喂全量同形的地基（增量渲染器按批喂事件；局部变量形态下跨批
	 *  紧邻的 spawn 会错误另开新组，与全量回放不同形）。 */
	private replayGroup: { k: "group"; ids: string[] } | undefined;

	/** 子代理 agent 组摄入（2026-09-27 用户拍板）：spawn 工具调用的替代显示——绝不走「Using Spawn」通用行。
	 *  连续 spawn 合成一组（末组还有活动条目就复用；全终态后下一次 spawn 开新组）。 */
	agentGroupCall(): void {
		this.settleActive();
		const last = [...this.lines].reverse().find((e) => e.k === "group");
		if (last !== undefined && last.k === "group") {
			const roster = this.agentProvider?.() ?? [];
			const alive = last.ids.some((id) => {
				const e = roster.find((r) => r.id === id);
				return e !== undefined && (e.status === "queued" || e.status === "running");
			});
			if (alive) return; // 末组还活着——并入它
		}
		this.pushE({ k: "group", ids: [] });
	}

	/** 全部 agent 组引用的编号集合（宿主 provider 据此补挂盘上历史条目——回放组的渲染取数口）。 */
	groupIds(): Set<string> {
		const s = new Set<string>();
		for (const e of this.lines) if (e.k === "group") for (const id of e.ids) s.add(id);
		return s;
	}

	/** 末组认领新条目（渲染期现算——老组只渲染既有 ids，新面孔归末组；kimi「同 step 断组」的等价实现）。 */
	private claimAgents(): void {
		if (this.agentProvider === undefined) return;
		const groups = this.lines.filter((e): e is Entry & { k: "group" } => e.k === "group");
		if (groups.length === 0) return;
		const claimed = new Set(groups.flatMap((g) => g.ids));
		const last = groups[groups.length - 1]!;
		for (const e of this.agentProvider()) {
			if (claimed.has(e.id)) continue;
			last.ids.push(e.id);
			claimed.add(e.id);
		}
	}
	private lines: Entry[] = [];
	private mdText = "";
	private thinkText = "";
	private inThink = false;
	private mdStream: StreamingMarkdown | undefined;
	private streamWidth = -1;
	/** 活动思考块增量折行缓存（m5-render-perf T1）——每帧只折最后一条未完行，
	 *  替代旧路径每帧对全文 wrapText（docmodel.ts 热点 (a)）；settleActive/discard 重置。 */
	private thinkLive = new LiveWrap();
	/** 转述活动块（A 案）：眼睛模型的思考/正文流式增量——visionDelta 喂入、activeTail 渲染、
	 *  visionTranscribeEnd 清空（思考弃置、正文定格进 ● 行）。 */
	private visionThinkText = "";
	private visionBodyText = "";
	private visionLive = new LiveWrap();

	// ---------- kimi 式轮次滑窗（m5-render-perf T7——D11/D12/D13） ----------
	/** 滑窗开关：主窗实例显式启用（main.ts）；renderAgentView 等一次性渲染实例不启用不裁剪
	 *  （查看窗自有 500 条帽，不叠第二轮窗——doc-review 定案：滑窗不得做成 historyFrom 无条件副作用）。 */
	turnWindowEnabled = false;
	/** 视口探针（阅读保护——D11）：宿主注入当前视口行区间（fullapp.layoutFrame 投影）；
	 *  被裁段与视口相交 → 本轮整批顺延（不做部分裁剪——中段移除破坏底部锚定几何：
	 *  fullapp end = total − scrollBack 只在恒头部移除下视口纹丝不动、scrollBack 无需修正）。 */
	viewportProbe: (() => { start: number; end: number } | undefined) | undefined = undefined;
	private turnOf: number[] = []; // 与 lines 平行：每条目轮号（turn/end 边界——一轮 = 两条用户消息之间的全部条目）
	private curTurn = 0;
	private foldedTurns = 0; // 累计已裁轮数（fold 行文案 N）
	private lastEvictAt = 0; // 远区淘汰 1Hz 节流（设计空白 #8 两可——落地取节流档，随 T8 回写登记）
	private headTrimmedNet = 0; // 头部净平移累计（走查⑦：裁剪 cut 行 − fold 回插 1 行 = cut−1）——fullapp 滚动补偿区分「行号平移」与「尾部增缩」

	/** 条目统一入列（T7）：lines/turnOf 同步 push（轮号 = curTurn）；counts 由 reconcile 补尾覆盖。 */
	private pushE(e: Entry): void {
		this.lines.push(e);
		this.turnOf.push(this.curTurn);
	}

	private thinkBlock(text: string, w: number): string[] {
		return this.styleWrappedThink(wrapText(text, Math.max(8, w - 2)), this.thinkOpen);
	}

	/** 思考块样式（m5-render-perf T1 提取——LiveWrap 裸行与 thinkBlock 全量行共用同一上色段：
	 *  先折行后上色与现状同序，D4——收起/展开两态吃同一份裸行缓存）。 */
	private styleWrappedThink(raw: string[], open: boolean): string[] {
		if (!open) {
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
			this.pushE({ k: "think", src: this.thinkText });
			this.thinkText = "";
			this.inThink = false;
			this.thinkLive = new LiveWrap(); // 下一块思考从头缓存
		}
		if (this.mdText !== "") {
			this.pushE({ k: "md", src: this.mdText });
			this.mdText = "";
			this.mdStream = undefined;
		}
	}

	activity(c: StreamChunk, _width: number): void {
		if (c.kind === "reasoning") {
			if (!this.inThink && this.mdText !== "") {
				this.pushE({ k: "md", src: this.mdText });
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
						this.markCountDirty(i); // 条目原位变更——账本行即时重算（T4）
						break;
					}
					if (prev.k === "raw" && prev.s.trim() !== "") break; // 工具行不紧邻（理论不至）——不合并
				}
				continue;
			}
			this.pushE({ k: "raw", s: l });
		}
	}

	/** turn 结束定格。 */
	end(_width: number): void {
		this.settleActive();
	}

	/** 工具调用结构化摄入（2026-09-23 走查批——args 留存供 diff 渲染；renderEvent 的一行文本形态
	 *  只服务行模式，全屏走本口）。callId = 与 tool/result 的配对键（事件载荷在场，loop 落盘即带）。 */
	toolCall(name: string, args: Record<string, unknown> | undefined, callId?: string): void {
		this.settleActive();
		// tasks 纯查询不占流区行（进度已在 agent 组里实时可见——2026-09-27 拍板；行模式 renderEvent 同幅抑制）
		if (name === "tool-subagent__tasks") {
			if (callId !== undefined) this.ghostCalls.add(callId);
			else this.ghostNoIdAt = this.lines.length; // CTW-10：位置感知——记静默 call 时刻条目序
			return;
		}
		// 连续同名只读工具聚合（2026-09-30 用户拍板抄 cc-haha 计数行）：紧邻前一条目是同名可折叠工具
		// （solo 或已成组）→ 并进宿主条目不新增行（kimi 就地升级同款）——渲染一行计数，下标/账本/callId 配对不变
		if (COLLAPSIBLE_TOOLS.has(name)) {
			const last = this.lines[this.lines.length - 1];
			if (last !== undefined && last.k === "tool" && (last.group?.name ?? last.name) === name) {
				if (last.group === undefined) {
					last.group = {
						name,
						items: [{ args: last.args, ...(last.callId !== undefined ? { callId: last.callId } : {}), ...(last.result !== undefined ? { result: last.result } : {}) }],
					};
				}
				last.group.items.push({ args, ...(callId !== undefined ? { callId } : {}) });
				this.markCountDirty(this.lines.length - 1); // 组员加入——组行数即时重算
				return;
			}
		}
		this.pushE({ k: "tool", name, args, ...(callId !== undefined ? { callId } : {}) });
		this.trimIntraTurn(); // T9：轮内步数即时有界（活轮巨步骤不再全挂载——懒查轻计数）
	}

	/** T9 轮内步级折叠切换（Alt+S）：开 = 全部 fold-step splice 回原位；关 = 全轮重折（各轮独立保留
	 *  最近 stepsKeep 步）。条目增删走 splice（下标稳定语义），账本由 reconcile 的 stepsOpen 键失配
	 *  全量重折收口。 */
	toggleSteps(): void {
		this.stepsOpen = !this.stepsOpen;
		if (this.stepsOpen) {
			for (let i = this.lines.length - 1; i >= 0; i--) {
				const e = this.lines[i]!;
				if (e.k !== "fold-step") continue;
				const t = this.turnOf[i] ?? 0;
				this.lines.splice(i, 1, ...e.hidden);
				this.turnOf.splice(i, 1, ...e.hidden.map(() => t));
				this.counts.splice(i, 1, ...e.hidden.map(() => -1));
			}
		} else {
			for (let t = 0; t <= this.curTurn; t++) this.foldStepsForTurn(t, true);
		}
	}

	/** T9 轮内折叠增量触发（toolCall 推入后 + turnEnd 收轮时）：滞回 +10——超 stepsKeep+10 才折到
	 *  stepsKeep（避免每步一折的抖动；kimi 滑窗滞回同思路）。stepsOpen 展开态/env 0 不折。 */
	private trimIntraTurn(): void {
		if (this.stepsOpen || this.stepsKeep === 0) return;
		this.foldStepsForTurn(this.curTurn, false);
	}

	/** T9 单轮折叠：该轮步骤条目超 stepsKeep+10 时，把最早的（步数 − stepsKeep）个收进 fold-step
	 *  （同轮已有 fold-step 则并入其 hidden，位置不动）；lines/turnOf/counts 三平行数组同步 splice，
	 *  fold-step 恒 1 行（账本即时精确）。 */
	private foldStepsForTurn(turn: number, final: boolean): void {
		const keep = this.stepsKeep;
		if (keep === 0) return;
		const SLACK = final ? 0 : 10; // 活轮滞回防每步一折；收轮/重折终态=精确 stepsKeep
		const stepIdx: number[] = [];
		let foldAt = -1;
		for (let i = 0; i < this.lines.length; i++) {
			const e = this.lines[i]!;
			if (this.turnOf[i] !== turn) continue;
			if (e.k === "fold-step") {
				foldAt = i;
				continue;
			}
			if (this.isStepEntry(e)) stepIdx.push(i);
		}
		if (stepIdx.length <= keep + SLACK) return;
		const foldN = stepIdx.length - keep;
		const victims = stepIdx.slice(0, foldN);
		const hidden: Entry[] = [];
		for (let v = victims.length - 1; v >= 0; v--) {
			const i = victims[v]!;
			hidden.unshift(this.lines[i]!);
			this.lines.splice(i, 1);
			this.turnOf.splice(i, 1);
			this.counts.splice(i, 1);
		}
		if (foldAt >= 0) {
			// 同轮已有折叠行：并入（foldAt 位于最早 victim 之前——splice 后仍指向折叠行本体）
			const fe = this.lines[foldAt]!;
			if (fe.k === "fold-step") fe.hidden.push(...hidden);
			return;
		}
		const insertAt = victims[0]!;
		this.lines.splice(insertAt, 0, { k: "fold-step", hidden });
		this.turnOf.splice(insertAt, 0, turn);
		this.counts.splice(insertAt, 0, 1);
	}

	/** 工具结果原位合并：callId 在场 → 精确配对（并发乱序不交叉挂错——2026-09-25 用户实机错配修复：
	 *  旧「最近未完结」启发式在后发先完成时把快工具的结果挂到慢工具行上）；缺席（旧会话日志）→
	 *  回退最近未完结（write() 的 TOOL_MERGE 哨兵同语义的结构化版）。 */
	toolResult(output: unknown, isError: unknown, callId?: string, images?: unknown): void {
		this.settleActive();
		// m5-media F4：图片附件摄入（不受信形状防御——坏条目剔除；statSync 取体积供信息行，失败记 0）
		const imgs: { path: string; mime: string; bytes: number }[] | undefined = (() => {
			if (!Array.isArray(images)) return undefined;
			const ok = images.flatMap((it): { path: string; mime: string; bytes: number }[] => {
				const o = it as { path?: unknown; mimeType?: unknown } | null;
				if (typeof o?.path !== "string" || o.path === "" || typeof o?.mimeType !== "string") return [];
				let bytes = 0;
				try { bytes = statSync(o.path).size; } catch { bytes = 0; }
				return [{ path: o.path, mime: o.mimeType.split("/")[1] ?? o.mimeType, bytes }];
			});
			return ok.length > 0 ? ok : undefined;
		})();
		// 静默对的另一半：tasks 的结果随 call 一起吞（agent 组已实时显示同款信息——不刷屏）
		if (callId !== undefined && this.ghostCalls.has(callId)) {
			this.ghostCalls.delete(callId);
			return;
		}
		if (callId === undefined && this.ghostNoIdAt !== undefined) {
			// 旧日志（无 callId）：仅当结果紧随静默 call（期间无新条目入列——条目序未动）才吞，一次性窗口。
			// 乱序日志中间必夹其他 call/消息条目 → 条目序已变 → 走正常回退路径，不吞别人的结果（CTW-10）
			const adjacent = this.lines.length === this.ghostNoIdAt;
			this.ghostNoIdAt = undefined;
			if (adjacent) return;
		}
		const text = typeof output === "string" ? stripDangerEsc(output) : stripDangerEsc(String(output ?? "")); // CR-01：工具输出是外部文字——摄入净化（会话文件仍存原文）
		let n = 0;
		for (const l of text.split("\n")) if (l.trim().length > 0) n++;
		if (callId !== undefined) {
			for (let i = this.lines.length - 1; i >= 0; i--) {
				const prev = this.lines[i]!;
				if (prev.k !== "tool") continue;
				if (prev.group !== undefined) {
					// 聚合组（2026-09-30）：callId 配对下钻 items——宿主自身字段自成组起停用
					const item = prev.group.items.find((it) => it.callId === callId);
					if (item !== undefined) {
						if (item.result === undefined) {
							item.result = { isError: isError === true, output: isError === true ? text : undefined, lines: n, ...(imgs !== undefined ? { images: imgs } : {}) };
							this.markCountDirty(i);
						}
						return;
					}
					continue; // 本组无此 callId——继续向前扫（前后可能另有同名 solo/组）
				}
				if (prev.callId === callId) {
					if (prev.result === undefined) {
						prev.result = { isError: isError === true, output: isError === true ? text : undefined, lines: n, ...(imgs !== undefined ? { images: imgs } : {}) };
						this.markCountDirty(i); // 条目原位变更——账本行即时重算（T4）
					}
					return; // callId 唯一：已有结果不覆盖，无则挂上
				}
			}
			return; // 无匹配 call 条目（call 行未入列——如压缩裁剪后）——宁可不挂也不错挂
		}
		for (let i = this.lines.length - 1; i >= 0; i--) {
			const prev = this.lines[i]!;
			if (prev.k === "tool") {
				if (prev.group !== undefined) {
					// 组内最近未完结（旧日志无 callId 回退语义——组员从后往前找第一个空位）
					for (let j = prev.group.items.length - 1; j >= 0; j--) {
						const item = prev.group.items[j]!;
						if (item.result === undefined) {
							item.result = { isError: isError === true, output: isError === true ? text : undefined, lines: n, ...(imgs !== undefined ? { images: imgs } : {}) };
							this.markCountDirty(i);
							return;
						}
					}
					continue; // 全组已结——继续向前
				}
				if (prev.result === undefined) {
					prev.result = { isError: isError === true, output: isError === true ? text : undefined, lines: n, ...(imgs !== undefined ? { images: imgs } : {}) };
					this.markCountDirty(i); // 条目原位变更——账本行即时重算（T4）
					return;
				}
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
			if (e.result.images !== undefined) chip += ` · 附 ${e.result.images.length} 图`; // m5-media F4：头行 chip 常显（收起态也可见）
		}
		const head = toolCallLine(e.name, e.args, process.cwd()).replace("● Using ", e.result === undefined ? "● Using " : "● Used ") + chip;
		const out = [this.styleToolLine(head, e.result?.isError === true)];
		// m5-media F4：图片信息行（不渲染像素——终端不折腾六块图）；Alt+O 展开态逐图一行（格式+体积+路径）
		if (e.result?.images !== undefined && this.toolOpen) {
			for (const img of e.result.images) {
				const size = img.bytes >= 1024 ? `${(img.bytes / 1024).toFixed(1)} KB` : `${img.bytes} 字节`;
				for (const wl of wrapText(`图 ${img.mime} · ${size} · ${img.path}`, Math.max(8, width - 4))) out.push(theme.dim(`  ${wl}`));
			}
		}
		if (e.result?.isError === true) {
			if (!this.errOpen) return out;
			// CTW-09（2026-09-28）：错误体入场一次解析缓存（hl/detail 同纪律）——errorLines 是
			// JSON.parse 尝试 + 全文 split + 逐行 cleanLine，失败体可达数百 KB，展开期帧心跳不重算
			// 展开帽 10（m5-render-perf 走查③修，2026-09-29 用户报「一大堆」——旧帽 60 整屏 err 色；
			// kimi RESULT_PREVIEW_LINES=3 同哲学：预览给够、完整内容有专门出口，其 ctrl+o = 我们会话文件）
			e.errLines ??= errorLines(e.result.output);
			const ERR_CAP = 10; // 与 diff/Write 收起帽同族（CAP 10）
			for (const l of e.errLines.slice(0, ERR_CAP)) for (const wl of wrapText(l, Math.max(8, width - 2))) out.push("  " + theme.fg("err", wl));
			if (e.errLines.length > ERR_CAP) out.push(theme.dim(`  … 其余 ${e.errLines.length - ERR_CAP} 行从略（完整内容在会话文件）`));
			return out;
		}
		// Write = 内容预览（kimi 形态：dim 行号 + 语法高亮正文，无 +/- 记号——高亮一次入缓存，
		// 折行按帧宽即时；wrapText 是 ANSI 感知折行，高亮序列跨行续色）
		const wc = writeContentFor(e.name, e.args);
		if (wc !== undefined) {
			if (e.hl === undefined) e.hl = highlightLines(stripDangerEsc(wc.content).replace(/\n+$/, ""), langForPath(wc.path)); // CR-01：Write 正文是模型手笔（外部文字）——高亮前净化
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

	/** 聚合组渲染（2026-09-30 用户拍板抄 cc-haha 计数行）：收起 = 一行「Used Read 3 个文件 · 共 N 行」
	 *  （进行中 Using…；含失败尾缀「· N 失败」）；Alt+O 展开 = 组头 + 逐组员单行（两格缩进，kimi 树形近似）。
	 *  计数去重口径（cc-haha 唯一路径 Set 同款）：read 按 path+offset+limit、grep/glob 按 pattern。 */
	private toolGroupLines(e: Entry & { k: "tool" }, width: number): string[] {
		const g = e.group!;
		const label = toolDisplayName(g.name);
		const uniq = new Set(g.items.map((it) =>
			g.name === "tool-fs__read"
				? `${String(it.args?.path ?? "")}:${String(it.args?.offset ?? "")}:${String(it.args?.limit ?? "")}`
				: String(it.args?.pattern ?? ""),
		)).size;
		const unit = g.name === "tool-fs__read" ? "个文件" : "个模式";
		const pend = g.items.some((it) => it.result === undefined);
		const failed = g.items.filter((it) => it.result?.isError === true).length;
		const total = g.items.reduce((s, it) => s + (it.result !== undefined && !it.result.isError ? it.result.lines : 0), 0);
		const head = pend
			? `● Using ${label} ${uniq} ${unit}…`
			: `● Used ${label} ${uniq} ${unit} · 共 ${total} 行${failed > 0 ? ` · ${failed} 失败` : ""}`;
		const out = [this.styleToolLine(head, !pend && failed === g.items.length)];
		if (!this.toolOpen) return out;
		for (const it of g.items) {
			out.push("  " + this.toolLines({ k: "tool", name: g.name, args: it.args, ...(it.result !== undefined ? { result: it.result } : {}) }, width)[0]!);
		}
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
		this.thinkLive = new LiveWrap();
	}

	/** turn 结束 = 轮边界（一轮 = 两条用户消息之间的全部条目，kimi 同义）。宿主在 onEvent
	 *  turn/end 的 sink.end()（settleActive）之后调用；historyFrom 装载期走 turnEnd(false)
	 *  只记账、尾部统一裁剪一次（resume 即裁）。 */
	turnEnd(trim = true): void {
		this.foldStepsForTurn(this.curTurn, true); // T9：收轮终折（回放路 turnEnd(false) 同钩——装载即有界且精确到 stepsKeep）
		this.curTurn++;
		if (trim) this.trimTurns();
	}

	/** 滑窗裁剪（kimi transcript-window 同参数：保留最近 15 轮、滞回 +5——超 20 轮才裁到 15；
	 *  env OROSUS_TUI_MAX_TURNS 覆盖、0 = 不裁逃生阀）。被裁轮次条目整块销毁（源+缓存释放，
	 *  治持仓），原地一行折叠提示（D12）。阅读保护：被裁段与视口相交 → 本轮整批顺延（不做
	 *  部分裁剪——中段移除破坏底部锚定几何；滚回底部后下一次触发再裁）。 */
	private trimTurns(): void {
		if (!this.turnWindowEnabled) return;
		const keep = Number(process.env.OROSUS_TUI_MAX_TURNS ?? 15);
		if (!Number.isFinite(keep) || keep <= 0) return; // 0 = 不裁（逃生阀）
		const HYST = 5; // 滞回：减少折叠行频繁进出的抖动（kimi 同值）
		if (this.curTurn + 1 <= keep + HYST) return; // 未超 keep+5 不裁
		const oldest = this.curTurn - keep + 1; // 保留 [oldest, curTurn] 共 keep 轮
		let cut = 0;
		while (cut < this.lines.length && (this.lines[cut]!.k === "fold" || this.turnOf[cut]! < oldest)) cut++;
		if (cut === 0) return;
		if (this.viewportProbe !== undefined) {
			const vp = this.viewportProbe();
			if (vp !== undefined) {
				let cutLines = 0;
				for (let i = 0; i < cut; i++) cutLines += Math.max(0, this.counts[i] ?? 0);
				if (cutLines > vp.start) return; // 被裁段 [0, cutLines) 与视口 [vp.start, vp.end) 相交——整批顺延
			}
		}
		this.foldedTurns = oldest; // 已折叠 = 轮 0..oldest-1（轮号恒连续）
		this.lines.splice(0, cut);
		this.turnOf.splice(0, cut);
		this.counts.splice(0, cut);
		this.lines.unshift({ k: "fold", turns: this.foldedTurns });
		this.turnOf.unshift(0);
		this.counts.unshift(1); // fold 恒 1 行（账本即时精确）
		this.headTrimmedNet += cut - 1; // 头部净平移：移除 cut 行 − 回插 fold 1 行（走查⑦滚动补偿用）
	}

	/** 头部净平移累计读口（走查⑦）：滑窗裁剪造成的行号整体平移量——fullapp 据此把总行数变化
	 *  分解为「行号平移（视口内容本就不动，不补偿）」与「尾部增缩（保视口 start 要补偿）」。 */
	headShiftTotal(): number {
		return this.headTrimmedNet;
	}

	/** 远区缓存淘汰（设计空白 #8——落地取节流档）：距视口所在轮 > 3 轮的条目丢渲染缓存，
	 *  源与账本精确计数保留（滚回即重渲、几何不变——T4 账本使「丢缓存不丢几何」成立）。
	 *  frameWindow 尾部 1Hz 节流调用；测试可直调。 */
	evictFarCaches(viewportStartLine: number): void {
		if (this.turnOf.length === 0 || this.lines.length === 0) return;
		let acc = 0;
		let vTurn = this.curTurn;
		for (let i = 0; i < this.lines.length; i++) {
			const e = this.lines[i]!;
			if (e.k !== "group") acc += Math.max(0, this.counts[i] ?? 0); // group 活体行不占账（近似定位淘汰边界，宽带有余量）
			if (acc > viewportStartLine) {
				vTurn = this.turnOf[i] ?? this.curTurn;
				break;
			}
		}
		for (let i = 0; i < this.lines.length; i++) {
			if (vTurn - (this.turnOf[i] ?? 0) <= 3) continue;
			const e = this.lines[i]!;
			if (e.k === "raw" || e.k === "md" || e.k === "user" || e.k === "think" || e.k === "tool") delete e.cache;
		}
	}

	/** 历史结构化摄入（F5 五轮②③④）：与实时流同形（暖金提问/md 渲染/think marker/工具 Used 行）。 */
	/** 已装载最老事件 seq（T14 懒分页取段锚——eventsBefore 的 beforeSeq 数据源）。 */
	oldestLoadedSeq: number | undefined = undefined;

	historyFrom(events: { type: string; seq?: unknown; [k: string]: unknown }[], _width: number): void {
		if (typeof events[0]?.seq === "number") this.oldestLoadedSeq = events[0]!.seq;
		this.replayEventLoop(events);
		this.settleActive();
		if (this.turnWindowEnabled) this.trimTurns(); // resume 即裁：装载完立即裁到保留窗（大会话恢复首帧与内存双收益——这正是恢复秒开的来源）
	}

	/** T14 懒分页头部插页：更早事件按 historyFrom 同款逐事件转换（共用 replayEventLoop，勿复制粘贴）
	 *  后整块搬到头部（fold 行之后——补页历史晚于已折叠轮）。轮号取负基（低于一切现存轮——补页是
	 *  临时阅读态，滚回底部后 trimTurns 按「轮号 < oldest」正常裁掉，滑窗治理不冲突）；账本 counts
	 *  插 -1 脏标（reconcile 补尾只长尾，头部插入须显式 splice）；bottom 锚定滚动几何天然钉住视口
	 *  （头部插入 → dmTotal 与内容同下移，scrollBack 不动 = 同一可视内容）。 */
	prependHistory(events: { type: string; seq?: unknown; [k: string]: unknown }[], _width: number): number {
		if (events.length === 0) return 0;
		const savedTurn = this.curTurn;
		const startLen = this.lines.length;
		this.curTurn = -events.filter((e) => e.type === "turn/end").length - 1; // 负基：补页轮恒先于现存轮被裁
		this.replayEventLoop(events);
		this.curTurn = savedTurn;
		const added = this.lines.length - startLen;
		if (added === 0) return 0;
		const newEntries = this.lines.splice(startLen, added);
		const newTurns = this.turnOf.splice(startLen, added);
		const at = this.lines.length > 0 && this.lines[0]!.k === "fold" ? 1 : 0;
		this.lines.splice(at, 0, ...newEntries);
		this.turnOf.splice(at, 0, ...newTurns);
		this.counts.splice(at, 0, ...Array.from({ length: added }, () => -1));
		if (typeof events[0]?.seq === "number") this.oldestLoadedSeq = events[0]!.seq;
		return added;
	}

	/** 回放事件 → 条目（historyFrom 与 T14 prependHistory 共用的逐事件转换——单源勿复制）。 */
	private replayEventLoop(events: { type: string; [k: string]: unknown }[]): void {
		// 回放期 agent 组重建（2026-09-27：重载后与实时同形——不再退化静态占位行）。同一轮 assistant
		// 的连续 spawn 并一组（组引用到 user/assistant 消息边界即断）——与实时路「末组活着才并入」等价：
		// 回放全员终态，轮边界即断组点。组员编号从 spawn 的 result 里抠（callId 精确配对，spawnIdsIn
		// 与 /tasks 历史重建同口径）。当前组 = this.replayGroup（T1 实例字段——分批喂入同形，见字段注释）。
		for (const e of events) {
			if (e.type === "user/message") {
				this.replayGroup = undefined;
				const parts = (e.content ?? []) as { kind?: string; text?: string }[];
				const text = parts.filter((p) => p.kind === "text").map((p) => p.text ?? "").join("");
				const imgs = parts.filter((p) => p.kind === "image").length;
				if (text !== "" || imgs > 0) this.userPrompt(text + (imgs > 0 ? `  [图片${imgs > 1 ? `×${imgs}` : ""}]` : ""));
			} else if (e.type === "assistant/message") {
				this.replayGroup = undefined;
				const parts = (e.content ?? []) as { kind?: string; text?: string }[];
				const think = parts.filter((p) => p.kind === "reasoning").map((p) => p.text ?? "").join("");
				if (think !== "") {
					this.settleActive();
					this.pushE({ k: "think", src: think });
				}
				const text = parts.filter((p) => p.kind === "text").map((p) => p.text ?? "").join("");
				if (text !== "") {
					this.settleActive();
					this.pushE({ k: "md", src: text });
				}
			} else if (e.type === "tool/call") {
				const name = String(e.name);
				const callId = typeof e.callId === "string" ? e.callId : undefined;
				if (name === "tool-subagent__spawn") {
					this.settleActive();
					if (this.replayGroup === undefined) {
						this.replayGroup = { k: "group", ids: [] };
						this.pushE(this.replayGroup);
					}
					if (callId !== undefined) this.pendingSpawnResults.set(callId, this.replayGroup);
					continue;
				}
				this.toolCall(name, e.args as Record<string, unknown> | undefined, callId);
			} else if (e.type === "tool/result") {
				const callId = typeof e.callId === "string" ? e.callId : undefined;
				const grp = callId !== undefined ? this.pendingSpawnResults.get(callId) : undefined;
				if (grp !== undefined && callId !== undefined) {
					this.pendingSpawnResults.delete(callId);
					for (const id of spawnIdsIn(String(e.output ?? ""))) if (!grp.ids.includes(id)) grp.ids.push(id);
					continue; // spawn 结果不落行——进度/结论都在 agent 组里（实时路同款：无配对工具行，静默丢弃）
				}
				this.toolResult(e.output, e.isError, callId, e.images); // m5-media F4：图片附件透传（信息行数据源）
				} else if (e.type === "agent/steering-message") {
					// steer 注入的消息回显（2026-09 队列批——投影 = user 消息，回显同形暖金提问块）
					const msgs = (e.messages ?? []) as { text?: string; sourceModule?: string }[];
					for (const m of msgs) {
						if (typeof m.text !== "string" || m.text === "") continue;
						// M4.5 T9：子代理送回走灰色系统行（sourceModule 标记——非用户块；行文自带 [非用户输入] 头防伪装）
						if (m.sourceModule === "tool-subagent") this.pushLine(theme.fg("muted", m.text));
						// 日期系统行（host/date）不回显：实时路 renderEvent 本就不渲染它，回放对齐——
						// resume 后流区不该冒出「[非用户输入] 系统提醒：今天是 …」（2026-09-28 修复，落盘与请求侧不动）
						else if (m.sourceModule === "host/date") continue;
						// 钩子注入折叠行（m5-hooks T10 / D19）：host/hook 注入与 hooks 续跑——回放与 live 同款重现
						else if (m.sourceModule === "host/hook" || m.sourceModule === "hooks")
							this.pushLine(theme.fg("muted", `  ⌁ ${injectionFoldLabel(m.text, m.sourceModule)}（Ctrl + H 查看全文）`));
						else this.userPrompt(m.text);
					}
				} else if (e.type === "host/vision-transcribe") {
				// 视觉转述行回放（走查四拍板「重进程序调历史也要显示」）：落盘恒终态——done（text 在场）/
				//  failed（ok !== true）；行序由 afterUserEvent 紧随 user/message 落盘保证（问题→转述→回答）。
				//  不进上下文：deriveMessages 未知类型跳过（本事件只是回放渲染数据）。
				const text = typeof e.text === "string" && e.text !== "" ? e.text : undefined;
				this.visionTranscribeEnd(String(e.model ?? ""), text, text === undefined ? "failed" : "done");
			} else if (e.type === "hooks/input-rewrite") {
				// 改参修订注记回放（m5-hooks T10）：与实时路 renderEvent 同款一行灰字
				this.pushLine(theme.fg("muted", "  ⌁ 钩子改参：参数已由钩子改写（对话流工具行存原始参数，审批与执行见改后参数）"));
			} else if (e.type === "turn/compaction") {
				this.settleActive();
				this.pushE({ k: "raw", s: `  [已压缩：${Number(e.droppedCount ?? 0)} 条历史 → 摘要（Ctrl+O 查看）]` });
			} else if (e.type === "turn/end") {
				this.turnEnd(false); // 装载期只记账不逐次裁剪——尾部统一一次（T7 轮次记账补分支）
			}
		}
	}

	/** 用户消息块（❯ 青玉 + 暖金加粗正文 + 前后各空一行）。
	 *  技能加载消息紧凑化（2026-09-28 拍板：正文不打印进对话流——kimi「Activated skill」/pi「[skill] name」
	 *  同款；全文照发模型上下文）。标记行可在消息首（菜单 Enter 注入）或任意行（手敲形态：原话行嵌在
	 *  标记行之后持久化，2026-09-30 拍板）——标记行前的内容与紧随其后以 / 开头的原话行都出用户块、
	 *  然后 ● 行，实时与 historyFrom 回放同走本口同形。 */
	userPrompt(text: string): void {
		const m = /(?:^|\n)（用户通过菜单手动加载技能 "([^"]+)"——请按该技能正文行事）/.exec(text);
		if (m !== null) {
			const pre = text.slice(0, m.index).replace(/\n+$/, "");
			if (pre.trim() !== "") this.pushE({ k: "user", src: pre });
			const rest = text.slice(m.index + m[0].length).replace(/^\n+/, "");
			const nl = rest.indexOf("\n");
			if (rest.startsWith("/")) this.pushE({ k: "user", src: nl === -1 ? rest : rest.slice(0, nl) });
			this.pushE({ k: "skill", name: m[1]! });
			return;
		}
		this.pushE({ k: "user", src: text });
	}

	/** markdown 渲染推入（F5 六轮②）：命令结果通道——/compact /summary 等输出含 md。 */
	pushMd(text: string, _width: number): void {
		this.settleActive();
		this.pushE({ k: "md", src: text });
	}

	/** 直接推一行（宿主带内输出——横幅/提示语的流区呈现；超宽由 frameLines 折行兜底）。 */
	pushLine(s: string): void {
		for (const l of s.replace(/\n$/, "").split("\n")) this.pushE({ k: "raw", s: l });
	}

	/** 视觉转述行·开始（走查四）：推送 ◐ 进行中条目——发送闸旁路时在回显后立即调用（回车即见）。 */
	visionTranscribeStart(model: string): void {
		this.settleActive();
		this.pushE({ k: "vision", model, state: "running", since: Date.now() });
	}

	/** 视觉转述行·收尾：最近一条 running 条目原位翻转终态（下标/账本稳定——markCountDirty 同 toolResult
	 *  挂上口径）；无 running 条目（回放路）直接推终态。aborted = 双 Esc 中止（live-only，永不回放）。
	 *  收尾同时清空转述活动块（思考增量弃置——流式期间可见即完成使命，定格只留正文；与主对话
	 *  「思考冻结成块」不同：转述思考是过程性噪音）。 */
	visionTranscribeEnd(model: string, text: string | undefined, state: "done" | "failed" | "aborted"): void {
		this.settleActive();
		this.visionThinkText = "";
		this.visionBodyText = "";
		this.visionLive = new LiveWrap();
		const final = text === undefined ? { k: "vision" as const, model, state } : { k: "vision" as const, model, state, text };
		for (let i = this.lines.length - 1; i >= 0; i--) {
			const e = this.lines[i]!;
			if (e.k === "vision" && e.state === "running") {
				this.lines[i] = final;
				this.markCountDirty(i);
				return;
			}
		}
		this.pushE(final);
	}

	/** 转述活动块·流式增量（A 案 2026-10-02 拍板）：思考 dim 尾两行（与主思考收起态同款流动感）+
	 *  正文 muted 全量折行——activeTail 渲染（1s 心跳重绘驱动，等待不死字防卡死感）。 */
	visionDelta(kind: "thinking" | "text", text: string): void {
		if (kind === "thinking") this.visionThinkText += text;
		else this.visionBodyText += text;
	}

	/** 工具行配色（F5 六轮① 用户拍板；2026-09-22 再拍板：动词 Using/Used 白色）：
	 *  ● 与工具名青玉、动词白、参数/行数灰；failed = ● 与 chip 转 err 红（kimi ✗ 形态——
	 *  失败卡在流区一眼可辨）。显示名可含空格（label 字段 "Web Search"——2026-09-24）：非贪婪
	 *  吃到「 (参数」「 · chip」或行尾为止，剥前缀旧名（无空格）逐字节同色。 */
	private styleToolLine(l: string, failed = false): string {
		const m = /^(●) (Using |Used )(.+?)(?= \(| · |$)(.*)$/.exec(l);
		if (m === null) return l;
		if (failed) return theme.fg("err", m[1]!) + theme.fg("fg", " " + m[2]!) + theme.fg("accent", m[3]!) + theme.fg("err", m[4]!);
		return theme.fg("accent", m[1]!) + theme.fg("fg", " " + m[2]!) + theme.fg("accent", m[3]!) + theme.dim(m[4]!);
	}

	/** 折行调用观测口（m5-render-perf T6 性能钉二数据源）：renderEntry 实际执行折行/渲染
	 *  （wrapText/thinkBlock/toolLines/renderMarkdown）的次数——缓存命中不计；group 活体行
	 *  与 skill 单行不计（前者恒现算、后者无折行）。测试复位读取，防「稳态帧被接回全量物化」。
	 *  生产路径零读取，仅观测。 */
	debugWrapCalls = 0;

	/** 单条目渲染（行内容缓存键控照旧——m5-render-perf T4 从 frameLines 循环体提取，
	 *  frameLines 与 frameWindow 共用；group 活体行每帧现算不缓存）。 */
	private renderEntry(e: Entry, width: number, roster: readonly SubagentRosterEntry[]): string[] {
		if (e.k === "fold") {
			// 滑窗折叠行（D12）：单行 dim 提示，与压缩提示行/工具截断行同族排版——去向 = 会话文件
			return [theme.dim(`┄ 已折叠更早的 ${e.turns} 轮对话 · 完整内容在会话文件`)];
		}
		if (e.k === "fold-step") {
			// 轮内步级折叠行（T9——kimi KEEP_RECENT_STEPS 同款文案形）：单行 dim，去向 = Alt+S 展开
			return [theme.dim(`  ⚙ 本轮前序 ${e.hidden.length} 步已折叠（Alt + S 展开全部）`)];
		}
		if (e.k === "group") {
			const mine = e.ids.map((id) => roster.find((r) => r.id === id)).filter((r): r is SubagentRosterEntry => r !== undefined);
			const out = agentGroupLines(mine); // 每帧现算——状态/时长/词元随心跳自更
			// 兜底：组员编号在场但花名册解析不出（fork 会话 agents/ 留在原会话、盘上文件被清）——
			// 留一行痕迹而不是整组消失（spawn 行已吞，无此行这段历史就空了）
			if (mine.length === 0 && e.ids.length > 0) out.push(theme.fg("muted", "  ● 派出子代理（本会话无可查名册——/tasks 可试）"));
			return out;
		}
		if (e.k === "think") {
			if (e.cache?.w !== width || e.cache.open !== this.thinkOpen) {
				this.debugWrapCalls++;
				e.cache = { w: width, open: this.thinkOpen, lines: this.thinkBlock(e.src, width) };
			}
			return e.cache.lines;
		}
		if (e.k === "user") {
			// 用户消息折行（2026-09-23 走查批①：此前逐逻辑行直推不折行，长提问被终端硬截）。
			// 一个块只画一个 ❯（2026-09-27 拍板：多行提问/子代理任务书整块一段——换行与折行续行
			// 同为 2 空格缩进；旧实现逐逻辑行各画 ❯，多行任务书满屏箭头）。宽度级缓存（A 批）。
			if (e.cache?.w !== width) {
				this.debugWrapCalls++;
				const uw = Math.max(8, width - 2); // 「❯ 」前缀 2 列计入折行宽
				const lines: string[] = [""];
				let first = true;
				for (const l of e.src.split("\n")) {
					for (const wl of wrapText(l, uw)) {
						lines.push(first ? `${theme.fg("accent", "❯")} ${theme.bold(theme.fg("warn", wl))}` : `  ${theme.bold(theme.fg("warn", wl))}`);
						first = false;
					}
				}
				lines.push("");
				e.cache = { w: width, lines };
			}
			return e.cache.lines;
		}
		if (e.k === "tool") {
			// 聚合组（2026-09-30）：每帧现算不缓存（agent group 同款——头行随组员挂果翻转「Using…→Used · 共
			// N 行」；行数 = 1 或 1+组员数，账本键控〔宽度/Alt+O 翻转全量失效〕+ markCountDirty〔组员到达/挂果〕覆盖）
			if (e.group !== undefined) return this.toolGroupLines(e, width);
			const done = e.result !== undefined;
			if (e.cache?.w !== width || e.cache.open !== this.toolOpen || e.cache.err !== this.errOpen || e.cache.done !== done) {
				this.debugWrapCalls++;
				e.cache = { w: width, open: this.toolOpen, err: this.errOpen, done, lines: this.toolLines(e, width) };
			}
			return e.cache.lines;
		}
		if (e.k === "skill") {
			// 技能加载行：● 与技能名青玉、说明灰（工具行配色同族——2026-09-28 用户拍板：技能正文不进对话流）
			return [theme.fg("accent", "●") + theme.fg("fg", " 已加载技能 ") + theme.fg("accent", e.name) + theme.dim(" · 正文已注入模型上下文")];
		}
		if (e.k === "vision") {
			// 视觉转述行（走查四）：进行中活体行——已耗时每帧现算（1s 心跳重绘驱动；流式增量在
			// 转述活动块 activeTail，这里只做「还活着」的计时证明——B 档兜底）；终态头行 ● 青玉 +
			// 模型名灰括注 + 正文 muted 折行（宽度级缓存）
			if (e.state === "running") return [theme.dim(`◐ 由 ${e.model} 转述图片中… ${Math.max(0, Math.floor((Date.now() - (e.since ?? Date.now())) / 1000))}s`)];
			if (e.state === "aborted") return [theme.fg("muted", "● 视觉转述已中止——消息未发出（重发即续：已生成的转述有缓存）")];
			if (e.state === "failed") return [theme.fg("muted", `● 视觉转述失败（${e.model}）——已按无图占位发送`)];
			// done 正文默认折叠、Alt+E 展开（2026-10-02 拍板——全量转述可达 1200 字，与主思考共键）：
			// 折叠 = 头行带展开提示 + 正文尾两行（thinkBlock 收起态同款「最新内容」语义）；展开 = 全文
			if (e.cache?.w !== width || e.cache.open !== this.thinkOpen) {
				this.debugWrapCalls++;
				const body = wrapText(e.text ?? "", Math.max(8, width - 2)).map((l) => theme.fg("muted", `  ${l}`));
				const head = this.thinkOpen
					? theme.fg("accent", "●") + theme.fg("fg", " 视觉转述") + theme.dim(`（${e.model}）`)
					: theme.fg("accent", "●") + theme.fg("fg", " 视觉转述") + theme.dim(`（${e.model}） · Alt + E 展开`);
				e.cache = { w: width, open: this.thinkOpen, lines: this.thinkOpen ? [head, ...body] : [head, ...body.slice(-2)] };
			}
			return e.cache.lines;
		}
		if (e.k === "md") {
			if (e.cache?.w !== width) {
				this.debugWrapCalls++;
				e.cache = { w: width, lines: renderMarkdown(e.src, width) };
			}
			return e.cache.lines;
		}
		// raw 行：工具行渲染期上色（存储留纯文本供合并）；超宽 wrapText 兜底——宽度级缓存（A 批）
		if (e.cache?.w !== width) {
			this.debugWrapCalls++;
			const shown = e.s.startsWith("● ") ? this.styleToolLine(e.s) : e.s;
			e.cache = { w: width, lines: visibleWidth(shown) > width ? wrapText(shown, width) : [shown] };
		}
		return e.cache.lines;
	}

	/** 账本（m5-render-perf T4）：与 lines 平行的定格条目行数。渲染即计（cache.lines.length），
	 *  帧入口 reconcile 校验宽度/折叠态键 + 脏行重算 + 补尾——任何消费点恒精确（D9：无估计值
	 *  无收敛过程；可惰性的只有行内容缓存）。group 活体行不入账（roster 心跳每变、恒现算）；
	 *  活动块（thinkText/mdText）是帧尾动态段同样不入账。-1 = 脏（toolResult 挂上/TOOL_MERGE
	 *  改行——条目原位变更，下次 reconcile 即时重算）。 */
	private counts: number[] = [];
	private ledgerWidth = -1;
	private ledgerThinkOpen = false;
	private ledgerToolOpen = false;
	private ledgerErrOpen = false;
	private ledgerStepsOpen = false;

	/** 帧入口账本维护：键失配（宽度/Ctrl+T 或 Alt+E/O/F/S 折叠态）→ 全量重折（refoldAll 语义）；
	 *  脏行重算；新入列条目补尾（渲染入 cache 顺便计数——计数精确不依赖先被窗口扫到）。 */
	private reconcile(width: number): void {
		if (this.ledgerWidth !== width || this.ledgerThinkOpen !== this.thinkOpen || this.ledgerToolOpen !== this.toolOpen || this.ledgerErrOpen !== this.errOpen || this.ledgerStepsOpen !== this.stepsOpen) {
			this.ledgerWidth = width;
			this.ledgerThinkOpen = this.thinkOpen;
			this.ledgerToolOpen = this.toolOpen;
			this.ledgerErrOpen = this.errOpen;
			this.ledgerStepsOpen = this.stepsOpen;
			this.counts = [];
		}
		if (this.counts.length > this.lines.length) this.counts.length = this.lines.length; // T9 展开态 splice 缩短——账本随缩（键失配路径已整清，此处兜同帧多次操作）
		const roster = this.agentProvider?.() ?? [];
		for (let i = 0; i < this.counts.length; i++) {
			if (this.counts[i] === -1) this.counts[i] = this.renderEntry(this.lines[i]!, width, roster).length;
		}
		while (this.counts.length < this.lines.length) {
			this.counts.push(this.renderEntry(this.lines[this.counts.length]!, width, roster).length);
		}
	}

	/** 显式全量重折（D8 定案）：宽度变化时由 fullapp 调用——保留窗内条目按新宽重折、
	 *  账本与缓存整体换宽，几何从此恒精确（无双态、无跳顶解锁）。 */
	refoldAll(width: number): void {
		this.ledgerWidth = -1;
		this.counts = [];
		this.reconcile(width);
	}

	/** 条目原位变更标脏（toolResult 挂上/TOOL_MERGE 改行）——计数先于下次渲染精确化。 */
	private markCountDirty(i: number): void {
		if (i < this.counts.length) this.counts[i] = -1;
	}

	/** 活动块尾段（帧尾动态段，不入账本——每帧现算一次，行数与内容同源）。 */
	private activeTail(width: number): string[] {
		const out: string[] = [];
		// 转述活动块（A 案）置前：转述发生在 turn 开始前，主流区此时空闲——视觉上紧跟 ◐ 行
		if (this.visionThinkText !== "") {
			const raw = this.visionLive.feed(this.visionThinkText, Math.max(8, width - 2));
			out.push(theme.dim("[视觉模型思考]"), ...raw.slice(-2).map((l) => theme.dim("  " + l))); // 尾两行流动（主思考收起态同款）
		}
		if (this.visionBodyText !== "") out.push(...wrapText(this.visionBodyText, Math.max(8, width - 2)).map((l) => theme.fg("muted", `  ${l}`)));
		if (this.thinkText !== "") out.push(...this.styleWrappedThink(this.thinkLive.feed(this.thinkText, Math.max(8, width - 2)), this.thinkOpen));
		if (this.mdText !== "") out.push(...this.mdRender(this.mdText, width));
		return out;
	}

	/** 总行数（定格账本求和 + group 现算 + 活动块尾段）——O(条目数) 纯加法，不物化行。 */
	totalLines(width: number): number {
		this.claimAgents();
		this.reconcile(width);
		const roster = this.agentProvider?.() ?? [];
		let total = this.activeTail(width).length;
		for (let i = 0; i < this.lines.length; i++) {
			const e = this.lines[i]!;
			if (e.k === "group") total += this.renderEntry(e, width, roster).length; // 活体行现算
			else total += Math.max(0, this.counts[i]!);
		}
		return total;
	}

	/** 视口窗口（m5-render-perf T4 热点 (b) 存储侧）：第 startLine 行起最多 maxLines 行——
	 *  从尾部往头部走账本累加定位（尾部是热区，跟随模式只碰尾部），只物化窗口覆盖到的条目，
	 *  窗口外条目一个都不碰（group 活体行例外：行数随心跳变，定位期须现算——kimi 同限）。
	 *  返回与 frameLines 同源的行切片（含活动块尾段）。 */
	frameWindow(width: number, startLine: number, maxLines: number): string[] {
		this.claimAgents();
		this.reconcile(width);
		const roster = this.agentProvider?.() ?? [];
		const tail = this.activeTail(width);
		// 总行数（group 现算行数缓存共用——定位与输出一次）
		const groupLines = new Map<number, string[]>();
		let total = tail.length;
		for (let i = 0; i < this.lines.length; i++) {
			const e = this.lines[i]!;
			if (e.k === "group") {
				const gl = this.renderEntry(e, width, roster);
				groupLines.set(i, gl);
				total += gl.length;
			} else total += Math.max(0, this.counts[i]!);
		}
		const start = Math.max(0, Math.min(startLine, Math.max(0, total)));
		if (start >= total || maxLines <= 0) return [];
		const end = Math.min(total, start + maxLines);
		// 逆序收集：尾段先，定格条目从后往前直到覆盖 start（跟随模式 start ≈ total-视口 → 段数少；
		// 滚到顶 = 一次性全量拼装，渲染缓存命中为引用操作）
		const segs: string[][] = [];
		let lo = total;
		if (lo > start && tail.length > 0) {
			segs.push(tail);
			lo -= tail.length;
		}
		for (let i = this.lines.length - 1; i >= 0 && lo > start; i--) {
			const e = this.lines[i]!;
			if (e.k === "group") {
				const gl = groupLines.get(i)!;
				segs.push(gl);
				lo -= gl.length;
				continue;
			}
			const n = Math.max(0, this.counts[i]!);
			if (n > 0) segs.push(this.renderEntry(e, width, roster));
			lo -= n;
		}
		let all: string[] = [];
		for (let k = segs.length - 1; k >= 0; k--) all = all.concat(segs[k]!); // [lo, total) 的行
		// 远区缓存淘汰（T7 设计空白 #8——节流档）：距视口所在轮 > 3 轮的条目丢渲染缓存（源与计数保留）
		if (this.turnWindowEnabled && Date.now() - this.lastEvictAt >= 1000) {
			this.lastEvictAt = Date.now();
			this.evictFarCaches(start);
		}
		return all.slice(start - lo, start - lo + (end - start));
	}

	/** 当前完整行源（定格条目 + 活动块）——按调用方当前宽度渲染：宽度变化即回流（F5 十一轮）。
	 *  T4 起为兼容包装（D10：/tasks 等一次性消费面保留全量 API），内部走窗口路径拼满。 */
	frameLines(width: number): string[] {
		return this.frameWindow(width, 0, Number.MAX_SAFE_INTEGER);
	}
}
