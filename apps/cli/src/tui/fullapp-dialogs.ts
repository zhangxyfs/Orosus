/** fullapp-dialogs.ts（m5-split-fullapp T4）：弹窗队列/查看窗/对话框/引导/toast——纯搬移自
 *  fullapp.ts 类体。共享槽字段（pendingUi/uiQueue/onboarding/toastTimer/toastSeq/stopped/scheduler）
 *  留守壳（降级共享——测试 as-cast 直取字段），本件经 app.* 触达；方法体全件搬入工厂。
 *  dialogListIds/dialogInteractiveIds 零 app 触达住模块级（lint 纪律）。非公开 API。 */

import { resolvePopupLayout } from "./popuplayout.ts";
import { renderWidgetLines } from "./widgets.ts";
import { renderMarkdown } from "../mdpipe.ts";
import { OnboardingSession, type OnboardingDeps, type OnboardingOutcome } from "./onboarding.ts";
import type { DialogEvent, DialogHandle, DialogSpec, PopupKey, PopupLayout, WidgetSpec } from "@orosus/contracts/module";
import type { HostDialogKeys, PickExtraKeys } from "./fullapp-types.ts";
import { syncSwitchRow } from "./fullapp-types.ts";
import type { FullApp } from "./fullapp.ts";

/** 弹窗保留键（决策点 7）：Esc/Ctrl+C/V/A/S/Z 绝对禁绑；宿主全局键在按键分发里先于弹窗分支消费
 *  （fullapp onKey 全局拦截段），绑了永不触发——注册即拒并记日志。
 *  走查④（2026-09-29）：alt+e/alt+o/alt+f 移出保留集——查看窗可注册（窗内优先，onKey 全局段
 *  按 viewHasKey 让位）——子代理消息窗的内容快捷键与主窗一致即用此路。铁律只锁 Ctrl+T/E/O
 *  （m5 UI 批「宿主全局键优先于模块窗自定义键」原样保持——这三键仍注册即拒）。alt+v 保留
 *  （贴图全局功能，查看窗无占用场景）。 */
const RESERVED_VIEW_KEYS = new Set([
	"escape", "ctrl+c", "ctrl+v", "ctrl+a", "ctrl+s", "ctrl+z",
	"ctrl+t", "ctrl+e", "ctrl+o", "ctrl+u", "alt+v",
]);

/** 控件清单里的交互列表 id（只计 list——选中逻辑专用）。 */
const dialogListIds = (widgets: readonly WidgetSpec[]): string[] => {
	const ids: string[] = [];
	for (const wd of widgets) if (wd.kind === "list" && wd.interactive === true) ids.push(wd.id);
	return ids;
};

/** 可焦点控件 id（m5 T8：交互列表 + 输入框，Tab 焦点循环序）。 */
const dialogInteractiveIds = (widgets: readonly WidgetSpec[]): string[] => {
	const ids: string[] = [];
	for (const wd of widgets) {
		if ((wd.kind === "list" && wd.interactive === true) || wd.kind === "input") ids.push(wd.id);
	}
	return ids;
};

