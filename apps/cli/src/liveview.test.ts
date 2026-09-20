import { describe, it, expect, vi } from "vitest";
import { createLiveView } from "./liveview.ts";
import { dispLines, dispWidth } from "./ansi.ts";

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe("流式活动区 liveview（TUI 批 T4——B11 半项）", () => {
  it("① 节流：80ms 内多次 activity 只重绘一次（fake timer）", () => {
    vi.useFakeTimers();
    try {
      const w: string[] = [];
      const lv = createLiveView({ write: (s) => w.push(s), isTTY: true, columns: () => 80 });
      lv.activity("甲");
      lv.activity("乙");
      lv.activity("丙");
      expect(w.join("")).toBe(""); // 节流窗口内零重绘
      vi.advanceTimersByTime(80);
      const first = w.join("");
      expect(first).toContain("甲乙丙"); // 合流为一次重绘
      expect(count(first, "\x1b[0J")).toBe(1); // 恰好一帧（clearToEnd 每帧一枚）
      const afterFirst = w.length;
      lv.activity("丁");
      vi.advanceTimersByTime(79);
      expect(w.length).toBe(afterFirst); // 第二窗口内不触发
      vi.advanceTimersByTime(1);
      const second = w.slice(afterFirst).join("");
      expect(second).toContain("甲乙丙丁"); // 整段重渲染
      expect(second).toContain("\x1b[1A\r"); // 第二帧是重绘——上移一视觉行（单行 3 宽 < 80 列）
      lv.end();
    } finally {
      vi.useRealTimers();
    }
  });

  it("② 活动区内容经 renderMarkdown 渲染（列表圆点/代码块缩进出现在重绘输出）", () => {
    const w: string[] = [];
    const lv = createLiveView({ write: (s) => w.push(s), isTTY: true, columns: () => 80 });
    lv.activity("- a\n- b\n```js\nconst x = 1\n```\n");
    lv.end(); // end() 同步冲刷——最终帧
    const out = w.join("");
    expect(out).toContain("• a");
    expect(out).toContain("• b");
    expect(out).toContain("  [js] const x = 1");
  });

  it("③ 窗口上限：活动区超 40 行后头部固化（不再参与重绘）；固化切点落在未闭合代码块内时顺延至 fence 闭合行", () => {
    vi.useFakeTimers();
    try {
      // 场景一：50 行纯文本——头部 10 行固化，活窗 40 行；固化行后续零重绘
      const w1: string[] = [];
      const lv1 = createLiveView({ write: (s) => w1.push(s), isTTY: true, columns: () => 80 }, { windowLines: 40 });
      lv1.activity(Array.from({ length: 50 }, (_, i) => `L${String(i).padStart(2, "0")}`).join("\n"));
      vi.advanceTimersByTime(80); // 帧 1：10 固化 + 40 活窗
      lv1.activity("\n新行"); // 换行起新行——活窗 41 行触发二次固化
      vi.advanceTimersByTime(80); // 帧 2：L10 顺延固化（形态未变——只重写活窗）
      const out1 = w1.join("");
      expect(count(out1, "L00")).toBe(1); // 首行只出现一次——固化后不参与重绘
      expect(count(out1, "L10")).toBe(1); // 二次固化同款——帧 2 不重写已上屏内容
      expect(out1).toContain("新行");
      lv1.end();

      // 场景二：10 文本 + 未闭合 fence + 45 代码行——切点不得落在块内（退到围栏前）；
      // fence 闭合后代码块须以缩进终态重画（未被提前固化成裸行——v1.8 B1②）
      const w2: string[] = [];
      const lv2 = createLiveView({ write: (s) => w2.push(s), isTTY: true, columns: () => 80 }, { windowLines: 40 });
      const text = Array.from({ length: 10 }, (_, i) => `T${i}`);
      const code = Array.from({ length: 45 }, (_, i) => `c${i}`);
      lv2.activity([...text, "```js", ...code].join("\n")); // 56 原文行 > 40——切点退到围栏前（10）
      vi.advanceTimersByTime(80);
      const frame1 = w2.join("");
      expect(count(frame1, "T0")).toBe(1);
      expect(frame1).not.toContain("  [js]"); // 未闭合防御——裸行形态上屏
      const before2 = w2.length;
      lv2.activity("\n```\n尾行"); // fence 闭合
      vi.advanceTimersByTime(80);
      const frame2 = w2.slice(before2).join("");
      expect(frame2).toContain("  [js] c0"); // 闭合后以缩进终态重画——证明代码块此前未被固化
      expect(frame2).toContain("\x1b[45A\r"); // 自首个形态差异行起重写（55 帧高 − 10 固化行）
      lv2.end();
    } finally {
      vi.useRealTimers();
    }
  });

  it("④ end() 固化终稿；write 到达先固化活动区再直写（后续 write 不再上移清尾）", () => {
    const w: string[] = [];
    const lv = createLiveView({ write: (s) => w.push(s), isTTY: true, columns: () => 80 });
    lv.activity("正文");
    lv.write("[tool] 调用\n"); // 工具行夹在两段正文间——先固化活动区再直写
    const atTool = w.join("");
    expect(atTool.indexOf("正文")).toBeLessThan(atTool.indexOf("[tool] 调用")); // 固化序：正文在工具行上方
    const before = w.length;
    lv.end();
    lv.write("后续行\n");
    expect(w.slice(before).join("")).toBe("后续行\n"); // end 后 write 直写——零 ANSI、无上移清尾
  });

  it("⑤ 显示宽：CJK 行按视觉宽计算折行数；ANSI 转义零宽（剥除后测宽——思考块 dim 序列不误算）", () => {
    expect(dispLines("中文中文中文中文中文中文", 10)).toBe(3); // 12 全角 = 24 显示宽，10 列 → ⌈24/10⌉ = 3 视觉行
    expect(dispWidth("\x1b[2m中文\x1b[22m")).toBe(4); // dim 转义剥除
    expect(dispLines("abc", 80)).toBe(1);
  });

  it("⑥ 非 TTY：activity 等价直写（零 ANSI、零缓冲）", () => {
    const w: string[] = [];
    const lv = createLiveView({ write: (s) => w.push(s), isTTY: false, columns: () => 80 });
    lv.activity("甲");
    lv.activity("乙\n");
    lv.write("丙\n");
    lv.end();
    expect(w.join("")).toBe("甲乙\n丙\n"); // 原样直通——无节流合流、无 ANSI
  });
});
