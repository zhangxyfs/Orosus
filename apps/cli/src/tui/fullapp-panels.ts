/** fullapp-panels.ts（m5-split-fullapp T3）：面板行拼装族——纯搬移自 fullapp.ts 类体（侧栏宽/
 *  输入内宽/尾行/面板盒/KV 行/分隔线/模块行/连接行/运行状态页/模块卡/任务页槽/任务清单）。
 *  工厂手法：闭包持 app 实例，this.→app. 改写；族内互调改本地引用。
 *  零 app 触达的五件纯拼行函数住模块级（lint 基线纪律——consistent-function-scoping）；原方法名
 *  sep 的绑定改 sepRow（connRow 体内原有局部 const sep，避免 shadow），返回对象键仍 sep——壳零感知。
 *  非公开 API。 */

import { renderWidgets } from "./widgets.ts";
import {
	CONN_SLOTS, CONN_STATE_TEXT, elapsedText, MOD_STATE_TEXT, MODULE_SLOTS, msText, SPIN_FRAMES, taskTick,
	type ModuleCard, type PanelData,
} from "./fullapp-types.ts";
import { padToWidth, truncateToWidth, visibleWidth, wrapText } from "./width.ts";
import * as theme from "../theme.ts";
import type { FullApp } from "./fullapp.ts";

const panelBox = (title: string, en: string, focused: boolean, w: number, h: number, content: string[], hints: string[], footer?: string[], footTop?: string[]): string[] => {
	const bc = focused ? "accent" : "border";
	const inner = w - 2;
	// CTU-09（2026-09-28 code review）：顶框标题源头截断（card.title 模块供给可超长——原靠 padToWidth
	// 兜底会把右侧框角 ╮ 切掉）。预算 = w − ╭─(2) − 首尾空格(2) − 最小 fill(1) − 最小 en 段(4) ─╮(2)
	const titleFit = truncateToWidth(title, Math.max(4, w - 11));
	const titleSeg = focused ? theme.fg("accent", ` ${titleFit} `) : theme.fg("muted", ` ${titleFit} `);
	const enSeg = theme.dim(` ${en} `);
	const titleW = visibleWidth(titleSeg);
	const enBudget = Math.max(4, w - 4 - titleW - 1);
	const enFit = truncateToWidth(enSeg, enBudget);
	const fill = Math.max(1, w - 4 - titleW - visibleWidth(enFit));
	const top = theme.fg(bc, "╭─") + titleSeg + theme.fg(bc, "─".repeat(fill)) + enFit + theme.fg(bc, "─╮");
	const pane = (l: string) => theme.fg(bc, "│") + padToWidth(l, inner) + theme.fg(bc, "│"); // 内底透明（F5 二轮⑩——surface 铺色在第三方终端主题下是一块黑）
	const rows: string[] = [top, pane("")];
	for (const l of content) rows.push(pane(l));
	const footRows = footer ?? [];
	const topRows = footTop ?? [];
	// 提示行超内宽折行不截字（F5 十一轮②：窄侧栏下「Enter 挂载/卸载」曾截成「挂载/卸」）
	const hintLines = hints.flatMap((hl) => wrapText(theme.dim(" " + hl), inner));
	// 填充目标含顶框（2026-09-24 走查：原 h-2 漏算顶框 1 行——面板恒矮一行，底框比输入框高，
	// 与输入框下边缘错位）；底部分三段（同日用户拍板）：footTop 分隔线贴提示区上沿 → 操作提示 →
	// footer 注脚贴底框——填充空行恒在分隔线上方，终端再高分隔线也不与提示行脱节
	while (rows.length < h - 1 - topRows.length - footRows.length - hintLines.length) rows.push(pane(""));
	for (const l of topRows) rows.push(pane(l));
	for (const hl of hintLines) rows.push(pane(hl));
	for (const l of footRows) rows.push(pane(l));
	rows.push(theme.fg(bc, "╰" + "─".repeat(inner) + "╯"));
	return rows.slice(0, h);
};

const kvRow = (label: string, value: string, w: number): string => {
	return ` ${theme.fg("muted", padToWidth(label, 8))} ${truncateToWidth(value, w - 11)}`;
};

const sepRow = (w: number): string => {
	return theme.fg("border", " " + "┄".repeat(Math.max(1, w - 2)));
};

