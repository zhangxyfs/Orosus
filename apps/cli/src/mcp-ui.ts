import { readFileSync } from "node:fs";
import { parse as tomlParse } from "smol-toml";
import type { Harness } from "@orosus/core";
import type { CommandUi } from "@orosus/contracts/module";
import type { McpCatalogRow } from "@orosus/mcp";
import { runMcpCommand, defaultMcpCmdDeps, type McpCmdDeps } from "./mcp-cmd.ts";
import { mcpListRow, mcpDetailText } from "./mcp-settings.ts";
import { openMcpAddWindow } from "./mcp-add-window.ts";
import { registerToolLabels } from "./render.ts";
import type { FullApp, PanelNetwork } from "./tui/fullapp.ts";
import * as theme from "./theme.ts";
import { ESC_CANCELLED } from "./i18n/protocol-strings.ts";

/** m5-split-main T6：MCP 面板族自 main.ts 搬入。横切单例经本依赖对象注入（D2 签名注入）：
 *  getH——harness 单例；commandUi——行模式菜单口；activeModuleNames/closeGoneModuleUi/refreshSkillMenu/
 *  refreshPanel——reload 收尾链（模块族/技能族留守件）；getActiveApp——全屏实例访问器。 */
export type McpUiDeps = {
  getH: () => Harness;
  commandUi: CommandUi;
  activeModuleNames: () => Set<string>;
  closeGoneModuleUi: (before: Set<string>) => void;
  refreshSkillMenu: () => Promise<void>;
  refreshPanel: () => Promise<void>;
  getActiveApp: () => FullApp | undefined;
};

/** Esc 判定（面板族共用小件——设置族消费点在 main.ts 留守段，经 import 取用；设计空白 6）。 */
export const isEsc = (err: unknown): boolean => err instanceof Error && err.message === ESC_CANCELLED;

// ---------- MCP 管理面（m4-3c T17——列表四段行 / 详情六字段 / Alt + K 启停 / d 两拍删除 / Alt + N 添加窗） ----------

/** mcp.catalog 服务现取（模块未启用 = 空表——面板给指路文案）。 */
export const mcpCatalogRows = async (deps: McpUiDeps): Promise<McpCatalogRow[]> => {
	const catalog = await deps.getH().graph().services.getOptional("mcp.catalog");
	return typeof catalog === "function" ? (catalog as () => McpCatalogRow[])() : [];
};
let mcpPanelCatalog: (() => McpCatalogRow[]) | undefined; // 面板期缓存上一轮服务值（runMcpCommand 同步消费）
const mcpWarmCatalog = (deps: McpUiDeps): void => {
	void deps.getH().graph().services.getOptional("mcp.catalog").then((cat) => { mcpPanelCatalog = typeof cat === "function" ? (cat as () => McpCatalogRow[]) : undefined; }).catch(() => undefined);
};
/** 面板版命令依赖（catalog 服务现取——启停与删除共用 /mcp 命令族的写盘与守卫）。 */
const mcpPanelDeps = (): McpCmdDeps => ({ ...defaultMcpCmdDeps(), ...(mcpPanelCatalog !== undefined ? { catalogRows: mcpPanelCatalog } : {}) });

// ---------- 「网络 · MCP」卡供数（2026-10-01 拍板填实：被动真值——首连耗时/末次请求耗时，不做主动探测） ----------

/** mcp.catalog 服务行 → 卡连接行投影（五态原文照传，渲染期映射点色；说明段 = 传输型 + 工具数）。 */
export const mcpConnRows = (deps: McpUiDeps): PanelNetwork["connections"] => {
	mcpWarmCatalog(deps); // panelData 每秒 tick 现读——顺带保温服务缓存（模块未启用 = 空表）
	const rows = mcpPanelCatalog?.() ?? [];
	return rows.map((r) => ({
		name: r.name,
		state: r.state,
		desc: `${r.transport === "http" ? "HTTP" : "stdio"}${r.toolCount !== undefined ? ` · ${r.toolCount} 工具` : ""}`,
		...(r.state === "connected" && r.connectMs !== undefined ? { connectMs: r.connectMs } : {}),
	}));
};

