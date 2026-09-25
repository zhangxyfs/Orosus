import { describe, it, expect } from "vitest";
import { resolvePopupLayout } from "./popuplayout.ts";

describe("弹窗布局求值纯函数（m5 T1——四步：扣可用 → 扣边距 → 定大小 → 定位置）", () => {
  it("缺省 center80：100×30 → 79×24 @ (10,3)，无回退", () => {
    const g = resolvePopupLayout(100, 30);
    expect(g).toEqual({ row: 3, col: 10, width: 79, height: 24 });
    expect(g.fallbackReason).toBeUndefined();
  });

  it("显式 \"center80\" 与缺省同值", () => {
    expect(resolvePopupLayout(100, 30, "center80")).toEqual(resolvePopupLayout(100, 30));
  });

  it("\"full\"：100×30 → 99×30 @ (0,0)——横向可用 = 列数 − 1（最后一列永不写）", () => {
    expect(resolvePopupLayout(100, 30, "full")).toEqual({ row: 0, col: 0, width: 99, height: 30 });
  });

  it("自定义算例（分析报告口子一同参）：{ height: 20, marginTop: 2, marginStart: 4 } → 76×20 @ (4,2)", () => {
    const g = resolvePopupLayout(100, 30, { height: 20, marginTop: 2, marginStart: 4 });
    expect(g).toEqual({ row: 2, col: 4, width: 76, height: 20 });
    expect(g.fallbackReason).toBeUndefined();
  });

  it("百分比串：width \"50%\" 按边距后的可用区算（100×30 无边距 → 49 宽居中）", () => {
    const g = resolvePopupLayout(100, 30, { width: "50%" });
    expect(g).toEqual({ row: 3, col: 25, width: 49, height: 24 });
  });

  it("固定数超界按可用区钳制：width 500 on 100×30 → 99", () => {
    const g = resolvePopupLayout(100, 30, { width: 500, height: 10 });
    expect(g).toMatchObject({ width: 99, height: 10, col: 0 });
    expect(g.fallbackReason).toBeUndefined();
  });

  it("保底 8×3：显式给小了往保底抬（100×30 → 8×3 居中）", () => {
    const g = resolvePopupLayout(100, 30, { width: 2, height: 1 });
    expect(g).toMatchObject({ width: 8, height: 3 });
    expect(g.col).toBe(Math.floor((99 - 8) / 2));
    expect(g.row).toBe(Math.floor((30 - 3) / 2));
  });

  it("单边贴边：只给 marginEnd → 右贴；只给 marginBottom → 底贴", () => {
    expect(resolvePopupLayout(100, 30, { marginEnd: 5, height: 10 })).toEqual({ row: 10, col: 19, width: 75, height: 10 });
    expect(resolvePopupLayout(100, 30, { marginBottom: 3, width: 40 })).toEqual({ row: 6, col: 29, width: 40, height: 21 });
  });

  it("对边同给 = 居中（在两侧边距之间居中，不是贴边）", () => {
    expect(resolvePopupLayout(100, 30, { marginStart: 10, marginEnd: 10, width: 40, height: 10 })).toEqual({ row: 10, col: 29, width: 40, height: 10 });
  });

  it("非法负数边距 → 整体回退 center80 重算 + fallbackReason", () => {
    const g = resolvePopupLayout(100, 30, { marginTop: -1 });
    expect(g).toEqual({ row: 3, col: 10, width: 79, height: 24, fallbackReason: "invalid" });
  });

  it("百分比出界（\"120%\"）→ 回退 center80 + fallbackReason", () => {
    const g = resolvePopupLayout(100, 30, { width: "120%" });
    expect(g).toEqual({ row: 3, col: 10, width: 79, height: 24, fallbackReason: "invalid" });
  });

  it("边距把可用区吃穿（两侧共留下 5 列 < 保底 8）→ 回退 center80", () => {
    const g = resolvePopupLayout(100, 30, { marginStart: 50, marginEnd: 44 });
    expect(g).toMatchObject({ row: 3, col: 10, width: 79, height: 24, fallbackReason: "invalid" });
  });

  it("too-small：8×2 终端连 center80 都装不下（可用宽 7 < 8、高 2 < 3）→ 夹进终端的保底几何 + 不弹窗信号", () => {
    expect(resolvePopupLayout(8, 2)).toEqual({ row: 0, col: 0, width: 7, height: 2, fallbackReason: "too-small" });
    expect(resolvePopupLayout(20, 2, "full")).toEqual({ row: 0, col: 0, width: 8, height: 2, fallbackReason: "too-small" });
  });
});
