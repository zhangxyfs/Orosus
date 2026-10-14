/** web 批 W2 伴生测试：pane.js 纯函数段——选项卡 tab 模型三件套（findTab/openOrSwitch/closeTabAt）
 *  + 行 HTML 推导（tabRowHtml/dropRowsHtml/tabTitle）。
 *  口径：brief Step 1 + v2 4390-4392 / 4414-4452 / 4635-4649 语义直裁——
 *  open-or-switch 幂等（同 kind+id 二次开 = 只激活不新增）/ closeTabAt 越界修正 active /
 *  全关 → empty=true（W1 closePane 钩子）/ 混合 kind 共存（agent 与 btw 同 id 互不冲突）。
 *  W3 追加：agent tab 接线面（app.js 侧 onBodyRender('agent')/agentTabDot/cmdTasks/openAgentTab）——
 *  DOM+fetch 耦合无 node 可测面（无 jsdom 纪律），走 render-plan.test.ts 同款源码锚定。
 *  W4 追加：子代理 todo 悬浮条可见性（.todo-float.ag-todo——无数据不渲染 + 签名门 +
 *  agentStreamLoads 同拍轮询），同款源码锚定；端点真栈面归 subagent-todo.test.ts。 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import "./assets/pane.js"; // 副作用挂 globalThis.OrosusPane（经典脚本零构建——node/浏览器同源导出；DOM 段 document 守卫不触）

/* W6 追加面：btw 选项卡纯函数（btwTabSpec/applyBtwFrame/btwTabHtml——帧归约与 HTML 推导零 DOM 依赖）。 */
type BtwRound = { q: string; a: string | null; phase: string | null; think?: string };
type BtwFrameIn = { tab: string; phase: string; text: string; round: number };

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
  /* W6：btw 选项卡纯函数段 */
  btwTabSpec: (seq: number) => Tab & { data: { rounds: BtwRound[] } };
  applyBtwFrame: (rounds: BtwRound[], frame: BtwFrameIn) => BtwRound[];
  settleBtwRounds: (rounds: BtwRound[]) => number;
  btwTabHtml: (data: { rounds: BtwRound[] }, locked?: boolean) => string;
  pickerHtml: (rows: { kind: string; id?: string; label: string; prefix?: string; open: () => void }[]) => string; /* 走查修① */
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

  it("W3④ 走查修①（2026-10-13 用户口令）：/tasks 入口下线——cmdTasks 绝迹 + agent 开卡只剩 spawn 组行与回填两路", () => {
    expect(W3.includes("function cmdTasks"), "cmdTasks 应随 /tasks 入口下线删除").toBe(false);
    expect(W3).toContain("Pane.addTab({ kind: 'agent'"); // addAgentTab 健在（spawn 组行点击的唯一开卡道）
    expect(W3).toContain("走查修①"); // 段头注记口径同步
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
    expect(W3).toContain("Pane.plusSource = function"); // ＋菜单内容源（走查修③：只留「✦ 侧问」类型行——子代理不罗列，入口走 /tasks 与 spawn 组行；孙代理 ⎿ 前缀随罗列一同废弃）
  });

  it("W3⑥ btn-split 纯开合（走查修① 用户口令：◧ = 打开/关闭——零 tab 出「打开标签页」选择器、有卡原样恢复；/tasks 形态废弃）", () => {
    const zone = APP.slice(APP.indexOf("$('btn-split').addEventListener"), APP.indexOf("子代理选项卡（问题 2 W3"));
    expect(zone).toContain("UI.openPane()");
    expect(zone.includes("cmdTasks"), "btn-split 不再接 cmdTasks").toBe(false);
    expect(zone).toContain("closePane()");
  });
});

