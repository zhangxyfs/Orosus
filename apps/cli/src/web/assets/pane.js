/* Orosus web 详情分栏·选项卡机构（问题 2 W2——v2 原型 1244-1250/4390-4708 直裁）。
 * 结构分两段（render.js 同款纪律）：
 *   ① 纯函数区：tab 模型三件套 findTab/openOrSwitch/closeTabAt + 行 HTML 推导
 *      （tabRowHtml/dropRowsHtml/tabTitle——零 DOM 依赖，pane.test.ts node 直测）；
 *   ② DOM 薄壳段：⌄ 全部选项卡下拉（搜索过滤 / 行点击切换 / 行尾 ×）+ ＋ 新建菜单（定位 clamp
 *      进选项卡条）+ tab 右键菜单（关闭 / 关闭其他 / 关闭所有——复用 #ctx-menu 单例模式）+
 *      renderTabs/activateTab/addTab/closeAt/onBodyRender 导出面（W3 子代理 tab / W6 btw tab 消费）。
 * 注入缝（W3/W6 接线位）：
 *   · OrosusPane.dotOf(tab)——状态点。缺省：btw ✦ / 其余 ◐ 兜底（v2 4404-4407 的缺省支）。
 *     W3 覆写为 agentTabDot（v2 4393-4396 口径：pendingApproval 独立布尔先行短路 ◉，
 *     映射本体 TASK_ICON 仅四态 queued○/running◐/completed✓/failed✗——v2 1598-1599）。
 *   · OrosusPane.plusSource()——＋菜单内容源：() → [{kind, id?, label, prefix?, open()}]。
 *     带 id = 实例行（已开的滤除——findTab < 0 才列出）；无 id = 类型行（每次点击开新实例，
 *     W6 的「✦ 侧问选项卡」即此类）。全开时禁用态文案「子代理均已打开」（v2 4688）。
 *   · OrosusPane.onBodyRender(kind, renderer)——内容渲染器注册：renderer(data, bodyEl)。
 * 与 W1 的接合（不改 app.js——GC 本批文件面）：
 *   · W1 closePane 会整体清写 #pane-tabs 的 innerHTML（空态口径）——本壳 renderTabs 先
 *     ensureShell 自愈内部结构（⌄/列表/＋/两浮层五件）；事件全部委派在持久的 #pane-tabs 上，
 *     结构重建不掉线；
 *   · #pane 的 hidden 变更走 MutationObserver 对齐状态：外路关闭（◧ 顶栏收回）→ 状态复位
 *     （v2 closePane 4382-4386 同款：tabs 清空、activeTab=-1、两浮层收起）；外路打开 → 壳
 *     自愈后按需重渲（幂等）。
 * 显示互斥 = activateTab 只切 activeTab 重渲（打开并存、显示互斥——v2 4414-4420）。
 * 导出挂 globalThis.OrosusPane（浏览器 window === globalThis；node 测试同源可取）。 */
