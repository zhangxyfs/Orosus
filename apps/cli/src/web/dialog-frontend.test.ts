/** web-dialog 批 T7 伴生测试：assets/dialog.js 纯函数核（设计 §6.5/§8/§12.3）。
 *  node 直 import（pane.test.ts:14 同模式——纯函数段不碰 DOM）；DOM/接线面的源码锚定归 T8。 */
import { describe, it, expect } from "vitest";
import "./assets/dialog.js"; // 副作用挂 globalThis.OrosusDialog（pane.test.ts:14 同模式——纯函数段 node 直测）

/** 纯函数核的 TS 视图（JS 经典脚本零构建——类型只描消费面）。 */
interface DialogCore {
  esc(s: unknown): string;
  widgetHtml(w: Record<string, unknown>, state: { selById?: Record<string, number>; focusedId?: string }): string;
  widgetsHtml(ws: Record<string, unknown>[], state: { selById?: Record<string, number>; focusedId?: string }): string;
  mapLayout(layout: unknown): { cls: string; css: Record<string, string> | null } | null;
  nextIndex(len: number, cur: number | undefined, dir: number): number;
  enterActivates(w: { id?: string; kind?: string; multiline?: boolean; enterSubmit?: boolean }): boolean;
  createEventQueue(opts: {
    post: (body: Record<string, unknown>) => Promise<{ ok: boolean; revision?: number }>;
    toast: () => void;
    onDrained: (id: string, maxAck: number) => void;
  }): { send(id: string, body: Record<string, unknown>, optimistic?: { apply(): void }): void; close(id: string, body: Record<string, unknown>): void; frameAllowed(id: string): boolean; maxAck(id: string): number };
}
const D = (): DialogCore => (globalThis as { OrosusDialog?: DialogCore }).OrosusDialog!;

describe("web dialog T7：八类控件渲染（设计 §8.2 + 12.3）", () => {
  it("① 8 种控件形状：类名/data-wid/data-idx 齐；嵌套 columns 递归渲染", () => {
    const w = D();
    expect(w.widgetHtml({ id: "t", kind: "text", text: "正文" }, {})).toBe('<div class="dw dw-text" data-wid="t">正文</div>');
    expect(w.widgetHtml({ id: "t2", kind: "text", text: "强调", style: "accent", wrap: "none" }, {})).toContain('class="dw dw-text dw-accent dw-nowrap"');
    expect(w.widgetHtml({ id: "k", kind: "kv", label: "键", value: "值" }, {})).toContain('<span class="dw-k">键</span><span class="dw-v">值</span>');
    expect(w.widgetHtml({ id: "s", kind: "sep" }, {})).toContain("dw-sep");
    expect(w.widgetHtml({ id: "l", kind: "list", interactive: true, items: ["甲", "乙"] }, {})).toContain('<li class="dw-row" data-idx="1">乙</li>');
    expect(w.widgetHtml({ id: "i", kind: "input", label: "备注", multiline: true, lines: 4, placeholder: "提示" }, {})).toContain('rows="4"');
    expect(w.widgetHtml({ id: "i", kind: "input", multiline: true, lines: 4, placeholder: "提示" }, {})).toContain('data-submit="0"');
    expect(w.widgetHtml({ id: "tb", kind: "table", head: ["列一"], rows: [["r1"]] }, {})).toContain("<th>列一</th></tr></thead><tbody><tr><td>r1</td></tr>");
    const cols = w.widgetHtml({ id: "c", kind: "columns", cols: [[{ id: "ct", kind: "text", text: "左" }], [{ id: "cl", kind: "list", interactive: true, items: ["x"] }]], widths: [2, 1] }, {});
    expect(cols).toContain('data-weights="2,1"');
    expect(cols).toContain(">左</div>");
    expect(cols).toContain("data-idx");
  });

  it("② 转义注入口径：模块原文全过 esc（text/label/value/items/head/rows/placeholder/id/style）", () => {
    const w = D();
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const html = w.widgetsHtml([
      { id: evil, kind: "text", text: evil },
      { id: "k", kind: "kv", label: evil, value: evil },
      { id: "l", kind: "list", interactive: true, items: [evil] },
      { id: "i", kind: "input", placeholder: evil },
      { id: "tb", kind: "table", head: [evil], rows: [[evil]] },
    ], {});
    expect(html).not.toContain("<img"); // 模块原文的裸标签全部转义（&lt;img——onerror 文字可见但不可执行）
    expect(html).toContain("&lt;img");
    expect(html).toContain("&quot;");
  });

  it("③ progress 边界：负值→0%、超 max→100%、max<=0 按 1、非数→0%", () => {
    const w = D();
    expect(w.widgetHtml({ id: "p", kind: "progress", value: -3, max: 1 }, {})).toContain('data-fill="0"');
    expect(w.widgetHtml({ id: "p", kind: "progress", value: 7, max: 2 }, {})).toContain('data-fill="100"');
    expect(w.widgetHtml({ id: "p", kind: "progress", value: 0.5, max: 0 }, {})).toContain('data-fill="50"');
    expect(w.widgetHtml({ id: "p", kind: "progress", value: 0.5, max: -2 }, {})).toContain('data-fill="50"');
    expect(w.widgetHtml({ id: "p", kind: "progress", value: Number.NaN, max: 1 }, {})).toContain('data-fill="0"');
  });

  it("④ 空列表占位「（空）」（空白登记 #3）；非交互列表不带 data-idx/选中态", () => {
    const w = D();
    const empty = w.widgetHtml({ id: "l", kind: "list", interactive: true, items: [] }, {});
    expect(empty).toContain("dw-empty");
    expect(empty).toContain("（空）");
    const plain = w.widgetHtml({ id: "l2", kind: "list", items: ["甲"] }, {});
    expect(plain).not.toContain("data-idx");
    expect(plain).not.toContain("dw-sel");
  });

  it("⑤ 选中/焦点态：selById 命中行加 dw-sel、焦点列表加 dw-focus（interactive 才有）", () => {
    const w = D();
    const html = w.widgetHtml({ id: "l", kind: "list", interactive: true, items: ["甲", "乙", "丙"] }, { selById: { l: 1 }, focusedId: "l" });
    expect(html).toContain('<li class="dw-row dw-sel dw-focus" data-idx="1">乙</li>');
    expect(html.match(/dw-sel/g)!.length).toBe(1);
  });
});

