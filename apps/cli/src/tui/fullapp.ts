/** 全屏应用骨架（TUI 批阶段三 F3——原型图主形态落地；v1.1–v1.11 走查拍板口径）。
 *  布局：无标题栏（首行即内容）+ 左栏（stream 滚动区 + 输入框带框多行〔F5 完成选择/菜单〕）+
 *  右栏 `min(40, ⌊cols×0.28⌋)` ≥100 列保底 34（静态占位面板——F4 接真实数据）+ 末列整列留白
 *  （conhost 无 DECAWM 的右角格防御——fullscreen.ts 同款）。
 *  键位（F3 面）：Tab 焦点循环 输入→模块→任务（聚焦面板青玉框）/ Shift+Tab 权限 chip /
 *  PgUp·PgDn 滚动 stream / Esc 返回输入 / Ctrl+T 请求切回滚动流 / Ctrl+C 请求退出。
 *  崩溃恢复（spike 判据 4 同款）：exit 钩子同步直写恢复序列 + uncaughtException 先恢复再抛。
 *  输入编辑器 F3 最小面：单行编辑 + 历史 + 光标/插入/删除/左右/Home/End + bracketed paste；
 *  多行 ≤5/选择/斜杠菜单 = F5。面板交互（↑↓ 选中/翻页/Shift+←→ 双页）= F4 随数据接线。 */

import { writeSync } from "node:fs";
import { Term, type TermIO } from "./terminal.ts";
import { matchKey, isPrintable } from "./keymatch.ts";
import { FullScreen } from "./fullscreen.ts";
import { FrameScheduler } from "./scheduler.ts";
import { padToWidth, truncateToWidth, visibleWidth } from "./width.ts";
import * as theme from "../theme.ts";

/** 应用可见块（流区行数组的数据源——F2 streamview 块模型在全屏的对应物）。 */
export interface FullAppIO {
	columns(): number;
	rows(): number;
	/** stream 行源（DocModel.frameLines——渲染归本件，行源归投影器）。 */
	doc(): string[];
	/** 提交一行用户输入（返回后由 attachRender 的 chunk/event 驱动 stream 更新）。 */
	submit(text: string): void;
	/** 请求切回滚动流模式（Ctrl+T）。 */
	requestLineMode(): void;
	/** 请求退出（Ctrl+C——先恢复终端再退出）。 */
	requestExit(): void;
}

interface AppState {
	input: string;
	cursor: number;
	history: string[];
	historyIdx: number;
	focusIdx: number; // 0=输入 1=模块 2=任务
	scrollBack: number;
	permissionIdx: number;
	busy: boolean;
	spinIdx: number;
}

const PERMISSIONS = ["read-only", "accept-edits", "yolo"];
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 全屏应用：stream 行源由外部（projector）推进 pushDoc，输入经 io.submit 上交。 */
export class FullApp {
	private term: Term;
	private full: FullScreen;
	private scheduler: FrameScheduler;
	private state: AppState;
	private busyTimer: NodeJS.Timeout | undefined;
	private stopped = false;