const modRow = (m: PanelData["modules"][number], selected: boolean, w: number): string => {
	const dot = m.state === "mounted" ? theme.fg("accent", "●") : m.state === "loading" || m.state === "pendingConfirm" ? theme.fg("warn", "◐") : theme.fg("muted", "○");
	// 锁定后缀（2026-09-23 用户拍板）：名字后灰色「· 锁定」；行尾状态位照常显示挂载态
	const lockSuffix = m.locked === true ? theme.dim(" · 锁定") : "";
	const stateText = MOD_STATE_TEXT[m.state]!;
	const st = m.state === "mounted" ? theme.fg("accent", stateText) : m.state === "loading" || m.state === "pendingConfirm" ? theme.fg("warn", stateText) : theme.dim(stateText);
	const lockW = m.locked === true ? visibleWidth(" · 锁定") : 0; // 锁定后缀占宽——desc/gap 预算要扣（防溢出）
	// CTU-09（2026-09-28 code review）：模块名源头截断（注册面供给可超长——原 padToWidth 兜底把行尾
	// 状态字切掉）。预算 = w − 前缀「 ● 」(3) − 锁定后缀 − 状态字 − 最小 gap(1)
	const nameTxt = truncateToWidth(m.name, Math.max(4, w - 3 - lockW - visibleWidth(stateText) - 1));
	const name = (m.state === "off" ? theme.fg("muted", nameTxt) : selected ? theme.fg("accent", nameTxt) : nameTxt) + lockSuffix;
	const descBudget = w - (3 + visibleWidth(nameTxt) + lockW + 1 + visibleWidth(stateText) + 1);
	const desc = descBudget >= visibleWidth(m.desc) ? theme.dim(m.desc) : descBudget >= 8 ? truncateToWidth(theme.dim(m.desc), descBudget) : "";
	const leftW = 3 + visibleWidth(nameTxt) + lockW + (desc === "" ? 0 : 1 + visibleWidth(desc));
	const gap = Math.max(1, w - leftW - visibleWidth(stateText));
	const row = ` ${dot} ${name}${desc === "" ? "" : ` ${desc}`}${" ".repeat(gap)}${st}`;
	return selected ? theme.bg("accentSoft", padToWidth(row, w)) : row;
};

/** 「网络 · MCP」卡连接行（2026-10-01）：布局同 modRow（点+名+说明+右列），无选中态/锁定后缀；
 *  五态点色对齐管理面口径——connected 绿 ● / failed·未确认 红 ● / idle·停用 灰 ○（mcp-cmd 同款）。
 *  右列：connected 有首连耗时时显耗时（被动真值），否则状态文案。 */
const connRow = (c: NonNullable<PanelData["network"]>["connections"][number], w: number): string => {
	const stateText = CONN_STATE_TEXT[c.state]!;
	const dot =
		c.state === "connected" ? theme.fg("accent", "●") : c.state === "failed" || c.state === "pending-confirm" ? theme.fg("err", "●") : theme.fg("muted", "○");
	const right =
		c.state === "connected" && c.connectMs !== undefined
			? theme.fg("muted", msText(c.connectMs))
			: c.state === "connected"
				? theme.fg("accent", stateText)
				: c.state === "failed" || c.state === "pending-confirm"
					? theme.fg("err", stateText)
					: theme.dim(stateText);
	// 名字源头截断（同 modRow CTU-09 预算式）：w − 前缀「 ● 」(3) − 右列实宽 − gap(1) − 右端呼吸(1)
	// （2026-10-01 走查「顶飞」修：名字多让 1 列，右列与边框恒 ≥1 空隙——pane padToWidth 补尾空格）
	const nameTxt = truncateToWidth(c.name, Math.max(4, w - 3 - visibleWidth(right) - 2));
	const name = c.state === "idle" || c.state === "disabled" ? theme.fg("muted", nameTxt) : nameTxt;
	// 说明段两段降级（2026-10-01 走查拍板「字体大时传输方式不显示」——预算驱动非硬阈值）：
	// 全段「stdio · 12 工具」→ 中段「12 工具」（丢传输方式）→ 空；裸传输段（无「 · 」）窄卡直接空。
	// 预算整体再让 1 列（… −1 尾）：全段「刚好吃满」时 gap 会被 max(1) 钉死→行满宽贴边框（w=48 实测）
	const descBudget = w - (3 + visibleWidth(nameTxt) + 1 + visibleWidth(right) + 1) - 1;
	const sep = c.desc.indexOf(" · ");
	const shortDesc = sep >= 0 ? c.desc.slice(sep + 3) : undefined;
	const descText =
		c.desc !== "" && descBudget >= visibleWidth(c.desc)
			? c.desc
			: shortDesc !== undefined && descBudget >= visibleWidth(shortDesc)
				? shortDesc
				: "";
	const desc = descText === "" ? "" : theme.dim(descText);
	const leftW = 3 + visibleWidth(nameTxt) + (desc === "" ? 0 : 1 + visibleWidth(descText));
	// gap 恒给右端留 1 列（2026-10-01 走查「顶飞」修：右列贴死边框观感差）；名字预算已让 1 列，闭环恒 ≤ w−1
	const gap = Math.max(1, w - leftW - visibleWidth(right) - 1);
	return ` ${dot} ${name}${desc === "" ? "" : ` ${desc}`}${" ".repeat(gap)}${right}`;
};

