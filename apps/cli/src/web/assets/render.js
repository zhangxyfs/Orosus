/* Orosus web 流区渲染器（web 批 T16）——§5 律一/律二的载体。
 * 结构分两段：
 *   ① 纯函数区：planAppend(renderedSeqs, events) → 操作列表 + 事件→行文案的全部纯推导
 *      （零 DOM 依赖，render-plan.test.ts node 直测）；
 *   ② DOM 应用层：薄壳——只 append / insertBefore / 局部替换 / tool 行原位合并，
 *      全文件不存在任何「整区重渲」代码路径（律一）；断线 backfill 按 seq 补插。
 * 流式（律二）：chunk 帧只 append 纯文本节点（不跑 marked/DOMPurify），经 rafFlush 合帧；
 *   assistant/message（转正）事件到达才整块 markdown 渲染替换流式文本。
 * 折叠件（思考块/diff 中段/气泡展开）自带展开锚定（2026-10-10 用户口令：展开过程中距顶部距离保持
 *   不变——锚 = 紧随折叠件后的首个元素，视口位置差值回写 scrollTop）。工具展开体例外（2026-10-12
 *   走查二轮口令）：向下展开——被点行不动、下方内容顺延下移，体越出视口时顺滚最小量（体有 10 行高帽）。
 * 工具行（2026-10-12 走查）：收起态零预览——「Using/Used X(关键参数) · N 行」一行即全部；
 *   点击行体按工具类型展开（bash 终端回放 / read 行号内容 / edit·write diff / 其余输出块），
 *   结果懒构建、原位重装不收拢；体高帽 10 行（超出体内滚动）；超长输出头尾截断 + bash CR 行内取尾。
 * 滚动跟随仅当用户在底部 40px 内；离开底部 >160px 显「回到底部」浮钮（点击回底并恢复跟随）。
 * 导出挂 globalThis.OrosusRender（浏览器 window === globalThis；node 测试同源可取）。 */
