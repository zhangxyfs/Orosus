/** fullapp.ts 类外段（m5-split-fullapp T2 出仓）：接缝类型 / AppState / 常量 / 纯函数。
 *  零 this、零状态——全件纯搬移自 fullapp.ts L28-456（commit c31c4ce 形态），消费方仍经
 *  fullapp.ts 转出口 import（`export * from`），九消费文件零改动。
 *  可见性放宽仅一处类：原模块私有件（FocusIdx/AppState/常量/纯函数等）因类体与子系统件
 *  跨文件取用而导出——非公开 API，外部勿用。 */

import { graphemeSpans, stripAnsi, truncateToWidth, visibleWidth } from "./width.ts";
import type { WidgetSpec } from "@orosus/contracts/module";
import type { DiagEntry } from "../module-diagnostics.ts";
import type { AtEntry } from "./fullapp-at.ts";
import * as theme from "../theme.ts";

// ---------- 接缝类型 ----------

export interface PanelData {
	model: string;
	session: string;
	cwd: string;
	tokens: { input: number; output: number; postCompaction?: boolean }; // 末条 usage 分拆（F5 二轮⑤：↑ 输入 · ↓ 输出）；postCompaction = 末条压缩晚于末条 usage，input 为压缩后投影估算（v3：压缩的数字回落不得滞后到下一条消息）
	startedAt: string | undefined; // 会话首事件 ts（F5 二轮④：运行时间行数据源）
	contextWindow: number;
	modules: { name: string; desc: string; state: "mounted" | "loading" | "off" | "pendingConfirm"; locked?: boolean; lockedReason?: string }[]; // locked = 不可热插拔；pendingConfirm = m5 T17 待确认第三方（回车弹确认窗）（2026-09-23 用户拍板：名后灰「· 锁定」，回车 toast 锁因）；其余回车实时插拔（宿主写 enabled + reload）
	tasks: { text: string; state: "done" | "active" | "pending" }[];
	permission: string; // 当前权限模式原文（ask-always/ask-risky/never）
	permissionNext(): string; // Shift+Tab 循环的下一档命令（如 "/permission ask-always")
	/** 模块卡（m5 T6 口子二）：宿主每次现调 getter 装配（不走快照——1 秒 tick 驱动现问现答）；
	 *  getter 抛错的卡宿主侧已剔除（设计空白 15）。可选——无卡宿主/占位路径不带。 */
	cards?: ModuleCard[] | undefined;
	/** 「网络 · MCP」卡数据面（2026-10-01 拍板）：被动真值——首连耗时/末次请求耗时，不做主动健康
	 *  探测（出网/DNS 周期 ping 维持方案书「另议」缺位）。proxy/modelService 为宿主拼好的显示串；
	 *  connections = mcp.catalog 服务行的投影（五态原文照传，渲染期映射点色）。可选——退化/测试路径
	 *  不带时卡体给占位行。 */
	network?: PanelNetwork | undefined;
}

/** 「网络 · MCP」卡连接行（消费侧本地声明——圈地纪律：类型结构不 import 模块包）。 */
export interface PanelNetwork {
	/** 代理态显示串（批 D proxy-env 语义）：「已启用 · host」/「直连 · 未检测到代理」。 */
	proxy: string;
	/** 模型服务信息行（不主张连接状态）：端点域名 + 末次请求耗时（assistant/message.durationMs 投影）。 */
	modelService: string;
	connections: {
		name: string;
		state: "connected" | "idle" | "failed" | "pending-confirm" | "disabled";
		/** 说明段（宿主拼好）：「HTTP · 12 工具」/「stdio · 8 工具」形。 */
		desc: string;
		/** 首连耗时毫秒（connected 行展示；缺省回落状态文案）。 */
		connectMs?: number;
	}[];
}

/** 模块卡的渲染面形态（PanelData.cards 元素）：contribute.card 注册物的投影。 */
export interface ModuleCard {
	area: "top" | "bottom";
	order: number;
	title: string;
	widgets: WidgetSpec[];
}

