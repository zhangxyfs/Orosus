/** 全屏应用（TUI 批阶段三 F3–F5——原型完整交互面落地；v1.1–v1.11 走查拍板口径）。
 *  布局：无标题栏 + 左栏（stream 滚动区 + 输入框带框多行 ≤5 行超出上滚）+ 右栏双面板
 *  （运行状态/任务清单，真实数据经 io.panelData）+ 末列整列留白（conhost DECAWM 防御）。
 *  交互：Tab 焦点循环（聚焦面板青玉框；面板聚焦裸键直控〔2026-09-24 拍板，不再借道 Shift〕：←→ 翻页 / PgUp·PgDn 模块·任务翻页 / ↑↓ 选择 / Enter 挂卸）/
 *  Shift+Tab 权限循环 / Esc 忙碌时双击停生成（单击 toast 提示防误触）、闲时返回输入 /
 *  斜杠菜单全宽浮层（每页 10 条窗口跟随/「还有 N 项」/二级列表 ✓ 当前值/空过滤占位不关窗/长说明）/
 *  输入多行 ≤5 + Alt+Enter / Shift+Enter 换行 + Ctrl+A 全选 + Shift+←→ 选择 + bracketed paste / Alt+E 思考折叠 / Alt+O 工具明细折叠 / Alt+F 失败体折叠。
 *  Ctrl+C 全屏期不占用（2026-09-23 用户拍板——WT 原生复制让位；退出走 /quit，停生成走双击 Esc）。
 *  崩溃恢复（spike 判据 4）：exit 钩子同步直写恢复序列 + uncaughtException 先恢复再抛。
 *  鼠标接管关闭（用户拍板 2026-09-21——重开 = fullscreen.ts ENTER_ALT 追加 ?1000/?1006）。 */

import { writeSync } from "node:fs";
import { writeClipboardText, openUrl } from "../paste.ts";
import { Term, type TermIO } from "./terminal.ts";
import { matchKey, isPrintable } from "./keymatch.ts";
import { FullScreen, CRASH_RESTORE, type OverlayFrame } from "./fullscreen.ts";
import { FrameScheduler } from "./scheduler.ts";
import { padToWidth, osc8LinkAtColumn, sliceByColumn, stripAnsi, truncateToWidth, visibleWidth, wrapText } from "./width.ts";
import { parseWheel, parseButton, isMouseSequence, type WheelEvent, type ButtonEvent } from "./mouse.ts";
import { OnboardingSession, type OnboardingDeps, type OnboardingOutcome } from "./onboarding.ts";
import { resolvePopupLayout } from "./popuplayout.ts";
import { renderWidgetLines, renderWidgets } from "./widgets.ts";
import type { DialogEvent, DialogHandle, DialogSpec, PopupKey, PopupLayout, WidgetSpec } from "@orosus/contracts/module";
import { pickLabel } from "../picker.ts";
import * as theme from "../theme.ts";
import { subagentCountHint } from "../subagent-status.ts";
import {
	ALT_WHEEL_MULTIPLIER, CONN_SLOTS, CONN_STATE_TEXT, DIAG_LIST_ROWS, diagListLines, DOUBLE_CLICK_INTERVAL_MS,
	elapsedText, indexAtRowCol, INPUT_MAX_ROWS, isSubseq, layoutInputRows, locateCursor, MOD_STATE_TEXT, MODULE_SLOTS,
	msText, normCmd, OVERLAY_PAGE, PERM_LABEL, SIDEBAR_SWITCH_COOLDOWN_MS, SPIN_FRAMES, taskTick, thumbGeometry,
	WHEEL_STEP, wordRangeAt,
	type AppState, type DialogKeyCtx, type FocusIdx, type FullAppIO, type HostDialogKeys, type InputRow,
	type ModuleCard, type PanelData, type PickExtraKeys, type SlashItem,
} from "./fullapp-types.ts";

// 类外段（接缝类型/AppState/常量/纯函数）已出仓 fullapp-types.ts（m5-split-fullapp T2）；
// 消费方九文件仍经本件 import——转出口维持不动（D3 消费方零改动）。
export * from "./fullapp-types.ts";