describe("web dialog T7：layout 语义映射（设计 §8.1 + 12.3）", () => {
  it("⑥ 两档字符串：类名档无 CSS 变量；dock/未指定 → null（不进大窗路径）", () => {
    const w = D();
    expect(w.mapLayout("center80")).toEqual({ cls: "dlg-center80", css: null });
    expect(w.mapLayout("full")).toEqual({ cls: "dlg-full", css: null });
    expect(w.mapLayout("dock")).toBeNull();
    expect(w.mapLayout(undefined)).toBeNull();
  });

  it("⑦ 百分比直译与格数近似（空白登记 #2：宽 1ch / 高 var(--dlg-row-h)）", () => {
    const w = D();
    expect(w.mapLayout({ width: "80%", height: "60%" })!.css).toEqual({ "--dlg-w": "80%", "--dlg-h": "60%", "--dlg-x": "auto", "--dlg-y": "auto" });
    expect(w.mapLayout({ width: 40 })!.css!["--dlg-w"]).toBe("calc(40 * 1ch)");
    expect(w.mapLayout({ height: 20 })!.css!["--dlg-h"]).toBe("calc(20 * var(--dlg-row-h))");
    expect(w.mapLayout({ marginStart: 4 })!.css!["--dlg-left"]).toBe("calc(4 * 1ch)");
  });

  it("⑧ 边距定位三档：对边同给=边距之间 / 单边=贴边 / 都不给=容器居中（TUI 直译）", () => {
    const w = D();
    const both = w.mapLayout({ marginStart: 2, marginEnd: 2, marginTop: 1, marginBottom: 1 })!.css!;
    expect(both["--dlg-x"]).toBe("between");
    expect(both["--dlg-y"]).toBe("between");
    const single = w.mapLayout({ marginStart: 3, marginTop: 1 })!.css!;
    expect(single["--dlg-x"]).toBe("start");
    expect(single["--dlg-y"]).toBe("start");
    const endOnly = w.mapLayout({ marginEnd: 2 })!.css!;
    expect(endOnly["--dlg-x"]).toBe("end");
    expect(endOnly["--dlg-y"]).toBe("auto");
  });

  it("⑨ 非法回落 center80：负边距 / 非百分比串 / 百分比出界 / 非法类型", () => {
    const w = D();
    const fb = { cls: "dlg-center80", css: null };
    expect(w.mapLayout({ marginStart: -1 })).toEqual(fb);
    expect(w.mapLayout({ width: "abc" })).toEqual(fb);
    expect(w.mapLayout({ width: "120%" })).toEqual(fb);
    expect(w.mapLayout({ width: true as unknown as string })).toEqual(fb);
    expect(w.mapLayout(42 as unknown as object)).toEqual(fb);
  });
});

