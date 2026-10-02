import type { Harness } from "@orosus/core";
import type { CommandUi } from "@orosus/contracts/module";
import type { PanelData, FullApp } from "./tui/fullapp.ts";
import { ctxUsageText, diskUsageText, runtimeStatusText, tokenUsageText } from "./usage-text.ts";
import { modelSlotList, moduleConfigFileFor, subagentConfigFile } from "./config-face.ts";
import { runSubagentApprovalSetting, runSubagentMaxTurnsSetting, runSubagentModelSetting } from "./subagent-settings.ts";
import { runVisionSetting } from "./vision-media.ts";
import { openSkillsLine, openSkillsPanel, type SkillUiDeps } from "./skills-ui.ts";
import { isEsc, openMcpLine, openMcpPanel, type McpUiDeps } from "./mcp-ui.ts";

/** m5-split-main T8：设置面板族自 main.ts 搬入。横切单例经本依赖对象注入（D2）：getH/commandUi
 *  直取；getPanelCache——panelCache（T9 留守状态）访问器；reloadModulesIdle——T9 留守共用件；
 *  skillDeps/mcpDeps——技能与 MCP 面板入口的既有依赖对象（对面族自管）。 */
export type SettingsUiDeps = {
  getH: () => Harness;
  commandUi: CommandUi;
  getPanelCache: () => PanelData | undefined;
  reloadModulesIdle: (app: FullApp | undefined, busyToast: string) => string;
  skillDeps: SkillUiDeps;
  mcpDeps: McpUiDeps;
};

/** /settings 二级菜单五项（SW-18 定案——/other 改名 /settings，别名 /config；前四项渲染原四子项面板，
 *  第五项「配置网络搜索」进 tool-web__settings 三级配置流。数据源 = harness 读口 h.usage()/h.status()）。 */
const SETTINGS_ITEMS = [
	"磁盘占用（各目录大小与清理口径）",
	"上下文用量（窗口占用与输入输出累计）",
	"Token 用量（本会话与项目累计）",
	"运行状态（模型 / 会话 / 模块图）",
	"子代理（模型 / 审批模式 / 轮数上限）",
	"技能（查看 / 启停——四轨目录全部技能）",
	"MCP（查看 / 开关 / 删除——server 管理与添加）",
	"配置视觉模型（停用 / 自动 / 指定——给非多模态模型提供视觉）",
	"配置网络搜索（LLM Web Search / Tavily / Brave）",
];
/** 第五项 = 调 web 模块自有命令（模块命令 + host 挂菜单的 approval__permission 先例）；空串 = 静默成功/取消（notice 承担反馈）。 */
const runSearchSettings = async (h: Harness): Promise<string> => ((await h.prompt("/tool-web__settings")) ?? "").trim();

