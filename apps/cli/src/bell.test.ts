import { describe, it, expect, vi, afterEach } from "vitest";
import { bellCount, ringTurnBell, BELL_GAP_MS } from "./bell.ts";

afterEach(() => { vi.useRealTimers(); });

// 2026-09-30 用户拍板：回合结束提示音——完成 1 响/中断 2 响/错误 3 响（响数区分结局）。
// BEL 终端自消费不进屏缓冲；多响 150ms 错峰防合并成一声。
describe("回合结束提示音（拍板 c）", () => {
  it("① 响数分档：completed=1 / interrupted=2 / error=3 / 未知形态 0 不响", () => {
    expect(bellCount("completed")).toBe(1);
    expect(bellCount("interrupted")).toBe(2);
    expect(bellCount("error")).toBe(3);
    expect(bellCount(undefined)).toBe(0);
    expect(bellCount("weird")).toBe(0);
  });

  it("② error 三响：首响同步、余响按 BELL_GAP_MS 错峰补齐，全部是 BEL 字节", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    ringTurnBell("error", (s) => writes.push(s));
    expect(writes).toEqual(["\x07"]); // 首响同步——回合结束即反馈
    vi.advanceTimersByTime(BELL_GAP_MS);
    expect(writes).toHaveLength(2);
    vi.advanceTimersByTime(BELL_GAP_MS);
    expect(writes).toHaveLength(3);
    expect(writes.every((s) => s === "\x07")).toBe(true);
    vi.advanceTimersByTime(BELL_GAP_MS * 3);
    expect(writes).toHaveLength(3); // 恰三响，无多报
  });

  it("③ completed 单响纯同步（零定时器——不依赖事件循环存活）；interrupted 两响", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    ringTurnBell("completed", (s) => writes.push(s));
    vi.advanceTimersByTime(BELL_GAP_MS * 3);
    expect(writes).toEqual(["\x07"]);
    writes.length = 0;
    ringTurnBell("interrupted", (s) => writes.push(s));
    vi.advanceTimersByTime(BELL_GAP_MS);
    expect(writes).toHaveLength(2);
  });
});