describe("web dialog T7：键盘规则（设计 §8.3）", () => {
  it("⑩ list ↑↓ 循环推进；越界当前值归边；Enter 规则按 multiline/enterSubmit", () => {
    const w = D();
    expect(w.nextIndex(3, 0, 1)).toBe(1);
    expect(w.nextIndex(3, 2, 1)).toBe(0); // 循环
    expect(w.nextIndex(3, 0, -1)).toBe(2); // 反向循环
    expect(w.nextIndex(3, 9, 1)).toBe(0);  // 越界归边
    expect(w.nextIndex(0, 0, 1)).toBe(-1);
    expect(w.enterActivates({ id: "i", kind: "input" })).toBe(true);              // 单行 Enter=激活
    expect(w.enterActivates({ id: "i", kind: "input", multiline: true })).toBe(false); // 多行换行
    expect(w.enterActivates({ id: "i", kind: "input", multiline: true, enterSubmit: true })).toBe(true);
  });
});

describe("web dialog T7：事件队列协调（设计 §6.5 + 12.3）", () => {
  it("⑪ 严格按序发送；close 排在先前事件之后", async () => {
    const w = D();
    const sent: string[] = [];
    const q = w.createEventQueue({
      post: (b: { ev?: string }) => new Promise((r) => { setTimeout(() => { sent.push(b.ev!); r({ ok: true, revision: 1 }); }, 5); }),
      toast: () => {},
      onDrained: () => {},
    });
    q.send("w1", { ev: "a" });
    q.send("w1", { ev: "b" });
    q.close("w1", { ev: "close" });
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toEqual(["a", "b", "close"]); // FIFO + close 殿后
  });

  it("⑫ 失败：toast 但队列继续；失败不推进 maxAck；排空后 onDrained 携最大已确认 revision", async () => {
    const w = D();
    let n = 0;
    const toasts: number[] = [];
    let drainedAt = -1;
    const q = w.createEventQueue({
      post: () => { n += 1; return n === 1 ? Promise.reject(new Error("net")) : Promise.resolve({ ok: true, revision: 5 }); },
      toast: () => { toasts.push(n); },
      onDrained: (_id: string, maxAck: number) => { drainedAt = maxAck; },
    });
    q.send("w1", { ev: "x" }); // 失败
    q.send("w1", { ev: "y" }); // 成功 revision 5
    await new Promise((r) => setTimeout(r, 30));
    expect(toasts.length).toBe(1);      // 失败 toast 一次
    expect(n).toBe(2);                  // 后续事件仍发
    expect(q.maxAck("w1")).toBe(5);     // 失败未推进、成功推进
    expect(drainedAt).toBe(5);          // 排空协调一次（失败本地修改随重画回滚）
  });

  it("⑬ frameAllowed：队列未清空不用旧快照覆盖未确认输入；清空后放行", async () => {
    const w = D();
    let release!: (v: { ok: true; revision: number }) => void;
    const q = w.createEventQueue({
      post: () => new Promise((r) => { release = r; }),
      toast: () => {},
      onDrained: () => {},
    });
    q.send("w1", { ev: "input" }, { apply: () => {} }); // 乐观更新已 apply
    expect(q.frameAllowed("w1")).toBe(false); // 在途：SSE 旧快照不得覆盖
    await new Promise((r) => setTimeout(r, 5)); // post 已被链尾取出（微任务后 release 就位）
    release({ ok: true, revision: 3 });
    await new Promise((r) => setTimeout(r, 10));
    expect(q.frameAllowed("w1")).toBe(true);  // 排空：放行协调
    expect(q.frameAllowed("w-unknown")).toBe(true);
  });
});
