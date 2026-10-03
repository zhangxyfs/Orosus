/** fullapp-frame.ts（m5-split-fullapp T11）：帧渲染链——纯搬移自 fullapp.ts 类体
 *  （选区着色/流区几何/行源窗口/帧渲染与帧内渲染）。lastTotal/lastHeadShift 两字段转工厂闭包
 *  let 态（帧间滚动补偿基准，仅本族消费）；renderFrame 壳留三行委托（FrameScheduler 调度闭包
 *  零改动——设计空白 7）；styleWithSelection 零 app 触达住模块级。非公开 API。 */

import { INPUT_MAX_ROWS, layoutInputRows, locateCursor, PERM_LABEL, thumbGeometry, type InputRow } from "./fullapp-types.ts";
import { padToWidth, truncateToWidth, visibleWidth, wrapText } from "./width.ts";
import { subagentCountHint } from "../subagent-status.ts";
import type { OverlayFrame } from "./fullscreen.ts";
import * as theme from "../theme.ts";
import type { FullApp } from "./fullapp.ts";

/** 渲染行按键盘选区反白（输入框选区——与 select.styleDocSelection 同手法；零 app 触达住模块级）。 */
const styleWithSelection = (vr: InputRow, sel: { lo: number; hi: number } | undefined): string => {
	if (!sel) return vr.text;
	const lo = Math.max(vr.srcStart, sel.lo);
	const hi = Math.min(vr.srcEnd, sel.hi);
	if (lo >= hi) return vr.text;
	const a = lo - vr.srcStart;
	const b = hi - vr.srcStart;
	return vr.text.slice(0, a) + theme.inverse(vr.text.slice(a, b)) + vr.text.slice(b);
}

