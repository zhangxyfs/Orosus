/** fullapp-mouse.ts（m5-split-fullapp T6）：滚轮/鼠标键/自动滚/滚动条——纯搬移自 fullapp.ts 类体。
 *  与选区族（fullapp-select.ts）在原类体交错，成员级锚定摘取；stopAutoScroll 随族搬入（选区族
 *  侧经 app.mouse.stopAutoScroll 触达）；scrollbarTrackHit 的 FullApp["scrollbarTrackBase"] 类型
 *  引用改结构化 TrackBase（类型面等价改写）。非公开 API。 */

import { WHEEL_STEP, ALT_WHEEL_MULTIPLIER, thumbGeometry, wordRangeAt } from "./fullapp-types.ts";
import { filterEntries } from "./fullapp-at.ts";
import { osc8LinkAtColumn, stripAnsi, visibleWidth } from "./width.ts";
import { renderWidgetLines } from "./widgets.ts";
import type { WheelEvent, ButtonEvent } from "./mouse.ts";
import type { WidgetSpec } from "@orosus/contracts/module";
import type { FullApp } from "./fullapp.ts";

/** 滚动条基座几何（scrollbarTrackBase 返回型——trackHit/press/drag 共用）。 */
type TrackBase = { total: number; viewportH: number; first: number; trackTop: number; thumb: { top: number; height: number } };

