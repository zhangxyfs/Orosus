/** fullapp-overlay.ts（m5-split-fullapp T10）：浮层构建族——纯搬移自 fullapp.ts 类体
 *  （查看窗/控件窗/pick 选择框/诊断列表/斜杠菜单总装五件）。依赖 resolvePopupLayout（经
 *  dialogs.viewGeo）与 widgets 渲染件；this.→app. 机械改写 15 处。非公开 API。 */

import { diagListLines, DIAG_LIST_ROWS, OVERLAY_PAGE, syncSwitchRow, thumbGeometry, type HostDialogKeys, type PickExtraKeys, type SlashItem, type SwitchRow } from "./fullapp-types.ts";
import { filterEntries, type AtEntry } from "./fullapp-at.ts";
import { padToWidth, truncateToWidth, visibleWidth, wrapText } from "./width.ts";
import { renderWidgetLines } from "./widgets.ts";
import { pickLabel } from "../picker.ts";
import type { PopupKey, PopupLayout, WidgetSpec } from "@orosus/contracts/module";
import type { OverlayFrame } from "./fullscreen.ts";
import * as theme from "../theme.ts";
import type { FullApp } from "./fullapp.ts";
import { t } from "../i18n/app.ts";

/** 模块 choose 的 overlay 选择框（全屏 CommandUi 适配面——与斜杠菜单同族：全宽/青玉框/分页/「还有 N 项」）。
 *  零 app 触达住模块级（lint 纪律）。
 *  m5-ask-multi（ext 传入 = chooseEx 增强面）：行域 = 过滤项 + 「其他」+「✓ 确定」两合成行（走查修后
 *  单选/多选同构）——合成行不参与过滤（D8）；多选 ☐/accent■、单选 ○/accent●（走查修：☑ 观感大一圈
 *  被否换实心方），已标记项文字同染 accent；标题尾拼「（可多选）」（D14，仅 multi）；输入态在提示行上插
 *  自行输入行。ext 缺省 = 老 choose 面逐字节原样。 */
export interface PickOverlayExt {
	multi?: boolean;
	custom?: boolean;
	editing?: boolean;
	customText?: string;
	customCommitted?: string;
	checked?: number[];
	/** 内容窗高（settings 高窗 2026-10-08）：frame 层按 pickPageOf(divRow, tall) 现算注入；缺省 OVERLAY_PAGE。 */
	page?: number;
	/** 底部横选行（2026-10-09 用户拍板：/model 选模型同窗选思考档）：传 pu.switchRow 活引用——渲染期
	 *  syncSwitchRow 兜底同步（viewPage 同款回写纪律），键路漏调/过滤改选中也能落位。 */
	switchRow?: SwitchRow;
}

/** pick 浮层页大小（settings 高窗 2026-10-08 用户拍板）：tall 面按输入框上缘可用高动态取
 *  [OVERLAY_PAGE, 20]——预算 = divRow − 6（顶框 + 空行 + 提示行 + 底框 4 恒定行，再留上下
 *  余量两行的上界；增强面输入行不入预算——row 钳 0 兜底）；其余面恒 OVERLAY_PAGE。
 *  渲染（frame 注入 ext.page）/ 翻页步长（keys）/ 鼠标点击（pickHitRow）三口共源——漂移即
 *  点击错行或步长与视口不符。每帧现算，resize 即生效。 */
export const pickPageOf = (divRow: number, tall: boolean | undefined): number =>
	tall === true ? Math.max(OVERLAY_PAGE, Math.min(20, divRow - 6)) : OVERLAY_PAGE;

/** pick 浮层行域视口几何（渲染与鼠标点击共源——两处口径漂移即点击错行）。
 *  rowsTotal 含合成行（其他〔+确定〕）；totalLines = 顶框 + 空行 + moreUp? + 内容窗 + moreDown? +
 *  输入行（editing）+ 提示行 + 底框——与 buildPickOverlay 的 olines 结构一一对齐。
 *  page（settings 高窗 2026-10-08）：内容窗高——缺省 OVERLAY_PAGE（老 choose 面逐字节原样）。 */
export function pickOverlayGeo(rowsTotal: number, sel: number, editing: boolean, page: number = OVERLAY_PAGE): { selI: number; winStart: number; winLen: number; moreUp: boolean; moreDown: boolean; totalLines: number } {
	const selI = Math.max(0, Math.min(rowsTotal - 1, sel));
	const winStart = Math.max(0, Math.min(Math.max(0, rowsTotal - page), selI - page + 1));
	const winLen = Math.min(page, rowsTotal - winStart);
	const moreUp = winStart > 0;
	const moreDown = rowsTotal - winStart - winLen > 0;
	return { selI, winStart, winLen, moreUp, moreDown, totalLines: 4 + (moreUp ? 1 : 0) + winLen + (moreDown ? 1 : 0) + (editing ? 1 : 0) };
}

