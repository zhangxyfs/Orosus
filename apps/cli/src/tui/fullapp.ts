/** 全屏应用（TUI 批阶段三 F3–F5——原型完整交互面落地；v1.1–v1.11 走查拍板口径）。
 *  布局：无标题栏 + 左栏（stream 滚动区 + 输入框带框多行 ≤5 行超出上滚）+ 右栏双面板
 *  （运行状态/任务清单，真实数据经 io.panelData）+ 末列整列留白（conhost DECAWM 防御）。
 *  交互：Tab 焦点循环（聚焦面板青玉框；面板聚焦裸键直控〔2026-09-24 拍板，不再借道 Shift〕：←→ 翻页 / PgUp·PgDn 模块·任务翻页 / ↑↓ 选择 / Enter 挂卸）/
 *  Shift+Tab 权限循环 / Esc 忙碌时双击停生成（单击 toast 提示防误触）、闲时返回输入 /
 *  斜杠菜单全宽浮层（每页 10 条窗口跟随/「还有 N 项」/二级列表 ✓ 当前值/空过滤占位不关窗/长说明）/
 *  输入多行 ≤5 + Alt+Enter 换行 + Ctrl+A 全选 + Shift+←→ 选择 + bracketed paste / Alt+E 思考折叠 / Alt+O 工具明细折叠 / Alt+F 失败体折叠。
 *  Ctrl+C 全屏期不占用（2026-09-23 用户拍板——WT 原生复制让位；退出走 /quit，停生成走双击 Esc）。
 *  崩溃恢复（spike 判据 4）：exit 钩子同步直写恢复序列 + uncaughtException 先恢复再抛。
 *  鼠标接管关闭（用户拍板 2026-09-21——重开 = fullscreen.ts ENTER_ALT 追加 ?1000/?1006）。 */

import { writeSync } from "node:fs";
import { Term, type TermIO } from "./terminal.ts";
import { matchKey, isPrintable } from "./keymatch.ts";
import { FullScreen, type OverlayFrame } from "./fullscreen.ts";
import { FrameScheduler } from "./scheduler.ts";
import { padToWidth, truncateToWidth, visibleWidth, wrapText } from "./width.ts";
import { OnboardingSession, type OnboardingDeps, type OnboardingOutcome } from "./onboarding.ts";
import type { DiagEntry } from "../module-diagnostics.ts";
import * as theme from "../theme.ts";

// ---------- 接缝类型 ----------

export interface PanelData {
	model: string;
	session: string;
	cwd: string;
	tokens: { input: number; output: number; postCompaction?: boolean }; // 末条 usage 分拆（F5 二轮⑤：↑ 输入 · ↓ 输出）；postCompaction = 末条压缩晚于末条 usage，input 为压缩后投影估算（v3：压缩的数字回落不得滞后到下一条消息）
	startedAt: string | undefined; // 会话首事件 ts（F5 二轮④：运行时间行数据源）
	contextWindow: number;
	modules: { name: string; desc: string; state: "mounted" | "loading" | "off"; locked?: boolean; lockedReason?: string }[]; // locked = 不可热插拔（2026-09-23 用户拍板：名后灰「· 锁定」，回车 toast 锁因）；其余回车实时插拔（宿主写 enabled + reload）
	tasks: { text: string; state: "done" | "active" | "pending" }[];
	permission: string; // 当前权限模式原文（ask-always/ask-risky/never）
	permissionNext(): string; // Shift+Tab 循环的下一档命令（如 "/permission ask-always"）
}

export interface SlashItem {
	name: string;
	desc: string;
	long: string;
	children?: string[]; // 有二级列表的命令（当前值 ✓ 标记——当前值由 io.slashCurrent 提供）
	aliases?: string[]; // 别名（F5 十六轮①：过滤/展示用——路由层早已直达，菜单按别名可筛出真实命令）
	childMeta?: Record<string, { label: string; desc: string; long: string }>; // 二级项元数据（F5 十轮⑤：档名/短解/详释）
}

export interface FullAppIO {
	columns(): number;
	rows(): number;
	doc(): string[];
	submit(text: string): void;
	/** 提交闸门（批④——busy 期拒收档拦在回车前）：返回拒因 = 拦截（输入保留、不进历史、不写流区，
	 *  拒因尾行瞬显自消）；undefined = 放行。宿主侧复用 inflight + 拒收名单单一数据源。 */
	submitGate?(text: string): string | undefined;
	requestExit(): void;
	requestCancel(): void; // Esc 忙碌时取消当前 turn（h.cancel）
	panelData(): PanelData;
	slashCommands(): SlashItem[];
	slashCurrent(cmd: string): string; // 二级列表当前值（/permission → 当前模式）
	thinkOpen(): boolean;
	toggleThink(): void;
	/** Alt + O 工具明细折叠切换（2026-09-23 走查批——Edit/Write diff 展开/收起）。 */
	toggleTool(): void;
	/** Alt + F 工具失败体折叠切换（二轮走查拍板：错误默认全收起，与 diff 分键）。 */
	toggleErr(): void;
	/** Alt + V 粘贴剪贴板图片（2026-09-23 修订——宿主侧 pasteImage 完成后经 insertAtCursor 把
	 *  chip token 插入输入框光标位，删除键可删 = 撤销挂图）。 */
	requestPasteImage?(): void;
	/** 消息队列（2026-09-23 队列批——kimi QueuePane 同族）：busy 期排队的消息列表（输入框上方逐条显示）。 */
	queueItems(): string[];
	/** ↑ 召回队尾（LIFO——kimi recallLastQueued 同语义）；空队列 → undefined。 */
	recallQueued(): string | undefined;
	/** Ctrl+U = steer（kimi Ctrl-S 改键位——Ctrl+S 是终端流控 XOFF 冲突回避）：排队消息 + 当前草稿
	 *  注入进行中的 turn；命令类（/ 开头）不可 steer 由宿主留队；无进行中 turn 时宿主直接提交。 */
	requestSteer(texts: string[]): void;
	/** 侧栏初始可见性（F5 十二轮②：[tui] sidebar 持久化读数；缺省可见）。 */
	sidebarInit?(): boolean;
	/** 侧栏开关变更（F5 十二轮②：宿主持久化 [tui] sidebar）。 */
	onSidebarChange?(visible: boolean): void;
	/** Ctrl+O = 查看压缩摘要（2026-09-23 用户拍板：/summary 命令退役，摘要查看唯一入口）。
	 *  宿主读最近 turn/compaction 的 summary（overlay 文本灰色 muted 由宿主包裹）。 */
	showCompactionSummary?(): void;
	/** 模块卡回车 = 热插拔（2026-09-23 用户拍板）：锁定项宿主 toast 锁因；可插拔项宿主写
	 *  config 的 [模块名] enabled + h.reload()（面板随之刷新）。 */
	toggleModule?(name: string, lockedReason: string | undefined): void;
	/** 模块诊断弹窗数据源（T9——定案「打开时刷新」：每次开 Ctrl + E 现读，不缓存）。 */
	diagEntries?(): DiagEntry[];
}

type FocusIdx = 0 | 1 | 2;

interface AppState {
	input: string;
	cursor: number;
	inputScroll: number;
	selAnchor: number; // -1 = 无选择
	history: string[];
	historyIdx: number;
	/** 历史浏览草稿快照（2026-09-23 走查拍板，kimi navigateHistory 同口径——进入浏览那一刻暂存
	 *  当前输入，↓ 翻回最新位时原样恢复；编辑即退出浏览丢弃草稿——kimi exitHistoryBrowsing 同语义）。 */
	historyDraft: string | undefined;
	focusIdx: FocusIdx;
	moduleSel: number;
	taskSel: number;
	statePage: number;
	scrollBack: number;
	busy: boolean;
	/** /compact 执行期（2026-09-23 用户拍板 UI 形态）：busy spinner 切换为「上下文压缩中…」石青（info）色——
	 *  压缩是命令级动作，与 turn 生成的「正在生成…」区分。 */
	compacting: boolean;
	spinIdx: number;
	sidebarVisible: boolean; // 右侧面板栏开关（Ctrl+T——用户拍板）
	overlayOpen: boolean;
	overlaySel: number;
	overlayCmd: string; // "" = 一级
	diagOpen: boolean; // 模块诊断一级列表（T9——独立于斜杠菜单 overlay：语义不同，另起一支）
	diagSel: number;
	/** 浮动提示（2026-09-22 用户拍板）：输入框上边缘黄字、3s 自消——瞬时反馈的统一形式（闸门拒因/模型切换等），
	 *  取代批④的尾行拒因位（rejectHint）。 */
	toast: { text: string; at: number } | undefined;
}

const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INPUT_MAX_ROWS = 5;
const OVERLAY_PAGE = 10;
const DIAG_LIST_ROWS = 8; // 诊断一级列表恒定行数（原型 LIST_ROWS=8——不足留空防闪烁）
const MODULE_SLOTS = 5; // 模块挂载区每页行数（渲染与 PgUp/PgDn 翻页共用一源——两处漂移即页号错位）
const MOD_STATE_TEXT: Record<string, string> = { mounted: "已挂载", loading: "挂载中", off: "未挂载" };
const TASK_TICK: Record<string, string> = { done: theme.fg("accent", "✓"), active: theme.fg("warn", "◐"), pending: theme.fg("muted", "○") };
/** 运行时间格式化（F5 十轮② 用户拍板：精确到秒，随 1s 心跳实时跳）：
 *  <60s「N 秒」；<1 时「M 分 SS 秒」；<1 天「H 时 MM 分 SS 秒」；否则「D 天 H 时」。 */
export function elapsedText(startedAt: string | undefined, now: number = Date.now()): string {
	if (startedAt === undefined) return "—";
	const ms = Math.max(0, now - Date.parse(startedAt));
	if (Number.isNaN(ms)) return "—";
	const total = Math.floor(ms / 1000);
	const p2 = (n: number): string => String(n).padStart(2, "0");
	const sec = total % 60;
	const min = Math.floor(total / 60) % 60;
	const hr = Math.floor(total / 3600) % 24;
	const day = Math.floor(total / 86400);
	if (total < 60) return `${total} 秒`;
	if (total < 3600) return `${Math.floor(total / 60)} 分 ${p2(sec)} 秒`;
	if (total < 86400) return `${hr} 时 ${p2(min)} 分 ${p2(sec)} 秒`;
	return `${day} 天 ${hr} 时`;
}