describe("web W4（问题 2）：子代理 todo 悬浮条（app.js/style.css 源码锚定——DOM 壳无 node 可测面纪律）", () => {
  const APP = readFileSync(fileURLToPath(new URL("./assets/app.js", import.meta.url)), "utf8");
  const CSS = readFileSync(fileURLToPath(new URL("./assets/style.css", import.meta.url)), "utf8");
  const W4 = APP.slice(APP.indexOf("todo 悬浮条（问题 2 W4"), APP.indexOf("agentStreamLoads.push(load)"));

  it("W4① 悬浮条 DOM（v2 4461-4471 直裁）：.todo-float.ag-todo + tf-pill（tf-owner = agentId 前 4 位 + ✓ + done/total 任务 + ⇲）+ tf-card（tf-head「任务清单 · <完整id>」+ 计数 + tf-list 行）", () => {
    expect(W4.length, "app.js 应含 W4 接线区").toBeGreaterThan(0);
    expect(W4).toContain("syncAgTodo");
    expect(W4).toContain("'todo-float ag-todo'");
    expect(W4).toContain("id.slice(0, 4)"); // tf-owner 归属徽标 = agentId 前 4 位（v2 4464）
    expect(W4).toContain("任务清单 · "); // 卡头「任务清单 · <完整id>」（v2 4465）
    expect(W4).toContain("data-agtf"); // pill 开合锚（v2 4464 → 4526-4531）
    expect(W4).toContain("tf-count");
    expect(W4).toContain("tf-card");
    expect(W4).toContain("tf-list");
    expect(W4).toContain("data-state="); // 行态三色（done/active/pending）
  });

  it("W4② 可见性纪律（v2 4462）：todos 空 → 整个不渲染；数据签名门——不变 DOM 零触碰；卡开合态跨刷新保持", () => {
    expect(W4).toContain("tasks.length === 0"); // 空 → 摘除后不重建（整个不渲染）
    expect(W4).toContain("agTodoSig"); // 签名门（GC7 律三）
    expect(W4).toContain("agTodoOpen"); // 重渲保持开合态
  });

  it("W4③ 轮询 GC7：todo 取数搭 agentStreamLoads 同拍（2s 仅活跃 tab——isConnected 失效自摘）+ GET /subagents/:id/todo 端点", () => {
    expect(W4).toContain("'/todo'");
    expect(W4).toContain("encodeURIComponent(id)");
    expect(W4).toContain("isConnected");
    expect(APP).toContain("A.addPoll(2000, 1500"); // 既有 2s 节拍器驱动（W3 同拍）
  });

  it("W4④ style.css：.ag-todo 定位（v2 965 top:8px;right:14px）+ 卡面 z-index 8（v2 966）", () => {
    const ag = /\.ag-todo\s*\{[^}]*\}/.exec(CSS)?.[0] ?? "";
    expect(ag, ".ag-todo 规则应存在").toContain("position: absolute");
    expect(ag).toContain("top: 8px");
    expect(ag).toContain("right: 14px");
    expect(CSS).toContain(".ag-todo .tf-card { z-index: 8; }");
  });
});