export function createMouse(app: FullApp) {
	/** 滚轮路由（m5 鼠标批 T2——kimi routeWheel :986-998 的窗口栈版）：滚轮给当前最上层可滚面，
	 *  与键盘焦点无关；主流区是兜底（= kimi 未落在可滚组件时兜底主视图）。主窗直绑 scrollBack
	 *  字段不绑翻页键（决策点 5：翻页键吃面板焦点而滚轮不吃——面板聚焦期滚轮仍滚主流区）。 */
	const onWheel = (w: WheelEvent): void => {
		const s = app.state;
		const lines = WHEEL_STEP * (w.alt ? ALT_WHEEL_MULTIPLIER : 1); // kimi :981-983 同式
		const up = w.direction === -1;
		if (app.onboarding !== undefined) return; // 引导焦点锁（同 onKey）
		const pu = app.pendingUi;
		if (pu?.kind === "view") {
			const page = pu.viewPage ?? Math.max(3, app.dialogs.viewGeo(pu.layout).height - 3); // viewPage = 渲染期回写（dock 与渲染同源；m4-7 走查修）
			if (pu.pinned === true) { pu.scroll = Math.max(0, pu.lines.length - page); pu.pinned = false; } // T1 落地再滚
			pu.scroll = Math.max(0, Math.min(Math.max(0, pu.lines.length - page), pu.scroll + (up ? -lines : lines)));
		} else if (pu?.kind === "dialog") {
			// 走查七-②：聚焦 interactive list 期滚轮 = ↑↓（移选中行 + 视口跟随 + select 事件——与键盘同效）；
			// 表单/无聚焦列表窗保持滚窗体（旧语义——内容行数走 renderWidgetLines 渲染口径，与 buildDialogOverlay 同源）
			const ids = app.dialogs.dialogInteractiveIds(pu.widgets);
			const focusId = pu.focusedId ?? ids[0];
			const list = focusId !== undefined
				? pu.widgets.find((wd): wd is Extract<WidgetSpec, { kind: "list" }> => wd.kind === "list" && wd.id === focusId && wd.interactive === true)
				: undefined;
			if (list !== undefined) {
				const cur = pu.selById[list.id] ?? 0;
				const next = Math.max(0, Math.min(list.items.length - 1, cur + (up ? -lines : lines)));   // 到头停（决策点 6 同款）
				if (next !== cur) {
					pu.selById[list.id] = next;
					app.dialogs.fireDialogEvent(pu, { type: "select", id: list.id, index: next });
					app.dialogs.dialogFollowSel(pu);
				}
			} else {
				const geo = app.dialogs.viewGeo(pu.layout === "dock" ? undefined : pu.layout);
				const page = Math.max(3, geo.height - 3);
				const total = renderWidgetLines(pu.widgets, geo.width - 2, { selById: pu.selById, inputById: pu.inputById, ...(pu.focusedId !== undefined ? { focusedId: pu.focusedId } : {}) }).lines.length;
				pu.scroll = Math.max(0, Math.min(Math.max(0, total - page), pu.scroll + (up ? -lines : lines)));
			}
		} else if (pu?.kind === "pick") {
			// 与键盘同一张过滤清单——过滤激活时按 filtered 钳，否则滚轮可越过过滤尾致 Enter 错位
			const filtered = pu.filter === undefined ? pu.items : pu.items.filter((i) => i.toLowerCase().includes(pu.filter!.toLowerCase()));
			pu.sel = Math.max(0, Math.min(filtered.length - 1, pu.sel + (up ? -lines : lines))); // 到头停（决策点 6——不学键盘回绕）
		} else if (pu !== undefined) {
			return; // ask——没有可滚面
		} else if (s.atMenu !== undefined) {
			// @ 文件菜单滚轮（m5-at-menu T3）：与 onAtKey 共用 filterEntries 一源（两处口径漂移即
			// Enter 错位）；到头停（决策点 6 同款——不学键盘回绕）
			const items = filterEntries(s.atMenu.entries, s.atMenu.filter);
			s.atMenu.sel = Math.max(0, Math.min(items.length - 1, s.atMenu.sel + (up ? -lines : lines)));
		} else if (s.overlayOpen) {
			const items = app.menu.overlayItems();
			s.overlaySel = app.menu.selToSelectable(items, s.overlaySel + (up ? -lines : lines));
		} else if (s.diagOpen) {
			const entries = app.io.diagEntries?.() ?? [];
			s.diagSel = Math.max(0, Math.min(Math.max(0, entries.length - 1), s.diagSel + (up ? -lines : lines)));
		} else if (s.launcherOpen) {
			const entries = app.io.launcherEntries?.() ?? [];   // m5-peers T6e：总览滚轮（diag 同款边界夹紧）
			s.launcherSel = Math.max(0, Math.min(Math.max(0, entries.length - 1), s.launcherSel + (up ? -lines : lines)));
		} else {
			s.scrollBack = Math.max(0, s.scrollBack + (up ? lines : -lines)); // 上滚=回看历史（PgUp 同向）；上界渲染帧已钳
			if (up && app.viewportRange().start === 0) app.requestOlderPage(); // T14：滚到顶继续上滚 → 懒分页补头
		}
		app.scheduler.requestImmediateRender();
	};

	/** 按钮事件处理器（m5 鼠标批 T5 填肉 / T6 粒度 / T7 链接 / T8 查看窗）：按下建锚（空点击 =
	 *  折叠选区）、拖动扩焦（越界钳边界）、松开结算复制（kimi handleSelectionMouseEvent
	 *  :1314-1383 同构）。查看窗在位且指针在盒内 → 选查看窗内容（T8，坐标系 = 盒内衬 2 列）。 */
	const onButton = (e: ButtonEvent): void => {
		if (app.onboarding !== undefined) return; // 引导锁（同 onWheel）
		if (e.button !== 0 && e.kind !== "hover") return; // v1 只左键；hover 恒无按钮（?1003 纯移动）
		const s = app.state;
		if (e.kind === "hover") {
			// 悬停检测（T10）：指针在轨道列上 → 记 scope 供渲染换亮色（tmux 降级档无 ?1003 →
			// 无 hover 事件恒不高亮，属预期披露）
			s.scrollbarHover = scrollbarTrackHit(e.x, e.y)?.scope;
			app.scheduler.requestImmediateRender();
			return;
		}
		if (e.kind === "press") {
			// 滚动条优先于选区（kimi :1102-1112 次序）：命中轨道列 → 拖动状态机（点轨道非拇指先跳位）
			const track = scrollbarTrackHit(e.x, e.y);
			if (track !== undefined) {
				scrollbarPress(track, e.y);
				app.scheduler.requestImmediateRender();
				return;
			}
			// 查看窗盒内优先（T8）——主流区 pointToDoc 之前判 viewGeo 盒命中
			const vp = app.select.pointToView(e.x, e.y);
			const p = vp !== undefined
				? { scope: "view" as const, docIdx: vp.docIdx, col: vp.col }
				: (() => { const m = app.select.pointToDoc(e.x, e.y); return m === undefined ? undefined : { scope: "main" as const, docIdx: m.docIdx, col: m.col }; })();
			const plain = p !== undefined ? stripAnsi(app.select.selLineText(p.scope, p.docIdx)) : undefined;
			const word = p !== undefined && plain !== undefined ? wordRangeAt(plain, p.col) : undefined;
			const count = app.select.clickCount(p, word);
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
					const url = osc8LinkAtColumn(app.select.selLineText(p.scope, p.docIdx), p.col);
					return url === undefined ? undefined : { url, x: e.x, y: e.y };
				})()
				: undefined;
		} else if (e.kind === "drag") {
			// 滚动条拖动跟手优先（T10——拖动态在位时不再扩选）
			if (s.scrollbarDrag !== undefined) {
				scrollbarDragTo(e.y);
				app.scheduler.requestImmediateRender();
				return;
			}
			s.pressedUrl = undefined; // 拖动即作废（误拖保护）
			if (s.mselAnchor === undefined) return;
			app.select.extendSelection(e.x, e.y);
			// 拖选自动滚（T9——kimi updateSelectionAutoScroll :1259-1285）：压到所在窗口上/下边缘
			// → 50ms 一格滚 + 指针重映射续选；方向必落 state（脉冲从 state 读——两字段号相反见 pulse）
			s.dragPointer = { x: e.x, y: e.y };
			const dir = autoScrollDirFor(e.y);
			if (dir === 0) {
				stopAutoScroll();
			} else {
				s.autoScrollDir = dir;
				if (s.autoScrollTimer === undefined) {
					s.autoScrollTimer = setInterval(() => autoScrollPulse(), 50); // 设计空白 12
					s.autoScrollTimer.unref?.();
				}
			}
		} else if (e.kind === "release") {
			s.scrollbarDrag = undefined; // 滚动条拖动结算（T10）
			stopAutoScroll(); // 松手即停（kimi :1322 同位）
			// 链接打开（T7——kimi :1330-1336 次序）：未拖动（pressedUrl 未被 drag 作废）且同点才打开
			const pu = s.pressedUrl;
			if (pu !== undefined && pu.x === e.x && pu.y === e.y) void app.select.openLink(pu.url);
			s.pressedUrl = undefined;
			const text = app.select.selectionText();
			if (text !== undefined) void app.select.copySelection(text); // 已复制 N 行（决策点 8）
			else { s.mselAnchor = undefined; s.mselFocus = undefined; } // 空选区松开即消
		}
		app.scheduler.requestImmediateRender();
	};

	/** 自动滚方向判定（T9）：按选区 scope 的窗口界——压上边缘 -1 / 压下边缘 +1 / 界内 0。 */
	const autoScrollDirFor = (y: number): -1 | 0 | 1 => {
		if (app.state.mselAnchor?.scope === "view") {
			const pu = app.pendingUi;
			if (pu?.kind === "view") {
				const geo = app.dialogs.viewGeo(pu.layout);
				if (y <= geo.row + 1) return -1; // 内容区顶（顶框让 1 行）
				if (y >= geo.row + geo.height - 2) return 1; // 内容区底（提示行/底框让位）
				return 0;
			}
			return 0;
		}
		const { streamH } = app.frame.layoutFrame();
		if (y <= 0) return -1;
		if (y >= streamH - 1) return 1;
		return 0;
	};

	/** 自动滚脉冲（T9——kimi autoScrollSelection :1287-1303）：每 tick 滚 1 行、滚到头自停、
	 *  滚完指针重映射续选（内容滚过指针 = 选区吃进滚过的行）。方向号按 scope：主窗 scrollBack -= dir
	 *  （压底 = 向新 = scrollBack 减）、查看窗 pu.scroll += dir——两字段号相反，统一 += 必有一窗反向。 */
	const autoScrollPulse = (): void => {
		const s = app.state;
		const { dragPointer, autoScrollDir } = s;
		if (dragPointer === undefined || autoScrollDir === 0) {
			stopAutoScroll();
			return;
		}
		if (s.mselAnchor?.scope === "view") {
			const pu = app.pendingUi;
			if (pu?.kind !== "view") {
				stopAutoScroll();
				return;
			}
			const page = pu.viewPage ?? Math.max(3, app.dialogs.viewGeo(pu.layout).height - 3); // viewPage = 渲染期回写（dock 与渲染同源；m4-7 走查修）
			const maxScroll = Math.max(0, pu.lines.length - page);
			if (pu.pinned === true) { pu.scroll = maxScroll; pu.pinned = false; } // 脱钉再滚（与滚轮/翻页键三处同款）
			const before = pu.scroll;
			pu.scroll = Math.max(0, Math.min(maxScroll, pu.scroll + autoScrollDir));
			if (pu.scroll === before) {
				stopAutoScroll();
				return;
			}
		} else {
			const { streamH, dmTotal } = app.frame.layoutFrame();
			const maxScroll = Math.max(0, dmTotal - streamH);
			const before = s.scrollBack;
			s.scrollBack = Math.max(0, Math.min(maxScroll, s.scrollBack - autoScrollDir));
			if (s.scrollBack === before) {
				stopAutoScroll();
				return;
			}
		}
		app.select.extendSelection(dragPointer.x, dragPointer.y); // 指针重映射：start 变了映射点随行
		app.scheduler.requestImmediateRender();
	};

	/** 停自动滚（T9）：松开/回界内/滚到头/窗关闭四路共用。 */
	const stopAutoScroll = (): void => {
		const s = app.state;
		if (s.autoScrollTimer !== undefined) {
			clearInterval(s.autoScrollTimer);
			s.autoScrollTimer = undefined;
		}
		s.autoScrollDir = 0;
		s.dragPointer = undefined;
	};

	/** 查看窗键让位判定（走查④）：查看窗注册了该键 → 窗内优先——Alt+E/O/F 等内容键落到查看窗
	 *  自己的 keys 分发（子代理消息窗的内容快捷键与主窗一致），主窗全局段不拦截（穿透到
	 *  pendingUi 分支）。查看窗未注册的键照旧走主窗语义。 */
	const viewHasKey = (key: string): boolean => {
		const pu = app.pendingUi;
		return pu?.kind === "view" && pu.keys?.[key] !== undefined;
	};

	/** 滚动条基座几何：scope → 视口高/总行数/首行/轨道顶行/当前拇指。 */
	const scrollbarTrackBase = (scope: "main" | "view"): TrackBase | undefined => {
		if (scope === "view") {
			const pu = app.pendingUi;
			if (pu?.kind !== "view") return undefined;
			const geo = app.dialogs.viewGeo(pu.layout);
			const page = Math.max(3, geo.height - 3);
			const maxScroll = Math.max(0, pu.lines.length - page);
			const sc = pu.pinned === true ? maxScroll : Math.max(0, Math.min(maxScroll, pu.scroll));
			const thumb = thumbGeometry(page, pu.lines.length, sc);
			if (thumb === undefined) return undefined;
			return { total: pu.lines.length, viewportH: page, first: sc, trackTop: geo.row + 1, thumb };
		}
		const { streamH, start, dmTotal } = app.frame.layoutFrame();
		const thumb = thumbGeometry(streamH, dmTotal, start);
		if (thumb === undefined) return undefined;
		return { total: dmTotal, viewportH: streamH, first: start, trackTop: 0, thumb };
	};

	/** 轨道命中判定（T10）：指针在轨道列（主窗 = leftW−1 / 查看窗 = 盒内右列）且在轨道行范围内。 */
	const scrollbarTrackHit = (x: number, y: number): { scope: "main" | "view" } & TrackBase | undefined => {
		const pu = app.pendingUi;
		if (pu?.kind === "view") {
			const geo = app.dialogs.viewGeo(pu.layout);
			const t = scrollbarTrackBase("view");
			if (t === undefined) return undefined;
			if (x === geo.col + geo.width - 2 && y >= t.trackTop && y < t.trackTop + t.viewportH) {
				return { scope: "view", ...t };
			}
			return undefined;
		}
		const { streamH, leftW } = app.frame.layoutFrame();
		const t = scrollbarTrackBase("main");
		if (t === undefined) return undefined;
		if (x === leftW - 1 && y >= 0 && y < streamH) {
			return { scope: "main", ...t };
		}
		return undefined;
	};

	/** 轨道按下（T10——kimi :1115-1118）：点轨道非拇指先把拇指中心跳到指针行，再记抓取偏移。 */
	const scrollbarPress = (t: TrackBase & { scope: "main" | "view" }, y: number): void => {
		const s = app.state;
		const scrollRange = Math.max(1, t.total - t.viewportH);
		const maxOff = Math.max(1, t.viewportH - t.thumb.height);
		const rel = y - t.trackTop;
		if (rel < t.thumb.top || rel >= t.thumb.top + t.thumb.height) {
			// 点轨道非拇指 → 跳位（指针行居中成新拇指中心）
			const first = Math.max(0, Math.min(t.total - t.viewportH, Math.round(((rel - t.thumb.height / 2) / maxOff) * scrollRange)));
			setScrollFirst(t.scope, first);
		}
		const th = scrollbarTrackBase(t.scope)?.thumb ?? t.thumb; // 跳位后重算
		s.scrollbarDrag = { scope: t.scope, grabOffset: y - (t.trackTop + th.top) };
	};

	/** 拖动跟手（T10——kimi :1075-1078 四则式）：指针 Y − 抓取偏移 → 拇指顶 → 滚动位置。 */
	const scrollbarDragTo = (y: number): void => {
		const s = app.state;
		const drag = s.scrollbarDrag;
		if (drag === undefined) return;
		const t = scrollbarTrackBase(drag.scope);
		if (t === undefined) {
			s.scrollbarDrag = undefined;
			return;
		}
		const scrollRange = Math.max(1, t.total - t.viewportH);
		const maxOff = Math.max(1, t.viewportH - t.thumb.height);
		const first = Math.max(0, Math.min(t.total - t.viewportH, Math.round(((y - drag.grabOffset - t.trackTop) / maxOff) * scrollRange)));
		setScrollFirst(drag.scope, first);
	};

	/** 写滚动位置（T10——与滚轮/翻页键/自动滚四源同汇同一字段）。主窗 first 是 start 口径
	 *  （拇指映射视角），scrollBack = maxScroll − first。 */
	const setScrollFirst = (scope: "main" | "view", first: number): void => {
		if (scope === "view") {
			const pu = app.pendingUi;
			if (pu?.kind === "view") {
				pu.pinned = false;
				pu.scroll = first;
			}
			return;
		}
		const { streamH, dmTotal } = app.frame.layoutFrame();
		app.state.scrollBack = Math.max(0, Math.min(Math.max(0, dmTotal - streamH), dmTotal - streamH - first));
	};

	return { onWheel, onButton, autoScrollDirFor, autoScrollPulse, stopAutoScroll, viewHasKey, scrollbarTrackBase, scrollbarTrackHit, scrollbarPress, scrollbarDragTo, setScrollFirst };
}