(function () {
  'use strict';

  /* ═══════════════════ ① 纯函数区（node 直测——不触 DOM） ═══════════════════ */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** findTab(tabs, kind, id) -> index | -1（v2 4390-4392）。kind 是身份的一部分——
   *  agent 与 btw 可同 id 共存（混合 kind 互不冲突）。 */
  function findTab(tabs, kind, id) {
    var list = tabs || [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t && t.kind === kind && t.id === id) return i;
    }
    return -1;
  }

  /** openOrSwitch(tabs, active, tab) -> { tabs, active, opened }（v2 4430-4451 open-or-switch 语义）：
   *  命中（同 kind+id 已开）→ 只激活不新增（幂等，opened=false，不改动原数组、不覆盖既有 label）；
   *  未命中 → 尾插 {kind,id,label,data?} 并激活（opened=true）。纯函数——返回新数组。
   *  data = 扩展数据槽（W6 btw 的问答轮存这里）。 */
  function openOrSwitch(tabs, active, tab) {
    var list = (tabs || []).slice();
    var hit = findTab(list, tab.kind, tab.id);
    if (hit >= 0) return { tabs: list, active: hit, opened: false };
    var t = { kind: tab.kind, id: tab.id, label: tab.label };
    if (tab.data !== undefined) t.data = tab.data;
    list.push(t);
    return { tabs: list, active: list.length - 1, opened: true };
  }

  /** closeTabAt(tabs, active, i) -> { tabs, active, empty }（v2 4421-4429 语义）：
   *  全关 → empty=true（调用方接 W1 closePane 收回分栏）、active=-1；
   *  active 越界（>= 余长）→ 收敛到新末位；关闭在 active 之前 → active 左移一位；
   *  i 越界 → 原样返回（empty 仅当本就空）。纯函数。 */
  function closeTabAt(tabs, active, i) {
    var list = (tabs || []).slice();
    if (i < 0 || i >= list.length) return { tabs: list, active: active, empty: list.length === 0 };
    list.splice(i, 1);
    if (list.length === 0) return { tabs: list, active: -1, empty: true };
    var a = active;
    if (a >= list.length) a = list.length - 1;
    else if (i < a) a = a - 1;
    return { tabs: list, active: a, empty: false };
  }

  /** tab 行 title 口径（v2 4409/4644）：btw → 「label（旁路 · 不进主对话）」；其余 → 「id · label」。 */
  function tabTitle(t) {
    return esc(t.kind === 'btw' ? t.label + '（旁路 · 不进主对话）' : t.id + ' · ' + t.label);
  }

  /** tab 条行 HTML（v2 4402-4412 直裁；dotOf 注入缝在此消费——span 行 + 行尾 ×）。 */
  function tabRowHtml(t, i, active, dotOf) {
    return '<span class="pt-item' + (i === active ? ' sel' : '') + '" data-pt="' + i + '" title="' + tabTitle(t) + '">' +
      dotOf(t) + '<span class="pt-label">' + esc(t.label) + '</span>' +
      '<button class="pt-x" data-ptx="' + i + '" title="关闭选项卡">✕</button></span>';
  }

  /** ⌄ 下拉行 HTML（v2 4635-4649 直裁）：q 过滤 label（小写包含）；空 / 无匹配双空态文案照抄。 */
  function dropRowsHtml(tabs, active, q, dotOf) {
    var list = tabs || [];
    if (list.length === 0) return '<div class="ptd-none">暂无打开的标签页——/tasks 开全部子代理 · ＋ 新建侧问</div>';
    var qq = (q || '').trim().toLowerCase();
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (qq && String(t.label == null ? '' : t.label).toLowerCase().indexOf(qq) < 0) continue;
      rows.push('<button class="ptd-row' + (i === active ? ' sel' : '') + '" data-ptd="' + i + '" title="' + tabTitle(t) + '">' +
        dotOf(t) + '<span class="ptd-label">' + esc(t.label) + '</span>' +
        '<span class="ptd-x" data-ptdx="' + i + '" title="关闭选项卡">✕</span></button>');
    }
    return rows.length ? rows.join('') : '<div class="ptd-none">无匹配的标签页</div>';
  }

  var P = {
    /* 纯函数（node 直测面） */
    findTab: findTab,
    openOrSwitch: openOrSwitch,
    closeTabAt: closeTabAt,
    tabTitle: tabTitle,
    tabRowHtml: tabRowHtml,
    dropRowsHtml: dropRowsHtml,
    esc: esc,
  };

  /* ═══════════════════ ② DOM 薄壳段（浏览器自举——node 下无 document 则整段惰置） ═══════════════════ */

  var tabs = [];          /* [{kind,id,label,data?}]——kind 可扩展（拍板第 2 条「类型可扩展」） */
  var activeTab = -1;     /* 显示互斥：唯一活跃下标（-1 = 空） */
  var bodyRenderers = {}; /* kind → renderer(data, bodyEl)——onBodyRender 注册 */
  var ctxTabIdx = -1;     /* 右键菜单目标下标（#ctx-menu 单例复用态） */
  var plusRows = [];      /* ＋菜单当前行（data-ptm 下标 → 行描述） */

  /* 注入缝缺省实现（W3 覆写 OrosusPane.dotOf 换 agentTabDot；见文件头注） */
  P.dotOf = function (tab) {
    if (tab && tab.kind === 'btw') return '<span class="pt-dot info">✦</span>';
    return '<span class="pt-dot st-run">◐</span>';
  };
  /* ＋菜单内容源（W3/W6 注入；null = 尚无可开项——菜单只剩禁用态行） */
  P.plusSource = null;
  /* 内容渲染器注册：onBodyRender('agent', function (data, bodyEl) { … })——未注册 kind 显示占位 */
  P.onBodyRender = function (kind, renderer) {
    if (typeof kind === 'string' && typeof renderer === 'function') bodyRenderers[kind] = renderer;
  };

  /* W1 导出面（app.js 载入后齐备——交互期恒可用；pane.js 先于 app.js 载入故须惰取） */
  function ui() { return globalThis.OrosusUI || {}; }

  var paneEl = null, paneTabsEl = null, paneBodyEl = null, ctxMenuEl = null;
  var ptListEl = null, ptAddEl = null, ptMenuEl = null, ptDropEl = null;

  /* #pane-tabs 内部结构（v2 1244-1250 直裁；W1 closePane 整写 innerHTML 后由 ensureShell 自愈） */
  function shellHtml() {
    return '<button class="pt-chev" id="pt-chev" title="查看全部选项卡（搜索 / 切换 / 关闭）"><svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 2.6 6 6.1 9.5 2.6"/><path d="M2.5 6.4 6 9.9 9.5 6.4"/></svg></button>' +
      '<div class="pt-list" id="pt-list"><span class="pt-empty">暂无打开的选项卡</span></div>' +
      '<button class="pt-add" id="pt-add" title="新建选项卡（类型可扩展）">＋</button>' +
      '<div class="pt-menu" id="pt-menu" hidden></div>' +
      '<div class="pt-drop" id="pt-drop" hidden></div>';
  }
  function grabShell() {
    ptListEl = paneTabsEl.querySelector('#pt-list');
    ptAddEl = paneTabsEl.querySelector('#pt-add');
    ptMenuEl = paneTabsEl.querySelector('#pt-menu');
    ptDropEl = paneTabsEl.querySelector('#pt-drop');
  }
  /* 壳自愈：#pt-list 不在（被 W1 closePane 清写）→ 重建五件套。返回是否重建过。 */
  function ensureShell() {
    if (paneTabsEl.querySelector('#pt-list')) return false;
    paneTabsEl.innerHTML = shellHtml();
    grabShell();
    return true;
  }

  /* ── 渲染面 ── */
  function renderTabs() {
    ensureShell();
    if (tabs.length === 0) {
      ptListEl.innerHTML = '<span class="pt-empty">暂无打开的选项卡</span>';
      return;
    }
    var html = '';
    for (var i = 0; i < tabs.length; i++) html += tabRowHtml(tabs[i], i, activeTab, P.dotOf);
    ptListEl.innerHTML = html;
  }
  function renderPaneBody() {
    var t = tabs[activeTab];
    if (!t) {
      paneBodyEl.innerHTML = '<div class="pane-blank">分栏已打开，暂无选项卡<br/>/tasks = 为每个子代理各开一个选项卡 · 点击主流中的子代理条目 · ＋ 新建侧问</div>';
      return;
    }
    var r = bodyRenderers[t.kind];
    paneBodyEl.innerHTML = '';
    if (r) r(t.data, paneBodyEl);
    else paneBodyEl.innerHTML = '<div class="pane-blank">「' + esc(t.kind) + '」类型尚无内容渲染器——onBodyRender 注册</div>';
  }

  /* ── 导出面四方法（brief Interfaces 逐字契约） ── */
  P.renderTabs = renderTabs;
  /* 显示互斥：只切 activeTab 重渲（v2 4414-4420） */
  P.activateTab = function (i) {
    if (i < 0 || i >= tabs.length) return;
    activeTab = i;
    renderTabs();
    renderPaneBody();
    refreshDrop();
  };
  /* open-or-switch + 开分栏（v2 openAgentTab/openBtwTab 4431-4451 同构）；返回 {tabs,active,opened} */
  P.addTab = function (spec) {
    var res = openOrSwitch(tabs, activeTab, spec);
    tabs = res.tabs;
    activeTab = res.active;
    var op = ui().openPane;
    if (op) op(); /* v2 openPane 幂等——已开早退 */
    ensureShell();
    renderTabs();
    renderPaneBody();
    return res;
  };
  /* 全关 → empty → W1 closePane 收回分栏（v2 4421-4429：closeTabAt 全空即 closePane） */
  P.closeAt = function (i) {
    var res = closeTabAt(tabs, activeTab, i);
    tabs = res.tabs;
    activeTab = res.active;
    if (res.empty) {
      var cp = ui().closePane;
      if (cp) cp(); /* 状态复位/壳自愈由 #pane hidden 的 MutationObserver 兜（外路 ◧ 收回同款） */
      else { renderTabs(); renderPaneBody(); }
      return res;
    }
    renderTabs();
    renderPaneBody();
    refreshDrop();
    return res;
  };

  /* ── ⌄ 全部选项卡下拉（v2 4634-4677 直裁） ── */
  function dropHtml(q) {
    return '<div class="ptd-search"><input id="ptd-q" type="text" placeholder="搜索标签页…" value="' + esc(q || '').replace(/"/g, '&quot;') + '" aria-label="搜索标签页"></div>' +
      '<div class="ptd-sec">打开的标签页</div><div class="ptd-rows" id="ptd-rows">' + dropRowsHtml(tabs, activeTab, q, P.dotOf) + '</div>';
  }
  function renderDrop(q) {
    ptDropEl.innerHTML = dropHtml(q);
    var inp = ptDropEl.querySelector('#ptd-q');
    if (inp) inp.focus();
  }
  /* 下拉开着时 tab 集或活跃位变化 → 行区重渲（保留搜索词——v2 refreshPtDrop 4660-4664） */
  function refreshDrop() {
    if (!ptDropEl || ptDropEl.hidden) return;
    var inp = ptDropEl.querySelector('#ptd-q');
    var rowsEl = ptDropEl.querySelector('#ptd-rows');
    if (rowsEl) rowsEl.innerHTML = dropRowsHtml(tabs, activeTab, inp ? inp.value : '', P.dotOf);
  }

  /* ── ＋ 新建菜单（v2 4679-4704 直裁：类型行 + 未开实例行；全开禁用态） ── */
  function openPlusMenu() {
    if (!ptMenuEl.hidden) { ptMenuEl.hidden = true; return; } /* 再点 ＝ 收 */
    ptDropEl.hidden = true; /* 两浮层互斥 */
    var entries = typeof P.plusSource === 'function' ? (P.plusSource() || []) : [];
    var types = [], agents = [];
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      if (!en || !en.kind) continue;
      if (en.id === null || en.id === undefined) types.push(en);
      else agents.push(en);
    }
    var unopened = [];
    for (var j = 0; j < agents.length; j++) {
      if (findTab(tabs, agents[j].kind, agents[j].id) < 0) unopened.push(agents[j]);
    }
    plusRows = types.concat(unopened);
    var html = '';
    for (var k = 0; k < plusRows.length; k++) {
      html += '<button class="ctx-item" data-ptm="' + k + '">' + (plusRows[k].prefix || '') + esc(plusRows[k].label || '') + '</button>';
    }
    if (unopened.length === 0) html += '<button class="ctx-item" disabled>子代理均已打开</button>';
    ptMenuEl.innerHTML = html;
    ptMenuEl.hidden = false;
    /* 定位 clamp（v2 4690-4696 直裁）：右缘对齐 ＋ 按钮，再双向夹取，保证弹层完整落在选项卡条内 */
    var r = ptAddEl.getBoundingClientRect();
    var pr = paneTabsEl.getBoundingClientRect();
    var mw = ptMenuEl.offsetWidth;
    var left = Math.min(r.right - pr.left - mw, pr.width - mw - 4);
    ptMenuEl.style.left = Math.max(4, left) + 'px';
  }

  /* ── tab 右键菜单（v2 4598-4632 直裁——复用 #ctx-menu 单例）──
   *  命名空间 data-ptctx 与 app.js 的 data-ctx 派发隔离（app.js 派发器对无 data-ctx 的行早退）；
   *  外击关闭由 app.js 既有的 document 级 #ctx-menu 收隐监听兜底。 */
  function openTabCtxMenu(i, x, y) {
    ctxTabIdx = i;
    var onlyOne = tabs.length <= 1; /* 仅剩一个标签时「关闭其他标签」禁用（v2 4603/4606） */
    ctxMenuEl.innerHTML =
      '<button class="ctx-item" data-ptctx="close">关闭标签</button>' +
      '<button class="ctx-item" data-ptctx="close-others"' + (onlyOne ? ' disabled' : '') + '>关闭其他标签</button>' +
      '<button class="ctx-item" data-ptctx="close-all">关闭所有标签</button>';
    ctxMenuEl.hidden = false;
    ctxMenuEl.style.left = Math.min(x, window.innerWidth - 150) + 'px';
    ctxMenuEl.style.top = Math.min(y, window.innerHeight - 130) + 'px';
  }
  function tabCtxAct(act) {
    var i = ctxTabIdx;
    ctxTabIdx = -1;
    if (i < 0 || i >= tabs.length) return;
    if (act === 'close') P.closeAt(i);
    else if (act === 'close-others') {
      tabs = [tabs[i]];
      activeTab = 0;
      renderTabs();
      renderPaneBody();
      refreshDrop();
    } else if (act === 'close-all') {
      var cp = ui().closePane;
      if (cp) cp(); /* 选项卡全关 → 分栏自动收回（v2 4623；状态复位由 observer 兜） */
    }
  }

  /* ── 接线：全部委派在持久的 #pane-tabs / #ctx-menu 上——壳重建不掉线（见文件头注） ── */
  function bindShell() {
    paneTabsEl.addEventListener('click', function (e) {
      if (e.target.closest('#pt-add')) { openPlusMenu(); return; }
      if (e.target.closest('#pt-chev')) {
        if (!ptDropEl.hidden) { ptDropEl.hidden = true; return; }
        ptMenuEl.hidden = true; /* 两浮层互斥 */
        renderDrop('');
        ptDropEl.hidden = false;
        return;
      }
      var m = e.target.closest('[data-ptm]'); /* ＋菜单行 */
      if (m) {
        ptMenuEl.hidden = true;
        var row = plusRows[parseInt(m.getAttribute('data-ptm'), 10)];
        if (row && row.open) row.open();
        return;
      }
      var dx = e.target.closest('[data-ptdx]'); /* ⌄ 下拉行尾 × */
      if (dx) { P.closeAt(parseInt(dx.getAttribute('data-ptdx'), 10)); return; }
      var drow = e.target.closest('[data-ptd]'); /* ⌄ 下拉行点击切换 */
      if (drow) {
        P.activateTab(parseInt(drow.getAttribute('data-ptd'), 10));
        ptDropEl.hidden = true;
        return;
      }
      var x = e.target.closest('[data-ptx]'); /* tab 条行尾 × */
      if (x) { P.closeAt(parseInt(x.getAttribute('data-ptx'), 10)); return; }
      var item = e.target.closest('[data-pt]'); /* tab 条点击切换 */
      if (item) P.activateTab(parseInt(item.getAttribute('data-pt'), 10));
    });
    paneTabsEl.addEventListener('contextmenu', function (e) {
      var item = e.target.closest('[data-pt]');
      if (!item) return;
      e.preventDefault();
      ptDropEl.hidden = true;
      ptMenuEl.hidden = true;
      openTabCtxMenu(parseInt(item.getAttribute('data-pt'), 10), e.clientX, e.clientY);
    });
    /* ⌄ 搜索框：input 重渲行区（保留焦点）、keydown 不外溢全局快捷键（v2 4653-4657） */
    paneTabsEl.addEventListener('input', function (e) {
      if (!ptDropEl || e.target.id !== 'ptd-q') return;
      var rowsEl = ptDropEl.querySelector('#ptd-rows');
      if (rowsEl) rowsEl.innerHTML = dropRowsHtml(tabs, activeTab, e.target.value, P.dotOf);
    });
    paneTabsEl.addEventListener('keydown', function (e) {
      if (e.target.id === 'ptd-q') e.stopPropagation();
    });
    /* 右键单例派发（app.js 的 data-ctx 派发器对本命名空间早退；stopPropagation 不外溢） */
    ctxMenuEl.addEventListener('click', function (e) {
      var item = e.target.closest('[data-ptctx]');
      if (!item) return;
      e.stopPropagation();
      ctxMenuEl.hidden = true;
      tabCtxAct(item.getAttribute('data-ptctx'));
    });
    /* 点击浮层外部 = 关闭（v2 4705-4708；#ctx-menu 的外击收隐由 app.js 既有监听兜） */
    document.addEventListener('click', function (e) {
      if (!ptMenuEl.hidden && !e.target.closest('#pt-menu') && !e.target.closest('#pt-add')) ptMenuEl.hidden = true;
      if (!ptDropEl.hidden && !e.target.closest('#pt-drop') && !e.target.closest('#pt-chev')) ptDropEl.hidden = true;
    });
    /* #pane hidden 变更对齐（外路开合——◧ 顶栏按钮 / W3 cmdTasks）：关 = 状态复位（v2 closePane
     * 4382-4386 同款）；开 = 壳自愈后按需重渲（重建过才渲——addTab 路径已渲，避免二次重渲） */
    new MutationObserver(function () {
      if (paneEl.hidden) {
        tabs = [];
        activeTab = -1;
        ctxTabIdx = -1;
        if (ptMenuEl) ptMenuEl.hidden = true;
        if (ptDropEl) ptDropEl.hidden = true;
        ensureShell();
        renderTabs();
      } else if (ensureShell()) {
        renderTabs();
        renderPaneBody();
      }
    }).observe(paneEl, { attributes: true, attributeFilter: ['hidden'] });
  }

  function initShell() {
    paneEl = document.getElementById('pane');
    paneTabsEl = document.getElementById('pane-tabs');
    paneBodyEl = document.getElementById('pane-body');
    ctxMenuEl = document.getElementById('ctx-menu');
    if (!paneEl || !paneTabsEl || !paneBodyEl || !ctxMenuEl) return;
    grabShell(); /* index.html 已带五件套；缺失（W1 清写后刷新前不应发生）由 ensureShell 自愈 */
    bindShell();
  }
  if (typeof document !== 'undefined') initShell();

  globalThis.OrosusPane = P;
})();