/** 诊断一级列表行拼装（T9，原型一级）：❯ ● 模块名 [标签] 原因……… N 次 · HH:MM:SS。
 *  恒 DIAG_LIST_ROWS 行不足留空（防闪烁纪律）+ 末行余量提示合一行（斜杠菜单同款）；窗口尾随选中行。
 *  返回 lines 长 DIAG_LIST_ROWS + 1（余量行——空时留空占位，条件性增删行即闪烁源）。 */
export function diagListLines(entries: readonly DiagEntry[], sel: number, innerW: number): { lines: string[]; selRow: number } {
	const wstart = sel <= DIAG_LIST_ROWS - 1 ? 0 : sel - (DIAG_LIST_ROWS - 1);
	const lines: string[] = [];
	for (let i = 0; i < DIAG_LIST_ROWS; i++) {
		const idx = wstart + i;
		const e = entries[idx];
		if (e === undefined) {
			lines.push("");
			continue;
		}
		const mark = idx === sel ? theme.fg("accent", "❯") : " ";
		const head = ` ${mark} ${theme.fg("err", "●")} ${e.name} ${theme.fg("info", e.tag)} `;
		const time = e.last.slice(11, 19); // ISO 时分秒（与日志同口径）
		const right = `${e.count} 次 · ${time}`;
		const headW = visibleWidth(stripAnsiOf(head));
		const reasonW = innerW - headW - right.length - 2;
		const reason = reasonW >= 3 ? truncateToWidth(e.reason, reasonW) : "";
		const pad = Math.max(1, innerW - headW - right.length - visibleWidth(reason));
		lines.push(`${head}${theme.dim(reason)}${" ".repeat(pad)}${theme.dim(right)}`);
	}
	const restUp = wstart;
	const restDown = entries.length - wstart - DIAG_LIST_ROWS;
	const hints = [restUp > 0 ? `↑ 还有 ${restUp}` : "", restDown > 0 ? `↓ 还有 ${restDown}` : ""].filter(Boolean).join(" · ");
	lines.push(hints === "" ? "" : theme.dim(`   ${hints}`));
	return { lines, selRow: sel - wstart };
}

/** stripAnsi 就地别名（width.ts 未导出该函数——此处只为计宽）。 */
const stripAnsiOf = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const PERM_LABEL: Record<string, string> = { "ask-always": "Always Ask", "ask-risky": "Ask When Needed", never: "Never Ask" }; // 英文档名（F5 十轮⑤ 用户拍板）

// ---------- 输入区多行布局（≤5 行，超出上滚——原型同款） ----------

interface InputRow {
	text: string;
	srcStart: number;
	srcEnd: number;
}

function cpw(ch: string): number {
	const cp = ch.codePointAt(0)!;
	return cp >= 0x2e80 || cp >= 0x20000 || (cp >= 0x1f000 && cp <= 0x1faff) ? 2 : 1;
}

function layoutInputRows(input: string, w: number): InputRow[] {
	const rows: InputRow[] = [];
	let base = 0;
	for (const logical of input.split("\n")) {
		const lineStart = base;
		base += logical.length + 1;
		if (logical.length === 0) {
			rows.push({ text: "", srcStart: lineStart, srcEnd: lineStart });
			continue;
		}
		let j = 0;
		while (j < logical.length) {
			let tw = 0;
			let k = j;
			while (k < logical.length) {
				const cp = logical.codePointAt(k)!;
				const gw = cpw(String.fromCodePoint(cp));
				if (tw + gw > w && tw > 0) break;
				tw += gw;
				k += cp > 0xffff ? 2 : 1;
			}
			rows.push({ text: logical.slice(j, k), srcStart: lineStart + j, srcEnd: lineStart + k });
			j = k;
		}
	}
	return rows.length > 0 ? rows : [{ text: "", srcStart: 0, srcEnd: 0 }];
}

function locateCursor(rows: InputRow[], cursor: number): { row: number; col: number } {
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i]!;
		if (cursor >= r.srcStart && cursor < r.srcEnd) {
			return { row: i, col: visibleWidth(r.text.slice(0, cursor - r.srcStart)) };
		}
		if (cursor === r.srcEnd && i === rows.length - 1) {
			return { row: i, col: visibleWidth(r.text) };
		}
	}
	return { row: 0, col: 0 };
}

function indexAtRowCol(rows: InputRow[], row: number, targetCol: number): number {
	const r = rows[Math.max(0, Math.min(rows.length - 1, row))]!;
	let w = 0;
	let i = r.srcStart;
	while (i < r.srcEnd) {
		const cp = r.text.codePointAt(i - r.srcStart)!;
		const gw = cpw(String.fromCodePoint(cp));
		if (w + gw > targetCol) break;
		w += gw;
		i += cp > 0xffff ? 2 : 1;
	}
	return i;
}

/** 命令归一化（core harness.ts:503-505 同口径：前导空白抹除 + 斜杠后空格抹除 + 连续空白折叠）。 */
function normCmd(text: string): string {
	return text.trim().replace(/^\/\s+/, "/").replace(/\s+/g, " ");
}

export class FullApp {
	private io: FullAppIO;
	private term: Term;
	private full: FullScreen;
	private scheduler: FrameScheduler;
	private state: AppState;
	private busyTimer: NodeJS.Timeout | undefined;
	private watchdogTimer: NodeJS.Timeout | undefined;
	private tickTimer: NodeJS.Timeout | undefined;
	private stopped = false;

	constructor(io: FullAppIO, termIo?: TermIO) {
		this.io = io;
		if (termIo !== undefined) {
			this.term = new Term(termIo);
		} else {
			this.term = new Term();
		}
		this.full = new FullScreen((d) => this.term.write(d));
		this.scheduler = new FrameScheduler(() => this.renderFrame());
		this.state = {
			input: "",
			cursor: 0,
			inputScroll: 0,
			selAnchor: -1,
			history: [],
			historyIdx: 0,
			historyDraft: undefined,
			focusIdx: 0,
			moduleSel: 0,
			taskSel: 0,
			statePage: 0,
			scrollBack: 0,
			busy: false,
			compacting: false,
			spinIdx: 0,
			sidebarVisible: io.sidebarInit?.() ?? true,
			overlayOpen: false,
			overlaySel: 0,
			overlayCmd: "",
			diagOpen: false,
			diagSel: 0,
			toast: undefined,
		};
	}

	/** 测试探针。 */
	get stateRef(): AppState {
		return this.state;
	}

	/** 流区可用宽（左栏内容宽——doc 折行口径，F5 三轮②③：宿主按此宽喂 DocModel）。 */
	get streamCols(): number {
		// 侧栏隐藏 = 左栏占满（与 renderFrame 同口径——F5 十二轮①：此前不看可见性，
		// 隐藏后 dm 仍按窄宽渲染 = 「回流没修好」的真根因）
		// 再收 2 列 = 右内衬（2026-09-23 用户拍板：左垫 2 列后右端顶分隔线错位——两端各留 2 列对称；
		// docmodel 内部再 −2 折行，正文实际占 leftW − 4）
		const sidebarW = this.state.sidebarVisible ? this.sidebarW() : 0;
		return Math.max(8, this.io.columns() - sidebarW - 4);
	}

	/** 忙碌探针（F5 四轮：宿主排队判定用）。 */
	get isBusy(): boolean {
		return this.state.busy;
	}

	start(): void {
		this.full.enter();
		this.term.start();
		// WT alt-buffer 滚轮自滚防御（图3 用户实测：滚轮后输入区消失、Tab 切换恢复——
		// 终端侧滚屏使 FullScreen 簿记与真实屏脱节；2s 看门狗强制全帧重绘兜底）
		this.watchdogTimer = setInterval(() => this.full.reset(), 2000);
		this.watchdogTimer.unref?.();
		// 1s 心跳重绘（F5 九轮⑤：运行时间等时钟性行实时——diff 后只动变化行）
		this.tickTimer = setInterval(() => this.scheduler.requestRender(), 1000);
		this.tickTimer.unref?.();
		this.term.onInput((seq) => this.onKey(matchKey(seq)));
		this.term.onPaste((text) => {
			// 引导期粘贴路由给会话（API Key 的首要输入方式就是粘贴——SW-23 静默盲输的进稿口）
			if (this.onboarding !== undefined) {
				this.onboarding.session.handlePaste(text);
				this.scheduler.requestImmediateRender();
				return;
			}
			this.inputInsert(text);
			this.afterEdit();
		});
		this.term.onResize(() => this.scheduler.requestRender());
		this.scheduler.requestRender();
		this.installCrashHooks();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		// 引导弹窗随应用停止结算（promise 不永挂——同 pendingUi 纪律）
		if (this.onboarding !== undefined) {
			const ob = this.onboarding;
			this.onboarding = undefined;
			ob.resolve({ kind: "quit" });
		}
		// 挂起的模块询问随应用停止结算为「取消」（F5：Ctrl+T/C 中途离场时 promise 不得永挂——
		// 否则模块命令侧永远等不到回答）
		if (this.pendingUi !== undefined) {
			const pu = this.pendingUi;
			this.pendingUi = undefined;
			if (pu.kind !== "view") pu.resolve(undefined); // view 无 promise 可结
		}
		// 暂存队列一并排空（批③②——thunk 内自查 stopped 即 resolve(undefined)，promise 不永挂）
		for (const run of this.uiQueue.splice(0)) run();
		if (this.busyTimer) clearInterval(this.busyTimer);
		if (this.watchdogTimer) clearInterval(this.watchdogTimer);
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.scheduler.stop();
		if (this.full.isActive) this.full.exit();
		this.term.stop();
		if (FullApp.activeInstance === this) FullApp.activeInstance = undefined;
	}

	setBusy(b: boolean): void {
		const s = this.state;
		if (s.busy === b) return;
		s.busy = b;
		if (!b) s.compacting = false; // 压缩期随 busy 退出复位（兜底——exit() 正常路径已清）
		if (b) {
			this.busyTimer = setInterval(() => {
				s.spinIdx = (s.spinIdx + 1) % SPIN_FRAMES.length;
				this.scheduler.requestRender();
			}, 100);
			this.busyTimer.unref?.();
		} else if (this.busyTimer) {
			clearInterval(this.busyTimer);
			this.busyTimer = undefined;
		}
		this.scheduler.requestRender();
	}