	private io: FullAppIO;

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
			history: [],
			historyIdx: 0,
			focusIdx: 0,
			scrollBack: 0,
			permissionIdx: 0,
			busy: false,
			spinIdx: 0,
		};
	}



	private tailLine(): string {
		const s = this.state;
		return s.busy
			? `${theme.fg("accent", SPIN_FRAMES[s.spinIdx]!)} ${theme.fg("muted", "正在生成…")}`
			: theme.dim("正在待命");
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

	start(): void {
		this.full.enter();
		this.term.start();
		this.term.onInput((seq) => this.onKey(matchKey(seq)));
		this.term.onPaste((text) => {
			this.insert(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
			this.scheduler.requestImmediateRender();
		});
		this.term.onResize(() => this.scheduler.requestRender());
		this.scheduler.requestRender();
		this.installCrashHooks();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.busyTimer) clearInterval(this.busyTimer);
		this.scheduler.stop();
		if (this.full.isActive) this.full.exit();
		this.term.stop();
	}

	// ---------- 按键 ----------

	private onKey(key: string): void {
		const s = this.state;
		if (key === "ctrl+c") {
			this.io.requestExit();
			return;
		}
		if (key === "ctrl+t") {
			this.io.requestLineMode();
			return;
		}
		if (key === "tab") {
			s.focusIdx = (s.focusIdx + 1) % 3;
		} else if (key === "shift+tab") {
			s.permissionIdx = (s.permissionIdx + 1) % PERMISSIONS.length;
		} else if (key === "escape") {
			s.focusIdx = 0;
		} else if (key === "pageUp") {
			s.scrollBack += Math.max(1, this.io.rows() - 8);
		} else if (key === "pageDown") {
			s.scrollBack = Math.max(0, s.scrollBack - Math.max(1, this.io.rows() - 8));
		} else if (s.focusIdx !== 0) {
			// F3 面板交互未接（F4 随数据接线）——焦点键位先消化，不产生编辑副作用
		} else {
			this.onEditKey(key);
			return;
		}
		this.scheduler.requestImmediateRender();
	}

	private onEditKey(key: string): void {
		const s = this.state;
		switch (key) {
			case "enter":
				if (s.input !== "") {
					const text = s.input;
					s.history.push(text);
					s.historyIdx = s.history.length;
					s.input = "";
					s.cursor = 0;
					this.io.submit(text);
				}
				break;
			case "backspace":
				if (s.cursor > 0) {
					s.input = s.input.slice(0, s.cursor - 1) + s.input.slice(s.cursor);
					s.cursor--;
				}
				break;
			case "delete":
				s.input = s.input.slice(0, s.cursor) + s.input.slice(s.cursor + 1);
				break;
			case "left":
				s.cursor = Math.max(0, s.cursor - 1);
				break;
			case "right":
				s.cursor = Math.min(s.input.length, s.cursor + 1);
				break;
			case "home":
				s.cursor = 0;
				break;
			case "end":
				s.cursor = s.input.length;
				break;
			case "up":
				if (s.historyIdx > 0) {
					s.historyIdx--;
					s.input = s.history[s.historyIdx]!;
					s.cursor = s.input.length;
				}
				break;
			case "down":
				if (s.historyIdx < s.history.length) {
					s.historyIdx++;
					s.input = s.history[s.historyIdx] ?? "";
					s.cursor = s.input.length;
				}
				break;
			default:
				if (isPrintable(key)) this.insert(key);
		}
		this.scheduler.requestImmediateRender();
	}

	private insert(text: string): void {
		const s = this.state;
		s.input = s.input.slice(0, s.cursor) + text + s.input.slice(s.cursor);
		s.cursor += text.length;
	}

	// ---------- 布局与渲染 ----------

	private sidebarW(): number {
		const cols = this.io.columns();
		return cols >= 100 ? Math.min(40, Math.max(34, Math.floor(cols * 0.28))) : Math.min(40, Math.floor(cols * 0.28));
	}

	private panelBox(title: string, en: string, focused: boolean, w: number, h: number, content: string[], hint: string): string[] {
		const bc = focused ? "accent" : "border";
		const inner = w - 2;
		const titleSeg = focused ? theme.fg("accent", ` ${title} `) : theme.fg("muted", ` ${title} `);
		const enSeg = theme.dim(` ${en} `);
		const titleW = visibleWidth(titleSeg);
		const enBudget = Math.max(4, w - 4 - titleW - 1);
		const enFit = truncateToWidth(enSeg, enBudget);
		const fill = Math.max(1, w - 4 - titleW - visibleWidth(enFit));
		const top = theme.fg(bc, "╭─") + titleSeg + theme.fg(bc, "─".repeat(fill)) + enFit + theme.fg(bc, "─╮");
		const pane = (l: string) => theme.bg("surface", theme.fg(bc, "│") + padToWidth(l, inner) + theme.fg(bc, "│"));
		const rows: string[] = [top, pane("")];
		for (const l of content) rows.push(pane(l));
		while (rows.length < h - 2) rows.push(pane(""));
		rows.push(pane(theme.dim(" " + hint)));
		rows.push(theme.fg(bc, "╰" + "─".repeat(inner) + "╯"));
		return rows.slice(0, h);
	}

	/** F3 静态占位面板（F4 接真实数据源）。 */
	private statusRows(w: number, h: number): string[] {
		return this.panelBox("运行状态", "1/2", this.state.focusIdx === 1, w, h, [
			` ${theme.fg("muted", padToWidth("模型", 8))} ${theme.fg("info", "…（F4 接线）")}`,
			` ${theme.fg("muted", padToWidth("会话", 8))} …`,
			` ${theme.fg("muted", padToWidth("工作目录", 8))} …`,
			` ${theme.fg("muted", padToWidth("Tokens", 8))} …`,
			theme.fg("border", " " + "┄".repeat(Math.max(2, w - 4))),
			` ${theme.fg("muted", "模块挂载")}`,
			` ${theme.fg("muted", "（F4 接线后显示真实挂载清单）")}`,
		], "Shift+↑↓ 翻页 · Enter 挂载/卸载");
	}

	private taskRows(w: number, h: number): string[] {
		return this.panelBox("任务清单", "1/1", this.state.focusIdx === 2, w, h, [
			` ${theme.fg("muted", "（F4 接线后显示 todo 任务）")}`,
		], "由 Agent 实时同步");
	}

	private renderFrame(): number {
		const cols = this.io.columns();
		const rows = this.io.rows();
		const s = this.state;
		const sidebarW = this.sidebarW();
		const leftW = cols - sidebarW - 2;

		const inputH = 3; // 顶框 + 输入行 + 底框（提示行折进输入行——F5 多行扩展时重排）
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
		screen[divRow] = theme.fg(ibc, "╭" + "─".repeat(Math.max(1, leftW - 2)) + "╮");
		const paneIn = (l: string) => theme.bg("surface2", theme.fg(ibc, "│") + padToWidth(l, leftW - 2) + theme.fg(ibc, "│"));
		const chip = theme.fg("accent", `◆ ${PERMISSIONS[s.permissionIdx]}`);
		const prompt = theme.fg("accent", "❯ ");
		const placeholder = s.input === "" ? theme.dim("向 Orosus 下达指令，或输入 / 查看命令…") : truncateToWidth(s.input, leftW - 8);
		const chipLine = `${prompt}${placeholder}${" ".repeat(Math.max(1, leftW - 4 - visibleWidth(placeholder) - visibleWidth(chip) - 2))}${chip}`;
		screen[divRow + 1] = paneIn(inputFocused ? chipLine : theme.dim(chipLine));
		screen[divRow + 2] = theme.fg(ibc, "╰" + "─".repeat(Math.max(1, leftW - 2)) + "╯");

		for (let r = 0; r < rows; r++) {
			const sep = theme.fg("border", "│");
			const right = r < statusH ? (status[r] ?? "") : (tasks[r - statusH] ?? "");
			screen[r] = (screen[r] ?? "") + sep + right;
		}

		const bytes = this.full.render(screen, rows, cols);
		this.full.placeCursor(divRow + 1, 2 + visibleWidth(s.input.slice(0, s.cursor)), inputFocused);
		return bytes;
	}

	// ---------- 崩溃恢复（spike 判据 4 同款） ----------

	private installCrashHooks(): void {
		process.on("exit", () => {
			try {
				writeSync(1, "\x1b[?25h\x1b[?2004l\x1b[?7h" + (this.full.isActive ? "\x1b[?1049l" : ""));
			} catch {
				/* noop */
			}
		});
		process.on("uncaughtException", (err) => {
			try {
				if (this.full.isActive) this.full.exit();
				this.term.stop();
				writeSync(1, "\x1b[?25h\x1b[?2004l\x1b[?7h");
			} catch {
				/* 恢复尽力而为 */
			}
			throw err;
		});
	}
}
