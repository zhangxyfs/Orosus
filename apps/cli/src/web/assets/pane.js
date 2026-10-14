/* Orosus web 详情分栏·选项卡机构（问题 2 W2——v2 原型 1244-1250/4390-4708 直裁）。
 * 结构分两段（render.js 同款纪律）：
 *   ① 纯函数区：tab 模型三件套 findTab/openOrSwitch/closeTabAt + 行 HTML 推导
 *      （tabRowHtml/dropRowsHtml/tabTitle——零 DOM 依赖，pane.test.ts node 直测）
 *      + W6 btw 纯函数段（btwTabSpec/applyBtwFrame/settleBtwRounds/btwTabHtml——实例铸造/帧归约/
 *      切走结算/内容 HTML 推导（含 locked 门控态），同零 DOM 依赖直测；DOM 事件绑定薄壳在 app.js
 *      的 onBodyRender('btw') 注册器内）；
 *   ② DOM 薄壳段：⌄ 全部选项卡下拉（搜索过滤 / 行点击切换 / 行尾 ×）+ ＋ 新建菜单（定位 clamp
 *      进选项卡条）+ tab 右键菜单（关闭 / 关闭其他 / 关闭所有——复用 #ctx-menu 单例模式）+
 *      renderTabs/activateTab/addTab/closeAt/onBodyRender 导出面（W3 子代理 tab / W6 btw tab 消费）。
 * 注入缝（W3 已接线 agent；W6 已接线 btw）：
 *   · OrosusPane.dotOf(tab)——状态点。缺省：btw ✦ / 其余 ◐ 兜底（v2 4404-4407 的缺省支）。
 *     W3 覆写为 agentTabDot（v2 4393-4396 口径：pendingApproval 独立布尔先行短路 ◉，
 *     映射本体 TASK_ICON 仅四态 queued○/running◐/completed✓/failed✗——v2 1598-1599）。
 *   · OrosusPane.plusSource()——＋菜单内容源：() → [{kind, id?, label, prefix?, open()}]。
 *     带 id = 实例行（已开的滤除——findTab < 0 才列出）；无 id = 类型行（每次点击开新实例，
 *     W6 的「✦ 侧问选项卡」即此类）。全开时禁用态文案「子代理均已打开」（v2 4688）。
 *   · OrosusPane.onBodyRender(kind, renderer)——内容渲染器注册：renderer(data, bodyEl)。
 *   · W6 只读口：tabsOf()（tab 快照）/ activeTab()（活跃 tab 对象）/ rerenderBody()（仅重渲
 *     内容区——btw 帧驱动重渲保草稿用，不重渲选项卡条）。
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

  /* ═══════════ btw 选项卡纯函数段（问题 2 W6——v2 4442-4452/4484-4507/4568-4588 直裁语义） ═══════════ */

  /* 圆弧旋转 spinner（app.js 同款标记自持一份——经典脚本零构建，不做跨件 import） */
  function btwSpin(size) {
    return '<svg class="spin-svg" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="40" stroke-dashoffset="16"/></svg>';
  }

  /** btwTabSpec(seq) -> addTab 规格（v2 openBtwTab 4443-4451：每次调用新实例——btw-N 自增 id、
   *  label「侧问 N」、data.rounds 各自独立数组。app.js 在 data 上补 sid 后 addTab）。 */
  function btwTabSpec(seq) {
    return { kind: 'btw', id: 'btw-' + seq, label: '侧问 ' + seq, data: { rounds: [] } };
  }

  /** applyBtwFrame(rounds, frame)——SSE btw 帧（W5 形 {tab, phase, text, round}）落到实例 rounds 的
   *  归约（原地改，返回同数组）：round 超前垫空 q 片（帧不带问题文本——重载/自动开 tab 后的对位）；
   *  answering 累积式文本 / tool 相位保文只换相位 / answer 终态清相位 / error 终态带文案。 */
  function applyBtwFrame(rounds, frame) {
    var list = rounds || [];
    var r = Math.max(1, frame && frame.round ? frame.round : 1);
    while (list.length < r) list.push({ q: '', a: null, phase: null });
    var rd = list[r - 1];
    if (frame.phase === 'answer') { rd.a = frame.text ?? ''; rd.phase = null; }
    else if (frame.phase === 'error') { rd.a = frame.text ?? ''; rd.phase = 'error'; }
    else if (frame.phase === 'tool') { rd.phase = 'tool'; } // 查证中——不覆盖已积累文本（下一轮 answering 重新累积）
    else if (frame.phase === 'thinking') { rd.think = frame.text ?? ''; if (rd.phase !== 'answering' && rd.phase !== 'tool') rd.phase = 'thinking'; } // 走查修②：思考流——正文已启不倒退
    else { rd.a = frame.text ?? ''; rd.phase = 'answering'; }
    return list;
  }

  /** settleBtwRounds(rounds) -> 结算数（W6复核修 Important#2②：切走结算——跨会话切换时在飞轮本地落终态）。
   *  在飞判据：a 空（null/undefined/''——本地 push 占位 {q,a:null} 与空文本 answering 帧都会永转
   *  「回答中…」）或 phase 为 answering/tool（半程文本冻结非终态）；error 终态不动。结算 = a 落中断
   *  标记（半程文本保留换行追加，不覆盖）+ phase 清 null（落定态——非 error：中断非失败）。
   *  幂等：全终态再结算零改动返回 0。零服务端往返（btw D6 零落盘无归档端点可查——本地结算即诚实口径）。 */
  function settleBtwRounds(rounds) {
    var list = rounds || [];
    var settled = 0;
    for (var i = 0; i < list.length; i++) {
      var rd = list[i];
      if (!rd || rd.phase === 'error') continue;
      var inFlight = rd.phase === 'answering' || rd.phase === 'tool' || rd.phase === 'thinking' || rd.a == null || rd.a === '';
      if (!inFlight) continue;
      rd.a = (rd.a ? rd.a + '\n' : '') + '〔已中断：切换会话〕';
      rd.phase = null;
      settled++;
    }
    return settled;
  }

  /** 单轮 HTML（v2 4492-4498 直裁 + 拍板相位态）：q 气泡复用 .msg-user（空 q 垫片不出空气泡）；
   *  .btw-a 回答区——error 终态 / 落定 markdown（走查修⑤：复用 OrosusRender.mdRender——主流同款
   *  marked+DOMPurify；node 测试态无 render.js 时降级 esc 纯文本）/ 回答中·查证中 spinner 相位
   *  （律二：在飞只攒纯文本，落定才整块 md 渲染——与主流 chunk→转正同律）。 */
  function btwMd(text) {
    var R = globalThis.OrosusRender;
    if (R && typeof R.mdRender === 'function') return R.mdRender(text);
    return esc(text);
  }
  function btwRoundHtml(rd) {
    var q = rd && rd.q ? String(rd.q) : '';
    var a = rd && rd.a != null ? String(rd.a) : '';
    var phase = rd && rd.phase ? rd.phase : null;
    var think = rd && rd.think ? String(rd.think) : '';
    var inFlight = phase === 'answering' || phase === 'tool' || phase === 'thinking';
    var bubble = q === '' ? '' :
      '<div class="msg-user"><div class="msg-bubble"><div class="msg-text">' + esc(q) + '</div></div></div>';
    /* 思考块（走查修②）：thinking 相位带走字提示；正文已启/落定后保留展示（主流思考块同款保留语义） */
    var thinkHtml = think === '' ? '' :
      '<div class="btw-think"><span class="dim">' + (phase === 'thinking' ? btwSpin(12) + ' 思考中…' : '思考过程') + '</span>' + esc(think) + '</div>';
    var body;
    if (phase === 'error') {
      body = '<span class="bad">侧问失败：' + esc(a) + '</span>';
    } else if (phase === 'thinking') {
      body = '';
    } else if (inFlight) {
      body = a !== '' ? esc(a) : '';
      if (phase === 'tool') body += (body !== '' ? '\n' : '') + btwSpin(12) + ' <span class="dim">查证中…</span>';
      else if (body === '') body = btwSpin(12) + ' <span class="dim">回答中…</span>';
    } else {
      body = a !== '' ? '<div class="md">' + btwMd(a) + '</div>' : '';
    }
    return '<div class="btw-round">' + bubble + thinkHtml + '<div class="btw-a">' + body + '</div></div>';
  }

  /** btwTabHtml(data, locked)——选项卡内容 HTML（v2 4484-4507 直裁）：.btw-scope 说明行 + .btw-stream
   *  rounds（空态 pane-blank）+ 裁剪版 composer（.ib-main ❯+textarea rows=2 + .ib-bar 左仅
   *  ＋文件〔= 插入 @〕、右 hint + 发送钮——去 mode/model/effort 三芯片，拍板第 4 条）。
   *  locked=true（W6复核修 Important#2①：composer 按 sid 门控）——textarea/发送钮/＋文件全 disabled
   *  + .btw-locked 诚实提示行「侧问绑定原会话——切回后可继续发问」（btw 帧只在归属会话的 SSE 流里，
   *  切走后发问将永无帧回填——杜绝新发问滞留）。
   *  hint 诚实口径「旁路 · 只读工具 · 走当前会话模型」——不照抄 v2 :4505 原文（「模型」一词与
   *  实现不符：btw 每次调用解析当前 provider/model，含 /model 覆盖也跟随——自创值登记④）。
   *  placeholder 同口径去「Ctrl + V 贴图」claim（POST /btw 无 imageIds 面——标签不得撒谎）。 */
  function btwTabHtml(data, locked) {
    var rounds = (data && data.rounds) || [];
    var lk = locked === true;
    var dis = lk ? ' disabled' : '';
    /* 走查修④：末轮在飞 → 发送钮变 ■ 停止（对齐主 composer 忙时换停止）。在飞口径与 app.js
     *  sendBtwAsk 尾弹判据同款：answering/tool 相位（半截文本也算）或 a 未回填且非 error 终态。 */
    var lastRd = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    var inFlight = !lk && !!lastRd && (lastRd.phase === 'answering' || lastRd.phase === 'tool' || lastRd.phase === 'thinking' || (lastRd.a == null && lastRd.phase !== 'error'));
    var html = '<div class="btw-wrap">' +
      '<div class="btw-scope">旁路侧问 · 只感知主对话（每轮重取最新历史）· 仅 Read/Grep/Glob 只读工具 · 不进主对话流、不落盘</div>' +
      '<div class="btw-stream" id="btw-stream">';
    if (rounds.length === 0) {
      html += '<div class="pane-blank">还没有侧问——在下方输入框直接提问，或主输入框 /btw &lt;问题&gt;<br/>带着主对话上下文，不打断正在进行的回答</div>';
    }
    for (var i = 0; i < rounds.length; i++) html += btwRoundHtml(rounds[i]);
    html += '</div>' +
      (lk ? '<div class="btw-locked">侧问绑定原会话——切回后可继续发问</div>' : '') +
      '<form class="btw-form" id="btw-form" autocomplete="off"><div class="inputbox">' +
      '<div class="ib-main"><span class="pchar" aria-hidden="true">❯</span>' +
      '<textarea id="btw-input" rows="2"' + dis + ' placeholder="继续追问——每轮重取最新主对话历史（@ 引用文件）…" aria-label="侧问输入框"></textarea></div>' +
      '<div class="ib-bar"><span class="cb-left"><button type="button" class="cb-chip" id="btw-file" title="引用文件（= 输入 @）"' + dis + '>＋ 文件</button></span>' +
      '<span class="cb-right"><span class="btw-hint">旁路 · 只读工具 · 走当前会话模型</span>' +
      (inFlight
        ? '<button type="button" class="sendbtn stop" id="btw-send" data-btwstop="1" title="停止本轮侧问" aria-label="停止">■</button>'
        : '<button type="submit" class="sendbtn idle" id="btw-send" title="发送（Enter）" aria-label="发送"' + dis + '>↑</button>') + '</span></div>' +
      '</div></form></div>';
    return html;
  }

  /* btwLiveUpdate(frame)（走查修②）：活跃 btw tab 在飞帧的增量渲染——answering/thinking 帧
   *  只改末轮 .btw-a / .btw-think 两元素（answering 节流 400ms 的渐进 md 解析），不再整体重渲
   *  （整渲每帧重建 composer textarea = 闪烁根因）；相位切换（tool）与终态（answer/error）仍走
   *  整体重渲。返回 true = 已增量处理（调用方免整渲）；false = 结构不匹配请整渲。
   *  近底自动跟随（>64px 视差不抢滚动）。DOM 面挂导出（node 测试只验存在性——行为走浏览器走查）。 */
  var btwLastLiveAt = 0;
  function btwLiveUpdate(frame) {
    var stream = document.getElementById('btw-stream');
    if (stream === null) return false;
    var rounds = stream.querySelectorAll('.btw-round');
    var last = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    if (last === null) return false;
    var aEl = last.querySelector('.btw-a');
    if (aEl === null) return false;
    if (frame.phase === 'thinking') {
      var tEl = last.querySelector('.btw-think');
      if (tEl === null) {
        tEl = document.createElement('div');
        tEl.className = 'btw-think';
        last.insertBefore(tEl, aEl);
      }
      tEl.innerHTML = '<span class="dim">' + btwSpin(12) + ' 思考中…</span>' + esc(frame.text || '');
      if (stream.scrollHeight - stream.scrollTop - stream.clientHeight < 64) stream.scrollTop = stream.scrollHeight;
      return true;
    }
    if (frame.phase === 'answering') {
      var now = Date.now();
      if (now - btwLastLiveAt < 400) return true; /* 节流：渐进 md 解析每 400ms 至多一次（终帧由 answer 整渲兜底） */
      btwLastLiveAt = now;
      var txt = frame.text || '';
      aEl.innerHTML = (txt !== '' ? '<div class="md">' + btwMd(txt) + '</div>' : '') + btwSpin(12) + ' <span class="dim">回答中…</span>';
      if (stream.scrollHeight - stream.scrollTop - stream.clientHeight < 64) stream.scrollTop = stream.scrollHeight;
      return true;
    }
    return false;
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
    /* W6：btw 选项卡纯函数 */
    btwTabSpec: btwTabSpec,
    applyBtwFrame: applyBtwFrame,
    settleBtwRounds: settleBtwRounds,
    btwLiveUpdate: btwLiveUpdate, /* 走查修②：在飞帧增量渲染（app.js btwFeed 消费——闪烁根除） */
    btwTabHtml: btwTabHtml,
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
  /* W6 只读口（btw 帧按 tab 分发消费）：tabsOf = tab 快照（复用空草稿 tab 搜索/帧落位查表）；
   *  activeTab = 活跃 tab 对象（帧分发判活跃——非活跃只改数据不触 DOM，GC7）；rerenderBody = 仅重渲
   *  内容区（帧驱动重渲保草稿——不重渲选项卡条，数据不变 DOM 零触碰）。 */
  P.tabsOf = function () { return tabs.slice(); };
  P.activeTab = function () { return tabs[activeTab] ?? null; };
  P.rerenderBody = renderPaneBody;

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
    return '<div class="ptd-search"><input id="ptd-q" type="text" placeholder="搜索标签页…" value="' + esc(q || '') + '" aria-label="搜索标签页"></div>' +
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
    /* 走查修③：禁用态脚注只在「内容源确曾提供实例行而全被滤除」时出现——plusSource 只给类型行
     *  （本批新形态：＋菜单只列「✦ 侧问」）时不显（恒显会误导成「子代理都在别处开着」）。 */
    if (agents.length > 0 && unopened.length === 0) html += '<button class="ctx-item" disabled>子代理均已打开</button>';
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
