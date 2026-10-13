/** web 批 W2 伴生测试：pane.js 纯函数段——选项卡 tab 模型三件套（findTab/openOrSwitch/closeTabAt）
 *  + 行 HTML 推导（tabRowHtml/dropRowsHtml/tabTitle）。
 *  口径：brief Step 1 + v2 4390-4392 / 4414-4452 / 4635-4649 语义直裁——
 *  open-or-switch 幂等（同 kind+id 二次开 = 只激活不新增）/ closeTabAt 越界修正 active /
 *  全关 → empty=true（W1 closePane 钩子）/ 混合 kind 共存（agent 与 btw 同 id 互不冲突）。
 *  DOM 薄壳段（⌄ 下拉 / ＋ 菜单 / 右键菜单 / renderTabs·activateTab·addTab·closeAt·onBodyRender）
 *  无 node 可测面（无 jsdom 纪律）——由 assets-check.test.ts 静态断言 + 走查自证。 */
import { describe, expect, it } from "vitest";

import "./assets/pane.js"; // 副作用挂 globalThis.OrosusPane（经典脚本零构建——node/浏览器同源导出；DOM 段 document 守卫不触）

/* noUncheckedIndexedAccess 下显式接口剥可选层（兼作导出面清单） */
type Fn = (...args: unknown[]) => unknown;
interface Tab {
  kind: string;
  id: string;
  label: string;
  data?: unknown;
}
interface OpenRes {
  tabs: Tab[];
  active: number;
  opened: boolean;
}
interface CloseRes {
  tabs: Tab[];
  active: number;
  empty: boolean;
}
interface PaneApi {
  findTab: Fn;
  openOrSwitch: Fn;
  closeTabAt: Fn;
  tabTitle: Fn;
  tabRowHtml: Fn;
  dropRowsHtml: Fn;
}
const P = (globalThis as { OrosusPane?: PaneApi }).OrosusPane!;
const open = (tabs: Tab[], active: number, tab: Tab): OpenRes => P.openOrSwitch(tabs, active, tab) as OpenRes;
const close = (tabs: Tab[], active: number, i: number): CloseRes => P.closeTabAt(tabs, active, i) as CloseRes;
const ids = (r: { tabs: Tab[] }): string[] => r.tabs.map((t) => t.id);