/** 配置文件里的原表值（修改窗预填——名称锁定的真身）。 */
const configuredMcpServer = (name: string): Record<string, unknown> => {
	try {
		const p = defaultMcpCmdDeps().configPath();
		const doc = tomlParse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")) as { mcp?: { servers?: Record<string, Record<string, unknown>> } };
		return doc.mcp?.servers?.[name] ?? {};
	} catch { return {}; }
};
/** MCP 写配置后的收尾（同 afterSkillToggle 口径）：空闲重载生效、busy 缓后 toast。 */
const afterMcpWrite = (deps: McpUiDeps, app: FullApp | undefined, doneText: string): string => {
	if (app === undefined || !app.stateRef.busy) {
		void (async () => {
			try {
				const namesBefore = deps.activeModuleNames();
				await deps.getH().reload();
				deps.closeGoneModuleUi(namesBefore);
				registerToolLabels(deps.getH().graph().tools.toolInfos());
				void deps.refreshSkillMenu();
				await deps.refreshPanel();
			} catch (err) {
				(app ?? deps.getActiveApp())?.showToast(`重载失败：${err instanceof Error ? err.message : String(err)}（已写配置，可 /reload 或重启对齐）`);
			}
		})();
		return doneText;
	}
	return `${doneText} · 有任务在执行，稍后请输入 /reload 重新加载`;
};
const runMcpToggle = async (deps: McpUiDeps, app: FullApp | undefined, row: McpCatalogRow): Promise<string> => {
	// 懒 server 的「启动」语义（2026-09-30「待启动态按启停=被停用」陷阱修）：待启动/首启失败的预装件，
	// 用户按 Alt + K 的意图是「启动它」不是「停用它」——触发手动连接（mcp.start 服务；与首调共用
	// memoized 连接，schema 补丁/落盘缓存照常走）。停用路径留给已连接态与停用态翻转。
	if (row.deferred === true && (row.state === "idle" || row.state === "failed")) {
		if (app === undefined) return "";
		try {
			const start = await deps.getH().graph().services.getOptional("mcp.start");
			if (typeof start !== "function") {
				app.showToast("mcp 模块未提供启动口——重启 CLI 后再试");
				return "";
			}
			app.showToast(`正在启动 ${row.name}（首次可能需要下载，最长 60 秒）…`);
			await (start as (name: string) => Promise<void>)(row.name);
			app.showToast(`已连接 ${row.name}——工具就绪`);
		} catch (err) {
			app.showToast(`启动 ${row.name} 失败：${err instanceof Error ? err.message : String(err)}`);
		}
		return "";
	}
	const enable = row.state === "disabled";
	const r = await runMcpCommand(`${enable ? "on" : "off"} ${row.name}`, mcpPanelDeps());
	row.state = enable ? (row.source === "preload" ? "idle" : "failed") : "disabled"; // 重载前乐观翻转（重载后 catalog 重算）
	return afterMcpWrite(deps, app, r.text);
};

export const openMcpPanel = async (app: FullApp, deps: McpUiDeps): Promise<void> => {
	let selAt = 0;
	for (;;) {
		mcpWarmCatalog(deps);
		const rows = await mcpCatalogRows(deps);
		const w = app.pickRowWidth();
		const items = [
			...rows.map((r) => mcpListRow(w, r)),
			...(rows.length === 0 ? [theme.fg("muted", "（还没有 MCP server——按 Alt + N 或回车添加第一个）")] : []),
		];
		let addRequested = false;
		const picked = await app.pickOverlay(
			`MCP（${rows.length} 个 server${rows.length === 0 ? "" : " · 预装按需启动"}）`,
			items,
			selAt,
			{
				"alt+n": { label: "Alt + N 添加", run: (ctrl): boolean => { addRequested = true; ctrl.close(); return true; } },
				"alt+k": { label: "Alt + K 启停", run: (): boolean => { app.showToast("列表页拿不准选中行——回车进详情再 Alt + K"); return true; } },
			},
		);
		if (addRequested || (rows.length === 0 && picked !== undefined)) {
			mcpWarmCatalog(deps);
			const existing = (await mcpCatalogRows(deps)).map((r) => r.name);
			openMcpAddWindow(app, {
				mode: "add",
				configPath: defaultMcpCmdDeps().configPath(),
				existingNames: existing,
				onSaved: (name) => { void afterMcpWrite(deps, app, `已添加 ${name}（模块图重载中）`); },
			});
			continue; // 窗 Esc 关后循环重开列表（行集现取）
		}
		if (picked === undefined) return; // Esc → 回设置根列表
		if (picked < 0 || picked >= rows.length) continue;
		selAt = picked;
		const row = rows[picked]!;
		items[picked] = mcpListRow(w, row);
		app.viewText(`${row.name} · MCP server`, mcpDetailText(w, row), { layout: "dock", keys: mcpDetailKeys(app, row, items, picked, deps) });
	}
};