describe("web W6（问题 2）：btw 选项卡纯函数（pane.js 直测——v2 4442-4452/4484-4507/4568-4588 语义）", () => {
  it("W6① btwTabSpec 每次新实例：btw-N 自增 id、label「侧问 N」、data.rounds 各自独立数组（两实例互不透）", () => {
    const s1 = P.btwTabSpec(1);
    const s2 = P.btwTabSpec(2);
    expect(s1).toEqual({ kind: "btw", id: "btw-1", label: "侧问 1", data: { rounds: [] } });
    expect(s2.id).toBe("btw-2");
    expect(s2.label).toBe("侧问 2");
    expect(s1.data.rounds).not.toBe(s2.data.rounds); // rounds 各自独立——多实例互不渗透
    // 帧按实例落位：btw-1 收帧不渗 btw-2
    P.applyBtwFrame(s1.data.rounds, { tab: "btw-1", phase: "answering", text: "甲", round: 1 });
    expect(s1.data.rounds).toHaveLength(1);
    expect(s2.data.rounds).toHaveLength(0);
  });

  it("W6② applyBtwFrame 帧归约：answering 累积 → tool 相位保文 → answer 落定；error 终态；round 超前垫空 q 片", () => {
    const rounds: BtwRound[] = [];
    P.applyBtwFrame(rounds, { tab: "btw-1", phase: "answering", text: "先查证", round: 1 });
    expect(rounds[0]).toEqual({ q: "", a: "先查证", phase: "answering" });
    P.applyBtwFrame(rounds, { tab: "btw-1", phase: "tool", text: "查证中…", round: 1 });
    expect(rounds[0]!.phase).toBe("tool");
    expect(rounds[0]!.a).toBe("先查证"); // tool 相位不覆盖已积累文本（查证后 answering 续流是新一轮累积）
    P.applyBtwFrame(rounds, { tab: "btw-1", phase: "answering", text: "答案", round: 1 });
    P.applyBtwFrame(rounds, { tab: "btw-1", phase: "answer", text: "答案全文", round: 1 });
    expect(rounds[0]).toEqual({ q: "", a: "答案全文", phase: null }); // answer 终态 = phase 清空
    // round 超前：垫空 q 轮（重载 / 自动开 tab 后的帧对位——帧不带问题文本）
    P.applyBtwFrame(rounds, { tab: "btw-1", phase: "answering", text: "乙", round: 3 });
    expect(rounds).toHaveLength(3);
    expect(rounds[2]).toEqual({ q: "", a: "乙", phase: "answering" });
    // error 终态
    P.applyBtwFrame(rounds, { tab: "btw-1", phase: "error", text: "炸了", round: 3 });
    expect(rounds[2]).toEqual({ q: "", a: "炸了", phase: "error" });
  });

  it("W6③ btwTabHtml：scope 行照抄 + rounds 渲染（msg-user 气泡 + btw-a 回答中/查证中/失败相位态）+ 裁剪版 composer（无三芯片）+ hint 诚实口径", () => {
    const html = P.btwTabHtml({ rounds: [] });
    expect(html).toContain("旁路侧问 · 只感知主对话（每轮重取最新历史）· 仅 Read/Grep/Glob 只读工具 · 不进主对话流、不落盘");
    expect(html).toContain("还没有侧问"); // 空态（v2 4490）
    expect(html).toContain('id="btw-form"');
    expect(html).toContain('id="btw-input" rows="2"');
    expect(html).toContain('id="btw-file"');
    expect(html).toContain('title="引用文件（= 输入 @）"'); // ＋文件 = 插入 @
    expect(html).toContain('id="btw-send"');
    expect(html).toContain("旁路 · 只读工具 · 走当前会话模型"); // hint 诚实口径（自创值登记④）
    expect(html).not.toContain("不继承权限/模型/思考档"); // v2 :4505 原文「模型」一词与实现不符——不照抄
    for (const chip of ["mode-chip", "model-chip", "effort-chip"]) {
      expect(html.includes(chip), `裁剪版 composer 不应含 ${chip}（拍板第 4 条：去三芯片）`).toBe(false);
    }
    const html2 = P.btwTabHtml({ rounds: [
      { q: "这是什么", a: null, phase: "answering" },
      { q: "第二问", a: "答案", phase: null },
      { q: "第三问", a: "坏了", phase: "error" },
      { q: "第四问", a: "查过", phase: "tool" },
      { q: "", a: "垫片轮", phase: null },
    ] });
    expect(html2).toContain('<div class="msg-text">这是什么</div>'); // 复用 .msg-user 气泡
    expect(html2).toContain("回答中…"); // 回答中相位态
    expect(html2).toContain('<div class="btw-a"><div class="md">答案</div></div>'); // 落定态走 md 渲染（走查修⑤——node 态无 OrosusRender 降级 esc 纯文本，壳层 .md 恒在）
    expect(html2).toContain("侧问失败：坏了"); // 失败终态
    expect(html2).toContain("查证中…"); // 查证中相位态
    expect(html2).not.toContain('<div class="msg-text"></div>'); // 空 q 垫片不出空气泡
  });

  it("走查修②（2026-10-13 用户报障）：thinking 帧——思考文本落 rd.think、相位不倒退、思考中出停止钮、思考块渲染且 answer 后保留、切走结算视为在飞", () => {
    const rounds: BtwRound[] = [];
    P.applyBtwFrame(rounds, { tab: "btw-1", phase: "thinking", text: "先想想", round: 1 });
    expect(rounds[0]).toMatchObject({ q: "", a: null, phase: "thinking", think: "先想想" });
    P.applyBtwFrame(rounds, { tab: "btw-1", phase: "thinking", text: "先想想再想想", round: 1 }); // 累积
    expect(rounds[0]!.think).toBe("先想想再想想");
    P.applyBtwFrame(rounds, { tab: "btw-1", phase: "answering", text: "答", round: 1 }); // 正文启
    P.applyBtwFrame(rounds, { tab: "btw-1", phase: "thinking", text: "又想", round: 1 }); // 正文已启不倒退
    expect(rounds[0]!.phase).toBe("answering");
    expect(rounds[0]!.think).toBe("又想"); // 思考文本更新（交错流）
    // 渲染：thinking 相位 = 思考块（走字提示）+ 空 .btw-a；answer 落定 = 思考块保留（「思考过程」标头）+ md 正文
    const r2: BtwRound[] = [{ q: "q", a: null, phase: "thinking", think: "想" }];
    const hThink = P.btwTabHtml({ rounds: r2 });
    expect(hThink).toContain('class="btw-think"');
    expect(hThink).toContain("思考中…");
    expect(hThink).toContain('data-btwstop="1"'); // 思考中也可停止
    P.applyBtwFrame(r2, { tab: "btw-1", phase: "answer", text: "**答**", round: 1 });
    const hDone = P.btwTabHtml({ rounds: r2 });
    expect(hDone).toContain("思考过程"); // 落定后思考块保留（标头换静态）
    expect(hDone).not.toContain("data-btwstop");
    // 切走结算：纯 thinking 轮（无正文）视为在飞
    const r3: BtwRound[] = [{ q: "q", a: null, phase: "thinking", think: "想" }];
    expect(P.settleBtwRounds(r3)).toBe(1);
    expect(String(r3[0]!.a)).toContain("已中断");
  });

  it("走查修①（用户口令第三条）：收回不清卡——观察器 close 分支不再清 tabs/activeTab，重开按保留态重绘", () => {
    const src = readFileSync(fileURLToPath(new URL("./assets/pane.js", import.meta.url)), "utf8");
    const zone = src.slice(src.indexOf("new MutationObserver"), src.indexOf("}).observe("));
    expect(zone.includes("tabs = []"), "收回不再清空 tab 集合（口令：未全关的卡重开恢复）").toBe(false);
    expect(zone).toContain("走查修①"); // 注记在案
    // 选择器空态接线：renderPaneBody 零 tab 走 pickerHtml；卡片点击委派 [data-pp] 挂常驻 #pane-body
    expect(src).toContain("pickerHtml(rows)");
    expect(src).toContain("e.target.closest('[data-pp]')");
    expect(src).toContain("paneBodyEl.childNodes.length === 0"); // 首开/重开渲口（壳完好 body 空也渲）
  });

  it("走查修⑨（2026-10-14 用户口令）：btw composer 模型/思考档芯片——渲染覆盖值或会话当前 + locked 禁用", () => {
    const html = P.btwTabHtml({ rounds: [], chipModel: "glm-5.3", chipEffort: "max" });
    expect(html).toContain('id="btw-model"');
    expect(html).toContain("glm-5.3");
    expect(html).toContain('id="btw-effort"');
    expect(html).toContain("思考 max");
    const blank = P.btwTabHtml({ rounds: [] });
    expect(blank).toContain("模型 —"); // 无渲染期现算数据时的兜底形
    const locked = P.btwTabHtml({ rounds: [], chipModel: "glm-5.3", chipEffort: "max" }, true);
    expect(locked).toContain('id="btw-model" title="本侧问临时指定模型（默认跟随会话当前）" disabled');
  });

  it("走查修⑧（2026-10-13 用户报障「/btw 打不开分栏」）：cmdBtw 复用空草稿 tab 也先开栏（保留态 tab 在栏外仍在册）", () => {
    const src = readFileSync(fileURLToPath(new URL("./assets/app.js", import.meta.url)), "utf8");
    const zone = src.slice(src.indexOf("function cmdBtw"), src.indexOf("function sendBtwAsk"));
    const reuseIdx = zone.indexOf("Pane.activateTab(i)");
    expect(reuseIdx).toBeGreaterThan(-1);
    expect(zone.lastIndexOf("UI.openPane()", reuseIdx), "activateTab 前必须先 openPane").toBeGreaterThan(-1);
    expect(zone.lastIndexOf("UI.openPane()", reuseIdx)).toBeLessThan(reuseIdx);
  });

  it("走查修①（2026-10-13 用户口令·图2形态）：pickerHtml 零 tab 选择器——标题/副题/虚线卡片网格 + esc + 多行扩列", () => {
    const html = P.pickerHtml([{ kind: "btw", label: "侧问", prefix: "✦ ", open() {} }]);
    expect(html).toContain("打开标签页");
    expect(html).toContain("选择要在侧边面板中打开的标签。");
    expect(html).toContain('class="pp-card" data-pp="0"');
    expect(html).toContain("✦");
    expect(html).toContain("侧问");
    const two = P.pickerHtml([
      { kind: "btw", label: "侧问", prefix: "✦ ", open() {} },
      { kind: "x", label: "<注入>", prefix: "?", open() {} },
    ]);
    expect(two).toContain('data-pp="1"');
    expect(two).toContain("&lt;注入&gt;"); // esc
    expect(P.pickerHtml([])).toContain('class="pp-grid"'); // 零行也不塌架（正常态下 plusSource 恒有侧问行）
  });

  it("走查修①（2026-10-13 用户口令）：在飞末轮发送钮变 ■ 停止 + 落定回答走 mdRender（在飞保持纯文本）", () => {
    // ④ 在飞 → 停止钮（type=button 不走 submit + data-btwstop 路由标记）；落定/空态 → 恢复原发送钮
    const flying = P.btwTabHtml({ rounds: [{ q: "q", a: null, phase: "answering" }] });
    expect(flying).toContain('data-btwstop="1"');
    expect(flying).toContain(">■</button>");
    expect(flying).toContain('class="sendbtn stop"');
    const toolPhase = P.btwTabHtml({ rounds: [{ q: "q", a: "半截", phase: "tool" }] });
    expect(toolPhase).toContain('data-btwstop="1"'); // 查证中也算在飞
    const settled = P.btwTabHtml({ rounds: [{ q: "q", a: "答", phase: null }] });
    expect(settled).not.toContain("data-btwstop");
    const errDone = P.btwTabHtml({ rounds: [{ q: "q", a: "坏了", phase: "error" }] });
    expect(errDone).not.toContain("data-btwstop"); // error 终态不在飞
    const lockedFlying = P.btwTabHtml({ rounds: [{ q: "q", a: null, phase: "answering" }] }, true);
    expect(lockedFlying).not.toContain("data-btwstop"); // 锁定态（跨会话）不出停止钮——composer 全禁用口径
    // ⑤ 落定回答经 OrosusRender.mdRender；在飞不跑 md（律二）
    const calls: string[] = [];
    (globalThis as Record<string, unknown>)["OrosusRender"] = { mdRender: (t: string) => { calls.push(t); return "<p>MD:" + t + "</p>"; } };
    try {
      const html = P.btwTabHtml({ rounds: [{ q: "q", a: "**粗体**", phase: null }] });
      expect(calls).toEqual(["**粗体**"]);
      expect(html).toContain('<div class="md"><p>MD:**粗体**</p></div>');
      calls.length = 0;
      const fly = P.btwTabHtml({ rounds: [{ q: "q", a: "半截文本", phase: "answering" }] });
      expect(calls).toEqual([]); // 在飞纯文本不跑 md
      expect(fly).toContain("半截文本");
    } finally {
      delete (globalThis as Record<string, unknown>)["OrosusRender"];
    }
  });
});

