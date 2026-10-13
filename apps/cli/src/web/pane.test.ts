/** web 批 W2 伴生测试：pane.js 纯函数段——选项卡 tab 模型三件套（findTab/openOrSwitch/closeTabAt）
 *  + 行 HTML 推导（tabRowHtml/dropRowsHtml/tabTitle）。
 *  口径：brief Step 1 + v2 4390-4392 / 4414-4452 / 4635-4649 语义直裁——
 *  open-or-switch 幂等（同 kind+id 二次开 = 只激活不新增）/ closeTabAt 越界修正 active /
 *  全关 → empty=true（W1 closePane 钩子）/ 混合 kind 共存（agent 与 btw 同 id 互不冲突）。
 *  W3 追加：agent tab 接线面（app.js 侧 onBodyRender('agent')/agentTabDot/cmdTasks/openAgentTab）——
 *  DOM+fetch 耦合无 node 可测面（无 jsdom 纪律），走 render-plan.test.ts 同款源码锚定。 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

describe("web W3（问题 2）：子代理选项卡接线面（app.js 源码锚定——DOM 壳无 node 可测面纪律）", () => {
  const APP = readFileSync(fileURLToPath(new URL("./assets/app.js", import.meta.url)), "utf8");
  const W3 = APP.slice(APP.indexOf("子代理选项卡（问题 2 W3"), APP.indexOf("面板渲染（2s 轮询"));

  it("W3① onBodyRender('agent') 注册：.ag-wrap + 可选 .ag-approval（⚠ 工具名 + 原因 + data-aga 拒/批准一次 → 既有 POST approval）+ .ag-stream 回放（renderTranscript 复用）+ 运行中尾行 spinner", () => {
    expect(W3.length, "app.js 应含 W3 接线区").toBeGreaterThan(0);
    expect(W3).toContain("Pane.onBodyRender('agent', function (data, bodyEl)");
    expect(W3).toContain('class="ag-wrap"');
    expect(W3).toContain("bar.className = 'ag-approval'");
    expect(W3).toContain("aga-text");
    expect(W3).toContain('data-aga="no"');
    expect(W3).toContain('data-aga="yes"');
    expect(W3).toContain("批准一次");
    expect(W3).toContain("等待批准——");
    expect(W3).toContain("/approval"); // 既有端点 POST …/subagents/:id/approval——服务端零改动
    expect(W3).toContain("JSON.stringify({ allow:");
    expect(W3).toContain("renderTranscript"); // 回放复用 OrosusRender.renderTranscript
    expect(W3).toContain("sp.className = 'line dim agent-spin'");
    expect(W3).toContain("spinSvg('', 12)");
    expect(W3).toContain("正在生成…");
  });

  it("W3② 回放轮询 GC7：2s addPoll 既有口径驱动 + 活跃门（isConnected 失效自摘——仅活跃 tab 轮询）+ 事件数门零重渲 + 贴底跟随", () => {
    expect(APP).toContain("A.addPoll(2000, 1500");
    expect(W3).toContain("isConnected");
    expect(W3).toContain("agentStreamLoads.splice");
    expect(W3).toContain('getAttribute(\'data-n\')');
    expect(W3).toContain("pinBottom");
  });

  it("W3③ dotOf 覆写 agentTabDot 口径（v2 4393-4396 + TASK_ICON 四态 1598-1599）：pendingApproval ◉ 先行短路 + 四态图标 + 非粮/不在册归 W2 缺省点", () => {
    expect(W3).toContain("Pane.dotOf = function");
    expect(W3).toContain("{ queued: '○', running: '◐', completed: '✓', failed: '✗' }");
    expect(W3).toContain('\'<span class="pt-dot st-warn">◉</span>\'');
    expect(W3).toContain("paneDotDefault(tab)"); // 非agent kind（W6 btw 并存）/ 不在册 → W2 缺省点（v2 4404-4407 兑底）
  });

  it("W3④ cmdTasks：名册每行 open-or-switch 各开一个 agent tab（有几开几，无列表视图）；空名册 → openPane 空分栏；拉取失败 toast", () => {
    const zone = W3.slice(W3.indexOf("function cmdTasks"), W3.indexOf("function openAgentTab"));
    expect(zone).toContain("var sid = currentSid"); // 拉取期间切会话不改写归属
    expect(zone).toContain("refreshTasks(sid)");
    expect(zone).toContain("UI.openPane()"); // 空名册 → 打开空分栏（.pt-empty 空态）
    expect(zone).toContain("rows.forEach");
    expect(zone).toContain("addAgentTab(sid, tk)"); // 每行各开一个（open-or-switch 经 addAgentTab → Pane.addTab）
    expect(W3).toContain("Pane.addTab({ kind: 'agent'");
    expect(zone).toContain("拉取子代理名册失败");
  });

  it("W3⑤ 主流 open-or-switch + 状态点联动：openAgentTab 名册查证（不在册 toast 兑底）+ onAgentOpen 接线 + updateSpawnGroups 刷点 + 轮询门扩至已开 tab + plusSource 注入", () => {
    const zone = W3.slice(W3.indexOf("function openAgentTab"), W3.indexOf("Pane.onBodyRender('agent'"));
    expect(zone).toContain("rosterRowOf(id)");
    expect(zone).toContain("不在册");
    expect(zone).toContain("addAgentTab");
    expect(APP).toMatch(/onAgentOpen:\s*function\s*\(id\)\s*\{\s*openAgentTab\(id\);\s*\}/); // sg-row 点击 → open-or-switch
    expect(APP).toContain("taskRoster = rows;"); // updateSpawnGroups 拍内更新名册缓存
    expect(APP).toContain("refreshAgentTabDots();"); // 联动刷新已开 agent tab 状态点（dotOf 注入实现）
    expect(APP).toContain("querySelector('#pt-list .pt-item')"); // 名册轮询门：组卡行或已开 tab 任一在即取
    expect(W3).toContain("Pane.plusSource = function"); // ＋菜单内容源（v2 4683-4688：子代理 · label / 孙代理 ⎿ 前缀）
    expect(W3).toContain("子代理 · ");
    expect(W3).toContain("⎿ ");
  });

  it("W3⑥ btn-split 未开分支改接 cmdTasks（W1 留位收口——v2 4730-4734 同款：◧ 分栏 = /tasks 形态）", () => {
    const zone = APP.slice(APP.indexOf("$('btn-split').addEventListener"), APP.indexOf("子代理选项卡（问题 2 W3"));
    expect(zone).toContain("cmdTasks();");
  });
});
