import type { Harness } from "@orosus/core";
import type { CommandUi } from "@orosus/contracts/module";
import type { LocaleStore } from "./i18n/store.ts";
import { runLocaleSetting } from "./i18n/switch.ts";
import type { PanelData, FullApp } from "./tui/fullapp.ts";
import { ctxUsageText, diskUsageText, runtimeStatusText, tokenUsageText } from "./usage-text.ts";
import { modelSlotList, moduleConfigFileFor, subagentConfigFile } from "./config-face.ts";
import { runSubagentApprovalSetting, runSubagentMaxTurnsSetting, runSubagentModelSetting } from "./subagent-settings.ts";
import { runUpdateCheckSetting, updateConfigFile } from "./update-settings.ts";
import { memoryImportResultText, mirrorImportResultText, runMemoryImportChoose, runMemorySetting, type MemoryImportDeps } from "./peers-settings.ts";
import { runVisionSetting } from "./vision-media.ts";
import { openSkillsLine, openSkillsPanel, type SkillUiDeps } from "./skills-ui.ts";
import { openHooksLine, openHooksPanel, type HooksUiDeps } from "./hooks-ui.ts";
import { isEsc, openMcpLine, openMcpPanel, type McpUiDeps } from "./mcp-ui.ts";
import { ESC_CANCELLED } from "./i18n/protocol-strings.ts";
import { t } from "./i18n/app.ts";

/** m5-split-main T8：设置面板族自 main.ts 搬入。横切单例经本依赖对象注入（D2）：getH/commandUi
 *  直取；getPanelCache——panelCache（T9 留守状态）访问器；reloadModulesIdle——T9 留守共用件；
 *  skillDeps/mcpDeps——技能与 MCP 面板入口的既有依赖对象（对面族自管）。 */
export type SettingsUiDeps = {
  getH: () => Harness;
  commandUi: CommandUi;
  getPanelCache: () => PanelData | undefined;
  reloadModulesIdle: (app: FullApp | undefined, busyToast: string) => string;
  skillDeps: SkillUiDeps;
  hooksDeps: HooksUiDeps;
  mcpDeps: McpUiDeps;
  /** m5-peers 走查修订三：「记忆导入」数据口（= 引导第 5 页同功能——importers 件宿主接线）。 */
  peersImport: MemoryImportDeps;
  /** m5-i18n T3：语言 store（「切换语言」行——列表/当前语 ✓/切换同 /locale）。 */
  localeStore: LocaleStore;
  /** 切换完成回执（toast 文案）：full = repaint + notify；行模式 = out。 */
  localeApplied: (toast: string) => void;
};

/** /settings 根列表（SW-18 定案——/other 改名 /settings，别名 /config）。2026-10-08 用户拍板序位：
 *  … 钩子 → MCP → 记忆（动态项，插此）→ 切换语言 → 更新检查 → 配置视觉模型 → 配置网络搜索——
 *  记忆/语言/更新三项连座紧随 MCP，视觉/搜索两工具配置殿后。数据源 = harness 读口 h.usage()/h.status()。 */
export const settingsItemsBase = (): string[] => [
  t("settings.items.disk"),
  t("settings.items.ctx"),
  t("settings.items.tokens"),
  t("settings.items.runtime"),
  t("settings.items.subagent"),
  t("settings.items.skills"),
  t("settings.items.hooks"),
  t("settings.items.mcp"),
  t("settings.items.locale"),
  t("settings.items.update"),
  t("settings.items.vision"),
  t("settings.items.search"),
];
/** 第五项 = 调 web 模块自有命令（模块命令 + host 挂菜单的 approval__permission 先例）；空串 = 静默成功/取消（notice 承担反馈）。 */
const runSearchSettings = async (h: Harness): Promise<string> => ((await h.prompt("/tool-web__settings")) ?? "").trim();

/** 走查八-② + 走查九 + 走查十二：导入执行段——进度弹窗（dock 贴输入框上缘）：进度条 + 当前条目活值，
 *  **进度前置**（每条开始处理时先报——条先动再跑数据）；**禁 Esc** + **Alt+C 停止并关窗**（走查十二-②④：
 *  硬中断——剩余条目不拷不落盘）；**完成自动关窗**（走查十二-①——结果走 toast，无需手动 Enter）。
 *  m5-peers-import-fix T6：mode 透传（"all" = 镜像各归各桶——G12 结果串）。 */