	/** /compact 执行期标志（2026-09-23 用户拍板）：置位时 busy spinner 切「上下文压缩中…」石青（info）色。 */
	setCompacting(b: boolean): void {
		if (this.state.compacting === b) return;
		this.state.compacting = b;
		this.scheduler.requestRender();
	}

	// ---------- 全屏 CommandUi 适配面（choose → overlay 选择器；ask/askSecret → 输入行询问） ----------

	private pendingUi:
		| { kind: "pick"; title: string; items: string[]; sel: number; resolve: (n: number | undefined) => void; filter?: string }
		| { kind: "ask"; question: string; secret: boolean; resolve: (v: string | undefined) => void }
		| { kind: "view"; title: string; lines: string[]; scroll: number }
		| undefined;

	/** 挂起交互的 FIFO 暂存队列（批③② 审批互斥）：pendingUi 单槽占用期新到的 choose/ask 不再顶退——
	 *  顶退会把挂起的审批 resolve(undefined) = 静默否决；暂存后当前挂起结算即自动展开。 */
	private uiQueue: Array<() => void> = [];

	/** 当前挂起结算后提升队首（无挂起才提——视图/选择/询问任一在位都等待）。 */
	private promoteUi(): void {
		if (this.pendingUi !== undefined) return;
		this.uiQueue.shift()?.();
	}

	/** 只读文本浮层（F5 二轮⑪——/help 形态：不可选择、↑↓/PgUp/PgDn 翻页、Esc/Enter/q 关闭）。 */
	viewText(title: string, text: string): void {
		this.state.overlayOpen = false; // 与斜杠菜单互斥
		this.pendingUi = { kind: "view", title, lines: text.split("\n"), scroll: 0 };
		this.scheduler.requestImmediateRender();
	}

	// ---------- 首次使用引导弹窗（M4-3 T1d，D10——三页定高锁焦点；施工基准 onboarding 原型） ----------

	/** 引导弹窗占用槽：在槽期一切按键/粘贴路由给会话（焦点锁——pendingUi/编辑态全部让位）。 */
	private onboarding: { session: OnboardingSession; resolve: (o: OnboardingOutcome) => void } | undefined;

	/** 打开引导弹窗（完成/退出即 resolve；宿主在完成态 reload 生效 + toast 留痕）。
	 *  requestRender 强制接自家帧调度（异步模型清单到达即重绘——宿主传的任何件都被覆盖）。 */
	runOnboarding(deps: OnboardingDeps, initial?: { configured?: string[]; active?: string | null }): Promise<OnboardingOutcome> {
		return new Promise((resolve) => {
			this.onboarding = {
				session: new OnboardingSession({ ...deps, requestRender: () => this.scheduler.requestRender() }, initial),
				resolve,
			};
			this.scheduler.requestImmediateRender();
		});
	}

	/** 浮动提示（2026-09-22 用户拍板）：输入框上边缘黄字、3s 自消。自消靠定时器补一帧——
	 *  非 busy 期没有 spinner 心跳，不定时的話旧 toast 会留到下一次按键。 */
	showToast(text: string): void {
		this.state.toast = { text, at: Date.now() };
		this.scheduler.requestImmediateRender();
		const timer = setTimeout(() => {
			if (this.state.toast !== undefined && Date.now() - this.state.toast.at >= 2_900) {
				this.state.toast = undefined;
				this.scheduler.requestRender();
			}
		}, 3_100);
		timer.unref?.();
	}

	/** 文本插入输入框光标位（2026-09-23 走查拍板——图片 chip [image #N (宽×高)] 从独立 chip 行
	 *  改为文内 token：光标处插入、删除键可删 = 撤销挂图）。 */
	insertAtCursor(text: string): void {
		const s = this.state;
		this.exitHistoryBrowse(); // 贴图 = 编辑（kimi exitHistoryBrowsing 同语义）
		s.input = s.input.slice(0, s.cursor) + text + s.input.slice(s.cursor);
		s.cursor += text.length; // chip 为 ASCII+×（BMP）——码元步进安全
		s.selAnchor = -1;
		this.afterEdit();
	}

	/** 提交被拒（如非 vision 模型拦截）时恢复输入原文（含图片 chip token——挂图不丢）。 */
	restoreInput(text: string): void {
		const s = this.state;
		s.input = text;
		s.cursor = text.length;
		s.selAnchor = -1;
		this.afterEdit();
	}

	/** 输入历史播种（2026-09-23 实测：/sessions 恢复后 FullApp 随会话重建、输入历史清零——
	 *  ↑ 无历史可召回前案）：宿主从会话事件取用户消息文本灌入（kimi 按 cwd 持久化历史的同族口径），
	 *  帽 100 条（kimi 同值）。 */
	seedHistory(items: string[]): void {
		const s = this.state;
		s.history = items.slice(-100);
		s.historyIdx = s.history.length;
		s.historyDraft = undefined;
	}

	/** choose 的全屏形态：overlay 列表选择（Esc → undefined——宿主侧转「已取消（Esc）」，机制③同族）。
	 *  单槽占用期 FIFO 暂存（批③②——不再顶退挂起者）。 */
	pickOverlay(title: string, items: string[]): Promise<number | undefined> {
		if (this.pendingUi !== undefined) {
			return new Promise((resolve) => this.uiQueue.push(() => {
				if (this.stopped) { resolve(undefined); return; }
				void this.pickOverlay(title, items).then(resolve);
			}));
		}
		this.state.overlayOpen = false; // 与斜杠菜单互斥
		return new Promise((resolve) => {
			// ≥12 项启用输入过滤（F5 九轮① 用户拍板：厂商目录全量直列、列表内输入即筛——includes 口径）
			this.pendingUi = {
				kind: "pick",
				title,
				items,
				sel: 0,
				resolve,
				...(items.length >= 12 ? { filter: "" } : {}),
			};
			this.scheduler.requestImmediateRender();
		});
	}

	/** ask/askSecret 的全屏形态：输入行接管（提示语进输入框前缀；secret 盲显 •；Esc → undefined）。
	 *  单槽占用期 FIFO 暂存（同 pickOverlay——批③②）。 */
	promptInput(question: string, secret: boolean): Promise<string | undefined> {
		if (this.pendingUi !== undefined) {
			return new Promise((resolve) => this.uiQueue.push(() => {
				if (this.stopped) { resolve(undefined); return; }
				void this.promptInput(question, secret).then(resolve);
			}));
		}
		const prev = { input: this.state.input, cursor: this.state.cursor };
		this.state.input = "";
		this.state.cursor = 0;
		return new Promise((resolve) => {
			this.pendingUi = {
				kind: "ask",
				question,
				secret,
				resolve: (v) => {
					if (v === undefined) {
						this.state.input = prev.input;
						this.state.cursor = prev.cursor;
					}
					resolve(v);
				},
			};
			this.scheduler.requestImmediateRender();
		});
	}

	// ---------- 选择与编辑 ----------

	private selRange(): { lo: number; hi: number } | undefined {
		const s = this.state;
		if (s.selAnchor < 0 || s.selAnchor === s.cursor) return undefined;
		return { lo: Math.min(s.selAnchor, s.cursor), hi: Math.max(s.selAnchor, s.cursor) };
	}

	private deleteSelection(): boolean {
		const s = this.state;
		const r = this.selRange();
		if (!r) return false;
		s.input = s.input.slice(0, r.lo) + s.input.slice(r.hi);
		s.cursor = r.lo;
		s.selAnchor = -1;
		return true;
	}

	/** 编辑即退出历史浏览（kimi exitHistoryBrowsing——浏览中改动的是召回条目本身，草稿快照作废）。 */
	private exitHistoryBrowse(): void {
		const s = this.state;
		s.historyIdx = s.history.length;
		s.historyDraft = undefined;
	}

	private inputInsert(text: string): void {
		const s = this.state;
		this.exitHistoryBrowse(); // 编辑即退出历史浏览、丢弃草稿快照（kimi exitHistoryBrowsing 同语义）
		const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		this.deleteSelection();
		s.input = s.input.slice(0, s.cursor) + norm + s.input.slice(s.cursor);
		s.cursor += norm.length;
	}

	private moveCursor(dir: -1 | 1, extend: boolean): void {
		const s = this.state;
		if (extend && s.selAnchor < 0) s.selAnchor = s.cursor;
		if (!extend) {
			const r = this.selRange();
			if (r) {
				s.cursor = dir === -1 ? r.lo : r.hi;
				s.selAnchor = -1;
				return;
			}
		}
		if (dir === -1 && s.cursor > 0) {
			const prev = s.input.codePointAt(s.cursor - 1)!;
			s.cursor -= prev >= 0xdc00 && prev <= 0xdfff && s.cursor > 1 ? 2 : 1;
		} else if (dir === 1 && s.cursor < s.input.length) {
			const cp = s.input.codePointAt(s.cursor)!;
			s.cursor += cp > 0xffff ? 2 : 1;
		}
	}

	private afterEdit(): void {
		const s = this.state;
		const rows = layoutInputRows(s.input, this.inputInnerW());
		const cur = locateCursor(rows, s.cursor);
		if (cur.row < s.inputScroll) s.inputScroll = cur.row;
		if (cur.row >= s.inputScroll + INPUT_MAX_ROWS) s.inputScroll = cur.row - INPUT_MAX_ROWS + 1;
		this.scheduler.requestImmediateRender();
	}

	// ---------- 按键 ----------

	private lastEscCancel = 0; // 双击 Esc 停止生成窗口（2026-09-23 走查拍板——防误触，qwen-code 1s 同口径）