export function createFrame(app: FullApp) {
	/** 上一帧总行数（滚动钉住的增量基准）。 */
	let lastTotal = -1;
	/** 上次头部平移累计（tailDelta 差分基准——走查⑦）。 */
	let lastHeadShift = 0;

	/** 流区几何与行源（m5 鼠标批 T5 提取——renderFrame 与鼠标映射 pointToDoc 共用一源，
	 *  两处漂移即选区错位；方案级纪律）。输入框/队列区行数一并带出（streamH 的计算依赖，
	 *  renderFrame 直接消费）。
	 *  m5-render-perf T5 窗口化：不再持有全量行数组——dmTotal = 宿主总行数 + 尾行 1，
	 *  doc = 视口窗口（streamH + 余量 streamH，设计空白 #6 视口×2），start 语义不变（全局首行
	 *  下标）；消费面全部走「dmTotal 当总长 / doc 局部下标 = 全局下标 − start」。 */
	const layoutFrame = (): {
		cols: number; rows: number; leftW: number; streamH: number; start: number;
		dmTotal: number; doc: string[]; inputRows: InputRow[]; cursorPos: { row: number; col: number };
		showRows: number; queue: string[]; queueH: number;
	} => {
		const cols = app.io.columns();
		const rows = app.io.rows();
		const s = app.state;
		const sidebarW = s.sidebarVisible ? app.panels.sidebarW() : 0; // 隐藏 = 左栏占满（无面板）
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
		const queue = app.io.queueItems();
		const queueH = queue.length === 0 ? 0 : queue.length + 1;
		const streamH = rows - inputH - queueH;
		const dmTotal = app.io.docTotal() + 1; // + 尾行（spinner/待命——恒 1 行，tailLine 并入窗口尾）
		const maxScroll = Math.max(0, dmTotal - streamH);
		// 滚动钉住（走查①修，走查⑦统一式）：scrollBack 是「距底行数」，内容增缩都会顶走视口——
		// 统一补偿 tailDelta = 总变化 − 头部平移（增长补正、收缩补负，恒保视口 start；学 kimi
		// agent-activity-viewer 的顶锚免疫：其 scrollTop 从顶数、内容更新只做 followTail 贴底/超界钳制）。
		// 头部平移（滑窗裁剪，经 docHeadShift 差分）不补——行号平移后视口内容本就不动（T7 几何论证）。
		// 跟随态（scrollBack = 0）不补照旧贴底。
		if (lastTotal >= 0 && s.scrollBack > 0) {
			const headNow = app.io.docHeadShift?.() ?? 0;
			const tailDelta = dmTotal - lastTotal + (headNow - lastHeadShift);
			lastHeadShift = headNow;
			if (tailDelta !== 0) s.scrollBack = Math.max(0, Math.min(maxScroll, s.scrollBack + tailDelta));
		} else if (app.io.docHeadShift !== undefined) {
			lastHeadShift = app.io.docHeadShift();
		}
		lastTotal = dmTotal;
		s.scrollBack = Math.min(s.scrollBack, maxScroll);
		const end = dmTotal - s.scrollBack;
		const start = Math.max(0, end - streamH);
		const doc = docRows(start, streamH * 2); // 视口 ×2 余量：滚动一帧内不重算边界（#6）
		return { cols, rows, leftW, streamH, start, dmTotal, doc, inputRows, cursorPos, showRows, queue, queueH };
	}


	/** 行源窗口：dm 行 + 尾行并入（旧 [...io.doc(), tailLine()] 的窗口化形态——尾行恒 1 行，
	 *  dm 短返回时补上）。 */
	const docRows = (start: number, count: number): string[] => {
		const out = app.io.docWindow(start, count);
		if (out.length < count && start + out.length === app.io.docTotal()) out.push(app.panels.tailLine());
		return out;
	}

	/** 帧级错误边界（CTU-12 2026-09-28 code review）：主渲染帧每帧现调宿主回调（io.doc/panelData——其
	 *  cards getter 自述已知会抛/queueItems），无防护时异常沿 scheduler 定时器/nextTick 逃逸为
	 *  uncaughtException 杀进程。与 fireDialogEvent/renderModuleCard 的全局约束 4 同款降级：失败帧
	 *  logWarn + 占位错误帧——渲染期异常从进程级降为帧级，宿主下一帧恢复即回。 */
	const renderFrame = (): number => {
		try {
			return renderFrameInner();
		} catch (err) {
			app.io.logWarn?.("tui.render.frame-error", "渲染帧抛错，占位帧兜底", { error: String(err instanceof Error ? err.message : err) });
			let rows = 24;
			let cols = 80;
			try {
				rows = Math.max(4, app.io.rows());
				cols = Math.max(8, app.io.columns());
			} catch {
				/* 宿主连尺寸口都抛——缺省几何尽力画 */
			}
			const screen: string[] = Array.from({ length: rows }, () => "");
			screen[0] = truncateToWidth(theme.fg("warn", " 渲染出错——下一帧自动恢复，详见诊断日志（Ctrl + E）"), cols);
			return app.full.render(screen, rows, cols, undefined);
		}
	}

	const renderFrameInner = (): number => {
		app.select.selectionGuard(); // T8：关窗首帧清 scope=view 残留选区
		const { cols, rows, leftW, streamH, start, dmTotal, doc, inputRows, cursorPos, showRows, queue, queueH } = layoutFrame();
		const s = app.state;

		// 面板行只在侧栏可见时计算（隐藏时 sidebarW=0 会让 panelBox 内宽为负——repeat 炸）
		const sidebarW = s.sidebarVisible ? app.panels.sidebarW() : 0;
		const statusH = Math.max(8, Math.floor(rows * 0.55));
		const taskH = rows - statusH;
		const status = s.sidebarVisible ? app.panels.statusRows(sidebarW, statusH) : [];
		const tasks = s.sidebarVisible ? app.panels.taskRows(sidebarW, taskH) : [];

		const inputFocused = s.focusIdx === 0;
		const ibc = inputFocused ? "accent" : "border";
		const screen: string[] = Array.from({ length: rows }, () => "");
		for (let r = 0; r < streamH; r++) {
			// 消息区左内衬 2 列（2026-09-23 用户拍板：文字起始贴屏幕左缘难看）——docmodel 折行口径
			// = streamW − 2，前导 2 空格后恰 = leftW 不截尾；空行也垫，块状整体右移保持对齐；
			// 选区行反白合入（m5 鼠标批 T5）。窗口化（T5）：doc[r] 即全局 start+r 行（窗口从 start 起）
			const raw = doc[r] === undefined ? "" : `  ${doc[r]!}`;
			screen[r] = padToWidth(app.select.styleDocSelection("main", start + r, raw), leftW);
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
				// 排队正文 = 用户输入的内容 → 石青 info（2026-10-03 走查拍板：灰色被否——消息是待发送的活内容不是提示）
				screen[streamH + i] = padToWidth(` ${theme.fg("accent", "›")} ${theme.fg("info", truncateToWidth(oneLine, Math.max(1, leftW - 4)))}`, leftW);
			}
			// 两行都 pad 到左栏宽——不补齐则右侧面板分隔线/内容左移错位（走查实锤）
			screen[streamH + queue.length] = padToWidth(theme.dim("  ↑ 召回队尾 · Ctrl + U 立即注入本轮 · 回答结束后依序发送"), leftW);
		}
		const divRow = streamH + queueH;
		// 模块询问挂起期：问题写进输入框顶边标题（F5——placeholder 只在空输入时可见，用户一打字问题就消失）
		if (app.pendingUi?.kind === "ask") {
			const qSeg = theme.fg("accent", ` ${app.pendingUi.question} `);
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

		const sel = app.input.selRange();
		const paneIn = (l: string) => theme.bg("surface2", theme.fg(ibc, "│") + padToWidth(l, leftW - 2) + theme.fg(ibc, "│"));
		for (let i = 0; i < showRows; i++) {
			const vr = inputRows[s.inputScroll + i];
			const prefix = i + s.inputScroll === 0 ? theme.fg("accent", "❯ ") : "  ";
			let line: string;
			if (vr === undefined) {
				line = prefix;
			} else if (s.input !== "" && app.pendingUi?.kind === "ask" && app.pendingUi.secret) {
				line = prefix + "•".repeat(vr.text.length);
			} else if (s.input === "" && i === 0) {
				const ph = app.pendingUi?.kind === "ask"
					? app.pendingUi.secret ? "请输入（不回显）…" : "请输入…" // 问题已在顶边标题（F5 九轮③——占位符不再复读）
					: "向 Orosus 下达指令，或输入 / 查看命令…";
				line = prefix + theme.dim(ph);
			} else {
				line = prefix + styleWithSelection(vr, sel);
			}
			screen[divRow + 1 + i] = paneIn(inputFocused ? line : theme.dim(line));
		}
		const d = app.io.panelData();
		// 档色语义（2026-09-22 用户拍板）：Never Ask = 全自动放行危险档 → 警示黄；确认类档保持青玉
		const chip = theme.fg(d.permission === "never" ? "warn" : "accent", `◆ ${PERM_LABEL[d.permission] ?? d.permission}`);
		const subCnt = app.io.subagentRunningCount?.() ?? 0;
		const subHint = subagentCountHint(subCnt);
		const leftHint = `${chip}${theme.dim(" · Shift + Tab 切换模式")}${subHint !== "" ? theme.dim(" · ") + subHint : ""}`;
		const rightHint = theme.dim("Enter 发送 · Alt + Enter 换行");
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
		if (app.onboarding !== undefined) {
			// dock = 输入框几何（2026-10-02 用户拍板，推翻居中+固定 96 宽）：底边贴输入框上缘、
			// 左缘对齐、宽度一致（leftW）——view/dialog 窗 dock 同款；定高防闪烁纪律不变
			const ob = app.onboarding.session.render(cols, rows, { bottom: divRow, width: leftW });
			overlay = { lines: ob.lines, row: ob.row, col: ob.col, width: ob.width };
		} else if (app.pendingUi?.kind === "pick") {
			const pu = app.pendingUi;
			overlay = app.overlay.buildPickOverlay(leftW, divRow, pu.title, pu.items, pu.sel, pu.filter, pu.extraKeys);
		} else if (app.pendingUi?.kind === "view") {
			const pu = app.pendingUi;
			// live 一秒结果缓存（m5-agentview-perf T4 / D1=1000ms——与查看窗转盘秒位节拍一致）：渲染层兜底，
			// 即使数据源侧判据失效（写入器疯狂 flush），实时窗成本也封顶 1 次/秒。缓存挂 pu 不挂闭包——
			// keys 的 run 消费点（fullapp-keys）回新文本后能顺手失效一拍，1s 窗口内不得顶回旧帧。
			if (pu.live !== undefined) {
				const now = Date.now();
				if (pu.liveCache === undefined || now - pu.liveCache.at >= 1000) {
					pu.liveCache = { at: now, text: pu.live() };
				}
				pu.lines = pu.liveCache.text.split("\n"); // 实时查看窗——每帧现算（滚动钳制在 build 内）
			}
			overlay = app.overlay.buildViewOverlay(pu, leftW, divRow);
		} else if (app.pendingUi?.kind === "dialog") {
			const pu = app.pendingUi;
			overlay = app.overlay.buildDialogOverlay(pu, leftW, divRow);
		} else if (s.atMenu !== undefined) {
			// @ 文件菜单（m5-at-menu T3）：过滤词从 atMenu 词快照读——渲染不追光标现算（光标挪走后
			// 菜单内容静止）；渲染期零 fs——entries 来自 state（导航点现读已存）
			overlay = app.overlay.buildAtOverlay(leftW, divRow, s.atMenu.dir, s.atMenu.entries, s.atMenu.sel, s.atMenu.filter, s.atMenu.miss);
		} else if (s.overlayOpen) {
			overlay = app.overlay.buildOverlay(leftW, divRow);
		} else if (s.diagOpen) {
			overlay = app.overlay.buildDiagOverlay(leftW, divRow);
		}

		const bytes = app.full.render(screen, rows, cols, overlay);
		// 引导期藏光标（弹窗锁焦点——输入框光标不该在背景里闪）；Key 输入是静默盲输，无光标可指示
		// 硬件光标可见条件（2026-09-27 用户走查补）：引导期与浮层挂起期（view/pick/dialog——
		// 浮层是字符层盖不住物理光标，子代理查看窗里浮着光标即此）隐藏；ask 输入行接管与
		// 斜杠菜单（输入框仍可打字过滤）保持显示
		const overlayUi = app.pendingUi !== undefined && app.pendingUi.kind !== "ask";
		app.full.placeCursor(divRow + 1 + (cursorPos.row - s.inputScroll), 3 + cursorPos.col, app.onboarding === undefined && !overlayUi && inputFocused);
		return bytes;
	}

	return { layoutFrame, docRows, renderFrame, renderFrameInner };
}
