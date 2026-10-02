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
import { Term, type TermIO } from "./terminal.ts";
import { matchKey } from "./keymatch.ts";
import { FullScreen, CRASH_RESTORE, type OverlayFrame } from "./fullscreen.ts";
import { FrameScheduler } from "./scheduler.ts";
import { padToWidth, truncateToWidth, visibleWidth, wrapText } from "./width.ts";
import { parseWheel, parseButton, isMouseSequence } from "./mouse.ts";
import { OnboardingSession, type OnboardingDeps, type OnboardingOutcome } from "./onboarding.ts";
import type { DialogHandle, DialogSpec, PopupKey, PopupLayout, WidgetSpec } from "@orosus/contracts/module";
import * as theme from "../theme.ts";
import { subagentCountHint } from "../subagent-status.ts";
import {
	INPUT_MAX_ROWS, layoutInputRows, locateCursor,
	PERM_LABEL, SIDEBAR_SWITCH_COOLDOWN_MS, SPIN_FRAMES, thumbGeometry,
	type AppState, type FullAppIO, type HostDialogKeys, type InputRow,
	type PickExtraKeys,
} from "./fullapp-types.ts";
import { createPanels } from "./fullapp-panels.ts";
import { createDialogs } from "./fullapp-dialogs.ts";
import { createSelect } from "./fullapp-select.ts";
import { createMouse } from "./fullapp-mouse.ts";
import { createMenu } from "./fullapp-menu.ts";
import { createInput } from "./fullapp-input.ts";
import { createKeys } from "./fullapp-keys.ts";
import { createOverlay } from "./fullapp-overlay.ts";

// 子系统拆分（m5-split-fullapp）：九个闭包工厂子系统住 fullapp-*.ts 族件；壳内子系统装配对象与
// 降级共享字段（io/state/pendingUi 等无修饰成员）——子系统共享态，非公开 API，外部勿用。

// 类外段（接缝类型/AppState/常量/纯函数）已出仓 fullapp-types.ts（m5-split-fullapp T2）；
// 消费方九文件仍经本件 import——转出口维持不动（D3 消费方零改动）。
export * from "./fullapp-types.ts";