	private onKey(key: string): void {
		const s = this.state;
		// 引导弹窗焦点锁（M4-3 T1d）：在槽期一切按键归会话——pendingUi/编辑态/busy-Esc 全部让位
		if (this.onboarding !== undefined) {
			const outcome = this.onboarding.session.handleKey(key);
			if (outcome !== undefined) {
				const ob = this.onboarding;
				this.onboarding = undefined;
				ob.resolve(outcome);
			}
			this.scheduler.requestImmediateRender();
			return;
		}
		if (key === "ctrl+t") {
			s.sidebarVisible = !s.sidebarVisible; // 显示/隐藏右侧两个面板（用户拍板——比数据流互切有意义）
			if (!s.sidebarVisible) s.focusIdx = 0; // 面板隐藏——焦点回输入区
			this.io.onSidebarChange?.(s.sidebarVisible); // 持久化（F5 十二轮②）
			this.scheduler.requestImmediateRender();
			return;
		}
		if (key === "ctrl+e") {
			// 模块诊断弹窗总开关（T9/S6：全局拦截含输入框编辑态——与 Ctrl+T 同款；keymatch 0x05 无既有消费者）
			if (s.diagOpen) {
				s.diagOpen = false; // 再按 = 关（二级开着 = 全关，T10 的 viewText 返回标记侧消费）
			} else {
				const entries = this.io.diagEntries?.() ?? [];
				if (entries.length === 0) {
					this.showToast("模块全部正常——没有诊断记录"); // 空态不弹空窗（原型同款）
				} else {
					s.overlayOpen = false; // 与斜杠菜单互斥
					s.diagOpen = true;
					s.diagSel = 0; // 打开时刷新（定案）：entries 每开现读
				}
			}
			this.scheduler.requestImmediateRender();
			return;
		}
		if (key === "alt+e") {
			this.io.toggleThink();
			this.scheduler.requestImmediateRender();
			return;
		}
		if (key === "alt+o") {
			this.io.toggleTool();
			this.scheduler.requestImmediateRender();
			return;
		}
		if (key === "alt+f") {
			this.io.toggleErr();
			this.scheduler.requestImmediateRender();
			return;
		}
		if (key === "ctrl+u") {
			// Ctrl+U = steer（2026-09-23 队列批——kimi Ctrl-S 改键位，Ctrl+S 是终端 XOFF 流控）：
			// 排队消息 + 当前草稿一起注入/提交；输入框清空（宿主把不可 steer 项留队）
			const texts = [...this.io.queueItems(), ...(s.input.trim() !== "" ? [s.input] : [])];
			if (texts.length > 0) {
				s.input = "";
				s.cursor = 0;
				s.inputScroll = 0;
				s.selAnchor = -1;
				this.exitHistoryBrowse();
				this.io.requestSteer(texts);
			}
			this.scheduler.requestImmediateRender();
			return;
		}
		if (key === "alt+v") {
			this.io.requestPasteImage?.(); // F5 二轮⑬——全屏期 Alt+V 由 FullApp 接管（readline 侧已让位）
			return;
		}
		if (key === "ctrl+o") {
			// Ctrl+O = 查看压缩摘要（2026-09-23 用户拍板——/summary 命令退役，摘要查看唯一入口；
			// 无摘要时 toast 提示而非静默）
			this.io.showCompactionSummary?.();
			this.scheduler.requestImmediateRender();
			return;
		}

		// 全屏 CommandUi 挂起态（模块 choose/ask 的 overlay 化——优先于一切编辑态；
		// F5 实证：须先于 busy-Esc 判定，否则命令询问期间 Esc 被取消 turn 分支截胡、询问卡死）
		if (this.pendingUi !== undefined) {
			const pu = this.pendingUi;
			if (pu.kind === "view") {
				const page = Math.max(3, this.io.rows() - 12);
				if (key === "up") pu.scroll = Math.max(0, pu.scroll - 1);
				else if (key === "down") pu.scroll = Math.min(Math.max(0, pu.lines.length - page), pu.scroll + 1);
				else if (key === "pageUp") pu.scroll = Math.max(0, pu.scroll - page);
				else if (key === "pageDown") pu.scroll = Math.min(Math.max(0, pu.lines.length - page), pu.scroll + page);
				else if (key === "escape" || key === "enter" || key === "q") { this.pendingUi = undefined; this.promoteUi(); }
				this.scheduler.requestImmediateRender();
				return;
			}
			if (pu.kind === "pick") {
				// 过滤列表（F5 九轮①）：可打印/退格编辑过滤串——子串匹配 includes（非 startsWith）
				const filtered = pu.filter === undefined ? pu.items : pu.items.filter((i) => i.toLowerCase().includes(pu.filter!.toLowerCase()));
				if (pu.filter !== undefined && key.length === 1 && isPrintable(key)) { // 单字符才入过滤——键名串（backspace 等）不得混入
					pu.filter += key;
					pu.sel = 0;
					this.scheduler.requestImmediateRender();
					return;
				}
				if (pu.filter !== undefined && pu.filter !== "" && key === "backspace") {
					pu.filter = pu.filter.slice(0, -1);
					pu.sel = 0;
					this.scheduler.requestImmediateRender();
					return;
				}
				if (key === "up" && filtered.length > 0) pu.sel = (pu.sel - 1 + filtered.length) % filtered.length;
				else if (key === "down" && filtered.length > 0) pu.sel = (pu.sel + 1) % filtered.length;
				else if (key === "pageUp" && filtered.length > 0) pu.sel = Math.max(0, pu.sel - OVERLAY_PAGE);
				else if (key === "pageDown" && filtered.length > 0) pu.sel = Math.min(filtered.length - 1, pu.sel + OVERLAY_PAGE);
				else if (key === "enter" && filtered.length > 0) {
					this.pendingUi = undefined;
					pu.resolve(pu.items.indexOf(filtered[pu.sel]!));
					this.promoteUi(); // 结算即提升暂存队首（批③②）
				} else if (key === "escape") {
					this.pendingUi = undefined;
					pu.resolve(undefined);
					this.promoteUi();
				}
				this.scheduler.requestImmediateRender();
				return;
			}
			// ask/askSecret：复用编辑器键，Enter 结算、Esc 取消
			if (key === "enter") {
				const v = this.state.input;
				this.pendingUi = undefined;
				this.state.input = "";
				this.state.cursor = 0;
				pu.resolve(v);
				this.promoteUi();
			} else if (key === "escape") {
				this.pendingUi = undefined;
				pu.resolve(undefined);
				this.promoteUi();
			} else {
				this.onEditKey(key);
				return;
			}
			this.scheduler.requestImmediateRender();
			return;
		}

		// 诊断一级列表态（T9）：弹窗焦点锁——↑↓ 选择（边界夹紧）、Enter 进二级（T10）、Esc 关；
		// 其余键吞掉不落编辑态。先于 busy-Esc：弹窗开着时 Esc 关弹窗、不触发「再按停止生成」
		if (s.diagOpen) {
			const entries = this.io.diagEntries?.() ?? [];
			if (key === "up") s.diagSel = Math.max(0, s.diagSel - 1);
			else if (key === "down") s.diagSel = Math.min(Math.max(0, entries.length - 1), s.diagSel + 1);
			else if (key === "escape") s.diagOpen = false;
			else if (key === "enter") {
				// 二级详情（T10 接线）：本期占位——选中行即目标
			}
			this.scheduler.requestImmediateRender();
			return;
		}

		if (key === "escape") {
			if (s.busy) {
				// 双击 Esc 才停止生成（2026-09-23 走查拍板——单击误触痛点；qwen-code 双击窗口
				// CTRL_EXIT_PROMPT_DURATION_MS=1000ms 同口径，比 claude-code 的 2s 短）：
				// 首按 toast 提示，1s 内再按才真正取消；窗口外再按重新计首按
				if (Date.now() - this.lastEscCancel < 1000) {
					this.lastEscCancel = 0;
					s.toast = undefined; // 二次确认即消提示（走查拍板——toast 留着会误解为「还没停」）
					this.io.requestCancel();
				} else {
					this.lastEscCancel = Date.now();
					this.showToast("再按一次 Esc 停止生成");
				}
				this.scheduler.requestImmediateRender();
				return;
			}
			this.lastEscCancel = 0;
			if (s.overlayOpen) {
				if (s.overlayCmd !== "") {
					s.overlayCmd = "";
					s.input = "/";
					s.cursor = 1;
					s.overlaySel = 0;
				} else s.overlayOpen = false;
				this.scheduler.requestImmediateRender();
				return;
			}
			s.focusIdx = 0;
			this.scheduler.requestImmediateRender();
			return;
		}

		// 斜杠菜单 overlay 态
		if (s.overlayOpen) {
			this.onOverlayKey(key);
			return;
		}

		if (key === "tab") {
			if (s.sidebarVisible) s.focusIdx = ((s.focusIdx + 1) % 3) as FocusIdx; // 面板隐藏时焦点恒输入区
		} else if (key === "shift+tab") {
			this.io.submit(this.io.panelData().permissionNext());
			return;
		} else if (key === "pageUp" || key === "pageDown") {
			// 面板聚焦时归面板（2026-09-24 拍板——翻页不再借道 Shift）：运行状态=模块翻页、任务清单=任务翻页，
			// 未聚焦才滚对话流；故此分支必须整体先于下方焦点分支
			if (s.focusIdx === 1) {
				const mods = this.io.panelData().modules;
				s.moduleSel = Math.max(0, Math.min(mods.length - 1, s.moduleSel + (key === "pageUp" ? -MODULE_SLOTS : MODULE_SLOTS)));
			} else if (s.focusIdx === 2) {
				const tasks = this.io.panelData().tasks;
				const slots = this.taskPageSlots();
				s.taskSel = Math.max(0, Math.min(tasks.length - 1, s.taskSel + (key === "pageUp" ? -slots : slots)));
			} else if (key === "pageUp") {
				s.scrollBack += Math.max(1, this.io.rows() - 10);
			} else {
				s.scrollBack = Math.max(0, s.scrollBack - Math.max(1, this.io.rows() - 10));
			}
		} else if (s.focusIdx === 1) {
			const mods = this.io.panelData().modules;
			if (key === "up" || key === "down") {
				s.moduleSel = Math.max(0, Math.min(mods.length - 1, s.moduleSel + (key === "up" ? -1 : 1)));
			} else if (key === "left" || key === "right") {
				s.statePage = s.statePage === 0 ? 1 : 0;
			} else if (key === "enter") {
				// 模块热插拔（2026-09-23 用户拍板）：锁定项 toast 锁因；可插拔项宿主写 enabled + reload
				const m = mods[s.moduleSel];
				if (m !== undefined) this.io.toggleModule?.(m.name, m.locked === true ? (m.lockedReason ?? "锁定") : undefined);
			}
		} else if (s.focusIdx === 2) {
			const tasks = this.io.panelData().tasks;
			if (key === "up" || key === "down") {
				s.taskSel = Math.max(0, Math.min(tasks.length - 1, s.taskSel + (key === "up" ? -1 : 1)));
			}
		} else {
			this.onEditKey(key);
			return;
		}
		this.scheduler.requestImmediateRender();
	}