export interface SlashItem {
	name: string;
	desc: string;
	long: string;
	children?: string[]; // 有二级列表的命令（当前值 ✓ 标记——当前值由 io.slashCurrent 提供）
	aliases?: string[]; // 别名（F5 十六轮①：过滤/展示用——路由层早已直达，菜单按别名可筛出真实命令）
	childMeta?: Record<string, { label: string; desc: string; long: string }>; // 二级项元数据（F5 十轮⑤：档名/短解/详释）
	usage?: string; // m4-7 技能条目：详释第 3 行「适用：…」（when_to_use；无则整行留空不删行——高度恒定纪律）
	skill?: string; // m4-7 技能条目标记 = 技能真名（Enter 提交「/skill : 名」等价命令走宿主解析管线，2026-10-03 方案 2）
}

export interface FullAppIO {
	columns(): number;
	rows(): number;
	/** 流区行源（m5-render-perf T5 窗口化：旧 doc(): string[] 全量整拷退役）——
	 *  docTotal = 总行数（含将来并入的尾行由 fullapp 侧加 1），docWindow = 第 start 行起最多
	 *  count 行（短返回合法）。main.ts 侧接 DocModel.totalLines/frameWindow。 */
	docTotal(): number;
	docWindow(start: number, count: number): string[];
	/** 头部净平移累计（走查⑦，可选）：滑窗裁剪造成的行号整体平移——滚动补偿据此区分
	 *  「行号平移」（视口内容本就不动，不补）与「尾部增缩」（保视口 start，要补）。 */
	docHeadShift?(): number;
	submit(text: string): void;
	/** 提交闸门（批④——busy 期拒收档拦在回车前）：返回拒因 = 拦截（输入保留、不进历史、不写流区，
	 *  拒因尾行瞬显自消）；undefined = 放行。宿主侧复用 inflight + 拒收名单单一数据源。 */
	submitGate?(text: string): string | undefined;
	// CTU-11（2026-09-28 code review）：requestExit 死接口已三方删除（本声明 + main.ts 宿主实现 +
	// fullapp.test.ts 桩）——2026-09-23 拍板 Ctrl+C 不占用、退出走 /quit 后成遗迹，全仓 grep 零真实调用方。
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
	/** 子代理在跑门槛（M4.5 2026-09-27 改版——前台显示已移入流区 agent 组，此口只供双击 Esc 全停判定）。 */
	subagentActive?(): boolean;
	/** 输入行计数（M4.5 T13——决策 13）：后台运行中的任务数（只后台、为零整段消失——提示行右侧拼接）。 */
	subagentRunningCount?(): number;
	/** 双击 Esc 全停（M4.5 T14——决策 12）：焦点在输入框空闲态双击 = 停止全部子代理（未答审批自动回绝）；
	 *  忙时双击 = 停生成 + 全停（叠合语义定案——设计空白 T14 条）。 */
	stopAllSubagents?(): void;
	/** 视觉转述等待期（m5-media 走查四 2026-10-02）：transcribing = 有转述在等；abort = 双击 Esc 中止
	 *  （宿主侧不发送、输入连图回挂；转述调用本身不掐——结果照常落缓存，重发命中零等待）。非 busy
	 *  独立态：busy 分支管不到（turn 未开始），判定口径与 busy 双击同款（1s 窗口首按 toast 提示）。 */
	visionTranscribing?(): boolean;
	abortVisionTranscribe?(): void;
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
	/** Ctrl+H = 注入查看窗（m5-hooks T10 / D19）：本会话钩子注入条目列表 → 选中看全文；
	 *  主窗全局键，弹窗模态期不生效（popupFocused 铁律——见 fullapp-keys）。 */
	showInjections?(): void;
	/** 模块卡回车 = 热插拔（2026-09-23 用户拍板）：锁定项宿主 toast 锁因；可插拔项宿主写
	 *  config 的 [模块名] enabled + h.reload()（面板随之刷新）。 */
	toggleModule?(name: string, lockedReason: string | undefined): void;
	/** 模块诊断弹窗数据源（T9——定案「打开时刷新」：每次开 Ctrl + E 现读，不缓存）。 */
	diagEntries?(): DiagEntry[];
	/** 二级详情文本（T10）：name → 详情全文（renderDetail 拼装——宿主喂原始日志行）。 */
	diagDetail?(name: string): string;
	/** 宿主日志口（m5 T2）：弹窗保留键注册即拒等 UI 层事件的留痕（接线 main.ts → harness 日志）。 */
	logWarn?(code: string, msg: string, data?: Record<string, unknown>): void;
	/** 斜杠菜单参数阶段数据源（m5 T15）：cmd（含斜杠）→ 参数候选全量（宿主侧调模块 completeArg，
	 *  抛错兜底当空表 + 日志）；undefined = 该命令无参数补全（菜单照命令名阶段）。 */
	slashArgComplete?(cmd: string, word: string, args: string): string[] | undefined;
	/** 待确认模块回车 = 首挂确认弹窗（m5 T17）：宣言面人话清单 → 确认三动作作
	 *  （trustModule 登记 + 写盘 enabled + reload 一次）；取消零副作用。 */
	confirmModule?(name: string): void;
	/** 剪贴板纯文本写入（m5 鼠标批 T5——拖选松开即复制）：缺省 paste.ts writeClipboardText；
	 *  测试注入 stub。返回 false = 写入失败（调用方落 OSC 52 逃生口）。 */
	writeClipboard?(text: string): Promise<boolean>;
	/** 打开 URL（m5 鼠标批 T7——链接单击）：缺省 paste.ts openUrl（三平台命令、只开 http/https）；
	 *  测试注入 stub。返回 false = 拒开或失败。 */
	openUrl?(url: string): Promise<boolean>;
	/** 斜杠菜单技能区数据源（m4-7 T7）：宿主从 skill.catalog 服务惰性取并缓存（同步渲染口）；
	 *  缺省/空数组 = 无技能区（菜单与现状逐字节一致——验收点 3）。条目须带 skill 字段（真名）。
	 *  （条目 Enter 2026-10-03 起提交「/skill : 名」等价命令走宿主解析管线，不再走注入口——
	 *  skillInject 接口随旧实现退役。） */
	skillItems?(): SlashItem[];
	/** @ 文件菜单数据源（m5-at-menu T5）：dir（相对路径，根 = 空串）→ 条目全量 + miss 标志（宿主
	 *  readdirSync 失败置 true——目录不存在，渲染层给「目录不存在」空态文案；entries [] 且无 miss =
	 *  空目录）。导航点现读、不缓存（渲染期不碰文件系统）；undefined = 宿主未供（菜单不开——
	 *  行模式/测试缺省路径）。 */
	atMenuEntries?(dir: string): { entries: AtEntry[]; miss?: boolean } | undefined;
}

