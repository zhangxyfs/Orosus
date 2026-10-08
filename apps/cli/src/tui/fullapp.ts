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
import { parseWheel, parseButton, isMouseSequence } from "./mouse.ts";
import { OnboardingSession, type OnboardingDeps, type OnboardingOutcome } from "./onboarding.ts";
import type { DialogHandle, DialogSpec, PopupKey, PopupLayout, WidgetSpec } from "@orosus/contracts/module";
import {
	SIDEBAR_SWITCH_COOLDOWN_MS, SPIN_FRAMES,
	type AppState, type FullAppIO, type HostDialogKeys,
	type PickExtraKeys,
} from "./fullapp-types.ts";
import { createPanels } from "./fullapp-panels.ts";
import { createDialogs } from "./fullapp-dialogs.ts";
import { createSelect } from "./fullapp-select.ts";
import { createMouse } from "./fullapp-mouse.ts";
import { createMenu } from "./fullapp-menu.ts";
import { createAt } from "./fullapp-at.ts";
import { createInput } from "./fullapp-input.ts";
import { createKeys } from "./fullapp-keys.ts";
import { createOverlay } from "./fullapp-overlay.ts";
import { createFrame } from "./fullapp-frame.ts";

// 拆分说明（m5-split-fullapp，2026-10-02）：本件曾是 3257 行的全仓第一大源文件——FullApp 总控台
// （终端接管/按键分派/鼠标选区/输入框/侧栏面板/斜杠菜单/弹窗队列/帧渲染），十几个交互批次的
// 功能逐层堆积的结果，多批并行开发同改一文件必撞车。拆法：类外段（接缝类型/AppState/常量/
// 纯函数）出仓 fullapp-types.ts；类本体按九个闭包工厂子系统拆到 fullapp-*.ts 族件（panels 面板
// 行拼装 / dialogs 弹窗队列 / select 鼠标选区 / mouse 滚轮滚动 / menu 斜杠菜单 / input 输入框 /
// keys 键盘路由 / overlay 浮层构建 / frame 帧渲染）；本件收口为壳（字段声明 + 构造器装配 +
// 生命周期 + 公共入口薄委托）。
// 限制：①公共面 23 成员（20 公开 + 3 getter）签名与 stateRef 形状零改动——179 it 安全网与九个
// 消费文件全走公共 API 的前提；②搬出方法触达的字段从 private 降为无修饰 = 子系统共享态，
// 非公开 API，外部勿用；③onKey（fullapp-keys.ts）内部分派顺序/case 分组/早退路径红线不动；
// ④九工厂装配统一放构造器末尾（state 构造器体内才赋值，字段初始化器先跑有访问序隐患）。
// 零行为变三维背书（公共面/消费方/测试件零改动）；方案与收官对账见
// docs/superpowers/plans/2026-10-02-m5-split-fullapp.md。

// 类外段（接缝类型/AppState/常量/纯函数）已出仓 fullapp-types.ts（m5-split-fullapp T2）；
// 消费方九文件仍经本件 import——转出口维持不动（D3 消费方零改动）。
export * from "./fullapp-types.ts";