	private onOverlayKey(key: string): void {
		const s = this.state;
		const level2 = s.overlayCmd !== "";
		const items: string[] = level2
			? (this.io.slashCommands().find((c) => c.name === s.overlayCmd)?.children ?? [])
			: this.filteredCommands().map((c) => c.name);
		if (key === "escape") {
			if (level2) {
				s.overlayCmd = "";
				s.input = "/";
				s.cursor = 1;
				s.overlaySel = 0;
			} else s.overlayOpen = false;
		} else if (key === "up" && items.length > 0) {
			s.overlaySel = (s.overlaySel - 1 + items.length) % items.length;
		} else if (key === "down" && items.length > 0) {
			s.overlaySel = (s.overlaySel + 1) % items.length;
		} else if (key === "pageUp" && items.length > 0) {
			s.overlaySel = Math.max(0, s.overlaySel - OVERLAY_PAGE);
		} else if (key === "pageDown" && items.length > 0) {
			s.overlaySel = Math.min(items.length - 1, s.overlaySel + OVERLAY_PAGE);
		} else if (key === "tab" && !level2 && items.length > 0) {
			s.input = items[s.overlaySel] ?? s.input;
			s.cursor = s.input.length;
			s.overlayOpen = false;
		} else if (key === "enter") {
			if (items.length === 0) {
				this.scheduler.requestImmediateRender();
				return;
			}
			const picked = items[s.overlaySel]!;
			const slash = this.io.slashCommands().find((c) => c.name === picked);
			if (!level2 && slash?.children !== undefined) {
				s.overlayCmd = picked;
				s.input = picked;
				s.cursor = picked.length;
				s.overlaySel = Math.max(0, slash.children.indexOf(this.io.slashCurrent(picked)));
			} else {
				// 带参数输入（/title 新名字）提交原文——裸命令名会丢参数（2026-09-23 实测：/title 改名失效前案，
				// 菜单过滤只认命令词、Enter 只提交 picked）；无参数 = picked（别名转正名）
				const typed = normCmd(s.input);
				const cmd = level2 ? `${s.overlayCmd} ${picked}` : typed.includes(" ") ? typed : picked;
				s.overlayOpen = false;
				s.overlayCmd = "";
				this.submitLine(cmd);
			}
		} else if (!level2 && (key === "backspace" || isPrintable(key))) {
			if (key === "backspace") {
				if (s.cursor > 0) {
					s.input = s.input.slice(0, s.cursor - 1) + s.input.slice(s.cursor);
					s.cursor--;
				}
			} else this.inputInsert(key);
			if (normCmd(s.input).startsWith("/")) s.overlaySel = 0;
			else s.overlayOpen = false;
		}
		this.scheduler.requestImmediateRender();
	}

	private onEditKey(key: string): void {
		const s = this.state;
		switch (key) {
			case "enter":
				if (normCmd(s.input) !== "") this.submitLine(normCmd(s.input));
				break;
			case "alt+enter":
				this.inputInsert("\n");
				break;
			case "ctrl+a":
				s.selAnchor = 0;
				s.cursor = s.input.length;
				break;
			case "shift+left":
				this.moveCursor(-1, true);
				break;
			case "shift+right":
				this.moveCursor(1, true);
				break;
			case "backspace":
				this.exitHistoryBrowse();
				if (!this.deleteSelection() && s.cursor > 0) {
					const cp = s.input.codePointAt(s.cursor - 1)!;
					const w = cp >= 0xd800 && cp <= 0xdbff ? 2 : 1;
					s.input = s.input.slice(0, s.cursor - w) + s.input.slice(s.cursor);
					s.cursor -= w;
				}
				break;
			case "delete":
				this.exitHistoryBrowse();
				if (!this.deleteSelection() && s.cursor < s.input.length) {
					const cp = s.input.codePointAt(s.cursor)!;
					s.input = s.input.slice(0, s.cursor) + s.input.slice(s.cursor + (cp > 0xffff ? 2 : 1));
				}
				break;
			case "left":
				this.moveCursor(-1, false);
				break;
			case "right":
				this.moveCursor(1, false);
				break;
			case "home":
				s.selAnchor = -1;
				s.cursor = 0;
				break;
			case "end":
				s.selAnchor = -1;
				s.cursor = s.input.length;
				break;
			case "up":
			case "down": {
				// ↑/↓ 历史导航（2026-09-23 走查拍板，照抄 kimi pi-tui editor.ts:1027-1052 语义）：
				// 非首/末视觉行 → 行内移动；首行非起始点 → 先回行首；起始点再 ↑ 才召回历史；
				// 进入浏览快照草稿，↓ 翻回最新位草稿原样恢复；上翻光标置首（可连按续翻）、下翻置末
				s.selAnchor = -1;
				const rows = layoutInputRows(s.input, this.inputInnerW());
				const cur = locateCursor(rows, s.cursor);
				const browsing = s.historyIdx < s.history.length;
				if (key === "up") {
					if (cur.row > 0) {
						s.cursor = indexAtRowCol(rows, cur.row - 1, cur.col);
					} else if (s.cursor !== 0) {
						s.cursor = 0; // 首行非起始 → 先回起始点（kimi moveToLineStart）
					} else if (s.input === "" && this.io.queueItems().length > 0) {
						// 空输入 + 队列非空 → 召回队尾（LIFO，kimi onUpArrowEmpty 优先于历史导航同口径）
						const q = this.io.recallQueued();
						if (q !== undefined) {
							s.input = q;
							s.cursor = q.length;
						}
					} else if (s.historyIdx > 0) {
						if (!browsing) s.historyDraft = s.input; // 进入浏览那一刻快照草稿
						s.historyIdx--;
						s.input = s.history[s.historyIdx]!;
						s.cursor = 0; // 上翻光标放开头——多行历史条目上连按 ↑ 即续翻（kimi setTextInternal "start"）
						s.inputScroll = 0;
					}
				} else if (browsing && cur.row === rows.length - 1) {
					s.historyIdx++;
					if (s.historyIdx === s.history.length) {
						s.input = s.historyDraft ?? ""; // 回到草稿位——草稿原样恢复
						s.historyDraft = undefined;
					} else {
						s.input = s.history[s.historyIdx]!;
					}
					s.cursor = s.input.length; // 下翻/回草稿光标放末尾（kimi "end"）
					s.inputScroll = 0;
				} else if (cur.row < rows.length - 1) {
					s.cursor = indexAtRowCol(rows, cur.row + 1, cur.col);
				} else {
					s.cursor = s.input.length; // 末行非浏览 → 跳行尾（kimi moveToLineEnd）
				}
				break;
			}
			default:
				if (isPrintable(key)) {
					this.inputInsert(key);
					// 输入仍是斜杠命令形态即（重）开菜单（F5 十五轮②：Esc 关掉后继续补字母要能重开
					// ——原条件 === "/" 只在恰好一个斜杠时触发，"/qu"+Esc 后再输入永不重开）
					if (normCmd(s.input).startsWith("/") && !s.overlayOpen) {
						s.overlayOpen = true;
						s.overlaySel = 0;
						s.overlayCmd = "";
					}
				}
		}
		this.afterEdit();
	}

	private submitLine(text: string): void {
		const s = this.state;
		// 提交闸门（批④——busy 期拒收档拦在回车前）：拦下则输入框原文保留、不进历史、不写流区、不提交，
		// 拒因尾行瞬显自消；回答结束后原文还在，直接再按回车即发
		const gated = this.io.submitGate?.(text);
		if (gated !== undefined) {
			this.showToast(gated); // 拒因走浮动 toast（输入框上边缘黄字 3s 自消——原尾行位退役）
			return;
		}
		s.scrollBack = 0; // 回看历史时提交 → 跳到底部（F5 五轮②：一次性置底，非粘底）
		s.history.push(text);
		s.historyIdx = s.history.length;
		s.historyDraft = undefined;
		s.input = "";
		s.cursor = 0;
		s.inputScroll = 0;
		s.selAnchor = -1;
		this.io.submit(text);
	}

	private filteredCommands(): SlashItem[] {
		const q = normCmd(this.state.input).slice(1).split(" ")[0]!;
		// 别名可筛（F5 十六轮①：/exit /q /rename /resume 都能过滤出真实命令——Enter 提交真名）
		// 前缀命中排前、含字命中殿后（2026-09-24 拍板：/ol 先列 ol 开头，再列含 ol 的 /yolo）——组内保持注册序
		const hits: SlashItem[] = [];
		const more: SlashItem[] = [];
		for (const c of this.io.slashCommands()) {
			const aliases = c.aliases ?? [];
			if (c.name.startsWith("/" + q) || aliases.some((a) => a.startsWith(q))) hits.push(c);
			else if (c.name.slice(1).includes(q) || aliases.some((a) => a.includes(q))) more.push(c);
		}
		return [...hits, ...more];
	}

	// ---------- 布局与渲染 ----------

	private sidebarW(): number {
		const cols = this.io.columns();
		return cols >= 100 ? Math.min(40, Math.max(34, Math.floor(cols * 0.28))) : Math.min(40, Math.floor(cols * 0.28));
	}

	private inputInnerW(): number {
		return Math.max(8, this.io.columns() - this.sidebarW() - 2 - 4);
	}

	private tailLine(): string {
		const s = this.state;
		// 模块询问挂起期：spinner 让位（F5——「正在生成…」与等待输入并存误导，用户不知该答什么）
		if (this.pendingUi?.kind === "ask") return theme.fg("info", "● 等待输入——Enter 确认 · Esc 取消");
		// 交互挂起期（pick/view）spinner 同让位（2026-09-22 用户实测：/model 选择期间「正在生成…」照转——
		// 挂起 = 等用户操作，不是在生成；浮层自带操作页脚，尾行回退待命态）
		if (this.pendingUi !== undefined) return theme.dim("正在待命");
		// pick 不占尾行（F5 十七轮①：选择浮层自带完整操作页脚——流区再挂「等待选择」是复读噪音）
		if (s.busy) {
			if (s.compacting) {
				// 压缩期（2026-09-23 用户拍板）：石青（info）色专属文案——与 turn 生成的「正在生成…」区分
				return `${theme.fg("info", SPIN_FRAMES[s.spinIdx]!)} ${theme.fg("info", "上下文压缩中…")}`;
			}
			return `${theme.fg("accent", SPIN_FRAMES[s.spinIdx]!)} ${theme.fg("muted", "正在生成…")}`;
		}
		return theme.dim("正在待命");
	}

