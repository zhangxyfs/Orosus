/** OrosusDialog —— web-dialog 批 T7 前端纯函数核（设计 §6.5/§8/§8.1）。
 *  结构（pane.js 同模式）：① 纯函数段——node 可测（vitest 直 import，dialog-frontend.test.ts），
 *  不碰 DOM；② DOM 薄壳段（T8——`typeof document` 守卫，node 下惰置）。
 *  加载序（index.html 静态链）：api.js 之后（esc/fetchJson）、ui.js/app.js 之前。
 *  CSP 纪律：渲染产物只含类名与 data-* 属性——动态几何（进度条填充、列宽权重、layout 变量）由
 *  DOM 段经 style.setProperty 落 CSS 变量，绝不产 style="..." HTML 属性。 */
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
        if (items.length === 0) return open + '<li class="dw-empty">（空）</li></ul>';
        var rows = items.map(function (it, i) {
          var rc = 'dw-row';
          if (w.interactive) {
            if (state.selById && state.selById[w.id] === i) rc += ' dw-sel';
            if (state.focusedId === w.id) rc += ' dw-focus';
          }
          return '<li class="' + rc + '"' + (w.interactive ? ' data-idx="' + i + '"' : '') + '>' + esc(it) + '</li>';
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

  globalThis.OrosusDialog = {
    esc: esc,
    widgetHtml: widgetHtml,
    widgetsHtml: widgetsHtml,
    mapLayout: mapLayout,
    nextIndex: nextIndex,
    enterActivates: enterActivates,
    createEventQueue: createEventQueue,
  };
})();
