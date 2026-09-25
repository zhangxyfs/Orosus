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

/** 控件清单 → 行。w = 可用内容宽（不含面板边框）。 */
export function renderWidgets(widgets: readonly WidgetSpec[], w: number): string[] {
  const lines: string[] = [];
  for (const wd of widgets) {
    switch (wd.kind) {
      case "text": {
        const raw = resolveText(wd.text);
        const styled =
          wd.style === "muted" ? theme.dim(raw)
          : wd.style === "accent" ? theme.fg("accent", raw)
          : wd.style === "warn" ? theme.fg("warn", raw)
          : raw;
        if (wd.wrap === "none") {
          lines.push(` ${truncateToWidth(styled, Math.max(1, w - 1))}`);
        } else {
          for (const l of wrapText(styled, Math.max(4, w - 1))) lines.push(` ${l}`);
        }
        break;
      }
      case "kv": {
        const label = theme.fg("muted", padToWidth(wd.label, 8));
        lines.push(` ${label} ${truncateToWidth(resolveText(wd.value), Math.max(1, w - 11))}`);
        break;
      }
      case "sep":
        lines.push(theme.fg("border", " " + "┄".repeat(Math.max(1, w - 2))));
        break;
      case "list":
        if (wd.items.length === 0) {
          lines.push(theme.dim(" （空）"));
          break;
        }
        for (const item of wd.items) lines.push(` ${theme.dim("·")} ${truncateToWidth(item, Math.max(1, w - 3))}`);
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
        lines.push(
          ` ${theme.fg("accent", "█".repeat(full) + fracCh)}${theme.fg("muted", "░".repeat(Math.max(0, barW - full - (fracCh === "" ? 0 : 1))))} ${theme.fg("muted", pctText)}`,
        );
        break;
      }
      default:
        // input/columns/table 是控件窗（口子三）的控件——卡片侧诚实降级提示（T8 落真渲染器）
        lines.push(theme.dim(" （该控件在控件窗中呈现，卡片内不画）"));
        break;
    }
  }
  return lines;
}