	private panelBox(title: string, en: string, focused: boolean, w: number, h: number, content: string[], hints: string[], footer?: string[], footTop?: string[]): string[] {
		const bc = focused ? "accent" : "border";
		const inner = w - 2;
		const titleSeg = focused ? theme.fg("accent", ` ${title} `) : theme.fg("muted", ` ${title} `);
		const enSeg = theme.dim(` ${en} `);
		const titleW = visibleWidth(titleSeg);
		const enBudget = Math.max(4, w - 4 - titleW - 1);
		const enFit = truncateToWidth(enSeg, enBudget);
		const fill = Math.max(1, w - 4 - titleW - visibleWidth(enFit));
		const top = theme.fg(bc, "╭─") + titleSeg + theme.fg(bc, "─".repeat(fill)) + enFit + theme.fg(bc, "─╮");
		const pane = (l: string) => theme.fg(bc, "│") + padToWidth(l, inner) + theme.fg(bc, "│"); // 内底透明（F5 二轮⑩——surface 铺色在第三方终端主题下是一块黑）
		const rows: string[] = [top, pane("")];
		for (const l of content) rows.push(pane(l));
		const footRows = footer ?? [];
		const topRows = footTop ?? [];
		// 提示行超内宽折行不截字（F5 十一轮②：窄侧栏下「Enter 挂载/卸载」曾截成「挂载/卸」）
		const hintLines = hints.flatMap((hl) => wrapText(theme.dim(" " + hl), inner));
		// 填充目标含顶框（2026-09-24 走查：原 h-2 漏算顶框 1 行——面板恒矮一行，底框比输入框高，
		// 与输入框下边缘错位）；底部分三段（同日用户拍板）：footTop 分隔线贴提示区上沿 → 操作提示 →
		// footer 注脚贴底框——填充空行恒在分隔线上方，终端再高分隔线也不与提示行脱节
		while (rows.length < h - 1 - topRows.length - footRows.length - hintLines.length) rows.push(pane(""));
		for (const l of topRows) rows.push(pane(l));
		for (const hl of hintLines) rows.push(pane(hl));
		for (const l of footRows) rows.push(pane(l));
		rows.push(theme.fg(bc, "╰" + "─".repeat(inner) + "╯"));
		return rows.slice(0, h);
	}

	private kvRow(label: string, value: string, w: number): string {
		return ` ${theme.fg("muted", padToWidth(label, 8))} ${truncateToWidth(value, w - 11)}`;
	}

	private sep(w: number): string {
		return theme.fg("border", " " + "┄".repeat(Math.max(1, w - 2)));
	}

	private modRow(m: PanelData["modules"][number], selected: boolean, w: number): string {
		const dot = m.state === "mounted" ? theme.fg("accent", "●") : m.state === "loading" ? theme.fg("warn", "◐") : theme.fg("muted", "○");
		// 锁定后缀（2026-09-23 用户拍板）：名字后灰色「· 锁定」；行尾状态位照常显示挂载态
		const lockSuffix = m.locked === true ? theme.dim(" · 锁定") : "";
		const name = (m.state === "off" ? theme.fg("muted", m.name) : selected ? theme.fg("accent", m.name) : m.name) + lockSuffix;
		const stateText = MOD_STATE_TEXT[m.state]!;
		const st = m.state === "mounted" ? theme.fg("accent", stateText) : m.state === "loading" ? theme.fg("warn", stateText) : theme.dim(stateText);
		const lockW = m.locked === true ? visibleWidth(" · 锁定") : 0; // 锁定后缀占宽——desc/gap 预算要扣（防溢出）
		const descBudget = w - (3 + visibleWidth(m.name) + lockW + 1 + visibleWidth(stateText) + 1);
		const desc = descBudget >= visibleWidth(m.desc) ? theme.dim(m.desc) : descBudget >= 8 ? truncateToWidth(theme.dim(m.desc), descBudget) : "";
		const leftW = 3 + visibleWidth(m.name) + lockW + (desc === "" ? 0 : 1 + visibleWidth(desc));
		const gap = Math.max(1, w - leftW - visibleWidth(stateText));
		const row = ` ${dot} ${name}${desc === "" ? "" : ` ${desc}`}${" ".repeat(gap)}${st}`;
		return selected ? theme.bg("accentSoft", padToWidth(row, w)) : row;
	}

	private statusRows(w: number, h: number): string[] {
		const s = this.state;
		const d = this.io.panelData();
		const focused = s.focusIdx === 1;
		const inner = w - 2;
		if (s.statePage === 0) {
			const content: string[] = [];
			content.push(this.kvRow("模型", theme.fg("info", d.model), inner));
			content.push(this.kvRow("会话", d.session, inner));
			content.push(this.kvRow("工作目录", theme.fg("info", d.cwd), inner));
			content.push(this.kvRow("运行时间", elapsedText(d.startedAt), inner)); // F5 二轮④
			content.push(this.kvRow("Tokens", `↑ ${d.tokens.input.toLocaleString()} · ↓ ${d.tokens.output.toLocaleString()}`, inner)); // F5 二轮⑤
			content.push(this.sep(inner));
			// 上下文占用 = 末次请求的输入规模（上下文体量口径）；占比再小也至少给一格 ▏（F5 二轮⑥——
			// 0k/1000k 时零绿块被读成「进度条坏了」）
			const usedCtx = d.tokens.input;
			const pct = d.contextWindow > 0 ? Math.min(1, usedCtx / d.contextWindow) : 0;
			const pctText = `${Math.round(usedCtx / 1000)}k/${Math.round(d.contextWindow / 1000)}k`;
			const FRACS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
			const barW = Math.max(6, inner - 8 - pctText.length - 1);
			const total = Math.max(0, Math.min(barW, Math.round(pct * barW * 8) / 8));
			const full = Math.floor(total);
			const frac = total - full;
			const fracCh = frac > 0 ? FRACS[Math.min(7, Math.ceil(frac * 8) - 1)] : usedCtx > 0 ? "▏" : "";
			content.push(
				` ${theme.fg("muted", "上下文")} ${theme.fg("accent", "█".repeat(full) + fracCh)}${theme.fg("muted", "░".repeat(Math.max(0, barW - full - (fracCh === "" ? 0 : 1))))} ${theme.fg("muted", pctText)}`,
			);
			content.push(this.sep(inner));
			const slots = MODULE_SLOTS;
			const pages = Math.max(1, Math.ceil(d.modules.length / slots));
			const page = Math.min(pages - 1, Math.floor(s.moduleSel / slots));
			const lo = page * slots;
			const headL = ` ${theme.fg("muted", "模块挂载")}`;
			const headR = theme.dim(`${page + 1}/${pages} · MODULES`);
			content.push(headL + " ".repeat(Math.max(1, inner - visibleWidth(headL) - visibleWidth(headR))) + headR);
			for (let i = lo; i < Math.min(d.modules.length, lo + slots); i++) {
				content.push(this.modRow(d.modules[i]!, focused && i === s.moduleSel, inner));
			}
			return this.panelBox("运行状态", "1/2", focused, w, h, content, ["←→ 翻页 · PgUp/PgDn 模块翻页", "↑↓ 模块选择 · Enter 挂/卸载"], undefined, [this.sep(inner)]);
		}
		const content: string[] = [
			` ${theme.fg("muted", "（健康探测数据源未就绪——如实登记：框架化方案书缺口项）")}`,
		];
		return this.panelBox("网络 · MCP", "2/2", focused, w, h, content, ["←→ 返回运行状态 · Esc 返回"], undefined, [this.sep(inner)]);
	}

	// 任务清单每页行数（翻页步长 = 页大小——步长小于页大小时选中项在页内挪动页号不翻）；
	// 与 renderFrame 的 statusH/taskH 布局同口径，改布局两处同步
	private taskPageSlots(): number {
		const taskH = this.io.rows() - Math.max(8, Math.floor(this.io.rows() * 0.55));
		return Math.max(2, taskH - 6);
	}

	private taskRows(w: number, h: number): string[] {
		const s = this.state;
		const d = this.io.panelData();
		const focused = s.focusIdx === 2;
		const inner = w - 2;
		const done = d.tasks.filter((t) => t.state === "done").length;
		const slots = this.taskPageSlots();
		const pages = Math.max(1, Math.ceil(d.tasks.length / slots));
		const page = Math.min(pages - 1, Math.floor(s.taskSel / slots));
		const lo = page * slots;
		const content: string[] = [];
		for (let i = lo; i < Math.min(d.tasks.length, lo + slots); i++) {
			const t = d.tasks[i]!;
			const text =
				t.state === "done"
					? `\x1b[9m${theme.fg("muted", t.text)}\x1b[29m`
					: t.state === "active"
						? theme.fg("warn", t.text)
						: theme.fg("fg", t.text);
			const row = ` ${TASK_TICK[t.state]} ${truncateToWidth(text, inner - 4)}`;
			content.push(focused && i === s.taskSel ? theme.bg("accentSoft", padToWidth(row, inner - 1)) : row);
		}
		const footL = theme.dim(" 由 Agent 实时同步");
		const footR = theme.dim(`任务数：${done}/${d.tasks.length}`);
		const footer = [footL + " ".repeat(Math.max(1, inner - visibleWidth(footL) - visibleWidth(footR))) + footR];
		return this.panelBox("任务清单", `${page + 1}/${pages}`, focused, w, h, content, ["PgUp/PgDn 翻页 · Esc 返回"], footer, [this.sep(inner)]);
	}

	private styleWithSelection(vr: InputRow, sel: { lo: number; hi: number } | undefined): string {
		if (!sel) return vr.text;
		const lo = Math.max(vr.srcStart, sel.lo);
		const hi = Math.min(vr.srcEnd, sel.hi);
		if (lo >= hi) return vr.text;
		const a = lo - vr.srcStart;
		const b = hi - vr.srcStart;
		return vr.text.slice(0, a) + theme.inverse(vr.text.slice(a, b)) + vr.text.slice(b);
	}