const runImportWithProgress = async (app: FullApp, deps: MemoryImportDeps, ids: string[], organize: boolean, mode: "current" | "all"): Promise<void> => {
	let done = 0;
	let label = "";
	let stopped = false;
	const ac = new AbortController();
	// 进度条 max 是静态数（控件契约）——开窗前先按源计数定总步数；实际步数以 onProgress 为准（max 只画条）
	const total = deps.detect().filter(s => ids.includes(s.id)).reduce((n, s) => n + s.count, 0);
	const statusText = (): string => {
		if (done === 0) return t("settings.import.reading");
		return organize
			? t("settings.import.organizing", { label, done, total })
			: t("settings.import.running", { done, total });
	};
	const handle = app.openDialogHost({
		title: t("settings.import.title"),
		layout: "dock",
		disallowEscape: true,   // 进行态禁 Esc（防误关丢进度感）——完成自动关、强停走 Alt+C
		widgets: [
			{ id: "status", kind: "text", text: statusText },
			{ id: "bar", kind: "progress", value: () => done, max: Math.max(1, total) },
		],
		hostKeys: {
			"alt+c": {
				label: t("settings.import.stopKey"),
				run: () => {
					if (!ac.signal.aborted) {
						stopped = true;
						ac.abort();   // 硬中断（走查十二-④）：剩余条目不拷不落盘
					}
					handle?.close();   // 立即关窗——已入库部分走完成 toast 报数
					return true;
				},
			},
			// 窗内无 interactive 控件 → activate 事件永不触发（走查十-②）；Enter 恒吞掉
			// （不消费会落回输入框当发送）；完成态窗已自动关，此处仅防御性兜底
			"enter": {
				label: "",
				run: () => {
					if (stopped) handle?.close();
					return true;
				},
			},
		},
	});
	const r = await deps.run(ids, organize, mode, (d, _t, title) => {
		done = d; label = title;   // 前置进度：条目开始时即推（进度条先动）
		app.scheduler.requestImmediateRender();
	}, ac.signal);
	handle?.close();   // 完成自动关窗（走查十二-①）——结果数字走 toast
	const resultText = mode === "all" && r.mirror !== undefined
		? mirrorImportResultText({ imported: r.imported, skipped: r.skipped, mirror: r.mirror })
		: memoryImportResultText(r);
	app.showToast(`${stopped ? `${t("settings.import.stopped")} ` : ""}${resultText}`, 6000);
};

/** D14（m5-peers T6b）：settings 面动态条目——tool-peers 模块 active（启用）时插「记忆」于 MCP 后
 *  （2026-10-08 用户拍板：MCP → 记忆 → 切换语言 → 更新检查 连座——原尾行追加形态退役）；未启用/卸载
 *  即从列表消失、后续项上移一位。静态数组保留导出（hooks-ui.test 序位锚等外部消费兼容）。
 *  模块启停本身走 config enabled（通用模块启停 UI 顺延，D15 注记）——这里只看运行态。 */
export const settingsItems = (h: Harness): string[] => {
  const peersActive = h.graph().audit().some((a) => a.name === "tool-peers" && a.state === "active");
  if (!peersActive) return settingsItemsBase();
  const base = settingsItemsBase();
  const at = base.indexOf(t("settings.items.locale")); // 插在切换语言前 = MCP 后（连座首邻）
  return [...base.slice(0, at), t("settings.items.memory"), ...base.slice(at)];
};