const buildPickOverlay = (leftW: number, divRow: number, title: string, items: string[], sel: number, filter?: string, extraKeys?: PickExtraKeys, ext?: PickOverlayExt): OverlayFrame => {
	const ow = leftW;
	const oInner = ow - 2;
	const bc = "accent";
	const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
	const multi = ext?.multi === true;
	const custom = ext?.custom === true;
	// 多行项压平单行（2026-09-24 走查实锤前案——/provider「名称\n（URL）」双行项：裸 \n 进 overlay 行，
	// padToWidth 计宽与合成全乱 → 上下移动大概率残影黑带+||；行模式 choose 同款压平 menu.ts:46）
	// pairs 携带原始索引（CTU-08——multi 勾选标记按索引判，重复文本项按值回查必错位）
	const pairs = items.map((raw) => raw.replace(/\s*\n\s*/g, " ")).map((text, i) => ({ t: text, i }));
	const shown = filter === undefined ? pairs : pairs.filter((x) => x.t.toLowerCase().includes(filter.toLowerCase()));
	const checked = ext?.checked;
	const otherAt = custom ? shown.length : -1;
	const confirmAt = custom ? shown.length + 1 : -1; // 走查修：确定行单选/多选同构（恒两合成行）
	const rowsTotal = shown.length + (custom ? 2 : 0);
	// 标记字形（走查修 2026-10-08）：多选 ☐/accent■（☑ 观感大一圈被否）、单选 ○/accent●；
	// 已标记项文字同染 accent（pickLabel current 口——标题青玉、说明仍灰）
	const markOf = (on: boolean): string => (on ? theme.fg("accent", multi ? "■" : "●") : multi ? "☐" : "○");
	const rowText = (gi: number): string => {
		if (gi === otherAt) { // 其他行：✎ 前缀（自有——三家 Other 行都无图标）；已提交 = 实心标 + accent 文本（D3 单槽）
			const committed = ext?.customCommitted;
			return `${markOf(committed !== undefined)} ✎ ${committed !== undefined ? theme.fg("accent", truncateToWidth(committed, Math.max(4, oInner - 6))) : t("pick.other.label")}`;
		}
		if (gi === confirmAt) return theme.fg("accent", `✓ ${t("pick.multi.confirm")}`); // D16 提交口
		const on = checked !== undefined && checked.includes(shown[gi]!.i);
		return `${markOf(on)} ${pickLabel(shown[gi]!.t, { current: on })}`;
	};
	const olines: string[] = [];
	const filterSeg = filter === undefined ? "" : ` ${filter === "" ? "" : t("pick.filterTag", { filter })} ${shown.length}/${items.length} `;
	// CTU-09（2026-09-28 code review）：标题源头截断（choose 标题模块供给可超长——原靠 padToWidth 兜底
	// 切掉右框角；预算扣除过滤段实测宽）；multi 标题尾拼「（可多选）」（D14——opencode 同款导引）
	const titleSeg = theme.fg("accent", ` ${truncateToWidth(multi ? `${title}${t("pick.multi.titleSuffix")}` : title, Math.max(4, ow - 7 - visibleWidth(theme.dim(filterSeg))))} `);
	const topFill = Math.max(1, ow - 4 - visibleWidth(titleSeg) - visibleWidth(theme.dim(filterSeg)));
	olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + titleSeg + theme.fg(bc, "─".repeat(topFill)) + theme.dim(filterSeg) + theme.fg(bc, "─╮")));
	olines.push(boxRow(""));
	const { selI, winStart, winLen, moreUp, moreDown } = pickOverlayGeo(rowsTotal, sel, ext?.editing === true, ext?.page);
	if (moreUp) olines.push(boxRow(theme.dim(`   ${t("pick.moreUp", { n: winStart })}`)));
	for (let i = 0; i < winLen; i++) {
		const gi = winStart + i;
		// 两段式渲染（2026-09-28 用户拍板：子界面与斜杠主菜单同形——标题白/说明灰；「 ✓」当前值项
		// 标题青玉 + 说明仍灰。说明拆分三形态见 pickLabel；已带 ANSI 的行（技能/任务列表）原样）
		const row = ` ${gi === selI ? theme.fg("accent", "❯") : " "} ${rowText(gi)}`;
		olines.push(gi === selI ? boxRow(theme.bg("accentSoft", padToWidth(row, oInner - 1))) : boxRow(row));
	}
	if (moreDown) olines.push(boxRow(theme.dim(`   ${t("pick.moreDown", { n: rowsTotal - winStart - winLen })}`)));
	// 底部横选行（2026-10-09 用户拍板：kimi 形态 Orosus 样式）：标签白 fg（modeRow 同规——恒白不被值抢权），
	// 候选值全列横排双空格隔（用户拍板 2026-10-09 二轮「不可能横向放不下，就横着放」——档位名恒短，
	// 不做窗口/省略）——选中 [v] accent、未选中 fg；两侧 ‹ › 箭头 dim（多值才显）。候选按高亮项取
	//（valuesOf；undefined/空 = 该项无档——「——」dim 降级，peers 模式行同款形）；渲染期 syncSwitchRow
	// 兜底（viewPage 回写同款——键路漏调/过滤重置选中后此处落位）。插在列表与提示行之间；行级
	// truncateToWidth 仅极端窄终端兜底。
	if (ext?.switchRow !== undefined) {
		const item = shown[selI]?.t;
		syncSwitchRow(ext.switchRow, item);
		const vals = item !== undefined ? ext.switchRow.valuesOf(item) : undefined;
		const idx = ext.switchRow.switchIdx;
		const labelSeg = theme.fg("fg", ` ${ext.switchRow.label}`);
		const seg = vals === undefined || vals.length === 0
			? theme.dim(" ——")
			: `${vals.length > 1 ? theme.dim(" ‹") : ""}  ${vals.map((v, i) => (i === idx ? theme.fg("accent", `[${v}]`) : theme.fg("fg", v))).join("  ")}  ${vals.length > 1 ? theme.dim("› ") : ""}`;
		olines.push(boxRow(truncateToWidth(labelSeg + seg, oInner)));
	}
	const extraLabels = extraKeys === undefined ? "" : Object.values(extraKeys).map((k) => k.label).join(" · ");
	// 输入态（m5-ask-multi）：提示行上插自行输入行（草稿直显）；键导引换输入态版——不写「Esc 取消」
	// 防误导（输入态 Esc 实为返回列表，非取消整窗）
	if (ext?.editing === true) olines.push(boxRow(` ${t("pick.custom.input")}${ext.customText ?? ""}`));
	const footCore = ext?.editing === true
		? t("pick.custom.foot")
		: custom
			? t("pick.multi.foot") // 走查修：两态同键（措辞中性「选定」）；普通项 Enter=标记、仅确定行 Enter=提交
			: (filter === undefined ? t("pick.foot.noFilter") : t("pick.foot.filter"));
	// 横选面键导引（2026-10-09）：foot 追加「←→ 切换档位」——恒显（高亮项无候选时 ←→ 无操作，导引不撒谎的
	// 口径按 modeRow 同规：行本身已用 —— 表达无档态）
	const switchHint = ext?.switchRow !== undefined ? t("pick.switch.foot") : "";
	olines.push(boxRow(theme.dim(` ${footCore}${switchHint !== "" ? ` · ${switchHint}` : ""}${extraLabels !== "" ? ` · ${extraLabels}` : ""}${t("pick.foot.esc")}`)));
	olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(oInner) + "╯")));
	return { lines: olines, row: Math.max(0, divRow - olines.length), col: 0, width: ow };
}