	private renderFrame(): number {
		const cols = this.io.columns();
		const rows = this.io.rows();
		const s = this.state;
		const sidebarW = s.sidebarVisible ? this.sidebarW() : 0; // 隐藏 = 左栏占满（无分隔线/无面板）
		const leftW = cols - sidebarW - 2;

		const innerW = Math.max(8, leftW - 4);
		const inputRows = layoutInputRows(s.input, innerW);
		const cursorPos = locateCursor(inputRows, s.cursor);
		const showRows = Math.min(INPUT_MAX_ROWS, inputRows.length);
		const inputH = showRows + 3;
		// 队列区（2026-09-23 队列批——kimi QueuePane 同族）：busy 期排队消息逐条单行摘要 +
		// 操作 hint 行，位于流区与输入框之间；空队列不占行
		const queue = this.io.queueItems();
		const queueH = queue.length === 0 ? 0 : queue.length + 1;
		const streamH = rows - inputH - queueH;

		// 面板行只在侧栏可见时计算（隐藏时 sidebarW=0 会让 panelBox 内宽为负——repeat 炸）
		const statusH = Math.max(8, Math.floor(rows * 0.55));
		const taskH = rows - statusH;
		const status = s.sidebarVisible ? this.statusRows(sidebarW, statusH) : [];
		const tasks = s.sidebarVisible ? this.taskRows(sidebarW, taskH) : [];

		const doc = [...this.io.doc(), this.tailLine()];
		const maxScroll = Math.max(0, doc.length - streamH);
		s.scrollBack = Math.min(s.scrollBack, maxScroll);
		const end = doc.length - s.scrollBack;
		const start = Math.max(0, end - streamH);

		const inputFocused = s.focusIdx === 0;
		const ibc = inputFocused ? "accent" : "border";
		const screen: string[] = Array.from({ length: rows }, () => "");
		for (let r = 0; r < streamH; r++) {
			// 消息区左内衬 2 列（2026-09-23 用户拍板：文字起始贴屏幕左缘难看）——docmodel 折行口径
			// = streamW − 2，前导 2 空格后恰 = leftW 不截尾；空行也垫，块状整体右移保持对齐
			screen[r] = padToWidth(doc[start + r] === undefined ? "" : `  ${doc[start + r]!}`, leftW);
		}
		if (queueH > 0) {
			for (let i = 0; i < queue.length; i++) {
				const oneLine = queue[i]!.replace(/\s+/g, " ").trim(); // 单行摘要（kimi QueuePane 同形态）
				screen[streamH + i] = padToWidth(` ${theme.fg("accent", "›")} ${theme.dim(truncateToWidth(oneLine, Math.max(1, leftW - 4)))}`, leftW);
			}
			// 两行都 pad 到左栏宽——不补齐则右侧面板分隔线/内容左移错位（走查实锤）
			screen[streamH + queue.length] = padToWidth(theme.dim("  ↑ 召回队尾 · Ctrl + U 立即注入本轮 · 回答结束后依序发送"), leftW);
		}
		const divRow = streamH + queueH;
		// 模块询问挂起期：问题写进输入框顶边标题（F5——placeholder 只在空输入时可见，用户一打字问题就消失）
		if (this.pendingUi?.kind === "ask") {
			const qSeg = theme.fg("accent", ` ${this.pendingUi.question} `);
			const qFill = Math.max(1, leftW - 4 - visibleWidth(qSeg));
			screen[divRow] = theme.fg(ibc, "╭─") + qSeg + theme.fg(ibc, "─".repeat(qFill) + "╮");
		} else {
			screen[divRow] = theme.fg(ibc, "╭" + "─".repeat(Math.max(1, leftW - 2)) + "╮");
		}

		// 浮动 toast（2026-09-22 用户拍板终稿：全宽无框——宽度与输入框一致左右顶到头、无包边字符）：
		// 输入框顶边上方叠黄色文字行（wrapText 折行 ≤3 行、3s 自消），只盖左栏（侧栏追加合并不受影响），
		// 遮蔽的流区内容随自消还原
		if (s.toast !== undefined && Date.now() - s.toast.at < 3000) {
			const tLines = wrapText(s.toast.text, Math.max(8, leftW - 2)).slice(0, 3);
			const top = Math.max(0, divRow - tLines.length);
			for (let i = 0; i < tLines.length; i++) {
				screen[top + i] = theme.fg("warn", padToWidth(` ${tLines[i]!}`, leftW));
			}
		}

		const sel = this.selRange();
		const paneIn = (l: string) => theme.bg("surface2", theme.fg(ibc, "│") + padToWidth(l, leftW - 2) + theme.fg(ibc, "│"));
		for (let i = 0; i < showRows; i++) {
			const vr = inputRows[s.inputScroll + i];
			const prefix = i + s.inputScroll === 0 ? theme.fg("accent", "❯ ") : "  ";
			let line: string;
			if (vr === undefined) {
				line = prefix;
			} else if (s.input !== "" && this.pendingUi?.kind === "ask" && this.pendingUi.secret) {
				line = prefix + "•".repeat(vr.text.length);
			} else if (s.input === "" && i === 0) {
				const ph = this.pendingUi?.kind === "ask"
					? this.pendingUi.secret ? "请输入（不回显）…" : "请输入…" // 问题已在顶边标题（F5 九轮③——占位符不再复读）
					: "向 Orosus 下达指令，或输入 / 查看命令…";
				line = prefix + theme.dim(ph);
			} else {
				line = prefix + this.styleWithSelection(vr, sel);
			}
			screen[divRow + 1 + i] = paneIn(inputFocused ? line : theme.dim(line));
		}
		const d = this.io.panelData();
		// 档色语义（2026-09-22 用户拍板）：Never Ask = 全自动放行危险档 → 警示黄；确认类档保持青玉
		const chip = theme.fg(d.permission === "never" ? "warn" : "accent", `◆ ${PERM_LABEL[d.permission] ?? d.permission}`);
		const leftHint = `${chip}${theme.dim(" · Shift + Tab 切换模式")}`;
		const rightHint = theme.dim("Enter 发送 · Alt + Enter 换行 · / 命令 · Tab 面板焦点 · Esc 返回");
		const hintW = leftW - 2;
		const gap = hintW - visibleWidth(leftHint) - visibleWidth(rightHint) - 1;
		screen[divRow + 1 + showRows] = paneIn(
			gap > 2 ? ` ${leftHint}${" ".repeat(gap)}${rightHint}` : padToWidth(` ${leftHint}`, hintW),
		);
		screen[divRow + 2 + showRows] = theme.fg(ibc, "╰" + "─".repeat(Math.max(1, leftW - 2)) + "╯");

		if (s.sidebarVisible) {
			for (let r = 0; r < rows; r++) {
				const sep = theme.fg("border", "│");
				const right = r < statusH ? (status[r] ?? "") : (tasks[r - statusH] ?? "");
				screen[r] = (screen[r] ?? "") + sep + right;
			}
		}

		let overlay: OverlayFrame | undefined;
		if (this.onboarding !== undefined) {
			const ob = this.onboarding.session.render(cols, rows); // 居中定高弹窗（三页恒定行数——防闪烁纪律）
			overlay = { lines: ob.lines, row: ob.row, col: ob.col, width: ob.width };
		} else if (this.pendingUi?.kind === "pick") {
			const pu = this.pendingUi;
			overlay = this.buildPickOverlay(leftW, divRow, pu.title, pu.items, pu.sel, pu.filter);
		} else if (this.pendingUi?.kind === "view") {
			const pu = this.pendingUi;
			overlay = this.buildViewOverlay(leftW, divRow, pu.title, pu.lines, pu.scroll);
		} else if (s.overlayOpen) {
			overlay = this.buildOverlay(leftW, divRow);
		} else if (s.diagOpen) {
			overlay = this.buildDiagOverlay(leftW, divRow);
		}

		const bytes = this.full.render(screen, rows, cols, overlay);
		// 引导期藏光标（弹窗锁焦点——输入框光标不该在背景里闪）；Key 输入是静默盲输，无光标可指示
		this.full.placeCursor(divRow + 1 + (cursorPos.row - s.inputScroll), 3 + cursorPos.col, this.onboarding === undefined && inputFocused);
		return bytes;
	}