export const openSettingsPanel = async (app: FullApp, deps: SettingsUiDeps): Promise<void> => {
	// 子菜单/子窗 Esc 返回根列表（2026-09-28 用户拍板「子菜单 Esc 返回上一级」）：根列表本身的 Esc = 收面。
	// 只读子窗走 /tasks 同款 FIFO——viewText 占槽期循环重入的 pickOverlay 排队，关窗即自动顶上回根列表
	for (;;) {
		const items = settingsItems(deps.getH());
		// settings 高窗（2026-10-08 用户拍板）：根列表页大小随终端高动态 [10,20]（pickPageOf——13 项常规终端一屏尽览）
		const picked = await app.pickOverlay(t("settings.title"), items, 0, undefined, { tall: true });
		if (picked === undefined) return; // 根列表 Esc：整面收起
		// 8+ 索引现算（2026-10-08 序位重排后记忆动态项插 MCP 后——位序随 peers 启停漂移，不落硬编码；0-7 恒稳定）
		const at = (key: string): number => items.indexOf(t(key));
		// 五个只读子窗一律 dock（2026-09-28 用户走查打回 m5 T2 的居中长相：贴输入框上缘——技能详情窗同款）
		if (picked === 0) app.viewText(t("settings.title.disk"), diskUsageText(), { layout: "dock" });
		else if (picked === 1) app.viewText(t("settings.title.ctx"), ctxUsageText(deps.getPanelCache()), { layout: "dock" });
		else if (picked === 2) app.viewText(t("settings.title.tokens"), await tokenUsageText(deps.getH()), { layout: "dock" });
		else if (picked === 3) app.viewText(t("settings.title.runtime"), runtimeStatusText(deps.getH()), { layout: "dock" });
		else if (picked === 4) {
			// M4.5 T12：子代理分组项 → 两子项（决策 7/23）——模型复用 /model 两段选换数据源、审批三档中文名。
			// 子菜单循环：子项内的 Esc 回子菜单（配置未写零副作用），子菜单的 Esc 回设置根列表
			for (;;) {
				const sub = await app.pickOverlay(t("settings.title.subagent"), [t("settings.subagent.model"), t("settings.subagent.approval"), t("settings.subagent.maxTurns")]);
				if (sub === undefined) break; // Esc → 回设置根列表
				const chooseVia = async (t: string, items: string[]): Promise<string> => {
					const i = await app.pickOverlay(t, items);
					if (i === undefined) throw new Error(ESC_CANCELLED);
					return items[i] ?? "";
				};
				try {
					if (sub === 0) {
						const res = await runSubagentModelSetting(chooseVia, subagentConfigFile(), modelSlotList(deps.getH()));
						if (res !== "") app.showToast(res);
					} else if (sub === 1) {
						const res = await runSubagentApprovalSetting(chooseVia, subagentConfigFile());
						if (res !== "") app.showToast(res);
					} else if (sub === 2) {
						const res = await runSubagentMaxTurnsSetting(chooseVia, (t) => app.promptInput(t, false).then((v) => { if (v === undefined) throw new Error(ESC_CANCELLED); return v; }), subagentConfigFile());
						if (res !== "") app.showToast(res);
					}
				} catch (err) {
					if (isEsc(err)) continue; // 子项内 Esc → 回子菜单
					throw err;
				}
			}
		}
		else if (picked === 5) await openSkillsPanel(app, deps.skillDeps); // 技能面板自身管列表↔详情逐级返回；其根列表 Esc = 退出面板 → 回设置根列表
		else if (picked === 6) await openHooksPanel(app, deps.hooksDeps); // m5-hooks T10：钩子面板自管（用户拍板不设 /hooks 命令）
		else if (picked === 7) await openMcpPanel(app, deps.mcpDeps); // MCP 管理面（m4-3c T17）：面板自身管逐级返回
		else if (picked === at("settings.items.vision")) {
			// F14 视觉模型：chooseVia 内取消（Esc）= 整支放弃回设置根列表
			try {
				const res = await runVisionSetting(
					async (t, items) => { const i = await app.pickOverlay(t, items); if (i === undefined) throw new Error(ESC_CANCELLED); return items[i] ?? ""; },
					() => moduleConfigFileFor("tool-media", deps.getH()),
				);
				// 写盘即自动重载（空闲）；busy（消息接收中）不 reload 只提示——reloadModulesIdle 共用件
				if (res.wrote) {
					const busyNote = deps.reloadModulesIdle(app, t("settings.busyNote"));
					app.showToast(busyNote === "" ? t("settings.reloadedNote", { message: res.message }) : `${res.message}——${busyNote}`);
				} else app.showToast(res.message);
			} catch (err) {
				if (isEsc(err)) continue;
				throw err;
			}
		}
		else if (picked === at("settings.items.search")) {
			// 顶层后端菜单的 Esc → 回设置根列表（更深的 Esc 已在 tool-web 模块内逐级返回）
			try {
				const res = await runSearchSettings(deps.getH());
				if (res !== "") app.viewText(t("settings.title.search"), res, { layout: "dock" }); // 成功路径走 notice/toast 静默约定——非空输出才落面板
			} catch (err) {
				if (isEsc(err)) continue;
				throw err;
			}
		}
		else if (picked === at("settings.items.locale")) {
			// m5-i18n T3：「切换语言」行——与 /locale 命令同源；Esc 静默回设置根列表（不落盘）
			try {
				const toast = await runLocaleSetting(
					async (t, items) => {
						const i = await app.pickOverlay(t, items);
						if (i === undefined) throw new Error(ESC_CANCELLED);
						return items[i] ?? "";
					},
					{ getH: deps.getH, store: deps.localeStore },
				);
				if (toast !== undefined) deps.localeApplied(toast);
			} catch (err) {
				if (isEsc(err)) continue;
				throw err;
			}
		}
      else if (picked === at("settings.items.update")) {
        // m5-update-check T5：「更新检查」开关——只管自动检测（写 [update] check；下次启动生效）
        try {
          const res = await runUpdateCheckSetting(async (title, items) => {
            const i = await app.pickOverlay(title, items);
            if (i === undefined) throw new Error(ESC_CANCELLED);
            return items[i] ?? "";
          }, updateConfigFile());
          if (res !== "") app.showToast(res);
        } catch (err) {
          if (isEsc(err)) continue;
          throw err;
        }
      }
      else if (picked === at("settings.items.memory")) {
        // m5-peers T6b + 走查修订三：「记忆」动态项——双开关 + 记忆导入（浏览窗不走设置入口：
        // /tool-peers__memory 命令 + Ctrl+P 总览两处，走查修订二）
        // 子菜单循环：切换后列表现读刷新（✓ 移位）；子菜单 Esc → 回设置根列表
			for (;;) {
				try {
					const res = await runMemorySetting(async (t, list) => {
						const i = await app.pickOverlay(t, list);
						return i === undefined ? "" : list[i] ?? "";
					});
					if (res === undefined) break; // Esc / 未匹配 → 回设置根列表
					if (res.kind === "import") {
						// 走查八：导入两段——选择段（开关形态菜单）+ 执行段（进度弹窗——dock 贴输入框，
						// progress/text 活值 getter 每步重绘；Esc 关窗不中断导入，完成 toast 收尾）
						const picked = await runMemoryImportChoose(async (t, list) => {
							const i = await app.pickOverlay(t, list);
							return i === undefined ? "" : list[i] ?? "";
						}, deps.peersImport);
						if (picked === "empty") { app.showToast(t("settings.import.emptyFull")); continue; }
						if (picked === undefined) continue;   // Esc 回子菜单
						await runImportWithProgress(app, deps.peersImport, picked.ids, picked.organize, picked.mode);
						continue;
					}
					// 写盘即自动重载（空闲）；busy 不 reload 只提示——reloadModulesIdle 共用件（D15）
					const busyNote = deps.reloadModulesIdle(app, t("settings.busyNote"));
					app.showToast(busyNote === "" ? t("settings.reloadedNote", { message: res.message }) : `${res.message}——${busyNote}`);
				} catch (err) {
					if (isEsc(err)) break;
					throw err;
				}
			}
		}
	}
};
/** 行模式对等件（2026-09-24 T1c：/other 时代行模式只有指路——配置流两态都要能走，菜单随之对等）：
 *  同一五项经 commandUi.choose（readline）；面板文本直出（out = processReplLine 的输出通道参数）。 */