/** @ 文件菜单浮层（m5-at-menu T3——buildPickOverlay 同款住模块级、零 app 触达）。框线/选中/
 *  恒定行数/余量合一行/源头截断全按 buildOverlay 同款纪律；miss = 目录不存在（数据源 readdirSync
 *  失败——空态文案三则的分判依据，设计空白 2）。dir/sel/filter 从 state 词快照读——渲染不追光标
 *  现算（光标挪走后菜单内容静止，kimi 同款）。 */
const buildAtOverlay = (leftW: number, divRow: number, dir: string, entries: AtEntry[], sel: number, filter: string, miss?: boolean): OverlayFrame => {
	const ow = leftW;
	const oInner = ow - 2;
	const bc = "accent";
	const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
	const shown = filterEntries(entries, filter);
	const rows: AtEntry[] = shown.length > 0
		? shown
		: [{ name: theme.dim(miss === true ? t("at.emptyMiss") : entries.length === 0 ? t("at.emptyDir") : t("at.noMatch")), dir: false }]; // 空态三则（设计空白 2）
	const olines: string[] = [];
	// 计数段（设计空白 4）：过滤时 pick overlay filter 段同款形态；平时目录/文件分计
	const dirs = entries.filter((e) => e.dir).length;
	const en = theme.dim(filter !== "" ? ` ${t("pick.filterTag", { filter })} ${shown.length}/${entries.length} ` : ` ${t("at.counts", { dirs, files: entries.length - dirs })} `);
	// 标题（设计空白 4）：根 = @ 文件、子目录 = @ src/tui/；CTU-09 源头截断（dir 是用户输入可超长）
	const titleText = dir === "" ? t("at.titleRoot") : t("at.titleSub", { dir });
	const title = theme.fg("accent", truncateToWidth(titleText, Math.max(4, ow - 7 - visibleWidth(en))));
	const topFill = Math.max(1, ow - 4 - visibleWidth(title) - visibleWidth(en));
	olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + title + theme.fg(bc, "─".repeat(topFill)) + en + theme.fg(bc, "─╮")));
	const selI = Math.max(0, Math.min(rows.length - 1, sel));
	const winStart = Math.max(0, Math.min(Math.max(0, rows.length - OVERLAY_PAGE), selI - OVERLAY_PAGE + 1));
	const win = rows.slice(winStart, winStart + OVERLAY_PAGE);
	for (let i = 0; i < OVERLAY_PAGE; i++) {
		const it = win[i];
		if (it === undefined) {
			olines.push(boxRow("")); // 恒定行数防闪烁（斜杠同款纪律）
			continue;
		}
		const gi = winStart + i;
		const selPrefix = gi === selI ? theme.fg("accent", "❯") : " ";
		const row = ` ${selPrefix} ${it.dir ? theme.fg("accent", `${it.name}/`) : it.name}`; // 目录行名/ accent、文件行默认色
		olines.push(gi === selI ? boxRow(theme.bg("accentSoft", padToWidth(row, oInner - 1))) : boxRow(row));
	}
	const rest = rows.length - winStart - win.length;
	const hints = [winStart > 0 ? t("pick.moreUp", { n: winStart }) : "", rest > 0 ? t("pick.moreDown", { n: rest }) : ""].filter(Boolean).join(" · ");
	olines.push(boxRow(hints === "" ? "" : theme.dim(`   ${hints}`)));
		olines.push(boxRow(theme.dim(` ${t("at.foot")}`))); // 设计空白 3
	olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(oInner) + "╯")));
	return { lines: olines, row: Math.max(0, divRow - olines.length), col: 0, width: ow };
}