	/** 只读文本浮层（F5 二轮⑪——/help：全宽青玉框 + 滚动窗口 + 余量指示；不可选择）。 */
	private buildViewOverlay(leftW: number, divRow: number, title: string, lines: string[], scroll: number): OverlayFrame {
		const ow = leftW;
		const oInner = ow - 2;
		const bc = "accent";
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
		const olines: string[] = [];
		const titleSeg = theme.fg("accent", ` ${title} `);
		const topFill = Math.max(1, ow - 4 - visibleWidth(titleSeg));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + titleSeg + theme.fg(bc, "─".repeat(topFill)) + theme.fg(bc, "─╮")));
		olines.push(boxRow(""));
		const page = Math.max(3, divRow - 6); // 浮层不高过输入框顶
		const maxScroll = Math.max(0, lines.length - page);
		const sc = Math.max(0, Math.min(maxScroll, scroll));
		const win = lines.slice(sc, sc + page);
		if (sc > 0) olines.push(boxRow(theme.dim(`   ↑ 还有 ${sc} 行`)));
		for (const l of win) olines.push(boxRow(" " + truncateToWidth(l, oInner - 2)));
		const rest = lines.length - sc - win.length;
		if (rest > 0) olines.push(boxRow(theme.dim(`   ↓ 还有 ${rest} 行`)));
		olines.push(boxRow(theme.dim(" ↑↓ / PgUp/PgDn 翻页 · Esc 关闭")));
		olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(oInner) + "╯")));
		return { lines: olines, row: Math.max(0, divRow - olines.length), col: 0, width: ow };
	}

	/** 模块 choose 的 overlay 选择框（全屏 CommandUi 适配面——与斜杠菜单同族：全宽/青玉框/分页/「还有 N 项」）。 */
	private buildPickOverlay(leftW: number, divRow: number, title: string, items: string[], sel: number, filter?: string): OverlayFrame {
		const ow = leftW;
		const oInner = ow - 2;
		const bc = "accent";
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
		// 多行项压平单行（2026-09-24 走查实锤前案——/provider「名称\n（URL）」双行项：裸 \n 进 overlay 行，
		// padToWidth 计宽与合成全乱 → 上下移动大概率残影黑带+||；行模式 choose 同款压平 menu.ts:46）
		const flatItems = items.map((i) => i.replace(/\s*\n\s*/g, " "));
		const shown = filter === undefined ? flatItems : flatItems.filter((i) => i.toLowerCase().includes(filter.toLowerCase()));
		const olines: string[] = [];
		const filterSeg = filter === undefined ? "" : ` ${filter === "" ? "" : `过滤「${filter}」`} ${shown.length}/${items.length} `;
		const titleSeg = theme.fg("accent", ` ${title} `);
		const topFill = Math.max(1, ow - 4 - visibleWidth(titleSeg) - visibleWidth(theme.dim(filterSeg)));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + titleSeg + theme.fg(bc, "─".repeat(topFill)) + theme.dim(filterSeg) + theme.fg(bc, "─╮")));
		olines.push(boxRow(""));
		const selI = Math.max(0, Math.min(shown.length - 1, sel));
		const winStart = Math.max(0, Math.min(Math.max(0, shown.length - OVERLAY_PAGE), selI - OVERLAY_PAGE + 1));
		const win = shown.slice(winStart, winStart + OVERLAY_PAGE);
		if (winStart > 0) olines.push(boxRow(theme.dim(`   ↑ 还有 ${winStart} 项`)));
		for (let i = 0; i < win.length; i++) {
			const gi = winStart + i;
			// 当前值项（" ✓" 尾标——/model /effort 命令层约定）整项染青玉 accent（2026-09-25 用户拍板：
			// 当前档用选中色区分——与斜杠菜单二级 ✓ mark 同族口径）
			const label = win[i]!.endsWith(" ✓") ? theme.fg("accent", win[i]!) : win[i]!;
			const row = ` ${gi === selI ? theme.fg("accent", "❯") : " "} ${label}`;
			olines.push(gi === selI ? boxRow(theme.bg("accentSoft", padToWidth(row, oInner - 1))) : boxRow(row));
		}
		const rest = shown.length - winStart - win.length;
		if (rest > 0) olines.push(boxRow(theme.dim(`   ↓ 还有 ${rest} 项`)));
		olines.push(boxRow(theme.dim(filter === undefined ? " ↑↓ 选择 · Enter 选定 · Esc 取消" : " 输入文字过滤 · ↑↓ 选择 · Enter 选定 · Esc 取消")));
		olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(oInner) + "╯")));
		return { lines: olines, row: Math.max(0, divRow - olines.length), col: 0, width: ow };
	}

	/** 模块诊断一级列表浮层（T9，原型一级）：赭石标题 + 恒 8 行列表 + 余量提示 + 键提示行（浮层高度恒定防闪烁）。 */
	private buildDiagOverlay(leftW: number, divRow: number): OverlayFrame {
		const s = this.state;
		const entries = this.io.diagEntries?.() ?? [];
		const ow = leftW;
		const oInner = ow - 2;
		const bc = "accent";
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
		const olines: string[] = [];
		const title = theme.fg("err", " 模块诊断 ");
		const en = theme.dim(` ${entries.length} 个模块出过问题 `);
		const topFill = Math.max(1, ow - 4 - visibleWidth(title) - visibleWidth(en));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + title + theme.fg(bc, "─".repeat(topFill)) + en + theme.fg(bc, "─╮")));
		const selI = Math.max(0, Math.min(entries.length - 1, s.diagSel));
		const { lines, selRow } = diagListLines(entries, selI, oInner - 1);
		for (let i = 0; i < DIAG_LIST_ROWS + 1; i++) {
			// 选中行青玉软底（斜杠菜单同款）；余量行（第 9 行）不参与高亮
			olines.push(i === selRow ? boxRow(theme.bg("accentSoft", padToWidth(lines[i] ?? "", oInner - 1))) : boxRow(lines[i] ?? ""));
		}
		olines.push(theme.bg("surface2", theme.fg(bc, "├" + "─".repeat(oInner) + "┤")));
		olines.push(boxRow(theme.dim(" ↑↓ 选择 · Enter 详情 · Esc 关闭")));
		olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(oInner) + "╯")));
		return { lines: olines, row: Math.max(0, divRow - olines.length), col: 0, width: ow };
	}

	private buildOverlay(leftW: number, divRow: number): OverlayFrame {		const s = this.state;
		const level2 = s.overlayCmd !== "";
		const ow = leftW;
		const oInner = ow - 2;
		const bc = "accent";
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
		const olines: string[] = [];
		const title = level2 ? theme.fg("accent", ` ${s.overlayCmd} `) : theme.fg("accent", " 斜杠命令 ");
		const en = theme.dim(level2 ? " 选择一项 " : ` ${this.filteredCommands().length} 个命令 `);
		const topFill = Math.max(1, ow - 4 - visibleWidth(title) - visibleWidth(en));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + title + theme.fg(bc, "─".repeat(topFill)) + en + theme.fg(bc, "─╮")));
		// 标题下不留装饰空行（2026-09-23 用户打回：上方空白一块）——↑ 占位行紧贴标题，滚动时原地变「↑ 还有 N 项」
		let items: { text: string; mark: string; long: string }[];
		if (level2) {
			const cmdDef = this.io.slashCommands().find((c) => c.name === s.overlayCmd);
			const current = this.io.slashCurrent(s.overlayCmd);
			items = (cmdDef?.children ?? []).map((c) => {
				const meta = cmdDef?.childMeta?.[c]; // F5 十轮⑤：档名 + 短解（详释区用 long）
				return {
					text: meta === undefined ? c : `${theme.fg("fg", meta.label)} ${theme.dim(`——${meta.desc}`)} ${theme.dim(`(${c})`)}`,
					mark: c === current ? theme.fg("accent", "✓") : " ",
					long: meta?.long ?? `${s.overlayCmd} 二级项：${c}——回车选定。`,
				};
			});
		} else {
			const real = this.filteredCommands();
			items =
				real.length === 0
					? [{ text: theme.dim("无匹配命令"), mark: " ", long: "没有匹配的命令。继续输入或删字修改筛选，Esc 关闭菜单。" }]
					: real.map((c) => ({
							text: `${c.name}${c.aliases === undefined ? "" : theme.fg("muted", `（${c.aliases.join(", ")}）`)} ${theme.dim(c.desc)}`,
							mark: " ",
							long: c.long,
						}));
		}
		const selI = Math.max(0, Math.min(items.length - 1, s.overlaySel));
		const winStart = Math.max(0, Math.min(Math.max(0, items.length - OVERLAY_PAGE), selI - OVERLAY_PAGE + 1));
		const win = items.slice(winStart, winStart + OVERLAY_PAGE);
		// 列表区恒定（2026-09-23 用户拍板：固定防闪烁）——命令恒 OVERLAY_PAGE 行（二级列表不足时补空行——空槽位留空）
		for (let i = 0; i < OVERLAY_PAGE; i++) {
			const it = win[i];
			if (it === undefined) {
				olines.push(boxRow(""));
				continue;
			}
			const gi = winStart + i;
			const selPrefix = gi === selI ? theme.fg("accent", "❯") : " ";
			const markSeg = it.mark === " " ? "" : `${it.mark} `;
			const row = ` ${selPrefix} ${markSeg}${it.text}`;
			olines.push(gi === selI ? boxRow(theme.bg("accentSoft", padToWidth(row, oInner - 1))) : boxRow(row));
		}
		// 余量提示合并一行常驻（2026-09-23 用户打回：上下两行占 2 行不好看）——上下都有时「↑ 还有 N · ↓ 还有 M」，无余量时空占位
		const rest = items.length - winStart - win.length;
		const hints = [
			winStart > 0 ? `↑ 还有 ${winStart} 项` : "",
			rest > 0 ? `↓ 还有 ${rest} 项` : "",
		].filter(Boolean).join(" · ");
		olines.push(boxRow(hints === "" ? "" : theme.dim(`   ${hints}`)));
		// 详释区恒定 3 行（同拍板）：说明最多 2 行，显示不下第 2 行末尾 "..."（占 3 列），第 3 行操作提示
		const longW = oInner - 2;
		const wrapped = wrapText(theme.dim(items[selI]?.long ?? ""), longW);
		const longLines = wrapped.slice(0, 2).map((l) => ` ${l}`);
		if (wrapped.length > 2) longLines[1] = ` ${truncateToWidth(wrapped[1] ?? "", longW - 4)}...`;
		while (longLines.length < 2) longLines.push("");
		const foot = theme.dim(level2 ? " ↑↓ 选择 · Enter 选定 · Esc 返回" : " ↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭");
		olines.push(theme.bg("surface2", theme.fg(bc, "├" + "─".repeat(oInner) + "┤")));
		for (const l of longLines) olines.push(boxRow(l));
		olines.push(boxRow(foot));
		olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(oInner) + "╯")));
		return { lines: olines, row: Math.max(0, divRow - olines.length), col: 0, width: ow };
	}

	// ---------- 崩溃恢复（spike 判据 4 同款） ----------

	private installCrashHooks(): void {
		// 进程级钩子每次 runFullScreen 新建实例都会再挂——不拦则 5 次模式切换后 MaxListeners 告警、
		// 旧实例的 term/full 引用陪葬（F5 修复轮补）。恢复只认当前活跃实例。
		FullApp.activeInstance = this;
		if (FullApp.hooksInstalled) return;
		FullApp.hooksInstalled = true;
		process.on("exit", () => {
			try {
				const cur = FullApp.activeInstance;
				writeSync(1, "\x1b[?25h\x1b[?2004l\x1b[?7h" + (cur?.full.isActive === true ? "\x1b[?1049l" : ""));
			} catch {
				/* noop */
			}
		});
		process.on("uncaughtException", (err) => {
			try {
				const cur = FullApp.activeInstance;
				if (cur !== undefined) {
					if (cur.full.isActive) cur.full.exit();
					cur.term.stop();
				}
				writeSync(1, "\x1b[?25h\x1b[?2004l\x1b[?7h");
			} catch {
				/* 恢复尽力而为 */
			}
			throw err;
		});
	}

	private static hooksInstalled = false;
	private static activeInstance: FullApp | undefined;
}