(function () {
  'use strict';

  /* ═══════════════════ ① 纯函数区（node 直测——不触 DOM） ═══════════════════ */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** planAppend：增量渲染计划（律一的纯函数核）。
   *  renderedSeqs：升序已渲染 seq 数组（不被改动——纯函数）；
   *  events：新到事件批（可乱序、可与已渲染重叠、可含断线 backfill 的旧 seq）。
   *  返回 { ops, seqs, maxSeq }：
   *    ops = [{op:'append', seq, ev}          —— seq 超过当前最大已渲染 → 尾部追加
   *         | {op:'insert', seq, ev, beforeSeq} —— 小于最大已渲染 → 按 seq 定位补插（beforeSeq = 最小的更大已渲染 seq）
   *    （已在 renderedSeqs 内的 seq 重复到达 → 跳过——SSE backfill 与已渲染重叠的天然去重）
   *    seqs = 操作后的新已渲染序数组（升序）；maxSeq = 其尾值（openStream 的 after 游标锚）。 */
  function planAppend(renderedSeqs, events) {
    var seqs = (renderedSeqs || []).slice();
    var batch = (events || []).filter(function (e) { return e && typeof e.seq === 'number'; });
    batch.sort(function (a, b) { return a.seq - b.seq; });
    var ops = [];
    var max = seqs.length > 0 ? seqs[seqs.length - 1] : 0;
    for (var i = 0; i < batch.length; i++) {
      var ev = batch[i];
      if (seqs.indexOf(ev.seq) >= 0) continue; /* 已渲染（重复/backfill 重叠）——跳过 */
      if (seqs.length === 0 || ev.seq > max) {
        ops.push({ op: 'append', seq: ev.seq, ev: ev });
        if (ev.seq > max) max = ev.seq;
      } else {
        var beforeSeq = 0;
        for (var j = 0; j < seqs.length; j++) {
          if (seqs[j] > ev.seq) { beforeSeq = seqs[j]; break; }
        }
        ops.push({ op: 'insert', seq: ev.seq, ev: ev, beforeSeq: beforeSeq });
      }
      insertSorted(seqs, ev.seq);
    }
    return { ops: ops, seqs: seqs, maxSeq: seqs.length > 0 ? seqs[seqs.length - 1] : 0 };
  }
  function insertSorted(arr, v) {
    var lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
    arr.splice(lo, 0, v);
  }

  /** 纯查询工具（tool-subagent__tasks）不占流区行——call 与 result 双侧静默（TUI 拍板同口径）。 */
  function isGhostTool(name) { return name === 'tool-subagent__tasks'; }

  /** 工具显示名：剥 <module>__ 前缀、首字母大写（render.ts toolDisplayName 同式）。 */
  function toolDisplayName(name) {
    var n = String(name ?? '');
    var tail = n.indexOf('__') >= 0 ? n.split('__').pop() : n;
    return tail.charAt(0).toUpperCase() + tail.slice(1);
  }

  function capArg(s, max) {
    max = max || 60;
    var t = String(s).replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : t.slice(0, max - 12) + '…' + t.slice(-10);
  }

  /** 关键参数：path/file/pattern/command/url/query/name 优先；工作区内相对路径、区外全路径
   *  （render.ts toolKeyArg 同口径——web 侧 cwd 来自会话 status）。 */
  function toolKeyArg(args, cwd) {
    var a = args || {};
    var raw =
      typeof a.path === 'string' ? a.path :
      typeof a.file === 'string' ? a.file :
      typeof a.pattern === 'string' ? a.pattern :
      typeof a.command === 'string' ? a.command :
      typeof a.url === 'string' ? a.url :
      typeof a.query === 'string' ? a.query :
      typeof a.name === 'string' ? a.name : undefined;
    if (raw === undefined || raw === '') return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return capArg(raw); /* URL 不做文件系统相对化 */
    if (cwd && /[\\/]/.test(raw)) {
      var norm = raw.replace(/\\/g, '/');
      var c = String(cwd).replace(/\\/g, '/').replace(/\/$/, '') + '/';
      if (norm.indexOf(c) === 0 && norm.length > c.length) return capArg(norm.slice(c.length));
    }
    return capArg(raw);
  }

  /** 工具行头文案：used=false「● Using Read(a.ts)」；chip 追加「 · 214 行」等（C6）。 */
  function toolHeadText(name, args, cwd, used, chip) {
    var arg = toolKeyArg(args, cwd);
    return '● ' + (used ? 'Used ' : 'Using ') + toolDisplayName(name) + (arg === '' ? '' : '(' + arg + ')') + (chip ? ' · ' + chip : '');
  }

  /** 工具行头 HTML（分段配色——用户走查口径：动词=主文本、工具名=#7cc9a5、参数与后缀=#97a49a）。
   *  与 toolHeadText 同文案、逐段 esc；前缀 ● 归 tchar 段（此处不再重复）。 */
  function toolHeadHtml(name, args, cwd, used, chip) {
    var arg = toolKeyArg(args, cwd);
    return '<span class="tverb">' + (used ? 'Used' : 'Using') + '</span> ' +
      '<span class="tname">' + esc(toolDisplayName(name)) + '</span>' +
      (arg === '' ? '' : '<span class="targs">(' + esc(arg) + ')</span>') +
      (chip ? '<span class="targs"> · ' + esc(chip) + '</span>' : '');
  }

  /** 分页切片（右栏模块/连接列表共用——用户走查口径：列表超幅分页不出滚动条）：
   *  total 条、pageSize 每页、page 当前页（越界收拢）→ {page, pages, from, to}（from..to 为 slice 区间）。 */
  function pageSlice(total, page, pageSize) {
    var size = Math.max(1, pageSize | 0);
    var pages = Math.max(1, Math.ceil(total / size));
    var p = Math.min(Math.max(0, page | 0), pages - 1);
    return { page: p, pages: pages, from: p * size, to: Math.min(total, (p + 1) * size) };
  }

  /** 结果输出 → 非空行数（render.ts toolResultChip 同口径）。 */
  function lineCountOf(output) {
    var text = typeof output === 'string' ? output : String(output ?? '');
    var n = 0;
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) if (lines[i].trim().length > 0) n++;
    return n;
  }

  /* ── diff 行（toolview.ts 纯函数的 JS 港——edit/write 载荷 → DiffRow 列表） ── */
  function cleanLine(l) { return String(l ?? '').replace(/\t/g, '  ').trimEnd(); }

  function dedentRows(rows) {
    var common = Infinity;
    for (var i = 0; i < rows.length; i++) {
      var it = rows[i];
      if (it.tag === 'gap' || it.text.trim() === '') continue;
      var m = /^ */.exec(it.text);
      if (m) common = Math.min(common, m[0].length);
    }
    if (common === Infinity || common === 0) return rows;
    return rows.map(function (rw) { return rw.tag === 'gap' ? rw : { tag: rw.tag, no: rw.no, text: rw.text.slice(common) }; });
  }

  function editDiffRows(oldText, newText) {
    var oldLines = String(oldText ?? '').split('\n').map(cleanLine);
    var newLines = String(newText ?? '').split('\n').map(cleanLine);
    var pre = 0;
    while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
    var suf = 0;
    while (suf < oldLines.length - pre && suf < newLines.length - pre && oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) suf++;
    var rows = [];
    var CTX = 3;
    var preShown = Math.min(pre, CTX);
    if (pre > preShown) rows.push({ tag: 'gap', no: 0, text: '⋯ 上方还有 ' + (pre - preShown) + ' 行' });
    for (var i = pre - preShown; i < pre; i++) rows.push({ tag: 'ctx', no: i + 1, text: oldLines[i] });
    for (var d = pre; d < oldLines.length - suf; d++) rows.push({ tag: 'del', no: d + 1, text: oldLines[d] });
    for (var a = pre; a < newLines.length - suf; a++) rows.push({ tag: 'add', no: a + 1, text: newLines[a] });
    var sufShown = Math.min(suf, CTX);
    for (var j = 0; j < sufShown; j++) {
      var idx = oldLines.length - sufShown + j;
      rows.push({ tag: 'ctx', no: idx + 1, text: oldLines[idx] });
    }
    if (suf > sufShown) rows.push({ tag: 'gap', no: 0, text: '⋯ 下方还有 ' + (suf - sufShown) + ' 行' });
    return dedentRows(rows);
  }

  /** 工具载荷 → diff 行（edit：edits 数组逐处；write：content 全量增行——去尾空段）。无 diff 形态 → null。 */
  function diffRowsOf(name, args) {
    var n = String(name ?? '');
    var tail = n.indexOf('__') >= 0 ? n.split('__').pop() : n;
    var a = args || {};
    if (tail === 'edit') {
      var edits = Array.isArray(a.edits) ? a.edits : [];
      var rows = [];
      for (var eIdx = 0; eIdx < edits.length; eIdx++) {
        var e = edits[eIdx] || {};
        if (typeof e.oldText !== 'string' || typeof e.newText !== 'string') continue;
        if (rows.length > 0) rows.push({ tag: 'gap', no: 0, text: '⋯' });
        rows = rows.concat(editDiffRows(e.oldText, e.newText));
      }
      return rows.length > 0 ? rows : null;
    }
    if (tail === 'write') {
      var content = typeof a.content === 'string' ? a.content : '';
      var lines = content.split('\n').map(cleanLine);
      var end = lines.length;
      while (end > 0 && lines[end - 1] === '') end--;
      if (end === 0) return null;
      return dedentRows(lines.slice(0, end).map(function (l, i) { return { tag: 'add', no: i + 1, text: l }; }));
    }
    return null;
  }

  /** 变更统计（chip 数据源——edit → 增/删行数、write → 内容行数；其余 null）。 */
  function changeStatsOf(name, args) {
    var rows = diffRowsOf(name, args);
    if (rows === null) return null;
    var adds = 0, dels = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].tag === 'add') adds++;
      else if (rows[i].tag === 'del') dels++;
    }
    return { adds: adds, dels: dels, lines: adds + dels };
  }

  /** 结果 chip 文案（tool/result → 工具行原位合并的「 · N 行 / +A -D / 失败」段）。 */
  function resultChip(result) {
    if (!result) return '';
    if (result.isError) return '失败';
    if (result.denied) return '已拒绝';
    var stats = changeStatsOf(result.name, result.args);
    var chip;
    if (stats === null) chip = lineCountOf(result.output) + ' 行';
    else if (stats.dels > 0) chip = '+' + stats.adds + ' -' + stats.dels;
    else chip = stats.adds + ' 行';
    if (result.truncated) chip += ' · 截断';
    if (Array.isArray(result.images) && result.images.length > 0) chip += ' · ' + result.images.length + ' 附件';
    return chip;
  }

  /** 技能加载标记行检测（SKILL_MARK 前缀——T6 合成体随 user/message 回流，正文不整渲）。 */
  function skillMarkOf(text) {
    var t = String(text ?? '');
    var pre = '（用户通过菜单手动加载技能';
    var i = t.indexOf(pre);
    if (i < 0) return null;
    var rest = t.slice(i + pre.length).trim();
    var m = /^"([^"]+)"/.exec(rest);
    return m ? m[1] : null;
  }

  /** content 块数组 → 文本 part 拼接 / image part 列表 / reasoning part 拼接。 */
  function textOf(ev) {
    var parts = Array.isArray(ev && ev.content) ? ev.content : [];
    var out = '';
    for (var i = 0; i < parts.length; i++) if (parts[i] && parts[i].kind === 'text' && typeof parts[i].text === 'string') out += parts[i].text;
    return out;
  }
  function imagesOf(ev) {
    var parts = Array.isArray(ev && ev.content) ? ev.content : [];
    var out = [];
    for (var i = 0; i < parts.length; i++) if (parts[i] && parts[i].kind === 'image' && typeof parts[i].path === 'string') out.push(parts[i]);
    return out;
  }
  function reasoningOf(ev) {
    var parts = Array.isArray(ev && ev.content) ? ev.content : [];
    var out = '';
    for (var i = 0; i < parts.length; i++) if (parts[i] && parts[i].kind === 'reasoning' && typeof parts[i].text === 'string') out += parts[i].text;
    return out;
  }

  function fmtK(n) {
    if (n === undefined || n === null || isNaN(n)) return '—';
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  /** 思考/正文持续时长（assistant/message durationMs → 「持续了 168 秒」；≥5 分钟转分秒）。 */
  function fmtDur(ms) {
    if (typeof ms !== 'number' || ms < 0) return '';
    var s = Math.max(1, Math.round(ms / 1000));
    if (s < 300) return '持续了 ' + s + ' 秒';
    var m = Math.floor(s / 60);
    return '持续了 ' + m + ' 分 ' + (s % 60) + ' 秒';
  }

  /** turn 完成时间（turn/end ts → 「今天 14:02」/「昨天 14:02」/「10月8日 14:02」）。 */
  function dayStartOf(x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); }
  function fmtTurnTime(tsIso, nowMs) {
    var d = new Date(tsIso);
    if (isNaN(d.getTime())) return '';
    var now = new Date(typeof nowMs === 'number' ? nowMs : Date.now());
    var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    var diffDays = Math.round((dayStartOf(now) - dayStartOf(d)) / 86400000);
    if (diffDays <= 0) return '今天 ' + hm;
    if (diffDays === 1) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  /* ═══════════════════ ② DOM 应用层（薄壳——只 append / insertBefore / 局部替换 / 行内合并） ═══════════════════ */

  var PAGE = 200;          /* 回放分页每页上限（§5 律三：首屏有界） */
  var STICK_PX = 40;       /* 滚动跟随判定：距底 ≤40px */
  var TO_BOTTOM_PX = 160;  /* 距底超过此值显示「回到底部」浮钮（调研 §5-1 P1 口径） */
  /* 工具体内容预算（2026-10-12 走查 + 调研 §5-5 head-tail 截断口径——展开体是 opt-in DOM，
   *  超长输出头尾保留、中段折叠点击展开） */
  var TB_LINE_CAP = 500;   /* 单行字符帽（超长截断标注） */
  var TB_HEAD = 120;       /* 头保留行数 */
  var TB_TAIL = 30;        /* 尾保留行数 */
  var TB_FOLD_MIN = 200;   /* 超过此行数进入头尾截断 */

  var R = null; /* 当前会话的渲染状态（render.open 装配） */
  var bound = false; /* 流区骨架事件绑定（一次性——元素是静态骨架） */

  function el(tag, cls, html) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html !== undefined) d.innerHTML = html;
    return d;
  }

  function rafFlush(fn) {
    if (typeof globalThis.OrosusAPI !== 'undefined' && globalThis.OrosusAPI.rafFlush) globalThis.OrosusAPI.rafFlush(fn);
    else fn();
  }
  function fetchJson(path, init) {
    return globalThis.OrosusAPI.fetchJson(path, init);
  }
  function mediaUrl(path) {
    var tok = (typeof globalThis.OrosusAPI !== 'undefined' && globalThis.OrosusAPI.getToken) ? globalThis.OrosusAPI.getToken() : '';
    return '/api/media?path=' + encodeURIComponent(path) + (tok ? '&token=' + encodeURIComponent(tok) : '');
  }
  var mdPurifyHooked = false;
  function mdRender(text) {
    try {
      if (typeof globalThis.marked !== 'undefined' && typeof globalThis.DOMPurify !== 'undefined') {
        var DP = globalThis.DOMPurify;
        /* 外链加固（调研 §5-6 P3——cc-haha/opencode 同款，一次性钩子）：外链补 rel 且新开标签
         * （原地导航会整页离开 GUI）；img 剥 srcset（不自家的响应式源）。 */
        if (!mdPurifyHooked && typeof DP.addHook === 'function') {
          mdPurifyHooked = true;
          DP.addHook('afterSanitizeAttributes', function (node) {
            if (typeof node.tagName !== 'string') return;
            if (node.tagName === 'A' && node.getAttribute('href')) {
              node.setAttribute('rel', 'noopener noreferrer');
              node.setAttribute('target', '_blank');
            } else if (node.tagName === 'IMG') {
              node.removeAttribute('srcset');
            }
          });
        }
        return DP.sanitize(globalThis.marked.parse(text, { breaks: true, gfm: true }));
      }
    } catch { /* 渲染失败兜底纯文本 */ }
    return '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
  }
  function spinSvg(cls, size) {
    var s = size ?? 11;
    return '<svg class="spin-svg' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="40" stroke-dashoffset="16"/></svg>';
  }

  /* ── 展开锚定（2026-10-10 用户口令）：展开/收起过程中距顶部距离保持不变。
   *    锚 = 紧随折叠件后的首个元素（折叠件底缘——gap 兄弟亦是合格锚）；展开前后锚的
   *    视口位置差值回写所在滚动容器的 scrollTop（同任务内同步写，无绘制窗无跳动）。
   *    不可锚块顶：折叠件展开/收起不动其顶缘，块顶差值恒 0、补偿成空操作。
   *    视口 rect 差值法对任意滚动容器（主流区 .stream / 浮层 .pu-body）统一成立。 ── */
  function scrollParentOf(node) {
    var p = node.parentElement;
    while (p) {
      var ov = getComputedStyle(p).overflowY;
      if ((ov === 'auto' || ov === 'scroll') && p.scrollHeight > p.clientHeight) return p;
      p = p.parentElement;
    }
    return null;
  }
  function anchoredToggle(foldEl, toggleFn) {
    var anchor = foldEl.nextElementSibling;
    var before = anchor ? anchor.getBoundingClientRect().top : foldEl.getBoundingClientRect().bottom;
    toggleFn();
    var sc = scrollParentOf(foldEl);
    if (sc) {
      var after = anchor ? anchor.getBoundingClientRect().top : foldEl.getBoundingClientRect().bottom;
      var delta = after - before;
      if (delta !== 0) sc.scrollTop += delta;
    }
    /* 折叠件开合改变布局——回到底部浮钮显隐随之刷新（scrollTop 未变时不触发 scroll 事件的补偿口） */
    syncToBottom();
  }

  function nearBottom() {
    var s = R.stream;
    return s.scrollHeight - s.scrollTop - s.clientHeight <= STICK_PX;
  }
  function followScroll() {
    if (R && R.stick) R.stream.scrollTop = R.stream.scrollHeight;
  }
  /* ── 「回到底部」浮钮（调研 §5-1 P1：用户滚动权不可被剥夺——离开底部出现、点击回底并恢复跟随；
   *    程序贴底（followScroll 落在底）时自然隐去。 ── */
  function syncToBottom() {
    if (R === null || !R.toBottom) return;
    var away = R.stream.scrollHeight - R.stream.scrollTop - R.stream.clientHeight;
    R.toBottom.hidden = away <= TO_BOTTOM_PX;
  }

  /* ── 渲染上下文：live（主流区，落位 = tail 之前）与 backfill fragment（落位 = frag 尾）共用 ──
   *    ctx = { appendTop(el)——top-level 落位；turn——当前 .turn 容器（null = 顶级）；
   *            setTurn(t)；pendingClamp[]——待测高气泡；fragMode } */
  function makeCtx(appendTop, sharedClamp) {
    var ctx = { appendTop: appendTop, turn: null, fragMode: false, pendingClamp: sharedClamp || [], usage: null };
    ctx.setTurn = function (t) { ctx.turn = t; };
    return ctx;
  }
  function ensureTurn(ctx) {
    if (ctx.turn) return ctx.turn;
    var t = el('div', 'turn');
    t.provisional = true; /* 无 seq 认领——turn/start 到达时收编（chunk 先行的临时容器） */
    ctx.appendTop(t);
    ctx.setTurn(t);
    return t;
  }
  function placeIn(ctx, node) {
    /* 评审 Important-3 收容口径：turn 作用域事件（assistant/tool/注入行）无开口容器时补建
     * （provisional）turn——分页边界落 mid-turn 的首事件不再散落顶级，turn/end 的 ensureTurn
     * 认领同容器挂 foot，「⧉ 复制本轮」作用域（closest('.turn')）由此闭合、不再拷空。 */
    if (!ctx.turn) ensureTurn(ctx);
    ctx.turn.appendChild(node);
  }
  function liveCtx() {
    var ctx = makeCtx(function (node) { R.stream.insertBefore(node, R.tail); }, R.pendingClamp);
    ctx.turn = R.openTurn;
    var superSet = ctx.setTurn;
    ctx.setTurn = function (t) { superSet(t); R.openTurn = t; }; /* live 的 turn 状态镜像进 R（chunk 复用） */
    return ctx;
  }

  /** 单事件渲染（返回主锚元素——seqEls 登记用；无视觉输出的类型返回 null）。 */
  function emitEvent(ev, ctx) {
    if (!ev || typeof ev.type !== 'string') return null;
    switch (ev.type) {
      case 'user/message': return emitUser(ev, ctx);
      case 'assistant/message': return emitAssistant(ev, ctx);
      case 'tool/call': return emitToolCall(ev, ctx);
      case 'tool/result': return emitToolResult(ev, ctx);
      case 'turn/start': return emitTurnStart(ev, ctx);
      case 'turn/end': return emitTurnEnd(ev, ctx);
      case 'turn/compaction': {
        var n = Number(ev.droppedCount ?? 0);
        var m = el('div', 'line mark-line', '[已压缩：' + n + ' 条历史 → 摘要（顶栏「更多 ▸ 压缩摘要」查看）]');
        m.setAttribute('data-seq', String(ev.seq));
        ctx.appendTop(m);
        R.compacting = false;
        syncTail();
        return m;
      }
      case 'turn/prune': {
        var prunes = Array.isArray(ev.prunes) ? ev.prunes.length : 0;
        var mp = el('div', 'line mark-line', '[已裁剪：' + prunes + ' 处长工具输出]');
        mp.setAttribute('data-seq', String(ev.seq));
        ctx.appendTop(mp);
        return mp;
      }
      case 'session/fork': {
        var parent = typeof ev.parentSession === 'string' ? ev.parentSession : '';
        var mf = el('div', 'line mark-line', '[分叉会话' + (parent !== '' ? '——继承自 ' + esc(parent) : '') + '，历史完整保留]');
        mf.setAttribute('data-seq', String(ev.seq));
        ctx.appendTop(mf);
        return mf;
      }
      case 'agent/steering-message': {
        /* 钩子注入折叠行（m5-hooks D19）：一行灰字——「出错才知道」的隐藏档被用户明确反对 */
        var msgs = Array.isArray(ev.messages) ? ev.messages : [];
        var first = null;
        for (var i = 0; i < msgs.length; i++) {
          var m2 = msgs[i] || {};
          if ((m2.sourceModule === 'host/hook' || m2.sourceModule === 'hooks') && typeof m2.text === 'string' && m2.text !== '') {
            var s = el('div', 'line sub-line', '<span class="tree">⌁</span>' + esc('钩子注入 · ' + m2.text.length + ' 字符（顶栏「更多 ▸ 钩子注入」查看）'));
            placeIn(ctx, s);
            if (first === null) first = s;
          }
        }
        return first;
      }
      case 'hooks/input-rewrite': {
        var hw = el('div', 'line sub-line', '<span class="tree">⌁</span>' + esc('工具参数已被钩子改写——行内显示原始参数，执行用改后参数'));
        placeIn(ctx, hw);
        return hw;
      }
      default:
        /* 无视觉输出：session/header、session/label、request/header、host/input-echo（上键召回面，web 不消费）、
         * approval/*（interaction 浮层承载）、mcp/*、session/subagent-usage——不渲染 */
        return null;
    }
  }

  function emitUser(ev, ctx) {
    R.spawnGroup = null; /* 消息边界断 spawn 组（TUI docmodel 同口径） */
    var text = textOf(ev);
    var skill = skillMarkOf(text);
    if (skill !== null) {
      /* 技能加载标记行（C9）——合成体正文（技能全文）不整渲 */
      var m = el('div', 'line mark-line', '[已加载技能 ' + esc(skill) + '] <span class="dim">· 正文已注入模型上下文</span>');
      m.setAttribute('data-seq', String(ev.seq));
      ctx.appendTop(m);
      markUserSeen();
      return m;
    }
    var imgs = imagesOf(ev);
    var imgHtml = '';
    for (var i = 0; i < imgs.length; i++) {
      imgHtml += '<img class="photo" src="' + esc(mediaUrl(imgs[i].path)) + '" alt="图片附件" loading="lazy" />';
    }
    var wrap = el('div', 'msg-user',
      '<div class="msg-bubble">' + (imgHtml !== '' ? '<div class="msg-img">' + imgHtml + '</div>' : '') +
      '<div class="msg-text">' + esc(text) + '</div><button type="button" class="msg-toggle">▾ 展开全部</button></div>' +
      '<div class="msg-acts"><button type="button" data-mcopy title="复制消息">⧉ 复制</button></div>');
    wrap.setAttribute('data-seq', String(ev.seq));
    ctx.appendTop(wrap);
    ctx.pendingClamp.push(wrap); /* 入 DOM 后测高（>5.5 行收拢） */
    markUserSeen();
    return wrap;
  }

  function markUserSeen() {
    if (R.userSeen) return;
    R.userSeen = true;
    R.welcome.hidden = true; /* C1：有消息即隐（前端按事件数判定——T15 新建会话欢迎页竞态在此消除） */
    if (R.onUserSeen) R.onUserSeen();
  }

  function emitAssistant(ev, ctx) {
    finalizeLive(); /* 流式文本节点让位（律二：事件边界一次 markdown 整块替换） */
    R.spawnGroup = null; /* 消息边界断 spawn 组（TUI docmodel 同口径） */
    var first = null;
    var reasoning = reasoningOf(ev);
    var text = textOf(ev);
    if (reasoning !== '') {
      var t = buildThink(reasoning, fmtDur(ev.durationMs));
      placeIn(ctx, t);
      first = t;
    }
    if (text !== '') {
      var md = el('div', 'line agent-md', '<span class="bullet">●</span><div class="md">' + mdRender(text) + '</div>');
      md.mdSource = text; /* 复制口径：正文 markdown 源串（textOf 只拼 text part——思考永不入），渲染态 textContent 丢围栏/标记不可用 */
      md.setAttribute('data-seq', String(ev.seq));
      placeIn(ctx, md);
      if (first === null) first = md;
    }
    if (ev.finishKind === 'length') {
      var tr = el('div', 'line sub-line', '<span class="tree">⎿</span><span class="bad">输出达 max_tokens 上限被截断（finishKind=length）</span>');
      placeIn(ctx, tr);
    }
    if (ev.usage && typeof ev.usage.input === 'number') ctx.usage = ev.usage; /* usage 旁注——turn-foot 收口呈现 */
    return first;
  }

  /** 思考块（C4）：默认收起；折叠期零内容行（2026-10-12 走查五轮——只留标题行，尾行预览亦不显）
   *  且全文不进 DOM（_full 挂 JS 属性，展开换装）；展开锚定。 */
  function buildThink(fullText, durText) {
    var t = el('div', 'think collapsed', '');
    var headEl = el('div', 'think-head');
    var bodyEl = el('div', 'think-body');
    t.appendChild(headEl);
    t.appendChild(bodyEl);
    t.fullText = fullText;
    function head(collapsed) {
      headEl.innerHTML = '<span class="tcaret">' + (collapsed ? '▸' : '▾') + '</span>[思考]' +
        (durText !== '' ? ' <span class="think-dur">· ' + esc(durText) + '</span>' : '') +
        ' <span class="think-hint">· 点击' + (collapsed ? '展开' : '收起') + '</span>';
    }
    function apply(collapsed) {
      head(collapsed);
      bodyEl.textContent = collapsed ? '' : t.fullText;
    }
    apply(true);
    headEl.addEventListener('click', function () {
      /* 向下展开且零顺滚（走查八轮定案：被点头行纹丝不动，内容向下顺延，用户自滚续读）。
       *  前史：anchoredToggle 锚定后续行 = 向上长；顺滚三行封顶档用户亦否（要绝对不动）。 */
      apply(t.classList.toggle('collapsed'));
      syncToBottom();
    });
    return t;
  }

  /** spawn 结果文本 → 8 位子代理编号（tasks-cmd.ts spawnIdsIn 同口径——结果文本里的 8 位 hex 全收）。 */
  function spawnIdsIn(output) {
    var out = [];
    var m = String(output ?? '').match(/[0-9a-f]{8}/g);
    if (m) for (var i = 0; i < m.length; i++) out.push(m[i]);
    return out;
  }
  /** 子代理组卡（TUI agent 组同款语义——web 卡片形）：头行「● N 个子代理 + 聚合状态」+ 组员行
   *  （├─ 标题 + 编号 + 状态）。状态刷新归 app.js 名册轮询（render 保持零 fetch——行带
   *  data-agent-id 钩子，点击经 onAgentOpen 回调进回放窗）。 */
  function ensureSpawnGroup(ctx) {
    if (R.spawnGroup && R.spawnGroup.el.isConnected) return R.spawnGroup;
    var g = el('div', 'spawn-group');
    var head = el('div', 'sg-head', '<span class="sg-dot">●</span><span class="sg-title">子代理</span><span class="sg-sum"></span>');
    var list = el('div', 'sg-list');
    g.appendChild(head);
    g.appendChild(list);
    placeIn(ctx, g);
    R.spawnGroup = { el: g, list: list, sum: head.querySelector('.sg-sum'), rows: new Map(), anyLive: true };
    return R.spawnGroup;
  }
  /** spawn result → 组员行挂卡（编号序 = prompts 序——label 从 args.description/items 按下标配对，
   *  名册轮询到达后以花名册为准校正）；isError → 组内错误行（占位符误用等校验错，静默会看不懂）。 */
  function spawnResultInto(ev, spArgs, ctx) {
    var grp = R.spawnGroup;
    if (!grp || !grp.el.isConnected) grp = ensureSpawnGroup(ctx);
    var output = typeof ev.output === 'string' ? ev.output : String(ev.output ?? '');
    if (ev.isError === true) {
      var errLine = el('div', 'sg-err', '⎿ 派活失败：' + esc(firstLineOf(output)));
      grp.list.appendChild(errLine);
      grp.sum.textContent = '· 派活失败';
      return;
    }
    var ids = spawnIdsIn(output);
    var desc = typeof spArgs.description === 'string' ? spArgs.description : '';
    var items = Array.isArray(spArgs.items) ? spArgs.items : null;
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (grp.rows.has(id)) continue;
      var label = items !== null && typeof items[i] === 'string' ? desc + '：' + items[i] : desc;
      var row = el('div', 'sg-row', '<span class="sg-caret">├─</span><span class="sg-name">' + esc(label || '子代理任务') + '</span><span class="sg-id">' + esc(id) + '</span><span class="sg-st st-run">已派出…</span>');
      row.setAttribute('data-agent-id', id);
      (function (aid) {
        row.addEventListener('click', function () { R.onAgentOpen(aid); });
      })(id);
      grp.list.appendChild(row);
      grp.rows.set(id, row);
    }
    var n = grp.rows.size;
    if (n > 0) grp.sum.textContent = '· ' + n + ' 个任务 · 运行中…';
    followScroll();
    syncToBottom();
  }

  function emitToolCall(ev, ctx) {
    var name = String(ev.name ?? '');
    var callId = String(ev.callId ?? '');
    if (isGhostTool(name)) {
      R.ghostCalls.add(callId);
      return null;
    }
    var args = (ev.args && typeof ev.args === 'object' && !Array.isArray(ev.args)) ? ev.args : {};
    /* 子代理派活（TUI docmodel 同款口径：spawn 不落工具行——call 开组、result 抠编号挂组员；
     *  连续 spawn 并一组，其它渲染事件〔用户/助手消息、别的工具〕断组）。 */
    if (name === 'tool-subagent__spawn') {
      R.spawnCalls.set(callId, args);
      var grp = ensureSpawnGroup(ctx);
      return grp.el;
    }
    R.spawnGroup = null; /* 断组 */
    var line = el('div', 'line tool-line', '<span class="tchar">●</span>' + toolHeadHtml(name, args, R.cwdOf(), false) + '<span class="tcaret" aria-hidden="true">▸</span>');
    line.setAttribute('data-seq', String(ev.seq));
    line.setAttribute('data-callid', callId);
    line.title = '点击展开 / 收起详情';
    placeIn(ctx, line);
    /* 展开体（2026-10-12 走查口径：收起态零预览——「Used X(x) · N 行」一行即全部；点击行体按工具
     *  类型展开：bash → 终端回放、read → 行号内容、edit/write → diff、其余 → 输出块。懒构建——
     *  首次展开才进 DOM（§5 律二同族；结果到达原位重装不收拢）。 */
    var body = el('div', 'tool-body');
    body.hidden = true;
    insertAfter(line, body);
    var row = { line: line, body: body, name: name, args: args, result: null, built: false };
    line.addEventListener('click', function () {
      if (!row.built) {
        fillToolBody(row);
        row.built = true;
      }
      var expanding = body.hidden;
      body.hidden = !expanding;
      var c = line.querySelector('.tcaret');
      if (c) c.textContent = body.hidden ? '▸' : '▾';
      /* 向下展开（2026-10-12 走查二轮用户口令：不锚定尾随元素——被点行不动、下方内容顺延下移；
       * 体越出视口下缘时顺滚最小量让整体可见。体有 10 行高帽，顺滚量有界不惊跳。 */
      if (expanding) revealBelow(body);
      syncToBottom();
    });
    R.toolRows.set(callId, row);
    return line;
  }

  /* ── 工具体构建（收起零预览配套——按工具尾名分形） ── */

  /** 工具尾名（tool-shell__bash → bash——形态分派键）。 */
  function toolTailOf(name) {
    var n = String(name ?? '');
    return n.indexOf('__') >= 0 ? n.split('__').pop() : n;
  }

  /** bash 输出 CR 语义清洗（调研 §2.6 cc-haha 口径）：行内取最后一个 \r 之后——进度条不堆行。 */
  function crWash(l) {
    var i = l.lastIndexOf('\r');
    return (i >= 0 ? l.slice(i + 1) : l).trimEnd();
  }
  function capLine(l) {
    return l.length > TB_LINE_CAP ? l.slice(0, TB_LINE_CAP) + '…' : l;
  }

  /** 行数组 → 头尾保留折叠块（超长输出：头 TB_HEAD + 「⋯ 中间还有 N 行」+ 中段 data-extra + 尾
   *  TB_TAIL——展开锚定；调研 §5-5 dsh head-tail-cap 口径）。rowHtml(line) → 完整行 HTML。 */
  function buildLineFold(lines, rowHtml) {
    var block = el('div', 'tb-fold');
    var total = lines.length;
    var fold = total > TB_FOLD_MIN;
    var head = fold ? TB_HEAD : total;
    var mid = fold ? total - head - TB_TAIL : 0;
    var html = '';
    for (var i = 0; i < head; i++) html += rowHtml(lines[i]);
    if (fold) {
      html += '<div class="tb-more" data-tbmore>⋯ 中间还有 ' + mid + ' 行 · 点击展开全部</div>';
      for (var j = 0; j < mid; j++) html += rowHtml(lines[head + j]).replace('<div ', '<div data-extra ');
      for (var t = 0; t < TB_TAIL; t++) html += rowHtml(lines[head + mid + t]);
    }
    block.innerHTML = html;
    var more = block.querySelector('[data-tbmore]');
    if (more) more.addEventListener('click', function () {
      anchoredToggle(block, function () {
        var expanded = block.classList.toggle('expanded');
        more.textContent = expanded ? '点击收起中段' : '⋯ 中间还有 ' + mid + ' 行 · 点击展开全部';
      });
    });
    return block;
  }

  function outputLinesOf(output) {
    var text = typeof output === 'string' ? output : String(output ?? '');
    var lines = text.split('\n').map(crWash);
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** bash → 终端回放块（$ 命令 + 输出——恒深底双主题不变，走查图 4 口径）。 */
  function buildTermBody(row) {
    var wrap = el('div', 'term' + (row.result && row.result.isError ? ' term-err' : ''));
    var cmd = typeof row.args.command === 'string' ? row.args.command : '';
    wrap.innerHTML = '<div class="term-cmd">$ ' + esc(cmd) + '</div>';
    if (!row.result) {
      wrap.appendChild(el('div', 'term-out term-dim', '（运行中…）'));
      return wrap;
    }
    var lines = outputLinesOf(row.result.output);
    if (lines.length === 0) wrap.appendChild(el('div', 'term-out term-dim', '（无输出）'));
    else wrap.appendChild(buildLineFold(lines.map(capLine), function (l) { return '<div class="term-out">' + esc(l) + '</div>'; }));
    return wrap;
  }

  var READ_ROW_RE = /^(\d+)→(.*)$/;

  /** read → 行号内容块（输出本带 `N→正文` 前缀——拆装为行号槽 + 正文，走查图 5 口径；页脚/提示行归 note）。 */
  function buildFileBody(row) {
    var wrap = el('div', 'tb-file');
    if (!row.result) {
      wrap.innerHTML = '<div class="tb-note">（等待结果…）</div>';
      return wrap;
    }
    var lines = outputLinesOf(row.result.output);
    if (lines.length === 0) {
      wrap.innerHTML = '<div class="tb-note">（无输出）</div>';
      return wrap;
    }
    wrap.appendChild(buildLineFold(lines, function (l) {
      var m = READ_ROW_RE.exec(l);
      if (m) return '<div class="tb-frow"><span class="g">' + m[1] + '</span><span>' + esc(capLine(m[2])) + '</span></div>';
      return '<div class="tb-note">' + esc(capLine(l)) + '</div>';
    }));
    return wrap;
  }

  /** edit/write → diff 块（载荷自算 diffRowsOf——既有行号 + 增删染色件原样复用；错误结果前置注记）。 */
  function buildDiffBody(row) {
    var wrap = el('div', 'tb-diffwrap');
    if (row.result && row.result.isError) {
      wrap.appendChild(el('div', 'tb-note bad', esc(capLine(firstLineOf(row.result.output)))));
    }
    var rows = diffRowsOf(row.name, row.args);
    if (rows !== null) wrap.appendChild(buildDiffBlock(rows));
    else if (!row.result) wrap.appendChild(el('div', 'tb-note', '（等待结果…）'));
    else wrap.appendChild(el('div', 'tb-note', esc(capLine(firstLineOf(row.result.output)) || '（无输出）')));
    return wrap;
  }

  /** 其余工具 → 通用输出块（pre-wrap 行折叠同族；错误结果整块染赭石）。 */
  function buildOutBody(row) {
    var wrap = el('div', 'tb-out');
    if (!row.result) {
      wrap.innerHTML = '<div class="tb-note">（等待结果…）</div>';
      return wrap;
    }
    var lines = outputLinesOf(row.result.output);
    if (lines.length === 0) {
      wrap.innerHTML = '<div class="tb-note">' + (row.result.isError ? '<span class="bad">（失败，无输出）</span>' : '（无输出）') + '</div>';
      return wrap;
    }
    var bad = row.result.isError ? ' tb-bad' : '';
    wrap.appendChild(buildLineFold(lines.map(capLine), function (l) { return '<div class="tb-orow' + bad + '">' + esc(l) + '</div>'; }));
    return wrap;
  }

  /** 工具体内容装配（row.result 在场时按类分形；denied 压过一切）。 */
  function fillToolBody(row) {
    row.body.innerHTML = '';
    var node;
    if (row.result && row.result.denied) {
      node = el('div', 'tb-note bad', '已拒绝——本轮不执行');
    } else {
      var tail = toolTailOf(row.name);
      if (tail === 'bash') node = buildTermBody(row);
      else if (tail === 'read') node = buildFileBody(row);
      else if (tail === 'edit' || tail === 'write') node = buildDiffBody(row);
      else node = buildOutBody(row);
    }
    row.body.appendChild(node);
  }

  /** 向下展开的顺滚口：体越出滚动视口下缘时滚最小量让体整体可见（体有高帽——顺滚有界）。 */
  function revealBelow(body) {
    var sc = scrollParentOf(body);
    if (!sc) return;
    var vr = sc.getBoundingClientRect();
    var br = body.getBoundingClientRect();
    var over = br.bottom - vr.bottom + 8;
    if (over > 0) sc.scrollTop += over;
  }

  function buildDiffBlock(rows) {
    var html = '';
    var extra = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var hidden = i >= 5;
      if (hidden) extra++;
      html += '<div class="diff-row diff-' + r.tag + '"' + (hidden ? ' data-extra' : '') + '><span class="g">' + (r.no > 0 ? r.no : '') + '</span><span>' + esc(r.text) + '</span></div>';
    }
    var d = el('div', 'diff' + (extra > 0 ? '' : ' expanded'), html + (extra > 0 ? '<div class="diff-more">… 还有 ' + extra + ' 行 · 点击展开全部</div>' : ''));
    var more = d.querySelector('.diff-more');
    if (more) more.addEventListener('click', function () {
      anchoredToggle(d, function () {
        var expanded = d.classList.toggle('expanded');
        more.textContent = expanded ? '点击收起' : '… 还有 ' + extra + ' 行 · 点击展开全部';
      });
    });
    return d;
  }

  function emitToolResult(ev, ctx) {
    var callId = String(ev.callId ?? '');
    if (R.ghostCalls.has(callId)) return null;
    /* spawn 结果（TUI 同款：不落行——编号从结果文本抠出挂进组卡；失败 = 组内错误行） */
    var spArgs = R.spawnCalls.get(callId);
    if (spArgs !== undefined) {
      R.spawnCalls.delete(callId);
      spawnResultInto(ev, spArgs, ctx);
      return R.spawnGroup ? R.spawnGroup.el : null;
    }
    var row = R.toolRows.get(callId);
    if (row) {
      patchToolRow(row, ev);
      return row.line;
    }
    /* 无配对 call（理论不至——投影完整性保证 call 先落）：结果单行兜底 */
    var s = el('div', 'line sub-line', '<span class="tree">⎿</span>' + esc(firstLineOf(ev.output)));
    placeIn(ctx, s);
    return s;
  }

  /** tool/result → 工具行原位合并（律一：局部替换，不重排）：Using→Used + chip；结果数据入 row——
   *  展开体已建则原位重装（保持展开态），未建则留待首次展开（收起态零预览——2026-10-12 走查）。 */
  function patchToolRow(row, ev) {
    var chip = resultChip({ isError: ev.isError === true, denied: ev.denied === true, truncated: ev.truncated === true, images: ev.images, output: ev.output, name: row.name, args: row.args });
    row.result = {
      output: typeof ev.output === 'string' ? ev.output : String(ev.output ?? ''),
      isError: ev.isError === true,
      denied: ev.denied === true,
      truncated: ev.truncated === true,
    };
    row.line.innerHTML = '<span class="tchar">●</span>' + toolHeadHtml(row.name, row.args, R.cwdOf(), true, chip) +
      '<span class="tcaret" aria-hidden="true">' + (row.body.hidden ? '▸' : '▾') + '</span>';
    if (ev.isError === true) row.line.classList.add('tool-err');
    if (ev.denied === true) row.line.classList.add('tool-denied');
    if (row.built) fillToolBody(row);
  }

  function firstLineOf(output) {
    var text = typeof output === 'string' ? output : String(output ?? '');
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) if (lines[i].trim() !== '') return lines[i];
    return '';
  }
  function insertAfter(ref, node) {
    var parent = ref.parentNode;
    if (!parent) return;
    parent.insertBefore(node, ref.nextSibling);
  }

  function emitTurnStart(ev, ctx) {
    if (ctx.turn && ctx.turn.provisional) {
      ctx.turn.provisional = false; /* chunk 先行的临时容器——收编 */
    } else {
      var t = el('div', 'turn');
      t.setAttribute('data-seq', String(ev.seq));
      ctx.appendTop(t);
      ctx.setTurn(t);
    }
    ctx.usage = null;
    return ctx.turn;
  }

  function emitTurnEnd(ev, ctx) {
    finalizeLive();
    var t = ensureTurn(ctx);
    if (ev.kind === 'interrupted') {
      t.appendChild(el('div', 'line sub-line', '<span class="tree">⎿</span><span class="bad">已停止生成</span> <span class="dim">· 停止按钮 / 双击 Esc 同效</span>'));
    } else if (ev.kind === 'error') {
      var msg = typeof ev.errorMessage === 'string' ? ev.errorMessage : '';
      t.appendChild(el('div', 'line sub-line', '<span class="tree">⎿</span><span class="bad">⚠ 回答出错' + (msg !== '' ? '：' + esc(msg) : '') + '</span>'));
    }
    var usage = ctx.usage;
    var usageText = usage ? '<span class="tf-time">↑ ' + fmtK(usage.input) + ' · ↓ ' + fmtK(usage.output) + '</span>' : '';
    var foot = el('div', 'turn-foot',
      '<button type="button" class="tf-btn" data-tf="copy" title="复制本轮回复（跨分页边界的轮次自动合并两段）">⧉ 复制</button>' +
      '<button type="button" class="tf-btn" data-tf="fork" title="从此处分叉会话">⑂ 分支</button>' +
      '<span class="tf-time">完成于 ' + esc(fmtTurnTime(ev.ts)) + '</span>' + usageText);
    foot.setAttribute('data-seq', String(ev.seq));
    t.appendChild(foot);
    ctx.setTurn(null);
    return foot;
  }

  /* ── 流式 chunk（律二：纯文本 append，rAF 合帧，零 markdown 解析） ── */
  function chunk(text) {
    if (R === null || typeof text !== 'string' || text === '') return;
    if (R.live.lineEl === null || !R.live.lineEl.isConnected) {
      var ctx = liveCtx();
      var t = ensureTurn(ctx);
      var line = el('div', 'line agent-line', '<span class="bullet">●</span>');
      var span = el('span', 'live-text');
      line.appendChild(span);
      t.appendChild(line);
      R.live.lineEl = line;
      R.live.textNode = document.createTextNode('');
      span.appendChild(R.live.textNode);
    }
    R.live.buf += text;
    rafFlush(flushChunk);
  }
  function flushChunk() {
    if (R === null || R.live.buf === '' || !R.live.textNode) return;
    R.live.textNode.appendData(R.live.buf);
    R.live.buf = '';
    followScroll();
    syncToBottom(); /* 流式长高——距底变远时浮钮即时出现（stick 期无 scroll 事件） */
  }

  /* ── 流式思考块（2026-10-12 走查六轮口令：reasoning 增量不再裸流成正文——折叠块承载，默认只显
   *  「▸[思考] · 持续了 N 秒 · 点击展开」标题行且秒数走字；全文不进 DOM（律二），用户手动展开才挂
   *  内容并随流增量；assistant/message 到达时正式块原位替换（finalizeLive 收编）。 ── */
  function thinkFlush() {
    if (R === null || !R.live.thinkOpen || !R.live.thinkBodyNode || R.live.thinkBuf === '') return;
    R.live.thinkBodyNode.appendData(R.live.thinkBuf);
    R.live.thinkBuf = '';
    followScroll();
    syncToBottom();
  }
  function thinkChunk(text) {
    if (R === null || typeof text !== 'string' || text === '') return;
    if (R.live.thinkEl === null || !R.live.thinkEl.isConnected) {
      var ctx = liveCtx();
      var t = ensureTurn(ctx);
      var tk = el('div', 'think collapsed', '');
      var headEl = el('div', 'think-head', '<span class="tcaret">▸</span>[思考] <span class="think-dur">· 持续了 1 秒</span> <span class="think-hint">· 点击展开</span>');
      var bodyEl = el('div', 'think-body');
      tk.appendChild(headEl);
      tk.appendChild(bodyEl);
      t.appendChild(tk);
      R.live.thinkEl = tk;
      R.live.thinkBuf = '';
      R.live.thinkSince = Date.now();
      R.live.thinkOpen = false;
      R.live.thinkBodyNode = document.createTextNode('');
      bodyEl.appendChild(R.live.thinkBodyNode);
      var durEl = headEl.querySelector('.think-dur');
      R.live.thinkTimer = window.setInterval(function () {
        if (R === null || R.live.thinkEl === null || !durEl) return;
        durEl.textContent = '· ' + fmtDur(Date.now() - R.live.thinkSince); /* 秒数走字（内容仍折叠） */
      }, 1000);
      headEl.addEventListener('click', function () {
        var collapsed = tk.classList.toggle('collapsed');
        R.live.thinkOpen = !collapsed;
        var caret = headEl.querySelector('.tcaret');
        if (caret) caret.textContent = collapsed ? '▸' : '▾';
        var hint = headEl.querySelector('.think-hint');
        if (hint) hint.textContent = '· 点击' + (collapsed ? '展开' : '收起');
        if (!collapsed && R.live.thinkBodyNode) { /* 展开一刻补挂累计全文（折叠期零 DOM——律二） */
          R.live.thinkBodyNode.appendData(R.live.thinkBuf);
          R.live.thinkBuf = '';
        } /* 展开零顺滚（走查八轮定案——同正式块：头行纹丝不动） */
        syncToBottom();
      });
    }
    if (R.live.thinkOpen && R.live.thinkBodyNode) {
      R.live.thinkBuf += text;
      rafFlush(thinkFlush);
    } else {
      R.live.thinkBuf += text; /* 折叠期纯累积——DOM 零触碰 */
    }
  }
  function finalizeLive() {
    /* 流式思考块收编（2026-10-12 走查六轮）：assistant/message 的正式块随后原位落（buildThink）；
     *  turn/end 中断档同口清——残块不留。 */
    if (R.live.thinkEl !== null) {
      R.live.thinkEl.remove();
      R.live.thinkEl = null;
      R.live.thinkBuf = '';
      R.live.thinkOpen = false;
      R.live.thinkBodyNode = null;
      if (R.live.thinkTimer !== null) { window.clearInterval(R.live.thinkTimer); R.live.thinkTimer = null; }
    }
    if (R.live.lineEl === null) return;
    R.live.lineEl.remove(); /* 流式行永远在转正块之前（chunk 追加即尾）——腾位后转正块落尾即原位 */
    R.live.lineEl = null;
    R.live.textNode = null;
    R.live.buf = '';
  }

  /* ── 尾行三态（C8：工作中 N 秒走字 / 压缩中 / 待命光标） ── */
  function setPhase(phase, isBusy) {
    if (R === null) return;
    R.busy = !!isBusy;
    if (phase === 'error') R.errorFlash = true;
    else if (isBusy) R.errorFlash = false;
    syncTail();
  }
  function setCompacting(on) {
    if (R === null) return;
    R.compacting = !!on;
    syncTail();
  }
  function syncTail() {
    if (R === null) return;
    window.clearInterval(R.busyTimer);
    R.busyTimer = null;
    var t = R.tail;
    if (R.compacting) {
      t.innerHTML = spinSvg('', 12) + ' <span class="info">上下文压缩中…</span>';
    } else if (R.busy) {
      R.busyStart = Date.now();
      /* 结构只建一次，走字只改文本节点——SVG 动画元素不被重写，旋转不重头（原型同款） */
      t.innerHTML = spinSvg('', 12) + ' 工作中 <span class="doing" id="tail-time"></span>';
      var tick = function () {
        if (R === null || R.busyTimer === null) return;
        var s = Math.max(1, Math.floor((Date.now() - R.busyStart) / 1000));
        var mm = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
        var te = t.querySelector('#tail-time');
        if (te) te.textContent = (mm > 0 ? mm + ' 分 ' : '') + ss + ' 秒';
      };
      tick();
      R.busyTimer = window.setInterval(tick, 1000);
    } else if (R.errorFlash) {
      t.innerHTML = '上轮报错 <span class="dim">· 详见流区</span>';
      window.setTimeout(function () {
        if (R && !R.busy && !R.compacting && R.errorFlash) { R.errorFlash = false; syncTail(); }
      }, 4000);
    } else {
      t.innerHTML = '正在待命 <span class="caret" aria-hidden="true"></span>';
    }
  }

  /* ── 装配 / 重置（切换会话——流区内容清空属会话切换面，非律一约束对象） ── */
  function open(opts) {
    if (R !== null) close();
    R = {
      sid: opts.sid,
      stream: opts.stream, tail: opts.tail, welcome: opts.welcome, pgMore: opts.pgMore,
      toBottom: opts.toBottom || null,
      onFork: opts.onFork || function () {},
      onCopy: opts.onCopy || function () {},
      onUserSeen: opts.onUserSeen || null,
      onAgentOpen: opts.onAgentOpen || function () {}, /* spawn 组卡行点击 → 回放窗（app.js 接线 ui.openSubagent） */
      cwdOf: opts.cwdOf || function () { return ''; },
      seqs: [], seqEls: new Map(), toolRows: new Map(), ghostCalls: new Set(), spawnCalls: new Map(), spawnGroup: null,
      openTurn: null,
      live: { lineEl: null, textNode: null, buf: '', thinkEl: null, thinkBuf: '', thinkSince: 0, thinkOpen: false, thinkTimer: null, thinkBodyNode: null },
      userSeen: false,
      busy: false, compacting: false, errorFlash: false,
      busyTimer: null, busyStart: 0,
      stick: true, loadingEarlier: false, hasMore: false,
      pendingClamp: [],
      pgArmed: false, pgCooling: false,
    };
    Array.prototype.slice.call(R.stream.children).forEach(function (c) {
      if (c !== R.welcome && c !== R.tail && c !== R.pgMore) c.remove();
    });
    R.pgMore.hidden = true;
    R.pgMore.textContent = '↑ 加载更早消息';
    R.welcome.hidden = false;
    R.tail.innerHTML = '正在连接…';
    bindOnce();
    if (R.toBottom) R.toBottom.hidden = true;
    return api;
  }

  function close() {
    if (R === null) return;
    window.clearInterval(R.busyTimer);
    if (R.live && R.live.thinkTimer !== null) window.clearInterval(R.live.thinkTimer);
    R = null;
  }

  /** 一只 .turn 容器内的正文文本（复制口径——agent-md/agent-line，行首 ● 剥离；.think 思考块永不入选）。
   *  agent-md 带 mdSource 时取正文 markdown 源串（2026-10-13 用户口令）——渲染态 textContent 会丢
   *  代码围栏/加粗/表格等标记；agent-line（流式未转正残段）无源串，退回 textContent。 */
  function turnTextsOf(t) {
    return Array.prototype.slice.call(t.querySelectorAll('.agent-md, .agent-line')).map(function (l) {
      if (typeof l.mdSource === 'string') return l.mdSource;
      return l.textContent.replace(/^●\s*/, '');
    });
  }

  function bindOnce() {
    if (bound) return;
    bound = true;
    var stream = R.stream, pgMore = R.pgMore;
    /* 流区点击委派：气泡展开/复制、轮操作行、图片放大（原型直裁 + 锚定口径） */
    stream.addEventListener('click', function (e) {
      var tg = e.target.closest('.msg-toggle');
      if (tg) {
        var mu = tg.closest('.msg-user');
        if (!mu) return;
        anchoredToggle(mu, function () {
          var expanded = mu.classList.toggle('expanded');
          mu.classList.toggle('msg-clamped', !expanded);
          tg.textContent = expanded ? '▴ 收起' : '▾ 展开全部';
        });
        return;
      }
      var mc = e.target.closest('[data-mcopy]');
      if (mc && R) {
        var bubble = mc.closest('.msg-user').querySelector('.msg-text');
        R.onCopy(bubble.textContent, '已复制消息');
        return;
      }
      var tf = e.target.closest('[data-tf]');
      if (tf && R) {
        var kind = tf.getAttribute('data-tf');
        var turn = tf.closest('.turn');
        if (kind === 'copy') {
          var texts = turnTextsOf(turn);
          /* 跨页 straddle（T16 复核 Minor① 收容案——复制取并集）：turn 内容分属相邻两只 .turn 容器
           *  （先旧后新——旧段无 foot、foot 挂新段）。本容器无正文时回溯无 foot 的前置 .turn 段并入，
           *  页界恰落 mid-turn 时不再拷空。 */
          if (texts.length === 0) {
            var p = turn.previousElementSibling;
            while (p && p.classList && p.classList.contains('turn') && !p.querySelector('.turn-foot')) {
              texts = turnTextsOf(p).concat(texts);
              p = p.previousElementSibling;
            }
          }
          R.onCopy(texts.join('\n'), texts.length > 0 ? '已复制本轮回复' : '（本轮无可复制文本）');
        } else if (kind === 'fork') {
          R.onFork(R.sid);
        }
        return;
      }
      var img = e.target.closest('.msg-img .photo');
      if (img) window.open(img.getAttribute('src'), '_blank'); /* C3：点击放大 */
    });
    /* 滚动：跟随判定（距底 40px）+ 回到底部浮钮显隐 + 滚顶自动加载更早（C2：先下滚 >40px 再回顶才触发 + 400ms 冷却） */
    stream.addEventListener('scroll', function () {
      if (R === null) return;
      R.stick = nearBottom();
      syncToBottom();
      if (R.pgMore.hidden) { R.pgArmed = false; return; }
      if (stream.scrollTop > STICK_PX) { R.pgArmed = true; return; }
      if (!R.pgArmed || R.pgCooling || R.loadingEarlier) return;
      R.pgCooling = true;
      R.pgArmed = false;
      loadEarlier();
      window.setTimeout(function () { if (R) R.pgCooling = false; }, 400);
    });
    pgMore.addEventListener('click', function () { loadEarlier(); });
    var toBottom = R.toBottom;
    if (toBottom) toBottom.addEventListener('click', function () {
      if (R === null) return;
      R.stick = true;
      R.stream.scrollTop = R.stream.scrollHeight;
      syncToBottom();
    });
  }

  /* ── 事件批摄入（首屏 / SSE ev / 翻页）——律一：append 或按 seq 补插，无整区重渲 ── */
  function ingest(events, opts) {
    if (R === null) return;
    opts = opts || {};
    var res = planAppend(R.seqs, events);
    R.seqs = res.seqs;
    var appends = [], inserts = [];
    for (var i = 0; i < res.ops.length; i++) (res.ops[i].op === 'append' ? appends : inserts).push(res.ops[i]);
    var wasStick = R.stick;
    for (var a = 0; a < appends.length; a++) {
      var primary = emitEvent(appends[a].ev, liveCtx());
      if (primary) R.seqEls.set(appends[a].seq, primary);
    }
    if (inserts.length > 0) applyInsertGroup(inserts);
    if (opts.page === 'latest') R.hasMore = (events || []).length >= PAGE; /* 满页 = 可能还有更早 */
    syncPgMore();
    flushClamps();
    if (wasStick) rafFlush(followScroll);
    syncToBottom();
  }

  function applyInsertGroup(ops) {
    var anchorEl = resolveAnchor(ops[0].beforeSeq);
    var frag = document.createDocumentFragment();
    var localClamp = [];
    var ctx = makeCtx(function (node) { frag.appendChild(node); }, localClamp);
    ctx.fragMode = true;
    /* 翻页保滚动：记录插入前高度，插完差值回写——视口内容稳定 */
    var h0 = R.stream.scrollHeight, st0 = R.stream.scrollTop;
    for (var i = 0; i < ops.length; i++) {
      var primary = emitEvent(ops[i].ev, ctx);
      if (primary) R.seqEls.set(ops[i].seq, primary);
    }
    /* 分页补插语义（评审 Important-4 定档，取代原「跨页 straddle 合并」——彼条件恒假系死代码已删）：
     *  锚 = stream 直属子级（resolveAnchor 上爬；turn 容器整只为插入位）→ 本批整段插在锚前，
     *  时序恒正确。跨页 straddle（边界落 mid-turn）时同轮内容分属相邻两只 .turn 容器（先旧后新）：
     *  placeIn 收容（Important-3）保证旧段自成容器非散落、turn/end 认领新段挂 foot——各自容器的
     *  复制/悬停独立成立，不重排不丢序。 */
    if (anchorEl) R.stream.insertBefore(frag, anchorEl);
    else R.stream.insertBefore(frag, R.tail); /* 无锚（更早全空——理论不至）——落底 */
    var dh = R.stream.scrollHeight - h0;
    if (dh > 0) R.stream.scrollTop = st0 + dh; /* 视口内容稳定（翻页不跳） */
    R.stick = false; /* 回看历史——退出跟随 */
    measureClamp(localClamp);
  }

  function resolveAnchor(beforeSeq) {
    for (var i = 0; i < R.seqs.length; i++) {
      if (R.seqs[i] < beforeSeq) continue;
      var e = R.seqEls.get(R.seqs[i]);
      if (e && e.isConnected) {
        var n = e; /* 上爬到 stream 直属子级（锚在 turn 内 → 以该 turn 容器为插入位） */
        while (n.parentElement && n.parentElement !== R.stream) n = n.parentElement;
        return n;
      }
    }
    return null;
  }

  function flushClamps() {
    var list = R.pendingClamp.splice(0);
    measureClamp(list);
  }
  function measureClamp(list) {
    for (var i = 0; i < list.length; i++) {
      var wrap = list[i];
      if (!wrap.isConnected) continue;
      var bt = wrap.querySelector('.msg-text');
      if (!bt) continue;
      var lh = parseFloat(getComputedStyle(bt).lineHeight) || 24.5;
      if (bt.scrollHeight > lh * 5.5 + 4) wrap.classList.add('msg-clamped');
    }
  }

  function syncPgMore() {
    R.pgMore.hidden = !(R.hasMore && R.seqs.length > 0);
  }

  /* ── 向旧翻页（C2）：events API after 游标——after = 最旧 seq − 1 − 页宽（T3 报告定档算法） ── */
  function loadEarlier() {
    if (R === null || R.loadingEarlier || !R.hasMore || R.seqs.length === 0) return;
    R.loadingEarlier = true;
    R.pgMore.textContent = '加载中…';
    var oldest = R.seqs[0];
    var after = Math.max(0, oldest - 1 - PAGE);
    fetchJson('/api/sessions/' + encodeURIComponent(R.sid) + '/events?after=' + after + '&limit=' + PAGE)
      .then(function (r) {
        var evs = r.events ?? [];
        R.loadingEarlier = false;
        R.pgMore.textContent = '↑ 加载更早消息';
        if (evs.length === 0) { R.hasMore = false; syncPgMore(); return; }
        ingest(evs, { page: 'earlier' });
        R.hasMore = evs.length >= PAGE; /* 满页 = 可能还有更早；短页 = 已到头 */
        syncPgMore();
      }, function () {
        R.loadingEarlier = false;
        R.pgMore.textContent = '↑ 加载更早消息';
        syncPgMore();
      });
  }

  /* ── 供 app.js 的辅助口 ── */
  function maxSeq() { return R ? (R.seqs.length > 0 ? R.seqs[R.seqs.length - 1] : 0) : 0; }
  function userSeen() { return R ? R.userSeen : false; }
  function appendMarkLine(text) {
    if (R === null) return;
    var m = el('div', 'line mark-line', esc(text));
    R.stream.insertBefore(m, R.tail);
    if (R.stick) R.stream.scrollTop = R.stream.scrollHeight;
  }

  /** transcript 回放窗渲染（/tasks 查看窗——子代理 jsonl 原始行，无 seq；一次性静态渲染 ≤500 行）。 */
  function renderTranscript(container, events) {
    container.innerHTML = '';
    var localClamp = [];
    var ctx = makeCtx(function (node) { container.appendChild(node); }, localClamp);
    var evs = (events || []).slice(-500);
    for (var i = 0; i < evs.length; i++) emitEvent(evs[i], ctx);
    measureClamp(localClamp);
  }

  /* ── 模块导出面（浏览器 window === globalThis；node 测试同源） ── */
  var api = {
    /* 纯函数（node 直测面） */
    planAppend: planAppend,
    isGhostTool: isGhostTool,
    toolDisplayName: toolDisplayName,
    toolKeyArg: toolKeyArg,
    toolHeadText: toolHeadText,
    toolHeadHtml: toolHeadHtml,
    toolTailOf: toolTailOf,
    crWash: crWash,
    outputLinesOf: outputLinesOf,
    pageSlice: pageSlice,
    lineCountOf: lineCountOf,
    diffRowsOf: diffRowsOf,
    changeStatsOf: changeStatsOf,
    resultChip: resultChip,
    skillMarkOf: skillMarkOf,
    textOf: textOf,
    imagesOf: imagesOf,
    reasoningOf: reasoningOf,
    fmtK: fmtK,
    fmtDur: fmtDur,
    fmtTurnTime: fmtTurnTime,
    esc: esc,
    /* DOM 应用层 */
    open: open,
    ingest: ingest,
    chunk: chunk,
    thinkChunk: thinkChunk,
    setPhase: setPhase,
    setCompacting: setCompacting,
    maxSeq: maxSeq,
    userSeen: userSeen,
    appendMarkLine: appendMarkLine,
    renderTranscript: renderTranscript,
    close: close,
  };
  globalThis.OrosusRender = api;
})();
