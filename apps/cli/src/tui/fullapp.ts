/** 全屏应用（TUI 批阶段三 F3–F5——原型完整交互面落地；v1.1–v1.11 走查拍板口径）。
 *  布局：无标题栏 + 左栏（stream 滚动区 + 输入框带框多行 ≤5 行超出上滚）+ 右栏双面板
 *  （运行状态/任务清单，真实数据经 io.panelData）+ 末列整列留白（conhost DECAWM 防御）。
 *  交互：Tab 焦点循环（聚焦面板青玉框）/ Shift+Tab 权限循环 / Esc 忙碌时取消 turn、闲时返回输入 /
 *  斜杠菜单全宽浮层（每页 10 条窗口跟随/「还有 N 项」/二级列表 ✓ 当前值/空过滤占位不关窗/长说明）/
 *  输入多行 ≤5 + Alt+Enter 换行 + Ctrl+A 全选 + Shift+←→ 选择 + bracketed paste / Alt+E 思考折叠。
 *  崩溃恢复（spike 判据 4）：exit 钩子同步直写恢复序列 + uncaughtException 先恢复再抛。
 *  鼠标接管关闭（用户拍板 2026-09-21——重开 = fullscreen.ts ENTER_ALT 追加 ?1000/?1006）。 */

import { writeSync } from "node:fs";
import { Term, type TermIO } from "./terminal.ts";
import { matchKey, isPrintable } from "./keymatch.ts";
import { FullScreen, type OverlayFrame } from "./fullscreen.ts";
import { FrameScheduler } from "./scheduler.ts";
import { padToWidth, truncateToWidth, visibleWidth, wrapText } from "./width.ts";
import * as theme from "../theme.ts";

// ---------- 接缝类型 ----------

export interface PanelData {
	model: string;
	session: string;
	cwd: string;
	tokens: { input: number; output: number }; // 末条 usage 分拆（F5 二轮⑤：↑ 输入 · ↓ 输出）
	startedAt: string | undefined; // 会话首事件 ts（F5 二轮④：运行时间行数据源）
	contextWindow: number;
	modules: { name: string; desc: string; state: "mounted" | "loading" | "off"; locked?: boolean }[];
	tasks: { text: string; state: "done" | "active" | "pending" }[];
	permission: string; // 当前权限模式原文（ask-always/ask-risky/never）
	permissionNext(): string; // Shift+Tab 循环的下一档命令（如 "/permission ask-always"）
}

export interface SlashItem {
	name: string;
	desc: string;
	long: string;
	children?: string[]; // 有二级列表的命令（当前值 ✓ 标记——当前值由 io.slashCurrent 提供）
}

export interface FullAppIO {
	columns(): number;
	rows(): number;
	doc(): string[];
	submit(text: string): void;
	requestLineMode(): void;
	requestExit(): void;
	requestCancel(): void; // Esc 忙碌时取消当前 turn（h.cancel）
	panelData(): PanelData;
	slashCommands(): SlashItem[];
	slashCurrent(cmd: string): string; // 二级列表当前值（/permission → 当前模式）
	thinkOpen(): boolean;
	toggleThink(): void;
	/** Alt + V 粘贴剪贴板图片（F5 二轮⑬——宿主侧 pasteImage 完成后经 addAttachment 回挂 chip）。 */
	requestPasteImage?(): void;
}

type FocusIdx = 0 | 1 | 2;

interface AppState {
	input: string;
	cursor: number;
	inputScroll: number;
	selAnchor: number; // -1 = 无选择
	history: string[];
	historyIdx: number;
	focusIdx: FocusIdx;
	moduleSel: number;
	taskSel: number;
	statePage: number;
	scrollBack: number;
	busy: boolean;
	spinIdx: number;
	overlayOpen: boolean;
	overlaySel: number;
	overlayCmd: string; // "" = 一级
}