export function createDialogs(app: FullApp) {
	/** 当前挂起结算后提升队首（无挂起才提——视图/选择/询问任一在位都等待）。 */
	const promoteUi = (): void => {
		if (app.pendingUi !== undefined) return;
		app.uiQueue.shift()?.run();
	};

	/** 剔除保留键并记日志（注册即拒——返回 undefined = 无合法键剩下）。 */
	const filterViewKeys = (keys: Record<string, PopupKey> | undefined, owner: string | undefined): Record<string, PopupKey> | undefined => {
		if (keys === undefined) return undefined;
		const kept: Record<string, PopupKey> = {};
		for (const [k, v] of Object.entries(keys)) {
			if (RESERVED_VIEW_KEYS.has(k)) {
				app.io.logWarn?.("tui.viewkey.reserved", `弹窗自定义键被拒（保留键）：${k}`, owner !== undefined ? { owner, key: k } : { key: k });
				continue;
			}
			kept[k] = v;
		}
		return Object.keys(kept).length > 0 ? kept : undefined;
	};

	/** 只读文本浮层（F5 二轮⑪ / m5 T2 口子一）：几何走 resolvePopupLayout（缺省 center80 居中弹窗——
	 *  五旧窗随之统一新长相）、自定义键（保留键剔除）、排队化。too-small（连保底 8×3 都装不下）不弹窗、
	 *  黄字「终端窗口太小」（分析报告口子一 :125 的调用方行为）。
	 *  layout "dock"（m4-7 走查修，宿主内部值——模块契约 PopupLayout 不含）：贴输入框上缘 + 左栏同宽，
	 *  内容自适应封顶可滚（渲染期 buildViewOverlay 算几何，不走 resolvePopupLayout）。 */
	const viewText = (title: string, text: string, opts?: { layout?: PopupLayout | "dock"; keys?: Record<string, PopupKey>; owner?: string; live?: () => string; bottom?: boolean; markdown?: boolean }): void => {
		const open = (): void => {
			if (app.stopped) return;
			if (opts?.layout !== "dock") { // dock 不走居中几何——too-small 检查仅对弹窗布局有意义
				const geo = viewGeo(opts?.layout);
				if (geo.fallbackReason === "too-small") {
					showToast("终端窗口太小，弹窗未打开");
					promoteUi(); // 队列里的下一个照常提（本窗没占槽）
					return;
				}
			}
			const keys = filterViewKeys(opts?.keys, opts?.owner);
			// markdown 正文先走回显面 md 管线（m5-peers 走查六-③——/btw dock 窗 renderMarkdown 同源先例）；
			// 折行宽 = full 弹窗内容区口径 cols−6（compaction 摘要同款），非 full 布局同样按此渲染（取窗内容宽近似）
			const initLines = opts?.markdown === true
				? renderMarkdown(text, Math.max(20, app.io.columns() - 6))
				: text.split("\n");
			app.state.overlayOpen = false; // 与斜杠菜单互斥
			app.pendingUi = {
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
			app.scheduler.requestImmediateRender();
		};
		if (app.pendingUi !== undefined) {
			app.uiQueue.push({ run: open, ...(opts?.owner !== undefined ? { owner: opts.owner } : {}) });
			return;
		}
		open();
	};

	/** view 态的窗几何（渲染与按键翻页共用一源——两处漂移即滚动越界）。 */
	const viewGeo = (layout: PopupLayout | "dock" | undefined): ReturnType<typeof resolvePopupLayout> => {
		// dock 不走居中几何（渲染期 buildViewOverlay 另算）——viewGeo 调用方一律回 center80 缺省
		return resolvePopupLayout(app.io.columns(), app.io.rows(), layout === "dock" ? undefined : layout);
	};

	/** 控件窗宿主超集（T17 m4-3c）：DialogSpec + 自定义键（hostKeys）。契约面不动——模块仍走
	 *  openDialog（键被静默丢弃）；宿主表单窗用本口。
	 *  开控件窗：几何走 T1（不另算）；排队同 viewText（单槽 FIFO）。
	 *  句柄闭包查属主与存活——窗已关/模块已卸载后调用 = 无操作不报错；
	 *  排队期（窗还没开）的 update/close 同款无操作。 */
	const openDialogHost = (spec: Omit<DialogSpec, "layout"> & { layout?: PopupLayout | "dock"; hostKeys?: HostDialogKeys; disallowEscape?: boolean }, owner?: string): DialogHandle | undefined => {
		const lists = dialogInteractiveIds(spec.widgets);
		let installed: (typeof app.pendingUi) & { kind: "dialog" } | undefined;
		const open = (): void => {
			if (app.stopped) return;
			const geo = viewGeo(spec.layout);
			if (geo.fallbackReason === "too-small") {
				showToast("终端窗口太小，弹窗未打开");
				promoteUi();
				return;
			}
			app.state.overlayOpen = false; // 与斜杠菜单互斥
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
				...(spec.disallowEscape === true ? { disallowEscape: true } : {}),   // 走查九-③：进行态窗（导入/整理）禁 Esc——强停走显式键
			};
			installed = e;
			app.pendingUi = e;
			app.scheduler.requestImmediateRender();
		};
		if (app.pendingUi !== undefined) {
			app.uiQueue.push({ run: open, ...(owner !== undefined ? { owner } : {}) });
			return {
				update: () => {}, // 窗未开前的句柄调用 = 无操作（开窗后的更新走已安装的闭包）
				close: () => {
					const i = app.uiQueue.findIndex((q) => q.run === open);
					if (i >= 0) app.uiQueue.splice(i, 1); // 还在排队里——直接退队
				},
			};
		}
		open();
		return {
			update: (widgets) => {
				if (installed === undefined || app.pendingUi !== installed) return; // 路 3：句柄更新——换清单滚回顶部（设计空白 14）
				installed.widgets = widgets;
				installed.selById = {};
				installed.scroll = 0;
				// inputById 与焦点保留（2026-09-30 实机走查：表单窗同 id 重拼是常态——切传输方式/开高级区
				// 重拼清单时清输入 = 已敲的字凭空蒸发、焦点跳回第一格；设计空白 14 钉的是滚回顶部，不含这俩。
				// 消失的 id 留着无害（渲染按 id 现读），焦点 id 不在新清单才回落首格）
				const ids = dialogInteractiveIds(widgets);
				if (installed.focusedId === undefined || !ids.includes(installed.focusedId)) {
					installed.focusedId = ids.length > 0 ? ids[0] : undefined; // 无交互控件 = 无焦点（exactOptional 收窄）
				}
				app.scheduler.requestImmediateRender();
			},
			close: () => {
				if (installed === undefined || app.pendingUi !== installed) return;
				app.pendingUi = undefined;
				promoteUi();
				app.scheduler.requestImmediateRender();
			},
		};
	};

	/** 按 owner 关模块的挂起窗（m5 T7——reload removed 名单通知的接收口）：
	 *  在屏的 view/dialog 属主匹配即关 + 排队里它的窗一并丢弃 + toast “模块已卸载”。 */
	const closeModuleUi = (owner: string): void => {
		const pu = app.pendingUi;
		if (pu !== undefined && (pu.kind === "view" || pu.kind === "dialog") && pu.owner === owner) {
			app.pendingUi = undefined;
			showToast(`模块 ${owner} 已卸载——其窗口已关闭`);
			promoteUi();
			app.scheduler.requestImmediateRender();
		}
		for (let i = app.uiQueue.length - 1; i >= 0; i--) {
			if (app.uiQueue[i]!.owner === owner) app.uiQueue.splice(i, 1);
		}
	};

	/** dialog 事件回传（m5 T7）：模块 onEvent 抛错 = 黄字提示且窗保留（全局约束 4）；
	 *  返回新清单 = 整窗替换滚回顶部（路 2）。 */
	const fireDialogEvent = (pu: { widgets: WidgetSpec[]; selById: Record<string, number>; inputById?: Record<string, { text: string; cursor: number }>; scroll: number; focusedId?: string | undefined; onEvent?: DialogSpec["onEvent"] }, e: DialogEvent): void => {
		if (pu.onEvent === undefined) return;
		try {
			const next = pu.onEvent(e);
			if (next !== undefined) {
				pu.widgets = next;
				pu.selById = {};
				pu.inputById = {};
				pu.scroll = 0;
				const ids = dialogInteractiveIds(next);
				pu.focusedId = ids.length > 0 ? ids[0] : undefined;
			}
		} catch (err) {
			showToast(`控件窗事件处理出错：${err instanceof Error ? err.message : String(err)}`);
		}
	};

	/** 选中项行位跟随（窗口滚动针对焦点列表的选中项最小平移）。 */
	const dialogFollowSel = (pu: { widgets: readonly WidgetSpec[]; scroll: number; layout?: PopupLayout | "dock"; focusedId?: string | undefined; selById: Record<string, number> }): void => {
		if (pu.focusedId === undefined) return;
		const geo = viewGeo(pu.layout === "dock" ? undefined : pu.layout);
		const wl = renderWidgetLines(pu.widgets, geo.width - 2, { selById: pu.selById, focusedId: pu.focusedId });
		const li = wl.lists.find((l) => l.id === pu.focusedId);
		if (li === undefined) return;
		const line = li.baseLine + (pu.selById[li.id] ?? 0);
		const page = Math.max(3, geo.height - 3);
		const lo = Math.max(0, line - page + 1);
		pu.scroll = Math.max(lo, Math.min(line, pu.scroll));
	};

	/** 打开引导弹窗（完成/退出即 resolve；宿主在完成态 reload 生效 + toast 留痕）。
	 *  requestRender 强制接自家帧调度（异步模型清单到达即重绘——宿主传的任何件都被覆盖）。
	 *  引导弹窗占用槽：在槽期一切按键/粘贴路由给会话（焦点锁——pendingUi/编辑态全部让位）。 */
	const runOnboarding = (deps: OnboardingDeps, initial?: { configured?: string[]; active?: string | null }): Promise<OnboardingOutcome> => {
		return new Promise((resolve) => {
			app.onboarding = {
				session: new OnboardingSession({
					...deps,
					requestRender: () => app.scheduler.requestRender(),
					finish: (outcome) => resolve(outcome),   // T6d：第 5 页异步导入完成自动收尾（session 侧调）
				}, initial),
				resolve,
			};
			app.scheduler.requestImmediateRender();
		});
	};

	/** 浮动提示（2026-09-22 用户拍板）：输入框上边缘黄字、自消。自消靠定时器补一帧——
	 *  非 busy 期没有 spinner 心跳，不定时的話旧 toast 会留到下一次按键。
	 *  m5 T3：增可选时长毫秒——缺省 3000、允许 [1000, 30000]、越界钳到边界（设计空白 3）；
	 *  主程序自己的十几处调用全走缺省零变化。
	 *  CTU-03（2026-09-28 修复）：toast 发身份令牌 + 定时器单槽登记清理。旧实现每 toast 新建
	 *  setTimeout 从不取消，旧定时器按闭包里的旧时长做龄检——任何在新 toast 顶上后 200ms 窗口内
	 *  创建的 toast 都会被旧定时器按旧时长误消（混时长实测：3000ms 宿主 toast 后 100ms 顶上
	 *  8000ms 模块 notice，~3.1s 被杀，应停 8s）。令牌判身份与时长彻底解耦，顶替时旧定时器直接作废。 */
	const showToast = (text: string, durationMs?: number): void => {
		const duration = Math.max(1000, Math.min(30000, durationMs ?? 3000));
		if (app.toastTimer !== undefined) clearTimeout(app.toastTimer); // 旧定时器随顶替作废（单槽登记）
		const id = ++app.toastSeq;
		app.state.toast = { id, text, at: Date.now(), ...(duration !== 3000 ? { duration } : {}) };
		app.scheduler.requestImmediateRender();
		const timer = setTimeout(() => {
			app.toastTimer = undefined;
			if (app.state.toast?.id !== id) return; // 身份不符（已被顶替）——不看时长直接退出
			app.state.toast = undefined;
			app.scheduler.requestRender();
		}, duration + 100);
		timer.unref?.();
		app.toastTimer = timer;
	};

	/** choose 的全屏形态：overlay 列表选择（Esc → undefined——宿主侧转「已取消（Esc）」，机制③同族）。
	 *  单槽占用期 FIFO 暂存（批③②——不再顶退挂起者）。
	 *  m5-ask-multi：opts.custom: true = chooseEx 增强面。走查修（2026-10-08）后 resolve 回调只剩两口：
	 *  undefined（Esc）与 items.length + 1（确定行——单选/多选统一提交口）；结算值按 pu 现值组装：
	 *  checked 升序映射 + customCommitted 恒尾（单选圆圈唯一 → 两者互斥恰一项成员）。
	 *  resolve 对外签名零改动（风险节铁律——勿为文本扩类型）。增强面旗标显式化（2026-10-08）：
	 *  opts 传入不再隐式触发合成行——settings 高窗 opts.tall 等展示旗标走老选择面。
	 *  settings 高窗（2026-10-08 用户拍板）：opts.tall: true = 页大小随终端高 [10,20]（渲染层 pickPageOf 现算）。
	 *  横选面（2026-10-09 用户拍板：/model 选模型同窗选思考档——kimi 形态）：opts.switch = 老选择面 +
	 *  底部左右选择器行；Enter 结算 { index, value }——value 按提交时 switchRow 现值（syncSwitchRow
	 *  随高亮项重置后取值；项无候选 = undefined）。与 custom 互斥（/model 单选即答面无需确认行）。 */
	const pickOverlay = (title: string, items: string[], selAt = 0, keys?: PickExtraKeys, opts?: { custom?: boolean; multi?: boolean; tall?: boolean; switch?: { label: string; valuesOf: (item: string) => string[] | undefined; initialOf?: (item: string) => string | undefined } }): Promise<number | undefined | string[] | undefined | { index: number; value: string | undefined } | undefined> => {
		if (app.pendingUi !== undefined) {
			return new Promise((resolve) => app.uiQueue.push({ run: () => {
				if (app.stopped) { resolve(undefined); return; }
				void pickOverlay(title, items, selAt, keys, opts).then(resolve);
			} }));
		}
		app.state.overlayOpen = false; // 与斜杠菜单互斥
		const ex = opts?.custom === true; // chooseEx 增强面（「其他」+「确定」合成行）——显式旗标
		const sw = opts?.switch; // 横选面（chooseSide——老选择面 + 底部左右选择器行）
		return new Promise((resolve) => {
			// ≥12 项启用输入过滤（F5 九轮① 用户拍板：厂商目录全量直列、列表内输入即筛——includes 口径）
			// m5-ask-multi：合成行不参与过滤（D8）——「其他」「确定」恒显示，阈值仍按普通项数计
			const pu: NonNullable<FullApp["pendingUi"]> & { kind: "pick" } = {
				kind: "pick",
				title,
				items,
				sel: Math.max(0, Math.min(items.length - 1, selAt)), // m4-7 T9：初始选中（详情 Esc 回列表选中行回到该技能）
				resolve: sw !== undefined
					? (n: number | undefined) => {
						if (n === undefined) { resolve(undefined); return; }
						const item = items[n]!;
						syncSwitchRow(pu.switchRow!, item); // 结算口兜底同步（键路漏调/直驱测试形态）
						const vals = pu.switchRow!.valuesOf(item);
						resolve({ index: n, value: vals !== undefined && vals.length > 0 ? (vals[pu.switchRow!.switchIdx] ?? vals[0]) : undefined });
					}
					: ex
						? (n: number | undefined) => {
							if (n === undefined) { resolve(undefined); return; }
							const out = pu.checked.toSorted((a, b) => a - b).map((i) => items[i]!);
							if (pu.customCommitted !== undefined) out.push(pu.customCommitted); // 「其他」恒尾语义
							resolve(out);
						}
						: resolve,
				...(items.length >= 12 ? { filter: "" } : {}),
				...(keys !== undefined ? { extraKeys: keys } : {}),
				...(ex ? { custom: true } : {}),
				...(opts?.multi === true ? { multi: true } : {}),
				...(opts?.tall === true ? { tall: true } : {}),
				...(sw !== undefined ? { switchRow: { label: sw.label, valuesOf: sw.valuesOf, ...(sw.initialOf !== undefined ? { initialOf: sw.initialOf } : {}), switchIdx: 0 } } : {}),
				checked: [],
				customText: "",
				editing: false,
			};
			if (pu.switchRow !== undefined) syncSwitchRow(pu.switchRow, items[pu.sel]); // 开窗初值（高亮项档位落位）
			app.pendingUi = pu;
			app.scheduler.requestImmediateRender();
		});
	};

	/** ask/askSecret 的全屏形态：输入行接管（提示语进输入框前缀；secret 盲显 •；Esc → undefined）。
	 *  单槽占用期 FIFO 暂存（同 pickOverlay——批③②）。 */
	const promptInput = (question: string, secret: boolean): Promise<string | undefined> => {
		if (app.pendingUi !== undefined) {
			return new Promise((resolve) => app.uiQueue.push({ run: () => {
				if (app.stopped) { resolve(undefined); return; }
				void promptInput(question, secret).then(resolve);
			} }));
		}
		const prev = { input: app.state.input, cursor: app.state.cursor };
		app.state.input = "";
		app.state.cursor = 0;
		return new Promise((resolve) => {
			app.pendingUi = {
				kind: "ask",
				question,
				secret,
				prev, // CTU-07：接管前草稿快照——Enter/Esc 两结算路径共读（成功路径不再丢草稿）
				resolve: (v) => {
					if (v === undefined) {
						app.state.input = prev.input;
						app.state.cursor = prev.cursor;
					}
					resolve(v);
				},
			};
			app.scheduler.requestImmediateRender();
		});
	};

	return { promoteUi, filterViewKeys, viewText, viewGeo, dialogListIds, dialogInteractiveIds, openDialogHost, closeModuleUi, fireDialogEvent, dialogFollowSel, runOnboarding, showToast, pickOverlay, promptInput };
}
