/** 只读控件渲染器 v1（m5 T6，口子二/三共用）：WidgetSpec 清单 → 面板内容行（不含外框——外框归
 *  panelBox / 控件窗窗体）。画法全部是现成段的提纯：text/kv 照状态卡行配色、sep 照面板分隔线、
 *  list 照工具行灰点、progress 照上下文占用条（█░ + 分数块）。
 *  铁律：模块给数据不给画面——文字不许夹终端控制码，宿主按看得见的宽度折行/截断（全局约束 1）。
 *  活值字段（text/value 为函数）渲染期现读；抛错由调用方（卡片 = 当帧占位/剔除）兜底。 */

import type { WidgetSpec } from "@orosus/contracts/module";
import * as theme from "../theme.ts";
import { padToWidth, truncateToWidth, wrapText } from "./width.ts";

const resolveText = (v: string | (() => string)): string => (typeof v === "function" ? v() : v);
const resolveNum = (v: number | (() => number)): number => (typeof v === "function" ? v() : v);

const FRACS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** 控件窗的交互态（m5 T7）：每个 interactive list 的选中 index + 当前焦点控件 id。 */
export interface WidgetRenderState {
	selById?: Record<string, number>;
	focusedId?: string;
}

/** 交互列表的行位（选中项跟随滚动用）：第 i 项在第 baseLine + i 行。 */
export interface WidgetListPos {
	id: string;
	baseLine: number;
	count: number;
}

/** 控件清单 → 行 + 交互列表行位（窗体滚动跟随选中项）。w = 可用内容宽（不含边框）。 */
export function renderWidgetLines(
	widgets: readonly WidgetSpec[],
	w: number,
	st?: WidgetRenderState,
): { lines: string[]; lists: WidgetListPos[] } {
	const lines: string[] = [];
	const lists: WidgetListPos[] = [];
	for (const wd of widgets) {
		switch (wd.kind) {
			case "list": {
				if (wd.interactive === true && wd.items.length > 0) {
					const focused = st?.focusedId === wd.id;
					const sel = st?.selById?.[wd.id] ?? 0;
					lists.push({ id: wd.id, baseLine: lines.length, count: wd.items.length });
					for (let i = 0; i < wd.items.length; i++) {
						const mark = i === sel ? (focused ? theme.fg("accent", "❯") : theme.dim("❯")) : theme.dim(" ");
						const text = i === sel ? theme.fg("accent", wd.items[i]!) : wd.items[i]!;
						lines.push(` ${mark} ${truncateToWidth(text, Math.max(1, w - 3))}`);
					}
					break;
				}
				if (wd.items.length === 0) {
					lines.push(theme.dim(" （空）"));
					break;
				}
				for (const item of wd.items) lines.push(` ${theme.dim("·")} ${truncateToWidth(item, Math.max(1, w - 3))}`);
				break;
			}
			default:
				lines.push(...renderPlainWidget(wd, w, lines.length));
				break;
		}
	}
	return { lines, lists };
}

/** 单个非交互控件 → 行（renderWidgetLines 的分派体内复用）。 */
function renderPlainWidget(wd: WidgetSpec, w: number, _base: number): string[] {
	const out: string[] = [];
	switch (wd.kind) {
		case "text": {
			const raw = resolveText(wd.text);
			const styled =
				wd.style === "muted" ? theme.dim(raw)
				: wd.style === "accent" ? theme.fg("accent", raw)
				: wd.style === "warn" ? theme.fg("warn", raw)
				: raw;
			if (wd.wrap === "none") {
				out.push(` ${truncateToWidth(styled, Math.max(1, w - 1))}`);
			} else {
				for (const l of wrapText(styled, Math.max(4, w - 1))) out.push(` ${l}`);
			}
			break;
		}
		case "kv": {
			const label = theme.fg("muted", padToWidth(wd.label, 8));
			out.push(` ${label} ${truncateToWidth(resolveText(wd.value), Math.max(1, w - 11))}`);
			break;
		}
		case "sep":
			out.push(theme.fg("border", " " + "┄".repeat(Math.max(1, w - 2))));
			break;
		case "progress": {
			const value = resolveNum(wd.value);
			const max = wd.max <= 0 ? 1 : wd.max;
			const ratio = Math.max(0, Math.min(1, value / max));
			const pctText = `${Math.round(value)}/${Math.round(wd.max)}`;
			const barW = Math.max(6, w - 4 - pctText.length - 1);
			const total = Math.max(0, Math.min(barW, Math.round(ratio * barW * 8) / 8));
			const full = Math.floor(total);
			const frac = total - full;
			const fracCh = frac > 0 ? FRACS[Math.min(7, Math.ceil(frac * 8) - 1)] : ratio > 0 ? "▏" : "";
			out.push(
				` ${theme.fg("accent", "█".repeat(full) + fracCh)}${theme.fg("muted", "░".repeat(Math.max(0, barW - full - (fracCh === "" ? 0 : 1))))} ${theme.fg("muted", pctText)}`,
			);
			break;
		}
		default:
			// input/columns/table 是控件窗（口子三②/T8）的控件——只读面诚实降级提示
			out.push(theme.dim(" （该控件待 T8 渲染器）"));
			break;
	}
	return out;
}

/** 卡片侧入口（m5 T6）：只要行、不要交互行位。 */
export function renderWidgets(widgets: readonly WidgetSpec[], w: number): string[] {
	return renderWidgetLines(widgets, w).lines;
}