const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INPUT_MAX_ROWS = 5;
const OVERLAY_PAGE = 10;
const MOD_STATE_TEXT: Record<string, string> = { mounted: "已挂载", loading: "挂载中", off: "未挂载" };
const TASK_TICK: Record<string, string> = { done: theme.fg("accent", "✓"), active: theme.fg("warn", "◐"), pending: theme.fg("muted", "○") };
/** 运行时间格式化（F5 二轮④）：<1 分「刚刚」；<1 时「N 分」；<1 天「N 时 N 分」；否则「N 天 N 时」。 */
export function elapsedText(startedAt: string | undefined, now: number = Date.now()): string {
	if (startedAt === undefined) return "—";
	const ms = Math.max(0, now - Date.parse(startedAt));
	if (Number.isNaN(ms)) return "—";
	const min = Math.floor(ms / 60000);
	if (min < 1) return "刚刚";
	if (min < 60) return `${min} 分`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr} 时 ${min % 60} 分`;
	return `${Math.floor(hr / 24)} 天 ${hr % 24} 时`;
}

const PERM_LABEL: Record<string, string> = { "ask-always": "总是询问", "ask-risky": "危险时询问", never: "从不询问" };

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
			focusIdx: 0,
			moduleSel: 0,
			taskSel: 0,
			statePage: 0,
			scrollBack: 0,
			busy: false,
			spinIdx: 0,
			overlayOpen: false,
			overlaySel: 0,
			overlayCmd: "",
		};
	}

	/** 测试探针。 */
	get stateRef(): AppState {
		return this.state;
	}

	/** 流区可用宽（左栏内容宽——doc 折行口径，F5 三轮②③：宿主按此宽喂 DocModel）。 */
	get streamCols(): number {
		return Math.max(8, this.io.columns() - this.sidebarW() - 2);
	}

	/** 忙碌探针（F5 四轮：宿主排队判定用）。 */
	get isBusy(): boolean {
		return this.state.busy;
	}

	/** 排队提交数（流式中提交的命令/消息——turn 结束后依序执行，尾行提示）。 */
	queuedCount = 0;

	/** 宿主更新排队数并即刻重绘尾行（F5 四轮）。 */
	setQueued(n: number): void {
		this.queuedCount = n;
		this.scheduler.requestImmediateRender();
	}

	start(): void {
		this.full.enter();
		this.term.start();
		// WT alt-buffer 滚轮自滚防御（图3 用户实测：滚轮后输入区消失、Tab 切换恢复——
		// 终端侧滚屏使 FullScreen 簿记与真实屏脱节；2s 看门狗强制全帧重绘兜底）
		this.watchdogTimer = setInterval(() => this.full.reset(), 2000);
		this.watchdogTimer.unref?.();
		this.term.onInput((seq) => this.onKey(matchKey(seq)));
		this.term.onPaste((text) => {
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
		// 挂起的模块询问随应用停止结算为「取消」（F5：Ctrl+T/C 中途离场时 promise 不得永挂——
		// 否则模块命令侧永远等不到回答）
		if (this.pendingUi !== undefined) {
			const pu = this.pendingUi;
			this.pendingUi = undefined;
			if (pu.kind !== "view") pu.resolve(undefined); // view 无 promise 可结
		}
		if (this.busyTimer) clearInterval(this.busyTimer);
		if (this.watchdogTimer) clearInterval(this.watchdogTimer);
		this.scheduler.stop();
		if (this.full.isActive) this.full.exit();
		this.term.stop();
		if (FullApp.activeInstance === this) FullApp.activeInstance = undefined;
	}

	setBusy(b: boolean): void {
		const s = this.state;
		if (s.busy === b) return;
		s.busy = b;
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

	// ---------- 全屏 CommandUi 适配面（choose → overlay 选择器；ask/askSecret → 输入行询问） ----------

	private pendingUi:
		| { kind: "pick"; title: string; items: string[]; sel: number; resolve: (n: number | undefined) => void }
		| { kind: "ask"; question: string; secret: boolean; resolve: (v: string | undefined) => void }
		| { kind: "view"; title: string; lines: string[]; scroll: number }
		| undefined;

	/** 只读文本浮层（F5 二轮⑪——/help 形态：不可选择、↑↓/PgUp/PgDn 翻页、Esc/Enter/q 关闭）。 */
	viewText(title: string, text: string): void {
		this.state.overlayOpen = false; // 与斜杠菜单互斥
		this.pendingUi = { kind: "view", title, lines: text.split("\n"), scroll: 0 };
		this.scheduler.requestImmediateRender();
	}

	/** 挂起的图片附件 chip 标签（F5 二轮⑬——「[image #2 (165×103)]」随输入框显示，提交即清空）。 */
	attachments: string[] = [];
	addAttachment(label: string): void {
		this.attachments.push(label);
		this.scheduler.requestImmediateRender();
	}

	/** choose 的全屏形态：overlay 列表选择（Esc → undefined——宿主侧转「已取消（Esc）」，机制③同族）。 */
	pickOverlay(title: string, items: string[]): Promise<number | undefined> {
		if (this.pendingUi?.kind === "pick") this.pendingUi.resolve(undefined);
		this.state.overlayOpen = false; // 与斜杠菜单互斥
		return new Promise((resolve) => {
			this.pendingUi = { kind: "pick", title, items, sel: 0, resolve };
			this.scheduler.requestImmediateRender();
		});
	}

	/** ask/askSecret 的全屏形态：输入行接管（提示语进输入框前缀；secret 盲显 •；Esc → undefined）。 */
	promptInput(question: string, secret: boolean): Promise<string | undefined> {
		if (this.pendingUi?.kind === "ask") this.pendingUi.resolve(undefined);
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

	private inputInsert(text: string): void {
		const s = this.state;
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

	private lastCtrlC = 0; // 双击退出窗口（Esc 同族惯例——claude-code 双击 Ctrl+C 退出）

	private onKey(key: string): void {
		const s = this.state;
		if (key === "ctrl+c") {
			// Ctrl+C 语义（F5 用户实测拍板：忙碌中按 Ctrl+C 是想停生成，整app退出被当成「崩了」）：
			// 忙碌 = 取消当前 turn（SIGINT 同效）；空闲 = 2s 内再按一次才退出，首按给提示
			if (s.busy) {
				this.lastCtrlC = 0;
				this.io.requestCancel();
			} else if (Date.now() - this.lastCtrlC < 2000) {
				this.io.requestExit();
			} else {
				this.lastCtrlC = Date.now();
			}
			this.scheduler.requestImmediateRender();
			return;
		}
		if (key === "ctrl+t") {
			this.io.requestLineMode();
			return;
		}
		if (key === "alt+e") {
			this.io.toggleThink();
			this.scheduler.requestImmediateRender();
			return;
		}
		if (key === "alt+v") {
			this.io.requestPasteImage?.(); // F5 二轮⑬——全屏期 Alt+V 由 FullApp 接管（readline 侧已让位）
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
				else if (key === "escape" || key === "enter" || key === "q") this.pendingUi = undefined;
				this.scheduler.requestImmediateRender();
				return;
			}
			if (pu.kind === "pick") {
				if (key === "up" && pu.items.length > 0) pu.sel = (pu.sel - 1 + pu.items.length) % pu.items.length;
				else if (key === "down" && pu.items.length > 0) pu.sel = (pu.sel + 1) % pu.items.length;
				else if (key === "pageUp" && pu.items.length > 0) pu.sel = Math.max(0, pu.sel - OVERLAY_PAGE);
				else if (key === "pageDown" && pu.items.length > 0) pu.sel = Math.min(pu.items.length - 1, pu.sel + OVERLAY_PAGE);
				else if (key === "enter") {
					this.pendingUi = undefined;
					pu.resolve(pu.sel);
				} else if (key === "escape") {
					this.pendingUi = undefined;
					pu.resolve(undefined);
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
			} else if (key === "escape") {
				this.pendingUi = undefined;
				pu.resolve(undefined);
			} else {
				this.onEditKey(key);
				return;
			}
			this.scheduler.requestImmediateRender();
			return;
		}

		if (key === "escape") {
			if (s.busy) {
				this.io.requestCancel(); // AI 回答中 Esc = 取消当前 turn（SIGINT 同效——修复轮①）
				this.scheduler.requestImmediateRender();
				return;
			}
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
			s.focusIdx = ((s.focusIdx + 1) % 3) as FocusIdx;
		} else if (key === "shift+tab") {
			this.io.submit(this.io.panelData().permissionNext());
			return;
		} else if (key === "pageUp") {
			s.scrollBack += Math.max(1, this.io.rows() - 10);
		} else if (key === "pageDown") {
			s.scrollBack = Math.max(0, s.scrollBack - Math.max(1, this.io.rows() - 10));
		} else if (s.focusIdx === 1) {
			const mods = this.io.panelData().modules;
			if (key === "up" || key === "down") {
				s.moduleSel = Math.max(0, Math.min(mods.length - 1, s.moduleSel + (key === "up" ? -1 : 1)));
			} else if (key === "shift+up" || key === "shift+down") {
				s.moduleSel = Math.max(0, Math.min(mods.length - 1, s.moduleSel + (key === "shift+up" ? -5 : 5)));
			} else if (key === "shift+left" || key === "shift+right") {
				s.statePage = s.statePage === 0 ? 1 : 0;
			}
		} else if (s.focusIdx === 2) {
			const tasks = this.io.panelData().tasks;
			if (key === "up" || key === "down") {
				s.taskSel = Math.max(0, Math.min(tasks.length - 1, s.taskSel + (key === "up" ? -1 : 1)));
			} else if (key === "shift+pageUp" || key === "shift+pageDown") {
				s.taskSel = Math.max(0, Math.min(tasks.length - 1, s.taskSel + (key === "shift+pageUp" ? -5 : 5)));
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
				const cmd = level2 ? `${s.overlayCmd} ${picked}` : picked;
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
				if (!this.deleteSelection() && s.cursor > 0) {
					const cp = s.input.codePointAt(s.cursor - 1)!;
					const w = cp >= 0xd800 && cp <= 0xdbff ? 2 : 1;
					s.input = s.input.slice(0, s.cursor - w) + s.input.slice(s.cursor);
					s.cursor -= w;
				}
				break;
			case "delete":
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
				s.selAnchor = -1;
				const rows = layoutInputRows(s.input, this.inputInnerW());
				const cur = locateCursor(rows, s.cursor);
				const target = cur.row + (key === "up" ? -1 : 1);
				if (target < 0) {
					if (s.historyIdx > 0) {
						s.historyIdx--;
						s.input = s.history[s.historyIdx]!;
						s.cursor = s.input.length;
					}
				} else if (target >= rows.length) {
					if (s.historyIdx < s.history.length) {
						s.historyIdx++;
						s.input = s.history[s.historyIdx] ?? "";
						s.cursor = s.input.length;
					}
				} else {
					s.cursor = indexAtRowCol(rows, target, cur.col);
				}
				break;
			}
			default:
				if (isPrintable(key)) {
					this.inputInsert(key);
					if (normCmd(s.input) === "/" && !s.overlayOpen) {
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
		this.attachments = []; // 附件 chip 随提交清空（宿主侧文件列表同步清——F5 二轮⑬）
		s.history.push(text);
		s.historyIdx = s.history.length;
		s.input = "";
		s.cursor = 0;
		s.inputScroll = 0;
		s.selAnchor = -1;
		this.io.submit(text);
	}

	private filteredCommands(): SlashItem[] {
		const q = normCmd(this.state.input).slice(1).split(" ")[0]!;
		return this.io.slashCommands().filter((c) => c.name.startsWith("/" + q));
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
		if (this.pendingUi?.kind === "pick") return theme.fg("info", "● 等待选择——↑↓ 移动 · Enter 选定 · Esc 取消");
		if (s.busy) {
			const queued = this.queuedCount > 0 ? theme.fg("info", ` · 已排队 ${this.queuedCount} 条（回答结束后执行）`) : "";
			return `${theme.fg("accent", SPIN_FRAMES[s.spinIdx]!)} ${theme.fg("muted", "正在生成…")}${queued}`;
		}
		if (Date.now() - this.lastCtrlC < 2000) return theme.fg("warn", "再按一次 Ctrl + C 退出（Esc 返回输入）");
		return theme.dim("正在待命");
	}

	private panelBox(title: string, en: string, focused: boolean, w: number, h: number, content: string[], hints: string[], footer?: string[]): string[] {
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
		while (rows.length < h - 2 - footRows.length - hints.length) rows.push(pane(""));
		for (const l of footRows) rows.push(pane(l));
		for (const hl of hints) rows.push(pane(theme.dim(" " + hl)));
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
		const name = m.state === "off" ? theme.fg("muted", m.name) : selected ? theme.fg("accent", m.name) : m.name;
		const stateText = m.locked ? "锁定" : MOD_STATE_TEXT[m.state]!;
		const st = m.locked || m.state === "mounted" ? theme.fg("accent", stateText) : m.state === "loading" ? theme.fg("warn", stateText) : theme.dim(stateText);
		const descBudget = w - (3 + visibleWidth(m.name) + 1 + visibleWidth(stateText) + 1);
		const desc = descBudget >= visibleWidth(m.desc) ? theme.dim(m.desc) : descBudget >= 8 ? truncateToWidth(theme.dim(m.desc), descBudget) : "";
		const leftW = 3 + visibleWidth(m.name) + (desc === "" ? 0 : 1 + visibleWidth(desc));
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
			const slots = 5;
			const pages = Math.max(1, Math.ceil(d.modules.length / slots));
			const page = Math.min(pages - 1, Math.floor(s.moduleSel / slots));
			const lo = page * slots;
			const headL = ` ${theme.fg("muted", "模块挂载")}`;
			const headR = theme.dim(`${page + 1}/${pages} · MODULES`);
			content.push(headL + " ".repeat(Math.max(1, inner - visibleWidth(headL) - visibleWidth(headR))) + headR);
			for (let i = lo; i < Math.min(d.modules.length, lo + slots); i++) {
				content.push(this.modRow(d.modules[i]!, focused && i === s.moduleSel, inner));
			}
			return this.panelBox("运行状态", "1/2", focused, w, h, content, ["Shift + ←→ 翻页", "Shift + ↑↓ 翻页 · Enter 挂载/卸载"], [this.sep(inner)]);
		}
		const content: string[] = [
			` ${theme.fg("muted", "（健康探测数据源未就绪——如实登记：框架化方案书缺口项）")}`,
		];
		return this.panelBox("网络 · MCP", "2/2", focused, w, h, content, ["Shift + ←→ 返回运行状态 · Esc 返回"], [this.sep(inner)]);
	}

	private taskRows(w: number, h: number): string[] {
		const s = this.state;
		const d = this.io.panelData();
		const focused = s.focusIdx === 2;
		const inner = w - 2;
		const done = d.tasks.filter((t) => t.state === "done").length;
		const slots = Math.max(2, h - 6);
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
		const footer = [this.sep(inner), footL + " ".repeat(Math.max(1, inner - visibleWidth(footL) - visibleWidth(footR))) + footR];
		return this.panelBox("任务清单", `${page + 1}/${pages}`, focused, w, h, content, ["Shift + PgUp/PgDn 翻页 · Esc 返回"], footer);
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
		const sidebarW = this.sidebarW();
		const leftW = cols - sidebarW - 2;

		const innerW = Math.max(8, leftW - 4);
		const inputRows = layoutInputRows(s.input, innerW);
		const cursorPos = locateCursor(inputRows, s.cursor);
		const showRows = Math.min(INPUT_MAX_ROWS, inputRows.length);
		const chipRows = this.attachments.length > 0 ? 1 : 0; // 图片附件 chip 行（F5 二轮⑬）
		const inputH = showRows + 3 + chipRows;
		const streamH = rows - inputH;

		const statusH = Math.max(8, Math.floor(rows * 0.55));
		const taskH = rows - statusH;
		const status = this.statusRows(sidebarW, statusH);
		const tasks = this.taskRows(sidebarW, taskH);

		const doc = [...this.io.doc(), this.tailLine()];
		const maxScroll = Math.max(0, doc.length - streamH);
		s.scrollBack = Math.min(s.scrollBack, maxScroll);
		const end = doc.length - s.scrollBack;
		const start = Math.max(0, end - streamH);

		const inputFocused = s.focusIdx === 0;
		const ibc = inputFocused ? "accent" : "border";
		const screen: string[] = new Array(rows).fill("");
		for (let r = 0; r < streamH; r++) {
			screen[r] = padToWidth(doc[start + r] ?? "", leftW);
		}
		const divRow = streamH;
		// 模块询问挂起期：问题写进输入框顶边标题（F5——placeholder 只在空输入时可见，用户一打字问题就消失）
		if (this.pendingUi?.kind === "ask") {
			const qSeg = theme.fg("accent", ` ${this.pendingUi.question} `);
			const qFill = Math.max(1, leftW - 4 - visibleWidth(qSeg));
			screen[divRow] = theme.fg(ibc, "╭─") + qSeg + theme.fg(ibc, "─".repeat(qFill) + "╮");
		} else {
			screen[divRow] = theme.fg(ibc, "╭" + "─".repeat(Math.max(1, leftW - 2)) + "╮");
		}

		const sel = this.selRange();
		const paneIn = (l: string) => theme.bg("surface2", theme.fg(ibc, "│") + padToWidth(l, leftW - 2) + theme.fg(ibc, "│"));
		if (chipRows > 0) {
			screen[divRow + 1] = paneIn(` ${this.attachments.map((a2) => theme.fg("info", a2)).join(" ")}`);
		}
		for (let i = 0; i < showRows; i++) {
			const vr = inputRows[s.inputScroll + i];
			const prefix = i + s.inputScroll === 0 ? theme.fg("accent", "❯ ") : "  ";
			let line: string;
			if (vr === undefined) {
				line = prefix;
			} else if (s.input !== "" && this.pendingUi?.kind === "ask" && this.pendingUi.secret) {
				line = prefix + "•".repeat(vr.text.length);
			} else if (s.input === "" && i === 0) {
				const ph = this.pendingUi?.kind === "ask" ? this.pendingUi.question : "向 Orosus 下达指令，或输入 / 查看命令…";
				line = prefix + theme.dim(ph);
			} else {
				line = prefix + this.styleWithSelection(vr, sel);
			}
			screen[divRow + 1 + chipRows + i] = paneIn(inputFocused ? line : theme.dim(line));
		}
		const d = this.io.panelData();
		const chip = theme.fg("accent", `◆ ${PERM_LABEL[d.permission] ?? d.permission}`);
		const leftHint = `${chip}${theme.dim(" · Shift + Tab 切换模式")}`;
		const rightHint = theme.dim("Enter 发送 · Alt + Enter 换行 · / 命令 · Tab 面板焦点 · Esc 返回");
		const hintW = leftW - 2;
		const gap = hintW - visibleWidth(leftHint) - visibleWidth(rightHint) - 1;
		screen[divRow + 1 + chipRows + showRows] = paneIn(
			gap > 2 ? ` ${leftHint}${" ".repeat(gap)}${rightHint}` : padToWidth(` ${leftHint}`, hintW),
		);
		screen[divRow + 2 + chipRows + showRows] = theme.fg(ibc, "╰" + "─".repeat(Math.max(1, leftW - 2)) + "╯");

		for (let r = 0; r < rows; r++) {
			const sep = theme.fg("border", "│");
			const right = r < statusH ? (status[r] ?? "") : (tasks[r - statusH] ?? "");
			screen[r] = (screen[r] ?? "") + sep + right;
		}

		let overlay: OverlayFrame | undefined;
		if (this.pendingUi?.kind === "pick") {
			const pu = this.pendingUi;
			overlay = this.buildPickOverlay(leftW, divRow, pu.title, pu.items, pu.sel);
		} else if (this.pendingUi?.kind === "view") {
			const pu = this.pendingUi;
			overlay = this.buildViewOverlay(leftW, divRow, pu.title, pu.lines, pu.scroll);
		} else if (s.overlayOpen) {
			overlay = this.buildOverlay(leftW, divRow);
		}

		const bytes = this.full.render(screen, rows, cols, overlay);
		this.full.placeCursor(divRow + 1 + chipRows + (cursorPos.row - s.inputScroll), 3 + cursorPos.col, inputFocused);
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
	private buildPickOverlay(leftW: number, divRow: number, title: string, items: string[], sel: number): OverlayFrame {
		const ow = leftW;
		const oInner = ow - 2;
		const bc = "accent";
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
		const olines: string[] = [];
		const titleSeg = theme.fg("accent", ` ${title} `);
		const topFill = Math.max(1, ow - 4 - visibleWidth(titleSeg));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + titleSeg + theme.fg(bc, "─".repeat(topFill)) + theme.fg(bc, "─╮")));
		olines.push(boxRow(""));
		const selI = Math.max(0, Math.min(items.length - 1, sel));
		const winStart = Math.max(0, Math.min(Math.max(0, items.length - OVERLAY_PAGE), selI - OVERLAY_PAGE + 1));
		const win = items.slice(winStart, winStart + OVERLAY_PAGE);
		if (winStart > 0) olines.push(boxRow(theme.dim(`   ↑ 还有 ${winStart} 项`)));
		for (let i = 0; i < win.length; i++) {
			const gi = winStart + i;
			const row = ` ${gi === selI ? theme.fg("accent", "❯") : " "} ${win[i]!}`;
			olines.push(gi === selI ? boxRow(theme.bg("accentSoft", padToWidth(row, oInner - 1))) : boxRow(row));
		}
		const rest = items.length - winStart - win.length;
		if (rest > 0) olines.push(boxRow(theme.dim(`   ↓ 还有 ${rest} 项`)));
		olines.push(boxRow(theme.dim(" ↑↓ 选择 · Enter 选定 · Esc 取消")));
		olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(oInner) + "╯")));
		return { lines: olines, row: Math.max(0, divRow - olines.length), col: 0, width: ow };
	}

	private buildOverlay(leftW: number, divRow: number): OverlayFrame {
		const s = this.state;
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
		olines.push(boxRow(""));
		let items: { text: string; mark: string; long: string }[];
		if (level2) {
			const current = this.io.slashCurrent(s.overlayCmd);
			items = (this.io.slashCommands().find((c) => c.name === s.overlayCmd)?.children ?? []).map((c) => ({
				text: c,
				mark: c === current ? theme.fg("accent", "✓") : " ",
				long: `${s.overlayCmd} 二级项：${c}——回车选定。`,
			}));
		} else {
			const real = this.filteredCommands();
			items =
				real.length === 0
					? [{ text: theme.dim("无匹配命令"), mark: " ", long: "没有以该前缀开头的命令。继续输入或删除字符修改前缀，Esc 关闭菜单。" }]
					: real.map((c) => ({
							text: `${c.name} ${theme.dim(c.desc)}`,
							mark: " ",
							long: c.long,
						}));
		}
		const selI = Math.max(0, Math.min(items.length - 1, s.overlaySel));
		const winStart = Math.max(0, Math.min(Math.max(0, items.length - OVERLAY_PAGE), selI - OVERLAY_PAGE + 1));
		const win = items.slice(winStart, winStart + OVERLAY_PAGE);
		if (winStart > 0) olines.push(boxRow(theme.dim(`   ↑ 还有 ${winStart} 项`)));
		for (let i = 0; i < win.length; i++) {
			const it = win[i]!;
			const gi = winStart + i;
			const selPrefix = gi === selI ? theme.fg("accent", "❯") : " ";
			const markSeg = it.mark === " " ? "" : `${it.mark} `;
			const row = ` ${selPrefix} ${markSeg}${it.text}`;
			olines.push(gi === selI ? boxRow(theme.bg("accentSoft", padToWidth(row, oInner - 1))) : boxRow(row));
		}
		const rest = items.length - winStart - win.length;
		if (rest > 0) olines.push(boxRow(theme.dim(`   ↓ 还有 ${rest} 项`)));
		const longLines = wrapText(theme.dim(items[selI]?.long ?? ""), oInner - 2).map((l) => ` ${l}`);
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