export class FullApp {
	private io: FullAppIO;
	private term: Term;
	private full: FullScreen;
	private scheduler: FrameScheduler;
	private state: AppState;
	private busyTimer: NodeJS.Timeout | undefined;
	private watchdogTimer: NodeJS.Timeout | undefined;
	private tickTimer: NodeJS.Timeout | undefined;
	private toastTimer: NodeJS.Timeout | undefined; // CTU-03：toast 自消定时器统一登记（顶替即清）
	private toastSeq = 0; // CTU-03：toast 身份令牌序列（定时器闭包捕获 id，与时长解耦）
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
			taskPage: 0,
			connPage: 0,
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
			diagReturn: false,
			toast: undefined,
			mselAnchor: undefined,
			mselFocus: undefined,
			selGranularity: "character",
			selInitialRange: undefined,
			lastClick: undefined,
			pressedUrl: undefined,
			autoScrollDir: 0,
			autoScrollTimer: undefined,
			dragPointer: undefined,
			scrollbarDrag: undefined,
			scrollbarHover: undefined,
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
		return Math.max(8, this.io.columns() - sidebarW - 3);
	}

	/** 忙碌探针（F5 四轮：宿主排队判定用）。 */
	get isBusy(): boolean {
		return this.state.busy;
	}

	/** 视口行区间探针（m5-render-perf T7 阅读保护）：layoutFrame 投影——main.ts 注入
	 *  DocModel.viewportProbe，裁剪时判被裁段与视口相交则整批顺延。 */
	viewportRange(): { start: number; end: number } {
		const { streamH, start, dmTotal } = this.layoutFrame();
		return { start, end: Math.min(dmTotal, start + streamH) };
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
		this.term.onInput((seq) => {
			// 鼠标分流（m5 鼠标批 T2/T4）：滚轮走 onWheel 路由；按钮事件（按下/拖动/松开）交
			// onButton 处理器（T5 起填肉——此间空挂安全吞）；其余鼠标序列整吞（kimi :708 同款）
			const wheel = parseWheel(seq);
			if (wheel !== undefined) {
				this.onWheel(wheel);
				return;
			}
			const button = parseButton(seq);
			if (button !== undefined) {
				this.onButton(button);
				return;
			}
			if (isMouseSequence(seq)) return;
			this.onKey(matchKey(seq));
		});
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
		this.stopAutoScroll(); // 拖选自动滚定时器不随实例陪葬（T9）
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
			if (pu.kind === "pick" || pu.kind === "ask") pu.resolve(undefined); // view/dialog 无 promise 可结
		}
		// 暂存队列一并排空（批③②——thunk 内自查 stopped 即 resolve(undefined)，promise 不永挂）
		for (const q of this.uiQueue.splice(0)) q.run();
		if (this.busyTimer) clearInterval(this.busyTimer);
		if (this.watchdogTimer) clearInterval(this.watchdogTimer);
		if (this.tickTimer) clearInterval(this.tickTimer);
		if (this.toastTimer) clearTimeout(this.toastTimer); // CTU-03：toast 自消定时器随实例停止清理
		this.scheduler.stop();
		if (this.full.isActive) this.full.exit();
		this.term.stop();
		if (FullApp.activeInstance === this) FullApp.activeInstance = undefined;
	}

	/** 子代理在册可见（M4.5 T14 / 2026-09-27 改版）：宿主直判口或有后台在跑——空闲双击 Esc 的全停门槛。 */
	private subagentsVisible(): boolean {
		return this.io.subagentActive?.() === true || (this.io.subagentRunningCount?.() ?? 0) > 0;
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

	/** 侧栏开关公共出口（m5 T11，候选 A-4「Ctrl+T 的程序化版本」）：toggle + 持久化回调 + 重画三件套——
	 *  Ctrl+T 与设置服务（ctx.settings.setSidebar）两处共用。
	 *  m5-render-perf T5（D8 两道护栏 + 契约加宽 Promise<boolean>）：
	 *  - busy 拒绝：生成中返回 false（宽度变化全量重折的尖峰削频——键路 Ctrl+T 预检发 toast）；
	 *  - 500ms 冷却：最近一次成功切换后冷却期内重复切换静默忽略（不发 toast——连击多为误操作）；
	 *  - 幂等短路：已在目标态 = 无事可做即已达成，返回 true。 */

	/** 重画一帧（m5 T12：设置服务切主题后的刷帧口——新渲染面用新色，历史行旧色不重刷是预期披露）。 */
	repaint(): void {
		this.scheduler.requestImmediateRender();
	}

	setSidebar(visible: boolean): boolean {
		const s = this.state;
		if (s.busy) return false; // 护栏①：生成中拒绝（想调宽度等本轮结束）
		if (s.sidebarVisible === visible) return true; // 幂等短路亦 true
		if (Date.now() - this.lastSidebarSwitch < SIDEBAR_SWITCH_COOLDOWN_MS) return false; // 护栏②：冷却静默吞
		s.sidebarVisible = visible; // 显示/隐藏右侧两个面板（用户拍板——比数据流互切有意义）
		if (!s.sidebarVisible) s.focusIdx = 0; // 面板隐藏——焦点回输入区
		this.lastSidebarSwitch = Date.now();
		this.io.onSidebarChange?.(s.sidebarVisible); // 持久化（F5 十二轮②）
		this.scheduler.requestImmediateRender();
		return true;
	}

	/** 侧栏切换冷却时间戳（护栏②——设计空白 #9：500ms）。 */
	private lastSidebarSwitch = Number.NaN;

	/** /compact 执行期标志（2026-09-23 用户拍板）：置位时 busy spinner 切「上下文压缩中…」石青（info）色。 */
	setCompacting(b: boolean): void {
		if (this.state.compacting === b) return;
		this.state.compacting = b;
		this.scheduler.requestRender();
	}

	// ---------- 全屏 CommandUi 适配面（choose → overlay 选择器；ask/askSecret → 输入行询问） ----------

	private pendingUi:
		| { kind: "pick"; title: string; items: string[]; sel: number; resolve: (n: number | undefined) => void; filter?: string; extraKeys?: PickExtraKeys }
		| { kind: "ask"; question: string; secret: boolean; prev: { input: string; cursor: number }; resolve: (v: string | undefined) => void }
		| { kind: "view"; title: string; text: string; lines: string[]; scroll: number; pinned?: boolean; layout?: PopupLayout | "dock"; keys?: Record<string, PopupKey>; owner?: string | undefined; live?: (() => string) | undefined; bottom?: boolean | undefined; viewPage?: number }
		| { kind: "dialog"; title: string; widgets: WidgetSpec[]; scroll: number; layout?: PopupLayout | "dock"; owner?: string | undefined; focusedId?: string | undefined; selById: Record<string, number>; inputById: Record<string, { text: string; cursor: number }>; onEvent?: DialogSpec["onEvent"]; hostKeys?: HostDialogKeys }
		| undefined;

	/** 挂起交互的 FIFO 暂存队列（批③② 审批互斥）：pendingUi 单槽占用期新到的 choose/ask 不再顶退——
	 *  顶退会把挂起的审批 resolve(undefined) = 静默否决；暂存后当前挂起结算即自动展开。
	 *  m5 T2（设计空白 8）：viewText 从「直接覆槽」并入本队列——连弹两窗后者等前者关（用户可见行为修正）。
	 *  m5 T7：队列项带 owner——closeModuleUi 时该模块的排队窗一并丢弃（不止在屏的）。 */
	private uiQueue: Array<{ run: () => void; owner?: string }> = [];

	/** 当前挂起结算后提升队首（无挂起才提——视图/选择/询问任一在位都等待）。 */
	private promoteUi(): void {
		if (this.pendingUi !== undefined) return;
		this.uiQueue.shift()?.run();
	}

	/** 弹窗保留键（决策点 7）：Esc/Ctrl+C/V/A/S/Z 绝对禁绑；宿主全局键在按键分发里先于弹窗分支消费
	 *  （fullapp onKey 全局拦截段），绑了永不触发——注册即拒并记日志。
	 *  走查④（2026-09-29）：alt+e/alt+o/alt+f 移出保留集——查看窗可注册（窗内优先，onKey 全局段
	 *  按 viewHasKey 让位）——子代理消息窗的内容快捷键与主窗一致即用此路。铁律只锁 Ctrl+T/E/O
	 *  （m5 UI 批「宿主全局键优先于模块窗自定义键」原样保持——这三键仍注册即拒）。alt+v 保留
	 *  （贴图全局功能，查看窗无占用场景）。 */
	private static readonly RESERVED_VIEW_KEYS = new Set([
		"escape", "ctrl+c", "ctrl+v", "ctrl+a", "ctrl+s", "ctrl+z",
		"ctrl+t", "ctrl+e", "ctrl+o", "ctrl+u", "alt+v",
	]);

	/** 剔除保留键并记日志（注册即拒——返回 undefined = 无合法键剩下）。 */
	private filterViewKeys(keys: Record<string, PopupKey> | undefined, owner: string | undefined): Record<string, PopupKey> | undefined {
		if (keys === undefined) return undefined;
		const kept: Record<string, PopupKey> = {};
		for (const [k, v] of Object.entries(keys)) {
			if (FullApp.RESERVED_VIEW_KEYS.has(k)) {
				this.io.logWarn?.("tui.viewkey.reserved", `弹窗自定义键被拒（保留键）：${k}`, owner !== undefined ? { owner, key: k } : { key: k });
				continue;
			}
			kept[k] = v;
		}
		return Object.keys(kept).length > 0 ? kept : undefined;
	}

	/** 只读文本浮层（F5 二轮⑪ / m5 T2 口子一）：几何走 resolvePopupLayout（缺省 center80 居中弹窗——
	 *  五旧窗随之统一新长相）、自定义键（保留键剔除）、排队化。too-small（连保底 8×3 都装不下）不弹窗、
	 *  黄字「终端窗口太小」（分析报告口子一 :125 的调用方行为）。
	 *  layout "dock"（m4-7 走查修，宿主内部值——模块契约 PopupLayout 不含）：贴输入框上缘 + 左栏同宽，
	 *  内容自适应封顶可滚（渲染期 buildViewOverlay 算几何，不走 resolvePopupLayout）。 */
	viewText(title: string, text: string, opts?: { layout?: PopupLayout | "dock"; keys?: Record<string, PopupKey>; owner?: string; live?: () => string; bottom?: boolean }): void {
		const open = (): void => {
			if (this.stopped) return;
			if (opts?.layout !== "dock") { // dock 不走居中几何——too-small 检查仅对弹窗布局有意义
				const geo = this.viewGeo(opts?.layout);
				if (geo.fallbackReason === "too-small") {
					this.showToast("终端窗口太小，弹窗未打开");
					this.promoteUi(); // 队列里的下一个照常提（本窗没占槽）
					return;
				}
			}
			const keys = this.filterViewKeys(opts?.keys, opts?.owner);
			const initLines = text.split("\n");
			this.state.overlayOpen = false; // 与斜杠菜单互斥
			this.pendingUi = {
				// bottom（2026-09-27 用户拍板：查看窗自动滚到底）——T1 pinned 重构：scroll 恒诚实值（0 起），
				// 贴底走显式标志每帧渲染钳到末页；旧「哨兵大数 + 渲染钳制」形态首按 ↑ 要连按
				// （哨兵 − 真实最大滚动）次才动（m5 鼠标批修的真 bug——滚轮/扫轮写字段前置）
				kind: "view", title, text, lines: initLines,
				scroll: 0,
				...(opts?.bottom === true ? { pinned: true } : {}), // 初值贴底——首帧渲染钳到末页
				...(opts?.layout !== undefined ? { layout: opts.layout } : {}),
				...(keys !== undefined ? { keys } : {}),
				...(opts?.owner !== undefined ? { owner: opts.owner } : {}),
				...(opts?.live !== undefined ? { live: opts.live } : {}), // M4.5 T11 查看窗实时流——每帧现调（1 秒 tick 自更）
				...(opts?.bottom === true ? { bottom: true } : {}),
			};
			this.scheduler.requestImmediateRender();
		};
		if (this.pendingUi !== undefined) {
			this.uiQueue.push({ run: open, ...(opts?.owner !== undefined ? { owner: opts.owner } : {}) });
			return;
		}
		open();
	}

	/** view 态的窗几何（渲染与按键翻页共用一源——两处漂移即滚动越界）。 */
	private viewGeo(layout: PopupLayout | "dock" | undefined): ReturnType<typeof resolvePopupLayout> {
		// dock 不走居中几何（渲染期 buildViewOverlay 另算）——viewGeo 调用方一律回 center80 缺省
		return resolvePopupLayout(this.io.columns(), this.io.rows(), layout === "dock" ? undefined : layout);
	}

	// ---------- 控件窗（m5 T7 口子三①——数据流三路：开窗快照 / onEvent 回新清单 / update 句柄） ----------

	/** 控件清单里的交互列表 id（只计 list——选中逻辑专用）。 */
	private dialogListIds(widgets: readonly WidgetSpec[]): string[] {
		const ids: string[] = [];
		for (const wd of widgets) if (wd.kind === "list" && wd.interactive === true) ids.push(wd.id);
		return ids;
	}

	/** 可焦点控件 id（m5 T8：交互列表 + 输入框，Tab 焦点循环序）。 */
	private dialogInteractiveIds(widgets: readonly WidgetSpec[]): string[] {
		const ids: string[] = [];
		for (const wd of widgets) {
			if ((wd.kind === "list" && wd.interactive === true) || wd.kind === "input") ids.push(wd.id);
		}
		return ids;
	}

	/** 开控件窗：几何走 T1（不另算）；排队同 viewText（单槽 FIFO）。
	 *  句柄闭包查属主与存活——窗已关/模块已卸载后调用 = 无操作不报错；
	 *  排队期（窗还没开）的 update/close 同款无操作。 */
	openDialog(spec: DialogSpec, owner?: string): DialogHandle | undefined {
		return this.openDialogHost(spec, owner);
	}

	/** 控件窗宿主超集（T17 m4-3c）：DialogSpec + 自定义键（hostKeys）。契约面不动——模块仍走
	 *  openDialog（键被静默丢弃）；宿主表单窗用本口。 */
	openDialogHost(spec: Omit<DialogSpec, "layout"> & { layout?: PopupLayout | "dock"; hostKeys?: HostDialogKeys }, owner?: string): DialogHandle | undefined {
		const lists = this.dialogInteractiveIds(spec.widgets);
		let installed: (typeof this.pendingUi) & { kind: "dialog" } | undefined;
		const open = (): void => {
			if (this.stopped) return;
			const geo = this.viewGeo(spec.layout);
			if (geo.fallbackReason === "too-small") {
				this.showToast("终端窗口太小，弹窗未打开");
				this.promoteUi();
				return;
			}
			this.state.overlayOpen = false; // 与斜杠菜单互斥
			const e = {
				kind: "dialog" as const,
				title: spec.title,
				widgets: spec.widgets, // 开窗快照（路 1）——活值字段渲染期现读（与卡片同款）
				scroll: 0,
				...(spec.layout !== undefined ? { layout: spec.layout } : {}),
				...(owner !== undefined ? { owner } : {}),
				...(lists.length > 0 ? { focusedId: lists[0] } : {}),
				selById: {},
				inputById: {},
				...(spec.onEvent !== undefined ? { onEvent: spec.onEvent } : {}),
				...(spec.hostKeys !== undefined ? { hostKeys: spec.hostKeys } : {}),
			};
			installed = e;
			this.pendingUi = e;
			this.scheduler.requestImmediateRender();
		};
		if (this.pendingUi !== undefined) {
			this.uiQueue.push({ run: open, ...(owner !== undefined ? { owner } : {}) });
			return {
				update: () => {}, // 窗未开前的句柄调用 = 无操作（开窗后的更新走已安装的闭包）
				close: () => {
				const i = this.uiQueue.findIndex((q) => q.run === open);
				if (i >= 0) this.uiQueue.splice(i, 1); // 还在排队里——直接退队
				},
			};
		}
		open();
		return {
			update: (widgets) => {
				if (installed === undefined || this.pendingUi !== installed) return; // 路 3：句柄更新——换清单滚回顶部（设计空白 14）
				installed.widgets = widgets;
				installed.selById = {};
				installed.scroll = 0;
				// inputById 与焦点保留（2026-09-30 实机走查：表单窗同 id 重拼是常态——切传输方式/开高级区
				// 重拼清单时清输入 = 已敲的字凭空蒸发、焦点跳回第一格；设计空白 14 钉的是滚回顶部，不含这俩。
				// 消失的 id 留着无害（渲染按 id 现读），焦点 id 不在新清单才回落首格）
				const ids = this.dialogInteractiveIds(widgets);
				if (installed.focusedId === undefined || !ids.includes(installed.focusedId)) {
					installed.focusedId = ids.length > 0 ? ids[0] : undefined; // 无交互控件 = 无焦点（exactOptional 收窄）
				}
				this.scheduler.requestImmediateRender();
			},
			close: () => {
				if (installed === undefined || this.pendingUi !== installed) return;
				this.pendingUi = undefined;
				this.promoteUi();
				this.scheduler.requestImmediateRender();
			},
		};
	}

	/** 按 owner 关模块的挂起窗（m5 T7——reload removed 名单通知的接收口）：
	 *  在屏的 view/dialog 属主匹配即关 + 排队里它的窗一并丢弃 + toast “模块已卸载”。 */
	closeModuleUi(owner: string): void {
		const pu = this.pendingUi;
		if (pu !== undefined && (pu.kind === "view" || pu.kind === "dialog") && pu.owner === owner) {
			this.pendingUi = undefined;
			this.showToast(`模块 ${owner} 已卸载——其窗口已关闭`);
			this.promoteUi();
			this.scheduler.requestImmediateRender();
		}
		for (let i = this.uiQueue.length - 1; i >= 0; i--) {
			if (this.uiQueue[i]!.owner === owner) this.uiQueue.splice(i, 1);
		}
	}

	/** dialog 事件回传（m5 T7）：模块 onEvent 抛错 = 黄字提示且窗保留（全局约束 4）；
	 *  返回新清单 = 整窗替换滚回顶部（路 2）。 */
	private fireDialogEvent(pu: { widgets: WidgetSpec[]; selById: Record<string, number>; inputById?: Record<string, { text: string; cursor: number }>; scroll: number; focusedId?: string | undefined; onEvent?: DialogSpec["onEvent"] }, e: DialogEvent): void {
		if (pu.onEvent === undefined) return;
		try {
			const next = pu.onEvent(e);
			if (next !== undefined) {
				pu.widgets = next;
				pu.selById = {};
				pu.inputById = {};
				pu.scroll = 0;
				const ids = this.dialogInteractiveIds(next);
				pu.focusedId = ids.length > 0 ? ids[0] : undefined;
			}
		} catch (err) {
			this.showToast(`控件窗事件处理出错：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 选中项行位跟随（窗口滚动针对焦点列表的选中项最小平移）。 */
	private dialogFollowSel(pu: { widgets: readonly WidgetSpec[]; scroll: number; layout?: PopupLayout | "dock"; focusedId?: string | undefined; selById: Record<string, number> }): void {
		if (pu.focusedId === undefined) return;
		const geo = this.viewGeo(pu.layout === "dock" ? undefined : pu.layout);
		const wl = renderWidgetLines(pu.widgets, geo.width - 2, { selById: pu.selById, focusedId: pu.focusedId });
		const li = wl.lists.find((l) => l.id === pu.focusedId);
		if (li === undefined) return;
		const line = li.baseLine + (pu.selById[li.id] ?? 0);
		const page = Math.max(3, geo.height - 3);
		const lo = Math.max(0, line - page + 1);
		pu.scroll = Math.max(lo, Math.min(line, pu.scroll));
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

	/** 浮动提示（2026-09-22 用户拍板）：输入框上边缘黄字、自消。自消靠定时器补一帧——
	 *  非 busy 期没有 spinner 心跳，不定时的話旧 toast 会留到下一次按键。
	 *  m5 T3：增可选时长毫秒——缺省 3000、允许 [1000, 30000]、越界钳到边界（设计空白 3）；
	 *  主程序自己的十几处调用全走缺省零变化。
	 *  CTU-03（2026-09-28 修复）：toast 发身份令牌 + 定时器单槽登记清理。旧实现每 toast 新建
	 *  setTimeout 从不取消，旧定时器按闭包里的旧时长做龄检——任何在新 toast 顶上后 200ms 窗口内
	 *  创建的 toast 都会被旧定时器按旧时长误消（混时长实测：3000ms 宿主 toast 后 100ms 顶上
	 *  8000ms 模块 notice，~3.1s 被杀，应停 8s）。令牌判身份与时长彻底解耦，顶替时旧定时器直接作废。 */
	showToast(text: string, durationMs?: number): void {
		const duration = Math.max(1000, Math.min(30000, durationMs ?? 3000));
		if (this.toastTimer !== undefined) clearTimeout(this.toastTimer); // 旧定时器随顶替作废（单槽登记）
		const id = ++this.toastSeq;
		this.state.toast = { id, text, at: Date.now(), ...(duration !== 3000 ? { duration } : {}) };
		this.scheduler.requestImmediateRender();
		const timer = setTimeout(() => {
			this.toastTimer = undefined;
			if (this.state.toast?.id !== id) return; // 身份不符（已被顶替）——不看时长直接退出
			this.state.toast = undefined;
			this.scheduler.requestRender();
		}, duration + 100);
		timer.unref?.();
		this.toastTimer = timer;
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
	/** pick 列表行的可用显示宽（m4-7 走查修 2026-09-27）：左栏宽 − 框 2 列 − 「 ❯ 」前缀 4 列——
	 *  宿主拼行（如技能列表三列）按此截断，防超宽把右框 │ 推错位。侧栏随 cols 现算（与渲染同源）。 */
	pickRowWidth(): number {
		return Math.max(8, this.io.columns() - this.sidebarW() - 1) - 2 - 4;
	}

	pickOverlay(title: string, items: string[], selAt = 0, keys?: PickExtraKeys): Promise<number | undefined> {
		if (this.pendingUi !== undefined) {
			return new Promise((resolve) => this.uiQueue.push({ run: () => {
				if (this.stopped) { resolve(undefined); return; }
				void this.pickOverlay(title, items, selAt, keys).then(resolve);
			} }));
		}
		this.state.overlayOpen = false; // 与斜杠菜单互斥
		return new Promise((resolve) => {
			// ≥12 项启用输入过滤（F5 九轮① 用户拍板：厂商目录全量直列、列表内输入即筛——includes 口径）
			this.pendingUi = {
				kind: "pick",
				title,
				items,
				sel: Math.max(0, Math.min(items.length - 1, selAt)), // m4-7 T9：初始选中（详情 Esc 回列表选中行回到该技能）
				resolve,
				...(items.length >= 12 ? { filter: "" } : {}),
				...(keys !== undefined ? { extraKeys: keys } : {}),
			};
			this.scheduler.requestImmediateRender();
		});
	}

	/** ask/askSecret 的全屏形态：输入行接管（提示语进输入框前缀；secret 盲显 •；Esc → undefined）。
	 *  单槽占用期 FIFO 暂存（同 pickOverlay——批③②）。 */
	promptInput(question: string, secret: boolean): Promise<string | undefined> {
		if (this.pendingUi !== undefined) {
			return new Promise((resolve) => this.uiQueue.push({ run: () => {
				if (this.stopped) { resolve(undefined); return; }
				void this.promptInput(question, secret).then(resolve);
			} }));
		}
		const prev = { input: this.state.input, cursor: this.state.cursor };
		this.state.input = "";
		this.state.cursor = 0;
		return new Promise((resolve) => {
			this.pendingUi = {
				kind: "ask",
				question,
				secret,
				prev, // CTU-07：接管前草稿快照——Enter/Esc 两结算路径共读（成功路径不再丢草稿）
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
		if (extend && s.selAnchor < 0) {
			s.selAnchor = s.cursor;
			this.clearStreamSelection(); // 键盘选区诞生清拖选高亮（2026-09-30 拍板，与 Ctrl+A 同规则）
		}
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

	/** 滚轮路由（m5 鼠标批 T2——kimi routeWheel :986-998 的窗口栈版）：滚轮给当前最上层可滚面，
	 *  与键盘焦点无关；主流区是兜底（= kimi 未落在可滚组件时兜底主视图）。主窗直绑 scrollBack
	 *  字段不绑翻页键（决策点 5：翻页键吃面板焦点而滚轮不吃——面板聚焦期滚轮仍滚主流区）。 */
	private onWheel(w: WheelEvent): void {
		const s = this.state;
		const lines = WHEEL_STEP * (w.alt ? ALT_WHEEL_MULTIPLIER : 1); // kimi :981-983 同式
		const up = w.direction === -1;
		if (this.onboarding !== undefined) return; // 引导焦点锁（同 onKey）
		const pu = this.pendingUi;
		if (pu?.kind === "view") {
			const page = pu.viewPage ?? Math.max(3, this.viewGeo(pu.layout).height - 3); // viewPage = 渲染期回写（dock 与渲染同源；m4-7 走查修）
			if (pu.pinned === true) { pu.scroll = Math.max(0, pu.lines.length - page); pu.pinned = false; } // T1 落地再滚
			pu.scroll = Math.max(0, Math.min(Math.max(0, pu.lines.length - page), pu.scroll + (up ? -lines : lines)));
		} else if (pu?.kind === "dialog") {
			// dialog 型没有 lines 字段（控件渲染出 content）——内容行数走 renderWidgetLines 渲染口径，
			// 与 buildDialogOverlay 同源调用；滚轮写 scroll 是本批新增的手动滚动，渲染切片面现成
			const geo = this.viewGeo(pu.layout === "dock" ? undefined : pu.layout);
			const page = Math.max(3, geo.height - 3);
			const total = renderWidgetLines(pu.widgets, geo.width - 2, { selById: pu.selById, inputById: pu.inputById, ...(pu.focusedId !== undefined ? { focusedId: pu.focusedId } : {}) }).lines.length;
			pu.scroll = Math.max(0, Math.min(Math.max(0, total - page), pu.scroll + (up ? -lines : lines)));
		} else if (pu?.kind === "pick") {
			// 与键盘同一张过滤清单——过滤激活时按 filtered 钳，否则滚轮可越过过滤尾致 Enter 错位
			const filtered = pu.filter === undefined ? pu.items : pu.items.filter((i) => i.toLowerCase().includes(pu.filter!.toLowerCase()));
			pu.sel = Math.max(0, Math.min(filtered.length - 1, pu.sel + (up ? -lines : lines))); // 到头停（决策点 6——不学键盘回绕）
		} else if (pu !== undefined) {
			return; // ask——没有可滚面
		} else if (s.overlayOpen) {
			const items = this.overlayItems();
			s.overlaySel = this.selToSelectable(items, s.overlaySel + (up ? -lines : lines));
		} else if (s.diagOpen) {
			const entries = this.io.diagEntries?.() ?? [];
			s.diagSel = Math.max(0, Math.min(Math.max(0, entries.length - 1), s.diagSel + (up ? -lines : lines)));
		} else {
			s.scrollBack = Math.max(0, s.scrollBack + (up ? lines : -lines)); // 上滚=回看历史（PgUp 同向）；上界渲染帧已钳
		}
		this.scheduler.requestImmediateRender();
	}

	/** 按钮事件处理器（m5 鼠标批 T5 填肉 / T6 粒度 / T7 链接 / T8 查看窗）：按下建锚（空点击 =
	 *  折叠选区）、拖动扩焦（越界钳边界）、松开结算复制（kimi handleSelectionMouseEvent
	 *  :1314-1383 同构）。查看窗在位且指针在盒内 → 选查看窗内容（T8，坐标系 = 盒内衬 2 列）。 */
	private onButton(e: ButtonEvent): void {
		if (this.onboarding !== undefined) return; // 引导锁（同 onWheel）
		if (e.button !== 0 && e.kind !== "hover") return; // v1 只左键；hover 恒无按钮（?1003 纯移动）
		const s = this.state;
		if (e.kind === "hover") {
			// 悬停检测（T10）：指针在轨道列上 → 记 scope 供渲染换亮色（tmux 降级档无 ?1003 →
			// 无 hover 事件恒不高亮，属预期披露）
			s.scrollbarHover = this.scrollbarTrackHit(e.x, e.y)?.scope;
			this.scheduler.requestImmediateRender();
			return;
		}
		if (e.kind === "press") {
			// 滚动条优先于选区（kimi :1102-1112 次序）：命中轨道列 → 拖动状态机（点轨道非拇指先跳位）
			const track = this.scrollbarTrackHit(e.x, e.y);
			if (track !== undefined) {
				this.scrollbarPress(track, e.y);
				this.scheduler.requestImmediateRender();
				return;
			}
			// 查看窗盒内优先（T8）——主流区 pointToDoc 之前判 viewGeo 盒命中
			const vp = this.pointToView(e.x, e.y);
			const p = vp !== undefined
				? { scope: "view" as const, docIdx: vp.docIdx, col: vp.col }
				: (() => { const m = this.pointToDoc(e.x, e.y); return m === undefined ? undefined : { scope: "main" as const, docIdx: m.docIdx, col: m.col }; })();
			const plain = p !== undefined ? stripAnsi(this.selLineText(p.scope, p.docIdx)) : undefined;
			const word = p !== undefined && plain !== undefined ? wordRangeAt(plain, p.col) : undefined;
			const count = this.clickCount(p, word);
			const range = p === undefined ? undefined
				: count === 3 ? { start: 0, end: visibleWidth(plain ?? "") }
				: count === 2 ? word
				: undefined;
			s.selGranularity = range === undefined ? "character" : count === 2 ? "word" : "line";
			s.selInitialRange = p !== undefined && range !== undefined
				? { start: { docIdx: p.docIdx, col: range.start }, end: { docIdx: p.docIdx, col: range.end } }
				: undefined;
			s.mselAnchor = p === undefined ? undefined : range === undefined ? p : { scope: p.scope, docIdx: p.docIdx, col: range.start };
			s.mselFocus = p === undefined ? undefined : range === undefined ? p : { scope: p.scope, docIdx: p.docIdx, col: range.end };
			// 链接探测（T7——kimi :1385-1390）：单击（count 1）才记 URL，双击/三击走选词不探测
			s.pressedUrl = count === 1 && p !== undefined
				? (() => {
					const url = osc8LinkAtColumn(this.selLineText(p.scope, p.docIdx), p.col);
					return url === undefined ? undefined : { url, x: e.x, y: e.y };
				})()
				: undefined;
		} else if (e.kind === "drag") {
			// 滚动条拖动跟手优先（T10——拖动态在位时不再扩选）
			if (s.scrollbarDrag !== undefined) {
				this.scrollbarDragTo(e.y);
				this.scheduler.requestImmediateRender();
				return;
			}
			s.pressedUrl = undefined; // 拖动即作废（误拖保护）
			if (s.mselAnchor === undefined) return;
			this.extendSelection(e.x, e.y);
			// 拖选自动滚（T9——kimi updateSelectionAutoScroll :1259-1285）：压到所在窗口上/下边缘
			// → 50ms 一格滚 + 指针重映射续选；方向必落 state（脉冲从 state 读——两字段号相反见 pulse）
			s.dragPointer = { x: e.x, y: e.y };
			const dir = this.autoScrollDirFor(e.y);
			if (dir === 0) {
				this.stopAutoScroll();
			} else {
				s.autoScrollDir = dir;
				if (s.autoScrollTimer === undefined) {
					s.autoScrollTimer = setInterval(() => this.autoScrollPulse(), 50); // 设计空白 12
					s.autoScrollTimer.unref?.();
				}
			}
		} else if (e.kind === "release") {
			s.scrollbarDrag = undefined; // 滚动条拖动结算（T10）
			this.stopAutoScroll(); // 松手即停（kimi :1322 同位）
			// 链接打开（T7——kimi :1330-1336 次序）：未拖动（pressedUrl 未被 drag 作废）且同点才打开
			const pu = s.pressedUrl;
			if (pu !== undefined && pu.x === e.x && pu.y === e.y) void this.openLink(pu.url);
			s.pressedUrl = undefined;
			const text = this.selectionText();
			if (text !== undefined) void this.copySelection(text); // 已复制 N 行（决策点 8）
			else { s.mselAnchor = undefined; s.mselFocus = undefined; } // 空选区松开即消
		}
		this.scheduler.requestImmediateRender();
	}

	/** 扩选到指针点（T9 提取——drag 分支与自动滚脉冲共用）：越界按 scope 钳边界（clampedSelPoint）
	 *  + 粒度感知（T6 逻辑原样：词/行粒度 focus 对齐区间、反侧锚点切换）。 */
	private extendSelection(x: number, y: number): void {
		const s = this.state;
		const p = this.clampedSelPoint(x, y);
		if (p === undefined) return;
		const initial = s.selInitialRange;
		if (s.selGranularity !== "character" && initial !== undefined) {
			const before = p.docIdx < initial.start.docIdx || (p.docIdx === initial.start.docIdx && p.col < initial.start.col);
			const anchor = { scope: p.scope, docIdx: before ? initial.end.docIdx : initial.start.docIdx, col: before ? initial.end.col : initial.start.col };
			if (s.selGranularity === "word") {
				const plain = stripAnsi(this.selLineText(p.scope, p.docIdx));
				const r = wordRangeAt(plain, p.col) ?? { start: p.col, end: p.col };
				s.mselAnchor = anchor;
				s.mselFocus = { scope: p.scope, docIdx: p.docIdx, col: before ? r.start : r.end };
			} else {
				const lineEnd = visibleWidth(stripAnsi(this.selLineText(p.scope, p.docIdx)));
				s.mselAnchor = anchor;
				s.mselFocus = { scope: p.scope, docIdx: p.docIdx, col: before ? 0 : lineEnd };
			}
		} else {
			s.mselFocus = p;
		}
	}

	/** 自动滚方向判定（T9）：按选区 scope 的窗口界——压上边缘 -1 / 压下边缘 +1 / 界内 0。 */
	private autoScrollDirFor(y: number): -1 | 0 | 1 {
		if (this.state.mselAnchor?.scope === "view") {
			const pu = this.pendingUi;
			if (pu?.kind === "view") {
				const geo = this.viewGeo(pu.layout);
				if (y <= geo.row + 1) return -1; // 内容区顶（顶框让 1 行）
				if (y >= geo.row + geo.height - 2) return 1; // 内容区底（提示行/底框让位）
				return 0;
			}
			return 0;
		}
		const { streamH } = this.layoutFrame();
		if (y <= 0) return -1;
		if (y >= streamH - 1) return 1;
		return 0;
	}

	/** 自动滚脉冲（T9——kimi autoScrollSelection :1287-1303）：每 tick 滚 1 行、滚到头自停、
	 *  滚完指针重映射续选（内容滚过指针 = 选区吃进滚过的行）。方向号按 scope：主窗 scrollBack -= dir
	 *  （压底 = 向新 = scrollBack 减）、查看窗 pu.scroll += dir——两字段号相反，统一 += 必有一窗反向。 */
	private autoScrollPulse(): void {
		const s = this.state;
		const { dragPointer, autoScrollDir } = s;
		if (dragPointer === undefined || autoScrollDir === 0) {
			this.stopAutoScroll();
			return;
		}
		if (s.mselAnchor?.scope === "view") {
			const pu = this.pendingUi;
			if (pu?.kind !== "view") {
				this.stopAutoScroll();
				return;
			}
			const page = pu.viewPage ?? Math.max(3, this.viewGeo(pu.layout).height - 3); // viewPage = 渲染期回写（dock 与渲染同源；m4-7 走查修）
			const maxScroll = Math.max(0, pu.lines.length - page);
			if (pu.pinned === true) { pu.scroll = maxScroll; pu.pinned = false; } // 脱钉再滚（与滚轮/翻页键三处同款）
			const before = pu.scroll;
			pu.scroll = Math.max(0, Math.min(maxScroll, pu.scroll + autoScrollDir));
			if (pu.scroll === before) {
				this.stopAutoScroll();
				return;
			}
		} else {
			const { streamH, dmTotal } = this.layoutFrame();
			const maxScroll = Math.max(0, dmTotal - streamH);
			const before = s.scrollBack;
			s.scrollBack = Math.max(0, Math.min(maxScroll, s.scrollBack - autoScrollDir));
			if (s.scrollBack === before) {
				this.stopAutoScroll();
				return;
			}
		}
		this.extendSelection(dragPointer.x, dragPointer.y); // 指针重映射：start 变了映射点随行
		this.scheduler.requestImmediateRender();
	}

	/** 停自动滚（T9）：松开/回界内/滚到头/窗关闭四路共用。 */
	private stopAutoScroll(): void {
		const s = this.state;
		if (s.autoScrollTimer !== undefined) {
			clearInterval(s.autoScrollTimer);
			s.autoScrollTimer = undefined;
		}
		s.autoScrollDir = 0;
		s.dragPointer = undefined;
	}

	// ---------- 滚动条（T10——kimi :1037-1052 命中 / :1115-1118 跳位 / :1075-1078 拖动映射） ----------

	/** 查看窗键让位判定（走查④）：查看窗注册了该键 → 窗内优先——Alt+E/O/F 等内容键落到查看窗
	 *  自己的 keys 分发（子代理消息窗的内容快捷键与主窗一致），主窗全局段不拦截（穿透到
	 *  pendingUi 分支）。查看窗未注册的键照旧走主窗语义。 */
	private viewHasKey(key: string): boolean {
		const pu = this.pendingUi;
		return pu?.kind === "view" && pu.keys?.[key] !== undefined;
	}

	/** 滚动条基座几何：scope → 视口高/总行数/首行/轨道顶行/当前拇指。 */
	private scrollbarTrackBase(scope: "main" | "view"): {
		total: number; viewportH: number; first: number; trackTop: number; thumb: { top: number; height: number };
	} | undefined {
		if (scope === "view") {
			const pu = this.pendingUi;
			if (pu?.kind !== "view") return undefined;
			const geo = this.viewGeo(pu.layout);
			const page = Math.max(3, geo.height - 3);
			const maxScroll = Math.max(0, pu.lines.length - page);
			const sc = pu.pinned === true ? maxScroll : Math.max(0, Math.min(maxScroll, pu.scroll));
			const thumb = thumbGeometry(page, pu.lines.length, sc);
			if (thumb === undefined) return undefined;
			return { total: pu.lines.length, viewportH: page, first: sc, trackTop: geo.row + 1, thumb };
		}
		const { streamH, start, dmTotal } = this.layoutFrame();
		const thumb = thumbGeometry(streamH, dmTotal, start);
		if (thumb === undefined) return undefined;
		return { total: dmTotal, viewportH: streamH, first: start, trackTop: 0, thumb };
	}

	/** 轨道命中判定（T10）：指针在轨道列（主窗 = leftW−1 / 查看窗 = 盒内右列）且在轨道行范围内。 */
	private scrollbarTrackHit(x: number, y: number): { scope: "main" | "view" } & ReturnType<NonNullable<FullApp["scrollbarTrackBase"]>> | undefined {
		const pu = this.pendingUi;
		if (pu?.kind === "view") {
			const geo = this.viewGeo(pu.layout);
			const t = this.scrollbarTrackBase("view");
			if (t === undefined) return undefined;
			if (x === geo.col + geo.width - 2 && y >= t.trackTop && y < t.trackTop + t.viewportH) {
				return { scope: "view", ...t };
			}
			return undefined;
		}
		const { streamH, leftW } = this.layoutFrame();
		const t = this.scrollbarTrackBase("main");
		if (t === undefined) return undefined;
		if (x === leftW - 1 && y >= 0 && y < streamH) {
			return { scope: "main", ...t };
		}
		return undefined;
	}

	/** 轨道按下（T10——kimi :1115-1118）：点轨道非拇指先把拇指中心跳到指针行，再记抓取偏移。 */
	private scrollbarPress(t: { scope: "main" | "view"; total: number; viewportH: number; first: number; trackTop: number; thumb: { top: number; height: number } }, y: number): void {
		const s = this.state;
		const scrollRange = Math.max(1, t.total - t.viewportH);
		const maxOff = Math.max(1, t.viewportH - t.thumb.height);
		const rel = y - t.trackTop;
		if (rel < t.thumb.top || rel >= t.thumb.top + t.thumb.height) {
			// 点轨道非拇指 → 跳位（指针行居中成新拇指中心）
			const first = Math.max(0, Math.min(t.total - t.viewportH, Math.round(((rel - t.thumb.height / 2) / maxOff) * scrollRange)));
			this.setScrollFirst(t.scope, first);
		}
		const th = this.scrollbarTrackBase(t.scope)?.thumb ?? t.thumb; // 跳位后重算
		s.scrollbarDrag = { scope: t.scope, grabOffset: y - (t.trackTop + th.top) };
	}

	/** 拖动跟手（T10——kimi :1075-1078 四则式）：指针 Y − 抓取偏移 → 拇指顶 → 滚动位置。 */
	private scrollbarDragTo(y: number): void {
		const s = this.state;
		const drag = s.scrollbarDrag;
		if (drag === undefined) return;
		const t = this.scrollbarTrackBase(drag.scope);
		if (t === undefined) {
			s.scrollbarDrag = undefined;
			return;
		}
		const scrollRange = Math.max(1, t.total - t.viewportH);
		const maxOff = Math.max(1, t.viewportH - t.thumb.height);
		const first = Math.max(0, Math.min(t.total - t.viewportH, Math.round(((y - drag.grabOffset - t.trackTop) / maxOff) * scrollRange)));
		this.setScrollFirst(drag.scope, first);
	}

	/** 写滚动位置（T10——与滚轮/翻页键/自动滚四源同汇同一字段）。主窗 first 是 start 口径
	 *  （拇指映射视角），scrollBack = maxScroll − first。 */
	private setScrollFirst(scope: "main" | "view", first: number): void {
		if (scope === "view") {
			const pu = this.pendingUi;
			if (pu?.kind === "view") {
				pu.pinned = false;
				pu.scroll = first;
			}
			return;
		}
		const { streamH, dmTotal } = this.layoutFrame();
		this.state.scrollBack = Math.max(0, Math.min(Math.max(0, dmTotal - streamH), dmTotal - streamH - first));
	}

	/** 拖动点钳制（T8）：按当前选区 scope 钳在对应窗口边界——view 钳查看窗盒、main 钳主流区。 */
	private clampedSelPoint(x: number, y: number): { scope: "main" | "view"; docIdx: number; col: number } | undefined {
		if (this.state.mselAnchor?.scope === "view") {
			const pu = this.pendingUi;
			if (pu?.kind !== "view") return undefined;
			const geo = this.viewGeo(pu.layout);
			const cx = Math.max(geo.col, Math.min(geo.col + geo.width - 1, x));
			const cy = Math.max(geo.row + 1, Math.min(geo.row + geo.height - 1, y)); // 顶框让位
			return (() => { const p = this.pointToView(cx, cy); return p === undefined ? undefined : { scope: "view" as const, ...p }; })();
		}
		const { streamH, leftW } = this.layoutFrame();
		const p = this.pointToDoc(Math.min(x, leftW - 1), Math.max(0, Math.min(streamH - 1, y)));
		return p === undefined ? undefined : { scope: "main", ...p };
	}

	/** 选区行文本（T8 scope 感知）：main → doc（含 tailLine）；view → pu.lines。
	 *  窗口化（T5）：doc 是窗口局部数组——全局下标 − start 取局部（窗口外回退空串）。 */
	private selLineText(scope: "main" | "view", idx: number): string {
		if (scope === "view") {
			const pu = this.pendingUi;
			return pu?.kind === "view" ? (pu.lines[idx] ?? "") : "";
		}
		const { start, doc } = this.layoutFrame();
		return doc[idx - start] ?? "";
	}

	/** 指针 → 查看窗内容行列（T8）：viewGeo 盒内才命中；行索引随渲染 sc 同源（滚动平移天然稳定）；
	 *  盒内衬 = │ + 空格共 2 列。 */
	private pointToView(x: number, y: number): { docIdx: number; col: number } | undefined {
		const pu = this.pendingUi;
		if (pu?.kind !== "view") return undefined;
		const geo = this.viewGeo(pu.layout);
		if (y < geo.row || y >= geo.row + geo.height || x < geo.col || x >= geo.col + geo.width) return undefined;
		const page = Math.max(3, geo.height - 3);
		pu.viewPage = page; // 渲染期回写——翻页/滚轮页大小与窗几何同源（dock 不走 viewGeo，m4-7 走查修）
		const maxScroll = Math.max(0, pu.lines.length - page);
		const sc = pu.pinned === true ? maxScroll : Math.max(0, Math.min(maxScroll, pu.scroll));
		const row = y - geo.row - 1; // 顶框占 1 行
		if (row < 0 || row >= page) return undefined;
		const idx = sc + row;
		if (idx >= pu.lines.length) return undefined;
		return { docIdx: idx, col: Math.max(0, x - geo.col - 2) };
	}

	/** 连击计数（T6——kimi getClickCount :1233-1257）：500ms 窗口内 + 同行 + 同词边界才 +1
	 *  （1→2→3 循环）；点到空白/流区外连击不记。 */
	private clickCount(point: { docIdx: number; col: number } | undefined, word: { start: number; end: number } | undefined): number {
		const s = this.state;
		const lc = s.lastClick;
		const now = Date.now();
		if (point !== undefined && word !== undefined && lc !== undefined
			&& now - lc.at <= DOUBLE_CLICK_INTERVAL_MS
			&& lc.docIdx === point.docIdx
			&& lc.wordStart === word.start && lc.wordEnd === word.end) {
			const count = (lc.count % 3) + 1;
			s.lastClick = { at: now, count, docIdx: point.docIdx, wordStart: word.start, wordEnd: word.end };
			return count;
		}
		s.lastClick = point !== undefined && word !== undefined
			? { at: now, count: 1, docIdx: point.docIdx, wordStart: word.start, wordEnd: word.end }
			: undefined; // 空白/流区外——连击状态清空
		return 1;
	}

	/** 指针屏坐标 → doc 行列（T5——与 renderFrame 同源几何 layoutFrame；左内衬 2 列）。 */
	private pointToDoc(x: number, y: number): { docIdx: number; col: number } | undefined {
		const { streamH, start, dmTotal, leftW } = this.layoutFrame();
		if (y < 0 || y >= streamH) return undefined; // 流区外（输入框/队列区）→ 不选
		if (x >= leftW) return undefined; // 右侧面板与流区同 y 段，按 x 排除（侧栏按下 = 清选区不建幻影锚点）
		const idx = start + y;
		if (idx >= dmTotal) return undefined;
		return { docIdx: idx, col: Math.max(0, x - 2) };
	}

	/** 选区端点排序（anchor/focus → lo/hi）。 */
	private mselRange(): { lo: { scope: "main" | "view"; docIdx: number; col: number }; hi: { scope: "main" | "view"; docIdx: number; col: number } } | undefined {
		const { mselAnchor: a, mselFocus: f } = this.state;
		if (a === undefined || f === undefined) return undefined;
		if (a.docIdx < f.docIdx || (a.docIdx === f.docIdx && a.col <= f.col)) return { lo: a, hi: f };
		return { lo: f, hi: a };
	}

	/** 选区纯文本提取（kimi getActiveSelectionText :1432-1454 同构）：逐行 sliceByColumn（ANSI 感知）
	 *  + stripAnsi + trimEnd；行源按 scope（T8：view → pu.lines、main → doc）；空选区/全空白 → undefined。 */
	private selectionText(): string | undefined {
		const r = this.mselRange();
		if (r === undefined) return undefined;
		const lines: string[] = [];
		for (let i = r.lo.docIdx; i <= r.hi.docIdx; i++) {
			const line = this.selLineText(r.lo.scope, i);
			const startCol = i === r.lo.docIdx ? r.lo.col : 0;
			const endCol = i === r.hi.docIdx ? r.hi.col : visibleWidth(line);
			lines.push(stripAnsi(sliceByColumn(line, startCol, Math.max(0, endCol - startCol))).trimEnd());
		}
		const text = lines.join("\n");
		return text.trim() === "" ? undefined : text;
	}

	/** 渲染行按选区反白（T5——theme.inverse 与输入框选区 styleWithSelection 同手法；
	 *  入参是已带内衬的渲染行，列区间 +2 对齐；scope 匹配才作用〔T8——主窗/查看窗各自渲染〕）。 */
	private styleDocSelection(scope: "main" | "view", docIdx: number, renderedLine: string): string {
		const r = this.mselRange();
		if (r === undefined || r.lo.scope !== scope) return renderedLine;
		if (docIdx < r.lo.docIdx || docIdx > r.hi.docIdx) return renderedLine;
		const lineStart = docIdx === r.lo.docIdx ? r.lo.col + 2 : 0;
		const lineEnd = docIdx === r.hi.docIdx ? r.hi.col + 2 : visibleWidth(renderedLine);
		if (lineEnd <= lineStart) return renderedLine;
		const left = sliceByColumn(renderedLine, 0, lineStart);
		const mid = sliceByColumn(renderedLine, lineStart, lineEnd - lineStart);
		const right = sliceByColumn(renderedLine, lineEnd, Math.max(0, visibleWidth(renderedLine) - lineEnd));
		return left + theme.inverse(mid) + right;
	}

	/** 选区一致性守卫（T8）：scope=view 的选区只在查看窗在位时有效——窗关闭首帧即整组清空
	 *  （防行索引残留误映射下一窗内容）；并同步停自动滚（T9——否则拖着选区关窗后 50ms 脉冲
	 *  继续跑、按主窗几何对空气重映射）。 */
	private selectionGuard(): void {
		const s = this.state;
		if ((s.mselAnchor?.scope ?? s.mselFocus?.scope) === "view" && this.pendingUi?.kind !== "view") {
			s.mselAnchor = undefined;
			s.mselFocus = undefined;
			this.stopAutoScroll();
		}
	}

	/** 选区复制结算（决策点 8）：真剪贴板优先（paste.ts 三平台），失败落 OSC 52 逃生口再提示。 */
	private copySelection(text: string): Promise<void> {
		return this.writeClipboardSettle(text, `已复制 ${text.split("\n").length} 行`);
	}

	/** 剪贴板写入结算（真剪贴板优先，失败落 OSC 52 逃生口再提示）——拖选松开（m5 T5）与
	 *  输入框 Ctrl+C（2026-09-30）共用同一条降级路。 */
	private async writeClipboardSettle(text: string, okMsg: string): Promise<void> {
		const write = this.io.writeClipboard ?? writeClipboardText;
		const ok = await write(text);
		if (ok) {
			this.showToast(okMsg);
		} else {
			this.term.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
			this.showToast("已发终端复制口令（系统剪贴板未确认）");
		}
	}

	/** 输入框键盘选区复制（2026-09-30 用户拍板）：Ctrl+C 只在「输入框有高亮选区」时消费——
	 *  WT 自有鼠标选区时会先截走 Ctrl+C、\x03 不到达应用，两层天然互斥、不抢 WT 原生复制；
	 *  无选区维持吞键现状（退出走 /quit、停生成双击 Esc 的 2026-09-23 拍板不动）。 */
	private async copyInputSelection(): Promise<void> {
		const r = this.selRange();
		if (r === undefined) return;
		const text = this.state.input.slice(r.lo, r.hi);
		await this.writeClipboardSettle(text, `已复制输入框 ${[...text].length} 字`);
	}

	/** 键盘选区与拖选选区互斥（2026-09-30 拍板：任一时刻屏幕最多一块高亮）：输入框键盘选区诞生
	 *  （Ctrl+A / Shift+←→ 首拍）即清对话流拖选残留高亮——Ctrl+C 复制的永远是「看到的那块」。 */
	private clearStreamSelection(): void {
		const s = this.state;
		if (s.mselAnchor === undefined && s.mselFocus === undefined) return;
		s.mselAnchor = undefined;
		s.mselFocus = undefined;
		this.stopAutoScroll();
	}

	/** 打开链接（T7 决策点 17）：只开 http/https——链接文本来自模型输出，file:// 等方案
	 *  拒开是注入面防线；toast 文案族（设计空白 6）。 */
	private async openLink(url: string): Promise<void> {
		if (!/^https?:\/\//i.test(url)) {
			this.showToast("仅支持打开 http/https 链接");
			return;
		}
		const open = this.io.openUrl ?? openUrl;
		const ok = await open(url);
		this.showToast(ok ? "已打开链接" : "打开链接失败");
	}

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
		// 弹窗聚焦期主窗快捷键不可用（走查⑤，2026-09-29 用户拍板「焦点在弹窗上 → 主界面快捷键
		// 应为不可用」）：查看/选择/询问/控件窗、诊断弹窗、斜杠菜单任一在场，主窗全局键不触发主窗
		// 功能。例外 = 弹窗自己的键：查看窗注册键（viewHasKey 让位，落窗内分发）与诊断开关
		// （Ctrl+E 在 diagOpen 期是诊断窗的关窗键）。旧铁律「模块窗期 Ctrl+E 仍走宿主全局键」随之
		// 作废（保留键注册即拒不动——模块依然不能绑这些键）；吞键静默，Esc 关弹窗后恢复。
		const popupFocused = this.pendingUi !== undefined || s.diagOpen || s.diagReturn || s.overlayOpen;
		if (key === "ctrl+t") {
			// m5-render-perf T5 护栏①（D8 定案）：生成中拒绝切换——宽度变化全量重折的尖峰削频，
			// toast 明示（设计空白 #9 文案）；冷却期连击由 setSidebar 静默吞（预检后到达的都是真实切换意图）
			if (popupFocused) return;
			if (s.busy) {
				this.showToast("生成中不能切换侧栏，回答结束后再试");
				return;
			}
			this.setSidebar(!s.sidebarVisible); // m5 T11：公共出口（设置服务共用——原内联三件套提纯）
			return;
		}
		if (key === "ctrl+e") {
			// 模块诊断弹窗总开关（T9/S6：全局拦截含输入框编辑态——与 Ctrl+T 同款；keymatch 0x05 无既有消费者）
			if (s.diagOpen || s.diagReturn) {
				// 二级开着（diagReturn 标记）= 全部关闭（原型定案）：一级、二级、返回标记一起清
				s.diagOpen = false;
				s.diagReturn = false;
				if (this.pendingUi?.kind === "view") {
					this.pendingUi = undefined;
					this.promoteUi(); // viewText 已排队化（T2）——关掉后队列里的下一个照常提
				}
			} else {
				if (popupFocused) return; // 弹窗聚焦期不开诊断（吞——走查⑤；诊断自开关在上分支不受影响）
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
		if (key === "alt+e" && !this.viewHasKey(key)) {
			if (popupFocused) return; // 弹窗期主窗折叠态不可用（走查⑤）——查看窗注册键已让位落窗内
			this.io.toggleThink();
			this.scheduler.requestImmediateRender();
			return;
		}
		if (key === "alt+o" && !this.viewHasKey(key)) {
			if (popupFocused) return;
			this.io.toggleTool();
			this.scheduler.requestImmediateRender();
			return;
		}
		if (key === "alt+f" && !this.viewHasKey(key)) {
			if (popupFocused) return;
			this.io.toggleErr();
			this.scheduler.requestImmediateRender();
			return;
		}
		if (key === "ctrl+u") {
			// Ctrl+U = steer（2026-09-23 队列批——kimi Ctrl-S 改键位，Ctrl+S 是终端 XOFF 流控冲突回避）：
			// 排队消息 + 当前草稿一起注入/提交；输入框清空（宿主把不可 steer 项留队）
			if (popupFocused) return; // 弹窗聚焦期 steer 不可用（走查⑤）
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
			if (popupFocused) return; // 弹窗聚焦期贴图不可用（走查⑤）
			this.io.requestPasteImage?.(); // F5 二轮⑬——全屏期 Alt+V 由 FullApp 接管（readline 侧已让位）
			return;
		}
		if (key === "ctrl+o") {
			// Ctrl+O = 查看压缩摘要（2026-09-23 用户拍板——/summary 命令退役，摘要查看唯一入口；
			// 无摘要时 toast 提示而非静默）
			if (popupFocused) return; // 弹窗聚焦期不叠摘要窗（走查④起，走查⑤扩到全部弹窗形态）
			this.io.showCompactionSummary?.();
			this.scheduler.requestImmediateRender();
			return;
		}

		// 全屏 CommandUi 挂起态（模块 choose/ask 的 overlay 化——优先于一切编辑态；
		// F5 实证：须先于 busy-Esc 判定，否则命令询问期间 Esc 被取消 turn 分支截胡、询问卡死）
		if (this.pendingUi !== undefined) {
			const pu = this.pendingUi;
			if (pu.kind === "view") {
				const closeView = (): void => {
					this.pendingUi = undefined;
					// 诊断二级的 Esc 逐级返回（T10/S5）：viewText 自身只管关——「回一级」由标记驱动重开（diagSel 原样保留）
					if (s.diagReturn) {
						s.diagReturn = false;
						if (key === "escape") s.diagOpen = true;
					}
					this.promoteUi();
				};
				// 模块自定义键优先（m5 T2 决策点 7：只保绝对禁绑集——pageUp 等翻页键可被模块占用）
				const custom = pu.keys?.[key];
				if (custom !== undefined) {
					try {
						const r = custom.run();
						if (r === "close") closeView();
						else if (typeof r === "string") {
							pu.text = r;
							pu.lines = r.split("\n");
							// 走查⑥（2026-09-29 用户报「折叠键按完直接置顶」）：内容替换不再滚回顶部
							// （旧「替换即置顶」是设计空白 14 为模块刷新内容定的语义，折叠切换被顶飞不合
							// 理）。学 kimi agent-activity-viewer :106-110（ctrl+o 折叠切换不动滚动）+
							// :292/:337-339（内容更新只做两件事：followTail 贴底 / scrollTop 超界才钳）：
							// 贴底窗（bottom → pinned）继续贴底；普通窗保持 scroll 仅钳到新范围——视口稳定。
							if (pu.pinned !== true) {
								const page = pu.viewPage ?? Math.max(3, this.viewGeo(pu.layout).height - 3);
								pu.scroll = Math.max(0, Math.min(Math.max(0, pu.lines.length - page), pu.scroll));
							}
						}
					} catch (err) {
						// 全局约束 4：模块函数抛错 = 黄字提示且窗保留
						this.showToast(`弹窗按键处理出错：${err instanceof Error ? err.message : String(err)}`);
					}
					this.scheduler.requestImmediateRender();
					return;
				}
				const page = pu.viewPage ?? Math.max(3, this.viewGeo(pu.layout).height - 3); // viewPage = 渲染期回写（dock 与渲染同源；m4-7 走查修）
				// pinned 窗先落地再滚（T1）：scroll 写到真实末页再脱钉——首按 ↑ 立即从末页上移（旧哨兵
				// 大数形态首按无效，要连按哨兵差值次才动）；↓/PgDn 落地后钳在 max 不动，语义不变
				if (pu.pinned === true) {
					pu.scroll = Math.max(0, pu.lines.length - page);
					pu.pinned = false;
				}
				if (key === "up") pu.scroll = Math.max(0, pu.scroll - 1);
				else if (key === "down") pu.scroll = Math.min(Math.max(0, pu.lines.length - page), pu.scroll + 1);
				else if (key === "pageUp") pu.scroll = Math.max(0, pu.scroll - page);
				else if (key === "pageDown") pu.scroll = Math.min(Math.max(0, pu.lines.length - page), pu.scroll + page);
				else if (key === "escape" || key === "enter" || key === "q") {
					closeView();
				}
				this.scheduler.requestImmediateRender();
				return;
			}
			if (pu.kind === "dialog") {
				const ids = this.dialogInteractiveIds(pu.widgets);
				// T17 宿主自定义键先行（含 escape 前的行内键——表单窗的 ←→/Shift+←→ 在此路由）；
				// escape 恒留给内建关窗（键表不得覆盖——收口纪律同 viewText 的 Esc）
				const hostKey = key !== "escape" ? pu.hostKeys?.[key] : undefined;
				if (hostKey !== undefined) {
					const ctx: DialogKeyCtx = {
						focusedId: pu.focusedId,
						focusIds: ids,
						setFocus: (id) => { pu.focusedId = id; },
						moveFocus: (delta) => {
							if (ids.length === 0) return;
							const i = Math.max(0, ids.indexOf(pu.focusedId ?? ids[0]!));
							pu.focusedId = ids[(i + delta + ids.length * 4) % ids.length]!;
						},
						selOf: (id) => pu.selById[id],
						setSel: (id, index) => { pu.selById[id] = index; },
						inputOf: (id) => pu.inputById[id]?.text ?? "",
						setInput: (id, text) => {
							const cur = pu.inputById[id] ?? (pu.inputById[id] = { text: "", cursor: 0 });
							cur.cursor = Math.min(cur.cursor, (cur.text = text).length);
						},
						close: () => { this.pendingUi = undefined; this.promoteUi(); },
					};
					let consumed: boolean | void = true;
					try {
						consumed = hostKey.run(ctx);
					} catch (err) {
						this.showToast(`表单键处理出错：${err instanceof Error ? err.message : String(err)}`);
					}
					if (consumed !== false) {
						this.scheduler.requestImmediateRender();
						return; // false = 不消费——回落内建（输入框光标等）
					}
				}
				if (key === "escape") {
					this.pendingUi = undefined;
					this.promoteUi();
				} else if (key === "tab" && ids.length > 1) {
					const i = Math.max(0, ids.indexOf(pu.focusedId ?? ids[0]!));
					pu.focusedId = ids[(i + 1) % ids.length]!;
				} else if (ids.length > 0) {
					const id = pu.focusedId ?? ids[0]!;
					const list = pu.widgets.find((wd): wd is Extract<WidgetSpec, { kind: "list" }> => wd.kind === "list" && wd.id === id && wd.interactive === true);
					const input = pu.widgets.find((wd): wd is Extract<WidgetSpec, { kind: "input" }> => wd.kind === "input" && wd.id === id);
					if (list !== undefined) {
						const cur = pu.selById[id] ?? 0;
						const step = key === "up" ? -1 : key === "down" ? 1 : key === "pageUp" ? -OVERLAY_PAGE : key === "pageDown" ? OVERLAY_PAGE : 0;
						if (step !== 0) {
							const next = Math.max(0, Math.min(list.items.length - 1, cur + step));
							if (next !== cur) {
								pu.selById[id] = next;
								this.fireDialogEvent(pu, { type: "select", id, index: next }); // 事件三型：select
								this.dialogFollowSel(pu);
							}
						} else if (key === "enter") {
							this.fireDialogEvent(pu, { type: "activate", id, index: cur }); // 事件三型：activate
						}
					} else if (input !== undefined) {
						// 输入框编辑（m5 T8）：方向键归输入框移光标（决策点 15）；每键 input 事件；
						// Enter 语义：enterSubmit 缺省 = 单行提交 / 多行换行；Alt+Enter 多行恒换行
						const ed = pu.inputById[id] ?? (pu.inputById[id] = { text: "", cursor: 0 });
						const fireInput = (): void => this.fireDialogEvent(pu, { type: "input", id, text: ed.text }); // 事件三型：input
						const submitOnEnter = input.enterSubmit ?? input.multiline !== true;
						if (key === "enter" && (submitOnEnter || input.multiline !== true)) {
							this.fireDialogEvent(pu, { type: "activate", id }); // 单行/显式 submit：Enter 激活（无 index）
						} else if ((key === "enter" || key === "alt+enter" || key === "shift+enter") && input.multiline === true) {
							ed.text = ed.text.slice(0, ed.cursor) + "\n" + ed.text.slice(ed.cursor);
							ed.cursor += 1;
							fireInput();
						} else if (key.length === 1 && isPrintable(key)) {
							ed.text = ed.text.slice(0, ed.cursor) + key + ed.text.slice(ed.cursor);
							ed.cursor += key.length;
							fireInput();
						} else if (key === "backspace" && ed.cursor > 0) {
							// CTU-10（2026-09-28 code review）：退格整对删代理对——主编辑器 onEditKey backspace 同款
							// 判定（光标前一位落低代理 0xdc00–0xdfff 且再前一位是高代理 → 删 2 码元；原按码元
							// 步进删非 BMP 字符一半，残留孤立代理串）
							const cp = ed.text.codePointAt(ed.cursor - 1)!;
							const prev2 = ed.text.charCodeAt(ed.cursor - 2);
							const w = cp >= 0xdc00 && cp <= 0xdfff && prev2 >= 0xd800 && prev2 <= 0xdbff ? 2 : 1;
							ed.text = ed.text.slice(0, ed.cursor - w) + ed.text.slice(ed.cursor);
							ed.cursor -= w;
							fireInput();
						} else if (key === "left") {
							// CTU-10：左移按码点跨越（主编辑器 moveCursor 同款——光标不落进代理对中间）
							const prev = ed.text.codePointAt(ed.cursor - 1)!;
							ed.cursor = Math.max(0, ed.cursor - (prev >= 0xdc00 && prev <= 0xdfff && ed.cursor > 1 ? 2 : 1));
						} else if (key === "right") {
							// CTU-10：右移按码点跨越（cp > 0xffff = 代理对高代理 → 跳 2 码元）
							const cp = ed.text.codePointAt(ed.cursor)!;
							ed.cursor = Math.min(ed.text.length, ed.cursor + (cp > 0xffff ? 2 : 1));
						} else if (key === "home") {
							ed.cursor = 0;
						} else if (key === "end") {
							ed.cursor = ed.text.length;
						}
						// 上下键在多行输入框 = 光标行间移动的简化口径（单行不消费）——v1 不做行间跳转，滚动跟随焦点控件不适用输入框
					}
				}
				this.scheduler.requestImmediateRender();
				return;
			}
			if (pu.kind === "pick") {
				// T17 宿主自定义键先行（escape 恒内建关窗）
				const pickKey = key !== "escape" && key !== "enter" ? pu.extraKeys?.[key] : undefined;
				if (pickKey !== undefined && pu.filter === undefined) { // 过滤态打字优先——自定义键只在无过滤时生效
					let consumed: boolean | void = true;
					try {
						consumed = pickKey.run({ close: () => { this.pendingUi = undefined; pu.resolve(undefined); this.promoteUi(); } });
					} catch (err) {
						this.showToast(`列表键处理出错：${err instanceof Error ? err.message : String(err)}`);
					}
					if (consumed !== false) {
						this.scheduler.requestImmediateRender();
						return;
					}
				}
				// 过滤列表（F5 九轮①）：可打印/退格编辑过滤串——子串匹配 includes（非 startsWith）。
				// CTU-08（2026-09-28 code review）：过滤携带原始索引——Enter 结算不再 indexOf 按值回查
				// （重复文本项会错拿首个同值项；choose 是模块契约面，契约未禁止重复项）
				const pairs = pu.items.map((t, i) => ({ t, i }));
				const filtered = pu.filter === undefined ? pairs : pairs.filter((x) => x.t.toLowerCase().includes(pu.filter!.toLowerCase()));
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
					pu.resolve(filtered[pu.sel]!.i); // 按携带索引结算（CTU-08——重复项不回查错位）
					this.promoteUi(); // 结算即提升暂存队首（批③②）
				} else if (key === "escape") {
					this.pendingUi = undefined;
					pu.resolve(undefined);
					this.promoteUi();
				}
				this.scheduler.requestImmediateRender();
				return;
			}
			// ask/askSecret：复用编辑器键，Enter 结算、Esc 取消；Shift+Enter 吞掉（单行问答不收换行——
			// 否则换行符悄悄进答案字符串，askSecret 里更荒诞）
			if (key === "enter") {
				const v = this.state.input;
				this.pendingUi = undefined;
				// CTU-07（2026-09-28 code review）：成功结算同样恢复接管前草稿——与 Esc 对称（答案已读出入 v，
				// 恢复无副作用；原实现清空丢弃：busy 期答完模块询问回来，正在写的草稿无声消失）
				this.state.input = pu.prev.input;
				this.state.cursor = pu.prev.cursor;
				pu.resolve(v);
				this.promoteUi();
			} else if (key === "escape") {
				this.pendingUi = undefined;
				pu.resolve(undefined);
				this.promoteUi();
			} else if (key !== "shift+enter") {
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
				// 二级详情（T10）：复用 viewText（翻页 + Esc 关闭——现成机制零新建）；Esc 逐级返回靠 diagReturn 标记
				const e = entries[s.diagSel];
				const text = e === undefined ? undefined : this.io.diagDetail?.(e.name);
				if (e !== undefined && text !== undefined) {
					s.diagReturn = true;
					s.diagOpen = false;
					this.viewText(`模块诊断 · ${e.name}`, text);
					return;
				}
			}
			this.scheduler.requestImmediateRender();
			return;
		}

		if (key === "escape") {
			if (s.busy) {
				// 焦点在侧栏面板（Tab 切走）时 Esc 先收焦点回输入框（2026-10-01 走查——否则被双击
				// 停止确认截胡，用户预期与空闲态一致先回焦点）；收焦点同时打断双击序列（含 lastEscCancel
				// 清零——与下方空闲态收尾同款，隔了一次 Tab 导航不再算连续两按）
				if (s.focusIdx !== 0) {
					this.lastEscCancel = 0;
					s.focusIdx = 0;
					this.scheduler.requestImmediateRender();
					return;
				}
				// 双击 Esc 才停止生成（2026-09-23 走查拍板——单击误触痛点；qwen-code 双击窗口
				// CTRL_EXIT_PROMPT_DURATION_MS=1000ms 同口径，比 claude-code 的 2s 短）：
				// 首按 toast 提示，1s 内再按才真正取消；窗口外再按重新计首按
				if (Date.now() - this.lastEscCancel < 1000) {
					this.lastEscCancel = 0;
					s.toast = undefined; // 二次确认即消提示（走查拍板——toast 留着会误解为「还没停」）
					this.io.requestCancel();
					this.io.stopAllSubagents?.(); // T14 叠合定案：忙时双击 = 停生成 + 全停子代理（一次操作两件事）
				} else {
					this.lastEscCancel = Date.now();
					this.showToast("再按一次 Esc 停止生成与全部子代理");
				}
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
			// 视觉转述等待期双击 Esc（走查四）：非 busy 独立态（turn 未开始）——busy 分支管不到。
			// 判定口径与 busy 双击同款；overlay 已关才轮到本分支（Esc 优先关菜单）
			if (this.io.visionTranscribing?.() === true) {
				if (Date.now() - this.lastEscCancel < 1000) {
					this.lastEscCancel = 0;
					s.toast = undefined;
					this.io.abortVisionTranscribe?.();
				} else {
					this.lastEscCancel = Date.now();
					this.showToast("再按一次 Esc 中止转述（消息不发出，重发即续）");
				}
				this.scheduler.requestImmediateRender();
				return;
			}
			// M4.5 T14：焦点在输入框且有子代理在册（跑着/排队/闪现）→ 双击 Esc 全停（1 秒窗口——
			// 与忙时停生成同款判定；判定在前不被下方 reset 冲掉；无子代理时零改动——直接回焦点）
			if (s.focusIdx === 0 && this.subagentsVisible()) {
				if (Date.now() - this.lastEscCancel < 1000) {
					this.lastEscCancel = 0;
					s.toast = undefined;
					this.io.stopAllSubagents?.();
				} else {
					this.lastEscCancel = Date.now();
					this.showToast("再按一次 Esc 停止全部子代理");
				}
				this.scheduler.requestImmediateRender();
				return;
			}
			this.lastEscCancel = 0;
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
				if (s.statePage === 1) {
					// 网络·MCP 页：连接列表翻页（纯页号 ±1——渲染期夹回；server 增减不炸）
					const conns = this.io.panelData().network?.connections ?? [];
					const connPages = Math.max(1, Math.ceil(conns.length / CONN_SLOTS));
					s.connPage = Math.max(0, Math.min(connPages - 1, s.connPage + (key === "pageUp" ? -1 : 1)));
				} else {
					const mods = this.io.panelData().modules;
					s.moduleSel = Math.max(0, Math.min(mods.length - 1, s.moduleSel + (key === "pageUp" ? -MODULE_SLOTS : MODULE_SLOTS)));
				}
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
				// 模块选择只在运行状态页（2026-10-01）：网络·MCP 页无选择语义——旧态 ↑↓ 隔页挪 moduleSel 属暗改
				if (s.statePage === 0) s.moduleSel = Math.max(0, Math.min(mods.length - 1, s.moduleSel + (key === "up" ? -1 : 1)));
			} else if (key === "left" || key === "right") {
				// 右上卡组翻页（m5 T6）：[运行状态, 网络·MCP, ...top 模块卡] 循环；先夹回（卡消失后页号可能越界）
				const pages = 2 + (this.io.panelData().cards ?? []).filter((c) => c.area === "top").length;
				s.statePage = (Math.min(s.statePage, pages - 1) + (key === "left" ? -1 : 1) + pages) % pages;
			} else if (key === "enter") {
				// 模块热插拔（2026-09-23 用户拍板）：锁定项 toast 锁因；可插拔项宿主写 enabled + reload；
				// 待确认项（m5 T17）：回车弹首挂确认窗（声明面人话清单→确认三动作）。
				// 只在运行状态页生效（2026-10-01）：网络·MCP 页回车不隔页热插拔看不见的模块
				if (s.statePage !== 0) return;
				const m = mods[s.moduleSel];
				if (m !== undefined) {
					if (m.state === "pendingConfirm") this.io.confirmModule?.(m.name);
					else this.io.toggleModule?.(m.name, m.locked === true ? (m.lockedReason ?? "锁定") : undefined);
				}
			}
		} else if (s.focusIdx === 2) {
			const d = this.io.panelData();
			const bottomPages = 1 + (d.cards ?? []).filter((c) => c.area === "bottom").length;
			if (key === "up" || key === "down") {
				if (s.taskPage === 0) {
					s.taskSel = Math.max(0, Math.min(d.tasks.length - 1, s.taskSel + (key === "up" ? -1 : 1)));
				}
				// 卡页无选择项——↑↓ 不落任务选择（防隐性挪动选中）
			} else if (key === "left" || key === "right") {
				// 右下卡组翻页（m5 T6）：[任务清单, ...bottom 模块卡] 循环
				s.taskPage = (Math.min(s.taskPage, bottomPages - 1) + (key === "left" ? -1 : 1) + bottomPages) % bottomPages;
			}
		} else {
			this.onEditKey(key);
			return;
		}
		this.scheduler.requestImmediateRender();
	}

	/** 参数阶段探测（m5 T15）：输入已是「/命令 参数」形态且该命令声明了补全 → 菜单切参数候选。
	 *  优先于二级列表（children 是菜单选定驱动，参数阶段是文本驱动）。 */
	private argPhase(): { cmd: string; word: string; args: string; items: string[] } | undefined {
		const typed = this.state.input; // 原始输入——normCmd 会裁尾空格，而尾空格正是参数阶段的触发形态
		if (!typed.startsWith("/")) return undefined;
		const sp = typed.indexOf(" ");
		if (sp <= 0) return undefined;
		const cmd = typed.slice(0, sp);
		const args = typed.slice(sp + 1);
		const word = args.split(/\s+/).pop() ?? "";
		const all = this.io.slashArgComplete?.(cmd, word, args);
		if (all === undefined || all.length === 0) return undefined;
		return { cmd, word, args, items: all.filter((x) => x.startsWith(word)) };
	}

	/** 斜杠菜单当前候选清单（onOverlayKey 与滚轮路由共用一源——两处过滤口径漂移即选中越界/Enter 错位）。
	 *  m4-7 T7：一级含技能区（sep 分隔行 + 技能条目殿后于命中命令）；key 一级命令 = 命令名、技能 = 真名。
	 *  （m4-3c T18 曾加 MCP 区，2026-09-30 用户打回「没有意义」整段退役——管理面唯一入口 /settings。） */
	private overlayItems(): { key: string; kind: "cmd" | "skill" | "sep" }[] {
		const s = this.state;
		const level2 = s.overlayCmd !== "";
		const ap = this.argPhase();
		if (ap !== undefined) return ap.items.map((c) => ({ key: c, kind: "cmd" as const }));
		if (level2) return (this.io.slashCommands().find((c) => c.name === s.overlayCmd)?.children ?? []).map((c) => ({ key: c, kind: "cmd" as const }));
		const cmds = this.filteredCommands().map((c) => ({ key: c.name, kind: "cmd" as const }));
		const skills = this.filteredSkills().map((c) => ({ key: c.skill ?? c.name, kind: "skill" as const }));
		const out: { key: string; kind: "cmd" | "skill" | "sep" }[] = [...cmds];
		if (skills.length > 0) out.push({ key: "", kind: "sep" as const }, ...skills);
		return out;
	}

	/** 技能区过滤（m4-7 T7，原型图 1）：技能名档位（前缀排前、含字居中、子序列殿后——2026-09-30
	 *  第三档拍板）殿后于全部命中命令；技能组整体不插进命令组（「追加在全部命中命令之后」）。q 为空 = 全显。
	 *  可搜文本 = 真名 + 显示标签「skill : 名」：只认真名则 /skas 筛不出 ask（skas 非 ask 子序列），认标签才成立。 */
	private filteredSkills(): SlashItem[] {
		const q = normCmd(this.state.input).slice(1).split(" ")[0]!.toLowerCase();
		const hits: SlashItem[] = [];
		const more: SlashItem[] = [];
		const fuzzy: SlashItem[] = [];
		for (const c of this.io.skillItems?.() ?? []) {
			const n = (c.skill ?? c.name).toLowerCase();
			const label = `skill : ${n}`;
			if (n.startsWith(q) || label.startsWith(q)) hits.push(c);
			else if (n.includes(q) || label.includes(q)) more.push(c);
			else if (isSubseq(q, n) || isSubseq(q, label)) fuzzy.push(c);
		}
		return [...hits, ...more, ...fuzzy];
	}

	/** overlaySel 夹到可选行（sep 不可选——重置 0/滚窗后落 sep 时沿向下让位）。 */
	private selToSelectable(rows: { kind: string }[], from: number): number {
		let i = Math.max(0, Math.min(rows.length - 1, from));
		while (i < rows.length - 1 && rows[i] !== undefined && rows[i]!.kind === "sep") i++;
		return i;
	}

	private onOverlayKey(key: string): void {
		const s = this.state;
		const level2 = s.overlayCmd !== "";
		const ap = this.argPhase();
		const items = this.overlayItems();
		// 循环步进跳过 sep（m4-7 技能分隔行不可选——up/down 回绕也越不过它停上去）
		const step = (from: number, delta: number): number => {
			let i = from;
			do { i = (i + delta + items.length) % items.length; } while (items[i] !== undefined && items[i]!.kind === "sep");
			return i;
		};
		if (key === "escape") {
			if (level2) {
				s.overlayCmd = "";
				s.input = "/";
				s.cursor = 1;
				s.overlaySel = 0;
			} else s.overlayOpen = false; // 参数阶段也走这里：只关菜单不清输入（Esc 回命令名阶段 = 继续编辑参数）
		} else if (key === "up" && items.length > 0) {
			s.overlaySel = step(s.overlaySel, -1);
		} else if (key === "down" && items.length > 0) {
			s.overlaySel = step(s.overlaySel, 1);
		} else if (key === "pageUp" && items.length > 0) {
			s.overlaySel = this.selToSelectable(items, s.overlaySel - OVERLAY_PAGE);
		} else if (key === "pageDown" && items.length > 0) {
			s.overlaySel = this.selToSelectable(items, s.overlaySel + OVERLAY_PAGE);
		} else if (key === "tab" && ap !== undefined && items.length > 0) {
			// 参数阶段 Tab（m5 T15）：选中候选替换当前词 + 空格（可继续补下一词）
			const picked = items[s.overlaySel] ?? items[0]!;
			const head = ap.args.slice(0, ap.args.length - ap.word.length);
			s.input = `${ap.cmd} ${head}${picked.key} `;
			s.cursor = s.input.length;
			s.overlaySel = 0;
		} else if (key === "tab" && !level2 && items.length > 0) {
			// 技能 Tab 填可输入形态「/skill : 名」（2026-09-30 用户拍板：Tab ≠ Enter——回车直接执行技能，
			// Tab 落输入框可编辑，提交层 processReplLine 解析该格式再注入正文）；命令行 Tab 照旧补全命令名
			const sel = items[s.overlaySel];
			s.input = sel?.kind === "skill" ? `/skill : ${sel.key}` : sel?.key ?? s.input;
			s.cursor = s.input.length;
			s.overlayOpen = false;
		} else if (key === "enter") {
			// 「/skill : 名 [参数]」完整形态（Tab 填出或手敲，2026-09-30 拍板「我输入啥就显示啥」）：
			// 菜单开着也提交原话走提交层（processReplLine 解析：原话回显 + 参数随技能注入）——不在此处
			// fireSkill（只带名字会丢参数也不回显）；零命中空态同样放行（否则带参形态被空态卡死无法发）；
			// 纯过滤词（/pdf 之类无冒号形态）维持「回车直接执行技能」拍板不变
			if (/^\/skill\s*:\s*\S/i.test(normCmd(s.input))) {
				s.overlayOpen = false;
				s.overlayCmd = "";
				this.submitLine(normCmd(s.input));
				this.scheduler.requestImmediateRender();
				return;
			}
			if (items.length === 0) {
				this.scheduler.requestImmediateRender();
				return;
			}
			if (ap !== undefined) {
				// 参数阶段 Enter（m5 T15）：选中候选替换当前词后提交（未选中任何行 = 提交原文）
				const picked = items[s.overlaySel];
				const final = picked === undefined ? normCmd(s.input) : `${ap.cmd} ${ap.args.slice(0, ap.args.length - ap.word.length)}${picked.key}`;
				s.overlayOpen = false;
				s.overlayCmd = "";
				this.submitLine(final);
				this.scheduler.requestImmediateRender();
				return;
			}
			// CTU-01 修复（2026-09-28 code review P0）：粘贴收缩清单/技能清单 5s TTL 异步换数组后 overlaySel
			// 可越界（渲染侧只算不回写），消费侧就地钳制——selToSelectable 夹回 [0, len-1] 并避开 sep 行
			s.overlaySel = this.selToSelectable(items, s.overlaySel);
			const row = items[s.overlaySel]!;
			if (row.kind === "skill") {
				// 技能 Enter = 用户触发（m4-7 T7 / 原型图 1 验收点 4）
				this.fireSkill(row.key);
				this.scheduler.requestImmediateRender();
				return;
			}
			const picked = row.key;
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
			// 重置选中须按敲键后的新清单算（2026-09-30 用户走查：/mc+/p 把命中命令筛光后 sep 占 0 位，
			// 旧实现用敲键前 items 重置 0 落 sep——渲染不跳 sep 焦点整屏隐身，Tab 还吃 sep 空串清空输入框）
			if (normCmd(s.input).startsWith("/")) s.overlaySel = this.selToSelectable(this.overlayItems(), 0);
			else s.overlayOpen = false;
		}
		this.scheduler.requestImmediateRender();
	}

	/** 技能条目 Enter 触发：正文以用户消息注入当前轮（m4-7 D3 拍板，pi/kimi 同款——走主输入口，
	 *  busy 期照排队语义，不打断 turn 机制）。读不到正文 = toast 提示留菜单。
	 *  Tab 不走此路（2026-09-30 拍板）：Tab 填「/skill : 名」可输入形态，提交层解析后殊途同归。 */
	private fireSkill(name: string): void {
		const text = this.io.skillInject?.(name);
		if (text === undefined) {
			this.showToast(`技能 "${name}" 正文读取失败——文件可能已被移动或删除（/reload 后重试）`);
			return;
		}
		this.state.overlayOpen = false;
		this.state.overlayCmd = "";
		this.submitLine(text);
	}

	private onEditKey(key: string): void {
		const s = this.state;
		switch (key) {
			case "enter":
				if (normCmd(s.input) !== "") this.submitLine(normCmd(s.input));
				break;
			case "alt+enter":
			case "shift+enter": // Shift+Enter = 换行（2026-09-27 用户拍板；keymatch 两形态：裸 LF / CSI-u）
				this.inputInsert("\n");
				break;
			case "ctrl+c": // 2026-09-30 用户拍板：输入框键盘选区复制；无选区吞键维持现状（WT 原生复制让位不动）
				void this.copyInputSelection();
				break;
			case "ctrl+a":
				s.selAnchor = 0;
				s.cursor = s.input.length;
				this.clearStreamSelection(); // 键盘选区诞生清拖选高亮（2026-09-30 拍板：屏幕最多一块高亮）
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
					// CTU-02 修复（2026-09-28 code review）：光标前一位（cursor-1）落在代理对的低代理
					// （0xdc00–0xdfff）且再前一位是高代理 → 整对删除。原判定区间写反（按高代理
					// 0xd800–0xdbff 判），emoji 退格一次只删低代理、残留孤立高代理——对齐 moveCursor 的写法
					const cp = s.input.codePointAt(s.cursor - 1)!;
					const prev2 = s.input.charCodeAt(s.cursor - 2);
					const w = cp >= 0xdc00 && cp <= 0xdfff && prev2 >= 0xd800 && prev2 <= 0xdbff ? 2 : 1;
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
		// 命令词忽略大小写（2026-09-27 用户走查拍板）：/He /HELP 都能筛出 /help——q 与命令名/别名
		// 统一小写比较；Enter 提交菜单真名（picked），不带过滤串的大小写进输入
		const q = normCmd(this.state.input).slice(1).split(" ")[0]!.toLowerCase();
		// 别名可筛（F5 十六轮①：/exit /q /rename /resume 都能过滤出真实命令——Enter 提交真名）
		// 前缀命中排前、含字命中居中、子序列命中殿后（2026-09-24 拍板两档 + 2026-09-30 第三档：
		// /ol 先列 ol 开头，再列含 ol 的 /yolo，末列字符按序散见的）——组内保持注册序
		const hits: SlashItem[] = [];
		const more: SlashItem[] = [];
		const fuzzy: SlashItem[] = [];
		for (const c of this.io.slashCommands()) {
			const lowerName = c.name.toLowerCase();
			const aliases = (c.aliases ?? []).map((a) => a.toLowerCase());
			if (lowerName.startsWith("/" + q) || aliases.some((a) => a.startsWith(q))) hits.push(c);
			else if (lowerName.slice(1).includes(q) || aliases.some((a) => a.includes(q))) more.push(c);
			else if (isSubseq(q, lowerName.slice(1)) || aliases.some((a) => isSubseq(q, a))) fuzzy.push(c);
		}
		return [...hits, ...more, ...fuzzy];
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
		// CTU-09（2026-09-28 code review）：顶框标题源头截断（card.title 模块供给可超长——原靠 padToWidth
		// 兜底会把右侧框角 ╮ 切掉）。预算 = w − ╭─(2) − 首尾空格(2) − 最小 fill(1) − 最小 en 段(4) ─╮(2)
		const titleFit = truncateToWidth(title, Math.max(4, w - 11));
		const titleSeg = focused ? theme.fg("accent", ` ${titleFit} `) : theme.fg("muted", ` ${titleFit} `);
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
		const dot = m.state === "mounted" ? theme.fg("accent", "●") : m.state === "loading" || m.state === "pendingConfirm" ? theme.fg("warn", "◐") : theme.fg("muted", "○");
		// 锁定后缀（2026-09-23 用户拍板）：名字后灰色「· 锁定」；行尾状态位照常显示挂载态
		const lockSuffix = m.locked === true ? theme.dim(" · 锁定") : "";
		const stateText = MOD_STATE_TEXT[m.state]!;
		const st = m.state === "mounted" ? theme.fg("accent", stateText) : m.state === "loading" || m.state === "pendingConfirm" ? theme.fg("warn", stateText) : theme.dim(stateText);
		const lockW = m.locked === true ? visibleWidth(" · 锁定") : 0; // 锁定后缀占宽——desc/gap 预算要扣（防溢出）
		// CTU-09（2026-09-28 code review）：模块名源头截断（注册面供给可超长——原 padToWidth 兜底把行尾
		// 状态字切掉）。预算 = w − 前缀「 ● 」(3) − 锁定后缀 − 状态字 − 最小 gap(1)
		const nameTxt = truncateToWidth(m.name, Math.max(4, w - 3 - lockW - visibleWidth(stateText) - 1));
		const name = (m.state === "off" ? theme.fg("muted", nameTxt) : selected ? theme.fg("accent", nameTxt) : nameTxt) + lockSuffix;
		const descBudget = w - (3 + visibleWidth(nameTxt) + lockW + 1 + visibleWidth(stateText) + 1);
		const desc = descBudget >= visibleWidth(m.desc) ? theme.dim(m.desc) : descBudget >= 8 ? truncateToWidth(theme.dim(m.desc), descBudget) : "";
		const leftW = 3 + visibleWidth(nameTxt) + lockW + (desc === "" ? 0 : 1 + visibleWidth(desc));
		const gap = Math.max(1, w - leftW - visibleWidth(stateText));
		const row = ` ${dot} ${name}${desc === "" ? "" : ` ${desc}`}${" ".repeat(gap)}${st}`;
		return selected ? theme.bg("accentSoft", padToWidth(row, w)) : row;
	}

	/** 「网络 · MCP」卡连接行（2026-10-01）：布局同 modRow（点+名+说明+右列），无选中态/锁定后缀；
	 *  五态点色对齐管理面口径——connected 绿 ● / failed·未确认 红 ● / idle·停用 灰 ○（mcp-cmd 同款）。
	 *  右列：connected 有首连耗时时显耗时（被动真值），否则状态文案。 */
	private connRow(c: NonNullable<PanelData["network"]>["connections"][number], w: number): string {
		const stateText = CONN_STATE_TEXT[c.state]!;
		const dot =
			c.state === "connected" ? theme.fg("accent", "●") : c.state === "failed" || c.state === "pending-confirm" ? theme.fg("err", "●") : theme.fg("muted", "○");
		const right =
			c.state === "connected" && c.connectMs !== undefined
				? theme.fg("muted", msText(c.connectMs))
				: c.state === "connected"
					? theme.fg("accent", stateText)
					: c.state === "failed" || c.state === "pending-confirm"
						? theme.fg("err", stateText)
						: theme.dim(stateText);
		// 名字源头截断（同 modRow CTU-09 预算式）：w − 前缀「 ● 」(3) − 右列实宽 − gap(1) − 右端呼吸(1)
		// （2026-10-01 走查「顶飞」修：名字多让 1 列，右列与边框恒 ≥1 空隙——pane padToWidth 补尾空格）
		const nameTxt = truncateToWidth(c.name, Math.max(4, w - 3 - visibleWidth(right) - 2));
		const name = c.state === "idle" || c.state === "disabled" ? theme.fg("muted", nameTxt) : nameTxt;
		// 说明段两段降级（2026-10-01 走查拍板「字体大时传输方式不显示」——预算驱动非硬阈值）：
		// 全段「stdio · 12 工具」→ 中段「12 工具」（丢传输方式）→ 空；裸传输段（无「 · 」）窄卡直接空。
		// 预算整体再让 1 列（… −1 尾）：全段「刚好吃满」时 gap 会被 max(1) 钉死→行满宽贴边框（w=48 实测）
		const descBudget = w - (3 + visibleWidth(nameTxt) + 1 + visibleWidth(right) + 1) - 1;
		const sep = c.desc.indexOf(" · ");
		const shortDesc = sep >= 0 ? c.desc.slice(sep + 3) : undefined;
		const descText =
			c.desc !== "" && descBudget >= visibleWidth(c.desc)
				? c.desc
				: shortDesc !== undefined && descBudget >= visibleWidth(shortDesc)
					? shortDesc
					: "";
		const desc = descText === "" ? "" : theme.dim(descText);
		const leftW = 3 + visibleWidth(nameTxt) + (desc === "" ? 0 : 1 + visibleWidth(descText));
		// gap 恒给右端留 1 列（2026-10-01 走查「顶飞」修：右列贴死边框观感差）；名字预算已让 1 列，闭环恒 ≤ w−1
		const gap = Math.max(1, w - leftW - visibleWidth(right) - 1);
		return ` ${dot} ${name}${desc === "" ? "" : ` ${desc}`}${" ".repeat(gap)}${right}`;
	}

	private statusRows(w: number, h: number): string[] {
		const s = this.state;
		const d = this.io.panelData();
		const focused = s.focusIdx === 1;
		const inner = w - 2;
		// 右上页序数组化（m5 T6，决策点 10 area:"top" 落位）：[运行状态, 网络·MCP, ...top 模块卡（按 order）]——
		// 内建固定在前、模块卡排后（决策点 12）；页号渲染期夹回（卸载拆卡不需要通知——每秒现读自然消失）
		const topCards = (d.cards ?? []).filter((c) => c.area === "top");
		const pages = 2 + topCards.length;
		const page = Math.min(s.statePage, pages - 1);
		if (page === 0) {
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
			const modPages = Math.max(1, Math.ceil(d.modules.length / slots));
			const modPage = Math.min(modPages - 1, Math.floor(s.moduleSel / slots));
			const lo = modPage * slots;
			const headL = ` ${theme.fg("muted", "模块挂载")}`;
			const headR = theme.dim(`${modPage + 1}/${modPages} · MODULES`);
			content.push(headL + " ".repeat(Math.max(1, inner - visibleWidth(headL) - visibleWidth(headR))) + headR);
			for (let i = lo; i < Math.min(d.modules.length, lo + slots); i++) {
				content.push(this.modRow(d.modules[i]!, focused && i === s.moduleSel, inner));
			}
			return this.panelBox("运行状态", `1/${pages}`, focused, w, h, content, ["←→ 翻页 · PgUp/PgDn 模块翻页", "↑↓ 模块选择 · Enter 挂/卸载"], undefined, [this.sep(inner)]);
		}
		if (page === 1) {
			// 2026-10-01 拍板填实（占位行退役）：被动真值——代理态 + 模型服务信息行 + mcp.catalog 五态
			// 连接列表（首连耗时）；主动健康探测（出网/DNS 周期 ping）维持方案书「另议」缺位，不假装有数据
			const n = d.network;
			const content: string[] = [];
			if (n === undefined) {
				content.push(` ${theme.fg("muted", "（网络面数据未装配——供数退化，详见诊断日志）")}`);
			} else {
				content.push(this.kvRow("代理", n.proxy, inner));
				content.push(this.kvRow("模型服务", n.modelService, inner));
			}
			content.push(this.sep(inner));
			const conns = n?.connections ?? [];
			const connPages = Math.max(1, Math.ceil(conns.length / CONN_SLOTS));
			const connPage = Math.min(s.connPage, connPages - 1);
			const lo = connPage * CONN_SLOTS;
			const headL = ` ${theme.fg("muted", "网络 / MCP 连接")}`;
			// 右段窄卡降级（2026-10-01 走查「顶飞」修：标题+右段超内宽曾被 padToWidth 腰斩成「1/1 · SER」贴边）——
			// 余量不足先丢「· SERVERS」后缀只留页码；标题侧不截（与页 0「模块挂载」头同权重）
			const pageTag = `${connPage + 1}/${connPages}`;
			const room = inner - visibleWidth(headL) - 1;
			const headR = theme.dim(room >= visibleWidth(`${pageTag} · SERVERS`) ? `${pageTag} · SERVERS` : pageTag);
			content.push(headL + " ".repeat(Math.max(1, inner - visibleWidth(headL) - visibleWidth(headR))) + headR);
			content.push(this.sep(inner)); // 小节头与列表之间分隔线（2026-10-01 走查打回：贴太近）
			if (conns.length === 0) {
				content.push(` ${theme.fg("muted", "（无 MCP server——/settings 添加，或模块挂载页启用 mcp）")}`);
			}
			for (let i = lo; i < Math.min(conns.length, lo + CONN_SLOTS); i++) {
				content.push(this.connRow(conns[i]!, inner));
			}
			// 提示两行制（2026-10-01 走查打回：单行 27 列在窄侧栏被 wrapText 折行——拆两行各保短，行数恒定不闪）
			return this.panelBox("网络 · MCP", `2/${pages}`, focused, w, h, content, ["←→ 切卡 · Esc 返回", "PgUp/PgDn 连接翻页"], undefined, [this.sep(inner)]);
		}
		return this.renderModuleCard(topCards[page - 2]!, w, h, focused, page, pages);
	}

	/** 模块卡页（m5 T6）：控件清单走只读渲染器；渲染抛错 = 当帧占位行 + 日志（全局约束 4——窗/卡保留）。 */
	private renderModuleCard(card: ModuleCard, w: number, h: number, focused: boolean, page: number, pages: number): string[] {
		const inner = w - 2;
		let content: string[];
		try {
			content = renderWidgets(card.widgets, inner);
		} catch (err) {
			this.io.logWarn?.("tui.card.render-error", `模块卡渲染抛错，当帧占位：${card.title}`, { error: String(err instanceof Error ? err.message : err) });
			content = [` ${theme.fg("warn", "（卡片渲染出错——下帧恢复即回，见诊断日志）")}`];
		}
		return this.panelBox(card.title, `${page + 1}/${pages}`, focused, w, h, content, ["←→ 切卡 · Esc 返回"], undefined, [this.sep(inner)]);
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
		// 右下卡组（m5 T6）：[任务清单（内建在前）, ...bottom 模块卡（按 order）]；单卡（无模块卡）时页码隐藏
		const bottomCards = (d.cards ?? []).filter((c) => c.area === "bottom");
		const pages = 1 + bottomCards.length;
		const page = Math.min(s.taskPage, pages - 1);
		if (page > 0) return this.renderModuleCard(bottomCards[page - 1]!, w, h, focused, page, pages);
		const done = d.tasks.filter((t) => t.state === "done").length;
		const slots = this.taskPageSlots();
		const itemPages = Math.max(1, Math.ceil(d.tasks.length / slots));
		const itemPage = Math.min(itemPages - 1, Math.floor(s.taskSel / slots));
		const lo = itemPage * slots;
		const content: string[] = [];
		for (let i = lo; i < Math.min(d.tasks.length, lo + slots); i++) {
			const t = d.tasks[i]!;
			const text =
				t.state === "done"
					? `\x1b[9m${theme.fg("muted", t.text)}\x1b[29m`
					: t.state === "active"
						? theme.fg("warn", t.text)
						: theme.fg("fg", t.text);
			const row = ` ${taskTick(t.state)} ${truncateToWidth(text, inner - 4)}`;
			content.push(focused && i === s.taskSel ? theme.bg("accentSoft", padToWidth(row, inner - 1)) : row);
		}
		const footL = theme.dim(" 由 Agent 实时同步");
		const pageTag = itemPages > 1 ? ` · 第 ${itemPage + 1}/${itemPages} 页` : ""; // 任务条目分页并进注脚（页码位让给卡组）
		const footR = theme.dim(`任务数：${done}/${d.tasks.length}${pageTag}`);
		const footer = [footL + " ".repeat(Math.max(1, inner - visibleWidth(footL) - visibleWidth(footR))) + footR];
		return this.panelBox("任务清单", pages > 1 ? `1/${pages}` : "", focused, w, h, content, pages > 1 ? ["←→ 切卡 · PgUp/PgDn 任务翻页 · Esc 返回"] : ["PgUp/PgDn 翻页 · Esc 返回"], footer, [this.sep(inner)]);
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

	/** 流区几何与行源（m5 鼠标批 T5 提取——renderFrame 与鼠标映射 pointToDoc 共用一源，
	 *  两处漂移即选区错位；方案级纪律）。输入框/队列区行数一并带出（streamH 的计算依赖，
	 *  renderFrame 直接消费）。
	 *  m5-render-perf T5 窗口化：不再持有全量行数组——dmTotal = 宿主总行数 + 尾行 1，
	 *  doc = 视口窗口（streamH + 余量 streamH，设计空白 #6 视口×2），start 语义不变（全局首行
	 *  下标）；消费面全部走「dmTotal 当总长 / doc 局部下标 = 全局下标 − start」。 */
	private layoutFrame(): {
		cols: number; rows: number; leftW: number; streamH: number; start: number;
		dmTotal: number; doc: string[]; inputRows: InputRow[]; cursorPos: { row: number; col: number };
		showRows: number; queue: string[]; queueH: number;
	} {
		const cols = this.io.columns();
		const rows = this.io.rows();
		const s = this.state;
		const sidebarW = s.sidebarVisible ? this.sidebarW() : 0; // 隐藏 = 左栏占满（无面板）
		// 2026-09-27 用户走查拍板：左栏与侧栏间的分隔线退役——原分隔线列并入左栏（左栏 +1 列，
		// 输入框与滚动条随之右扩；面板紧贴左栏、自身宽度不变）
		const leftW = cols - sidebarW - 1;
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
		const dmTotal = this.io.docTotal() + 1; // + 尾行（spinner/待命——恒 1 行，tailLine 并入窗口尾）
		const maxScroll = Math.max(0, dmTotal - streamH);
		// 滚动钉住（走查①修，走查⑦统一式）：scrollBack 是「距底行数」，内容增缩都会顶走视口——
		// 统一补偿 tailDelta = 总变化 − 头部平移（增长补正、收缩补负，恒保视口 start；学 kimi
		// agent-activity-viewer 的顶锚免疫：其 scrollTop 从顶数、内容更新只做 followTail 贴底/超界钳制）。
		// 头部平移（滑窗裁剪，经 docHeadShift 差分）不补——行号平移后视口内容本就不动（T7 几何论证）。
		// 跟随态（scrollBack = 0）不补照旧贴底。
		if (this.lastTotal >= 0 && s.scrollBack > 0) {
			const headNow = this.io.docHeadShift?.() ?? 0;
			const tailDelta = dmTotal - this.lastTotal + (headNow - this.lastHeadShift);
			this.lastHeadShift = headNow;
			if (tailDelta !== 0) s.scrollBack = Math.max(0, Math.min(maxScroll, s.scrollBack + tailDelta));
		} else if (this.io.docHeadShift !== undefined) {
			this.lastHeadShift = this.io.docHeadShift();
		}
		this.lastTotal = dmTotal;
		s.scrollBack = Math.min(s.scrollBack, maxScroll);
		const end = dmTotal - s.scrollBack;
		const start = Math.max(0, end - streamH);
		const doc = this.docRows(start, streamH * 2); // 视口 ×2 余量：滚动一帧内不重算边界（#6）
		return { cols, rows, leftW, streamH, start, dmTotal, doc, inputRows, cursorPos, showRows, queue, queueH };
	}

	/** 上一帧总行数（滚动钉住的增量基准）。 */
	private lastTotal = -1;
	/** 上次头部平移累计（tailDelta 差分基准——走查⑦）。 */
	private lastHeadShift = 0;

	/** 行源窗口：dm 行 + 尾行并入（旧 [...io.doc(), tailLine()] 的窗口化形态——尾行恒 1 行，
	 *  dm 短返回时补上）。 */
	private docRows(start: number, count: number): string[] {
		const out = this.io.docWindow(start, count);
		if (out.length < count && start + out.length === this.io.docTotal()) out.push(this.tailLine());
		return out;
	}

	/** 帧级错误边界（CTU-12 2026-09-28 code review）：主渲染帧每帧现调宿主回调（io.doc/panelData——其
	 *  cards getter 自述已知会抛/queueItems），无防护时异常沿 scheduler 定时器/nextTick 逃逸为
	 *  uncaughtException 杀进程。与 fireDialogEvent/renderModuleCard 的全局约束 4 同款降级：失败帧
	 *  logWarn + 占位错误帧——渲染期异常从进程级降为帧级，宿主下一帧恢复即回。 */
	private renderFrame(): number {
		try {
			return this.renderFrameInner();
		} catch (err) {
			this.io.logWarn?.("tui.render.frame-error", "渲染帧抛错，占位帧兜底", { error: String(err instanceof Error ? err.message : err) });
			let rows = 24;
			let cols = 80;
			try {
				rows = Math.max(4, this.io.rows());
				cols = Math.max(8, this.io.columns());
			} catch {
				/* 宿主连尺寸口都抛——缺省几何尽力画 */
			}
			const screen: string[] = Array.from({ length: rows }, () => "");
			screen[0] = truncateToWidth(theme.fg("warn", " 渲染出错——下一帧自动恢复，详见诊断日志（Ctrl + E）"), cols);
			return this.full.render(screen, rows, cols, undefined);
		}
	}

	private renderFrameInner(): number {
		this.selectionGuard(); // T8：关窗首帧清 scope=view 残留选区
		const { cols, rows, leftW, streamH, start, dmTotal, doc, inputRows, cursorPos, showRows, queue, queueH } = this.layoutFrame();
		const s = this.state;

		// 面板行只在侧栏可见时计算（隐藏时 sidebarW=0 会让 panelBox 内宽为负——repeat 炸）
		const sidebarW = s.sidebarVisible ? this.sidebarW() : 0;
		const statusH = Math.max(8, Math.floor(rows * 0.55));
		const taskH = rows - statusH;
		const status = s.sidebarVisible ? this.statusRows(sidebarW, statusH) : [];
		const tasks = s.sidebarVisible ? this.taskRows(sidebarW, taskH) : [];

		const inputFocused = s.focusIdx === 0;
		const ibc = inputFocused ? "accent" : "border";
		const screen: string[] = Array.from({ length: rows }, () => "");
		for (let r = 0; r < streamH; r++) {
			// 消息区左内衬 2 列（2026-09-23 用户拍板：文字起始贴屏幕左缘难看）——docmodel 折行口径
			// = streamW − 2，前导 2 空格后恰 = leftW 不截尾；空行也垫，块状整体右移保持对齐；
			// 选区行反白合入（m5 鼠标批 T5）。窗口化（T5）：doc[r] 即全局 start+r 行（窗口从 start 起）
			const raw = doc[r] === undefined ? "" : `  ${doc[r]!}`;
			screen[r] = padToWidth(this.styleDocSelection("main", start + r, raw), leftW);
		}
		// 滚动条（T10）：内容超一屏才显示——右缘 1 列轨道/拇指；文字截在 leftW−2、与轨道间
		// 空 1 列（2026-09-27 用户走查两轮定稿：先一个字（2 列）、后收窄为 1 列——满宽行不贴轨道）。
		// 截断必须 truncateToWidth（严格语义——宽字符跨界整体让位）+ padToWidth 补齐恒宽：
		// sliceByColumn 相交语义截点落汉字中间时行超 1 列、严格截断在汉字边界让位 1 列不补齐则
		// 满宽行与短行差 1 列——两种不齐都会让分隔线/滚动条逐行错开即界面错乱（走查打回实锤）
		const mthumb = thumbGeometry(streamH, dmTotal, start);
		if (mthumb !== undefined) {
			for (let r = 0; r < streamH; r++) {
				const onThumb = r >= mthumb.top && r < mthumb.top + mthumb.height;
				const ch = onThumb
					? theme.fg(s.scrollbarHover === "main" ? "accent" : "muted", "█")
					: theme.dim("│");
				screen[r] = padToWidth(truncateToWidth(screen[r] ?? "", leftW - 2), leftW - 2) + " " + ch;
			}
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
		// 遮蔽的流区内容随自消还原（m5 T3：显示窗长随时长参数——不传 = 缺省 3000）
		if (s.toast !== undefined && Date.now() - s.toast.at < (s.toast.duration ?? 3000)) {
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
		const subCnt = this.io.subagentRunningCount?.() ?? 0;
		const subHint = subagentCountHint(subCnt);
		const leftHint = `${chip}${theme.dim(" · Shift + Tab 切换模式")}${subHint !== "" ? theme.dim(" · ") + subHint : ""}`;
		const rightHint = theme.dim("Enter 发送 · Alt + Enter 换行 · / 命令 · Tab 面板焦点 · Esc 返回");
		const hintW = leftW - 2;
		const gap = hintW - visibleWidth(leftHint) - visibleWidth(rightHint) - 1;
		screen[divRow + 1 + showRows] = paneIn(
			gap > 2 ? ` ${leftHint}${" ".repeat(gap)}${rightHint}` : padToWidth(` ${leftHint}`, hintW),
		);
		screen[divRow + 2 + showRows] = theme.fg(ibc, "╰" + "─".repeat(Math.max(1, leftW - 2)) + "╯");

		if (s.sidebarVisible) {
			// 2026-09-27 用户走查拍板：左栏-侧栏分隔线退役——面板直接拼接（自带框线不缺分隔感）
			for (let r = 0; r < rows; r++) {
				const right = r < statusH ? (status[r] ?? "") : (tasks[r - statusH] ?? "");
				screen[r] = (screen[r] ?? "") + right;
			}
		}

		let overlay: OverlayFrame | undefined;
		if (this.onboarding !== undefined) {
			// dock = 输入框几何（2026-10-02 用户拍板，推翻居中+固定 96 宽）：底边贴输入框上缘、
			// 左缘对齐、宽度一致（leftW）——view/dialog 窗 dock 同款；定高防闪烁纪律不变
			const ob = this.onboarding.session.render(cols, rows, { bottom: divRow, width: leftW });
			overlay = { lines: ob.lines, row: ob.row, col: ob.col, width: ob.width };
		} else if (this.pendingUi?.kind === "pick") {
			const pu = this.pendingUi;
			overlay = this.buildPickOverlay(leftW, divRow, pu.title, pu.items, pu.sel, pu.filter, pu.extraKeys);
		} else if (this.pendingUi?.kind === "view") {
			const pu = this.pendingUi;
			if (pu.live !== undefined) pu.lines = pu.live().split("\n"); // M4.5 T11：实时查看窗——每帧现算（滚动钳制在 build 内）
			overlay = this.buildViewOverlay(pu, leftW, divRow);
		} else if (this.pendingUi?.kind === "dialog") {
			const pu = this.pendingUi;
			overlay = this.buildDialogOverlay(pu, leftW, divRow);
		} else if (s.overlayOpen) {
			overlay = this.buildOverlay(leftW, divRow);
		} else if (s.diagOpen) {
			overlay = this.buildDiagOverlay(leftW, divRow);
		}

		const bytes = this.full.render(screen, rows, cols, overlay);
		// 引导期藏光标（弹窗锁焦点——输入框光标不该在背景里闪）；Key 输入是静默盲输，无光标可指示
		// 硬件光标可见条件（2026-09-27 用户走查补）：引导期与浮层挂起期（view/pick/dialog——
		// 浮层是字符层盖不住物理光标，子代理查看窗里浮着光标即此）隐藏；ask 输入行接管与
		// 斜杠菜单（输入框仍可打字过滤）保持显示
		const overlayUi = this.pendingUi !== undefined && this.pendingUi.kind !== "ask";
		this.full.placeCursor(divRow + 1 + (cursorPos.row - s.inputScroll), 3 + cursorPos.col, this.onboarding === undefined && !overlayUi && inputFocused);
		return bytes;
	}

	/** 只读文本浮层（F5 二轮⑪ / m5 T2 新几何）：resolvePopupLayout 居中弹窗（缺省 center80；五旧窗随之
	 *  统一新长相）。恒定行数防闪烁（斜杠菜单同款纪律）：顶框 + 内容页（高 − 3）+ 余量提示行 + 底框，
	 *  余量并进提示行不再条件性增删行；自定义键的 label 附在提示行尾。 */
	private buildViewOverlay(pu: { title: string; lines: string[]; scroll: number; pinned?: boolean; layout?: PopupLayout | "dock"; keys?: Record<string, PopupKey>; viewPage?: number }, leftW?: number, divRow?: number): OverlayFrame {
		// dock（m4-7 走查修 2026-09-27 用户拍板）：贴输入框上缘 + 与输入框（左栏）同宽——技能详情窗形态，
		// 内容自适应封顶可滚（高度 = min(内容行数, 输入框上方可用高)）；不走 resolvePopupLayout 居中几何
		const dock = pu.layout === "dock" && leftW !== undefined && divRow !== undefined;
		const geo = dock
			? { row: 0, col: 0, width: leftW, height: Math.max(6, Math.min(pu.lines.length + 3, divRow)) }
			: this.viewGeo(pu.layout === "dock" ? undefined : pu.layout);
		const ow = geo.width;
		const oInner = ow - 2;
		const bc = "accent";
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
		const olines: string[] = [];
		// CTU-09（2026-09-28 code review）：标题源头截断（模块供给可超长——原靠 padToWidth 兜底切掉右框角；
		// 预算 = ow − ╭─(2) − 首尾空格(2) ─╮(2) − 最小 fill(1)）
		const titleSeg = theme.fg("accent", ` ${truncateToWidth(pu.title, Math.max(4, ow - 7))} `);
		const topFill = Math.max(1, ow - 4 - visibleWidth(titleSeg));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + titleSeg + theme.fg(bc, "─".repeat(topFill)) + theme.fg(bc, "─╮")));
		const page = Math.max(3, geo.height - 3);
		pu.viewPage = page; // 渲染期回写——翻页/滚轮页大小与窗几何同源（dock 不走 viewGeo，m4-7 走查修）
		const maxScroll = Math.max(0, pu.lines.length - page);
		const sc = pu.pinned === true ? maxScroll : Math.max(0, Math.min(maxScroll, pu.scroll)); // pinned = 每帧钳到末页（T1 贴底跟随）
		const win = pu.lines.slice(sc, sc + page);
		// 恒满屏（2026-10-01 走查①拍板「不论内容填不填满都得满屏」）：full 布局内容行补空行到 page——
		// 盒高恒 geo.height，短内容不再抱内容贴终端顶（子代理详情窗短内容半屏盒即此症；斜杠菜单 17 行
		// 定高同族纪律）。dock（技能详情窗，内容自适应封顶）与 center80（既有弹窗视觉契约）不动。
		if (pu.layout === "full") while (win.length < page) win.push("");
		// 选区反白合入（T8）：行索引与 pointToView 同源（sc + 行号——滚动平移天然稳定）；
		// 滚动条（T10）：右缘 1 列轨道/拇指覆盖在内容最右列上
		const vthumb = thumbGeometry(page, pu.lines.length, sc);
		for (let i = 0; i < win.length; i++) {
			// 前导空格算进截断预算（oInner−3）：满宽文字 + 前导空格恰占满内容区——与主窗
			// 212e891「截断与 pad 同目标」恒宽口径一致（原截 oInner−2 靠 padToWidth 转截断兜底）
			const raw = " " + truncateToWidth(win[i]!, oInner - 3);
			const styled = this.styleDocSelection("view", sc + i, raw);
			if (vthumb !== undefined) {
				const onThumb = i >= vthumb.top && i < vthumb.top + vthumb.height;
				// 轨道格 = 深底空格、拇指 = █（2026-09-27 用户走查二轮：dim │ 细竖线字形上下有留缝、
				// 渲染成虚线，与右侧 1 列的 accent 边框虚线交叠成锯齿——「画歪了」实锤。bg 块与 █
				// 同为满格实心字形，虚线观感消除；主窗轨道是末列无邻线故无此症，不改）
				const bar = onThumb
					? theme.paint(this.state.scrollbarHover === "view" ? "accent" : "muted", "surface2", "█")
					: theme.bg("surface", " ");
				// 文字与轨道间空 1 列；各段显式带底色（theme.bg 收尾 49m 清外层底色——整行单包会漏）
				olines.push(
					theme.bg("surface2", theme.fg(bc, "│") + padToWidth(styled, oInner - 2)) +
					theme.bg("surface2", " ") + bar + theme.bg("surface2", theme.fg(bc, "│")),
				);
			} else {
				olines.push(boxRow(styled));
			}
		}
		const upN = sc;
		const downN = pu.lines.length - sc - win.length;
		const more = [upN > 0 ? `↑ 还有 ${upN}` : "", downN > 0 ? `↓ 还有 ${downN}` : ""].filter(Boolean).join(" · ");
		const keyHints = pu.keys === undefined ? "" : Object.values(pu.keys).map((k) => k.label).join(" · ");
		const hint = ` ${more}${more !== "" ? " · " : ""}↑↓ / PgUp/PgDn 翻页${keyHints !== "" ? ` · ${keyHints}` : ""} · Esc 关闭`;
		olines.push(boxRow(theme.dim(hint)));
		olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(oInner) + "╯")));
		return { lines: olines, row: dock && divRow !== undefined ? Math.max(0, divRow - olines.length) : geo.row, col: dock ? 0 : geo.col, width: ow };
	}

	/** 控件窗体（m5 T7①）：几何走 T1 resolvePopupLayout（不另算）；内容行走只读渲染器
	 *  （交互列表带选中标记与焦点高亮）；恒定行数防闪烁（余量并进提示行——view 窗同款纪律）。 */
	private buildDialogOverlay(pu: { title: string; widgets: WidgetSpec[]; scroll: number; layout?: PopupLayout | "dock"; focusedId?: string | undefined; selById: Record<string, number>; inputById: Record<string, { text: string; cursor: number }>; hostKeys?: HostDialogKeys }, leftW?: number, divRow?: number): OverlayFrame {
		// dock（T17 原型走查拍板：窗体与输入框同宽、贴输入框上缘）——几何同 buildViewOverlay dock 分支；
		// 高度按内容自适应封顶（控件行数预渲染一次取长）
		const dock = pu.layout === "dock" && leftW !== undefined && divRow !== undefined;
		let contentLen = 3;
		if (dock) {
			try {
				contentLen = renderWidgetLines(pu.widgets, Math.max(20, leftW - 2), { selById: pu.selById, inputById: pu.inputById, ...(pu.focusedId !== undefined ? { focusedId: pu.focusedId } : {}) }).lines.length;
			} catch { /* 预渲染失败走保底高度——正式渲染的 try/catch 会给占位行 */ }
		}
		const geo = dock
			? { row: 0, col: 0, width: leftW, height: Math.max(6, Math.min(contentLen + 3, divRow)) }
			: this.viewGeo(pu.layout);
		const ow = geo.width;
		const inner = ow - 2;
		const bc = "accent";
		// 先截断再补齐（2026-09-30 实机走查：控件行超宽时 padToWidth 只补不切——右边框被顶出去，
		// 终端软换行把底线推歪 = 「左右竖线不直」的根因；截断口径与其余四窗「源头截断」同族）
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(truncateToWidth(l, inner), inner) + theme.fg(bc, "│"));
		const olines: string[] = [];
		// CTU-09（2026-09-28 code review）：标题源头截断（spec.title 模块供给可超长——原靠 padToWidth 兜底
		// 切掉右框角；预算 = ow − ╭─(2) − 首尾空格(2) ─╮(2) − 最小 fill(1)）
		const titleSeg = theme.fg("accent", ` ${truncateToWidth(pu.title, Math.max(4, ow - 7))} `);
		const topFill = Math.max(1, ow - 4 - visibleWidth(titleSeg));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + titleSeg + theme.fg(bc, "─".repeat(topFill)) + theme.fg(bc, "─╮")));
		const page = Math.max(3, geo.height - 3);
		let content: string[];
		try {
			content = renderWidgetLines(pu.widgets, inner, { selById: pu.selById, inputById: pu.inputById, ...(pu.focusedId !== undefined ? { focusedId: pu.focusedId } : {}) }).lines;
		} catch (err) {
			this.io.logWarn?.("tui.dialog.render-error", `控件窗渲染抛错：${pu.title}`, { error: String(err instanceof Error ? err.message : err) });
			content = [` ${theme.fg("warn", "（控件渲染出错——见诊断日志）")}`];
		}
		const maxScroll = Math.max(0, content.length - page);
		const sc = Math.max(0, Math.min(maxScroll, pu.scroll));
		const win = content.slice(sc, sc + page);
		for (const l of win) olines.push(boxRow(l));
		const upN = sc;
		const downN = content.length - sc - win.length;
		const more = [upN > 0 ? `↑ 还有 ${upN}` : "", downN > 0 ? `↓ 还有 ${downN}` : ""].filter(Boolean).join(" · ");
		// 键位行（2026-09-30 实机走查重排）：宿主自定义键的标签过滤空串（同键多绑只标一次——空标签混进
		// join 出「· ·」断片）；有自定义键 = 窗自带完整键表（Enter/Esc 内建兜底），不再拼通用「↑↓ 选择 ·
		// Tab 换焦点」表单窗用不上的段；无自定义键维持原通用句
		const hostLabels = pu.hostKeys === undefined ? "" : [...new Set(Object.values(pu.hostKeys).map((k) => k.label).filter((l) => l !== ""))].join(" · ");
		const hint = pu.hostKeys === undefined
			? ` ${more}${more !== "" ? " · " : ""}↑↓ 选择 · Tab 换焦点 · Enter 激活 · Esc 关闭`
			: ` ${more}${more !== "" ? " · " : ""}${hostLabels}${hostLabels !== "" ? " · " : ""}Enter 激活 · Esc 关闭`;
		olines.push(boxRow(theme.dim(hint)));
		olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(inner) + "╯")));
		return { lines: olines, row: dock && divRow !== undefined ? Math.max(0, divRow - olines.length) : geo.row, col: dock ? 0 : geo.col, width: ow };
	}

	/** 模块 choose 的 overlay 选择框（全屏 CommandUi 适配面——与斜杠菜单同族：全宽/青玉框/分页/「还有 N 项」）。 */
	private buildPickOverlay(leftW: number, divRow: number, title: string, items: string[], sel: number, filter?: string, extraKeys?: PickExtraKeys): OverlayFrame {
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
		// CTU-09（2026-09-28 code review）：标题源头截断（choose 标题模块供给可超长——原靠 padToWidth 兜底
		// 切掉右框角；预算扣除过滤段实测宽）
		const titleSeg = theme.fg("accent", ` ${truncateToWidth(title, Math.max(4, ow - 7 - visibleWidth(theme.dim(filterSeg))))} `);
		const topFill = Math.max(1, ow - 4 - visibleWidth(titleSeg) - visibleWidth(theme.dim(filterSeg)));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + titleSeg + theme.fg(bc, "─".repeat(topFill)) + theme.dim(filterSeg) + theme.fg(bc, "─╮")));
		olines.push(boxRow(""));
		const selI = Math.max(0, Math.min(shown.length - 1, sel));
		const winStart = Math.max(0, Math.min(Math.max(0, shown.length - OVERLAY_PAGE), selI - OVERLAY_PAGE + 1));
		const win = shown.slice(winStart, winStart + OVERLAY_PAGE);
		if (winStart > 0) olines.push(boxRow(theme.dim(`   ↑ 还有 ${winStart} 项`)));
		for (let i = 0; i < win.length; i++) {
			const gi = winStart + i;
			// 两段式渲染（2026-09-28 用户拍板：子界面与斜杠主菜单同形——标题白/说明灰；「 ✓」当前值项
			// 标题青玉 + 说明仍灰。说明拆分三形态见 pickLabel；已带 ANSI 的行（技能/任务列表）原样）
			const label = pickLabel(win[i]!);
			const row = ` ${gi === selI ? theme.fg("accent", "❯") : " "} ${label}`;
			olines.push(gi === selI ? boxRow(theme.bg("accentSoft", padToWidth(row, oInner - 1))) : boxRow(row));
		}
		const rest = shown.length - winStart - win.length;
		if (rest > 0) olines.push(boxRow(theme.dim(`   ↓ 还有 ${rest} 项`)));
		const extraLabels = extraKeys === undefined ? "" : Object.values(extraKeys).map((k) => k.label).join(" · ");
		olines.push(boxRow(theme.dim((filter === undefined ? " ↑↓ 选择 · Enter 选定" : " 输入文字过滤 · ↑↓ 选择 · Enter 选定") + (extraLabels !== "" ? ` · ${extraLabels}` : "") + " · Esc 取消")));
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
		const en = theme.dim(` ${entries.length} 个模块出过问题 `);
		// CTU-09（2026-09-28 code review）：标题源头截断（本窗标题为内建定长——窄终端下 en 段挤爆顶框时的
		// 防线，与其余四窗拼行点同式；预算扣除 en 段实测宽）
		const title = theme.fg("err", truncateToWidth(" 模块诊断 ", Math.max(4, ow - 7 - visibleWidth(en))));
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
		const ap = this.argPhase();
		const ow = leftW;
		const oInner = ow - 2;
		const bc = "accent";
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
		const olines: string[] = [];
		const skillCount = ap === undefined && !level2 ? this.filteredSkills().length : 0;
		const en = theme.dim(ap !== undefined ? ` ${ap.items.length} 个候选 ` : level2 ? " 选择一项 " : ` ${this.filteredCommands().length} 个命令${skillCount > 0 ? ` · ${skillCount} 个技能 ` : ` `}`);
		// CTU-09（2026-09-28 code review）：标题源头截断（overlayCmd/ap.cmd 是用户输入可超长——原靠
		// padToWidth 兜底切掉右框角；预算扣除 en 段实测宽）
		const titleText = ap !== undefined ? ` ${ap.cmd} 参数 ` : level2 ? ` ${s.overlayCmd} ` : " 斜杠命令 ";
		const title = theme.fg("accent", truncateToWidth(titleText, Math.max(4, ow - 7 - visibleWidth(en))));
		const topFill = Math.max(1, ow - 4 - visibleWidth(title) - visibleWidth(en));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + title + theme.fg(bc, "─".repeat(topFill)) + en + theme.fg(bc, "─╮")));
		// 标题下不留装饰空行（2026-09-23 用户打回：上方空白一块）——↑ 占位行紧贴标题，滚动时原地变「↑ 还有 N 项」
		let items: { text: string; mark: string; long: string; kind: "cmd" | "skill" | "sep"; usage?: string }[];
		if (ap !== undefined) {
			// 参数阶段（m5 T15）：候选行与命令菜单同框（恒定行数防闪烁纪律不变）
			items = ap.items.length === 0
				? [{ text: theme.dim("无匹配候选"), mark: " ", long: "继续输入或删字修改；Esc 关菜单继续编辑。", kind: "cmd" as const }]
				: ap.items.map((c) => ({ text: c, mark: " ", long: `参数候选：${c}——Tab 补全当前词，Enter 直接提交。`, kind: "cmd" as const }));
		} else if (level2) {
			const cmdDef = this.io.slashCommands().find((c) => c.name === s.overlayCmd);
			const current = this.io.slashCurrent(s.overlayCmd);
			items = (cmdDef?.children ?? []).map((c) => {
				const meta = cmdDef?.childMeta?.[c]; // F5 十轮⑤：档名 + 短解（详释区用 long）；内部档值括注已删（2026-09-28 用户走查打回——中文档名自足）
				return {
					text: meta === undefined ? c : `${theme.fg("fg", meta.label)} ${theme.dim(`——${meta.desc}`)}`,
					mark: c === current ? theme.fg("accent", "✓") : " ",
					long: meta?.long ?? `${s.overlayCmd} 二级项：${c}——回车选定。`,
					kind: "cmd" as const,
				};
			});
		} else {
			const real = this.filteredCommands();
			const sk = this.filteredSkills();
			// m4-7 T7（原型图 1）：技能条目殿后于全部命中命令；分隔行「── 技能 ──」仅技能区非空时出现——
			// 无技能环境此处与原实现逐字节一致（验收点 3）；muted（2026-09-27 用户走查打回：border 边框色
			// #25352d 深底上几乎不可见——换灰绿与描述文字同色独占一行可读；不用 accent 避免与选中行抢权重）
			const sepRow = { text: theme.fg("muted", `── 技能 ${"─".repeat(Math.max(1, oInner - 12))}`), mark: " ", long: "", kind: "sep" as const };
			const skillRow = (c: SlashItem) => {
				// 主标签固定格式「skill : 名」（类别前缀，冒号两侧空格照写——与命令 /xxx 视觉区分）+
				// 行内短说明 = description（超宽截断不折行，原型要点）
				const label = `skill : ${c.skill ?? c.name}`;
				const budget = oInner - 4 - visibleWidth(label) - 1;
				const desc = budget >= 8 ? ` ${theme.dim(truncateToWidth(c.desc, budget))}` : "";
				return { text: truncateToWidth(`${label}${desc}`, oInner - 4), mark: " ", long: c.long, kind: "skill" as const, ...(c.usage !== undefined ? { usage: c.usage } : {}) };
			};
			items =
				real.length === 0 && sk.length === 0
					? [{ text: theme.dim("无匹配命令"), mark: " ", long: "没有匹配的命令。继续输入或删字修改筛选，Esc 关闭菜单。", kind: "cmd" as const }]
					: [
							...real.map((c) => ({
								text: `${c.name}${c.aliases === undefined ? "" : theme.fg("muted", `（${c.aliases.join(", ")}）`)} ${theme.dim(c.desc)}`,
								mark: " ",
								long: c.long,
								kind: "cmd" as const,
							})),
							...(sk.length > 0 ? [sepRow] : []),
							...sk.map(skillRow),
						];
		}
		const selI = Math.max(0, Math.min(items.length - 1, s.overlaySel));
		const winStart = Math.max(0, Math.min(Math.max(0, items.length - OVERLAY_PAGE), selI - OVERLAY_PAGE + 1));
		const win = items.slice(winStart, winStart + OVERLAY_PAGE);
		// 列表区恒定（2023-09-23 用户拍板：固定防闪烁）——命令恒 OVERLAY_PAGE 行（二级列表不足时补空行——空槽位留空）
		for (let i = 0; i < OVERLAY_PAGE; i++) {
			const it = win[i];
			if (it === undefined) {
				olines.push(boxRow(""));
				continue;
			}
			const gi = winStart + i;
			if (it.kind === "sep") {
				// 分隔行不可选不高亮（占 1 行参与窗口分页——滚出视野即不见）
				olines.push(boxRow(` ${it.text}`));
				continue;
			}
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
		const foot = theme.dim(ap !== undefined ? " ↑↓ 选择 · Tab 补全词 · Enter 提交 · Esc 关菜单" : level2 ? " ↑↓ 选择 · Enter 选定 · Esc 返回" : " ↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭");
		olines.push(theme.bg("surface2", theme.fg(bc, "├" + "─".repeat(oInner) + "┤")));
		for (const l of longLines) olines.push(boxRow(l));
		// 详释第 3 行（m4-7 T7 / 原型图 1 验收点 2）：技能选中 = when_to_use 简单说明（无则整行留空不删行——
		// 高度恒定纪律）；命令/参数/二级维持操作提示行（技能的 Enter/Esc 键位与命令同，操作行省去不损可发现性）
		const selItem = items[selI];
		const third = selItem !== undefined && selItem.kind === "skill"
			? (selItem.usage !== undefined && selItem.usage !== ""
				? ` ${theme.dim(`适用：${truncateToWidth(selItem.usage, longW - 4)}`)}`
				: "")
			: foot;
		olines.push(boxRow(third));
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
				// CRASH_RESTORE（m5 鼠标批 T3）：恢复串提为 fullscreen.ts 导出常量与 MOUSE_OFF 同源——
				// 开了鼠标上报后这里漏关段就是「崩溃后滚轮失灵到 reset」事故；?1049l 段按 isActive 追加
				writeSync(1, CRASH_RESTORE + (cur?.full.isActive === true ? "\x1b[?1049l" : ""));
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