export class FullApp {
	io: FullAppIO;
	term: Term;
	full: FullScreen;
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
	/** @ 文件菜单键子系统（m5-at-menu T2——fullapp-at.ts 工厂件）。 */
	at: ReturnType<typeof createAt>;
	/** 输入框编辑/历史/提交子系统（m5-split-fullapp T8——fullapp-input.ts 工厂件）。 */
	input: ReturnType<typeof createInput>;
	/** 键盘路由子系统（m5-split-fullapp T9——fullapp-keys.ts 工厂件；onKey 巨方法整体搬入）。 */
	keys: ReturnType<typeof createKeys>;
	/** 浮层构建子系统（m5-split-fullapp T10——fullapp-overlay.ts 工厂件）。 */
	overlay: ReturnType<typeof createOverlay>;
	/** 帧渲染链子系统（m5-split-fullapp T11——fullapp-frame.ts 工厂件）。 */
	frame: ReturnType<typeof createFrame>;

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
			launcherOpen: false,
			launcherSel: 0,
			atMenu: undefined,
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
		this.at = createAt(this);
		this.input = createInput(this);
		this.keys = createKeys(this);
		this.overlay = createOverlay(this);
		this.frame = createFrame(this);
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
		const { streamH, start, dmTotal } = this.frame.layoutFrame();
		return { start, end: Math.min(dmTotal, start + streamH) };
	}

	/** T14（m5-resume-perf）：懒分页取段状态（防抖 150ms 合并到顶区连击滚动；inflight 防并发；
	 *  exhausted 到头停触——「已到会话开头」toast 后不再发取段）。 */
	private olderTimer: ReturnType<typeof setTimeout> | undefined;
	private olderInflight = false;
	private olderExhausted = false;

	/** 到顶触发懒分页（PgUp/滚轮上在视口 start===0 时调）：防抖后取一页插头。底部锚定滚动几何
	 *  天然钉住视口（头部插入 → 总行与内容同下移、scrollBack 不动 = 同一可视内容——ZCode/Codex 式
	 *  无限上翻的补偿免写）。 */
	requestOlderPage(): void {
		if (this.olderExhausted || this.olderInflight || this.io.fetchOlderPage === undefined) return;
		if (this.olderTimer !== undefined) return; // 防抖窗口内连击合并
		this.olderTimer = setTimeout(() => {
			this.olderTimer = undefined;
			if (this.olderExhausted || this.olderInflight) return;
			this.olderInflight = true;
			void (async () => {
				try {
					const more = await this.io.fetchOlderPage!();
					if (!more) {
						this.olderExhausted = true;
						this.showToast("已到会话开头");
					}
					this.scheduler.requestImmediateRender();
				} finally {
					this.olderInflight = false;
				}
			})();
		}, 150);
	}

	/** 就地换页配套（m5-resume-perf 走查修）：宿主换会话后调用——重置懒分页到头态与在飞防抖，
	 *  新会话可重新上翻（不重置则上一会话的 olderExhausted 会吃掉新会话的到顶触发）。 */
	sessionSwapped(): void {
		if (this.olderTimer !== undefined) {
			clearTimeout(this.olderTimer);
			this.olderTimer = undefined;
		}
		this.olderExhausted = false;
		this.olderInflight = false;
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

	/** 钩子运行中状态行（m5-hooks T11/D20）：running 账到达即设（数据源 ≥300ms 防闪屏）、完成清；
	 *  转帧计时器与 busy 共用（钩子可在非 busy 期跑——提交门/停止边界）。 */
	setHookStatus(label: string | undefined): void {
		const s = this.state;
		if (s.hookStatus === label) return;
		s.hookStatus = label;
		if (label !== undefined && this.busyTimer === undefined) {
			this.busyTimer = setInterval(() => {
				s.spinIdx = (s.spinIdx + 1) % SPIN_FRAMES.length;
				this.scheduler.requestRender();
			}, 100);
			this.busyTimer.unref?.();
		} else if (label === undefined && !s.busy && this.busyTimer) {
			clearInterval(this.busyTimer);
			this.busyTimer = undefined;
		}
		this.scheduler.requestRender();
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
		| { kind: "pick"; title: string; items: string[]; sel: number; resolve: (n: number | undefined) => void; filter?: string; extraKeys?: PickExtraKeys
			// m5-ask-multi 增强面：multi/custom 仅 chooseEx 路置位（老 choose 面恒 falsy——33 处消费方零感知）；
			// checked/customText/customCommitted/editing 恒初始化（单构建点 fullapp-dialogs pickOverlay），
			// 老面读不到也写不到。resolve 签名零改动（风险节铁律）：自定义文本不经 resolve 携带——
			// 「其他」行恒占 items.length、「确定」行恒占 items.length + 1 合成索引，包装层按 pu 现值组装 string[]。
			multi?: true; custom?: true; checked: number[]; customText: string; customCommitted?: string | undefined; editing: boolean }
		| { kind: "ask"; question: string; secret: boolean; prev: { input: string; cursor: number }; resolve: (v: string | undefined) => void }
		| { kind: "view"; title: string; text: string; lines: string[]; scroll: number; pinned?: boolean; layout?: PopupLayout | "dock"; keys?: Record<string, PopupKey>; owner?: string | undefined; live?: (() => string) | undefined; liveCache?: { at: number; text: string } | undefined; bottom?: boolean | undefined; viewPage?: number }
		| { kind: "dialog"; title: string; widgets: WidgetSpec[]; scroll: number; layout?: PopupLayout | "dock"; owner?: string | undefined; focusedId?: string | undefined; selById: Record<string, number>; inputById: Record<string, { text: string; cursor: number }>; onEvent?: DialogSpec["onEvent"]; hostKeys?: HostDialogKeys; disallowEscape?: boolean }
		| undefined;

	/** 挂起交互的 FIFO 暂存队列（批③② 审批互斥）：pendingUi 单槽占用期新到的 choose/ask 不再顶退——
	 *  顶退会把挂起的审批 resolve(undefined) = 静默否决；暂存后当前挂起结算即自动展开。
	 *  m5 T2（设计空白 8）：viewText 从「直接覆槽」并入本队列——连弹两窗后者等前者关（用户可见行为修正）。
	 *  m5 T7：队列项带 owner——closeModuleUi 时该模块的排队窗一并丢弃（不止在屏的）。 */
	uiQueue: Array<{ run: () => void; owner?: string }> = [];

	// ---------- 弹窗/查看窗/对话框/引导/toast 公开入口——体已出仓 fullapp-dialogs.ts（m5-split-fullapp T4），壳留薄委托 ----------

	viewText(title: string, text: string, opts?: { layout?: PopupLayout | "dock"; keys?: Record<string, PopupKey>; owner?: string; live?: () => string; bottom?: boolean; markdown?: boolean }): void {
		this.dialogs.viewText(title, text, opts);
	}

	openDialogHost(spec: Omit<DialogSpec, "layout"> & { layout?: PopupLayout | "dock"; hostKeys?: HostDialogKeys; disallowEscape?: boolean }, owner?: string): DialogHandle | undefined {
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
	 *  单槽占用期 FIFO 暂存（批③②——不再顶退挂起者）。
	 *  m5-ask-multi：第 5 参 opts 传入 = chooseEx 增强面（其他行恒在；multi 加确定行），返回形状变为
	 *  Promise<string[] | undefined>（undefined = Esc）——快照组装见 fullapp-dialogs pickOverlay；老调用
	 *  （无 opts）签名与语义一字不动。 */
	pickOverlay(title: string, items: string[], selAt?: number, keys?: PickExtraKeys): Promise<number | undefined>;
	pickOverlay(title: string, items: string[], selAt: number | undefined, keys: PickExtraKeys | undefined, opts: { multi?: boolean }): Promise<string[] | undefined>;
	pickOverlay(title: string, items: string[], selAt = 0, keys?: PickExtraKeys, opts?: { multi?: boolean }): Promise<number | undefined | string[] | undefined> {
		return this.dialogs.pickOverlay(title, items, selAt, keys, opts);
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
	lastWinEscCloseAt = 0; // 关窗余震门（2026-10-04）：Esc 关掉任一窗的时刻——其后 500ms 内落主窗 busy 分支的 Esc 视为关窗手势惯性（不计数不提示），关多层弹窗连按不再误停生成

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

	renderFrame(): number {
		return this.frame.renderFrame();
	}


	// ---------- 浮层族测试探针（fullapp.test.ts 经 as-cast 直取的四件——体已出仓 fullapp-overlay.ts，壳留委托） ----------

	buildViewOverlay(pu: { title: string; lines: string[]; scroll: number; pinned?: boolean; layout?: PopupLayout | "dock"; keys?: Record<string, PopupKey>; viewPage?: number }, leftW?: number, divRow?: number): OverlayFrame {
		return this.overlay.buildViewOverlay(pu, leftW, divRow);
	}

	buildDialogOverlay(pu: { title: string; widgets: WidgetSpec[]; scroll: number; layout?: PopupLayout | "dock"; focusedId?: string | undefined; selById: Record<string, number>; inputById: Record<string, { text: string; cursor: number }>; hostKeys?: HostDialogKeys; disallowEscape?: boolean }, leftW?: number, divRow?: number): OverlayFrame {
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