describe("web W6（问题 2）：btw 选项卡接线面（app.js/ui.js 源码锚定——DOM 壳无 node 可测面纪律）", () => {
  const APP = readFileSync(fileURLToPath(new URL("./assets/app.js", import.meta.url)), "utf8");
  const UI = readFileSync(fileURLToPath(new URL("./assets/ui.js", import.meta.url)), "utf8");
  const W6 = APP.slice(APP.indexOf("btw 选项卡（问题 2 W6"), APP.indexOf("面板渲染（2s 轮询"));

  it("W6④ openBtwTab 每次新实例（btwTabSpec + addTab）＋ plusSource「✦ 侧问选项卡」类型行（v2 4442-4452/4685）", () => {
    expect(W6.length, "app.js 应含 W6 接线区").toBeGreaterThan(0);
    expect(W6).toContain("btwSeq");
    expect(W6).toContain("Pane.btwTabSpec(btwSeq)");
    expect(W6).toContain("Pane.addTab(spec)");
    const ps = APP.slice(APP.indexOf("Pane.plusSource = function"), APP.indexOf("拉名册并刷 tab 状态点"));
    expect(ps).toContain("label: '侧问'"); // 走查修③：＋菜单单入口「✦ 侧问」（仿 ZCode 侧聊入口；旧名册罗列废弃）
    expect(ps).toContain("✦ ");
    expect(ps).toContain("openBtwTab()");
  });

  it("W6⑤ 发送链路：POST /btw {tab,q}（W5 askBtw 数据面）+ 本地 push {q,a:null} 占位 + 单飞尾轮对齐 + POST 失败标错不悬转", () => {
    expect(W6).toContain("'/btw'");
    expect(W6).toContain("tab: tab.id, q: q,"); // 走查修⑨：POST 体扩 model/effort 覆盖键（条件展开——缺省不带）
    expect(W6).toContain("{ q: q, a: null, phase: 'answering' }");
    expect(W6).toContain("rounds.pop()"); // 尾部在飞轮先弹——server per-tab 单飞 abort 旧在飞（旧问不入 rounds），对齐帧 round 对位
    expect(W6).toContain("发送失败："); // POST 失败即标 error 相位
  });

  it("W6⑥ SSE btw 帧按 tab 分发：未开 tab 的 answering/answer 帧自动开 tab（对齐旧 btwOpen 自动占窗）+ 仅活跃 tab 重渲（GC7）", () => {
    expect(APP).toMatch(/btw: function \(d\) \{ if \(currentSid === sid && d\) btwFeed\(d\); \}/); // :2761 接线改派 btwFeed
    expect(W6).toContain("function btwFeed(frame)");
    expect(W6).toContain("frame.tab");
    expect(W6).toContain("frame.phase !== 'answering' && frame.phase !== 'answer'");
    expect(W6).toContain("Pane.applyBtwFrame");
    expect(W6).toContain("Pane.activeTab() === tab");
    expect(W6).toContain("rerenderBtwKeepingDraft()");
  });

  it("W6⑦ /btw mark 分支 + :102-104 截获块改发问源 + 裁剪 composer 交互（Enter 发送/Shift+Enter 换行、stopPropagation、保草稿、＋文件插 @）", () => {
    const hm = APP.slice(APP.indexOf("function handleMark"), APP.indexOf("贴图（D6"));
    expect(hm).toContain("mark === 'btw'");
    expect(hm).toContain("cmdBtw(r);"); // 走查修：mark 响应透传（r.btywRounds 无参回看水合）
    expect(APP).toContain("pendingBtwQuestion"); // 截获块存问题文本（mark 响应不带文本——发问源）
    expect(W6).toContain("e.key === 'Enter' && !e.shiftKey");
    expect(W6).toContain("requestSubmit()");
    expect(W6).toContain("e.stopPropagation()"); // 不触发主输入框 Esc / 快捷键逻辑（v2 4555-4558）
    expect(W6).toContain("function rerenderBtwKeepingDraft");
    expect(W6).toContain("'@'"); // ＋文件 = 插入 @
  });

  it("W6⑧ 旧弹窗三面绝迹：ui.js btwOpen/btwSetQuestion/btwFrame/btwTitle 拆除 + 导出面清理 + 全 assets 零残留", () => {
    for (const name of ["btwOpen", "btwSetQuestion", "btwFrame", "btwTitle"]) {
      expect(UI.includes(name), `ui.js 不应再含 ${name}`).toBe(false);
      for (const f of ["app.js", "render.js", "ui.js", "pane.js", "archived-view.js", "index.html"]) {
        const src = readFileSync(fileURLToPath(new URL("./assets/" + f, import.meta.url)), "utf8");
        expect(src.includes(name), `assets/${f} 不应残留 ${name}`).toBe(false);
      }
    }
  });
});

