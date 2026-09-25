/** 弹窗布局求值纯函数（m5 T1，口子一/三共用）：给终端行列数 + 布局描述，出 OverlayFrame 要的
 *  row/col/width/height。全批唯一的新算法件，viewText（T2）与控件窗（T7）都直接吃它。
 *
 *  四步（分析报告口子一「主程序怎么算」）：
 *  ① 横向画布可用 = 列数 − 1（最后一列永不写——conhost 不实现 DECAWM，写满底行右角格会自动换行）；
 *  ② 扣四边距得可用区；
 *  ③ 定大小：百分比按可用区、固定数超界钳到可用区、保底 8×3（顶框 + 一行内容 + 底框）；
 *  ④ 定位置：单边贴边、对边同给 = 在两侧边距之间居中、都不给 = 画布居中。
 *
 *  非法（负数边距、百分比出界、边距吃穿可用区）→ 整体回退 center80 重算并带 fallbackReason:"invalid"；
 *  连 center80 都装不下（可用宽 < 8 或高 < 3，如 8×2 终端）→ 夹到终端内的保底几何 + fallbackReason:"too-small"
 *  ——调用方（viewText）见 too-small 不弹窗、黄字「终端窗口太小」。 */

import type { PopupLayout } from "@orosus/contracts/module";

/** 保底尺寸：宽 8 列、高 3 行（设计空白 2）。 */
const MIN_WIDTH = 8;
const MIN_HEIGHT = 3;

export interface PopupGeometry {
  row: number;
  col: number;
  width: number;
  height: number;
  fallbackReason?: string;
}

/** 尺寸单值求值：百分比串按可用区 floor、固定数钳到可用区、undefined 取缺省 80%。非法返回 undefined。 */
function resolveSize(
  spec: string | number | undefined,
  avail: number,
  defaultPct: number,
): number | undefined {
  if (spec === undefined) return Math.floor((avail * defaultPct) / 100);
  if (typeof spec === "number") {
    if (!Number.isFinite(spec)) return undefined;
    return Math.max(0, Math.min(Math.floor(spec), avail));
  }
  const m = /^(\d+(?:\.\d+)?)%$/.exec(spec);
  if (m === null) return undefined;
  const pct = Number(m[1]);
  if (pct < 0 || pct > 100) return undefined;
  return Math.floor((avail * pct) / 100);
}

export function resolvePopupLayout(cols: number, rows: number, layout?: PopupLayout): PopupGeometry {
  const availW = Math.max(0, cols - 1);
  const availH = Math.max(0, rows);

  // too-small：连保底都装不进终端——夹到终端内返回（调用方不弹窗）
  if (availW < MIN_WIDTH || availH < MIN_HEIGHT) {
    return { row: 0, col: 0, width: Math.min(MIN_WIDTH, availW), height: Math.min(MIN_HEIGHT, availH), fallbackReason: "too-small" };
  }

  const compute = (l: PopupLayout): PopupGeometry | undefined => {
    if (l === "full") return { row: 0, col: 0, width: availW, height: availH };
    // center80 = 无边距 + 80% 尺寸，走与自定义同一条路（画布居中）
    const s = l === "center80" ? ({ width: "80%", height: "80%" } as Exclude<PopupLayout, "center80" | "full">) : l;
    const ms = s.marginStart ?? 0;
    const me = s.marginEnd ?? 0;
    const mt = s.marginTop ?? 0;
    const mb = s.marginBottom ?? 0;
    if (ms < 0 || me < 0 || mt < 0 || mb < 0) return undefined;
    const innerW = availW - ms - me;
    const innerH = availH - mt - mb;
    if (innerW < MIN_WIDTH || innerH < MIN_HEIGHT) return undefined; // 边距吃穿可用区
    const width = resolveSize(s.width, innerW, 80);
    const height = resolveSize(s.height, innerH, 80);
    if (width === undefined || height === undefined) return undefined;
    const w = Math.max(MIN_WIDTH, width);
    const h = Math.max(MIN_HEIGHT, height);
    // 定位置：对边同给 = 边距间居中；单边 = 贴边；都不给 = 画布居中
    const col =
      ms > 0 && me > 0 ? ms + Math.floor((innerW - w) / 2)
      : ms > 0 ? ms
      : me > 0 ? availW - me - w
      : Math.floor((availW - w) / 2);
    const row =
      mt > 0 && mb > 0 ? mt + Math.floor((innerH - h) / 2)
      : mt > 0 ? mt
      : mb > 0 ? availH - mb - h
      : Math.floor((availH - h) / 2);
    return { row, col, width: w, height: h };
  };

  let geo = compute(layout ?? "center80");
  let fallback = false;
  if (geo === undefined) {
    geo = compute("center80")!;
    fallback = true;
  }
  return fallback ? { ...geo, fallbackReason: "invalid" } : geo;
}