export type FocusIdx = 0 | 1 | 2;

export interface AppState {
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
	/** 右下卡组页号（m5 T6）：0 = 任务清单（内建在前），≥1 = bottom 模块卡（按 order 排）。
	 *  与 statePage（右上组同款语义：0 运行状态 / 1 网络·MCP / ≥2 top 模块卡）成对。 */
	taskPage: number;
	/** 「网络 · MCP」卡连接列表页号（2026-10-01）：纯页号（无选择语义——↑↓ 不动它），渲染期夹回。 */
	connPage: number;
	scrollBack: number;
	busy: boolean;
	/** /compact 执行期（2026-09-23 用户拍板 UI 形态）：busy spinner 切换为「上下文压缩中…」石青（info）色——
	 *  压缩是命令级动作，与 turn 生成的「正在生成…」区分。 */
	compacting: boolean;
	spinIdx: number;
	/** 钩子运行中状态行文案（m5-hooks T11/D20）：hooks/run running 账驱动——≥300ms 显形（数据源侧已
	 *  防闪屏）、多钩子带 N/M；工具钩子期并入本行（不另设行——工具行本就是运行态）。 */
	hookStatus?: string | undefined;
	sidebarVisible: boolean; // 右侧面板栏开关（Ctrl+T——用户拍板）
	overlayOpen: boolean;
	overlaySel: number;
	overlayCmd: string; // "" = 一级
	diagOpen: boolean; // 模块诊断一级列表（T9——独立于斜杠菜单 overlay：语义不同，另起一支）
	diagSel: number;
	diagReturn: boolean; // 二级详情的「逐级返回」标记（T10/S5——viewText 关闭时据此重开一级）
	/** @ 文件菜单（m5-at-menu，独立于斜杠菜单 overlay 另起一支——diagOpen 同理由）：undefined = 关。
	 *  dir = 当前目录相对路径（根 = 空串）；entries = 导航点现读的原始全量（渲染与过滤只查内存表
	 *  ——渲染期不碰文件系统）；miss = 目录不存在（数据源 readdirSync 失败——空态文案分「目录不
	 *  存在」与「（空目录）」两则的依据）；start/filter = 最近一次编辑动作落定时光标处词的快照
	 *  （渲染与滚轮读快照、不追光标现算——纯光标移动后菜单内容静止，下次编辑动作重判刷新或关，
	 *  kimi 同款）。 */
	atMenu: { dir: string; entries: AtEntry[]; sel: number; start: number; filter: string; miss?: boolean } | undefined;
	/** 浮动提示（2026-09-22 用户拍板）：输入框上边缘黄字、自消（duration = 自定义时长毫秒，m5 T3）。 */
	toast: { id: number; text: string; at: number; duration?: number } | undefined;
	/** 鼠标选区端点（m5 鼠标批 T5/T8）：存绝对行索引（设计空白 9——内容追加不漂移；压缩重建 doc
	 *  后选区可能错位，不跨压缩保真已登记不修）；undefined = 无选区。流区外/面板按下 = 折叠清空。
	 *  scope：main = 主窗 doc 行；view = 查看窗内容行（T8——行索引随 pu.scroll 平移天然稳定）；
	 *  窗关闭选区整组清空（渲染守卫——防行索引误映射下一窗内容）。 */
	mselAnchor: { scope: "main" | "view"; docIdx: number; col: number } | undefined;
	mselFocus: { scope: "main" | "view"; docIdx: number; col: number } | undefined;
	/** 选区粒度（T6）：双击 word / 三击 line / 拖动 character——drag 分支按粒度对齐扩选。 */
	selGranularity: "character" | "word" | "line";
	/** 双击/三击的初始区间（T6 智能扩选）：扩到反侧时锚点切到初始区间另一端。 */
	selInitialRange: { start: { docIdx: number; col: number }; end: { docIdx: number; col: number } } | undefined;
	/** 连击计数状态（T6——kimi :1233-1257）：count 必带（(prev%3)+1 的 prev 就存这里）。 */
	lastClick: { at: number; count: number; docIdx: number; wordStart: number; wordEnd: number } | undefined;
	/** 链接按下暂存（T7——kimi pressedUrl :224 同族）：count 1 的按下记 URL 与坐标，松开未拖动同点才打开。 */
	pressedUrl: { url: string; x: number; y: number } | undefined;
	/** 拖选自动滚三件（T9——kimi :216-218 同族）：方向必落 state（脉冲从 state 读）；50ms 一格、
	 *  每格 1 行；滚到头/回界内/松手自停。 */
	autoScrollDir: -1 | 0 | 1;
	autoScrollTimer: NodeJS.Timeout | undefined;
	dragPointer: { x: number; y: number } | undefined;
	/** 滚动条拖动态（T10）：grabOffset = 指针 Y 相对拇指顶的偏移（拖动跟手映射用）。 */
	scrollbarDrag: { scope: "main" | "view"; grabOffset: number } | undefined;
	/** 滚动条悬停（T10——?1003 全动跟踪的 hover 事件驱动）：换亮色渲染用。 */
	scrollbarHover: "main" | "view" | undefined;
}