export class FullApp {
	io: FullAppIO;
	term: Term;
	private full: FullScreen;
	scheduler: FrameScheduler;
	state: AppState;
	private busyTimer: NodeJS.Timeout | undefined;
	private watchdogTimer: NodeJS.Timeout | undefined;
	private tickTimer: NodeJS.Timeout | undefined;
	toastTimer: NodeJS.Timeout | undefined; // CTU-03：toast 自消定时器统一登记（顶替即清）
	toastSeq = 0; // CTU-03：toast 身份令牌序列（定时器闭包捕获 id，与时长解耦）
	stopped = false;
	/** 面板行拼装子系统（m5-split-fullapp T3——fullapp-panels.ts 工厂件）。 */
	panels: ReturnType<typeof createPanels>;
	/** 弹窗队列/查看窗/对话框/引导/toast 子系统（m5-split-fullapp T4——fullapp-dialogs.ts 工厂件）。 */
	dialogs: ReturnType<typeof createDialogs>;
	/** 鼠标选区与剪贴板/链接子系统（m5-split-fullapp T5——fullapp-select.ts 工厂件）。 */
	select: ReturnType<typeof createSelect>;
	/** 滚轮/鼠标键/自动滚/滚动条子系统（m5-split-fullapp T6——fullapp-mouse.ts 工厂件）。 */
	mouse: ReturnType<typeof createMouse>;
	/** 斜杠菜单 overlay 键子系统（m5-split-fullapp T7——fullapp-menu.ts 工厂件）。 */
	menu: ReturnType<typeof createMenu>;
	/** 输入框编辑/历史/提交子系统（m5-split-fullapp T8——fullapp-input.ts 工厂件）。 */
	input: ReturnType<typeof createInput>;
	/** 键盘路由子系统（m5-split-fullapp T9——fullapp-keys.ts 工厂件；onKey 巨方法整体搬入）。 */
	keys: ReturnType<typeof createKeys>;
	/** 浮层构建子系统（m5-split-fullapp T10——fullapp-overlay.ts 工厂件）。 */
	overlay: ReturnType<typeof createOverlay>;

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
		// 子系统装配统一放构造器末尾（m5-split-fullapp 设计空白 1：state 等共享态先就位，工厂只在
		// 调用期解引用 app——装配点晚对行为无影响，统一末尾最稳）
		this.panels = createPanels(this);
		this.dialogs = createDialogs(this);
		this.select = createSelect(this);
		this.mouse = createMouse(this);
		this.menu = createMenu(this);
		this.input = createInput(this);
		this.keys = createKeys(this);
		this.overlay = createOverlay(this);
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
		const sidebarW = this.state.sidebarVisible ? this.panels.sidebarW() : 0;
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
				this.mouse.onWheel(wheel);
				return;
			}
			const button = parseButton(seq);
			if (button !== undefined) {
				this.mouse.onButton(button);
				return;
			}
			if (isMouseSequence(seq)) return;
			this.keys.onKey(matchKey(seq));
		});
		this.term.onPaste((text) => {
			// 引导期粘贴路由给会话（API Key 的首要输入方式就是粘贴——SW-23 静默盲输的进稿口）
			if (this.onboarding !== undefined) {
				this.onboarding.session.handlePaste(text);
				this.scheduler.requestImmediateRender();
				return;
			}
			this.input.inputInsert(text);
			this.input.afterEdit();
		});
		this.term.onResize(() => this.scheduler.requestRender());
		this.scheduler.requestRender();
		this.installCrashHooks();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.mouse.stopAutoScroll(); // 拖选自动滚定时器不随实例陪葬（T9）
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
	subagentsVisible(): boolean {
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

	pendingUi:
		| { kind: "pick"; title: string; items: string[]; sel: number; resolve: (n: number | undefined) => void; filter?: string; extraKeys?: PickExtraKeys }
		| { kind: "ask"; question: string; secret: boolean; prev: { input: string; cursor: number }; resolve: (v: string | undefined) => void }
		| { kind: "view"; title: string; text: string; lines: string[]; scroll: number; pinned?: boolean; layout?: PopupLayout | "dock"; keys?: Record<string, PopupKey>; owner?: string | undefined; live?: (() => string) | undefined; bottom?: boolean | undefined; viewPage?: number }
		| { kind: "dialog"; title: string; widgets: WidgetSpec[]; scroll: number; layout?: PopupLayout | "dock"; owner?: string | undefined; focusedId?: string | undefined; selById: Record<string, number>; inputById: Record<string, { text: string; cursor: number }>; onEvent?: DialogSpec["onEvent"]; hostKeys?: HostDialogKeys }
		| undefined;

	/** 挂起交互的 FIFO 暂存队列（批③② 审批互斥）：pendingUi 单槽占用期新到的 choose/ask 不再顶退——
	 *  顶退会把挂起的审批 resolve(undefined) = 静默否决；暂存后当前挂起结算即自动展开。
	 *  m5 T2（设计空白 8）：viewText 从「直接覆槽」并入本队列——连弹两窗后者等前者关（用户可见行为修正）。
	 *  m5 T7：队列项带 owner——closeModuleUi 时该模块的排队窗一并丢弃（不止在屏的）。 */
	uiQueue: Array<{ run: () => void; owner?: string }> = [];

	// ---------- 弹窗/查看窗/对话框/引导/toast 公开入口——体已出仓 fullapp-dialogs.ts（m5-split-fullapp T4），壳留薄委托 ----------

	viewText(title: string, text: string, opts?: { layout?: PopupLayout | "dock"; keys?: Record<string, PopupKey>; owner?: string; live?: () => string; bottom?: boolean }): void {
		this.dialogs.viewText(title, text, opts);
	}

	openDialogHost(spec: Omit<DialogSpec, "layout"> & { layout?: PopupLayout | "dock"; hostKeys?: HostDialogKeys }, owner?: string): DialogHandle | undefined {
		return this.dialogs.openDialogHost(spec, owner);
	}

	closeModuleUi(owner: string): void {
		this.dialogs.closeModuleUi(owner);
	}

	runOnboarding(deps: OnboardingDeps, initial?: { configured?: string[]; active?: string | null }): Promise<OnboardingOutcome> {
		return this.dialogs.runOnboarding(deps, initial);
	}

	showToast(text: string, durationMs?: number): void {
		this.dialogs.showToast(text, durationMs);
	}

	/** choose 的全屏形态：overlay 列表选择（Esc → undefined——宿主侧转「已取消（Esc）」，机制③同族）。
	 *  单槽占用期 FIFO 暂存（批③②——不再顶退挂起者）。 */
	pickOverlay(title: string, items: string[], selAt = 0, keys?: PickExtraKeys): Promise<number | undefined> {
		return this.dialogs.pickOverlay(title, items, selAt, keys);
	}

	/** ask/askSecret 的全屏形态：输入行接管（提示语进输入框前缀；secret 盲显 •；Esc → undefined）。
	 *  单槽占用期 FIFO 暂存（同 pickOverlay——批③②）。 */
	promptInput(question: string, secret: boolean): Promise<string | undefined> {
		return this.dialogs.promptInput(question, secret);
	}

	/** 输入框编辑/历史/提交公开入口三件——体已出仓 fullapp-input.ts（m5-split-fullapp T8），壳留薄委托。 */
	insertAtCursor(text: string): void {
		this.input.insertAtCursor(text);
	}

	restoreInput(text: string): void {
		this.input.restoreInput(text);
	}

	seedHistory(items: string[]): void {
		this.input.seedHistory(items);
	}

	// ---------- 控件窗（m5 T7 口子三①——数据流三路：开窗快照 / onEvent 回新清单 / update 句柄） ----------

	/** 开控件窗：几何走 T1（不另算）；排队同 viewText（单槽 FIFO）。
	 *  句柄闭包查属主与存活——窗已关/模块已卸载后调用 = 无操作不报错；
	 *  排队期（窗还没开）的 update/close 同款无操作。 */
	openDialog(spec: DialogSpec, owner?: string): DialogHandle | undefined {
		return this.openDialogHost(spec, owner);
	}

	// ---------- 首次使用引导弹窗（M4-3 T1d，D10——三页定高锁焦点；施工基准 onboarding 原型） ----------

	/** 引导弹窗占用槽：在槽期一切按键/粘贴路由给会话（焦点锁——pendingUi/编辑态全部让位）。 */
	onboarding: { session: OnboardingSession; resolve: (o: OnboardingOutcome) => void } | undefined;

	/** pick 列表行的可用显示宽（m4-7 走查修 2026-09-27）：左栏宽 − 框 2 列 − 「 ❯ 」前缀 4 列——
	 *  宿主拼行（如技能列表三列）按此截断，防超宽把右框 │ 推错位。侧栏随 cols 现算（与渲染同源）。 */
	pickRowWidth(): number {
		return Math.max(8, this.io.columns() - this.panels.sidebarW() - 1) - 2 - 4;
	}

	// ---------- 按键 ----------

	lastEscCancel = 0; // 双击 Esc 停止生成窗口（2026-09-23 走查拍板——防误触，qwen-code 1s 同口径）

	// ---------- 滚动条（T10——kimi :1037-1052 命中 / :1115-1118 跳位 / :1075-1078 拖动映射） ----------

	/** 选区族测试探针（fullapp.test.ts 经 as-cast 直取的两件——体已出仓 fullapp-select.ts，壳留委托）。 */
	pointToDoc(x: number, y: number): { docIdx: number; col: number } | undefined {
		return this.select.pointToDoc(x, y);
	}

	/** 同上——selectionText（拖选复制断言驱动口）。 */
	selectionText(): string | undefined {
		return this.select.selectionText();
	}

	// ---------- 布局与渲染 ----------

	/** 面板族测试探针（fullapp.test.ts 经 as-cast 直取的两件——体已出仓 fullapp-panels.ts，壳留委托）。 */
	sidebarW(): number {
		return this.panels.sidebarW();
	}

	/** 同上——statusRows（网络·MCP 卡与截断回归钉的驱动口）。 */
	statusRows(w: number, h: number): string[] {
		return this.panels.statusRows(w, h);
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
	layoutFrame(): {
		cols: number; rows: number; leftW: number; streamH: number; start: number;
		dmTotal: number; doc: string[]; inputRows: InputRow[]; cursorPos: { row: number; col: number };
		showRows: number; queue: string[]; queueH: number;
	} {
		const cols = this.io.columns();
		const rows = this.io.rows();
		const s = this.state;
		const sidebarW = s.sidebarVisible ? this.panels.sidebarW() : 0; // 隐藏 = 左栏占满（无面板）
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
		if (out.length < count && start + out.length === this.io.docTotal()) out.push(this.panels.tailLine());
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
		this.select.selectionGuard(); // T8：关窗首帧清 scope=view 残留选区
		const { cols, rows, leftW, streamH, start, dmTotal, doc, inputRows, cursorPos, showRows, queue, queueH } = this.layoutFrame();
		const s = this.state;

		// 面板行只在侧栏可见时计算（隐藏时 sidebarW=0 会让 panelBox 内宽为负——repeat 炸）
		const sidebarW = s.sidebarVisible ? this.panels.sidebarW() : 0;
		const statusH = Math.max(8, Math.floor(rows * 0.55));
		const taskH = rows - statusH;
		const status = s.sidebarVisible ? this.panels.statusRows(sidebarW, statusH) : [];
		const tasks = s.sidebarVisible ? this.panels.taskRows(sidebarW, taskH) : [];

		const inputFocused = s.focusIdx === 0;
		const ibc = inputFocused ? "accent" : "border";
		const screen: string[] = Array.from({ length: rows }, () => "");
		for (let r = 0; r < streamH; r++) {
			// 消息区左内衬 2 列（2026-09-23 用户拍板：文字起始贴屏幕左缘难看）——docmodel 折行口径
			// = streamW − 2，前导 2 空格后恰 = leftW 不截尾；空行也垫，块状整体右移保持对齐；
			// 选区行反白合入（m5 鼠标批 T5）。窗口化（T5）：doc[r] 即全局 start+r 行（窗口从 start 起）
			const raw = doc[r] === undefined ? "" : `  ${doc[r]!}`;
			screen[r] = padToWidth(this.select.styleDocSelection("main", start + r, raw), leftW);
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

		const sel = this.input.selRange();
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
			overlay = this.overlay.buildPickOverlay(leftW, divRow, pu.title, pu.items, pu.sel, pu.filter, pu.extraKeys);
		} else if (this.pendingUi?.kind === "view") {
			const pu = this.pendingUi;
			if (pu.live !== undefined) pu.lines = pu.live().split("\n"); // M4.5 T11：实时查看窗——每帧现算（滚动钳制在 build 内）
			overlay = this.overlay.buildViewOverlay(pu, leftW, divRow);
		} else if (this.pendingUi?.kind === "dialog") {
			const pu = this.pendingUi;
			overlay = this.overlay.buildDialogOverlay(pu, leftW, divRow);
		} else if (s.overlayOpen) {
			overlay = this.overlay.buildOverlay(leftW, divRow);
		} else if (s.diagOpen) {
			overlay = this.overlay.buildDiagOverlay(leftW, divRow);
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

	// ---------- 浮层族测试探针（fullapp.test.ts 经 as-cast 直取的四件——体已出仓 fullapp-overlay.ts，壳留委托） ----------

	buildViewOverlay(pu: { title: string; lines: string[]; scroll: number; pinned?: boolean; layout?: PopupLayout | "dock"; keys?: Record<string, PopupKey>; viewPage?: number }, leftW?: number, divRow?: number): OverlayFrame {
		return this.overlay.buildViewOverlay(pu, leftW, divRow);
	}

	buildDialogOverlay(pu: { title: string; widgets: WidgetSpec[]; scroll: number; layout?: PopupLayout | "dock"; focusedId?: string | undefined; selById: Record<string, number>; inputById: Record<string, { text: string; cursor: number }>; hostKeys?: HostDialogKeys }, leftW?: number, divRow?: number): OverlayFrame {
		return this.overlay.buildDialogOverlay(pu, leftW, divRow);
	}

	buildPickOverlay(leftW: number, divRow: number, title: string, items: string[], sel: number, filter?: string, extraKeys?: PickExtraKeys): OverlayFrame {
		return this.overlay.buildPickOverlay(leftW, divRow, title, items, sel, filter, extraKeys);
	}

	buildOverlay(leftW: number, divRow: number): OverlayFrame {
		return this.overlay.buildOverlay(leftW, divRow);
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
