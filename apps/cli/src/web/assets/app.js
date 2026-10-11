/* Orosus web 前端骨架（web 批 T15）——app.js：启动序（health 自证 → bootstrap → currentSid/最新会话）、
 * 主题切换、左栏（B1-B15 前端面：新会话跟随/分组折叠/每组 5 条展开更多/置顶/当前高亮/收缩窄轨/
 * 2s 轮询/行首活动指示/工作区行三功能/会话行双钮与右键七项）、右栏三页签壳 + 任务清单 + 收缩悬浮卡、
 * appbar 按钮壳接线。
 * 流区渲染（render.js）与浮层交互（ui.js）是 T16/T17——本件只做状态机骨架，不做流区内容渲染。
 * 性能律：轮询回调字段 diff（渲染签名比对）后按需更新 DOM，数据不变不碰 DOM。 */
function $(id) { return document.getElementById(id); }
(function () {
  'use strict';
  var A = window.OrosusAPI;
  var esc = A.esc;

  /* ═══════════ refs ═══════════ */
  var tailEl = $('stream-tail');
  var welcomeEl = $('welcome');
  var lsBody = $('ls-body');
  var lside = $('lside');
  var rside = $('rside');
  var toastline = $('toastline');

  /* ═══════════ toast（原型直裁：输入框上边缘黄字行、自消） ═══════════ */
  var toastTimer = null;
  function toast(text, durationMs) {
    toastline.textContent = text;
    toastline.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { toastline.classList.remove('show'); }, Math.max(1000, Math.min(30000, durationMs ?? 3000)));
  }
  function copyText(t, okMsg) {
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch { /* 剪贴板被拒 */ }
      ta.remove();
      toast(ok ? okMsg : '复制失败');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { toast(okMsg); }, fallback);
    } else fallback();
  }

  /* 圆弧旋转 spinner（原型直裁——SVG 弧段整圈旋转） */
  function spinSvg(cls, size) {
    var s = size ?? 11;
    return '<svg class="spin-svg' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="40" stroke-dashoffset="16"/></svg>';
  }

  /* ═══════════ 主题：深 / 浅切换（localStorage 记忆——原型直裁） ═══════════ */
  var btnTheme = $('btn-theme');
  function applyTheme(light) {
    document.body.classList.toggle('light', light);
    btnTheme.textContent = light ? '☾ 深色' : '☀ 浅色';
    try { localStorage.setItem('orosus-web-theme', light ? 'light' : 'dark'); } catch { /* 存储被拒 */ }
  }
  btnTheme.addEventListener('click', function () { applyTheme(!document.body.classList.contains('light')); });
  try { applyTheme(localStorage.getItem('orosus-web-theme') === 'light'); } catch { /* 同上 */ }

  /* ═══════════ 全局状态 ═══════════ */
  var currentSid = null;          /* 当前查看的会话（视图态） */
  var streamCtl = null;           /* openStream 控制器 */
  var sessionsData = { pinned: [], groups: [] };
  var prevRowMap = new Map();     /* 上一轮 SessionRow（B14 转移检测：跑完→done） */
  var panelInfo = null;           /* {data, fetchedAt}——运行时间跳秒基准 */
  var sessionTitle = '';
  var busy = false;               /* 当前会话 turn 进行中（phase 帧驱动——T16 流区联动消费同位） */

  /* 会话活动指示持久化（B14：done/failed 终态 + lastSeen per-sid——重开不复燃） */
  var SACT_KEY = 'orosus-web-sact';
  var SEEN_KEY = 'orosus-web-lastseen';
  function loadJson(key) { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; } }
  function saveJson(key, m) { try { localStorage.setItem(key, JSON.stringify(m)); } catch { /* 存储被拒 */ } }
  function sactAll() { return loadJson(SACT_KEY); }
  function sactSet(sid, act) { var m = sactAll(); m[sid] = { act: act, at: Date.now() }; saveJson(SACT_KEY, m); }
  function seenSet(sid) { var m = loadJson(SEEN_KEY); m[sid] = Date.now(); saveJson(SEEN_KEY, m); }

  /* 分组折叠/展开数（按 cwd 记——2s 轮询重渲保持状态，B15） */
  var groupOpen = {};   /* cwd → bool（缺省 true） */
  var groupShow = {};   /* cwd → 已展条数（缺省 5，每次多展 5） */

  /* ═══════════ 工具 ═══════════ */
  function fmtRel(ms) {
    if (ms < 60 * 1000) return '刚刚';
    if (ms < 60 * 60 * 1000) return Math.floor(ms / 60000) + ' 分';
    if (ms < 24 * 3600 * 1000) return Math.floor(ms / 3600000) + ' 小时';
    if (ms < 48 * 3600 * 1000) return '昨天';
    if (ms < 7 * 24 * 3600 * 1000) return Math.floor(ms / 86400000) + ' 天';
    if (ms < 14 * 24 * 3600 * 1000) return '上周';
    var d = new Date(Date.now() - ms);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function fmtK(n) {
    if (n === undefined || n === null) return '—';
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
  function fmtElapsed(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    var h = Math.floor(m / 60);
    return h + ' 时 ' + (m % 60) + ' 分';
  }

  /* ═══════════ 左栏：渲染（B3/B5/B7/B14/B15） ═══════════ */
  var PHASE_DOT = { running: ['●', 'sdot-run'], 'waiting-approval': ['◉', 'sdot-wait'], 'waiting-input': ['◉', 'sdot-wait'], error: ['✗', 'sdot-err'], idle: ['○', 'sdot-idle'] };
  var PIN_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 7 3.2 3.2V16H6.8v-1.8L10 11 9 4z"/><path d="M12 16v5"/></svg>';
  var ARCHIVE_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h18v4H3z"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>';

  /* 行首活动指示（B14）：进行中转圈 / 完成未读绿点 / 失败红点（localStorage 终态持久化——重开不
   *  复燃）/ phase 图标 / ○。真跑（live running/waiting）压过旧终态；终态压过 idle 瞬态。
   *  sact/seen 两表由调用方按渲染批次读一次（行级不再各读 localStorage）。 */
  function rowActivity(row, prev, sact, seen) {
    var running = row.live && (row.phase === 'running' || row.phase === 'waiting-approval' || row.phase === 'waiting-input');
    if (running) return { k: 'running' };
    if (row.live && row.phase === 'error') { sactSet(row.sid, 'failed'); return { k: 'failed' }; }
    var m = sact[row.sid];
    if (m && m.at > (seen[row.sid] ?? 0)) return { k: m.act };
    /* 转移检测：上一轮在跑、本轮歇了 → 完成（绿点源——下次渲染起生效） */
    if (prev && prev.live && (prev.phase === 'running' || prev.phase === 'waiting-approval' || prev.phase === 'waiting-input') && !running) {
      sactSet(row.sid, 'done');
      return { k: 'done' };
    }
    return { k: 'phase', phase: row.phase };
  }
  function sactHtml(act) {
    if (act.k === 'running') return '<span class="sact">' + spinSvg() + '</span>';
    if (act.k === 'done') return '<span class="sact done">●</span>';
    if (act.k === 'failed') return '<span class="sact failed">●</span>';
    var pd = act.phase ? PHASE_DOT[act.phase] : null;
    if (pd) return '<span class="sdot ' + pd[1] + '">' + pd[0] + '</span>';
    return '<span class="sdot sdot-none">○</span>';
  }
  function lsRowHtml(row, prev, pinned, sact, seen) {
    var act = rowActivity(row, row.cur ? null : prev, sact, seen);
    var title = row.label !== '' ? row.label : (row.fresh ? '新会话' : '（未命名会话）');
    return '<div class="ls-item' + (row.cur ? ' cur' : '') + (pinned ? ' pinned-row' : '') + '" data-sid="' + esc(row.sid) + '" data-pinned="' + (pinned ? 1 : '') + '">' +
      sactHtml(act) +
      '<span class="stitle" title="' + esc(title) + '">' + esc(title) + '</span>' +
      (row.cur ? '<span class="curtag">当前</span>' : '') +
      '<button class="sact-btn spin-pin" data-sact="pin" title="' + (pinned ? '取消置顶' : '置顶') + '">' + PIN_SVG + '</button>' +
      (row.fresh ? '' : '<button class="sact-btn" data-sact="archive" title="归档">' + ARCHIVE_SVG + '</button>') +
      '<span class="srel">' + esc(fmtRel(row.relMs)) + '</span>' +
      '</div>';
  }
  /* 渲染签名门（性能律）：可见内容（含相对时间取整文案）不变 → DOM 一字不动 */
  var lsSig = null;
  function renderSidebar() {
    var sact = sactAll();
    var seen = loadJson(SEEN_KEY);
    var html = '<div class="ls-sec"><span>已置顶</span><span class="ls-count">' + sessionsData.pinned.length + '</span><button class="ls-collapse" id="ls-collapse" title="收起会话栏">⇤</button></div>';
    if (sessionsData.pinned.length === 0) html += '<div class="ls-sec ls-hint"><span>（悬停会话行可置顶）</span></div>';
    html += sessionsData.pinned.map(function (s) { return lsRowHtml(s, prevRowMap.get(s.sid), true, sact, seen); }).join('');
    html += '<div class="ls-sec"><span>项目</span><span class="ls-count">' + sessionsData.groups.length + '</span></div>';
    sessionsData.groups.forEach(function (g) {
      var open = groupOpen[g.cwd] !== false;
      var limit = groupShow[g.cwd] ?? 5;
      html += '<div class="ls-group" data-group="' + esc(g.cwd) + '" data-path="' + esc(g.cwd) + '"><span class="gcaret">' + (open ? '▾' : '▸') + '</span><span class="gname">' + esc(g.name) + '</span><span class="gcount">' + g.sessions.length + '</span><span class="g-acts"><button class="g-act" data-gact="more" title="更多">⋯</button><button class="g-act" data-gact="new" title="在该工作区下新建会话">＋</button></span></div>';
      if (open) {
        html += g.sessions.slice(0, limit).map(function (s) { return lsRowHtml(s, prevRowMap.get(s.sid), false, sact, seen); }).join('');
        if (g.sessions.length > limit) {
          html += '<div class="ls-more" data-more="' + esc(g.cwd) + '">∨ 展开更多（还有 ' + (g.sessions.length - limit) + ' 条）</div>';
        }
      }
    });
    if (sessionsData.groups.length === 0) html += '<div class="ls-sec ls-hint"><span>（暂无项目——点击上方「＋ 新会话」开始）</span></div>';
    if (html === lsSig) return; /* 数据无变化——DOM 零触碰 */
    lsSig = html;
    lsBody.innerHTML = html;
    var col = $('ls-collapse');
    if (col) col.addEventListener('click', function () { lside.classList.add('rail'); });
  }
  function rememberRows(data) {
    var m = new Map();
    data.pinned.forEach(function (s) { m.set(s.sid, s); });
    data.groups.forEach(function (g) { g.sessions.forEach(function (s) { if (!m.has(s.sid)) m.set(s.sid, s); }); });
    return m;
  }
  /* 2s 轮询回调（diff 后按需更新——签名门内建；失败静默——断连面由 SSE 看门狗管） */
  function pollSessions() {
    return A.fetchJson('/api/sessions').then(function (data) {
      var next = rememberRows(data);
      sessionsData = data;
      renderSidebar();
      prevRowMap = next;
      /* 当前会话行标签/活动可能变了——顶栏与右栏标题随行刷新 */
      var cur = next.get(currentSid ?? '');
      if (cur && cur.label !== '' && cur.label !== sessionTitle) setSessionTitle(cur.label, cur.sid);
    }, function () { /* 同上 */ });
  }

  /* ═══════════ 左栏：交互（B1/B5/B8-B13） ═══════════ */
  lsBody.addEventListener('click', function (e) {
    var act = e.target.closest('.g-act');
    if (act) {
      var g = findGroup(act.closest('.ls-group').getAttribute('data-group'));
      if (g) {
        if (act.getAttribute('data-gact') === 'more') openWsCtxMenu(g, act);
        else newSessionInProject(g);
      }
      return;
    }
    var grp = e.target.closest('.ls-group');
    if (grp) {
      var cwd = grp.getAttribute('data-group');
      groupOpen[cwd] = groupOpen[cwd] === false;
      renderSidebar();
      return;
    }
    var more = e.target.closest('.ls-more');
    if (more) {
      var cwd2 = more.getAttribute('data-more');
      groupShow[cwd2] = (groupShow[cwd2] ?? 5) + 5;
      renderSidebar();
      return;
    }
    var row = e.target.closest('.ls-item');
    if (!row) return;
    var sid = row.getAttribute('data-sid');
    if (e.target.closest('[data-sact="archive"]')) { archiveSession(sid); return; }
    if (e.target.closest('[data-sact="pin"]')) { togglePin(sid); return; }
    if (sid !== currentSid) openSession(sid);
  });
  lsBody.addEventListener('contextmenu', function (e) {
    var row = e.target.closest('.ls-item');
    if (!row) return;
    e.preventDefault();
    openSessionCtxMenu(row.getAttribute('data-sid'), e.clientX, e.clientY);
  });
  $('ls-collapse-rail').addEventListener('click', function () { lside.classList.remove('rail'); });

  function findGroup(cwd) {
    for (var i = 0; i < sessionsData.groups.length; i++) if (sessionsData.groups[i].cwd === cwd) return sessionsData.groups[i];
    return null;
  }
  function findRow(sid) {
    var i;
    for (i = 0; i < sessionsData.pinned.length; i++) if (sessionsData.pinned[i].sid === sid) return { row: sessionsData.pinned[i], pinned: true };
    for (var j = 0; j < sessionsData.groups.length; j++) {
      var ss = sessionsData.groups[j].sessions;
      for (i = 0; i < ss.length; i++) if (ss[i].sid === sid) return { row: ss[i], pinned: false, group: sessionsData.groups[j] };
    }
    return null;
  }
  function rowTitle(sid) {
    var f = findRow(sid);
    if (!f) return sid;
    return f.row.label !== '' ? f.row.label : (f.row.fresh ? '新会话' : '（未命名会话）');
  }
  /* 剩余首个会话（置顶优先——归档/删除/移除工作区切走口径） */
  function firstRemaining(excludeCwd) {
    for (var i = 0; i < sessionsData.pinned.length; i++) {
      var p = sessionsData.pinned[i];
      var g = findGroupOfSid(p.sid);
      if (!g || g.cwd !== excludeCwd) return p.sid;
    }
    for (var j = 0; j < sessionsData.groups.length; j++) {
      if (sessionsData.groups[j].cwd === excludeCwd) continue;
      var ss = sessionsData.groups[j].sessions;
      if (ss.length > 0) return ss[0].sid;
    }
    return null;
  }
  function findGroupOfSid(sid) {
    for (var j = 0; j < sessionsData.groups.length; j++) {
      if (sessionsData.groups[j].sessions.some(function (s) { return s.sid === sid; })) return sessionsData.groups[j];
    }
    return null;
  }

  /* ＋ 新会话（B1：不带 cwd 直发——跟随当前会话项目） */
  $('btn-new').addEventListener('click', function () { void createSession({}); });
  function createSession(body) {
    return A.fetchJson('/api/sessions', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      if (r.reused) toast('已有空会话——沿用并刷新创建时间');
      return switchTo(r.sid).then(function () { return r; });
    }, function (err) { toast('新建会话失败：' + err.message); });
  }
  /* 工作区行 ＋（B9）：在该工作区下新建（fresh 沿用语义在 server 侧，reused 提示同口） */
  function newSessionInProject(g) {
    void createSession({ cwd: g.cwd }).then(function (r) {
      if (r && !r.reused) toast('已在「' + g.name + '」下新建会话');
    });
  }
  /* 点击切换（B5）：POST {resumeSid} host 换轨 + 视图切换 */
  function openSession(sid) {
    return A.fetchJson('/api/sessions', { method: 'POST', body: JSON.stringify({ resumeSid: sid }) }).then(function (r) {
      return switchTo(r.sid);
    }, function (err) { toast('打开会话失败：' + err.message); });
  }
  /* 置顶（B2/B11） */
  function togglePin(sid) {
    A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/pin', { method: 'POST', body: '{}' }).then(function (r) {
      toast(r.pinned ? '已置顶「' + rowTitle(sid) + '」' : '已取消置顶「' + rowTitle(sid) + '」');
      void pollSessions();
    }, function (err) { toast('置顶失败：' + err.message); });
  }
  /* 归档（B12）：归档当前会话 → 切剩余首个（置顶优先） */
  function archiveSession(sid) {
    A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/archive', { method: 'POST', body: '{}' }).then(function () {
      toast('已归档「' + rowTitle(sid) + '」——设置 ▸ 已归档的会话 可恢复');
      return afterMaybeCurrentGone(sid);
    }, function (err) { toast('归档失败：' + err.message); });
  }
  /* 删除（B11）：overlay2 确认层叠于设置弹窗之上 */
  function deleteSession(sid) {
    A.fetchJson('/api/sessions/' + encodeURIComponent(sid), { method: 'DELETE' }).then(function () {
      toast('已永久删除「' + rowTitle(sid) + '」');
      var m = sactAll(); delete m[sid]; saveJson(SACT_KEY, m);
      return afterMaybeCurrentGone(sid);
    }, function (err) { toast(err.status === 409 ? '删除被拒：' + err.message : '删除失败：' + err.message); });
  }
  /* 当前会话被归档/删除/其工作区被移除后：切剩余首个（无则空态） */
  function afterMaybeCurrentGone(goneSid) {
    return pollSessions().then(function () {
      if (goneSid !== currentSid) return;
      var next = firstRemaining(findGroupOfSid(goneSid)?.cwd);
      if (next) return openSession(next);
      /* 无会话可切——空态 */
      if (streamCtl) streamCtl.close();
      streamCtl = null;
      currentSid = null;
      setSessionTitle('', '');
      showWelcome(true);
      tailEl.textContent = '暂无会话——点击左栏「＋ 新会话」开始';
      return undefined;
    });
  }
  /* 重命名（B11）：弹窗输入 → /title 命令通道。当前会话直发；非当前会话先 resume 打开再发
   *  （任意会话重命名的 HTTP 面后端未交付——setTitle 未挂路由，报告留档；副作用 = 重命名后
   *  该会话成为当前会话）。 */
  function renameSession(sid) {
    modalClose();
    openModal({
      title: '重命名会话',
      en: sid,
      bodyHtml: '<div class="pf-row rename-row"><label>会话名</label><input class="fi" id="rename-input" /></div>',
      actionsHtml: '<span class="spacer"></span><button class="btn" data-act="cancel">取消</button><button class="btn primary" data-act="save">保存</button>',
      onAction: function (a) {
        if (a === 'save') {
          var v = document.getElementById('rename-input').value.trim();
          if (v !== '') void doRename(sid, v);
        }
        modalClose();
      },
    });
    window.setTimeout(function () { var el = document.getElementById('rename-input'); if (el) { el.value = rowTitle(sid) === '（未命名会话）' ? '' : rowTitle(sid); el.focus(); } }, 30);
  }
  function doRename(sid, name) {
    var send = function (target) {
      return A.fetchJson('/api/sessions/' + encodeURIComponent(target) + '/send', { method: 'POST', body: JSON.stringify({ text: '/title ' + name }) }).then(function (r) {
        toast(r.output || '已命名 → ' + name);
        if (target === currentSid) setSessionTitle(name, sid);
        void pollSessions();
      }, function (err) { toast('重命名失败：' + err.message); });
    };
    if (sid === currentSid) return send(sid);
    openSession(sid).then(function () { return send(sid); });
  }
  /* 导出（B11）：fetch blob 下载（token 走头——不进地址栏历史） */
  function exportSession(sid) {
    fetch('/api/sessions/' + encodeURIComponent(sid) + '/export.md', { headers: { 'x-orosus-token': A.getToken() } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var cd = res.headers.get('content-disposition') || '';
      var m = /filename="([^"]+)"/.exec(cd);
      return res.blob().then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = m ? m[1] : 'oro-' + sid + '.md';
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        toast('已导出 ' + a.download);
      });
    }, function (err) { toast('导出失败：' + err.message); });
  }

  /* ═══════════ 右键菜单（原型 :3554-3666 直裁——图标 SVG + 定位 + 互清） ═══════════ */
  function ic(name) {
    var P = {
      fork: '<circle cx="12" cy="18" r="2.4"/><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><path d="M18 8.4v1.2c0 1-.8 2-2 2H8c-1.2 0-2-1-2-2V8.4"/><path d="M12 11.6v3.2"/>',
      pin: '<path d="M9 4h6l-1 7 3.2 3.2V16H6.8v-1.8L10 11 9 4z"/><path d="M12 16v5"/>',
      archive: '<path d="M3 4h18v4H3z"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
      edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
      copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
      trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
      folderX: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h7"/><path d="m14 13 6 6"/><path d="m20 13-6 6"/>',
    }[name] ?? '';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P + '</svg>';
  }
  var ctxMenu = $('ctx-menu');
  var ctxGroup = null, ctxSid = null;
  function hideCtx() { ctxMenu.hidden = true; ctxGroup = null; ctxSid = null; }
  document.addEventListener('click', function (e) {
    if (ctxMenu.hidden) return;
    if (e.target.closest('#ctx-menu') || e.target.closest('.g-act')) return;
    hideCtx();
  });
  /* 工作区 ⋯ 菜单（B10）：复制路径 / 移除工作区 */
  function openWsCtxMenu(g, anchorEl) {
    ctxGroup = g;
    ctxSid = null;
    ctxMenu.innerHTML = '<button class="ctx-item" data-ctx="copy">' + ic('copy') + '复制路径</button>' +
      '<button class="ctx-item danger" data-ctx="remove">' + ic('folderX') + '移除工作区…</button>';
    ctxMenu.hidden = false;
    var r = anchorEl.getBoundingClientRect();
    ctxMenu.style.left = Math.round(r.right - ctxMenu.offsetWidth) + 'px';
    ctxMenu.style.top = Math.round(r.bottom + 4) + 'px';
  }
  /* 会话右键菜单（B11 七项；fresh 无归档项） */
  function openSessionCtxMenu(sid, x, y) {
    var f = findRow(sid);
    if (!f) return;
    ctxSid = sid;
    ctxGroup = null;
    ctxMenu.innerHTML =
      '<button class="ctx-item" data-ctx="fork">' + ic('fork') + '分叉会话</button>' +
      '<button class="ctx-item" data-ctx="pin">' + ic('pin') + (f.pinned ? '取消置顶' : '置顶') + '</button>' +
      (f.row.fresh ? '' : '<button class="ctx-item" data-ctx="archive">' + ic('archive') + '归档</button>') +
      '<button class="ctx-item" data-ctx="rename">' + ic('edit') + '重命名</button>' +
      '<button class="ctx-item" data-ctx="copyid">' + ic('copy') + '复制会话 ID</button>' +
      '<button class="ctx-item" data-ctx="export">' + ic('download') + '导出会话</button>' +
      '<button class="ctx-item danger" data-ctx="delete">' + ic('trash') + '删除</button>';
    ctxMenu.hidden = false;
    ctxMenu.style.left = Math.min(x, window.innerWidth - 170) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - 260) + 'px';
  }
  ctxMenu.addEventListener('click', function (e) {
    var item = e.target.closest('[data-ctx]');
    if (!item) return;
    var act = item.getAttribute('data-ctx');
    hideCtx();
    if (ctxSid !== null) { sessionCtxAct(act, ctxSid); return; }
    var g = ctxGroup;
    ctxGroup = null;
    if (!g) return;
    if (act === 'copy') copyText(g.cwd, '已复制路径');
    else if (act === 'remove') {
      var currentInGoneWs = currentSid !== null && findGroupOfSid(currentSid)?.cwd === g.cwd;
      openConfirm({
        title: '移除工作区',
        bodyHtml: '<div class="pu-text">确认从列表移除工作区「<b>' + esc(g.name) + '</b>」？\n\n' +
          '<span class="info">' + esc(g.cwd) + '</span>\n\n' +
          '<span class="dim">文件夹和文件不会被删除，其中的会话记录也会保留，重新添加该文件夹即可找回。</span></div>',
        confirmText: '移除',
        onConfirm: function () {
          A.fetchJson('/api/workspaces/hide', { method: 'POST', body: JSON.stringify({ cwd: g.cwd }) }).then(function () {
            toast('已移除工作区「' + g.name + '」——文件与会话记录均保留，重新添加即可找回');
            if (currentInGoneWs) return afterMaybeCurrentGone(currentSid);
            return pollSessions();
          }, function (err) { toast('移除失败：' + err.message); });
        },
      });
    }
  });
  function sessionCtxAct(act, sid) {
    if (act === 'fork') {
      void createSession({ forkFrom: sid }).then(function (r) { if (r) toast('已分叉出新会话——继承全部上下文'); });
    } else if (act === 'pin') {
      togglePin(sid);
    } else if (act === 'archive') {
      archiveSession(sid);
    } else if (act === 'rename') {
      renameSession(sid);
    } else if (act === 'copyid') {
      copyText(sid, '已复制会话 ID ' + sid);
    } else if (act === 'export') {
      exportSession(sid);
    } else if (act === 'delete') {
      openConfirm({
        title: '删除会话',
        bodyHtml: '<div class="pu-text">将永久删除「<b>' + esc(rowTitle(sid)) + '</b>」的全部对话记录，无法恢复。\n\n<span class="dim">工作区里的文件和代码改动不受影响。</span></div>',
        confirmText: '永久删除',
        onConfirm: function () { void deleteSession(sid); },
      });
    }
  }

  /* ═══════════ 确认弹窗层 overlay2（原型 :3569-3591 直裁——叠于设置弹窗之上） ═══════════ */
  var overlay2 = $('overlay2');
  var modal2 = $('modal2');
  var confirmYes = null; /* 当前确认弹窗的「确认」回调（openConfirm/closeConfirm 成对维护） */
  function openConfirm(opts) {
    modal2.innerHTML = '<div class="pu-head"><span class="pu-title">' + opts.title + '</span><span class="pu-close" data-c2="no" title="取消（Esc）">✕</span></div>' +
      '<div class="pu-body">' + opts.bodyHtml + '</div>' +
      '<div class="pu-actions right"><button class="btn" data-c2="no">取消</button><button class="btn del" data-c2="yes">' + (opts.confirmText ?? '永久删除') + '</button></div>';
    overlay2.hidden = false;
    confirmYes = opts.onConfirm;
  }
  function closeConfirm() { overlay2.hidden = true; modal2.innerHTML = ''; confirmYes = null; }
  modal2.addEventListener('click', function (e) {
    var b = e.target.closest('[data-c2]');
    if (!b) return;
    var yes = b.getAttribute('data-c2') === 'yes';
    var fn = confirmYes;
    closeConfirm();
    if (yes && fn) fn();
  });
  overlay2.addEventListener('click', function (e) { if (e.target === overlay2) closeConfirm(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay2.hidden) { e.stopPropagation(); closeConfirm(); }
  }, true);

  /* ═══════════ 居中弹窗壳（设置 / 帮助 / 更多 / 重命名——栈式；T17 填十页真内容） ═══════════ */
  var overlay = $('overlay');
  var modal = $('modal');
  var modalStack = [];
  function renderModal() {
    var top = modalStack[modalStack.length - 1];
    if (!top) { overlay.hidden = true; modal.innerHTML = ''; return; }
    modal.className = 'modal' + (top.wide ? ' settings-modal' : '');
    modal.innerHTML = '<div class="pu-head"><span class="pu-title">' + top.title + '</span>' +
      '<span class="pu-en">' + (top.en ?? '') + '</span>' +
      (modalStack.length > 1 ? '<button class="btn" data-mback>‹ 返回</button>' : '') +
      '<span class="pu-close" data-mclose title="关闭（Esc）">✕</span></div>' +
      '<div class="pu-body">' + top.bodyHtml + '</div>';
    overlay.hidden = false;
  }
  function openModal(opts) { modalStack.push(opts); renderModal(); }
  function modalBack() { modalStack.pop(); renderModal(); }
  function modalClose() { modalStack = []; renderModal(); }
  modal.addEventListener('click', function (e) {
    if (e.target.closest('[data-mclose]')) { modalClose(); return; }
    if (e.target.closest('[data-mback]')) { modalBack(); return; }
    var act = e.target.closest('[data-act]');
    var top = modalStack[modalStack.length - 1];
    if (act && top && top.onAction) top.onAction(act.getAttribute('data-act'));
  });
  overlay.addEventListener('click', function (e) { if (e.target === overlay) modalClose(); });
  function modalEsc() { if (modalStack.length > 1) modalBack(); else modalClose(); }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay.hidden) modalEsc();
  });

  /* appbar 按钮壳接线（A5/A6/A7 占位壳——真内容 T17；主题 A8 已在上面接好） */
  function openShellModal(title, en, note) {
    openModal({ title: title, en: en, bodyHtml: '<div class="pu-text"><span class="dim">' + esc(note) + '</span></div>' });
  }
  $('btn-settings').addEventListener('click', function () { openShellModal('设置', 'SETTINGS', '设置中心建设中——常规 / 提供商与模型 / 技能 / 钩子 / MCP / 记忆 / 已归档的会话等十页将在此接入。'); });
  $('btn-help').addEventListener('click', function () { openShellModal('帮助', 'HELP', '帮助与快捷键对照表建设中——/ 命令菜单、@ 文件引用、Enter 发送等交互已可用。'); });
  $('btn-more').addEventListener('click', function () { openShellModal('更多', 'MORE', '模块诊断 / 模块总览 / 钩子注入 / 压缩摘要建设中（TUI 的 Ctrl+E/P/H/O）。'); });
  $('btn-update').addEventListener('click', function () { openShellModal('更新', 'UPDATE', '更新内容弹窗建设中。'); });

  /* ═══════════ 当前会话视图（appbar 标题 / 流区骨架态 / SSE 状态机） ═══════════ */
  var sessionTitleEl = $('session-title');
  var kvSession = $('kv-session');
  function setSessionTitle(name, sid) {
    sessionTitle = name;
    sessionTitleEl.innerHTML = name !== '' ? esc(name) + ' <span class="dim">' + esc(shortSid(sid)) + '</span>' : '<span class="dim">（无会话）</span>';
    kvSession.textContent = name !== '' ? name : '—';
  }
  function shortSid(sid) { return sid ? '#' + String(sid).slice(-4) : ''; }
  function showWelcome(show) { welcomeEl.hidden = !show; }
  function flashCurrentSession() {
    lside.classList.remove('rail');
    var cur = lsBody.querySelector('.ls-item.cur');
    if (!cur) return;
    cur.scrollIntoView({ block: 'nearest' });
    cur.classList.remove('flash');
    void cur.offsetWidth;
    cur.classList.add('flash');
  }
  sessionTitleEl.addEventListener('click', flashCurrentSession);
  kvSession.addEventListener('click', flashCurrentSession);

  /* 切换视图：SSE 重开 + 面板立即拉一次（事件渲染归 T16——本件维护游标/phase/终态状态机） */
  function switchTo(sid) {
    if (streamCtl) { streamCtl.close(); streamCtl = null; }
    currentSid = sid;
    seenSet(sid);
    var f = findRow(sid);
    var label = f && f.row.label !== '' ? f.row.label : '新会话';
    setSessionTitle(label, sid);
    showWelcome(!!(f && f.row.fresh));
    tailEl.innerHTML = '正在连接…';
    renderSidebar();
    streamCtl = A.openStream(sid, 0, {
      onOpen: function () { if (currentSid === sid) tailEl.innerHTML = '正在待命 <span class="caret" aria-hidden="true"></span>'; },
      onEvent: function (ev) {
        if (currentSid !== sid || !ev) return;
        if (ev.type === 'session/label' && typeof ev.label === 'string') setSessionTitle(ev.label, sid);
        if (ev.type === 'user/message') showWelcome(false);
        if (ev.type === 'turn/end' && currentSid === sid) { /* 已读——不落未读点 */ }
      },
      phase: function (d) {
        if (currentSid !== sid || !d) return;
        busy = !!d.busy;
        if (busy) tailEl.innerHTML = spinSvg() + ' 正在回答…';
        else tailEl.innerHTML = '正在待命 <span class="caret" aria-hidden="true"></span>';
        if (d.phase === 'error') sactSet(sid, 'failed');
      },
      onShutdown: function () { /* api.js 已显「已正常关闭」弹窗并停止重连 */ },
    });
    return fetchPanel(sid);
  }

  /* ═══════════ 右栏：三页签 + 任务清单 + 收缩悬浮卡（E1/E7/E8） ═══════════ */
  var ptabs = Array.prototype.slice.call(document.querySelectorAll('.panel-state .ptab[data-tab]'));
  var pages = [$('state-page-1'), $('state-page-2'), $('state-page-3')];
  var stateEn = $('state-en');
  ptabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () {
      ptabs.forEach(function (t) { t.classList.remove('sel'); });
      tab.classList.add('sel');
      pages.forEach(function (p, j) { p.hidden = j !== i; });
      stateEn.textContent = (i + 1) + '/3';
    });
  });
  var todoFloat = $('todo-float');
  var tfCard = $('tf-card');
  function syncTodoFloat() {
    var railed = rside.classList.contains('rail');
    todoFloat.hidden = !railed;
    if (!railed) { tfCard.hidden = true; todoFloat.classList.remove('open'); }
  }
  $('rs-collapse').addEventListener('click', function () { rside.classList.add('rail'); syncTodoFloat(); });
  $('rs-expand').addEventListener('click', function () { rside.classList.remove('rail'); syncTodoFloat(); });
  $('tf-pill').addEventListener('click', function () {
    var opening = tfCard.hidden;
    tfCard.hidden = !opening;
    todoFloat.classList.toggle('open', opening);
    if (opening) renderTfList();
  });

  /* 面板渲染（2s 轮询 + 签名门——数据不变 DOM 零触碰；运行时间跳秒本地自增） */
  var TICK = { pending: '○', active: '◐', done: '✓' };
  var MOD_STATE_TEXT = { mounted: '已挂载', loading: '挂载中', off: '未挂载', pendingConfirm: '待确认' };
  var CONN_STATE_TEXT = { connected: '已连接', idle: '待启动', failed: '失败', 'pending-confirm': '未确认', disabled: '已停用' };
  var kvSig = '', modSig = '', connSig = '', peerSig = '', todoSig = '';
  function todoHtml(tasks) {
    return tasks.map(function (t) {
      return '<div class="todo" data-state="' + esc(t.state) + '" title="由 Agent 实时同步"><span class="tick">' + (TICK[t.state] ?? '○') + '</span><span class="ttext">' + esc(t.text) + '</span></div>';
    }).join('');
  }
  function renderTfList() {
    var tasks = panelInfo ? panelInfo.data.tasks ?? [] : [];
    $('tf-list').innerHTML = todoHtml(tasks);
  }
  function renderPanel(data) {
    /* 运行状态 kv + 上下文条 */
    var sig = [data.model, data.session, data.cwd, data.tokens && data.tokens.input, data.tokens && data.tokens.output, data.ctx && data.ctx.pct, data.ctx && data.ctx.used, data.ctx && data.ctx.window].join('|');
    if (sig !== kvSig) {
      kvSig = sig;
      $('kv-model').textContent = data.model ?? '—';
      $('kv-session').textContent = data.session || '—';
      $('kv-cwd').textContent = data.cwd ?? '—';
      var tk = data.tokens;
      $('kv-tokens').textContent = tk ? '↑ ' + (tk.input ?? 0).toLocaleString() + ' · ↓ ' + (tk.output ?? 0).toLocaleString() : '—';
      var ctx = data.ctx;
      if (ctx) {
        $('ctx-bar-fill').style.width = ctx.pct + '%';
        $('ctx-pct').textContent = fmtK(ctx.used) + '/' + fmtK(ctx.window);
      }
    }
    /* 模块挂载（E4 显示面；插拔交互归 T16/T17） */
    var ms = (data.modules ?? []).map(function (m) { return m.name + ':' + m.state + (m.locked ? 'L' : ''); }).join('|');
    if (ms !== modSig) {
      modSig = ms;
      $('mod-list').innerHTML = (data.modules ?? []).map(function (m) {
        var dot = m.state === 'mounted' ? '●' : (m.state === 'loading' || m.state === 'pendingConfirm') ? '◐' : '○';
        var tip = m.locked ? (m.lockedReason ?? '已锁定——不可插拔') : (MOD_STATE_TEXT[m.state] ?? m.state);
        return '<div class="mod ' + esc(m.state) + '" data-mod="' + esc(m.name) + '" title="' + esc(tip) + '">' +
          '<span class="dot">' + dot + '</span><span class="mname">' + esc(m.name) + (m.locked ? '<span class="locktag"> · 锁定</span>' : '') + '</span>' +
          '<span class="mdesc">' + esc(m.desc ?? '') + '</span><span class="mstate">' + (MOD_STATE_TEXT[m.state] ?? m.state) + '</span></div>';
      }).join('');
    }
    /* 网络 · MCP 连接（E5 显示面） */
    var conns = (data.network && data.network.connections) ?? [];
    var cs = conns.map(function (c) { return c.name + ':' + c.state + ':' + (c.connectMs ?? ''); }).join('|');
    if (cs !== connSig) {
      connSig = cs;
      $('conn-list').innerHTML = conns.map(function (c) {
        var cls = c.state === 'connected' ? 'mounted' : c.state === 'failed' ? 'failed' : c.state === 'pending-confirm' ? 'failed pending' : 'off';
        var dot = c.state === 'connected' ? '●' : (c.state === 'failed' || c.state === 'pending-confirm') ? '●' : '○';
        var right = c.state === 'connected' && c.connectMs !== undefined ? c.connectMs + 'ms' : CONN_STATE_TEXT[c.state] ?? c.state;
        return '<div class="mod ' + cls + '" title="' + esc(c.desc) + '"><span class="dot">' + dot + '</span><span class="mname">' + esc(c.name) + '</span><span class="mdesc">' + esc(c.desc) + '</span><span class="mstate">' + esc(right) + '</span></div>';
      }).join('') || '<div class="panel-hint">（无 MCP 连接配置）</div>';
      $('kv-proxy').textContent = (data.network && data.network.proxy) ?? '—';
      $('kv-modelsvc').textContent = (data.network && data.network.modelService) ?? '—';
    }
    /* 会话协同（E6 显示面；点击只读视图归 T16） */
    var peers = data.peers;
    var ps = peers ? (peers.self ? peers.self.sid + ':' + peers.self.phase : '') + ';' + (peers.list ?? []).map(function (p) { return p.sid + ':' + p.phase + ':' + (p.label ?? '') + ':' + (p.preview ?? ''); }).join('|') : '';
    if (ps !== peerSig) {
      peerSig = ps;
      var html2 = '';
      if (peers) {
        if (peers.self) html2 += peerHtml(peers.self, true);
        html2 += '<hr class="side-sep" /><div class="subhead"><span>活跃会话</span><span class="en">PEERS</span></div>';
        (peers.list ?? []).forEach(function (p) { html2 += peerHtml(p, false); });
      } else {
        html2 = '<div class="panel-hint">（暂无协同数据）</div>';
      }
      $('peer-list').innerHTML = html2;
    }
    /* 任务清单（E7）+ 悬浮卡计数同步（E8） */
    var tasks = data.tasks ?? [];
    var ts = tasks.map(function (t) { return t.text + ':' + t.state; }).join('|');
    if (ts !== todoSig) {
      todoSig = ts;
      var done = tasks.filter(function (t) { return t.state === 'done'; }).length;
      $('todo-list').innerHTML = todoHtml(tasks) || '<div class="panel-hint">（暂无任务）</div>';
      $('todo-count').textContent = done + '/' + tasks.length;
      $('todo-bar').style.width = (tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0) + '%';
      $('tf-count').textContent = done + '/' + tasks.length;
      $('tf-count2').textContent = done + '/' + tasks.length;
      if (!tfCard.hidden) renderTfList();
    }
  }
  function peerHtml(p, self) {
    var map = { running: ['●', 'ph-running', '正在跑'], 'waiting-approval': ['◉', 'ph-wait', '等审批'], 'waiting-input': ['◉', 'ph-wait', '等输入'], error: ['✗', 'ph-error', '上轮报错'], idle: ['○', 'ph-idle', '闲着'] };
    var ph = map[p.phase] ?? ['○', 'ph-idle', p.phase ?? ''];
    var label = p.label ?? p.sid;
    var row = '<div class="peer' + (self ? ' self' : '') + '" title="' + esc(label) + (self ? ' · 本会话' : '') + '">' +
      '<span class="ph ' + ph[1] + '">' + ph[0] + '</span><span class="pname">' + ph[2] + '</span>' +
      '<span class="ptitle">' + esc(label) + '</span><span class="pmeta">' + (self ? '本会话' : esc(fmtRel(Date.now() - (p.lastEventAt ?? Date.now())))) + '</span></div>';
    /* 非 self 行包一层（preview 第二行贴其下——原型 data-peer 容器同构） */
    if (self) return row;
    return '<div>' + row + (p.preview ? '<div class="peer-preview">' + esc(p.preview) + '</div>' : '') + '</div>';
  }
  /* panel 轮询（2s，与 sessions 同拍错峰 1s——api.js addPoll） */
  function fetchPanel(sid) {
    if (sid === null || sid === undefined) return Promise.resolve();
    return A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/panel').then(function (data) {
      panelInfo = { data: data, fetchedAt: Date.now() };
      A.rafFlush(function () { renderPanel(data); });
    }, function () { /* 面板拉取失败静默（断连面由 SSE 看门狗管） */ });
  }
  /* 运行时间跳秒（T10 报告指针：缓存命中 elapsedMs ≤1s 陈旧——本地节拍自增） */
  setInterval(function () {
    if (panelInfo === null || currentSid === null) return;
    var ms = panelInfo.data.elapsedMs + (Date.now() - panelInfo.fetchedAt);
    $('kv-elapsed').textContent = fmtElapsed(ms);
  }, 1000);

  /* ═══════════ 启动序：health 自证 → bootstrap → 优先 currentSid 否则最新会话 ═══════════ */
  function boot() {
    if (!A.getToken()) {
      A.showDisconnect('notoken');
      return;
    }
    A.fetchJson('/api/health').then(function (h) {
      $('ab-addr').textContent = location.host + ' · token 已校验';
      $('welcome-ver').textContent = 'v' + (h.version ?? '?');
      return A.fetchJson('/api/bootstrap');
    }, function () {
      A.showDisconnect('lost', function () {
        A.fetchJson('/api/health').then(function () { location.reload(); }, function () { /* 仍断开 */ });
      });
      return null;
    }).then(function (bs) {
      if (bs === null) return; /* 启动即断——弹窗已出（重试成功后刷新即恢复） */
      if (bs.update) $('btn-update').hidden = false; /* A4 更新胶囊壳（内容弹窗 T17） */
      return pollSessions().then(function () {
        var target = null;
        if (bs.currentSid && findRow(bs.currentSid)) target = bs.currentSid; /* /web 交接会话优先 */
        else if (sessionsData.groups.length > 0 && sessionsData.groups[0].sessions.length > 0) {
          target = sessionsData.groups[0].sessions[0].sid; /* 无当前 → 最新活动会话（组间最新在前） */
        } else if (sessionsData.pinned.length > 0) target = sessionsData.pinned[0].sid;
        if (target) return switchTo(target);
        setSessionTitle('', '');
        showWelcome(true);
        tailEl.textContent = '暂无会话——点击左栏「＋ 新会话」开始';
        return undefined;
      });
    }).then(function () {
      /* 轮询节拍器：sessions 2s / panel 2s 错峰 1s（自创值登记口径） */
      A.addPoll(2000, 0, pollSessions);
      A.addPoll(2000, 1000, function () { return fetchPanel(currentSid); });
    }, function () {
      A.showDisconnect('lost');
    });
  }
  boot();
})();