export const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const INPUT_MAX_ROWS = 5;
export const OVERLAY_PAGE = 10;
export const DIAG_LIST_ROWS = 8; // 诊断一级列表恒定行数（原型 LIST_ROWS=8——不足留空防闪烁）
export const MODULE_SLOTS = 5; // 模块挂载区每页行数（渲染与 PgUp/PgDn 翻页共用一源——两处漂移即页号错位）
export const WHEEL_STEP = 1; // 滚轮每格滚动行数（m5 鼠标批设计空白 1——kimi 生产默认同款 tui-alt-screen.ts:264 ?? 1）
export const ALT_WHEEL_MULTIPLIER = 5; // Alt+滚轮加速倍数（设计空白 2——kimi :75 同名常量同值）
export const DOUBLE_CLICK_INTERVAL_MS = 500; // 双击判定窗口（m5 鼠标批 T6 设计空白 10——kimi :79 同值）
export const SIDEBAR_SWITCH_COOLDOWN_MS = 500; // 侧栏切换冷却（m5-render-perf T5 护栏②——D8 设计空白 #9：连击静默吞）

/** 滚动条几何（m5 鼠标批 T10——kimi layout.ts:285-292 getScrollbarGeometry 同式，设计空白 7/8）：
 *  不超一屏 undefined；拇指最小高 2；拇指顶 = round(首行/(总−视口) × (视口−拇指高))。
 *  拇指上限半轨（2026-09-27 用户走查：内容略超一屏时面积比例拇指≈满轨，看不出位置——近溢出区钳半轨；
 *  超两屏后 round(视口²/总) ≤ 视口/2，上限不再起作用，比例语义原样）。
 *  top/height 都是视口内行偏移（渲染与拖动映射共用一源）。 */
