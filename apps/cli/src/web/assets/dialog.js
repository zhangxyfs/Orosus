/** OrosusDialog —— web-dialog 批 T7 前端纯函数核（设计 §6.5/§8/§8.1）。
 *  结构（pane.js 同模式）：① 纯函数段——node 可测（vitest 直 import，dialog-frontend.test.ts），
 *  不碰 DOM；② DOM 薄壳段（T8——`typeof document` 守卫，node 下惰置）。
 *  加载序（index.html 静态链）：api.js 之后（esc/fetchJson）、ui.js/app.js 之前。
 *  CSP 纪律：渲染产物只含类名与 data-* 属性——动态几何（进度条填充、列宽权重、layout 变量）由
 *  DOM 段经 style.setProperty 落 CSS 变量，绝不产内联样式属性串。 */
(function () {
  'use strict';

  /* ── 转义：浏览器走 OrosusAPI.esc 正主（api.js:126 五替换全量实体转义）；fallback 是同款逐字
   *    镜像，仅供 node 直 import 的测试路径（api.js 未加载时行为一致）——模块原文一律过此口。 ── */
  var esc = function (s) {
    var a = globalThis.OrosusAPI;
    if (a && typeof a.esc === 'function') return a.esc(String(s == null ? '' : s));
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /* ═══════════ ① 控件渲染（设计 §8.2 八类）═══════════
   * state = { selById: {<wid>: index}, focusedId?: wid }——interactive list 的选中/焦点态；
   * 空列表占位「（空）」（空白登记 #3）；progress 钳 0-1、max<=0 按 1 防除零。 */
  function widgetHtml(w, state) {
    state = state || {};
    switch (w.kind) {
      case 'text': {
        var cls = 'dw dw-text';
        if (w.style) cls += ' dw-' + esc(w.style);
        if (w.wrap === 'none') cls += ' dw-nowrap';
        return '<div class="' + cls + '" data-wid="' + esc(w.id) + '">' + esc(w.text) + '</div>';
      }
      case 'kv':
        return '<div class="dw dw-kv" data-wid="' + esc(w.id) + '"><span class="dw-k">' + esc(w.label) + '</span><span class="dw-v">' + esc(w.value) + '</span></div>';
      case 'sep':
        return '<div class="dw dw-sep" data-wid="' + esc(w.id) + '"></div>';
      case 'list': {
        var open = '<ul class="dw dw-list' + (w.interactive ? ' dw-interactive' : '') + '" data-wid="' + esc(w.id) + '">';
        var items = w.items || [];
        if (items.length === 0) return open + '<li class="dw-empty">' + OrosusI18N.t('web.common.empty') + '</li></ul>';
        var rows = items.map(function (it, i) {
          var rc = 'dw-row';
          if (w.interactive) {
            if (state.selById && state.selById[w.id] === i) rc += ' dw-sel';
            if (state.focusedId === w.id) rc += ' dw-focus';
          }
          /* 结构行（2026-10-16 用户走查）：{ text, note } → dw-cols 双栏——左主文占满截断、右窄注（时间类）贴右 */
          var body;
          if (it !== null && typeof it === 'object') {
            rc += ' dw-cols';
            body = '<span class="dw-cell">' + esc(it.text ?? '') + '</span>' + (it.note ? '<span class="dw-note">' + esc(it.note) + '</span>' : '');
          } else {
            body = esc(it);
          }
          return '<li class="' + rc + '"' + (w.interactive ? ' data-idx="' + i + '"' : '') + '>' + body + '</li>';
        });
        return open + rows.join('') + '</ul>';
      }
      case 'progress': {
        var max = (typeof w.max === 'number' && isFinite(w.max) && w.max > 0) ? w.max : 1;
        var v = (typeof w.value === 'number' && isFinite(w.value)) ? w.value / max : 0;
        var pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
        return '<div class="dw dw-progress" data-wid="' + esc(w.id) + '"><div class="dw-bar" data-fill="' + pct + '"></div><span class="dw-num">' + pct + '%</span></div>';
      }
      case 'input': {
        var rws = (typeof w.lines === 'number' && w.lines > 0) ? Math.floor(w.lines) : (w.multiline ? 3 : 1);
        var submit = enterActivates(w);
        return '<div class="dw dw-input" data-wid="' + esc(w.id) + '">' +
          (w.label ? '<label class="dw-il">' + esc(w.label) + '</label>' : '') +
          '<textarea class="dw-field" rows="' + rws + '"' + (w.placeholder ? ' placeholder="' + esc(w.placeholder) + '"' : '') +
          ' data-submit="' + (submit ? '1' : '0') + '" data-multiline="' + (w.multiline ? '1' : '0') + '"></textarea></div>';
      }
      case 'columns': {
        var weights = (w.widths && w.widths.length > 0) ? w.widths.join(',') : '';
        var cols = (w.cols || []).map(function (col) {
          return '<div class="dw-col">' + (col || []).map(function (cw) { return widgetHtml(cw, state); }).join('') + '</div>';
        });
        return '<div class="dw dw-cols' + (weights ? '' : ' dw-eq') + '" data-wid="' + esc(w.id) + '"' +
          (weights ? ' data-weights="' + esc(weights) + '"' : '') + '>' + cols.join('') + '</div>'; /* widths 作列宽权重——DOM 段落 CSS 变量 */
      }
      case 'table': {
        var head = '<tr>' + (w.head || []).map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>';
        var body = (w.rows || []).map(function (row) {
          return '<tr>' + (row || []).map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
        }).join('');
        return '<table class="dw dw-table" data-wid="' + esc(w.id) + '"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
      }
    }
    return '';
  }
  function widgetsHtml(ws, state) { return (ws || []).map(function (w) { return widgetHtml(w, state); }).join(''); }

  /* ═══════════ ② layout 语义映射（设计 §8.1）═══════════
   * 返回 { cls, css }——cls 类名档、css 为 CSS 变量名→值映射（DOM 段 setProperty 落地）；返回
   * null = dock/未指定（不进大窗路径，viewText 走原 .popup）。非法值整体回落 center80（对齐 TUI
   * fallbackReason:"invalid"）：负边距、非百分比串、百分比出界。格数近似（空白登记 #2）：宽 1 格 =
   * 1ch、高 1 行 = var(--dlg-row-h)；边距三档直译 TUI（对边同给=边距间居中 / 单边=贴边 / 都不给=
   * 容器居中）。 */
  var PCT = /^(\d+(?:\.\d+)?)%$/;
  var INVALID = { invalid: true };

  function pctValue(s) {
    var m = PCT.exec(String(s));
    if (!m) return INVALID;
    var v = Number(m[1]);
    if (!(v >= 0) || v > 100) return INVALID;
    return v;
  }
  function marginCss(v) { /* 契约边距是纯 number：负数非法、格数近似 1ch */
    if (v === undefined) return undefined;
    if (typeof v === 'number' && isFinite(v) && v >= 0) return 'calc(' + Math.floor(v) + ' * 1ch)';
    return INVALID;
  }

  function mapLayout(layout) {
    if (layout === 'center80') return { cls: 'dlg-center80', css: null };
    if (layout === 'full') return { cls: 'dlg-full', css: null };
    if (layout === undefined || layout === null || layout === 'dock') return null;
    if (typeof layout !== 'object') return { cls: 'dlg-center80', css: null };
    var css = {};
    if (layout.width !== undefined) {
      if (typeof layout.width === 'number' && isFinite(layout.width) && layout.width > 0) css['--dlg-w'] = 'calc(' + Math.floor(layout.width) + ' * 1ch)';
      else if (typeof layout.width === 'string') { var p = pctValue(layout.width); if (p === INVALID) return { cls: 'dlg-center80', css: null }; css['--dlg-w'] = p + '%'; }
      else return { cls: 'dlg-center80', css: null };
    }
    if (layout.height !== undefined) {
      if (typeof layout.height === 'number' && isFinite(layout.height) && layout.height > 0) css['--dlg-h'] = 'calc(' + Math.floor(layout.height) + ' * var(--dlg-row-h))';
      else if (typeof layout.height === 'string') { var p2 = pctValue(layout.height); if (p2 === INVALID) return { cls: 'dlg-center80', css: null }; css['--dlg-h'] = p2 + '%'; }
      else return { cls: 'dlg-center80', css: null };
    }
    var ms = marginCss(layout.marginStart), me = marginCss(layout.marginEnd);
    var mt = marginCss(layout.marginTop), mb = marginCss(layout.marginBottom);
    if (ms === INVALID || me === INVALID || mt === INVALID || mb === INVALID) return { cls: 'dlg-center80', css: null };
    if (ms === undefined && me === undefined && mt === undefined && mb === undefined) {
      css['--dlg-x'] = 'auto';
      css['--dlg-y'] = 'auto';
    } else {
      css['--dlg-x'] = 'auto';  /* 单轴给边距时另一轴容器居中 */
      css['--dlg-y'] = 'auto';
      if (ms !== undefined && me !== undefined) { css['--dlg-left'] = ms; css['--dlg-right'] = me; css['--dlg-x'] = 'between'; }
      else if (ms !== undefined) { css['--dlg-left'] = ms; css['--dlg-x'] = 'start'; }
      else if (me !== undefined) { css['--dlg-right'] = me; css['--dlg-x'] = 'end'; }
      if (mt !== undefined && mb !== undefined) { css['--dlg-top'] = mt; css['--dlg-bottom'] = mb; css['--dlg-y'] = 'between'; }
      else if (mt !== undefined) { css['--dlg-top'] = mt; css['--dlg-y'] = 'start'; }
      else if (mb !== undefined) { css['--dlg-bottom'] = mb; css['--dlg-y'] = 'end'; }
    }
    return { cls: 'dlg-custom', css: css };
  }

  /* ═══════════ ③ 键盘规则纯函数（设计 §8.3）═══════════ */
  function nextIndex(len, cur, dir) { /* ↑↓ 序号推进（循环）；越界/缺失当前值归边 */
    if (!(len > 0)) return -1;
    if (cur === undefined || cur === null || cur < 0 || cur >= len) return dir > 0 ? 0 : len - 1;
    return (cur + (dir > 0 ? 1 : -1) + len) % len;
  }
  function enterActivates(w) { /* 单行 Enter=激活；多行 Enter=换行，仅 enterSubmit 激活 */
    return !!(w && (w.multiline ? w.enterSubmit === true : true));
  }

  /* ═══════════ ④ 事件队列协调器（设计 §6.5）═══════════
   * 每 dialog 一条 FIFO promise 链：事件严格按产生顺序发送；选择/输入先本地乐观更新（apply 回调）；
   * 单个请求失败 toast 但队列继续；失败不推进 maxAckRevision；链排空时 onDrained(id, maxAck)——
   * 渲染层据此按「不小于最大已确认 revision」的最新快照协调一次，未被覆盖的失败本地修改随重画回滚；
   * close 走同链尾 = 排在先前事件之后。frameAllowed(id) = 队列清空与否——未清空不用较旧 SSE 快照
   * 覆盖未确认的输入或选择。 */
  function createEventQueue(opts) {
    var post = opts.post, toast = opts.toast, onDrained = opts.onDrained;
    var dialogs = new Map();
    var st = function (id) {
      if (!dialogs.has(id)) dialogs.set(id, { tail: Promise.resolve(), pending: 0, maxAck: 0 });
      return dialogs.get(id);
    };
    var enqueue = function (id, body, optimistic) {
      var s = st(id);
      if (optimistic && typeof optimistic.apply === 'function') optimistic.apply();
      s.pending += 1;
      s.tail = s.tail.then(function () {
        return post(body).then(function (r) {
          s.pending -= 1;
          if (r && r.ok && typeof r.revision === 'number' && r.revision > s.maxAck) s.maxAck = r.revision;
          if (s.pending === 0 && typeof onDrained === 'function') onDrained(id, s.maxAck);
        }, function () {
          s.pending -= 1;
          if (typeof toast === 'function') toast();
          if (s.pending === 0 && typeof onDrained === 'function') onDrained(id, s.maxAck);
        });
      });
    };
    return {
      send: function (id, body, optimistic) { enqueue(id, body, optimistic); },
      close: function (id, body) { enqueue(id, body, null); },
      frameAllowed: function (id) { var s = dialogs.get(id); return s === undefined || s.pending === 0; },
      maxAck: function (id) { var s = dialogs.get(id); return s === undefined ? 0 : s.maxAck; },
    };
  }

  /* ═══════════ ⑤ DOM 薄壳段（T8——浏览器自举；node 无 document 整段惰置） ═══════════
   *  #dlg-overlay > .dlg-modal（index.html 静态节点——assets-check 可断言）。帧驱动：onFrame(open/
   *  update/close)；Esc/✕ 只发 {close:true}——关窗确认以服务端广播的 close 帧为准（设计 §10 不伪造）；
   *  点击遮罩不关窗（§8.1 防表单误触）；↑↓/Enter/点击行 → select/activate；Tab 在可聚焦控件间循环；
   *  窗内键盘 stopPropagation 不进 composer。unmount() = 本地清理（切会话）；上行口经 wire() 由
   *  app.js 注入（sid 在事件入队时捕获——切会话后在途事件仍回旧会话端点，对端幂等 noop）。 */
  var dom = null;
  if (typeof document !== 'undefined') (function () {
    var overlayEl = null, modalEl = null;
    var cur = null;        /* { id, sid, widgets, selById, focusedId } */
    var queue = null;      /* createEventQueue 实例（wire 时建） */
    var latestFrame = null;
    var postFn = null, getSid = null, toastFn = null, onUserCloseFn = null;
    var retiredIds = {};   /* unmount 后不再上行的 dialog id（挂起队列静默收尾——不发 HTTP） */

    function ensureDom() {
      if (overlayEl !== null) return true;
      overlayEl = document.getElementById('dlg-overlay');
      if (!overlayEl) return false;
      modalEl = overlayEl.querySelector('.dlg-modal');
      overlayEl.addEventListener('click', function () { /* 点击遮罩不关窗（设计 §8.1） */ });
      modalEl.addEventListener('keydown', onKey);
      modalEl.addEventListener('click', onClick);
      modalEl.addEventListener('focusin', function (e) {
        if (!cur || !e.target || !e.target.closest) return;
        var host = e.target.closest('[data-wid]');
        if (host) cur.focusedId = host.getAttribute('data-wid');
      });
      modalEl.addEventListener('input', function (e) {
        if (!cur || !e.target.classList || !e.target.classList.contains('dw-field')) return;
        var host = e.target.closest('[data-wid]');
        if (!host) return;
        sendEvent({ type: 'input', id: host.getAttribute('data-wid'), text: e.target.value }); /* 每键一回不防抖（契约口径） */
      });
      return true;
    }

    /* 渲染。kind：open/all = 全新（清选择输入焦点回顶）；selection = 换清单滚回顶（按同 id 保留输入与
     * 焦点）；none/server = 保滚动，none 另保留输入、server 用服务端值覆盖输入（排空协调回滚失败本地修改）。 */
    function render(kind) {
      if (!cur || !modalEl) return;
      var bodyEl = modalEl.querySelector('.dlg-body');
      var keepInputs = kind === 'selection' || kind === 'none';
      var inputs = keepInputs ? harvestInputs() : {};
      var scrollTop = (kind === 'none' || kind === 'server') && bodyEl ? bodyEl.scrollTop : 0;
      var focusWid = keepInputs && document.activeElement && document.activeElement.closest
        ? widOf(document.activeElement.closest('[data-wid]')) : null;
      if (kind === 'selection' || kind === 'all' || kind === 'open') cur.selById = {};
      bodyEl.innerHTML = widgetsHtml(cur.widgets, cur);
      applyGeometries(bodyEl);
      if (keepInputs) restoreInputs(inputs);
      if (focusWid !== null) refocus(focusWid);
      if (kind === 'open' || kind === 'all') focusFirst();
      if (scrollTop > 0 && bodyEl) bodyEl.scrollTop = scrollTop;
    }

    function harvestInputs() {
      var m = {};
      if (!modalEl) return m;
      var fields = modalEl.querySelectorAll('.dw-field');
      for (var i = 0; i < fields.length; i++) {
        var host = fields[i].closest('[data-wid]');
        if (host) m[host.getAttribute('data-wid')] = fields[i].value;
      }
      return m;
    }
    function restoreInputs(m) {
      var fields = modalEl.querySelectorAll('.dw-field');
      for (var i = 0; i < fields.length; i++) {
        var host = fields[i].closest('[data-wid]');
        var wid = host ? host.getAttribute('data-wid') : null;
        if (wid && Object.prototype.hasOwnProperty.call(m, wid)) fields[i].value = m[wid];
      }
    }
    function widOf(host) { return host ? host.getAttribute('data-wid') : null; }
    function refocus(wid) {
      if (!modalEl || wid === null) return;
      var hosts = modalEl.querySelectorAll('[data-wid]');
      for (var i = 0; i < hosts.length; i++) {
        if (hosts[i].getAttribute('data-wid') !== wid) continue;
        var f = hosts[i].querySelector('.dw-field');
        if (f) { f.focus(); return; }
      }
    }
    function focusFirst() {
      if (!modalEl) return;
      var f = modalEl.querySelector('.dw-field');
      if (f) f.focus();
      else modalEl.focus(); /* 窗体自持焦点（键盘事件落位——modal 无 tabindex 时 focus() 无效则落 body，Esc 仍有 overlay 级兜底） */
    }

    /* CSP 纪律的几何落地：进度条宽度、列宽权重——HTML 只带 data-*，这里走 CSSOM setProperty */
    function applyGeometries(root) {
      var bars = root.querySelectorAll('.dw-bar');
      for (var i = 0; i < bars.length; i++) bars[i].style.setProperty('width', (bars[i].getAttribute('data-fill') || '0') + '%');
      var colsEls = root.querySelectorAll('.dw-cols[data-weights]');
      for (var j = 0; j < colsEls.length; j++) {
        var ws = (colsEls[j].getAttribute('data-weights') || '').split(',');
        var total = 0;
        var fracs = [];
        for (var k = 0; k < ws.length; k++) { var n = Number(ws[k]); if (!(n > 0)) n = 1; fracs.push(n); total += n; }
        if (total <= 0 || fracs.length === 0) continue;
        var tpl = [];
        for (var m = 0; m < fracs.length; m++) tpl.push((fracs[m] / total * 100).toFixed(2) + '%');
        colsEls[j].style.setProperty('grid-template-columns', tpl.join(' '));
      }
    }

    function buildShell(frame) {
      var mapped = mapLayout(frame.layout);
      modalEl.className = 'dlg-modal ' + (mapped ? mapped.cls : 'dlg-center80');
      if (mapped && mapped.css) for (var k in mapped.css) modalEl.style.setProperty(k, mapped.css[k]);
      modalEl.innerHTML = '<div class="dlg-head"><span class="dlg-title">' + esc(frame.title || '') + '</span>' + OrosusI18N.t('web.dialog.closeEsc') +
        '<div class="dlg-body"></div>';
    }

    function firstInteractiveListId(widgets) {
      for (var i = 0; i < (widgets || []).length; i++) {
        var w = widgets[i];
        if (w.kind === 'list' && w.interactive) return w.id;
        if (w.kind === 'columns') {
          for (var c = 0; c < (w.cols || []).length; c++) {
            var hit = firstInteractiveListId(w.cols[c]);
            if (hit) return hit;
          }
        }
      }
      return null;
    }

    function onFrame(frame) {
      if (!frame || frame.kind !== 'dialog') return;
      if (frame.op === 'open') {
        if (!ensureDom()) return;
        var ws = frame.widgets || [];
        cur = { id: frame.id, sid: getSid ? getSid() : '', widgets: ws, selById: {}, focusedId: firstInteractiveListId(ws) };
        latestFrame = frame;
        buildShell(frame);
        render('open');
        overlayEl.hidden = false;
        return;
      }
      if (frame.op === 'update') {
        if (!cur || cur.id !== frame.id) return; /* 迟到/替身帧：不复活 */
        latestFrame = frame;
        cur.widgets = frame.widgets || cur.widgets;
        if (queue && !queue.frameAllowed(cur.id)) return; /* 队列未清空：不用较旧快照覆盖未确认输入（§6.5——排空后 onDrained 协调） */
        render(frame.reset === 'selection' || frame.reset === 'all' ? frame.reset : 'none');
        return;
      }
      if (frame.op === 'close') {
        if (cur && cur.id === frame.id) teardown();
      }
    }

    function teardown() {
      cur = null;
      latestFrame = null;
      if (overlayEl) overlayEl.hidden = true;
      if (modalEl) {
        modalEl.innerHTML = '';
        modalEl.className = 'dlg-modal';
        var props = ['--dlg-w', '--dlg-h', '--dlg-left', '--dlg-right', '--dlg-top', '--dlg-bottom'];
        for (var i = 0; i < props.length; i++) modalEl.style.removeProperty(props[i]);
      }
    }

    /* ── 键盘（设计 §8.3）：窗内 stopPropagation——不进 composer 的发送/斜杠菜单/双击 Esc ── */
    function onKey(e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); requestClose(); return; }
      if (e.key === 'Tab') { trapFocus(e); return; }
      if (!cur) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var listEl = focusedListEl();
        if (!listEl) return;
        e.preventDefault();
        var wid = listEl.getAttribute('data-wid');
        var len = listEl.querySelectorAll('.dw-row').length;
        var nxt = nextIndex(len, cur.selById[wid], e.key === 'ArrowDown' ? 1 : -1);
        setSelection(wid, nxt);
        return;
      }
      if (e.key === 'Enter') {
        if (e.target && e.target.classList && e.target.classList.contains('dw-field')) {
          if (e.target.getAttribute('data-submit') !== '1') return; /* 多行非 enterSubmit：默认换行 */
          e.preventDefault();
          var host = e.target.closest('[data-wid]');
          if (host) sendEvent({ type: 'activate', id: host.getAttribute('data-wid') }); /* input 回车激活不带 index（契约） */
          return;
        }
        var listEl2 = focusedListEl();
        if (listEl2) {
          e.preventDefault();
          var wid2 = listEl2.getAttribute('data-wid');
          var idx = cur.selById[wid2];
          if (idx === undefined) idx = 0;
          setSelection(wid2, idx);
          sendEvent({ type: 'activate', id: wid2, index: idx });
        }
      }
    }
    function trapFocus(e) {
      if (!modalEl) return;
      var fs = modalEl.querySelectorAll('.dw-field, .dlg-x');
      if (fs.length === 0) return;
      var first = fs[0], last = fs[fs.length - 1];
      var ae = document.activeElement;
      if (e.shiftKey && ae === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && ae === last) { e.preventDefault(); first.focus(); }
      else if (ae === document.body || ae === null || !modalEl.contains(ae)) { e.preventDefault(); first.focus(); }
    }
    function focusedListEl() {
      if (!modalEl) return null;
      var lists = modalEl.querySelectorAll('.dw-list.dw-interactive');
      if (lists.length === 0) return null;
      for (var i = 0; i < lists.length; i++) if (widOf(lists[i]) === cur.focusedId) return lists[i];
      return lists[0];
    }

    /* ── 鼠标：点击行与 Enter 同效（激活前先选中）；✕ 关窗；遮罩不关 ── */
    function onClick(e) {
      if (!e.target || !e.target.closest) return;
      var x = e.target.closest('.dlg-x');
      if (x) { requestClose(); return; }
      var row = e.target.closest('.dw-interactive .dw-row');
      if (row && cur) {
        var listEl = row.closest('.dw-interactive');
        var wid = widOf(listEl);
        var idx = Number(row.getAttribute('data-idx'));
        setSelection(wid, idx);
        sendEvent({ type: 'activate', id: wid, index: idx });
      }
    }

    function setSelection(wid, idx) {
      if (!cur || !modalEl) return;
      cur.selById[wid] = idx;
      var lists = modalEl.querySelectorAll('.dw-list.dw-interactive');
      for (var i = 0; i < lists.length; i++) {
        if (widOf(lists[i]) !== wid) continue;
        var rows = lists[i].querySelectorAll('.dw-row');
        for (var j = 0; j < rows.length; j++) {
          rows[j].className = 'dw-row' + (j === idx ? ' dw-sel' : '') + (cur.focusedId === wid ? ' dw-focus' : '');
          if (j === idx && rows[j].scrollIntoView) rows[j].scrollIntoView({ block: 'nearest' });
        }
      }
      sendEvent({ type: 'select', id: wid, index: idx }); /* 本地类已改 = 乐观更新（§6.5） */
    }

    function sendEvent(ev) {
      if (!cur || !queue) return;
      queue.send(cur.id, { id: cur.id, event: ev, sid: cur.sid }); /* sid 入队时捕获——切会话后仍回旧会话端点 */
    }
    function requestClose() {
      if (!cur || !queue) return;
      queue.close(cur.id, { id: cur.id, close: true, sid: cur.sid }); /* 排在先前事件之后；确认以服务端 close 帧为准 */
      if (typeof onUserCloseFn === 'function') { /* 走查（2026-10-16 用户口令）：用户关窗（Esc/✕）回调——app.js 凭此「返回上一页」（启动器来源回总览）；supersede 关（viewText 顶替）不走此路 */
        try { onUserCloseFn(); } catch { /* 回调失败不阻断关窗 */ }
      }
    }

    /* 上行口注入（app.js）：post(sid, body) → Promise；getSid() 供开窗时记属主会话；toast 供失败提示；
     * onUserClose = 用户主动关窗回调（Esc/✕——supersede 关不触发）。 */
    function wire(opts) {
      postFn = opts.post;
      getSid = opts.getSid;
      toastFn = opts.toast;
      onUserCloseFn = opts.onUserClose ?? null;
      queue = createEventQueue({
        post: function (body) {
          var sid = body.sid;
          var clean = { id: body.id };
          if (body.event !== undefined) clean.event = body.event;
          if (body.close !== undefined) clean.close = body.close;
          if (retiredIds[clean.id]) return Promise.resolve({ ok: true, noop: true }); /* unmount 后不再新发（在途自然收尾） */
          return postFn(sid, clean);
        },
        toast: function () { if (typeof toastFn === 'function') toastFn(); },
        onDrained: function (id) {
          /* 排空协调（§6.5）：按不小于最大已确认 revision 的最新快照重画——失败且未被覆盖的本地修改随重画回滚 */
          if (cur && cur.id === id && latestFrame && latestFrame.revision !== undefined && queue && latestFrame.revision >= queue.maxAck(id)) render('server');
        },
      });
    }

    dom = {
      onFrame: onFrame,
      unmount: function () { if (cur) retiredIds[cur.id] = true; teardown(); },
      wire: wire,
    };
  })();

  globalThis.OrosusDialog = {
    esc: esc,
    widgetHtml: widgetHtml,
    widgetsHtml: widgetsHtml,
    mapLayout: mapLayout,
    nextIndex: nextIndex,
    enterActivates: enterActivates,
    createEventQueue: createEventQueue,
    onFrame: function (frame) { if (dom) dom.onFrame(frame); },
    unmount: function () { if (dom) dom.unmount(); },
    wire: function (opts) { if (dom) dom.wire(opts); },
  };
})();