describe("web W2：pane.js 纯函数 tab 模型（v2 4390/4414-4452 直裁语义）", () => {
  it("① open-or-switch 幂等：同 kind+id 二次开 = 只激活不新增；不同 id 各自新增尾插激活；data 透传", () => {
    const a: Tab = { kind: "agent", id: "9f2c41ab", label: "检索挂载点" };
    const r1 = open([], -1, a);
    expect(r1.opened).toBe(true);
    expect(ids(r1)).toEqual(["9f2c41ab"]);
    expect(r1.active).toBe(0);

    const r2 = open(r1.tabs, 0, { kind: "agent", id: "7d2e90c2", label: "写入骨架" });
    expect(r2.opened).toBe(true);
    expect(ids(r2)).toEqual(["9f2c41ab", "7d2e90c2"]);
    expect(r2.active).toBe(1);

    // 回头再开首个：命中既有 → 只激活（幂等——不新增、active 指回原位、原数组零改动）
    const before = r2.tabs.slice();
    const r3 = open(r2.tabs, 1, a);
    expect(r3.opened).toBe(false);
    expect(ids(r3)).toEqual(["9f2c41ab", "7d2e90c2"]);
    expect(r3.active).toBe(0);
    expect(r2.tabs).toEqual(before); // 纯函数——入参数组不被原地改动
    expect(r3.tabs).not.toBe(r2.tabs); // 返回新数组

    // data 透传（W3/W6 的扩展数据槽）
    const r4 = open([], -1, { kind: "btw", id: "btw-1", label: "侧问 1", data: { rounds: [] } });
    expect(r4.tabs[0]!.data).toEqual({ rounds: [] });
  });

  it("② closeTabAt 越界修正 active：关尾（本尊被关且为尾）/ 关首 / 关 active 之前 / 关 active 之后四向", () => {
    const t = (id: string): Tab => ({ kind: "agent", id, label: id });
    const three = [t("a"), t("b"), t("c")];
    // active=2 关 2：关掉本尊且为尾 → 收敛到新末位 1
    const c1 = close(three, 2, 2);
    expect(ids(c1)).toEqual(["a", "b"]);
    expect(c1.active).toBe(1);
    expect(c1.empty).toBe(false);
    // active=0 关 0：后继左移入位，active 仍 0
    expect(close(three, 0, 0).active).toBe(0);
    // active=2 关 0（关在 active 之前）→ active 左移一位
    const c3 = close(three, 2, 0);
    expect(ids(c3)).toEqual(["b", "c"]);
    expect(c3.active).toBe(1);
    // active=1 关 2（关在 active 之后）→ active 不动
    expect(close(three, 1, 2).active).toBe(1);
    // i 越界（-1 / 99）→ 原样返回、empty=false（tabs 非空）
    const c5 = close(three, 1, 99);
    expect(ids(c5)).toEqual(["a", "b", "c"]);
    expect(c5.active).toBe(1);
    expect(c5.empty).toBe(false);
  });

  it("③ 全关 → empty=true（W1 closePane 收回分栏的钩子口径）", () => {
    const r = close([{ kind: "btw", id: "btw-1", label: "侧问 1" }], 0, 0);
    expect(r.tabs).toEqual([]);
    expect(r.active).toBe(-1);
    expect(r.empty).toBe(true);
    // 本就空再关 → 仍 empty=true
    expect(close([], -1, 0).empty).toBe(true);
  });

  it("④ 混合 kind 共存：agent 与 btw 同 id 互不冲突；btw 多实例并存（v2 openBtwTab 每次新实例）", () => {
    const r = open([{ kind: "agent", id: "x", label: "代理" }], 0, { kind: "btw", id: "x", label: "侧问" });
    expect(r.opened).toBe(true); // 同 id 不同 kind → 不算命中，新增
    expect(r.tabs).toHaveLength(2);
    expect(P.findTab(r.tabs, "agent", "x")).toBe(0);
    expect(P.findTab(r.tabs, "btw", "x")).toBe(1);
    // btw-1 / btw-2 同 kind 不同 id 并存
    const r2 = open(r.tabs, 1, { kind: "btw", id: "btw-2", label: "侧问 2" });
    expect(r2.tabs).toHaveLength(3);
    expect(P.findTab(r2.tabs, "btw", "btw-2")).toBe(2);
    // 不命中 → -1；kind 不同即不命中
    expect(P.findTab(r2.tabs, "agent", "btw-2")).toBe(-1);
    expect(P.findTab(r2.tabs, "btw", "nope")).toBe(-1);
    expect(P.findTab([], "agent", "x")).toBe(-1);
  });

  it("⑤ 行 HTML 推导：sel 态 / dot 注入 / title 口径 / ⌄ 下拉过滤与双空态（v2 4402-4412·4635-4649）", () => {
    const dot = (t: Tab): string => '<span class="pt-dot info">' + (t.kind === "btw" ? "✦" : "○") + "</span>";
    const agent: Tab = { kind: "agent", id: "7d2e90c2", label: "写入模块骨架" };
    const btw: Tab = { kind: "btw", id: "btw-1", label: "侧问 1" };
    // tab 条行：sel 类 / dot 注入 / label / 行尾 ×
    const rowSel = P.tabRowHtml(agent, 0, 0, dot) as string;
    expect(rowSel.startsWith('<span class="pt-item sel" data-pt="0"')).toBe(true);
    expect(rowSel).toContain('title="7d2e90c2 · 写入模块骨架"'); // title 口径：id · label
    expect(rowSel).toContain(dot(agent));
    expect(rowSel).toContain('<span class="pt-label">写入模块骨架</span>');
    expect(rowSel).toContain('<button class="pt-x" data-ptx="0" title="关闭选项卡">✕</button>');
    const rowUnsel = P.tabRowHtml(btw, 1, 0, dot) as string;
    expect(rowUnsel.startsWith('<span class="pt-item" data-pt="1"')).toBe(true);
    expect(rowUnsel).toContain('title="侧问 1（旁路 · 不进主对话）"'); // btw title 口径
    // ⌄ 下拉行：过滤 q（label 小写包含）、sel 行
    const tabs = [agent, btw];
    const rows = P.dropRowsHtml(tabs, 1, "侧问", dot) as string;
    expect(rows).toContain('data-ptd="1"');
    expect(rows).toContain('class="ptd-row sel"');
    expect(rows).not.toContain('data-ptd="0"');
    expect(rows).toContain('data-ptdx="1"');
    // 无匹配 / 空 tabs 双空态文案照抄（v2 4636/4648）
    expect(P.dropRowsHtml(tabs, 0, "不存在", dot)).toBe('<div class="ptd-none">无匹配的标签页</div>');
    expect(P.dropRowsHtml([], -1, "", dot)).toBe(
      '<div class="ptd-none">暂无打开的标签页——/tasks 开全部子代理 · ＋ 新建侧问</div>',
    );
  });
});