export function thumbGeometry(viewportH: number, total: number, first: number): { top: number; height: number } | undefined {
	if (total <= viewportH) return undefined; // 不超一屏不显示
	const h = Math.max(Math.min(2, viewportH), Math.min(Math.floor(viewportH / 2), Math.round((viewportH * viewportH) / total)));
	const maxOff = viewportH - h;
	return { top: Math.round((first / Math.max(1, total - viewportH)) * maxOff), height: h };
}
const WORD_JOINERS = new Set(["/", "-"]); // 词连接符（设计空白 11——kimi :82 同集：a/b/c.ts、well-known 当一个词）
const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });

type WordSeg = { seg: string; start: number; end: number; selectable: boolean; joiner: boolean };

/** 词区间（m5 鼠标批 T6——kimi getWordSelection :1169-1204 精简；显示列口径）：Intl.Segmenter 分段，
 *  段分 selectable（词like）与 joiner（/ -）；点中段向两侧贪心拼接（邻段双方可选内容且至少一方
 *  joiner 才并）。空白/标点段 → undefined（连击不计数）。 */
export function wordRangeAt(plain: string, col: number): { start: number; end: number } | undefined {
	const segs: WordSeg[] = [];
	for (const s of wordSegmenter.segment(plain)) {
		segs.push({ seg: s.segment, start: s.index, end: s.index + s.segment.length, selectable: s.isWordLike === true, joiner: WORD_JOINERS.has(s.segment) });
	}
	const colOf = (idx: number): number => visibleWidth(plain.slice(0, idx)); // 字符索引 → 显示列（CJK 2 列）
	const hitIdx = segs.findIndex((s) => col >= colOf(s.start) && col < colOf(s.end));
	if (hitIdx === -1) return undefined;
	const hit = segs[hitIdx]!;
	if (!hit.selectable && !hit.joiner) return undefined;
	const canJoin = (a: WordSeg, b: WordSeg): boolean =>
		(a.selectable || a.joiner) && (b.selectable || b.joiner) && (a.joiner || b.joiner); // kimi :1184-1187 同式
	let lo = hitIdx;
	let hi = hitIdx;
	while (lo - 1 >= 0 && canJoin(segs[lo - 1]!, segs[lo]!)) lo--;
	while (hi + 1 < segs.length && canJoin(segs[hi + 1]!, segs[hi]!)) hi++;
	return { start: colOf(segs[lo]!.start), end: colOf(segs[hi]!.end) };
}
export const MOD_STATE_TEXT: Record<string, string> = { mounted: "已挂载", loading: "挂载中", off: "未挂载", pendingConfirm: "待确认" }; // pendingConfirm = m5 T17 第四态（不进 failed 计数——待决不是失败）
/** 「网络 · MCP」卡连接行五态文案（mcp-cmd.ts STATE_TEXT 同款口径——管理面/卡片两处措辞一致）。 */
export const CONN_STATE_TEXT: Record<string, string> = { connected: "已连接", idle: "待启动", failed: "失败", "pending-confirm": "未确认", disabled: "已停用" };
/** 连接列表每页行数（2026-10-01）：页 2 比页 0 少 3 行 KV + 上下文进度条——同框高多容 3 行（8 = 5+3）。 */
export const CONN_SLOTS = 8;
// 任务勾选色（m5 T12：渲染期现算——主题可切后导入期烤色会是旧主题快照；全仓唯一烤色点改掉）
export const taskTick = (state: "done" | "active" | "pending"): string =>
	state === "done" ? theme.fg("accent", "✓") : state === "active" ? theme.fg("warn", "◐") : theme.fg("muted", "○");