export const openSettingsLine = async (out: (s: string) => void, deps: SettingsUiDeps): Promise<void> => {
	// Esc 逐级返回（2026-09-28 用户拍板，全屏对等件）：根菜单 Esc 穿透（宿主静默）；子级 Esc 回上级
	for (;;) {
		const items = settingsItems(deps.getH());
		const picked = await deps.commandUi.choose(t("settings.title"), items); // 根 Esc 穿透——整面收起
		const idx = items.indexOf(picked);
		if (idx === -1) return;
		// 8+ 索引现算（全屏对等件——记忆动态项插 MCP 后，位序随 peers 启停漂移）
		const at = (key: string): number => items.indexOf(t(key));
		if (idx === 0) out(diskUsageText());
		else if (idx === 1) out(ctxUsageText(deps.getPanelCache()));
		else if (idx === 2) out(await tokenUsageText(deps.getH()));
		else if (idx === 3) out(runtimeStatusText(deps.getH()));
		else if (idx === 4) {
			// M4.5 T12 行模式对等件：子代理分组（模型 / 审批模式 / 轮数上限）——子级 Esc 回子菜单，子菜单 Esc 回根
			for (;;) {
				let subIdx: string;
				try {
					subIdx = await deps.commandUi.choose(t("settings.title.subagent"), [t("settings.subagent.model"), t("settings.subagent.approval"), t("settings.subagent.maxTurns")]);
				} catch (err) {
					if (isEsc(err)) break; // Esc → 回设置根菜单
					throw err;
				}
				try {
					if (subIdx === t("settings.subagent.model")) {
						const res = await runSubagentModelSetting((t, items) => deps.commandUi.choose(t, items), subagentConfigFile(), modelSlotList(deps.getH()));
						if (res !== "") out(res);
					} else if (subIdx === t("settings.subagent.approval")) {
						const res = await runSubagentApprovalSetting((t, items) => deps.commandUi.choose(t, items), subagentConfigFile());
						if (res !== "") out(res);
					} else if (subIdx === t("settings.subagent.maxTurns")) {
						const res = await runSubagentMaxTurnsSetting((t, items) => deps.commandUi.choose(t, items), (t) => deps.commandUi.ask(t), subagentConfigFile());
						if (res !== "") out(res);
					}
				} catch (err) {
					if (isEsc(err)) continue; // 子项内 Esc → 回子菜单
					throw err;
				}
			}
		}
		else if (idx === 5) await openSkillsLine(out, deps.skillDeps);
		else if (idx === 6) await openHooksLine(out, deps.hooksDeps); // m5-hooks T10 行模式对等件
		else if (idx === 7) await openMcpLine(out, deps.mcpDeps);
		else if (idx === at("settings.items.vision")) {
			try {
				const res = await runVisionSetting(async (t, items) => deps.commandUi.choose(t, items), () => moduleConfigFileFor("tool-media", deps.getH()));
				// 写盘即自动重载——行模式 /settings busy 期排队到 turn 结束，此处必然空闲（共用件口径）
				if (res.wrote) { deps.reloadModulesIdle(undefined, ""); out(t("settings.reloadedNote", { message: res.message })); }
				else out(res.message);
			} catch (err) {
				if (isEsc(err)) continue; // Esc → 回设置根菜单
				throw err;
			}
		}
		else if (idx === at("settings.items.search")) {
			try {
				const res = await runSearchSettings(deps.getH());
				if (res !== "") out(res);
			} catch (err) {
				if (isEsc(err)) continue; // 顶层后端菜单 Esc → 回设置根菜单（更深的已在模块内逐级返回）
				throw err;
			}
		}
		else if (idx === at("settings.items.locale")) {
			// m5-i18n T3 行模式对等件：「切换语言」——与 /locale 同源；Esc 静默回设置根菜单
			try {
				const toast = await runLocaleSetting((t, items) => deps.commandUi.choose(t, items), { getH: deps.getH, store: deps.localeStore });
				if (toast !== undefined) deps.localeApplied(toast);
			} catch (err) {
				if (isEsc(err)) continue;
				throw err;
			}
		}
      else if (idx === at("settings.items.update")) {
        // m5-update-check T5 行模式对等件：「更新检查」开关——Esc 静默回设置根菜单
        try {
          const res = await runUpdateCheckSetting((title, items) => deps.commandUi.choose(title, items), updateConfigFile());
          if (res !== "") out(res);
        } catch (err) {
          if (isEsc(err)) continue;
          throw err;
        }
      }
      else if (idx === at("settings.items.memory")) {
        // m5-peers T6b + 走查修订三 行模式对等件：「记忆」双开关 + 记忆导入——子菜单 Esc 回设置根菜单
			for (;;) {
				try {
					const res = await runMemorySetting(async (t, list) => {
						try { return await deps.commandUi.choose(t, list); } catch { return ""; }   // 子菜单 Esc → 空串 = 未匹配
					});
					if (res === undefined) break;
					if (res.kind === "import") {
						// 行模式对等件（走查八）：选择段同款；执行段无弹窗——完成串直出（进度条能力面留全屏）
						const picked = await runMemoryImportChoose(async (t, list) => {
							try { return await deps.commandUi.choose(t, list); } catch { return ""; }
						}, deps.peersImport);
						if (picked === "empty") { out(t("settings.import.emptyLine")); continue; }
						if (picked === undefined) continue;
						out(picked.organize ? t("settings.import.lineOrganize") : t("settings.import.lineRunning"));
						const lr = await deps.peersImport.run(picked.ids, picked.organize, picked.mode);
						out(picked.mode === "all" && lr.mirror !== undefined
							? mirrorImportResultText({ imported: lr.imported, skipped: lr.skipped, mirror: lr.mirror })
							: memoryImportResultText(lr));
						continue;
					}
					// 行模式 /settings busy 期排队到 turn 结束，走到这里必然空闲（共用件口径）
					const busyNote = deps.reloadModulesIdle(undefined, "");
					out(busyNote === "" ? t("settings.reloadedNote", { message: res.message }) : `${res.message}——${busyNote}`);
				} catch (err) {
					if (isEsc(err)) break;
					throw err;
				}
			}
		}
	}
};