export function createPanels(app: FullApp) {
	const sidebarW = (): number => {
		const cols = app.io.columns();
		return cols >= 100 ? Math.min(40, Math.max(34, Math.floor(cols * 0.28))) : Math.min(40, Math.floor(cols * 0.28));
	};

	const inputInnerW = (): number => {
		return Math.max(8, app.io.columns() - sidebarW() - 2 - 4);
	};

	const tailLine = (): string => {
		const s = app.state;
		// 模块询问挂起期：spinner 让位（F5——「正在生成…」与等待输入并存误导，用户不知该答什么）
		if (app.pendingUi?.kind === "ask") return theme.fg("info", "● 等待输入——Enter 确认 · Esc 取消");
		// 交互挂起期（pick/view）spinner 同让位（2026-09-22 用户实测：/model 选择期间「正在生成…」照转——
		// 挂起 = 等用户操作，不是在生成；浮层自带操作页脚，尾行回退待命态）
		if (app.pendingUi !== undefined) return theme.dim("正在待命");
		// pick 不占尾行（F5 十七轮①：选择浮层自带完整操作页脚——流区再挂「等待选择」是复读噪音）
		if (s.busy) {
			if (s.compacting) {
				// 压缩期（2026-09-23 用户拍板）：石青（info）色专属文案——与 turn 生成的「正在生成…」区分
				return `${theme.fg("info", SPIN_FRAMES[s.spinIdx]!)} ${theme.fg("info", "上下文压缩中…")}`;
			}
			return `${theme.fg("accent", SPIN_FRAMES[s.spinIdx]!)} ${theme.fg("muted", "正在生成…")}`;
		}
		return theme.dim("正在待命");
	};

	const statusRows = (w: number, h: number): string[] => {
		const s = app.state;
		const d = app.io.panelData();
		const focused = s.focusIdx === 1;
		const inner = w - 2;
		// 右上页序数组化（m5 T6，决策点 10 area:"top" 落位）：[运行状态, 网络·MCP, ...top 模块卡（按 order）]——
		// 内建固定在前、模块卡排后（决策点 12）；页号渲染期夹回（卸载拆卡不需要通知——每秒现读自然消失）
		const topCards = (d.cards ?? []).filter((c) => c.area === "top");
		const pages = 2 + topCards.length;
		const page = Math.min(s.statePage, pages - 1);
		if (page === 0) {
			const content: string[] = [];
			content.push(kvRow("模型", theme.fg("info", d.model), inner));
			content.push(kvRow("会话", d.session, inner));
			content.push(kvRow("工作目录", theme.fg("info", d.cwd), inner));
			content.push(kvRow("运行时间", elapsedText(d.startedAt), inner)); // F5 二轮④
			content.push(kvRow("Tokens", `↑ ${d.tokens.input.toLocaleString()} · ↓ ${d.tokens.output.toLocaleString()}`, inner)); // F5 二轮⑤
			content.push(sepRow(inner));
			// 上下文占用 = 末次请求的输入规模（上下文体量口径）；占比再小也至少给一格 ▏（F5 二轮⑥——
			// 0k/1000k 时零绿块被读成「进度条坏了」）
			const usedCtx = d.tokens.input;
			const pct = d.contextWindow > 0 ? Math.min(1, usedCtx / d.contextWindow) : 0;
			const pctText = `${Math.round(usedCtx / 1000)}k/${Math.round(d.contextWindow / 1000)}k`;
			const FRACS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
			const barW = Math.max(6, inner - 8 - pctText.length - 1);
			const total = Math.max(0, Math.min(barW, Math.round(pct * barW * 8) / 8));
			const full = Math.floor(total);
			const frac = total - full;
			const fracCh = frac > 0 ? FRACS[Math.min(7, Math.ceil(frac * 8) - 1)] : usedCtx > 0 ? "▏" : "";
			content.push(
				` ${theme.fg("muted", "上下文")} ${theme.fg("accent", "█".repeat(full) + fracCh)}${theme.fg("muted", "░".repeat(Math.max(0, barW - full - (fracCh === "" ? 0 : 1))))} ${theme.fg("muted", pctText)}`,
			);
			content.push(sepRow(inner));
			const slots = MODULE_SLOTS;
			const modPages = Math.max(1, Math.ceil(d.modules.length / slots));
			const modPage = Math.min(modPages - 1, Math.floor(s.moduleSel / slots));
			const lo = modPage * slots;
			const headL = ` ${theme.fg("muted", "模块挂载")}`;
			const headR = theme.dim(`${modPage + 1}/${modPages} · MODULES`);
			content.push(headL + " ".repeat(Math.max(1, inner - visibleWidth(headL) - visibleWidth(headR))) + headR);
			for (let i = lo; i < Math.min(d.modules.length, lo + slots); i++) {
				content.push(modRow(d.modules[i]!, focused && i === s.moduleSel, inner));
			}
			return panelBox("运行状态", `1/${pages}`, focused, w, h, content, ["←→ 翻页 · PgUp/PgDn 模块翻页", "↑↓ 模块选择 · Enter 挂/卸载"], undefined, [sepRow(inner)]);
		}
		if (page === 1) {
			// 2026-10-01 拍板填实（占位行退役）：被动真值——代理态 + 模型服务信息行 + mcp.catalog 五态
			// 连接列表（首连耗时）；主动健康探测（出网/DNS 周期 ping）维持方案书「另议」缺位，不假装有数据
			const n = d.network;
			const content: string[] = [];
			if (n === undefined) {
				content.push(` ${theme.fg("muted", "（网络面数据未装配——供数退化，详见诊断日志）")}`);
			} else {
				content.push(kvRow("代理", n.proxy, inner));
				content.push(kvRow("模型服务", n.modelService, inner));
			}
			content.push(sepRow(inner));
			const conns = n?.connections ?? [];
			const connPages = Math.max(1, Math.ceil(conns.length / CONN_SLOTS));
			const connPage = Math.min(s.connPage, connPages - 1);
			const lo = connPage * CONN_SLOTS;
			const headL = ` ${theme.fg("muted", "网络 / MCP 连接")}`;
			// 右段窄卡降级（2026-10-01 走查「顶飞」修：标题+右段超内宽曾被 padToWidth 腰斩成「1/1 · SER」贴边）——
			// 余量不足先丢「· SERVERS」后缀只留页码；标题侧不截（与页 0「模块挂载」头同权重）
			const pageTag = `${connPage + 1}/${connPages}`;
			const room = inner - visibleWidth(headL) - 1;
			const headR = theme.dim(room >= visibleWidth(`${pageTag} · SERVERS`) ? `${pageTag} · SERVERS` : pageTag);
			content.push(headL + " ".repeat(Math.max(1, inner - visibleWidth(headL) - visibleWidth(headR))) + headR);
			content.push(sepRow(inner)); // 小节头与列表之间分隔线（2026-10-01 走查打回：贴太近）
			if (conns.length === 0) {
				content.push(` ${theme.fg("muted", "（无 MCP server——/settings 添加，或模块挂载页启用 mcp）")}`);
			}
			for (let i = lo; i < Math.min(conns.length, lo + CONN_SLOTS); i++) {
				content.push(connRow(conns[i]!, inner));
			}
			// 提示两行制（2026-10-01 走查打回：单行 27 列在窄侧栏被 wrapText 折行——拆两行各保短，行数恒定不闪）
			return panelBox("网络 · MCP", `2/${pages}`, focused, w, h, content, ["←→ 切卡 · Esc 返回", "PgUp/PgDn 连接翻页"], undefined, [sepRow(inner)]);
		}
		return renderModuleCard(topCards[page - 2]!, w, h, focused, page, pages);
	};

	/** 模块卡页（m5 T6）：控件清单走只读渲染器；渲染抛错 = 当帧占位行 + 日志（全局约束 4——窗/卡保留）。 */
	const renderModuleCard = (card: ModuleCard, w: number, h: number, focused: boolean, page: number, pages: number): string[] => {
		const inner = w - 2;
		let content: string[];
		try {
			content = renderWidgets(card.widgets, inner);
		} catch (err) {
			app.io.logWarn?.("tui.card.render-error", `模块卡渲染抛错，当帧占位：${card.title}`, { error: String(err instanceof Error ? err.message : err) });
			content = [` ${theme.fg("warn", "（卡片渲染出错——下帧恢复即回，见诊断日志）")}`];
		}
		return panelBox(card.title, `${page + 1}/${pages}`, focused, w, h, content, ["←→ 切卡 · Esc 返回"], undefined, [sepRow(inner)]);
	};

	// 任务清单每页行数（翻页步长 = 页大小——步长小于页大小时选中项在页内挪动页号不翻）；
	// 与 renderFrame 的 statusH/taskH 布局同口径，改布局两处同步
	const taskPageSlots = (): number => {
		const taskH = app.io.rows() - Math.max(8, Math.floor(app.io.rows() * 0.55));
		return Math.max(2, taskH - 6);
	};

	const taskRows = (w: number, h: number): string[] => {
		const s = app.state;
		const d = app.io.panelData();
		const focused = s.focusIdx === 2;
		const inner = w - 2;
		// 右下卡组（m5 T6）：[任务清单（内建在前）, ...bottom 模块卡（按 order）]；单卡（无模块卡）时页码隐藏
		const bottomCards = (d.cards ?? []).filter((c) => c.area === "bottom");
		const pages = 1 + bottomCards.length;
		const page = Math.min(s.taskPage, pages - 1);
		if (page > 0) return renderModuleCard(bottomCards[page - 1]!, w, h, focused, page, pages);
		const done = d.tasks.filter((t) => t.state === "done").length;
		const slots = taskPageSlots();
		const itemPages = Math.max(1, Math.ceil(d.tasks.length / slots));
		const itemPage = Math.min(itemPages - 1, Math.floor(s.taskSel / slots));
		const lo = itemPage * slots;
		const content: string[] = [];
		for (let i = lo; i < Math.min(d.tasks.length, lo + slots); i++) {
			const t = d.tasks[i]!;
			const text =
				t.state === "done"
					? `\x1b[9m${theme.fg("muted", t.text)}\x1b[29m`
					: t.state === "active"
						? theme.fg("warn", t.text)
						: theme.fg("fg", t.text);
			const row = ` ${taskTick(t.state)} ${truncateToWidth(text, inner - 4)}`;
			content.push(focused && i === s.taskSel ? theme.bg("accentSoft", padToWidth(row, inner - 1)) : row);
		}
		const footL = theme.dim(" 由 Agent 实时同步");
		const pageTag = itemPages > 1 ? ` · 第 ${itemPage + 1}/${itemPages} 页` : ""; // 任务条目分页并进注脚（页码位让给卡组）
		const footR = theme.dim(`任务数：${done}/${d.tasks.length}${pageTag}`);
		const footer = [footL + " ".repeat(Math.max(1, inner - visibleWidth(footL) - visibleWidth(footR))) + footR];
		return panelBox("任务清单", pages > 1 ? `1/${pages}` : "", focused, w, h, content, pages > 1 ? ["←→ 切卡 · PgUp/PgDn 任务翻页 · Esc 返回"] : ["PgUp/PgDn 翻页 · Esc 返回"], footer, [sepRow(inner)]);
	};

	return { sidebarW, inputInnerW, tailLine, panelBox, kvRow, sep: sepRow, modRow, connRow, statusRows, renderModuleCard, taskPageSlots, taskRows };
}