/** 运行时间格式化（F5 十轮② 用户拍板：精确到秒，随 1s 心跳实时跳）：
 *  <60s「N 秒」；<1 时「M 分 SS 秒」；<1 天「H 时 MM 分 SS 秒」；否则「D 天 H 时」。 */
/** 毫秒耗时显示串（2026-10-01 拍板 B）：<1s「Nms」，≥1s「M.Ns」——首连耗时（连接行右列）与
 *  末次请求耗时（模型服务行）共用一源；宿主供数侧（main.ts 模型服务行拼串）同款 import。 */
export function msText(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

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
		const headW = visibleWidth(stripAnsi(head));
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


export const PERM_LABEL: Record<string, string> = { "ask-always": "每次都询问", "ask-risky": "需要时候询问", never: "从不询问" }; // 显示名（2026-09-26 拍板改中文——F5 十轮⑤ 英文档名由本次取代）

// ---------- 输入区多行布局（≤5 行，超出上滚——原型同款） ----------
// CTU-04（2026-09-28 修复）：宽度口径统一走 width.ts grapheme/EAW（graphemeSpans）。原私有 cpw
// 按首码点区间计宽，与 visibleWidth 在四类字符上分歧（前轮实测：❤️ 3/2、谚文 Jamo ᄀ 1/2、
// ZWJ 家族 👨‍👩‍👧 8/2、tab 1/3）——折行（layoutInputRows/indexAtRowCol 用 cpw）与光标列
// （locateCursor 用 visibleWidth）两口径错位：多算提前折行、少算行超框被 paneIn 截尾、硬件光标
// 列与编辑点视觉偏移。删 cpw，折行/定位/回映射三口一源（width.ts 是全仓唯一计宽权威）。

export interface InputRow {
	text: string;
	srcStart: number;
	srcEnd: number;
}

export function layoutInputRows(input: string, w: number): InputRow[] {
	const rows: InputRow[] = [];
	let base = 0;
	for (const logical of input.split("\n")) {
		const lineStart = base;
		base += logical.length + 1;
		if (logical.length === 0) {
			rows.push({ text: "", srcStart: lineStart, srcEnd: lineStart });
			continue;
		}
		let pos = 0; // 已装填码元游标
		let rowStart = 0; // 当前行起点（码元）
		let tw = 0; // 当前行累计显示宽（grapheme 口径）
		for (const sp of graphemeSpans(logical)) {
			if (tw > 0 && tw + sp.w > w) {
				rows.push({ text: logical.slice(rowStart, pos), srcStart: lineStart + rowStart, srcEnd: lineStart + pos });
				rowStart = pos;
				tw = 0;
			}
			tw += sp.w;
			pos += sp.text.length;
		}
		rows.push({ text: logical.slice(rowStart), srcStart: lineStart + rowStart, srcEnd: lineStart + logical.length });
	}
	return rows.length > 0 ? rows : [{ text: "", srcStart: 0, srcEnd: 0 }];
}

/** 行内码元偏移 → 显示列（graphemeSpans 同口径累计；偏移落在 grapheme 中段时列停在该段前）。 */
function spanColAt(text: string, offset: number): number {
	let col = 0;
	let used = 0;
	for (const sp of graphemeSpans(text)) {
		if (used + sp.text.length > offset) break;
		col += sp.w;
		used += sp.text.length;
	}
	return col;
}

export function locateCursor(rows: InputRow[], cursor: number): { row: number; col: number } {
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i]!;
		if (cursor >= r.srcStart && cursor < r.srcEnd) {
			return { row: i, col: spanColAt(r.text, cursor - r.srcStart) };
		}
		if (cursor === r.srcEnd && i === rows.length - 1) {
			return { row: i, col: spanColAt(r.text, r.text.length) };
		}
	}
	return { row: 0, col: 0 };
}

export function indexAtRowCol(rows: InputRow[], row: number, targetCol: number): number {
	const r = rows[Math.max(0, Math.min(rows.length - 1, row))]!;
	let w = 0;
	let i = r.srcStart;
	for (const sp of graphemeSpans(r.text)) {
		if (w + sp.w > targetCol) break;
		w += sp.w;
		i += sp.text.length;
	}
	return i;
}

