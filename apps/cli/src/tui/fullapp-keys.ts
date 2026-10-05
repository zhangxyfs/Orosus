/** fullapp-keys.ts（m5-split-fullapp T9）：键盘路由巨方法 onKey——纯搬移自 fullapp.ts 类体
 *  （L381-876 原样整体摘取，分派顺序/case 分组/早退路径一个不动——D4 结构红线）。
 *  体内 this.→app. 机械改写 119 处；子系统调用经装配对象前缀。非公开 API。 */

import { CONN_SLOTS, inlineSlashWord, MODULE_SLOTS, normCmd, OVERLAY_PAGE, type DialogKeyCtx, type FocusIdx } from "./fullapp-types.ts";
import { isPrintable } from "./keymatch.ts";
import type { WidgetSpec } from "@orosus/contracts/module";
import type { FullApp } from "./fullapp.ts";

export function createKeys(app: FullApp) {
	/** Esc 关窗记账（2026-10-04 溢出修，用户实机事故：busy 期多层弹窗连按 Esc 关窗，尾部两拍落主窗
	 *  拼成「双击停止」误停生成）：①清双击时戳——Tab 收焦点分支同款先例，无关 Esc 序列不得拼进停止
	 *  判定；②记关窗时刻——busy 余震门数据源（其后 500ms 内落主窗的 Esc 视为关窗手势惯性，不计数）。 */
	const escCloseWin = (): void => {
		app.lastEscCancel = 0;
		app.lastWinEscCloseAt = Date.now();
	};
	const onKey = (key: string): void => {
		const s = app.state;
		// 引导弹窗焦点锁（M4-3 T1d）：在槽期一切按键归会话——pendingUi/编辑态/busy-Esc 全部让位
		if (app.onboarding !== undefined) {
			const outcome = app.onboarding.session.handleKey(key);
			if (outcome !== undefined) {
				const ob = app.onboarding;
				app.onboarding = undefined;
				ob.resolve(outcome);
			}
			app.scheduler.requestImmediateRender();
			return;
		}
		// 弹窗聚焦期主窗快捷键不可用（走查⑤，2026-09-29 用户拍板「焦点在弹窗上 → 主界面快捷键
		// 应为不可用」）：查看/选择/询问/控件窗、诊断弹窗、斜杠菜单任一在场，主窗全局键不触发主窗
		// 功能。例外 = 弹窗自己的键：查看窗注册键（viewHasKey 让位，落窗内分发）与诊断开关
		// （Ctrl+E 在 diagOpen 期是诊断窗的关窗键）。旧铁律「模块窗期 Ctrl+E 仍走宿主全局键」随之
		// 作废（保留键注册即拒不动——模块依然不能绑这些键）；吞键静默，Esc 关弹窗后恢复。
		const popupFocused = app.pendingUi !== undefined || s.diagOpen || s.diagReturn || s.overlayOpen || s.atMenu !== undefined;
		if (key === "ctrl+t") {
			// m5-render-perf T5 护栏①（D8 定案）：生成中拒绝切换——宽度变化全量重折的尖峰削频，
			// toast 明示（设计空白 #9 文案）；冷却期连击由 setSidebar 静默吞（预检后到达的都是真实切换意图）
			if (popupFocused) return;
			if (s.busy) {
				app.showToast("生成中不能切换侧栏，回答结束后再试");
				return;
			}
			app.setSidebar(!s.sidebarVisible); // m5 T11：公共出口（设置服务共用——原内联三件套提纯）
			return;
		}
		if (key === "ctrl+e") {
			// 模块诊断弹窗总开关（T9/S6：全局拦截含输入框编辑态——与 Ctrl+T 同款；keymatch 0x05 无既有消费者）
			if (s.diagOpen || s.diagReturn) {
				// 二级开着（diagReturn 标记）= 全部关闭（原型定案）：一级、二级、返回标记一起清
				s.diagOpen = false;
				s.diagReturn = false;
				if (app.pendingUi?.kind === "view") {
					app.pendingUi = undefined;
					app.dialogs.promoteUi(); // viewText 已排队化（T2）——关掉后队列里的下一个照常提
				}
			} else {
				if (popupFocused) return; // 弹窗聚焦期不开诊断（吞——走查⑤；诊断自开关在上分支不受影响）
				const entries = app.io.diagEntries?.() ?? [];
				if (entries.length === 0) {
					app.showToast("模块全部正常——没有诊断记录"); // 空态不弹空窗（原型同款）
				} else {
					s.overlayOpen = false; // 与斜杠菜单互斥
					s.atMenu = undefined; // 与 @ 文件菜单互斥（m5-at-menu T3——两标志位独立，逐个清）
					s.diagOpen = true;
					s.diagSel = 0; // 打开时刷新（定案）：entries 每开现读
				}
			}
			app.scheduler.requestImmediateRender();
			return;
		}
		if (key === "alt+e" && !app.mouse.viewHasKey(key)) {
			if (popupFocused) return; // 弹窗期主窗折叠态不可用（走查⑤）——查看窗注册键已让位落窗内
			app.io.toggleThink();
			app.scheduler.requestImmediateRender();
			return;
		}
		if (key === "alt+o" && !app.mouse.viewHasKey(key)) {
			if (popupFocused) return;
			app.io.toggleTool();
			app.scheduler.requestImmediateRender();
			return;
		}
		if (key === "alt+f" && !app.mouse.viewHasKey(key)) {
			if (popupFocused) return;
			app.io.toggleErr();
			app.scheduler.requestImmediateRender();
			return;
		}
		if (key === "alt+s" && !app.mouse.viewHasKey(key)) {
			if (popupFocused) return; // 弹窗让位（alt+e/f/o 三连同款）
			app.io.toggleSteps();
			app.scheduler.requestImmediateRender();
			return;
		}
		if (key === "ctrl+u") {
			// Ctrl+U = steer（2026-09-23 队列批——kimi Ctrl-S 改键位，Ctrl+S 是终端 XOFF 流控冲突回避）：
			// 排队消息 + 当前草稿一起注入/提交；输入框清空（宿主把不可 steer 项留队）
			if (popupFocused) return; // 弹窗聚焦期 steer 不可用（走查⑤）
			const texts = [...app.io.queueItems(), ...(s.input.trim() !== "" ? [s.input] : [])];
			if (texts.length > 0) {
				s.input = "";
				s.cursor = 0;
				s.inputScroll = 0;
				s.selAnchor = -1;
				app.input.exitHistoryBrowse();
				app.io.requestSteer(texts);
			}
			app.scheduler.requestImmediateRender();
			return;
		}
		if (key === "alt+v") {
			if (popupFocused) return; // 弹窗聚焦期贴图不可用（走查⑤）
			app.io.requestPasteImage?.(); // F5 二轮⑬——全屏期 Alt+V 由 FullApp 接管（readline 侧已让位）
			return;
		}
		if (key === "ctrl+o") {
			// Ctrl+O = 查看压缩摘要（2026-09-23 用户拍板——/summary 命令退役，摘要查看唯一入口；
			// 无摘要时 toast 提示而非静默）
			if (popupFocused) return; // 弹窗聚焦期不叠摘要窗（走查④起，走查⑤扩到全部弹窗形态）
			app.io.showCompactionSummary?.();
			app.scheduler.requestImmediateRender();
			return;
		}
		if (key === "ctrl+h") {
			// Ctrl+H = 注入查看窗（m5-hooks T10 / D19 用户拍板展开键）：钩子注入条目列表 → 全文；
			// 主窗全局键、弹窗模态期不生效（模态铁律）；键位自  拆分而来（keymatch——遗留终端撞键走查项）
			if (popupFocused) return;
			app.io.showInjections?.();
			app.scheduler.requestImmediateRender();
			return;
		}

		// 全屏 CommandUi 挂起态（模块 choose/ask 的 overlay 化——优先于一切编辑态；
		// F5 实证：须先于 busy-Esc 判定，否则命令询问期间 Esc 被取消 turn 分支截胡、询问卡死）
		if (app.pendingUi !== undefined) {
			const pu = app.pendingUi;
			if (pu.kind === "view") {
				const closeView = (): void => {
					app.pendingUi = undefined;
					// 诊断二级的 Esc 逐级返回（T10/S5）：viewText 自身只管关——「回一级」由标记驱动重开（diagSel 原样保留）
					if (s.diagReturn) {
						s.diagReturn = false;
						if (key === "escape") s.diagOpen = true;
					}
					app.dialogs.promoteUi();
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
							// live 一秒缓存失效一拍（m5-agentview-perf T4）：run 回新文本（如折叠键切换）后，
							// 下一帧 live 必须现算——否则 1s 龄门窗口内命中旧缓存会把新文本顶回旧帧
							pu.liveCache = undefined;
							// 走查⑥（2026-09-29 用户报「折叠键按完直接置顶」）：内容替换不再滚回顶部
							// （旧「替换即置顶」是设计空白 14 为模块刷新内容定的语义，折叠切换被顶飞不合
							// 理）。学 kimi agent-activity-viewer :106-110（ctrl+o 折叠切换不动滚动）+
							// :292/:337-339（内容更新只做两件事：followTail 贴底 / scrollTop 超界才钳）：
							// 贴底窗（bottom → pinned）继续贴底；普通窗保持 scroll 仅钳到新范围——视口稳定。
							if (pu.pinned !== true) {
								const page = pu.viewPage ?? Math.max(3, app.dialogs.viewGeo(pu.layout).height - 3);
								pu.scroll = Math.max(0, Math.min(Math.max(0, pu.lines.length - page), pu.scroll));
							}
						}
					} catch (err) {
						// 全局约束 4：模块函数抛错 = 黄字提示且窗保留
						app.showToast(`弹窗按键处理出错：${err instanceof Error ? err.message : String(err)}`);
					}
					app.scheduler.requestImmediateRender();
					return;
				}
				const page = pu.viewPage ?? Math.max(3, app.dialogs.viewGeo(pu.layout).height - 3); // viewPage = 渲染期回写（dock 与渲染同源；m4-7 走查修）
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
					if (key === "escape") escCloseWin(); // enter/q 关窗不记余震——非 Esc 手势无连按惯性概念
					closeView();
				}
				app.scheduler.requestImmediateRender();
				return;
			}
			if (pu.kind === "dialog") {
				const ids = app.dialogs.dialogInteractiveIds(pu.widgets);
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
						close: () => { app.pendingUi = undefined; app.dialogs.promoteUi(); },
					};
					let consumed: boolean | void = true;
					try {
						consumed = hostKey.run(ctx);
					} catch (err) {
						app.showToast(`表单键处理出错：${err instanceof Error ? err.message : String(err)}`);
					}
					if (consumed !== false) {
						app.scheduler.requestImmediateRender();
						return; // false = 不消费——回落内建（输入框光标等）
					}
				}
				if (key === "escape") {
					escCloseWin();
					app.pendingUi = undefined;
					app.dialogs.promoteUi();
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
								app.dialogs.fireDialogEvent(pu, { type: "select", id, index: next }); // 事件三型：select
								app.dialogs.dialogFollowSel(pu);
							}
						} else if (key === "enter") {
							app.dialogs.fireDialogEvent(pu, { type: "activate", id, index: cur }); // 事件三型：activate
						}
					} else if (input !== undefined) {
						// 输入框编辑（m5 T8）：方向键归输入框移光标（决策点 15）；每键 input 事件；
						// Enter 语义：enterSubmit 缺省 = 单行提交 / 多行换行；Alt+Enter 多行恒换行
						const ed = pu.inputById[id] ?? (pu.inputById[id] = { text: "", cursor: 0 });
						const fireInput = (): void => app.dialogs.fireDialogEvent(pu, { type: "input", id, text: ed.text }); // 事件三型：input
						const submitOnEnter = input.enterSubmit ?? input.multiline !== true;
						if (key === "enter" && (submitOnEnter || input.multiline !== true)) {
							app.dialogs.fireDialogEvent(pu, { type: "activate", id }); // 单行/显式 submit：Enter 激活（无 index）
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
				app.scheduler.requestImmediateRender();
				return;
			}
			if (pu.kind === "pick") {
				// T17 宿主自定义键先行（escape 恒内建关窗）
				const pickKey = key !== "escape" && key !== "enter" ? pu.extraKeys?.[key] : undefined;
				if (pickKey !== undefined && pu.filter === undefined) { // 过滤态打字优先——自定义键只在无过滤时生效
					let consumed: boolean | void = true;
					try {
						consumed = pickKey.run({ close: () => { app.pendingUi = undefined; pu.resolve(undefined); app.dialogs.promoteUi(); } });
					} catch (err) {
						app.showToast(`列表键处理出错：${err instanceof Error ? err.message : String(err)}`);
					}
					if (consumed !== false) {
						app.scheduler.requestImmediateRender();
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
					app.scheduler.requestImmediateRender();
					return;
				}
				if (pu.filter !== undefined && pu.filter !== "" && key === "backspace") {
					pu.filter = pu.filter.slice(0, -1);
					pu.sel = 0;
					app.scheduler.requestImmediateRender();
					return;
				}
				if (key === "up" && filtered.length > 0) pu.sel = (pu.sel - 1 + filtered.length) % filtered.length;
				else if (key === "down" && filtered.length > 0) pu.sel = (pu.sel + 1) % filtered.length;
				else if (key === "pageUp" && filtered.length > 0) pu.sel = Math.max(0, pu.sel - OVERLAY_PAGE);
				else if (key === "pageDown" && filtered.length > 0) pu.sel = Math.min(filtered.length - 1, pu.sel + OVERLAY_PAGE);
				else if (key === "enter" && filtered.length > 0) {
					app.pendingUi = undefined;
					pu.resolve(filtered[pu.sel]!.i); // 按携带索引结算（CTU-08——重复项不回查错位）
					app.dialogs.promoteUi(); // 结算即提升暂存队首（批③②）
				} else if (key === "escape") {
					escCloseWin();
					app.pendingUi = undefined;
					pu.resolve(undefined);
					app.dialogs.promoteUi();
				}
				app.scheduler.requestImmediateRender();
				return;
			}
			// ask/askSecret：复用编辑器键，Enter 结算、Esc 取消；Shift+Enter 吞掉（单行问答不收换行——
			// 否则换行符悄悄进答案字符串，askSecret 里更荒诞）
			if (key === "enter") {
				const v = app.state.input;
				app.pendingUi = undefined;
				// CTU-07（2026-09-28 code review）：成功结算同样恢复接管前草稿——与 Esc 对称（答案已读出入 v，
				// 恢复无副作用；原实现清空丢弃：busy 期答完模块询问回来，正在写的草稿无声消失）
				app.state.input = pu.prev.input;
				app.state.cursor = pu.prev.cursor;
				pu.resolve(v);
				app.dialogs.promoteUi();
			} else if (key === "escape") {
				escCloseWin();
				app.pendingUi = undefined;
				pu.resolve(undefined);
				app.dialogs.promoteUi();
			} else if (key !== "shift+enter") {
				app.input.onEditKey(key);
				return;
			}
			app.scheduler.requestImmediateRender();
			return;
		}

		// 诊断一级列表态（T9）：弹窗焦点锁——↑↓ 选择（边界夹紧）、Enter 进二级（T10）、Esc 关；
		// 其余键吞掉不落编辑态。先于 busy-Esc：弹窗开着时 Esc 关弹窗、不触发「再按停止生成」
		if (s.diagOpen) {
			const entries = app.io.diagEntries?.() ?? [];
			if (key === "up") s.diagSel = Math.max(0, s.diagSel - 1);
			else if (key === "down") s.diagSel = Math.min(Math.max(0, entries.length - 1), s.diagSel + 1);
			else if (key === "escape") {
				escCloseWin();
				s.diagOpen = false;
			}
			else if (key === "enter") {
				// 二级详情（T10）：复用 viewText（翻页 + Esc 关闭——现成机制零新建）；Esc 逐级返回靠 diagReturn 标记
				const e = entries[s.diagSel];
				const text = e === undefined ? undefined : app.io.diagDetail?.(e.name);
				if (e !== undefined && text !== undefined) {
					s.diagReturn = true;
					s.diagOpen = false;
					app.viewText(`模块诊断 · ${e.name}`, text);
					return;
				}
			}
			app.scheduler.requestImmediateRender();
			return;
		}

		if (key === "escape") {
			if (s.busy && !popupFocused) {
				// 焦点在侧栏面板（Tab 切走）时 Esc 先收焦点回输入框（2026-10-01 走查——否则被双击
				// 停止确认截胡，用户预期与空闲态一致先回焦点）；收焦点同时打断双击序列（含 lastEscCancel
				// 清零——与下方空闲态收尾同款，隔了一次 Tab 导航不再算连续两按）
				if (s.focusIdx !== 0) {
					app.lastEscCancel = 0;
					s.focusIdx = 0;
					app.scheduler.requestImmediateRender();
					return;
				}
				// 关窗余震门（2026-10-04 用户实机事故：busy 期多层弹窗连按 Esc 关窗，尾部两拍落进
				// 本分支拼成「双击停止」误停生成）：刚用 Esc 关过窗的 500ms 内，后续 Esc 视为关窗
				// 手势惯性——不计数不提示。真想停：屏幕安静后再按两下（首拍照常 toast 确认）
				if (Date.now() - app.lastWinEscCloseAt < 500) {
					app.scheduler.requestImmediateRender();
					return;
				}
				// 双击 Esc 才停止生成（2026-09-23 走查拍板——单击误触痛点；qwen-code 双击窗口
				// CTRL_EXIT_PROMPT_DURATION_MS=1000ms 同口径，比 claude-code 的 2s 短）：
				// 首按 toast 提示，1s 内再按才真正取消；窗口外再按重新计首按。
				// 前置 !popupFocused（2026-10-04）：斜杠/@ 菜单在顶上时 Esc 先归菜单（下方分支关窗），
				// 不再「菜单开着按 Esc 不关窗直接喂计数器」——与 pendingUi/诊断窗（本块之前已归窗）和
				// 非 busy 路径（视觉转述分支注「Esc 优先关菜单」）统一成一条原则：Esc 先关眼前的东西
				if (Date.now() - app.lastEscCancel < 1000) {
					app.lastEscCancel = 0;
					s.toast = undefined; // 二次确认即消提示（走查拍板——toast 留着会误解为「还没停」）
					app.io.requestCancel();
					app.io.stopAllSubagents?.(); // T14 叠合定案：忙时双击 = 停生成 + 全停子代理（一次操作两件事）
				} else {
					app.lastEscCancel = Date.now();
					app.showToast("再按一次 Esc 停止生成与全部子代理");
				}
				app.scheduler.requestImmediateRender();
				return;
			}
			if (s.atMenu !== undefined) {
				// at 菜单 Esc（m5-at-menu T2）：词内多级逐级回退、根上关闭——busy/非 busy 同级
				//（2026-10-04 起 busy 不再截胡：有窗在顶 Esc 先归窗，与斜杠菜单/pendingUi 统一；
				// 旧注「busy 期 Esc 优先双击停生成，在上分支已截住」随前置 !popupFocused 作废）；
				// onAtKey 尾部自带渲染请求
				escCloseWin(); // 退级拍也记账无害——菜单还开着，后续 Esc 仍归菜单；根上关闭那拍即余震门起点
				app.at.onAtKey("escape");
				return;
			}
			if (s.overlayOpen) {
				escCloseWin(); // busy 期 Esc 归菜单关窗/退级（不再喂双击停止计数器）；关窗那拍即余震门起点，退级拍记账无害（菜单还开着，后续 Esc 仍归菜单）
				if (s.overlayCmd !== "") {
					// 中行形态退级回串尾 /（2026-10-03 前缀保留），行首形态回裸 /——与 fullapp-menu
					// onOverlayKey escape 同口径（两处 Esc 都要认中行形态）
					const inline = normCmd(s.input).startsWith("/") ? undefined : inlineSlashWord(s.input.trimEnd());
					s.overlayCmd = "";
					s.input = inline !== undefined ? s.input.slice(0, inline.start) + "/" : "/";
					s.cursor = s.input.length;
					s.overlaySel = 0;
				} else s.overlayOpen = false;
				app.scheduler.requestImmediateRender();
				return;
			}
			// 视觉转述等待期双击 Esc（走查四）：非 busy 独立态（turn 未开始）——busy 分支管不到。
			// 判定口径与 busy 双击同款；overlay 已关才轮到本分支（Esc 优先关菜单）
			if (app.io.visionTranscribing?.() === true) {
				if (Date.now() - app.lastEscCancel < 1000) {
					app.lastEscCancel = 0;
					s.toast = undefined;
					app.io.abortVisionTranscribe?.();
				} else {
					app.lastEscCancel = Date.now();
					app.showToast("再按一次 Esc 中止转述（消息不发出，重发即续）");
				}
				app.scheduler.requestImmediateRender();
				return;
			}
			// M4.5 T14：焦点在输入框且有子代理在册（跑着/排队/闪现）→ 双击 Esc 全停（1 秒窗口——
			// 与忙时停生成同款判定；判定在前不被下方 reset 冲掉；无子代理时零改动——直接回焦点）
			if (s.focusIdx === 0 && app.subagentsVisible()) {
				if (Date.now() - app.lastEscCancel < 1000) {
					app.lastEscCancel = 0;
					s.toast = undefined;
					app.io.stopAllSubagents?.();
				} else {
					app.lastEscCancel = Date.now();
					app.showToast("再按一次 Esc 停止全部子代理");
				}
				app.scheduler.requestImmediateRender();
				return;
			}
			app.lastEscCancel = 0;
			s.focusIdx = 0;
			app.scheduler.requestImmediateRender();
			return;
		}

		// @ 文件菜单态（m5-at-menu T2——与斜杠菜单分派同型位置、at 在前：两态互斥、顺序无行为差异）
		if (s.atMenu !== undefined) {
			app.at.onAtKey(key);
			return;
		}

		// 斜杠菜单 overlay 态
		if (s.overlayOpen) {
			app.menu.onOverlayKey(key);
			return;
		}

		if (key === "tab") {
			if (s.sidebarVisible) s.focusIdx = ((s.focusIdx + 1) % 3) as FocusIdx; // 面板隐藏时焦点恒输入区
		} else if (key === "shift+tab") {
			app.io.submit(app.io.panelData().permissionNext());
			return;
		} else if (key === "pageUp" || key === "pageDown") {
			// 面板聚焦时归面板（2026-09-24 拍板——翻页不再借道 Shift）：运行状态=模块翻页、任务清单=任务翻页，
			// 未聚焦才滚对话流；故此分支必须整体先于下方焦点分支
			if (s.focusIdx === 1) {
				if (s.statePage === 1) {
					// 网络·MCP 页：连接列表翻页（纯页号 ±1——渲染期夹回；server 增减不炸）
					const conns = app.io.panelData().network?.connections ?? [];
					const connPages = Math.max(1, Math.ceil(conns.length / CONN_SLOTS));
					s.connPage = Math.max(0, Math.min(connPages - 1, s.connPage + (key === "pageUp" ? -1 : 1)));
				} else {
					const mods = app.io.panelData().modules;
					s.moduleSel = Math.max(0, Math.min(mods.length - 1, s.moduleSel + (key === "pageUp" ? -MODULE_SLOTS : MODULE_SLOTS)));
				}
			} else if (s.focusIdx === 2) {
				const tasks = app.io.panelData().tasks;
				const slots = app.panels.taskPageSlots();
				s.taskSel = Math.max(0, Math.min(tasks.length - 1, s.taskSel + (key === "pageUp" ? -slots : slots)));
			} else if (key === "pageUp") {
				s.scrollBack += Math.max(1, app.io.rows() - 10);
			} else {
				s.scrollBack = Math.max(0, s.scrollBack - Math.max(1, app.io.rows() - 10));
			}
		} else if (s.focusIdx === 1) {
			const mods = app.io.panelData().modules;
			if (key === "up" || key === "down") {
				// 模块选择只在运行状态页（2026-10-01）：网络·MCP 页无选择语义——旧态 ↑↓ 隔页挪 moduleSel 属暗改
				if (s.statePage === 0) s.moduleSel = Math.max(0, Math.min(mods.length - 1, s.moduleSel + (key === "up" ? -1 : 1)));
			} else if (key === "left" || key === "right") {
				// 右上卡组翻页（m5 T6）：[运行状态, 网络·MCP, ...top 模块卡] 循环；先夹回（卡消失后页号可能越界）
				const pages = 2 + (app.io.panelData().cards ?? []).filter((c) => c.area === "top").length;
				s.statePage = (Math.min(s.statePage, pages - 1) + (key === "left" ? -1 : 1) + pages) % pages;
			} else if (key === "enter") {
				// 模块热插拔（2026-09-23 用户拍板）：锁定项 toast 锁因；可插拔项宿主写 enabled + reload；
				// 待确认项（m5 T17）：回车弹首挂确认窗（声明面人话清单→确认三动作）。
				// 只在运行状态页生效（2026-10-01）：网络·MCP 页回车不隔页热插拔看不见的模块
				if (s.statePage !== 0) return;
				const m = mods[s.moduleSel];
				if (m !== undefined) {
					if (m.state === "pendingConfirm") app.io.confirmModule?.(m.name);
					else app.io.toggleModule?.(m.name, m.locked === true ? (m.lockedReason ?? "锁定") : undefined);
				}
			}
		} else if (s.focusIdx === 2) {
			const d = app.io.panelData();
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
			app.input.onEditKey(key);
			return;
		}
		app.scheduler.requestImmediateRender();
	}

	return { onKey };
}