describe("web W6 复核修（Important#1/#2 + Minor#1——切走结算/门控/发送清空/前缀口径统一）", () => {
  const APP = readFileSync(fileURLToPath(new URL("./assets/app.js", import.meta.url)), "utf8");

  it("F① settleBtwRounds 切走结算：在飞轮（a 空或 answering/tool 相位）a 落「〔已中断：切换会话〕」+ phase 清终态；error/落定轮不动；幂等", () => {
    const rounds: BtwRound[] = [
      { q: "已答", a: "答案全文", phase: null }, // 落定终态——不动
      { q: "本地占位", a: null, phase: "answering" }, // sendBtwAsk 本地 push 形——永转「回答中…」的源头
      { q: "空文本帧", a: "", phase: "answering" }, // answering 帧空文本（a=''）同样永转——一并结算
      { q: "半程", a: "部分文本", phase: "answering" }, // 流中断前已有半程文本——保留追加不覆盖
      { q: "查证中", a: "已积累", phase: "tool" }, // tool 相位在飞
      { q: "失败", a: "坏了", phase: "error" }, // error 终态——不动
    ];
    expect(P.settleBtwRounds(rounds)).toBe(4);
    expect(rounds[0]).toEqual({ q: "已答", a: "答案全文", phase: null });
    expect(rounds[1]).toEqual({ q: "本地占位", a: "〔已中断：切换会话〕", phase: null });
    expect(rounds[2]).toEqual({ q: "空文本帧", a: "〔已中断：切换会话〕", phase: null });
    expect(rounds[3]).toEqual({ q: "半程", a: "部分文本\n〔已中断：切换会话〕", phase: null }); // 半程文本保留
    expect(rounds[4]).toEqual({ q: "查证中", a: "已积累\n〔已中断：切换会话〕", phase: null });
    expect(rounds[5]).toEqual({ q: "失败", a: "坏了", phase: "error" });
    expect(P.settleBtwRounds(rounds)).toBe(0); // 幂等——全终态再结算零改动
    expect(P.settleBtwRounds([])).toBe(0); // 空表零结算
  });

  it("F② btwTabHtml locked 门控态：textarea/发送钮/＋文件全 disabled + 「侧问绑定原会话」诚实提示行；未锁路径零 disabled 零提示行", () => {
    const locked = P.btwTabHtml({ rounds: [] }, true);
    expect(locked).toContain('<div class="btw-locked">侧问绑定原会话——切回后可继续发问</div>');
    expect(locked).toContain('<textarea id="btw-input" rows="2" disabled');
    expect(locked).toContain('id="btw-file" title="引用文件（= 输入 @）" disabled');
    expect(locked).toContain('class="sendbtn idle" id="btw-send" title="发送（Enter）" aria-label="发送" disabled');
    const open = P.btwTabHtml({ rounds: [{ q: "问", a: "答", phase: null }] }, false);
    expect(open).not.toContain("disabled");
    expect(open).not.toContain("btw-locked");
    expect(open).not.toContain("侧问绑定原会话");
    const plain = P.btwTabHtml({ rounds: [] }); // 旧单参调用兼容——缺省不锁
    expect(plain).not.toContain("disabled");
  });

  it("F③ switchTo 切走结算接线 + composer sid 门控接线（app.js 源锚定）", () => {
    // ② 切走结算：switchTo 捕获离去 sid → 关流后 currentSid 已换新时结算 + 活跃 btw tab 重渲刷门控
    const sw = APP.slice(APP.indexOf("function switchTo"), APP.indexOf("服务端游标同步"));
    expect(sw).toContain("var fromSid = currentSid"); // 离去会话判据在关流/换 currentSid 前捕获
    expect(sw).toContain("settleBtwOnSwitch(fromSid)");
    const settle = APP.slice(APP.indexOf("function settleBtwOnSwitch"), APP.indexOf("Pane.onBodyRender('btw'"));
    expect(settle).toContain("t.data.sid !== fromSid"); // 仅离去会话的 btw tab 结算——他 tab 不误伤
    expect(settle).toContain("Pane.settleBtwRounds(t.data.rounds)");
    expect(settle).toContain("Pane.activeTab() === t"); // 活跃者无论有无在飞轮都重渲——composer 门控即时生效（防旧表单滞留窗）
    expect(settle).toContain("rerenderBtwKeepingDraft()"); // 草稿保留
    // ① composer 门控：渲染器按 data.sid !== currentSid 出 locked 态（disabled 归 F② 纯函数面钉）
    const render = APP.slice(APP.indexOf("Pane.onBodyRender('btw'"), APP.indexOf("面板渲染（2s 轮询"));
    expect(render).toContain("var locked = data.sid !== currentSid");
    expect(render).toContain("Pane.btwTabHtml(data, locked)");
  });

  it("F④ 发送清空（Important#1）+ /btw 前缀口径统一（Minor#1）（app.js 源锚定）", () => {
    // 发送成功 push 轮次清空侧问框——清在保草稿重渲之前（rerenderBtwKeepingDraft 读到空草稿 → 空 textarea）
    const send = APP.slice(APP.indexOf("function sendBtwAsk"), APP.indexOf("function btwFeed"));
    const clearAt = send.indexOf("bi.value = ''");
    expect(clearAt).toBeGreaterThan(-1);
    expect(send.indexOf("rerenderBtwKeepingDraft()", clearAt)).toBeGreaterThan(clearAt); // 先清后渲
    expect(send.indexOf("rounds.push(rd)")).toBeLessThan(clearAt); // 仅本地 push 成功之后的路径清空——sid 空守卫早退（问文保留）不受影响
    // 前缀判定唯一口径：共享常量，截获存文与失败清存两处同源；indexOf 区分大小写版绝迹
    const pipe = APP.slice(APP.indexOf("发送管线"), APP.indexOf("function submit"));
    expect(pipe).toContain("var BTW_PREFIX_RE = /^\\/btw(\\s|$)/i");
    expect(pipe.match(/BTW_PREFIX_RE\.test\(text\)/g)).toHaveLength(2); // handleSendResponse 截获 + handleSendError 清存
    expect(APP).not.toContain("indexOf('/btw')");
  });

  it("F⑤ 切回解锁（W6复核修二）：A→B→A 回环后归属新 currentSid 的活跃 btw tab 重渲解锁——三重门 + GC7 签名门（app.js 源锚定）", () => {
    // switchTo 接线：切走结算之后跑解锁——离去 sid 的锁先由 settle 渲出（此路 sid 门先弹不叠渲），切回 sid 由 unlock 收
    const sw = APP.slice(APP.indexOf("function switchTo"), APP.indexOf("服务端游标同步"));
    const settleAt = sw.indexOf("settleBtwOnSwitch(fromSid)");
    const unlockAt = sw.indexOf("unlockBtwOnReturn()");
    expect(unlockAt).toBeGreaterThan(-1);
    expect(unlockAt).toBeGreaterThan(settleAt); // 结算在前——两向互斥（unlock 的 sid 门对离去 sid 早退）
    // 解锁函数：kind/sid 门 + 渲染签名门（.btw-locked 缺席零重渲）+ 保草稿重渲（与 settle 同口径）
    const unlock = APP.slice(APP.indexOf("function unlockBtwOnReturn"), APP.indexOf("Pane.onBodyRender('btw'"));
    expect(unlock).toContain("t.kind !== 'btw'"); // 仅 btw tab——agent tab 不误伤
    expect(unlock).toContain("t.data.sid !== currentSid"); // 仅归属新 currentSid 的 tab——settleBtwOnSwitch 刚渲的离去锁不在此路重渲
    expect(unlock).toContain("body.querySelector('.btw-locked')"); // 签名门：当前渲染确持锁态才重渲（GC7——首次归属渲染本就解锁，零触碰）
    expect(unlock).toContain("rerenderBtwKeepingDraft()"); // 草稿/焦点保留——与 settleBtwOnSwitch 同一口径
    expect(unlock).not.toContain("settleBtwRounds"); // 只解锁不结算——离去结算语义不被切回路径改坏
  });
});