export const openSettingsPanel = async (app: FullApp, deps: SettingsUiDeps): Promise<void> => {
	// 子菜单/子窗 Esc 返回根列表（2026-09-28 用户拍板「子菜单 Esc 返回上一级」）：根列表本身的 Esc = 收面。
	// 只读子窗走 /tasks 同款 FIFO——viewText 占槽期循环重入的 pickOverlay 排队，关窗即自动顶上回根列表
	for (;;) {
		const picked = await app.pickOverlay("设置", SETTINGS_ITEMS);
		if (picked === undefined) return; // 根列表 Esc：整面收起
		// 五个只读子窗一律 dock（2026-09-28 用户走查打回 m5 T2 的居中长相：贴输入框上缘——技能详情窗同款）
		if (picked === 0) app.viewText("磁盘占用", diskUsageText(), { layout: "dock" });
		else if (picked === 1) app.viewText("上下文用量", ctxUsageText(deps.getPanelCache()), { layout: "dock" });
		else if (picked === 2) app.viewText("Token 用量", await tokenUsageText(deps.getH()), { layout: "dock" });
		else if (picked === 3) app.viewText("运行状态", runtimeStatusText(deps.getH()), { layout: "dock" });
		else if (picked === 4) {
			// M4.5 T12：子代理分组项 → 两子项（决策 7/23）——模型复用 /model 两段选换数据源、审批三档中文名。
			// 子菜单循环：子项内的 Esc 回子菜单（配置未写零副作用），子菜单的 Esc 回设置根列表
			for (;;) {
				const sub = await app.pickOverlay("子代理", ["子代理模型", "审批模式", "轮数上限"]);
				if (sub === undefined) break; // Esc → 回设置根列表
				const chooseVia = async (t: string, items: string[]): Promise<string> => {
					const i = await app.pickOverlay(t, items);
					if (i === undefined) throw new Error("已取消（Esc）");
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
						const res = await runSubagentMaxTurnsSetting(chooseVia, (t) => app.promptInput(t, false).then((v) => { if (v === undefined) throw new Error("已取消（Esc）"); return v; }), subagentConfigFile());
						if (res !== "") app.showToast(res);
					}
				} catch (err) {
					if (isEsc(err)) continue; // 子项内 Esc → 回子菜单
					throw err;
				}
			}
		}
		else if (picked === 5) await openSkillsPanel(app, deps.skillDeps); // 技能面板自身管列表↔详情逐级返回；其根列表 Esc = 退出面板 → 回设置根列表
		else if (picked === 6) await openMcpPanel(app, deps.mcpDeps); // MCP 管理面（m4-3c T17）：面板自身管逐级返回
		else if (picked === 7) {
			// F14 视觉模型：chooseVia 内取消（Esc）= 整支放弃回设置根列表
			try {
				const res = await runVisionSetting(
					async (t, items) => { const i = await app.pickOverlay(t, items); if (i === undefined) throw new Error("已取消（Esc）"); return items[i] ?? ""; },
					() => moduleConfigFileFor("tool-media", deps.getH()),
				);
				// 写盘即自动重载（空闲）；busy（消息接收中）不 reload 只提示——reloadModulesIdle 共用件
				if (res.wrote) {
					const busyNote = deps.reloadModulesIdle(app, "有任务在执行，稍后 /reload 生效");
					app.showToast(busyNote === "" ? `${res.message}，已重载生效` : `${res.message}——${busyNote}`);
				} else app.showToast(res.message);
			} catch (err) {
				if (isEsc(err)) continue;
				throw err;
			}
		}
		else if (picked === 8) {
			// 顶层后端菜单的 Esc → 回设置根列表（更深的 Esc 已在 tool-web 模块内逐级返回）
			try {
				const res = await runSearchSettings(deps.getH());
				if (res !== "") app.viewText("配置网络搜索", res, { layout: "dock" }); // 成功路径走 notice/toast 静默约定——非空输出才落面板
			} catch (err) {
				if (isEsc(err)) continue;
				throw err;
			}
		}
	}
};
/** 行模式对等件（2026-09-24 T1c：/other 时代行模式只有指路——配置流两态都要能走，菜单随之对等）：
 *  同一五项经 commandUi.choose（readline）；面板文本直出（out = processReplLine 的输出通道参数）。 */
export const openSettingsLine = async (out: (s: string) => void, deps: SettingsUiDeps): Promise<void> => {
	// Esc 逐级返回（2026-09-28 用户拍板，全屏对等件）：根菜单 Esc 穿透（宿主静默）；子级 Esc 回上级
	for (;;) {
		const picked = await deps.commandUi.choose("设置", SETTINGS_ITEMS); // 根 Esc 穿透——整面收起
		const idx = SETTINGS_ITEMS.indexOf(picked);
		if (idx === 0) out(diskUsageText());
		else if (idx === 1) out(ctxUsageText(deps.getPanelCache()));
		else if (idx === 2) out(await tokenUsageText(deps.getH()));
		else if (idx === 3) out(runtimeStatusText(deps.getH()));
		else if (idx === 4) {
			// M4.5 T12 行模式对等件：子代理分组（模型 / 审批模式 / 轮数上限）——子级 Esc 回子菜单，子菜单 Esc 回根
			for (;;) {
				let subIdx: string;
				try {
					subIdx = await deps.commandUi.choose("子代理", ["子代理模型", "审批模式", "轮数上限"]);
				} catch (err) {
					if (isEsc(err)) break; // Esc → 回设置根菜单
					throw err;
				}
				try {
					if (subIdx === "子代理模型") {
						const res = await runSubagentModelSetting((t, items) => deps.commandUi.choose(t, items), subagentConfigFile(), modelSlotList(deps.getH()));
						if (res !== "") out(res);
					} else if (subIdx === "审批模式") {
						const res = await runSubagentApprovalSetting((t, items) => deps.commandUi.choose(t, items), subagentConfigFile());
						if (res !== "") out(res);
					} else if (subIdx === "轮数上限") {
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
		else if (idx === 6) await openMcpLine(out, deps.mcpDeps);
		else if (idx === 7) {
			try {
				const res = await runVisionSetting(async (t, items) => deps.commandUi.choose(t, items), () => moduleConfigFileFor("tool-media", deps.getH()));
				// 写盘即自动重载——行模式 /settings busy 期排队到 turn 结束，此处必然空闲（共用件口径）
				if (res.wrote) { deps.reloadModulesIdle(undefined, ""); out(`${res.message}，已重载生效`); }
				else out(res.message);
			} catch (err) {
				if (isEsc(err)) continue; // Esc → 回设置根菜单
				throw err;
			}
		}
		else if (idx === 8) {
			try {
				const res = await runSearchSettings(deps.getH());
				if (res !== "") out(res);
			} catch (err) {
				if (isEsc(err)) continue; // 顶层后端菜单 Esc → 回设置根菜单（更深的已在模块内逐级返回）
				throw err;
			}
		}
	}
};