/** 命令归一化（core harness.ts:503-505 同口径：前导空白抹除 + 斜杠后空格抹除 + 连续空白折叠）。 */
export function normCmd(text: string): string {
	return text.trim().replace(/^\/\s+/, "/").replace(/\s+/g, " ");
}

/** 中行斜杠词（2026-10-03「消息内容 空格 /」也开斜杠菜单）：串尾 / 词，词界 = 行首或空白
 *  （与 @ 菜单词界 (?:^|\s)@ 同源）——词内含空白即不再命中（打参数菜单就关，v1 不做中行参数阶段）。
 *  URL 的 //（http://x）斜杠前是字符非空白，不触发。start = 词起点（含 /）在原串的 index，
 *  键位路径用它切前缀——Enter 调用命令后消息前缀保留回输入框。不命中返回 undefined。 */
export function inlineSlashWord(text: string): { start: number; word: string } | undefined {
	const m = /(?:^|\s)(\/\S*)$/.exec(text);
	if (m === null) return undefined;
	return { start: m.index + m[0].length - m[1]!.length, word: m[1]! };
}

/** 斜杠菜单开合判定：行首命令词编辑期 + 中行串尾 / 词（2026-10-03）。有空格就关（2026-10-03 拍板，
 *  九仓主流同款——codex/ZCode/opencode/kimi/qwen/Reasonix/pi 全是空格后不再显命令列表）：空格 = 出了
 *  命令词进参数或行文，命令列表不得赖着不走（前案 /yolo aaa 菜单挂着 /yolo 即此病）。中行词内/词尾
 *  空白由正则天然不命中。例外（qwen/kimi/pi/Reasonix 同款）：声明了 completeArg 的命令空格后切参数
 *  候选——两道闸（menuReopenCheck/onOverlayKey）挂 argPhase 认这个例外。 */
export function slashMenuActive(input: string): boolean {
	const lead = input.trimStart();
	return (lead.startsWith("/") && !/\s/.test(lead)) || inlineSlashWord(input) !== undefined;
}

/** 斜杠菜单过滤词：行首形态取首词（旧口径不变），中行形态取串尾 / 词去 /（2026-10-03）。 */
export function slashFilterQ(input: string): string {
	const t = normCmd(input);
	if (t.startsWith("/")) return t.slice(1).split(" ")[0]!.toLowerCase();
	return inlineSlashWord(t)?.word.slice(1).toLowerCase() ?? "";
}

/** 子序列模糊命中（斜杠菜单第三档，2026-09-30 用户拍板：/skas 筛出 skill : ask——fzf/命令面板同款）：
 *  q 的字符按序散见于目标即可，不必连续。空词恒 false（已被前缀档全收，到不了这）。 */
export function isSubseq(q: string, target: string): boolean {
	if (q === "") return false;
	let i = 0;
	for (const ch of target) if (ch === q[i]) i++;
	return i === q.length;
}

/** 控件窗自定义键表（T17 m4-3c 宿主侧扩展）：契约 DialogSpec 不动——宿主调用点用超集
 *  openDialogHost(spec) 传键；表单类窗（MCP 添加窗）需要行内 ←→、Shift+←→ 切页签这类
 *  超出「Tab 循环 + ↑↓ 选择」内建面的键。 */
export type HostDialogKeys = Record<string, { label: string; run: (ctx: DialogKeyCtx) => boolean | void }>; // 返回 false = 不消费回落内建键

/** pick 列表自定义键（T17 m4-3c 宿主侧扩展）：列表页 Alt + N / Alt + K 的载体——run 拿
 *  关闭口（close = 以 undefined 结算——调用方用旗标区分「键关闭」与「Esc 返回」）。 */
export type PickExtraKeys = Record<string, { label: string; run: (ctrl: { close(): void }) => boolean | void }>;

/** 控件窗键上下文（T17）：闭包读写窗态的窄口。 */
export interface DialogKeyCtx {
	focusedId?: string | undefined;
	focusIds: readonly string[];
	setFocus(id: string): void;
	moveFocus(delta: number): void;
	selOf(id: string): number | undefined;
	setSel(id: string, index: number): void;
	inputOf(id: string): string;
	setInput(id: string, text: string): void;
	close(): void;
}