export function createOverlay(app: FullApp) {
	/** 只读文本浮层（F5 二轮⑪ / m5 T2 新几何）：resolvePopupLayout 居中弹窗（缺省 center80；五旧窗随之
	 *  统一新长相）。恒定行数防闪烁（斜杠菜单同款纪律）：顶框 + 内容页（高 − 3）+ 余量提示行 + 底框，
	 *  余量并进提示行不再条件性增删行；自定义键的 label 附在提示行尾。 */
	const buildViewOverlay = (pu: { title: string; lines: string[]; scroll: number; pinned?: boolean; layout?: PopupLayout | "dock"; keys?: Record<string, PopupKey>; viewPage?: number }, leftW?: number, divRow?: number): OverlayFrame => {
		// dock（m4-7 走查修 2026-09-27 用户拍板）：贴输入框上缘 + 与输入框（左栏）同宽——技能详情窗形态，
		// 内容自适应封顶可滚（高度 = min(内容行数, 输入框上方可用高)）；不走 resolvePopupLayout 居中几何
		const dock = pu.layout === "dock" && leftW !== undefined && divRow !== undefined;
		const geo = dock
			? { row: 0, col: 0, width: leftW, height: Math.max(6, Math.min(pu.lines.length + 3, divRow)) }
			: app.dialogs.viewGeo(pu.layout === "dock" ? undefined : pu.layout);
		const ow = geo.width;
		const oInner = ow - 2;
		const bc = "accent";
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
		const olines: string[] = [];
		// CTU-09（2026-09-28 code review）：标题源头截断（模块供给可超长——原靠 padToWidth 兜底切掉右框角；
		// 预算 = ow − ╭─(2) − 首尾空格(2) ─╮(2) − 最小 fill(1)）
		const titleSeg = theme.fg("accent", ` ${truncateToWidth(pu.title, Math.max(4, ow - 7))} `);
		const topFill = Math.max(1, ow - 4 - visibleWidth(titleSeg));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + titleSeg + theme.fg(bc, "─".repeat(topFill)) + theme.fg(bc, "─╮")));
		const page = Math.max(3, geo.height - 3);
		pu.viewPage = page; // 渲染期回写——翻页/滚轮页大小与窗几何同源（dock 不走 viewGeo，m4-7 走查修）
		const maxScroll = Math.max(0, pu.lines.length - page);
		const sc = pu.pinned === true ? maxScroll : Math.max(0, Math.min(maxScroll, pu.scroll)); // pinned = 每帧钳到末页（T1 贴底跟随）
		const win = pu.lines.slice(sc, sc + page);
		// 恒满屏（2026-10-01 走查①拍板「不论内容填不填满都得满屏」）：full 布局内容行补空行到 page——
		// 盒高恒 geo.height，短内容不再抱内容贴终端顶（子代理详情窗短内容半屏盒即此症；斜杠菜单 17 行
		// 定高同族纪律）。dock（技能详情窗，内容自适应封顶）与 center80（既有弹窗视觉契约）不动。
		if (pu.layout === "full") while (win.length < page) win.push("");
		// 选区反白合入（T8）：行索引与 pointToView 同源（sc + 行号——滚动平移天然稳定）；
		// 滚动条（T10）：右缘 1 列轨道/拇指覆盖在内容最右列上
		const vthumb = thumbGeometry(page, pu.lines.length, sc);
		for (let i = 0; i < win.length; i++) {
			// 前导空格算进截断预算（oInner−3）：满宽文字 + 前导空格恰占满内容区——与主窗
			// 212e891「截断与 pad 同目标」恒宽口径一致（原截 oInner−2 靠 padToWidth 转截断兜底）
			const raw = " " + truncateToWidth(win[i]!, oInner - 3);
			const styled = app.select.styleDocSelection("view", sc + i, raw);
			if (vthumb !== undefined) {
				const onThumb = i >= vthumb.top && i < vthumb.top + vthumb.height;
				// 轨道格 = 深底空格、拇指 = █（2026-09-27 用户走查二轮：dim │ 细竖线字形上下有留缝、
				// 渲染成虚线，与右侧 1 列的 accent 边框虚线交叠成锯齿——「画歪了」实锤。bg 块与 █
				// 同为满格实心字形，虚线观感消除；主窗轨道是末列无邻线故无此症，不改）
				const bar = onThumb
					? theme.paint(app.state.scrollbarHover === "view" ? "accent" : "muted", "surface2", "█")
					: theme.bg("surface", " ");
				// 文字与轨道间空 1 列；各段显式带底色（theme.bg 收尾 49m 清外层底色——整行单包会漏）
				olines.push(
					theme.bg("surface2", theme.fg(bc, "│") + padToWidth(styled, oInner - 2)) +
					theme.bg("surface2", " ") + bar + theme.bg("surface2", theme.fg(bc, "│")),
				);
			} else {
				olines.push(boxRow(styled));
			}
		}
		const upN = sc;
		const downN = pu.lines.length - sc - win.length;
		const more = [upN > 0 ? t("diag.more.up", { n: upN }) : "", downN > 0 ? t("diag.more.down", { n: downN }) : ""].filter(Boolean).join(" · ");
		const keyHints = pu.keys === undefined ? "" : Object.values(pu.keys).map((k) => k.label).join(" · ");
		const hint = ` ${more}${more !== "" ? " · " : ""}${t("view.foot.page")}${keyHints !== "" ? ` · ${keyHints}` : ""}${t("view.foot.esc")}`;
		olines.push(boxRow(theme.dim(hint)));
		olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(oInner) + "╯")));
		return { lines: olines, row: dock && divRow !== undefined ? Math.max(0, divRow - olines.length) : geo.row, col: dock ? 0 : geo.col, width: ow };
	}

	/** 控件窗体（m5 T7①）：几何走 T1 resolvePopupLayout（不另算）；内容行走只读渲染器
	 *  （交互列表带选中标记与焦点高亮）；恒定行数防闪烁（余量并进提示行——view 窗同款纪律）。 */
	const buildDialogOverlay = (pu: { title: string; widgets: WidgetSpec[]; scroll: number; layout?: PopupLayout | "dock"; focusedId?: string | undefined; selById: Record<string, number>; inputById: Record<string, { text: string; cursor: number }>; hostKeys?: HostDialogKeys; disallowEscape?: boolean }, leftW?: number, divRow?: number): OverlayFrame => {
		// dock（T17 原型走查拍板：窗体与输入框同宽、贴输入框上缘）——几何同 buildViewOverlay dock 分支；
		// 高度按内容自适应封顶（控件行数预渲染一次取长）
		const dock = pu.layout === "dock" && leftW !== undefined && divRow !== undefined;
		let contentLen = 3;
		if (dock) {
			try {
				contentLen = renderWidgetLines(pu.widgets, Math.max(20, leftW - 2), { selById: pu.selById, inputById: pu.inputById, ...(pu.focusedId !== undefined ? { focusedId: pu.focusedId } : {}) }).lines.length;
			} catch { /* 预渲染失败走保底高度——正式渲染的 try/catch 会给占位行 */ }
		}
		const geo = dock
			? { row: 0, col: 0, width: leftW, height: Math.max(6, Math.min(contentLen + 3, divRow)) }
			: app.dialogs.viewGeo(pu.layout);
		const ow = geo.width;
		const inner = ow - 2;
		const bc = "accent";
		// 先截断再补齐（2026-09-30 实机走查：控件行超宽时 padToWidth 只补不切——右边框被顶出去，
		// 终端软换行把底线推歪 = 「左右竖线不直」的根因；截断口径与其余四窗「源头截断」同族）
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(truncateToWidth(l, inner), inner) + theme.fg(bc, "│"));
		const olines: string[] = [];
		// CTU-09（2026-09-28 code review）：标题源头截断（spec.title 模块供给可超长——原靠 padToWidth 兜底
		// 切掉右框角；预算 = ow − ╭─(2) − 首尾空格(2) ─╮(2) − 最小 fill(1)）
		const titleSeg = theme.fg("accent", ` ${truncateToWidth(pu.title, Math.max(4, ow - 7))} `);
		const topFill = Math.max(1, ow - 4 - visibleWidth(titleSeg));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + titleSeg + theme.fg(bc, "─".repeat(topFill)) + theme.fg(bc, "─╮")));
		const page = Math.max(3, geo.height - 3);
		let content: string[];
		try {
			content = renderWidgetLines(pu.widgets, inner, { selById: pu.selById, inputById: pu.inputById, ...(pu.focusedId !== undefined ? { focusedId: pu.focusedId } : {}) }).lines;
		} catch (err) {
			app.io.logWarn?.("tui.dialog.render-error", `控件窗渲染抛错：${pu.title}`, { error: String(err instanceof Error ? err.message : err) }); // i18n:diag 诊断面不翻
			content = [` ${theme.fg("warn", t("dialog.widgetError"))}`];
		}
		const maxScroll = Math.max(0, content.length - page);
		const sc = Math.max(0, Math.min(maxScroll, pu.scroll));
		const win = content.slice(sc, sc + page);
		// 走查七-②：滚动条（view 窗 T10 同款——右缘 1 列轨道/拇指覆盖在内容最右列；不超一屏不显示）
		const vthumb = thumbGeometry(page, content.length, sc);
		for (let i = 0; i < win.length; i++) {
			if (vthumb === undefined) {
				olines.push(boxRow(win[i] ?? ""));
				continue;
			}
			const onThumb = i >= vthumb.top && i < vthumb.top + vthumb.height;
			const bar = onThumb
				? theme.paint("muted", "surface2", "█")
				: theme.bg("surface", " ");
			olines.push(
				theme.bg("surface2",
					theme.fg(bc, "│") + padToWidth(truncateToWidth(win[i] ?? "", inner - 2), inner - 2)
					+ theme.bg("surface2", " ") + bar + theme.fg(bc, "│")),
			);
		}
		const upN = sc;
		const downN = content.length - sc - win.length;
		const more = [upN > 0 ? t("diag.more.up", { n: upN }) : "", downN > 0 ? t("diag.more.down", { n: downN }) : ""].filter(Boolean).join(" · ");
		// 键位行（2026-09-30 实机走查重排）：宿主自定义键的标签过滤空串（同键多绑只标一次——空标签混进
		// join 出「· ·」断片）；有自定义键 = 窗自带完整键表（Enter/Esc 内建兜底），不再拼通用「↑↓ 选择 ·
		// Tab 换焦点」表单窗用不上的段；无自定义键维持原通用句。
		// 禁 Esc 窗（走查十-①：键位行说「Esc 关闭」但 Esc 实际被吞 = 红框误导）：内建尾巴整段不拼——
		// 键表全部由 hostKeys 标签自带（如「Alt + C 停止 · Enter 关闭」），窗内无 interactive 控件时
		// 「Enter 激活 · Esc 关闭」两句都是空头支票
		const hostLabels = pu.hostKeys === undefined ? "" : [...new Set(Object.values(pu.hostKeys).map((k) => k.label).filter((l) => l !== ""))].join(" · ");
		const builtinTail = pu.disallowEscape === true ? "" : t("dialog.foot.builtin");
		const hint = pu.disallowEscape === true
			? ` ${more}${more !== "" && hostLabels !== "" ? " · " : ""}${hostLabels}`
			: pu.hostKeys === undefined
				? ` ${more}${more !== "" ? " · " : ""}${t("dialog.foot.generic")}`
				: ` ${more}${more !== "" ? " · " : ""}${hostLabels}${hostLabels !== "" ? " · " : ""}${builtinTail}`;
		olines.push(boxRow(theme.dim(hint)));
		olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(inner) + "╯")));
		return { lines: olines, row: dock && divRow !== undefined ? Math.max(0, divRow - olines.length) : geo.row, col: dock ? 0 : geo.col, width: ow };
	}

	/** 模块诊断一级列表浮层（T9，原型一级）：赭石标题 + 恒 8 行列表 + 余量提示 + 键提示行（浮层高度恒定防闪烁）。 */
	const buildDiagOverlay = (leftW: number, divRow: number): OverlayFrame => {
		const s = app.state;
		const entries = app.io.diagEntries?.() ?? [];
		const ow = leftW;
		const oInner = ow - 2;
		const bc = "accent";
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
		const olines: string[] = [];
		const en = theme.dim(` ${t("diag.en", { n: entries.length })} `);
		// CTU-09（2026-09-28 code review）：标题源头截断（本窗标题为内建定长——窄终端下 en 段挤爆顶框时的
		// 防线，与其余四窗拼行点同式；预算扣除 en 段实测宽）
		const title = theme.fg("err", truncateToWidth(` ${t("diag.title")} `, Math.max(4, ow - 7 - visibleWidth(en))));
		const topFill = Math.max(1, ow - 4 - visibleWidth(title) - visibleWidth(en));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + title + theme.fg(bc, "─".repeat(topFill)) + en + theme.fg(bc, "─╮")));
		const selI = Math.max(0, Math.min(entries.length - 1, s.diagSel));
		const { lines, selRow } = diagListLines(entries, selI, oInner - 1);
		for (let i = 0; i < DIAG_LIST_ROWS + 1; i++) {
			// 选中行青玉软底（斜杠菜单同款）；余量行（第 9 行）不参与高亮
			olines.push(i === selRow ? boxRow(theme.bg("accentSoft", padToWidth(lines[i] ?? "", oInner - 1))) : boxRow(lines[i] ?? ""));
		}
		olines.push(theme.bg("surface2", theme.fg(bc, "├" + "─".repeat(oInner) + "┤")));
		olines.push(boxRow(theme.dim(` ${t("diag.foot")}`)));
		olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(oInner) + "╯")));
		return { lines: olines, row: Math.max(0, divRow - olines.length), col: 0, width: ow };
	}

	/** 模块总览启动器浮层（m5-peers T6e，A-1 极简版 D24）：buildDiagOverlay 同族几何——通栏左列宽、
	 *  底贴输入框上缘、surface2+accent 框、右上计数徽标、恒定列表行数防闪、底行键导引。 */
	const LAUNCHER_LIST_ROWS = 6;
	const buildLauncherOverlay = (leftW: number, divRow: number): OverlayFrame => {
		const s = app.state;
		const entries = app.io.launcherEntries?.() ?? [];
		const ow = leftW;
		const oInner = ow - 2;
		const bc = "accent";
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
		const olines: string[] = [];
		const en = theme.dim(` ${t("launcher.en", { n: entries.length })} `);
		const title = theme.fg("info", truncateToWidth(` ${t("launcher.title")} `, Math.max(4, ow - 7 - visibleWidth(en))));
		const topFill = Math.max(1, ow - 4 - visibleWidth(title) - visibleWidth(en));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + title + theme.fg(bc, "─".repeat(topFill)) + en + theme.fg(bc, "─╮")));
		const selI = Math.max(0, Math.min(entries.length - 1, s.launcherSel));
		for (let i = 0; i < LAUNCHER_LIST_ROWS + 1; i++) {
			const e = entries[i];
			// labelKey 翻译（2026-10-07 走查）：声明方自报键 → t 回落声明原值；无键保底原样
			const lab = e !== undefined && e.labelKey !== undefined ? t(e.labelKey, undefined, e.label) : e?.label;
			const row = e === undefined ? "" : ` ${lab}${e.command !== undefined ? theme.dim(` —— ${e.command}`) : ""}`;
			olines.push(i === selI ? boxRow(theme.bg("accentSoft", padToWidth(row, oInner - 1))) : boxRow(row));   // 选中行青玉软底（diag 同款）
		}
		olines.push(theme.bg("surface2", theme.fg(bc, "├" + "─".repeat(oInner) + "┤")));
		olines.push(boxRow(theme.dim(` ${t("launcher.foot")}`)));
		olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(oInner) + "╯")));
		return { lines: olines, row: Math.max(0, divRow - olines.length), col: 0, width: ow };
	};

	const buildOverlay = (leftW: number, divRow: number): OverlayFrame => {		const s = app.state;
		const level2 = s.overlayCmd !== "";
		const ap = app.menu.argPhase();
		const ow = leftW;
		const oInner = ow - 2;
		const bc = "accent";
		const boxRow = (l: string) => theme.bg("surface2", theme.fg(bc, "│") + padToWidth(l, oInner) + theme.fg(bc, "│"));
		const olines: string[] = [];
		const skillCount = ap === undefined && !level2 ? app.menu.filteredSkills().length : 0;
		const en = theme.dim(ap !== undefined ? ` ${t("menu.en.arg", { n: ap.items.length })} ` : level2 ? ` ${t("menu.en.level2")} ` : ` ${t("menu.en.cmds", { n: app.input.filteredCommands().length })}${skillCount > 0 ? t("menu.en.skills", { n: skillCount }) : ` `}`);
		// CTU-09（2026-09-28 code review）：标题源头截断（overlayCmd/ap.cmd 是用户输入可超长——原靠
		// padToWidth 兜底切掉右框角；预算扣除 en 段实测宽）
		const titleText = ap !== undefined ? t("menu.title.arg", { cmd: ap.cmd }) : level2 ? ` ${s.overlayCmd} ` : t("menu.title.root");
		const title = theme.fg("accent", truncateToWidth(titleText, Math.max(4, ow - 7 - visibleWidth(en))));
		const topFill = Math.max(1, ow - 4 - visibleWidth(title) - visibleWidth(en));
		olines.push(theme.bg("surface2", theme.fg(bc, "╭─") + title + theme.fg(bc, "─".repeat(topFill)) + en + theme.fg(bc, "─╮")));
		// 标题下不留装饰空行（2026-09-23 用户打回：上方空白一块）——↑ 占位行紧贴标题，滚动时原地变「↑ 还有 N 项」
		let items: { text: string; mark: string; long: string; kind: "cmd" | "skill" | "sep"; usage?: string }[];
		if (ap !== undefined) {
			// 参数阶段（m5 T15）：候选行与命令菜单同框（恒定行数防闪烁纪律不变）
			items = ap.items.length === 0
				? [{ text: theme.dim(t("menu.empty.arg")), mark: " ", long: t("menu.long.emptyArg"), kind: "cmd" as const }]
				: ap.items.map((c) => ({ text: c, mark: " ", long: t("menu.long.arg", { c }), kind: "cmd" as const }));
		} else if (level2) {
			const cmdDef = app.io.slashCommands().find((c) => c.name === s.overlayCmd);
			const current = app.io.slashCurrent(s.overlayCmd);
			items = (cmdDef?.children ?? []).map((c) => {
				const meta = cmdDef?.childMeta?.[c]; // F5 十轮⑤：档名 + 短解（详释区用 long）；内部档值括注已删（2026-09-28 用户走查打回——中文档名自足）
				return {
					text: meta === undefined ? c : `${theme.fg("fg", meta.label)} ${theme.dim(`——${meta.desc}`)}`,
					mark: c === current ? theme.fg("accent", "✓") : " ",
					long: meta?.long ?? t("menu.long.level2", { cmd: s.overlayCmd, c }),
					kind: "cmd" as const,
				};
			});
		} else {
			const real = app.input.filteredCommands();
			const sk = app.menu.filteredSkills();
			// m4-7 T7（原型图 1）：技能条目殿后于全部命中命令；分隔行「── 技能 ──」仅技能区非空时出现——
			// 无技能环境此处与原实现逐字节一致（验收点 3）；muted（2026-09-27 用户走查打回：border 边框色
			// #25352d 深底上几乎不可见——换灰绿与描述文字同色独占一行可读；不用 accent 避免与选中行抢权重）
			const sepRow = { text: theme.fg("muted", `${t("menu.sep.skills")}${"─".repeat(Math.max(1, oInner - visibleWidth(t("menu.sep.skills")) - 2))}`), mark: " ", long: "", kind: "sep" as const }; // 表值只给前缀——补宽横线调用侧拼（清单 {─…} notation 的实施期形态）
			const skillRow = (c: SlashItem) => {
				// 主标签固定格式「skill : 名」（类别前缀，冒号两侧空格照写——与命令 /xxx 视觉区分）+
				// 行内短说明 = description（超宽截断不折行，原型要点）
				const label = `skill : ${c.skill ?? c.name}`;
				const budget = oInner - 4 - visibleWidth(label) - 1;
				const desc = budget >= 8 ? ` ${theme.dim(truncateToWidth(c.desc, budget))}` : "";
				return { text: truncateToWidth(`${label}${desc}`, oInner - 4), mark: " ", long: c.long, kind: "skill" as const, ...(c.usage !== undefined ? { usage: c.usage } : {}) };
			};
			items =
				real.length === 0 && sk.length === 0
					? [{ text: theme.dim(t("menu.empty.cmd")), mark: " ", long: t("menu.long.emptyCmd"), kind: "cmd" as const }]
					: [
							...real.map((c) => ({
								text: `${c.name}${c.aliases === undefined ? "" : theme.fg("muted", `（${c.aliases.join(", ")}）`)} ${theme.dim(c.desc)}`,
								mark: " ",
								long: c.long,
								kind: "cmd" as const,
							})),
							...(sk.length > 0 ? [sepRow] : []),
							...sk.map(skillRow),
						];
		}
		const selI = Math.max(0, Math.min(items.length - 1, s.overlaySel));
		const winStart = Math.max(0, Math.min(Math.max(0, items.length - OVERLAY_PAGE), selI - OVERLAY_PAGE + 1));
		const win = items.slice(winStart, winStart + OVERLAY_PAGE);
		// 列表区恒定（2023-09-23 用户拍板：固定防闪烁）——命令恒 OVERLAY_PAGE 行（二级列表不足时补空行——空槽位留空）
		for (let i = 0; i < OVERLAY_PAGE; i++) {
			const it = win[i];
			if (it === undefined) {
				olines.push(boxRow(""));
				continue;
			}
			const gi = winStart + i;
			if (it.kind === "sep") {
				// 分隔行不可选不高亮（占 1 行参与窗口分页——滚出视野即不见）
				olines.push(boxRow(` ${it.text}`));
				continue;
			}
			const selPrefix = gi === selI ? theme.fg("accent", "❯") : " ";
			const markSeg = it.mark === " " ? "" : `${it.mark} `;
			const row = ` ${selPrefix} ${markSeg}${it.text}`;
			olines.push(gi === selI ? boxRow(theme.bg("accentSoft", padToWidth(row, oInner - 1))) : boxRow(row));
		}
		// 余量提示合并一行常驻（2026-09-23 用户打回：上下两行占 2 行不好看）——上下都有时「↑ 还有 N · ↓ 还有 M」，无余量时空占位
		const rest = items.length - winStart - win.length;
		const hints = [
			winStart > 0 ? t("pick.moreUp", { n: winStart }) : "",
			rest > 0 ? t("pick.moreDown", { n: rest }) : "",
		].filter(Boolean).join(" · ");
		olines.push(boxRow(hints === "" ? "" : theme.dim(`   ${hints}`)));
		// 详释区恒定 3 行（同拍板）：说明最多 2 行，显示不下第 2 行末尾 "..."（占 3 列），第 3 行操作提示
		const longW = oInner - 2;
		const wrapped = wrapText(theme.dim(items[selI]?.long ?? ""), longW);
		const longLines = wrapped.slice(0, 2).map((l) => ` ${l}`);
		if (wrapped.length > 2) longLines[1] = ` ${truncateToWidth(wrapped[1] ?? "", longW - 4)}...`;
		while (longLines.length < 2) longLines.push("");
		const foot = theme.dim(ap !== undefined ? ` ${t("menu.foot.arg")}` : level2 ? ` ${t("menu.foot.level2")}` : ` ${t("menu.foot.root")}`);
		olines.push(theme.bg("surface2", theme.fg(bc, "├" + "─".repeat(oInner) + "┤")));
		for (const l of longLines) olines.push(boxRow(l));
		// 详释第 3 行（m4-7 T7 / 原型图 1 验收点 2）：技能选中 = when_to_use 简单说明（无则整行留空不删行——
		// 高度恒定纪律）；命令/参数/二级维持操作提示行（技能的 Enter/Esc 键位与命令同，操作行省去不损可发现性）
		const selItem = items[selI];
		const third = selItem !== undefined && selItem.kind === "skill"
			? (selItem.usage !== undefined && selItem.usage !== ""
				? ` ${theme.dim(`${t("menu.usagePrefix")}${truncateToWidth(selItem.usage, longW - 4)}`)}`
				: "")
			: foot;
		olines.push(boxRow(third));
		olines.push(theme.bg("surface2", theme.fg(bc, "╰" + "─".repeat(oInner) + "╯")));
		return { lines: olines, row: Math.max(0, divRow - olines.length), col: 0, width: ow };
	}

	return { buildViewOverlay, buildDialogOverlay, buildPickOverlay, buildDiagOverlay, buildLauncherOverlay, buildAtOverlay, buildOverlay };
}