/** 详情窗键位构造（T17 主循环与 T18 菜单直达共用）：Alt + K 启停 / Alt + N 修改 / d 两拍删除。 */
const mcpDetailKeys = (app: FullApp, row: McpCatalogRow, items: string[], picked: number, deps: McpUiDeps): Record<string, import("@orosus/contracts/module").PopupKey> => {
	let deleteArm = false;
	let detailMsg = "";
	const w = app.pickRowWidth();
	const detail = (): string => (detailMsg === "" ? mcpDetailText(w, row) : `${mcpDetailText(w, row)}\n${theme.fg("muted", detailMsg)}`);
	return {
		"alt+k": {
			label: "Alt + K 启停",
			run: (): string => {
				void runMcpToggle(deps, app, row).then((t) => { if (t !== "") app.showToast(t); });
				items[picked] = mcpListRow(w, row);
				return detail();
			},
		},
		"alt+n": {
			label: "Alt + N 修改",
			run: (): string => {
				if (row.source !== "config") {
					detailMsg = row.source === "project"
						? "此 server 来自项目 .mcp.json——Orosus 不改它的来源；停用用 Alt + K（用户层覆盖）"
						: "预装 server 不可修改——只能停用（Alt + K）";
					return detail();
				}
				mcpWarmCatalog(deps);
				openMcpAddWindow(app, {
					mode: "edit",
					row,
					original: configuredMcpServer(row.name),
					configPath: defaultMcpCmdDeps().configPath(),
					existingNames: [],
					onSaved: (name) => { void afterMcpWrite(deps, app, `已修改 ${name}（模块图重载中）`); },
				});
				return detail();
			},
		},
		// d 删除只挂手写条目（2026-09-30 用户拍板「预装不允许删除」）：预装/项目行不注册 d——
		// 键位行不显示、按下走浮层默认键（不引导尝试；详情文本另有「只能停用不能删除」说明行）
		...(row.source === "config" ? {
			d: {
				label: "d 删除",
				run: (): string => {
					if (!deleteArm) {
						deleteArm = true; // 两拍制（设计空白拍板：弹窗里误按一下不该直接删配置）
						detailMsg = `再按一次 d 确认删除 ${row.name} · 按其他键取消`;
						return detail();
					}
					void runMcpCommand(`remove ${row.name}`, mcpPanelDeps()).then((r) => {
						const t = r.wrote ? afterMcpWrite(deps, app, r.text) : r.text;
						if (t !== "") app.showToast(t);
					});
					return "close";
				},
			},
		} : {}),
		t: {
			// 确认信任（2026-09-30 /mcp 命令退役后确认门的新家）：仅未确认态生效——核对指纹后按 t
			// 写 mcp-trust.json 并重载连接；其余态按下无感（键位行恒定防闪烁——标签只随未确认态显示提示）
			label: row.state === "pending-confirm" ? "t 确认" : "",
			run: (): string => {
				if (row.state !== "pending-confirm") return detail();
				void runMcpCommand(`trust ${row.name}`, mcpPanelDeps()).then((r) => {
					const t = r.wrote ? afterMcpWrite(deps, app, r.text) : r.text;
					if (t !== "") app.showToast(t);
				});
				return "close"; // 确认即收窗回列表（重载后状态翻绿）
			},
		},
	};
};

/** 行模式对等件（m4-3c T17）：列表 choose → 详情直出 → 动作菜单。 */
export const openMcpLine = async (out: (s: string) => void, deps: McpUiDeps): Promise<void> => {
	for (;;) {
		mcpWarmCatalog(deps);
		const rows = await mcpCatalogRows(deps);
		const w = 76;
		const items = [...rows.map((r) => mcpListRow(w, r)), ...(rows.length === 0 ? ["（还没有 MCP server——添加用 /mcp add 名字 命令或URL）"] : [])];
		let picked: number;
		try {
			const chosen = await deps.commandUi.choose("MCP（回车查看详情）", items);
			picked = items.indexOf(chosen);
		} catch (err) {
			if (isEsc(err)) return;
			throw err;
		}
		if (picked < 0) return;
		if (rows.length === 0 || picked >= rows.length) continue;
		const row = rows[picked]!;
		out(mcpDetailText(w, row));
		try {
			const actions = [row.state === "disabled" ? "启用（Alt + K 同款）" : "停用（Alt + K 同款）"];
			if (row.state === "pending-confirm") actions.push("确认（信任 t 键同款）");
			if (row.source === "config") actions.push("删除");
			actions.push("返回列表");
			const action = await deps.commandUi.choose(row.name, actions);
			if (action === "启用（Alt + K 同款）" || action === "停用（Alt + K 同款）") {
				out(await runMcpToggle(deps, undefined, row));
			} else if (action === "确认（信任 t 键同款）") {
				const r = await runMcpCommand(`trust ${row.name}`, mcpPanelDeps());
				out(r.wrote ? afterMcpWrite(deps, undefined, r.text) : r.text);
			} else if (action === "删除") {
				const r = await runMcpCommand(`remove ${row.name}`, mcpPanelDeps());
				out(r.wrote ? afterMcpWrite(deps, undefined, r.text) : r.text);
			}
		} catch (err) {
			if (err instanceof Error && err.message === ESC_CANCELLED) continue;
			throw err;
		}
	}
};
