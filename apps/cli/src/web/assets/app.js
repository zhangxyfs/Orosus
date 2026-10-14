/* Orosus web 前端应用（web 批 T15 骨架 + T16 流区/composer 全交互 + T17 设置收官）——app.js：启动序
 * （health 自证 → bootstrap → currentSid/最新会话）、主题切换、左栏（B1-B15）、右栏三页签 + 任务清单 +
 * 收缩悬浮卡、appbar 按钮接线；T16：流区渲染接线（render.js——SSE ev/chunk/queue/phase/interaction/btw
 * 全帧面）、composer（发送四态/贴图 ≤6/Esc 双击停止/队列条撤回/cwd 芯片/命令 mark 分发）；
 * T17：设置弹窗十页（F1-F10——常规/提供商/偏好/技能/钩子/MCP/记忆/语言/更新/已归档）+ 帮助弹窗 +
 * ⋮ 更多四窗（诊断/总览/注入/压缩）+ 更新弹窗（marked 渲染或降级指引）——数据源 = T11-T14 端点。
 * 性能律：轮询回调字段 diff（渲染签名比对）后按需更新 DOM，数据不变不碰 DOM。 */
function $(id) { return document.getElementById(id); }
(function () {
  'use strict';
  var A = window.OrosusAPI;
  var UI = window.OrosusUI;
  var render = window.OrosusRender;
  var esc = A.esc;

  /* ═══════════ refs ═══════════ */
  var tailEl = $('stream-tail');
  var welcomeEl = $('welcome');
  var lsBody = $('ls-body');
  var lside = $('lside');
  var rside = $('rside');
  var toastline = $('toastline');
  var streamEl = $('stream');
  var pgMoreEl = $('pg-more');
  var input = $('prompt-input');
  var form = $('input-form');
  var sendBtn = $('send-btn');
  var attachbar = $('attachbar');
  var queuebar = $('queuebar');
  var cwdChip = $('cwd-chip');
  var modelChip = $('model-chip');
  var effortChip = $('effort-chip');
  var modeChip = $('mode-chip');

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

  /* ══════════════════════════════════════════════════════════════════════════
   * T16：composer 全交互 + 流区/浮层接线（render.js/ui.js 消费面）
   * ══════════════════════════════════════════════════════════════════════════ */

  /* ── UI 宿主回调（ui.js init：toast / 会话语境 / 命令提交 / cwd 切换） ── */
  UI.init({
    toast: toast,
    getSid: function () { return currentSid ?? ''; },
    getCwd: function () { return sessionCwd; },
    getEffort: function () { return currentEffort; },
    onStatusChanged: function () { if (currentSid !== null) fetchStatus(currentSid); },
    onCommandSubmit: function (text) { sendCommandText(text); },
    onCwdPick: function (cwd, name) {
      createSession({ cwd: cwd }).then(function (r) {
        if (r) toast('工作目录 → ' + name + '（已在该目录开会话，原空会话保留）');
      });
    },
    onBrowseFolder: function () { openDirPicker(); }, /* cwd 菜单「📂 浏览文件夹…」（走查八轮：重新选择文件夹——任意目录下钻） */
    onManageModels: function () { openSettingsRoot(2); }, /* 模型菜单「管理模型」→ 设置·提供商页（外观页插位后 idx 1→2） */
  });

  /* ── 发送管线（命令与消息统一口：202 受理即回——output/mark/queued 按 T6 协议分发） ── */
  var BTW_PREFIX_RE = /^\/btw(\s|$)/i; /* /btw 前缀判定唯一口径（W6复核修 Minor#1）：截获存文（handleSendResponse）与失败清存（handleSendError）共用——ignoreCase 交集，杜绝大小写漏捕/误捕 */
  function sendCore(text, imageIds, promptId) {
    var body = { text: text };
    if (imageIds && imageIds.length > 0) body.imageIds = imageIds;
    if (promptId) body.promptId = promptId;
    return A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/send', { method: 'POST', body: JSON.stringify(body) });
  }
  function newPromptId() {
    try { return crypto.randomUUID(); } catch { return 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2); }
  }
  function handleSendResponse(r, text) {
    sendingNow = false;
    attachments = [];
    renderAttach();
    syncSendBtn();
    pendingBtwQuestion = ''; /* 发问源（W6）：先清陈旧——仅本条 /btw 带参重新存文（mark 响应不带文本） */
    if (BTW_PREFIX_RE.test(text) && text.trim().length > 4) {
      pendingBtwQuestion = text.trim().replace(/^\/btw\s+/i, ''); /* 供 mark 分支消费（cmdBtw 开新 tab 即发问） */
    }
    if (r && r.queued) { /* 入队——队列条由 SSE queue 帧整表快照驱动（唯一真源） */ }
    if (r && typeof r.output === 'string' && r.output !== '') presentCommandOutput(r.output);
    if (r && r.mark) handleMark(r.mark, r);
    /* C8 压缩中尾行窗：/compact 受理起显「上下文压缩中…」，turn/compaction 事件 / idle 相位收口 */
    if (/^\/compact(\s|$)/.test(text)) render.setCompacting(true);
  }
  function handleSendError(err, text) {
    sendingNow = false;
    syncSendBtn();
    if (BTW_PREFIX_RE.test(text)) pendingBtwQuestion = ''; /* 失败不吃陈旧问文（输入已还原——重发再存；前缀口径与截获块同一正则） */
    /* 失败保留输入（409 拦截提示保留输入 / viewer 只读 / 网络失败同口径） */
    input.value = text;
    autogrow();
    syncSendBtn();
    toast('发送失败：' + err.message);
  }
  function submit() {
    if (UI.pickCurrent()) return; /* 浮层开着时点发送键 = 确认当前选中行（与 Enter 同效；view 窗不拦截） */
    var text = input.value.trim();
    if (text === '') return;
    if (currentSid === null) { toast('暂无会话——先在左栏「＋ 新会话」或选择一个会话'); return; }
    var imgs = attachments.slice();
    if (imgs.some(function (a) { return a.failed; })) { toast('有图片上传失败——点 × 撤销后重试'); return; }
    if (imgs.some(function (a) { return !a.id; })) { toast('图片尚在上传——稍候再发送'); return; }
    var ids = imgs.map(function (a) { return a.id; });
    input.value = '';
    autogrow();
    sendingNow = true;
    syncSendBtn();
    sendCore(text, ids, newPromptId()).then(
      function (r) { handleSendResponse(r, text); },
      function (err) { handleSendError(err, text); },
    );
  }
  /** 斜杠菜单技能区/命令区选中 → 提交（ui.js 已清输入框）。 */
  function sendCommandText(text) {
    if (currentSid === null) { toast('暂无会话——先在左栏「＋ 新会话」或选择一个会话'); return; }
    sendingNow = true;
    syncSendBtn();
    sendCore(text).then(
      function (r) { handleSendResponse(r, text); },
      function (err) { handleSendError(err, text); },
    );
  }
  /** 命令输出呈现（D16：命令行不进流区——短文 toast、长文/多行 dock 只读窗）。 */
  function presentCommandOutput(output) {
    if (output.length > 300 || output.split('\n').length > 5) {
      UI.openView({ title: '命令输出', en: 'OUTPUT', bodyHtml: '<div class="pu-text">' + esc(output) + '</div>', foot: '滚动查看 · Esc 关闭' });
    } else {
      toast(output, 6000);
    }
  }
  /** mark 路由信号分发（T6 全集）：quit/new/fork/menu:model/tasks；skill 标记行随 user/message 事件回流。 */
  function handleMark(mark, r) { /* r = send 响应（走查修：btw mark 携带 btwRounds 归档轮次透传 cmdBtw） */
    if (mark === 'quit') {
      toast('已退出当前会话');
      void afterMaybeCurrentGone(currentSid);
    } else if (mark === 'new') {
      createSession({}).then(function (r) {
        if (r) render.appendMarkLine('[新会话 ' + shortSid(r.sid) + '] · 当前会话保留，点左侧会话行可切回');
      });
    } else if (mark === 'fork') {
      createSession({ forkFrom: currentSid }).then(function (r) {
        if (r) toast('已分叉出新会话——继承全部上下文');
      });
    } else if (mark === 'menu:model') {
      UI.openModelMenu(modelChip);
    } else if (mark === 'tasks') {
      cmdTasks(); /* W3：/tasks = 分栏批量开 tab（v2 2528-2537 目标形态——不弹列表面） */
    } else if (mark === 'btw') {
      cmdBtw(r); /* W6：带参（截获块问题文本）开新 tab 即发问；无参复用空草稿 tab 或新开（v2 cmdBtw 2541-2548；走查修：r.btwRounds 水合回看——弹窗退役） */
    }
  }

  /* ── 贴图（D6：Ctrl+V 预览条 / ≤6 张前端拦截 / × 撤销 / 随消息发送） ── */
  var attachments = []; /* {id, name, url, failed}——url = /api/media 预览源（上传落盘后回填） */
  function renderAttach() {
    if (attachments.length === 0) { attachbar.hidden = true; attachbar.innerHTML = ''; return; }
    attachbar.hidden = false;
    attachbar.innerHTML = attachments.map(function (a, i) {
      /* 评审 Important-2：预览源 = /api/media（server 已落盘路径）——blob: 会被自家 CSP
       * img-src 'self' data: 吞成裂图；上传在途显 spinner 占位，落盘即换真图 */
      var inner = a.url
        ? '<img src="' + esc(a.url) + '" alt="' + esc(a.name) + '" />'
        : a.failed
          ? '<span class="ax-stop" title="上传失败——点 ✕ 撤销后重试">✕</span>' /* 失败态静止占位（T16 复核 Minor②——spinner 不再永转） */
          : '<span class="ax-waiting" title="上传中…">' + spinSvg('', 15) + '</span>';
      return '<span class="attach-thumb">' + inner +
        (a.failed ? '<span class="ax-fail" title="上传失败">!</span>' : '') +
        '<button type="button" class="ax" data-ax="' + i + '" title="撤销挂图">✕</button></span>';
    }).join('');
  }
  attachbar.addEventListener('click', function (e) {
    var ax = e.target.closest('[data-ax]');
    if (!ax) return;
    var i = parseInt(ax.getAttribute('data-ax'), 10);
    attachments.splice(i, 1);
    renderAttach();
  });
  /** 上传不走 fetchJson（其会覆盖 content-type 为 JSON——二进制体须原始 fetch）。 */
  function uploadImage(file) {
    var sid = currentSid;
    return fetch('/api/uploads?sid=' + encodeURIComponent(sid ?? '') + '&name=' + encodeURIComponent(file.name || 'paste.png'), {
      method: 'POST',
      headers: { 'x-orosus-token': A.getToken(), 'content-type': file.type || 'application/octet-stream' },
      body: file,
    }).then(function (res) {
      return res.text().then(function (t) {
        var b = {};
        try { b = t ? JSON.parse(t) : {}; } catch { /* 非 JSON 错误壳 */ }
        if (!res.ok) throw new Error(b.error || 'HTTP ' + res.status);
        return b;
      });
    });
  }
  input.addEventListener('paste', function (e) {
    var files = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []).filter(function (f) { return f.type.indexOf('image/') === 0; });
    if (files.length === 0) return;
    e.preventDefault();
    var room = 6 - attachments.length; /* 最多 6 张（D6 原型口径——前端拦截） */
    if (room <= 0) { toast('最多 6 张图片——已达上限'); return; }
    if (files.length > room) { toast('最多 6 张图片——超出部分未添加'); files = files.slice(0, room); }
    if (currentSid === null) { toast('暂无会话——先新建或选择会话后再贴图'); return; }
    files.forEach(function (f) {
      var a = { id: '', name: f.name || 'paste.png', url: '', failed: false };
      attachments.push(a);
      renderAttach();
      uploadImage(f).then(function (r) {
        a.id = r.id;
        var tok = A.getToken();
        a.url = '/api/media?path=' + encodeURIComponent(r.path) + (tok ? '&token=' + encodeURIComponent(tok) : '');
        renderAttach();
      }, function () {
        a.failed = true;
        renderAttach();
        toast('图片上传失败：' + a.name);
      });
    });
    toast('[已粘贴图片]——将随下一条消息发送（点 × 撤销）');
  });

  /* ── 队列条（D2：queue 帧整表快照 = 唯一真源；点击撤回） ── */
  function renderQueue(items) {
    if (!items || items.length === 0) { queuebar.classList.remove('has'); queuebar.innerHTML = ''; return; }
    queuebar.classList.add('has');
    queuebar.innerHTML = items.map(function (q) {
      return '<div class="queue-row" data-q="' + q.index + '" title="点击撤回该条">' +
        '<span>⌛</span><span class="qtext">' + esc(q.text) + '</span><span class="dim">排队中</span></div>';
    }).join('') + '<div class="queue-hint">点击撤回 · 回答结束后依序发送</div>';
  }
  queuebar.addEventListener('click', function (e) {
    var row = e.target.closest('.queue-row');
    if (!row || currentSid === null) return;
    var idx = parseInt(row.getAttribute('data-q'), 10);
    A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/queue/' + idx, { method: 'DELETE', body: '' })
      .then(function () {
        toast('已撤回排队消息（TUI 键位：↑ 召回队尾）');
      }, function (err) {
        if (err.status === 404) return; /* 并发撤回被 server 表重算吸收——静默 */
        toast('撤回失败：' + err.message);
      });
  });

  /* ── 发送键四态（D11：idle/ready/sending/stop ■）+ busy 期点击 = 停止 ── */
  function syncSendBtn() {
    sendBtn.classList.remove('idle', 'ready', 'sending', 'stop');
    if (busy) { sendBtn.classList.add('stop'); sendBtn.textContent = '■'; sendBtn.title = '停止生成（双击 Esc 同效）'; return; }
    if (sendingNow) { sendBtn.classList.add('sending'); sendBtn.innerHTML = spinSvg('', 13); sendBtn.title = '正在发送…'; return; }
    if (input.value.trim() !== '') { sendBtn.classList.add('ready'); sendBtn.textContent = '↑'; sendBtn.title = '发送（Enter）'; return; }
    sendBtn.classList.add('idle');
    sendBtn.textContent = '↑';
    sendBtn.title = '发送（Enter）';
  }
  sendBtn.addEventListener('click', function (e) {
    if (busy) {
      e.preventDefault();
      e.stopPropagation();
      stopGeneration();
    }
  }, true);

  /* ── Esc 链 + 双击停止（D12：POST /cancel + 连带 POST /answer {cancelled}——T5/T7 指针） ── */
  function stopGeneration() {
    escArmedAt = 0;
    busy = false;
    syncSendBtn();
    /* 乐观复位尾行（2026-10-12 走查修——「已停止仍显示工作中」：点击停止只复位了发送键，尾行
     *  spinner 要等 server 相位帧；取消收尾慢时两者长时间不一致。真实相位帧随后归真/纠偏） */
    render.setPhase('idle', false);
    if (currentSid !== null) {
      A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/cancel', { method: 'POST', body: '{}' })
        .catch(function () { /* 取消失败静默——turn/end interrupted 事件面兜底 */ });
    }
    /* 挂起交互浮层关闭 → ui.js onClose 连带 POST /answer {id, cancelled}（不 resolve 卡会挂死 turn） */
    UI.cancelPending();
  }
  function handleEscGlobal() {
    if (!$('overlay2').hidden) return; /* 确认弹窗层（capture 处理器已管） */
    if (!$('overlay').hidden) return;  /* 居中弹窗层（T15 处理器已管——多级逐次返回） */
    if (UI.isOpen()) { UI.closePopup(); input.focus(); return; }
    if (!$('tf-card').hidden) { $('tf-card').hidden = true; $('todo-float').classList.remove('open'); return; }
    if (busy) {
      var now = Date.now();
      if (now - escArmedAt < 1000) {
        stopGeneration();
      } else {
        escArmedAt = now;
        toast('再按一次 Esc 停止生成与全部子代理');
      }
    }
  }

  /* ── composer 输入：多行长高（D1）+ 菜单键（↑↓/Enter/Esc）+ Enter 发送 ── */
  function autogrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 168) + 'px';
  }
  input.addEventListener('input', function () {
    autogrow();
    syncSendBtn();
    UI.inputChanged(input); /* @ 菜单优先（词尾 @）、斜杠菜单其次（行首 / 词）——过滤随输入 */
  });
  input.addEventListener('keydown', function (e) {
    if (UI.handleInputKey(e)) return; /* 浮层键盘（↑↓/Enter/Esc）优先消费 */
    if (e.key === 'Escape') { handleEscGlobal(); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    submit();
  });

  /* ── ＋ 文件（D7：光标处插入 @ 并开文件菜单） ── */
  $('btn-file').addEventListener('click', function () {
    var v = input.value;
    var pos = input.selectionStart ?? v.length;
    input.value = v.slice(0, pos) + '@' + v.slice(pos);
    input.focus();
    input.selectionStart = input.selectionEnd = pos + 1;
    UI.inputChanged(input);
  });

  /* ── cwd 切换芯片（D5：仅空会话——C1 事件数判据；候选 = 项目池含 hidden 找回） ── */
  function syncCwdGate() {
    var empty = currentSid !== null && !render.userSeen();
    cwdChip.hidden = !empty;
    var nm = sessionCwd ? sessionCwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
    $('cwd-name').textContent = nm || '选择目录';
  }
  cwdChip.addEventListener('click', function () {
    if (cwdChip.hidden) { toast('当前会话已有消息——新会话后才能切换工作目录'); return; }
    var pool = projectsPool.slice();
    if (sessionCwd !== '' && !pool.some(function (p) { return p.cwd === sessionCwd; })) {
      pool.push({ cwd: sessionCwd, name: sessionCwd.split(/[\\/]/).pop() || sessionCwd });
    }
    if (pool.length === 0) { openDirPicker(); return; } /* 无已知项目池 → 直接进浏览窗（走查八轮） */
    UI.openCwdMenu(cwdChip, pool, sessionCwd);
  });

  /* ── 目录浏览窗（2026-10-12 走查八轮：文件夹芯片的「重新选择文件夹」——/api/at 目录下钻 + ..
   *  上级回退 + 路径输入直达（回车）；选定 = 在该目录开会话。/api/at 复用 @ 菜单数据源
   *  （readdir + 目录前置），只取 dir:true 行。 ── */
  var dpState = { path: '' };
  function dpParentOf(p) {
    var s = String(p ?? '').replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    if (i < 0) return null;
    if (i <= 2 && /^[A-Za-z]:/.test(s)) return s.slice(0, 2) + '\\'; /* 盘根 D:\ 止步于其自身 */
    if (s.length <= 3 && /^[A-Za-z]:[\\/]?$/.test(s)) return null;
    return s.slice(0, i);
  }
  function openDirPicker() {
    dpState.path = sessionCwd || '';
    openModal({
      title: '选择工作目录',
      en: 'BROWSE',
      bodyHtml: '<div class="dp-bar"><input class="fi" id="dp-input" placeholder="输入路径直达（回车跳转）…" /></div><div class="dp-list" id="dp-list"><div class="sp-note">加载中…</div></div>',
      actionsHtml: '<span class="spacer"></span><button class="btn" data-act="cancel">取消</button><button class="btn primary" data-act="open">在此目录开会话</button>',
      onAction: function (a) {
        if (a === 'open') {
          var p = dpState.path;
          modalClose();
          if (p !== '') {
            var nm = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
            createSession({ cwd: p }).then(function (r) {
              if (r) toast('工作目录 → ' + nm + '（已在该目录开会话，原空会话保留）');
            });
          }
          return;
        }
        modalClose();
      },
      onClick: function (e) {
        var row = e.target.closest('[data-dp]');
        if (!row) return;
        var v = row.getAttribute('data-dp');
        if (v === '..') {
          var up = dpParentOf(dpState.path);
          if (up !== null && up !== dpState.path) { dpState.path = up; dpLoad(); }
          return;
        }
        dpState.path = dpState.path.replace(/[\\/]+$/, '') + '\\' + v;
        dpLoad();
      },
    });
    window.setTimeout(function () {
      var inp = $('dp-input');
      if (inp) {
        inp.value = dpState.path;
        inp.focus();
        inp.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          var v = inp.value.trim();
          if (v === '') return;
          dpState.path = v;
          dpLoad();
        });
      }
    }, 30);
    dpLoad();
  }
  function dpLoad() {
    A.fetchJson('/api/at?cwd=' + encodeURIComponent(dpState.path), { timeoutMs: 8000 }).then(function (d) {
      var dirs = (d.entries ?? []).filter(function (x) { return x.dir; });
      var up = dpParentOf(dpState.path);
      var html = '';
      if (up !== null && up !== dpState.path) html += '<div class="dp-row" data-dp="..">📂 .. <span class="dim">上级目录</span></div>';
      html += dirs.map(function (x) { return '<div class="dp-row" data-dp="' + esc(x.name) + '">📁 ' + esc(x.name) + '</div>'; }).join('');
      if (html === '') html = '<div class="sp-note">（没有子目录——可直接在下方「在此目录开会话」）</div>';
      var list = $('dp-list');
      if (list) list.innerHTML = html;
      var inp = $('dp-input');
      if (inp && inp.value !== dpState.path) inp.value = dpState.path;
    }, function () {
      var list = $('dp-list');
      if (list) list.innerHTML = '<div class="sp-note">（目录不可读——检查路径后回车重试）</div>';
    });
  }

  /* ── 芯片：模型（D9）/ 思考档位（D10）/ 权限（D8）——status 装配显示面 ── */
  function modelTail(full) {
    var s = String(full ?? '');
    return s.indexOf('/') >= 0 ? s.slice(s.indexOf('/') + 1) : (s || '（未配置）');
  }
  function syncChips(st) {
    sessionCwd = typeof st.cwd === 'string' ? st.cwd : sessionCwd;
    currentPerm = typeof st.permission === 'string' ? st.permission : currentPerm;
    currentEffort = typeof st.effort === 'string' ? st.effort : currentEffort;
    modelChip.innerHTML = esc(modelTail(st.model)) + ' <span class="dim">▾</span>';
    /* D10 口径：芯片显示 status.effort（未设置 = 目录默认档名）——永不渲染「自动」二字 */
    effortChip.innerHTML = '思考 ' + esc(currentEffort !== '' ? currentEffort : '—') + ' <span class="dim">▾</span>';
    var m = null;
    for (var i = 0; i < UI.MODES.length; i++) if (UI.MODES[i].key === currentPerm) m = UI.MODES[i];
    modeChip.innerHTML = '◆ ' + (m ? m.label : (currentPerm || '—')) + ' ▾';
    modeChip.classList.toggle('never', currentPerm === 'never');
    syncCwdGate();
  }
  function fetchStatus(sid) {
    return A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/status').then(function (st) {
      if (currentSid !== sid) return;
      syncChips(st);
    }, function () { /* status 拉取失败静默（外部会话） */ });
  }
  modelChip.addEventListener('click', function () { UI.openModelMenu(modelChip); });
  effortChip.addEventListener('click', function () { UI.openEffortMenu(effortChip); });
  modeChip.addEventListener('click', function () { UI.openPermMenu(modeChip, currentPerm); });
  $('kv-model').addEventListener('click', function () { UI.openModelMenu(modelChip); });
  syncSendBtn();

  /* ── interaction 应答口（ui.js 审批浮层 → POST /answer） ── */
  function answerInteraction(body) {
    return A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/answer', { method: 'POST', body: JSON.stringify(body) })
      .catch(function (err) {
        toast('应答失败：' + err.message);
        UI.invalidateCaches();
      });
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

  /* 原型 v2 外观·整体字号（写 --fz 驱动全表 font-size calc——只放大文字，框架/控件几何恒定
   * 〔2026-10-12 走查修：曾用 body.zoom 会连框架一起缩放，被用户否〕；localStorage 记忆，boot 恢复）。 */
  var FONT_SCALES = [
    { name: '小', scale: 0.875 },
    { name: '默认', scale: 1 },
    { name: '大', scale: 1.125 },
    { name: '特大', scale: 1.25 },
    { name: '超大', scale: 1.4 }
  ];
  var fontScaleIdx = 1;
  function applyFontScale(i) {
    fontScaleIdx = i;
    document.documentElement.style.setProperty('--fz', String(FONT_SCALES[i].scale)); /* 全表 font-size = calc(Npx * var(--fz))——字体缩放单源 */
    try { localStorage.setItem('orosus-web-fontscale', String(i)); } catch { /* 存储被拒 */ }
  }
  try {
    var fsInit = parseInt(localStorage.getItem('orosus-web-fontscale') ?? '', 10);
    if (fsInit >= 0 && fsInit < FONT_SCALES.length) applyFontScale(fsInit);
  } catch { /* 同上 */ }

  /* ═══════════ 全局状态 ═══════════ */
  var currentSid = null;          /* 当前查看的会话（视图态） */
  var streamCtl = null;           /* openStream 控制器 */
  var sessionsData = { pinned: [], groups: [] };
  var prevRowMap = new Map();     /* 上一轮 SessionRow（B14 转移检测：跑完→done） */
  var panelInfo = null;           /* {data, fetchedAt}——运行时间跳秒基准 */
  var sessionTitle = '';
  var busy = false;               /* 当前会话 turn 进行中（phase 帧驱动——render 尾行/停止键同源） */
  var sessionCwd = '';            /* 当前会话工作目录（status 装配——@ 菜单/工具行相对化基准） */
  var currentPerm = '';           /* 权限三档（芯片显示 + 菜单勾标） */
  var currentEffort = '';         /* 思考档位显示口径（status.effort——未设置=目录默认档名，D10） */
  var projectsPool = [];          /* cwd 芯片候选（bootstrap.projects——含 hidden 找回，D5） */
  var sendingNow = false;         /* 发送四态之「发送中」（POST 在途） */
  var escArmedAt = 0;             /* Esc 双击停止的 armed 时刻 */

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
    /* 当前行判据 = 本标签页视图态 currentSid（纯本地——多标签各看各的；server 游标 row.cur
     *  只服务 B1 项目跟随/bootstrap 初值，不参与高亮，否则它标签页的游标会把本页染成双选中） */
    var isCur = row.sid === currentSid;
    var act = rowActivity(row, isCur ? null : prev, sact, seen);
    var title = row.label !== '' ? row.label : (row.fresh ? '新会话' : '（未命名会话）');
    return '<div class="ls-item' + (isCur ? ' cur' : '') + (pinned ? ' pinned-row' : '') + '" data-sid="' + esc(row.sid) + '" data-pinned="' + (pinned ? 1 : '') + '">' +
      sactHtml(act) +
      '<span class="stitle" title="' + esc(title) + '">' + esc(title) + '</span>' +
      (isCur ? '<span class="curtag">当前</span>' : '') +
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
    /* 置顶区（2026-10-12 走查口径）：有置顶才显「已置顶 N」分组头与行；无置顶零占位——仅保留
     *  ⇤ 收起钮（会话栏收起入口不能随区隐没）。 */
    var html = '';
    if (sessionsData.pinned.length > 0) {
      html += '<div class="ls-sec"><span>已置顶</span><span class="ls-count">' + sessionsData.pinned.length + '</span><button class="ls-collapse" id="ls-collapse" title="收起会话栏">⇤</button></div>';
      html += sessionsData.pinned.map(function (s) { return lsRowHtml(s, prevRowMap.get(s.sid), true, sact, seen); }).join('');
    } else {
      html += '<div class="ls-sec ls-pin-empty"><button class="ls-collapse" id="ls-collapse" title="收起会话栏">⇤</button></div>';
    }
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
    return A.fetchJson('/api/sessions', { timeoutMs: 9000 }).then(function (data) {
      var next = rememberRows(data);
      sessionsData = data;
      renderSidebar();
      prevRowMap = next;
      /* 当前会话行标签/活动可能变了——顶栏与右栏标题随行刷新 */
      var cur = next.get(currentSid ?? '');
      if (cur && cur.label !== '' && cur.label !== sessionTitle) setSessionTitle(cur.label, cur.sid);
      syncCwdGate(); /* cwd 芯片显隐随会话态（fresh 判据轮询兜底——事件驱动为主） */
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
      /* 先刷新左栏再切视图（2026-10-12 走查修——「新会话不立即出现在列表」根因：switchTo 只重渲
       *  旧 sessionsData，新行要等 2s 轮询；pollSessions 先行让新行与「当前」高亮一步到位） */
      return pollSessions().then(function () { return switchTo(r.sid); }).then(function () { return r; });
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
      /* 无会话可切——空态（渲染器卸载——欢迎页留显） */
      if (streamCtl) streamCtl.close();
      streamCtl = null;
      currentSid = null;
      setSessionTitle('', '');
      render.close();
      showWelcome(true);
      syncCwdGate();
      tailEl.textContent = '暂无会话——点击左栏「＋ 新会话」开始';
      return undefined;
    });
  }
  /* 重命名（B11）：弹窗输入 → POST /api/sessions/:sid/title（setTitle 旁路写——任意会话可达，
   *  不碰 host、不切当前会话；T15 审查补漏端点）。 */
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
    /* 走查五轮：回车即保存——与 data-act=save 按钮同路径（弹窗点击委派复用，不另接线） */
    window.setTimeout(function () {
      var el = document.getElementById('rename-input');
      if (!el) return;
      el.value = rowTitle(sid) === '（未命名会话）' ? '' : rowTitle(sid);
      el.focus();
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var btn = modal.querySelector('[data-act="save"]');
        if (btn) btn.click();
      });
    }, 30);
  }
  function doRename(sid, name) {
    A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/title', { method: 'POST', body: JSON.stringify({ title: name }) }).then(function () {
      toast('已命名 → ' + name);
      /* 本地即时补（旁路写不经 host——无 SSE label 帧）：当前会话顶栏同步 + 左栏行标签刷新 */
      if (sid === currentSid) setSessionTitle(name, sid);
      var f = findRow(sid);
      if (f) f.row.label = name;
      void pollSessions();
    }, function (err) { toast('重命名失败：' + err.message); });
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
    /* 目标先取后藏（2026-10-12 走查三轮根因修）：hideCtx 会清空 ctxSid/ctxGroup——此前先藏后读，
     *  两个判据恒假，右键菜单全部条目点击无动作（「右键菜单完全没实现」的根因）。 */
    var sid = ctxSid;
    var g = ctxGroup;
    hideCtx();
    if (sid !== null) { sessionCtxAct(act, sid); return; }
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

  /* ═══════════ 居中弹窗壳（设置 / 帮助 / 更多 / 重命名——栈式；T17 起承载十页真内容） ═══════════ */
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
      '<div class="pu-body">' + top.bodyHtml + '</div>' +
      (top.actionsHtml ? '<div class="pu-actions right">' + top.actionsHtml + '</div>' : '') +
      (top.foot ? '<div class="pu-foot">' + top.foot + '</div>' : '');
    overlay.hidden = false;
  }
  function openModal(opts) { modalStack.push(opts); renderModal(); }
  function modalReplace(opts) { modalStack[modalStack.length - 1] = opts; renderModal(); }
  function modalBack() { modalStack.pop(); renderModal(); }
  function modalClose() { modalStack = []; renderModal(); }
  modal.addEventListener('click', function (e) {
    if (e.target.closest('[data-mclose]')) { modalClose(); return; }
    if (e.target.closest('[data-mback]')) { modalBack(); return; }
    var top = modalStack[modalStack.length - 1];
    if (!top) return;
    var act = e.target.closest('[data-act]');
    if (act && top.onAction) { top.onAction(act.getAttribute('data-act'), act); return; }
    if (top.onClick) top.onClick(e); /* 通用委派（T17 设置十页的 data-nv/data-k 行——CSP 无内联） */
  });
  overlay.addEventListener('click', function (e) { if (e.target === overlay) modalClose(); });
  function modalEsc() { if (modalStack.length > 1) modalBack(); else modalClose(); }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay.hidden) modalEsc();
  });

  /* ══════════════════════════════════════════════════════════════════════════
   * T17：设置弹窗十页（F1-F10）+ 帮助 + ⋮ 更多四窗 + 更新弹窗
   * 数据源 = T11-T14 端点（/api/settings/*、/api/providers*、/api/archived、/api/diagnostics、
   * /api/launchers、hooks-activity、compaction、/api/update）；排序/筛选/分组纯函数 =
   * assets/archived-view.js（OrosusArchived——node 直测）。CSP 无内联：零 style= 属性——几何变体
   * 全走类名/JS 属性赋值。
   * ══════════════════════════════════════════════════════════════════════════ */
  var AV = window.OrosusArchived;
  var setPageHandler = null; /* 当前设置页的点击委派（各页渲染器置位——原型 setPageHandler 同构） */

  function spTitle(t, en) { return '<div class="sp-title">' + esc(t) + (en ? '<span class="en">' + esc(en) + '</span>' : '') + '</div>'; }
  function subHeadT(t, mt) { return '<div class="subhead' + (mt ? ' mt' : '') + '"><span>' + esc(t) + '</span></div>'; }
  function optRow(label, desc, checked, k, v) {
    return '<div class="pu-item" data-k="' + esc(k) + '" data-v="' + esc(v) + '"><span class="pu-check">' + (checked ? '✓' : '') + '</span><span class="pi-name">' + esc(label) + '</span>' + (desc ? '<span class="pi-desc">' + esc(desc) + '</span>' : '') + '</div>';
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDateTime(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function kvRow(k, v, cls) {
    return '<span class="k">' + esc(k) + '</span><span class="v ' + (cls ?? '') + '">' + v + '</span>'; /* v 由调用方负责转义 */
  }
  function pageLoading(page, text) { setPageHandler = null; page.innerHTML = '<div class="sp-note">' + esc(text ?? '加载中…') + '</div>'; }
  function pageLoadError(page, err) { setPageHandler = null; page.innerHTML = '<div class="sp-note bad">' + esc('加载失败：' + (err && err.message ? err.message : '网络错误')) + '</div>'; }

  var SET_PAGES = [
    { name: '常规', desc: '上下文 / Token / 磁盘', render: pageGeneral },
    { name: '外观', desc: '主题 / 明暗 / 字号 / 语言', render: pageAppearance },
    { name: '提供商与模型', desc: '供应商列表 / 目录添加 / 模型表', render: pageProviders },
    { name: '模型偏好', desc: '默认模型 / 视觉 / 搜索 / 子代理', render: pageModelPrefs },
    { name: '技能', desc: '查看 / 启停', render: pageSkills },
    { name: '钩子', desc: '查看 / 启停 / 信任审查', render: pageHooks },
    { name: 'MCP', desc: 'server 管理与添加', render: pageMcp },
    { name: '记忆', desc: '工作区记忆 / 会话感知 / 导入', render: pageMemory },
    { name: '更新检查', desc: '启动时自动检测新版本', render: pageUpdate },
    { name: '已归档的会话', desc: '查看 / 恢复到会话列表', render: pageArchived },
  ];

  /** 打开设置弹窗（原型 openSettingsRoot：居中双栏 wide；pageIdx = 初始页（E5 审阅/管理模型直达用））。 */
  function openSettingsRoot(pageIdx) {
    UI.closePopup();
    modalClose();
    openModal({
      wide: true,
      title: '设置',
      en: 'SETTINGS',
      bodyHtml: '<div class="set-grid"><div class="set-nav" id="set-nav"></div><div class="set-page" id="set-page"></div></div>',
      foot: '左侧选项卡切换页面 · Esc 关闭',
      onClick: function (e) {
        var nv = e.target.closest('[data-nv]');
        if (nv) { renderSetPage(parseInt(nv.getAttribute('data-nv'), 10)); return; }
        if (setPageHandler) setPageHandler(e);
      },
    });
    renderSetPage(pageIdx ?? 0);
  }
  function renderSetPage(i) {
    setState.nav = i;
    var nav = document.getElementById('set-nav');
    var page = document.getElementById('set-page');
    if (!nav || !page) return;
    nav.innerHTML = SET_PAGES.map(function (p, j) {
      return '<button class="nv' + (j === i ? ' sel' : '') + '" data-nv="' + j + '">' + esc(p.name) + '<span class="nv-desc">' + esc(p.desc) + '</span></button>';
    }).join('');
    page.scrollTop = 0;
    page.innerHTML = '';
    SET_PAGES[i].render(page);
  }
  var setState = { nav: 0 };

  /* ── F1 常规（GET /api/settings/general：disk 五目录+total / tokens 双口径 / ctx / runtime） ── */
  function genRingSvg(pct, hot) {
    var c = 2 * Math.PI * 34;
    var used = Math.round(c * pct / 100);
    return '<svg class="ring-svg' + (hot ? ' ring-hot' : '') + '" width="92" height="92" viewBox="0 0 92 92" aria-label="上下文占用 ' + pct + '%">' +
      '<circle class="ring-track" cx="46" cy="46" r="34" fill="none" stroke-width="10"/>' +
      '<circle class="ring-fill" cx="46" cy="46" r="34" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + used + ' ' + (Math.round(c) - used) + '" transform="rotate(-90 46 46)"/>' +
      '<text x="46" y="52" text-anchor="middle" class="ring-text">' + pct + '%</text></svg>';
  }
  function genStat(label, num, sub) {
    return '<div class="stat-card"><div class="sc-num">' + esc(num) + '</div><div class="sc-lbl">' + esc(label) + (sub ? ' · ' + esc(sub) : '') + '</div></div>';
  }
  function genDiskRow(name, mb, files) {
    return '<div class="disk-row" data-mb="' + mb + '"><span class="dk-name">' + esc(name) + '</span>' +
      '<span class="dk-bar"><i></i></span>' +
      '<span class="dk-size">' + mb.toFixed(1) + ' MB</span><span class="dk-files">' + files + ' 个文件</span></div>';
  }
  function pageGeneral(page) {
    pageLoading(page);
    A.fetchJson('/api/settings/general').then(function (d) {
      var ctx = d.ctx ?? { used: 0, window: 0, pct: 0 };
      var tk = d.tokens ?? { input: 0, output: 0, lifetimeInput: 0, lifetimeOutput: 0 };
      var model = (panelInfo && panelInfo.data && panelInfo.data.model) || '—';
      var disk = (d.disk ?? []).filter(function (r) { return r.name !== 'total'; });
      var total = (d.disk ?? []).find(function (r) { return r.name === 'total'; });
      var maxMb = disk.reduce(function (m, r) { return Math.max(m, r.mb ?? 0); }, 0);
      page.innerHTML = spTitle('常规', 'GENERAL') +
        subHeadT('上下文用量') +
        '<div class="gen-flex">' + genRingSvg(ctx.pct ?? 0, (ctx.pct ?? 0) >= 80) +
          '<div class="gen-legend">' +
            '<div class="gl-row"><span class="gl-k">模型</span><span class="gl-v">' + esc(model) + '</span></div>' +
            '<div class="gl-row"><span class="gl-k">窗口</span><span class="gl-v">' + (ctx.window ?? 0).toLocaleString() + ' tokens</span></div>' +
            '<div class="gl-row"><span class="gl-k">已用</span><span class="gl-v"><span class="ok">~' + (ctx.used ?? 0).toLocaleString() + '</span>（' + (ctx.pct ?? 0) + '%）</span></div>' +
            '<div class="gl-row"><span class="gl-k">输入累计</span><span class="gl-v">↑ ' + fmtK(tk.lifetimeInput) + '</span></div>' +
            '<div class="gl-row"><span class="gl-k">输出累计</span><span class="gl-v">↓ ' + fmtK(tk.lifetimeOutput) + '</span></div>' +
          '</div></div>' +
        '<div class="sp-note">口径：已用 = 最近一次请求的输入规模；增长到阈值（80%）会自动压缩，/compact 可手动。运行时间 ' + esc(fmtElapsed((d.runtime ?? { elapsedMs: 0 }).elapsedMs)) + '。</div>' +
        subHeadT('Token 用量', true) +
        '<div class="stat-cards">' +
          genStat('本会话 · 输入', (tk.input ?? 0).toLocaleString(), 'tokens') +
          genStat('本会话 · 输出', (tk.output ?? 0).toLocaleString(), 'tokens') +
          genStat('项目累计 · 输入', fmtK(tk.lifetimeInput), 'tokens') +
          genStat('项目累计 · 输出', fmtK(tk.lifetimeOutput), 'tokens') +
        '</div>' +
        subHeadT('磁盘占用 · ~/.orosus', true) +
        '<div class="disk">' + disk.map(function (r) { return genDiskRow(r.name, r.mb ?? 0, r.files ?? 0); }).join('') + '</div>' +
        (total ? '<div class="dk-total"><span>合计 ' + (total.mb ?? 0).toFixed(1) + ' MB · ' + (total.files ?? 0) + ' 个文件</span></div>' : '') +
        '<div class="sp-note">清理口径：cache 可安全删除；tmp 为粘贴图片暂存，可手动清；sessions 是会话历史（orosus sessions prune 清理）。</div>';
      /* 磁盘条宽度：CSP 无内联——JS 属性赋值（比例相对五目录最大值） */
      if (maxMb > 0) {
        page.querySelectorAll('.disk-row').forEach(function (row) {
          var mb = parseFloat(row.getAttribute('data-mb')) || 0;
          row.querySelector('.dk-bar i').style.width = Math.max(2, Math.round((mb / maxMb) * 100)) + '%';
        });
      }
      setPageHandler = null;
    }, function (err) { pageLoadError(page, err); });
  }

  /* ── F2 提供商与模型（GET /api/providers + catalog；写口 POST /api/providers〔自定义/编辑〕与
   *    POST /api/providers/cmd〔目录添加——provider import argv，T13 钉形〕；模型表只读 + defaultModel 选择） ── */
  var SLOT_COLORS = ['#4a7dff', '#5b6ef0', '#e04e5a', '#7a5af5', '#f55036', '#1f8a70', '#b07d2b', '#8a5cf5'];
  function provLetter(name) { return String(name ?? '?').trim().slice(0, 1).toUpperCase() || '?'; }
  function provIcon(name) {
    var h = 0;
    var s = String(name ?? '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return '<span class="vico" data-color="' + SLOT_COLORS[h % SLOT_COLORS.length] + '">' + esc(provLetter(name)) + '</span>';
  }
  function paintVicos(page) {
    page.querySelectorAll('.vico[data-color]').forEach(function (el) { el.style.background = el.getAttribute('data-color'); });
  }
  var provData = { providers: [], vendors: [] };
  function pageProviders(page) {
    pageLoading(page);
    A.fetchJson('/api/providers').then(function (d) {
      provData.providers = d.providers ?? [];
      page.innerHTML = '<div class="pf-headrow">' + spTitle('模型供应商', 'PROVIDERS') +
        '<button class="btn primary" data-k="prov-add">＋ 添加供应商</button></div>' +
        '<div class="pf-list">' + provData.providers.map(function (p, pi) {
          return '<div class="pf-vrow" data-k="prov" data-v="' + pi + '">' + provIcon(p.key) +
            '<span class="vname">' + esc(p.name ?? p.key) + '</span><span class="vbadge">' + esc(p.proto ?? 'openai') + '</span>' +
            '<span class="vcount">' + (p.modelCount ?? (p.models ?? []).length) + ' 个模型 ›</span></div>';
        }).join('') + '</div>' +
        '<div class="sp-note">点供应商进编辑页（协议 / 密钥 / Base URL / 默认模型）；目录添加走 models.dev 缓存；当前模型切换在输入框右下模型芯片。</div>';
      paintVicos(page);
      setPageHandler = function (e) {
        var row = e.target.closest('[data-k="prov"]');
        if (row) { renderProviderForm(page, provData.providers[parseInt(row.getAttribute('data-v'), 10)], false); return; }
        if (e.target.closest('[data-k="prov-add"]')) renderProviderAdd(page);
      };
    }, function (err) { pageLoadError(page, err); });
  }
  /** 编辑 / 自定义手填表单（POST /api/providers upsert——writeNestedTable 路线）。 */
  function renderProviderForm(page, p, isNew) {
    setPageHandler = null;
    var models = (p && p.models) || [];
    var defOpts = isNew
      ? ''
      : '<option value="">（不设默认模型）</option>' + models.map(function (m) {
          return '<option value="' + esc(m) + '"' + (p.defaultModel === m ? ' selected' : '') + '>' + esc(m) + '</option>';
        }).join('');
    page.innerHTML =
      '<span class="pf-back" data-k="pf-back">‹ ' + provIcon(p ? p.key : 'custom') + ' ' + esc(isNew ? '自定义供应商' : (p.name ?? p.key)) + ' <span class="vbadge">' + (isNew ? '手填' : '编辑') + '</span></span>' +
      '<div class="pf-row"><label>名称（槽位 id） <span class="req">*</span></label><input class="fi" id="pf-name" value="' + esc(isNew ? '' : (p.key ?? '')) + '" placeholder="my-openai" ' + (isNew ? '' : 'readonly') + ' /></div>' +
      '<div class="pf-row"><label>API 协议 <span class="req">*</span></label><select class="fsel" id="pf-proto"><option value="openai"' + (!p || (p.proto ?? 'openai') === 'openai' ? ' selected' : '') + '>OpenAI</option><option value="anthropic"' + (p && p.proto === 'anthropic' ? ' selected' : '') + '>Anthropic</option></select></div>' +
      '<div class="pf-row"><label>API Key</label><div class="pf-key"><input class="fi" id="pf-key" type="password" placeholder="' + (!isNew && p && p.hasApiKey ? '已配置——留空保留' : 'sk-…') + '" /><button type="button" class="eye" data-k="pf-eye" title="显示 / 隐藏">👁</button></div></div>' +
      '<div class="pf-row"><label>Base URL <span class="req">*</span></label><input class="fi" id="pf-url" value="' + esc(p && p.baseUrl ? p.baseUrl : '') + '" placeholder="https://api.example.com/v1" /></div>' +
      '<div class="pf-row"><label>默认模型</label>' + (isNew
        ? '<input class="fi" id="pf-def" placeholder="模型 id（可留空，保存后再确认默认）" />'
        : '<select class="fsel" id="pf-def">' + defOpts + '</select>') + '</div>' +
      '<div class="pf-row"><label>上下文窗口（全局顶层键——所有槽共享）</label><input class="fi" id="pf-ctx" placeholder="留空 = 不修改" /></div>' +
      (isNew ? '' : '<div class="pf-row"><label>模型表（只读——槽值发现；增删走 provider 子命令/TOML）· ' + models.length + ' 个</label>' +
        '<div class="pf-models"><div class="pf-mhead"><span>模型 ID</span><span></span><span></span><span></span></div>' +
        models.map(function (m) { return '<div class="pf-mrow"><input class="fi" value="' + esc(m) + '" readonly /><span></span><span></span><span></span></div>'; }).join('') + '</div></div>') +
      '<div class="pu-actions"><span class="spacer"></span>' +
        (isNew ? '' : '<button class="btn danger" data-k="pf-del">删除供应商</button>') +
        '<button class="btn" data-k="pf-cancel">取消</button>' +
        '<button class="btn primary" data-k="pf-save">保存</button></div>';
    paintVicos(page);
    setPageHandler = function (e) { providerFormAct(page, p, isNew, e); };
  }
  function providerFormAct(page, p, isNew, e) {
    if (e.target.closest('[data-k="pf-back"]') || e.target.closest('[data-k="pf-cancel"]')) { pageProviders(page); return; }
    if (e.target.closest('[data-k="pf-eye"]')) {
      var inp = page.querySelector('#pf-key');
      inp.type = inp.type === 'password' ? 'text' : 'password';
      return;
    }
    if (e.target.closest('[data-k="pf-del"]')) {
      openConfirm({
        title: '删除供应商',
        bodyHtml: '<div class="pu-text">将永久删除供应商「<b>' + esc(p.name ?? p.key) + '</b>」的槽位配置与模型表，无法恢复。\n\n<span class="dim">secrets.env 中的密钥行同时移除。</span></div>',
        confirmText: '删除供应商',
        onConfirm: function () {
          A.fetchJson('/api/providers', { method: 'POST', body: JSON.stringify({ op: 'remove', slot: p.key, removeSecret: true }) }).then(function (r) {
            toast('已移除 ' + (p.name ?? p.key));
            if (r && r.report && r.report.failed && r.report.failed.length) toast('部分模块重载失败：' + r.report.failed.map(function (f) { return f.name; }).join(', '));
            pageProviders(page);
          }, function (err) { toast('删除失败：' + err.message); });
        },
      });
      return;
    }
    if (e.target.closest('[data-k="pf-save"]')) {
      var name = (page.querySelector('#pf-name').value || '').trim();
      var url = (page.querySelector('#pf-url').value || '').trim();
      var slot = isNew ? name : (p ? p.key : name);
      if (slot === '' || !/^[A-Za-z0-9_-]+$/.test(slot)) { toast(isNew ? '名称必填（字母/数字/-/_ 的槽位 id）' : '槽位异常'); return; }
      if (!/^https?:\/\//.test(url)) { toast('Base URL 得以 http:// 或 https:// 开头'); return; }
      var spec = { type: page.querySelector('#pf-proto').value, baseUrl: url };
      var key = page.querySelector('#pf-key').value;
      if (key !== '') spec.apiKey = key; /* 缺省 = 保留旧 $ENV: 引用（掩码不重发不清凭据） */
      var defEl = page.querySelector('#pf-def');
      var def = defEl ? (defEl.value || '').trim() : '';
      if (def !== '') spec.defaultModel = def; /* 缺省 = 清除默认（整表替换的普通字段） */
      var ctxW = parseInt(page.querySelector('#pf-ctx').value, 10);
      if (Number.isFinite(ctxW) && ctxW >= 1024) spec.contextWindow = ctxW; /* 缺省不动顶层 */
      A.fetchJson('/api/providers', { method: 'POST', body: JSON.stringify({ op: 'upsert', slot: slot, spec: spec }) }).then(function (r) {
        toast('已写入「' + slot + '」' + (r && r.report ? '——模块图重载后生效' : ''));
        pageProviders(page);
      }, function (err) { toast('保存失败：' + err.message); });
    }
  }
  /** 添加供应商：目录搜索（models.dev 缓存——source 恒 cache）+ 自定义手填。 */
  function renderProviderAdd(page) {
    pageLoading(page);
    A.fetchJson('/api/providers/catalog').then(function (d) {
      provData.vendors = d.vendors ?? [];
      page.innerHTML = '<span class="pf-back" data-k="pf-back">‹ 添加供应商</span>' +
        '<div class="pf-row"><input class="fi" id="pf-q" placeholder="搜索供应商" /></div>' +
        '<div class="pf-list" id="pf-vlist">' + provData.vendors.map(function (v, vi) {
          return '<div class="pf-vrow" data-k="vend" data-v="' + vi + '" data-name="' + esc(String(v.name ?? '').toLowerCase()) + '">' + provIcon(v.key) +
            '<span class="vname">' + esc(v.name ?? v.key) + '</span><span class="vbadge">' + esc(v.proto ?? 'openai') + '</span>' +
            '<span class="vcount">' + (v.models ?? []).length + ' 个模型</span></div>';
        }).join('') +
        '<div class="pf-vrow" data-k="vend-custom">' + provIcon('custom') + '<span class="vname">自定义（手填）</span><span class="vcount">OpenAI 兼容端点</span></div>' +
        '</div>' +
        '<div class="sp-note">从 models.dev 目录缓存选择（预填端点与模型表；缓存为空时先在终端 orosus provider import 刷新），或自定义手填。</div>';
      paintVicos(page);
      var q = page.querySelector('#pf-q');
      q.addEventListener('input', function () {
        var s = q.value.trim().toLowerCase();
        page.querySelectorAll('#pf-vlist .pf-vrow[data-name]').forEach(function (r) {
          r.hidden = !r.getAttribute('data-name').includes(s);
        });
      });
      setPageHandler = function (e) {
        if (e.target.closest('[data-k="pf-back"]')) { pageProviders(page); return; }
        var v = e.target.closest('[data-k="vend"]');
        if (v) { renderProviderImport(page, provData.vendors[parseInt(v.getAttribute('data-v'), 10)]); return; }
        if (e.target.closest('[data-k="vend-custom"]')) {
          renderProviderForm(page, { key: '', name: '', proto: 'openai', baseUrl: '', models: [] }, true);
        }
      };
    }, function (err) { pageLoadError(page, err); });
  }
  /** 目录添加表单（POST /api/providers/cmd——argv = provider import <id> --baseUrl --key --model，T13 钉形）。 */
  function renderProviderImport(page, v) {
    setPageHandler = null;
    var models = (v && v.models) || [];
    page.innerHTML =
      '<span class="pf-back" data-k="pf-back">‹ ' + provIcon(v ? v.key : 'catalog') + ' ' + esc(v ? v.name ?? v.key : '目录供应商') + ' <span class="vbadge">目录导入</span></span>' +
      '<div class="pf-row"><label>API Key <span class="req">*</span></label><input class="fi" id="pf-key" type="password" placeholder="sk-…" /></div>' +
      '<div class="pf-row"><label>Base URL <span class="req">*</span></label><input class="fi" id="pf-url" value="' + esc(v ? v.baseUrl ?? '' : '') + '" /></div>' +
      '<div class="pf-row"><label>默认模型 <span class="req">*</span></label><select class="fsel" id="pf-def">' +
        models.map(function (m, i) {
          return '<option value="' + esc(m.id) + '"' + (i === 0 ? ' selected' : '') + '>' + esc(m.label ?? m.id) + (m.ctx ? '（' + m.ctx + '）' : '') + '</option>';
        }).join('') + '</select></div>' +
      '<div class="sp-note">导入走 provider import 子命令（目录模型表与上下文窗口自动落盘——上下文取目录 limit）。模型目录：' + (models.length) + ' 个。</div>' +
      '<div class="pu-actions"><span class="spacer"></span>' +
        '<button class="btn" data-k="pf-cancel">取消</button>' +
        '<button class="btn primary" data-k="pf-save">导入</button></div>';
    paintVicos(page);
    setPageHandler = function (e) {
      if (e.target.closest('[data-k="pf-back"]') || e.target.closest('[data-k="pf-cancel"]')) { renderProviderAdd(page); return; }
      if (e.target.closest('[data-k="pf-save"]')) {
        var key = (page.querySelector('#pf-key').value || '').trim();
        var url = (page.querySelector('#pf-url').value || '').trim();
        var def = page.querySelector('#pf-def').value;
        if (key === '') { toast('API Key 必填（导入命令需要 --key）'); return; }
        if (!/^https?:\/\//.test(url)) { toast('Base URL 得以 http:// 或 https:// 开头'); return; }
        var argv = ['provider', 'import', v.key, '--baseUrl', url, '--key', key, '--model', def];
        A.fetchJson('/api/providers/cmd', { method: 'POST', body: JSON.stringify({ argv: argv }) }).then(function (r) {
          if (r.code === 0) {
            toast('已导入「' + (v.name ?? v.key) + '」' + (r.report ? '——模块图重载后生效' : ''));
            pageProviders(page);
          } else {
            toast(r.out || '导入失败（code ' + r.code + '）');
          }
        }, function (err) { toast('导入失败：' + err.message); });
      }
    };
  }

  /* ── F3 模型偏好（GET /api/models + GET /api/settings/prefs〔T17 补读口〕；下拉即改即写） ── */
  function mpRow(label, control, sub) {
    return '<div class="mp-row' + (sub ? ' sub' : '') + '"><span class="mp-label">' + esc(label) + '</span><span class="mp-ctl">' + control + '</span></div>';
  }
  function modelOptGroups(selectedVal, providers) {
    return (providers ?? []).map(function (p) {
      return '<optgroup label="' + esc(p.displayName ?? p.key) + '">' + (p.models ?? []).map(function (m) {
        var val = p.key + '/' + m.name;
        return '<option value="' + esc(val) + '"' + (val === selectedVal ? ' selected' : '') + '>' + esc(m.label ?? m.name) + '（' + esc(m.name) + '）</option>';
      }).join('') + '</optgroup>';
    }).join('');
  }
  function pageModelPrefs(page) {
    pageLoading(page);
    Promise.all([
      A.fetchJson('/api/models' + (currentSid ? '?sid=' + encodeURIComponent(currentSid) : '')),
      A.fetchJson('/api/settings/prefs'),
    ]).then(function (res) {
      var md = res[0], pf = res[1];
      var providers = md.providers ?? [];
      var current = String(md.current ?? '');
      var vision = String(pf.visionModel ?? 'off');
      var search = String(pf.search ?? 'auto');
      var sub = pf.subagent ?? {};
      var visionCur = (vision !== 'off' && vision !== 'auto') ? vision : '';
      var turnCur = sub.maxTurns === null || sub.maxTurns === undefined ? '' : String(sub.maxTurns);
      var turnOpts = [
        { v: '', l: '跟随默认——100 轮' },
        { v: '150', l: '150——较长任务' },
        { v: '200', l: '200——钳位上限' },
        { v: '-1', l: '不限（仅时长兜底）' },
      ];
      if (turnCur !== '' && !turnOpts.some(function (o) { return o.v === turnCur; })) turnOpts.push({ v: turnCur, l: '当前 ' + turnCur });
      page.innerHTML = spTitle('模型偏好', 'PREFERENCES') +
        '<div class="sp-note">默认模型 / 视觉模型 / 网络搜索 / 子代理模型——改一项写一项，立即写盘并重载生效。</div>' +
        mpRow('默认模型', '<select class="fsel" id="mp-model"><option value=""' + (current === '' ? ' selected' : '') + '>（未配置）</option>' + modelOptGroups(current, providers) + '</select>') +
        mpRow('视觉模型', '<select class="fsel" id="mp-vision">' +
          '<option value="off"' + (vision === 'off' ? ' selected' : '') + '>停用（默认）</option>' +
          '<option value="auto"' + (vision === 'auto' ? ' selected' : '') + '>自动（用已配置模型里支持图片的）</option>' +
          (visionCur && !modelOptGroups(visionCur, providers).includes('value="' + esc(visionCur) + '"')
            ? '<option value="' + esc(visionCur) + '" selected>' + esc(visionCur) + '（当前）</option>' : '') +
          modelOptGroups(visionCur, providers) + '</select>') +
        mpRow('网络搜索', '<select class="fsel" id="mp-search">' +
          '<option value="auto"' + (search === 'auto' ? ' selected' : '') + '>自动（缺省）</option>' +
          '<option value="llm"' + (search === 'llm' ? ' selected' : '') + '>LLM Web Search（模型内置）</option>' +
          '<option value="tavily"' + (search === 'tavily' ? ' selected' : '') + '>Tavily（需 API key）</option>' +
          '<option value="brave"' + (search === 'brave' ? ' selected' : '') + '>Brave（需 API key）</option></select>') +
        mpRow('子代理模型', '<select class="fsel" id="mp-submodel"><option value=""' + (!sub.model ? ' selected' : '') + '>跟随（工种声明 / 父模型）</option>' +
          (sub.model && !modelOptGroups(sub.model, providers).includes('value="' + esc(sub.model) + '"')
            ? '<option value="' + esc(sub.model) + '" selected>' + esc(sub.model) + '（当前）</option>' : '') +
          modelOptGroups(sub.model ?? '', providers) + '</select>') +
        mpRow('审批模式', '<select class="fsel" id="mp-subapproval">' +
          '<option value=""' + (!sub.approvalMode ? ' selected' : '') + '>跟随主对话（缺省）</option>' +
          '<option value="auto"' + (sub.approvalMode === 'auto' ? ' selected' : '') + '>从不询问</option>' +
          '<option value="ask"' + (sub.approvalMode === 'ask' ? ' selected' : '') + '>需要时候询问</option></select>', true) +
        mpRow('轮数上限', '<select class="fsel" id="mp-subturns">' + turnOpts.map(function (o) {
          return '<option value="' + esc(o.v) + '"' + (turnCur === o.v ? ' selected' : '') + '>' + esc(o.l) + '</option>';
        }).join('') + '</select>', true) +
        '<div class="sp-note">子代理模型下方的审批模式 / 轮数上限是子代理专属子项；「跟随」= 删配置键（缺省语义）。</div>';
      setPageHandler = null;
      var sel = function (id) { return page.querySelector('#' + id); };
      function postPref(key, value, okMsg, revert) {
        A.fetchJson('/api/settings/prefs', { method: 'POST', body: JSON.stringify({ key: key, value: value }) }).then(function () {
          toast(okMsg);
        }, function (err) {
          toast('设置失败：' + err.message);
          if (revert) revert();
        });
      }
      sel('mp-model').addEventListener('change', function () {
        var val = this.value;
        var prev = current;
        if (val === '') { this.value = prev; return; }
        if (currentSid === null) { toast('暂无会话——默认模型切换需要当前会话（/model 写顶层 provider 键）'); this.value = prev; return; }
        var parts = val.split('/');
        var mname = parts.slice(1).join('/');
        A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/model', { method: 'POST', body: JSON.stringify({ platform: parts[0], model: mname }) }).then(function () {
          current = val;
          toast('默认模型已切换 → ' + val + '（已写 config，下一轮生效）');
        }, function (err) {
          toast('切换失败：' + err.message);
          var el = sel('mp-model');
          if (el) el.value = prev;
        });
      });
      sel('mp-vision').addEventListener('change', function () {
        var el = this; /* revert 闭包捕获元素——strict-mode 裸调用 this === undefined（审查 Important） */
        var v = this.value;
        postPref('visionModel', v, v === 'off' ? '视觉模型：已设为停用' : v === 'auto' ? '视觉模型：已设为自动（用已配置模型里支持图片的）' : '视觉模型：已指定 ' + v + '（已写 [tool-media]）', function () { el.value = vision; });
      });
      sel('mp-search').addEventListener('change', function () {
        var el = this;
        var v = this.value;
        var names = { auto: '自动（缺省）', llm: 'LLM Web Search', tavily: 'Tavily', brave: 'Brave' };
        postPref('search.backend', v, '网络搜索后端：' + (names[v] ?? v) + '（已写 tool-web 配置）', function () { el.value = search; });
      });
      sel('mp-submodel').addEventListener('change', function () {
        var el = this;
        var v = this.value;
        postPref('model', v === '' ? null : v, v === '' ? '子代理模型：已清除（跟工种声明 / 父模型）' : '子代理模型：' + v + '（已写 [tool-subagent] model）', function () { el.value = sub.model ?? ''; });
      });
      sel('mp-subapproval').addEventListener('change', function () {
        var el = this;
        var v = this.value;
        postPref('approvalMode', v === '' ? null : v, v === '' ? '子代理审批模式：跟随主对话（配置键已清除）' : '子代理审批模式：' + (v === 'auto' ? '从不询问' : '需要时候询问') + '（已写 [tool-subagent] approvalMode）', function () { el.value = sub.approvalMode ?? ''; });
      });
      sel('mp-subturns').addEventListener('change', function () {
        var el = this;
        var v = this.value;
        postPref('maxTurns', v === '' ? null : parseInt(v, 10), v === '' ? '子代理轮数上限：跟随默认（100）——配置键已清除' : '子代理轮数上限：已写入 ' + v, function () { el.value = turnCur; });
      });
    }, function (err) { pageLoadError(page, err); });
  }

  /* ── F4 技能（GET /api/settings/skills——行即详情五字段；POST toggle 写 [skill] disabled + reload） ── */
  /* ── F4 技能（2026-10-12 走查七轮重做：平铺名录 → 富列表行——状态点 + 双行文 + 行内启停拨杆 +
   *    范围徽标；点击行仍进详情。TUI 详情窗 Alt+K 的 web 化不变） ── */
  var SKILL_SCOPE = { user: '用户', project: '项目', bundled: '内置' };
  function skillRowHtml(s) {
    return '<div class="lr-row' + (s.disabled ? ' off' : '') + '" data-k="skill" data-v="' + esc(s.name) + '">' +
      '<span class="mdot ' + (s.disabled ? 'off">○' : 'ok">●') + '</span>' +
      '<span class="lr-main"><span class="lr-name">' + esc(s.name) +
      ' <span class="lr-tag">' + esc(SKILL_SCOPE[s.scope] ?? s.scope ?? '') + '</span></span>' +
      (s.desc ? '<span class="lr-desc">' + esc(s.desc) + '</span>' : '') + '</span>' +
      '<button class="mc-toggle' + (s.disabled ? '' : ' on') + '" data-sw="' + esc(s.name) + '" role="switch" aria-checked="' + String(!s.disabled) + '" aria-label="' + esc(s.name) + ' 启停" title="' + (s.disabled ? '启用' : '停用') + '"></button>' +
      '<span class="lr-caret">›</span></div>';
  }
  function pageSkills(page) {
    pageLoading(page);
    A.fetchJson('/api/settings/skills').then(function (d) {
      var skills = d.skills ?? [];
      if (skills.length === 0) {
        page.innerHTML = spTitle('技能', 'SKILLS · 四轨目录') + '<div class="sp-note">（暂无技能——技能目录四轨：~/.agents/skills → ~/.orosus/skills → 项目 .agents/skills → 项目 .orosus/skills；skill 模块未启用时此页为空）</div>';
        setPageHandler = null;
        return;
      }
      var offN = skills.filter(function (s) { return s.disabled; }).length;
      page.innerHTML = spTitle('技能', 'SKILLS · 四轨目录') +
        '<div class="lr-sum">共 ' + skills.length + ' 个 · 启用 ' + (skills.length - offN) + ' · 停用 ' + offN + '</div>' +
        skills.map(skillRowHtml).join('') +
        '<div class="sp-note">拨杆直接启停（写 [skill] disabled + 模块重载，斜杠菜单即刻生效）；点击行进详情——详情页内文件可点击打开。</div>';
      setPageHandler = function (e) {
        /* 拨杆先行（行内直切不进详情）；点击行其余部位进详情 */
        var sw = e.target.closest('[data-sw]');
        if (sw) {
          var name = sw.getAttribute('data-sw');
          var s = skills.find(function (x) { return x.name === name; });
          if (!s) return;
          var target = !s.disabled;
          A.fetchJson('/api/settings/skills/toggle', { method: 'POST', body: JSON.stringify({ name: name, disabled: target }) }).then(function () {
            s.disabled = target;
            toast((target ? '已停用 ' : '已启用 ') + name + '（模块已重载，清单即刻生效）');
            UI.invalidateCaches(); /* 斜杠菜单技能区 30s 缓存同步失效 */
            /* 行原位刷新（零整页重拉——点/拨杆/统计三段换装） */
            var rowEl = sw.closest('.lr-row');
            if (rowEl) {
              rowEl.classList.toggle('off', target);
              var dot = rowEl.querySelector('.mdot');
              if (dot) { dot.className = 'mdot ' + (target ? 'off' : 'ok'); dot.textContent = target ? '○' : '●'; }
              sw.classList.toggle('on', !target);
              sw.setAttribute('aria-checked', String(!target));
              sw.title = target ? '启用' : '停用';
            }
            var sumEl = page.querySelector('.lr-sum');
            if (sumEl) {
              var off2 = skills.filter(function (x) { return x.disabled; }).length;
              sumEl.textContent = '共 ' + skills.length + ' 个 · 启用 ' + (skills.length - off2) + ' · 停用 ' + off2;
            }
          }, function (err) { toast('操作失败：' + err.message); });
          return;
        }
        var row = e.target.closest('[data-k="skill"]');
        if (!row) return;
        var s2 = skills.find(function (x) { return x.name === row.getAttribute('data-v'); });
        if (s2) renderSkillDetail(page, s2);
      };
    }, function (err) { pageLoadError(page, err); });
  }
  function renderSkillDetail(page, s) {
    page.innerHTML = '<span class="sp-back" data-k="skill-back">‹ 返回技能列表</span>' +
      spTitle('技能详情') +
      '<div class="pu-kv">' +
      kvRow('名称', esc(s.name)) +
      kvRow('描述', esc(s.desc ?? '')) +
      (s.usage ? kvRow('适用', esc(s.usage)) : '') +
      kvRow('范围', esc(s.scope ?? '')) +
      kvRow('状态', s.disabled ? '<span class="bad">停用</span>' : '<span class="ok">启用</span>') +
      /* 2026-10-12 走查：文件路径可点击——POST /api/open 系统默认程序打开 */
      kvRow('文件', '<button type="button" class="kv-link" data-k="open-file" data-v="' + esc(s.file ?? '') + '" title="点击用系统默认程序打开">' + esc(s.file ?? '') + '</button>', 'info') +
      '</div>' +
      '<div class="pu-actions"><button class="btn" data-k="skill-toggle">' + (s.disabled ? '启用' : '停用') + '</button></div>';
    setPageHandler = function (e) {
      if (e.target.closest('[data-k="skill-back"]')) { renderSetPage(4); return; } /* 技能页（外观插位后 3→4） */
      if (e.target.closest('[data-k="open-file"]')) {
        var path = e.target.closest('[data-k="open-file"]').getAttribute('data-v');
        A.fetchJson('/api/open', { method: 'POST', body: JSON.stringify({ path: path }) }).then(function () {
          toast('已请求系统默认程序打开');
        }, function (err) { toast('打开失败：' + err.message); });
        return;
      }
      if (e.target.closest('[data-k="skill-toggle"]')) {
        var target = !s.disabled;
        A.fetchJson('/api/settings/skills/toggle', { method: 'POST', body: JSON.stringify({ name: s.name, disabled: target }) }).then(function () {
          s.disabled = target;
          toast((target ? '已停用 ' : '已启用 ') + s.name + '（模块已重载，清单即刻生效）');
          UI.invalidateCaches(); /* 斜杠菜单技能区 30s 缓存同步失效 */
          renderSkillDetail(page, s);
        }, function (err) { toast('操作失败：' + err.message); });
      }
    };
  }

  /* ── F5 钩子（GET /api/settings/hooks——用户级/项目级分节；POST toggle/trust） ── */
  var HOOK_TIMEOUT_DEFAULT = 60;
  /* ── F5 钩子（2026-10-12 走查七轮重做：与技能页同款富列表行——状态点 + 说明/命令双行 + 行内启停
   *    拨杆 + 产品/未信任徽标；点击行仍进详情（信任审查在详情页）。TUI e/t 键的 web 化不变） ── */
  function hookRowHtmlV2(h, trusted) {
    var comp = h.file + '|' + h.event + '|' + h.tableIdx + '|' + h.hookIdx;
    var untrusted = h.origin === 'project' && !trusted;
    return '<div class="lr-row' + (h.disabled ? ' off' : '') + '" data-k="hook" data-v="' + esc(comp) + '">' +
      '<span class="mdot ' + (h.disabled ? 'off">○' : 'ok">●') + '</span>' +
      '<span class="lr-main"><span class="lr-name">' + esc(h.name ? h.name : h.event) +
      (h.name ? ' <span class="lr-tag">' + esc(h.event) + '</span>' : '') +
      (h.product ? ' <span class="lr-tag info">' + esc(h.product) + '</span>' : '') +
      (untrusted ? ' <span class="lr-tag warn">未信任</span>' : '') +
      '</span>' +
      '<span class="lr-desc mono">' + esc(h.command ?? '') + (h.matcher ? '　·　matcher: ' + esc(h.matcher) : '') + '</span></span>' +
      '<button class="mc-toggle' + (h.disabled ? '' : ' on') + '" data-sw="' + esc(comp) + '" role="switch" aria-checked="' + String(!h.disabled) + '" aria-label="' + esc(h.event) + ' 钩子启停" title="' + (h.disabled ? '启用' : '停用') + '"></button>' +
      '<span class="lr-caret">›</span></div>';
  }
  function pageHooks(page) {
    pageLoading(page);
    A.fetchJson('/api/settings/hooks').then(function (d) {
      var user = d.user ?? [];
      var proj = d.project ?? [];
      var trusted = !!d.projectTrusted;
      var sec = function (title, rows) {
        return subHeadT(title + '（' + rows.length + '）', title.indexOf('项目') === 0) + (rows.length > 0 ? rows.map(function (h) {
          return hookRowHtmlV2(h, trusted);
        }).join('') : '<div class="sp-note">（空——钩子增编走 TOML 文件：' + esc(title.indexOf('项目') === 0 ? '项目 .orosus/hooks' : '~/.orosus/hooks') + '，改后 /reload）</div>');
      };
      page.innerHTML = spTitle('钩子', 'HOOKS · 七事件生命周期') +
        sec('用户级', user) + sec('项目级（须信任审查）', proj) +
        '<div class="sp-note">拨杆直接启停（行级写盘 + 重载生效）；点击行进详情——项目层信任审查在详情页。</div>';
      var all = user.concat(proj);
      setPageHandler = function (e) {
        /* 拨杆先行（行内直切）；点击行其余部位进详情 */
        var sw = e.target.closest('[data-sw]');
        if (sw) {
          var cv = sw.getAttribute('data-sw');
          var h2 = all.find(function (x) { return x.file + '|' + x.event + '|' + x.tableIdx + '|' + x.hookIdx === cv; });
          if (!h2) return;
          var target = !h2.disabled;
          A.fetchJson('/api/settings/hooks/toggle', { method: 'POST', body: JSON.stringify({ file: h2.file, event: h2.event, tableIdx: h2.tableIdx, hookIdx: h2.hookIdx, disabled: target }) }).then(function () {
            h2.disabled = target;
            toast((target ? '已停用 ' : '已启用 ') + (h2.name ? h2.name : h2.event) + '（行级写盘，重载后生效）');
            var rowEl = sw.closest('.lr-row');
            if (rowEl) {
              rowEl.classList.toggle('off', target);
              var dot = rowEl.querySelector('.mdot');
              if (dot) { dot.className = 'mdot ' + (target ? 'off' : 'ok'); dot.textContent = target ? '○' : '●'; }
              sw.classList.toggle('on', !target);
              sw.setAttribute('aria-checked', String(!target));
              sw.title = target ? '启用' : '停用';
            }
          }, function (err) { toast('操作失败：' + err.message); });
          return;
        }
        var row = e.target.closest('[data-k="hook"]');
        if (!row) return;
        var h = all.find(function (x) { return x.file + '|' + x.event + '|' + x.tableIdx + '|' + x.hookIdx === row.getAttribute('data-v'); });
        if (h) renderHookDetail(page, h, trusted);
      };
    }, function (err) { pageLoadError(page, err); });
  }
  function renderHookDetail(page, h, trusted) {
    page.innerHTML = '<span class="sp-back" data-k="hook-back">‹ 返回钩子列表</span>' +
      spTitle('钩子详情') +
      '<div class="pu-kv">' +
      (h.name ? kvRow('说明', esc(h.name)) : '') +
      kvRow('事件', esc(h.event)) +
      (h.matcher ? kvRow('matcher', esc(h.matcher)) : '') +
      kvRow('命令', esc(h.command ?? ''), 'info') +
      kvRow('超时', esc(String(h.timeout ?? HOOK_TIMEOUT_DEFAULT) + 's')) +
      kvRow('来源', h.origin === 'user' ? '用户级' : '项目级') +
      kvRow('信任态', h.origin === 'user' ? '用户级免审' : (trusted ? '<span class="ok">已信任</span>' : '<span class="st-warn">未信任——须审查后生效</span>')) +
      '</div>' +
      '<div class="pu-actions">' +
      '<button class="btn" data-k="hook-toggle">' + (h.disabled ? '启用' : '停用') + '</button>' +
      (h.origin === 'project' && !trusted ? '<button class="btn primary" data-k="hook-trust">信任审查（TUI t 键）</button>' : '') +
      '</div>';
    setPageHandler = function (e) {
      if (e.target.closest('[data-k="hook-back"]')) { renderSetPage(5); return; } /* 钩子页（外观插位后 4→5） */
      if (e.target.closest('[data-k="hook-toggle"]')) {
        var target = !h.disabled;
        A.fetchJson('/api/settings/hooks/toggle', { method: 'POST', body: JSON.stringify({ file: h.file, event: h.event, tableIdx: h.tableIdx, hookIdx: h.hookIdx, disabled: target }) }).then(function () {
          h.disabled = target;
          toast((target ? '已停用' : '已启用') + '（行级写盘，重载后生效）');
          renderHookDetail(page, h, trusted);
        }, function (err) { toast('操作失败：' + err.message); });
      } else if (e.target.closest('[data-k="hook-trust"]')) {
        A.fetchJson('/api/settings/hooks/trust', { method: 'POST', body: '{}' }).then(function () {
          toast('项目层钩子已通过信任审查（sha256 已登记）');
          pageHooks(page);
        }, function (err) { toast('信任失败：' + err.message); });
      }
    };
  }

  /* ── F6 MCP（GET /api/settings/mcp——McpCatalogRow 五态；POST /api/settings/mcp/ops 七 op + 结构化 add）
   *  2026-10-12 走查二轮重构（对齐 TUI）：列表行 = 状态点（绿=已连接 / 红=失败 / 灰=停用·待启动）+
   *  名称 + 传输·工具数 + 行上「启动」（懒启动件）/「详情」钮——右侧状态文字退役；添加/修改窗对齐
   *  TUI Alt+N（mcp-add-window.ts）：手动/JSON 双页签、传输三档、高级区 env/headers/cwd/超时秒。 */
  var MCP_STATE_TEXT = { connected: '已连接 · 启用', idle: '待启动 · 启用', failed: '失败 · 启用', disabled: '已停用', 'pending-confirm': '未确认' };
  var MCP_SOURCE_TEXT = { config: '配置文件', project: '项目 .mcp.json', preload: '预装' };
  var MCP_TRANSPORT_TEXT = { stdio: 'stdio 子进程', http: 'HTTP（远程）', sse: 'SSE（远程）' };
  function mcpDot(m) {
    if (m.state === 'connected') return '<span class="mdot ok">●</span>';
    if (m.state === 'failed') return '<span class="mdot bad">●</span>';
    if (m.state === 'disabled') return '<span class="mdot off">●</span>';
    if (m.state === 'pending-confirm') return '<span class="mdot bad">◉</span>';
    return '<span class="mdot off">○</span>'; /* idle 待启动 */
  }
  function mcpRowLine(m) {
    var remote = m.transport === 'http' || m.transport === 'sse';
    var desc = remote ? 'HTTP' : 'stdio';
    if (m.state === 'connected' && typeof m.toolCount === 'number') desc += ' · ' + m.toolCount + ' 工具';
    var acts = '';
    if (m.deferred === true && (m.state === 'idle' || m.state === 'failed')) {
      acts += '<button class="btn tiny" data-k="mcp-start" data-v="' + esc(m.name) + '" title="懒启动件首次连接（npx 下载最长 60 秒）">启动</button>';
    }
    acts += '<button class="btn tiny" data-k="mcp-detail" data-v="' + esc(m.name) + '">详情</button>';
    return mcpDot(m) +
      '<span class="pi-name">' + esc(m.name) + '</span><span class="pi-desc">' + esc(desc) + '</span><span class="pi-right mcp-acts">' + acts + '</span>';
  }
  function pageMcp(page) {
    pageLoading(page);
    A.fetchJson('/api/settings/mcp').then(function (d) {
      var servers = d.servers ?? [];
      page.innerHTML = '<div class="pf-headrow">' + spTitle('MCP', 'SERVERS · ' + servers.length + ' 个 · 预装按需启动') +
        '<button class="btn primary" data-k="mcp-add">＋ 添加</button></div>' +
        (servers.length > 0 ? servers.map(function (m) {
          return '<div class="pu-item" data-k="mcp" data-v="' + esc(m.name) + '" title="' + esc(MCP_TRANSPORT_TEXT[m.transport] ?? m.transport ?? 'stdio') + '">' + mcpRowLine(m) + '</div>';
        }).join('') : '<div class="sp-note">（无 MCP server——mcp 模块未启用或未配置）</div>') +
        '<div class="sp-note">状态点：绿=已连接 · 红=失败 · 灰=停用/待启动；「启动」仅懒启动件（首次连接可能需要下载）；其余操作（停用/信任/修改/删除）在详情页。</div>';
      setPageHandler = function (e) {
        if (e.target.closest('[data-k="mcp-add"]')) { renderMcpForm(page, 'add'); return; }
        var start = e.target.closest('[data-k="mcp-start"]');
        if (start) {
          var nm = start.getAttribute('data-v');
          A.fetchJson('/api/settings/mcp/ops', { method: 'POST', body: JSON.stringify({ op: 'start', name: nm }) }).then(function (r) {
            toast(r && r.starting ? '正在启动 ' + nm + '（首次可能需要下载，最长 60 秒）…' : '已触发启动');
            window.setTimeout(function () { if (document.getElementById('set-page')) pageMcp(page); }, 5000);
          }, function (err) { toast(err.status === 409 ? err.message : '启动失败：' + err.message); });
          return;
        }
        var det = e.target.closest('[data-k="mcp-detail"]');
        var row = e.target.closest('[data-k="mcp"]');
        var target = det ?? row;
        if (!target) return;
        var m = servers.find(function (x) { return x.name === target.getAttribute('data-v'); });
        if (m) renderMcpDetail(page, m);
      };
    }, function (err) { pageLoadError(page, err); });
  }
  function renderMcpDetail(page, m) {
    var acts = [];
    if (m.deferred === true && (m.state === 'idle' || m.state === 'failed')) acts.push('<button class="btn primary" data-k="mcp-start">启动</button>');
    else acts.push('<button class="btn" data-k="mcp-toggle">' + (m.state === 'disabled' ? '启用' : '停用') + '</button>');
    if (m.source === 'config') {
      acts.push('<button class="btn" data-k="mcp-edit">修改</button>');
      acts.push('<button class="btn danger" data-k="mcp-del">删除</button>');
    }
    if (m.state === 'pending-confirm') acts.push('<button class="btn primary" data-k="mcp-trust">确认信任（TUI t 键）</button>');
    var specDesc = m.instructions ?? ((m.toolCount ?? 0) > 0 ? m.toolCount + ' 个工具' : '—');
    page.innerHTML = '<span class="sp-back" data-k="mcp-back">‹ 返回 MCP 列表</span>' +
      spTitle(m.name + ' · MCP server') +
      '<div class="pu-kv">' +
      kvRow('名称', esc(m.name)) +
      kvRow('说明', esc(specDesc)) +
      kvRow('状态', esc(MCP_STATE_TEXT[m.state] ?? m.state) + (m.connectMs !== undefined && m.state === 'connected' ? ' · ' + m.connectMs + 'ms' : '')) +
      kvRow('来源', esc(MCP_SOURCE_TEXT[m.source] ?? m.source)) +
      kvRow('传输方式', esc(MCP_TRANSPORT_TEXT[m.transport] ?? m.transport ?? 'stdio')) +
      kvRow(m.url ? 'URL' : '命令', esc(m.url ?? m.command ?? '—'), 'info') +
      (m.failReason ? '<span class="k"></span><span class="v dim">' + esc(m.failReason) + '</span>' : '') +
      (m.state === 'pending-confirm' ? '<span class="k"></span><span class="v dim">未确认——核对指纹后确认连接（指纹 ' + esc((m.fingerprint ?? '').slice(0, 8)) + '…；确认一次永久可用，配置被改过会重新要求）</span>' : '') +
      (m.source === 'preload' ? '<span class="k"></span><span class="v dim">预装 server——只能停用不能删除</span>' : '') +
      '</div>' +
      '<div class="pu-actions">' + acts.join('') + '</div>';
    setPageHandler = function (e) {
      if (e.target.closest('[data-k="mcp-back"]')) { renderSetPage(6); return; } /* MCP 页（外观插位后 5→6） */
      if (e.target.closest('[data-k="mcp-toggle"]')) {
        var off = m.state !== 'disabled';
        mcpOp(page, { op: off ? 'off' : 'on', name: m.name }, function () { toast((off ? '已停用 ' : '已启用 ') + m.name + '——模块图重载后生效'); pageMcp(page); });
        return;
      }
      if (e.target.closest('[data-k="mcp-start"]')) {
        A.fetchJson('/api/settings/mcp/ops', { method: 'POST', body: JSON.stringify({ op: 'start', name: m.name }) }).then(function (r) {
          if (r && r.starting) {
            toast('正在启动 ' + m.name + '（首次可能需要下载，最长 60 秒）…');
            window.setTimeout(function () { pageMcp(page); }, 5000); /* lazy 态翻转走 catalog（202 排队无失败回执帧） */
          } else {
            toast('已触发启动');
            pageMcp(page);
          }
        }, function (err) { toast(err.status === 409 ? err.message : '启动失败：' + err.message); });
        return;
      }
      if (e.target.closest('[data-k="mcp-trust"]')) {
        mcpOp(page, { op: 'trust', name: m.name }, function () { toast('已确认 ' + m.name + '——模块图重载后连接'); pageMcp(page); });
        return;
      }
      if (e.target.closest('[data-k="mcp-edit"]')) { renderMcpForm(page, 'edit', m); return; }
      if (e.target.closest('[data-k="mcp-del"]')) {
        openConfirm({
          title: '删除 MCP server',
          bodyHtml: '<div class="pu-text">将永久删除 server「<b>' + esc(m.name) + '</b>」的配置条目，无法恢复。</div>',
          confirmText: '删除',
          onConfirm: function () { mcpOp(page, { op: 'remove', name: m.name }, function () { toast('已删除 ' + m.name + '——模块图重载后生效'); pageMcp(page); }); },
        });
      }
    };
  }
  /** mcp ops 统一发口：200 → text 服务端成品串 toast；400/404 → error 文案。 */
  function mcpOp(page, body, onOk) {
    A.fetchJson('/api/settings/mcp/ops', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      if (r && typeof r.text === 'string' && r.text !== '') toast(r.text);
      if (r && r.report && r.report.failed && r.report.failed.length) toast('部分模块重载失败：' + r.report.failed.map(function (f) { return f.name; }).join(', '));
      if (onOk) onOk(r);
    }, function (err) { toast('操作失败：' + err.message); });
  }
  /** 添加/修改 MCP server 窗（TUI Alt+N mcp-add-window.ts 的 web 化——2026-10-12 走查二轮）：
   *  手动/JSON 双页签（共享草稿互转不丢）+ 传输方式三档 + 高级区（env/headers〔远程〕/cwd〔stdio〕/
   *  超时秒）。保存走 ops add/edit 的结构化 spec（服务端 checkEditSpec 白名单校验同 TUI 写器）。 */
  function renderMcpForm(page, mode, row) {
    setPageHandler = null;
    var isEdit = mode === 'edit';
    var draft = { name: isEdit ? row.name : '', transport: 'stdio', cmd: '', env: '', headers: '', cwd: '', timeout: '', jsonText: '' };
    var tab = 'manual';
    var advOpen = isEdit; /* TUI：edit 高级区默认展开 */
    var msg = '';
    var msgBad = false;
    function paint() { setPageHandler = null; paintNow(); }
    function paintNow() {
      var remote = draft.transport !== 'stdio';
      var html = '<span class="pf-back" data-k="mcp-back">‹ 返回 MCP 列表</span>' +
        spTitle(isEdit ? '修改 ' + row.name : '添加 MCP server') +
        '<div class="mcp-tabs">' +
          '<button type="button" class="mcp-tab' + (tab === 'manual' ? ' sel' : '') + '" data-k="mtp-manual">手动</button>' +
          '<button type="button" class="mcp-tab' + (tab === 'json' ? ' sel' : '') + '" data-k="mtp-json">JSON</button>' +
          '<span class="mcp-tab-hint">页签间草稿互转</span></div>';
      if (tab === 'manual') {
        html += (isEdit
            ? '<div class="pf-row"><label>名称</label><input class="fi" value="' + esc(draft.name) + '" readonly /></div>'
            : '<div class="pf-row"><label>名称 <span class="req">*</span></label><input class="fi" id="mf-name" placeholder="my-search（字母/数字/-/_）" value="' + esc(draft.name) + '" /></div>') +
          '<div class="pf-row"><label>传输方式</label><select class="fsel" id="mf-transport">' +
            '<option value="stdio"' + (!remote ? ' selected' : '') + '>stdio（本地子进程）</option>' +
            '<option value="http"' + (draft.transport === 'http' ? ' selected' : '') + '>HTTP（远程）</option>' +
            '<option value="sse"' + (draft.transport === 'sse' ? ' selected' : '') + '>SSE（远程）</option></select></div>' +
          '<div class="pf-row"><label>' + (remote ? 'URL <span class="req">*</span>' : '命令 <span class="req">*</span>') + '</label>' +
            '<input class="fi" id="mf-cmd" value="' + esc(draft.cmd) + '" placeholder="' + (remote ? 'https://mcp.internal.example.com/sse' : 'npx -y my-search-mcp（整行命令，支持引号参数）') + '" /></div>' +
          '<div class="pf-row"><button type="button" class="btn" data-k="mf-adv">' + (advOpen ? '▾' : '▸') + ' 高级' + (advOpen ? '' : remote ? '（headers / 环境变量 / 超时）' : '（环境变量 / 工作目录 / 超时）') + '</button></div>';
        if (advOpen) {
          html += '<div class="pf-row"><label>环境变量（每行 KEY=VALUE' + (isEdit ? '；裸 KEY = 保持原值' : '') + '）</label><textarea class="fi" id="mf-env" rows="2" placeholder="API_KEY=xxx"></textarea></div>';
          if (remote) html += '<div class="pf-row"><label>请求头（每行 KEY=VALUE）</label><textarea class="fi" id="mf-headers" rows="2" placeholder="Authorization=Bearer …"></textarea></div>';
          else html += '<div class="pf-row"><label>工作目录</label><input class="fi" id="mf-cwd" value="' + esc(draft.cwd) + '" placeholder="（缺省 = 项目根）" /></div>';
          html += '<div class="pf-row"><label>超时（秒，正整数）</label><input class="fi" id="mf-timeout" value="' + esc(draft.timeout) + '" placeholder="（缺省 60）" /></div>';
        }
      } else {
        html += '<div class="sp-note">粘贴单条 server 的 JSON（{"mcpServers": {…}} 包裹或裸对象均可；一次只接受一个 server）。</div>' +
          '<div class="pf-row"><label>JSON</label><textarea class="fi" id="mf-json" rows="8" placeholder="{&quot;mcpServers&quot;: {&quot;my-search&quot;: {&quot;command&quot;: &quot;npx&quot;, &quot;args&quot;: [&quot;-y&quot;, &quot;my-search-mcp&quot;]}}}"></textarea></div>';
      }
      if (msg !== '') html += '<div class="sp-note ' + (msgBad ? 'bad' : '') + '">' + (msgBad ? '✕ ' : '✓ ') + esc(msg) + '</div>';
      html += '<div class="pu-actions"><span class="spacer"></span><button class="btn" data-k="mcp-cancel">取消</button>' +
        '<button class="btn primary" data-k="mcp-save">' + (isEdit ? '保存' : '添加') + '</button></div>';
      page.innerHTML = html;
      bind();
    }
    function bind() {
      var q = function (id) { return page.querySelector('#' + id); };
      var nameEl = q('mf-name'), cmdEl = q('mf-cmd'), envEl = q('mf-env'), hdEl = q('mf-headers'), cwdEl = q('mf-cwd'), toEl = q('mf-timeout'), jsonEl = q('mf-json');
      var syncInputs = function () {
        if (nameEl) draft.name = nameEl.value;
        if (cmdEl) draft.cmd = cmdEl.value;
        if (envEl) draft.env = envEl.value;
        if (hdEl) draft.headers = hdEl.value;
        if (cwdEl) draft.cwd = cwdEl.value;
        if (toEl) draft.timeout = toEl.value;
        if (jsonEl) draft.jsonText = jsonEl.value;
      };
      [nameEl, cmdEl, envEl, hdEl, cwdEl, toEl, jsonEl].forEach(function (el) {
        if (el) el.addEventListener('input', function () { syncInputs(); msg = ''; });
      });
      var tr = q('mf-transport');
      if (tr) tr.addEventListener('change', function () { draft.transport = this.value; paint(); });
      setPageHandler = function (e) {
        if (e.target.closest('[data-k="mcp-back"]') || e.target.closest('[data-k="mcp-cancel"]')) { pageMcp(page); return; }
        if (e.target.closest('[data-k="mtp-manual"]') && tab !== 'manual') {
          syncInputs();
          var fromJson = parseMcpJson(draft.jsonText);
          if (fromJson.error === undefined && fromJson.name !== undefined) applyJsonToDraft(fromJson, draft);
          tab = 'manual'; msg = ''; paint();
          return;
        }
        if (e.target.closest('[data-k="mtp-json"]') && tab !== 'json') {
          syncInputs();
          draft.jsonText = draftToJsonText(draft);
          tab = 'json'; msg = ''; paint();
          return;
        }
        if (e.target.closest('[data-k="mf-adv"]')) { syncInputs(); advOpen = !advOpen; paint(); return; }
        if (e.target.closest('[data-k="mcp-save"]')) { syncInputs(); void save(); }
      };
      if (jsonEl) { jsonEl.value = draft.jsonText; }
      if (envEl) envEl.value = draft.env;
      if (hdEl) hdEl.value = draft.headers;
      if (cwdEl) cwdEl.value = draft.cwd;
      if (toEl) toEl.value = draft.timeout;
    }
    function save() {
      var name = draft.name.trim();
      var spec;
      if (tab === 'json') {
        var parsed = parseMcpJson(draft.jsonText);
        if (parsed.error !== undefined) { msg = parsed.error; msgBad = true; paintNow(); return; }
        if (!isEdit) name = parsed.name;
        spec = parsed.spec;
      } else {
        if (name === '' || /\s/.test(name)) { msg = '名称必填且不含空白'; msgBad = true; paintNow(); return; }
        var built = buildMcpSpec(draft);
        if (built.error !== undefined) { msg = built.error; msgBad = true; paintNow(); return; }
        spec = built.spec;
      }
      A.fetchJson('/api/settings/mcp/ops', { method: 'POST', body: JSON.stringify(isEdit ? { op: 'edit', name: row.name, spec: spec } : { op: 'add', name: name, spec: spec }) }).then(function (r) {
        toast(isEdit ? '已保存 ' + name + '——模块图重载后生效' : '已添加 ' + name + '——模块图重载后连接');
        if (r && r.report && r.report.failed && r.report.failed.length) toast('部分模块重载失败：' + r.report.failed.map(function (f) { return f.name; }).join(', '));
        pageMcp(page);
      }, function (err) { msg = err.message; msgBad = true; paintNow(); });
    }
    if (isEdit) {
      pageLoading(page, '读取原配置…');
      A.fetchJson('/api/settings/mcp/entry?name=' + encodeURIComponent(row.name)).then(function (d) {
        var v = d.values ?? {};
        var remote = row.transport === 'http' || row.transport === 'sse';
        draft.transport = remote ? (v.transport === 'sse' ? 'sse' : 'http') : 'stdio';
        draft.cmd = remote ? String(v.url ?? '') : [v.command ?? ''].concat(Array.isArray(v.args) ? v.args : []).join(' ').trim();
        draft.env = Object.keys(v.env ?? {}).join('\n'); /* TUI 拍板：edit 只显键名不显值 */
        draft.headers = Object.keys(v.headers ?? {}).join('\n');
        draft.cwd = typeof v.cwd === 'string' ? v.cwd : '';
        draft.timeout = typeof v.timeoutMs === 'number' ? String(Math.round(v.timeoutMs / 1000)) : '';
        paint();
      }, function () { msg = '原配置读取失败（仅 config 来源可改）'; msgBad = true; paint(); });
    } else {
      paint();
    }
  }

  /* MCP 窗纯函数（TUI mcp-add-window 同族——splitCommandLine/parseKeyValueLines/parseJsonPaste 的 web 版） */
  function splitMcpCmd(line) {
    var out = [], cur = '', q = '';
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (q) { if (c === q) q = ''; else cur += c; }
      else if (c === '"' || c === "'") q = c;
      else if (c === ' ' || c === '\t') { if (cur !== '') { out.push(cur); cur = ''; } }
      else cur += c;
    }
    if (cur !== '') out.push(cur);
    return q !== '' ? null : out;
  }
  function parseMcpKv(text) {
    var pairs = {};
    var lines = String(text ?? '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line === '') continue;
      var eq = line.indexOf('=');
      if (eq <= 0) return { error: '环境变量/请求头行须为 KEY=VALUE：' + line };
      pairs[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return { pairs: pairs };
  }
  function buildMcpSpec(d) {
    var timeoutOf = function (spec) {
      if (d.timeout.trim() === '') return null;
      var s = Number(d.timeout);
      if (!Number.isFinite(s) || s <= 0) return '超时须为正数（秒）';
      spec.timeoutMs = Math.round(s * 1000);
      return null;
    };
    if (d.transport === 'stdio') {
      var parts = splitMcpCmd(d.cmd.trim());
      if (parts === null) return { error: '命令行引号未闭合' };
      if (parts.length === 0) return { error: '命令必填' };
      var env = parseMcpKv(d.env);
      if (env.error) return env;
      var spec = { command: parts[0] };
      if (parts.length > 1) spec.args = parts.slice(1);
      if (Object.keys(env.pairs).length > 0) spec.env = env.pairs;
      if (d.cwd.trim() !== '') spec.cwd = d.cwd.trim();
      var te = timeoutOf(spec);
      if (te) return { error: te };
      return { spec: spec };
    }
    if (!/^https?:\/\//i.test(d.cmd.trim())) return { error: 'URL 须以 http:// 或 https:// 开头' };
    var env2 = parseMcpKv(d.env);
    if (env2.error) return env2;
    var hd = parseMcpKv(d.headers);
    if (hd.error) return hd;
    var spec2 = { url: d.cmd.trim() };
    if (d.transport === 'sse') spec2.transport = 'sse';
    if (Object.keys(hd.pairs).length > 0) spec2.headers = hd.pairs;
    if (Object.keys(env2.pairs).length > 0) spec2.env = env2.pairs;
    var te2 = timeoutOf(spec2);
    if (te2) return { error: te2 };
    return { spec: spec2 };
  }
  function parseMcpJson(text) {
    var o;
    try { o = JSON.parse(text); } catch { return { error: 'JSON 解析失败' }; }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return { error: 'JSON 须为对象' };
    if (o.mcpServers !== undefined) {
      if (o.mcpServers === null || typeof o.mcpServers !== 'object' || Array.isArray(o.mcpServers)) return { error: 'mcpServers 须为对象' };
      o = o.mcpServers;
    }
    var names = Object.keys(o).filter(function (k) { return o[k] !== null && typeof o[k] === 'object'; });
    if (names.length === 0) return { error: '缺少 server 条目' };
    if (names.length > 1) return { error: '一次只接受一个 server（收到 ' + names.length + ' 个：' + names.slice(0, 3).join('、') + '）' };
    var name = names[0];
    var entry = o[name];
    var hasCmd = typeof entry.command === 'string' && entry.command !== '';
    var hasUrl = typeof entry.url === 'string' && entry.url !== '';
    if (!hasCmd && !hasUrl) return { error: 'server 条目缺 command 或 url' };
    var spec = {};
    if (hasUrl) spec.url = entry.url;
    else {
      spec.command = entry.command;
      if (Array.isArray(entry.args) && entry.args.every(function (x) { return typeof x === 'string'; })) spec.args = entry.args;
    }
    if (entry.transport === 'sse') spec.transport = 'sse';
    ['env', 'headers'].forEach(function (k) {
      var v = entry[k];
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return;
      var p = {};
      Object.keys(v).forEach(function (kk) { if (typeof v[kk] === 'string') p[kk] = v[kk]; });
      if (Object.keys(p).length > 0) spec[k] = p;
    });
    if (typeof entry.cwd === 'string') spec.cwd = entry.cwd;
    if (typeof entry.timeoutMs === 'number' && entry.timeoutMs > 0) spec.timeoutMs = entry.timeoutMs;
    return { name: name, spec: spec };
  }
  function draftToJsonText(d) {
    var body = d.transport === 'stdio'
      ? Object.assign({ command: d.cmd.split(' ')[0] ?? '' }, d.cmd.indexOf(' ') >= 0 ? { args: d.cmd.split(' ').slice(1) } : {})
      : Object.assign({ url: d.cmd }, d.transport === 'sse' ? { transport: 'sse' } : {});
    var env = parseMcpKv(d.env).pairs;
    if (Object.keys(env).length > 0) body.env = env;
    if (d.transport === 'stdio' && d.cwd !== '') body.cwd = d.cwd;
    if (d.timeout !== '') { var n = Number(d.timeout); if (Number.isFinite(n) && n > 0) body.timeoutMs = Math.round(n * 1000); }
    var name = d.name.trim() === '' ? 'my-server' : d.name.trim();
    var servers = {};
    servers[name] = body;
    return JSON.stringify({ mcpServers: servers }, null, 2);
  }
  function applyJsonToDraft(parsed, d) {
    d.name = parsed.name;
    if (typeof parsed.spec.url === 'string') {
      d.cmd = parsed.spec.url;
      d.transport = parsed.spec.transport === 'sse' ? 'sse' : 'http';
    } else {
      d.transport = 'stdio';
      d.cmd = [parsed.spec.command ?? ''].concat(Array.isArray(parsed.spec.args) ? parsed.spec.args : []).join(' ').trim();
    }
    d.env = Object.keys(parsed.spec.env ?? {}).map(function (k) { return k + '=' + parsed.spec.env[k]; }).join('\n');
    d.headers = Object.keys(parsed.spec.headers ?? {}).map(function (k) { return k + '=' + parsed.spec.headers[k]; }).join('\n');
    d.cwd = typeof parsed.spec.cwd === 'string' ? parsed.spec.cwd : '';
    d.timeout = typeof parsed.spec.timeoutMs === 'number' ? String(Math.round(parsed.spec.timeoutMs / 1000)) : '';
  }



  /* ── F7 记忆（原型 v2：swRow 双开关 + 记忆导入卡——检索 → 勾选 → 导入；数据口 = GET 富 sources
   *    + POST /import {ids, organize, mode}——与 TUI runMemoryImportChoose 执行段同口径） ── */
  var MEM_IMPORT = { sources: null, scope: 'current', polish: false, busy: false }; /* 跨页缓存：翻设置页不重复检索 */
  function swRowHtml(label, desc, on, k, v) {
    return '<div class="sp-swrow" data-k="' + k + '" data-v="' + esc(v) + '"><span class="sw-txt"><span class="sw-name">' + esc(label) + '</span><span class="sw-sub">' + esc(desc) + '</span></span>' +
      '<button class="mc-toggle' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '" aria-label="' + esc(label) + '"></button></div>';
  }
  /** 导入结果人话（peers-settings memoryImportResultText 的 web 面——覆盖/跳过/镜像段拼装）。 */
  function memResultText(r) {
    var segs = [];
    if ((r.imported ?? 0) > 0) segs.push('导入 ' + r.imported + ' 条新记忆');
    if ((r.updated ?? 0) > 0) segs.push('更新覆盖 ' + r.updated + ' 条旧版');
    if ((r.skipped ?? 0) > 0) segs.push('源内同名跳过 ' + r.skipped + ' 条');
    if (segs.length === 0) segs.push('没有新记忆（同标题旧版已覆盖）');
    if (r.mirror) segs.push('镜像 ' + r.mirror.projects + ' 个项目' + (r.mirror.unresolved > 0 ? '（未归类 ' + r.mirror.unresolved + ' 条）' : ''));
    return segs.join(' · ') + (MEM_IMPORT.polish ? '（含模型整理）' : '');
  }
  function memRowHtml(s) {
    var cnt = s.imported
      ? '<span class="mc-count"><span class="ok">✓ 已导入 ' + s.count + ' 条</span></span>'
      : '<span class="mc-count">' + s.count + ' 条 · ' + ((s.newCount ?? 0) > 0 ? '<span class="new">新 ' + s.newCount + '</span>' : '<span class="zero">新 0</span>') + '</span>';
    return '<div class="mc-row' + (s.imported ? ' done' : '') + '" data-agent="' + esc(s.id) + '">' +
      '<input type="checkbox" class="mc-cb" data-cb="' + esc(s.id) + '"' + (s.on ? ' checked' : '') + (s.imported ? ' disabled' : '') + ' aria-label="选择 ' + esc(s.label) + '">' +
      '<span class="mc-agent">' + esc(s.label) + '</span>' +
      (s.global ? '<span class="mc-glob">全局</span>' : '') +
      '<span class="mc-path" title="' + esc(s.dir ?? '') + '">' + esc(s.dir ?? '') + '</span>' + cnt +
      '<button class="mc-one" data-one="' + esc(s.id) + '"' + (s.imported || MEM_IMPORT.busy ? ' disabled' : '') + '>' + (s.imported ? '已导入' : '导入该源') + '</button></div>';
  }
  function memCardHtml() {
    var mi = MEM_IMPORT;
    var srcs = mi.sources;
    var scanning = srcs === null;
    var status = scanning
      ? '<span class="mc-spin"></span> 正在检索 Claude Code / ZCode / qwen / codex / Reasonix…'
      : '<span class="ok">✓</span> 已检索 5 家常用 agent · 发现 ' + (srcs ?? []).length + ' 个记忆源';
    var list = scanning
      ? '<div class="mc-empty"><span class="mc-spin mc-spin-inline"></span>正在枚举各 agent 的记忆条目…</div>'
      : ((srcs ?? []).length ? (srcs ?? []).map(memRowHtml).join('') : '<div class="mc-empty">本机没有检测到可导入的记忆</div>');
    var sel = (srcs ?? []).filter(function (s) { return s.on && !s.imported; });
    var selTotal = sel.reduce(function (n, s) { return n + s.count; }, 0);
    var selNew = sel.reduce(function (n, s) { return n + (s.newCount ?? 0); }, 0);
    var allOn = (srcs ?? []).length > 0 && (srcs ?? []).every(function (s) { return s.on || s.imported; });
    return '<div class="mem-card">' +
      '<div class="mc-head"><span class="mc-title">记忆导入</span><span class="mc-status">' + status + '</span>' +
      '<button class="mc-refresh" data-k="mc-refresh">重新检索</button></div>' +
      '<div id="mc-list">' + list + '</div>' +
      '<div class="mc-opts">' +
      '<div class="mc-opt"><span class="mc-opt-label">导入范围</span><span class="mc-seg">' +
      '<button class="seg' + (mi.scope === 'current' ? ' cur' : '') + '" data-k="mc-scope" data-v="current">仅当前项目</button>' +
      '<button class="seg' + (mi.scope === 'all' ? ' cur' : '') + '" data-k="mc-scope" data-v="all">全部项目（各归各桶）</button></span></div>' +
      '<div class="mc-opt"><span class="mc-opt-label">用模型整理</span>' +
      '<button class="mc-toggle' + (mi.polish ? ' on' : '') + '" data-k="mc-polish" role="switch" aria-checked="' + mi.polish + '" aria-label="用模型整理"></button>' +
      '<span class="mc-opt-hint">逐条优化内容 + 重写摘要 + 英文短题，消耗 token 一次性；开启后所有导入路径都走整理</span></div>' +
      '</div>' +
      '<div class="mc-foot"><label class="mc-all"><input type="checkbox" class="mc-cb" data-k="mc-all"' + (allOn ? ' checked' : '') + '> 全选</label>' +
      '<span class="mc-sum">已选 ' + sel.length + ' 个来源 · 共 ' + selTotal + ' 条 · 新 ' + selNew + '</span>' +
      '<button class="btn primary" data-k="mc-import"' + (sel.length === 0 || mi.busy ? ' disabled' : '') + '>' + (mi.busy ? '导入中…' : '导入选中') + '</button></div>' +
      '<div class="mc-note">重复导入将覆盖同标题旧版 · 导入本身不耗 token（开启「用模型整理」除外）</div>' +
      '</div>';
  }
  /** 卡片直绑（原型 bindMemCard 同构——每次 outerHTML 换装后重绑；双开关仍走 setPageHandler 委派）。 */
  function bindMemCard(page) {
    var card = page.querySelector('.mem-card');
    if (!card) return;
    var refresh = function () { var c = page.querySelector('.mem-card'); if (c) { c.outerHTML = memCardHtml(); bindMemCard(page); } };
    card.querySelector('[data-k="mc-refresh"]').addEventListener('click', function () {
      MEM_IMPORT.sources = null; /* 回扫描态（转圈） */
      refresh();
      A.fetchJson('/api/settings/memory').then(function (d) {
        MEM_IMPORT.sources = (d.sources ?? []).map(function (s) { return { id: s.id, label: s.label, dir: s.dir, count: s.count, newCount: s.newCount, global: s.global, on: true, imported: false }; });
        refresh();
      }, function (err) { toast('检索失败：' + err.message); refresh(); });
    });
    card.querySelectorAll('.mc-cb[data-cb]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var s = (MEM_IMPORT.sources ?? []).find(function (x) { return x.id === cb.getAttribute('data-cb'); });
        if (s) s.on = cb.checked;
        refresh();
      });
    });
    card.querySelectorAll('.mc-row').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('.mc-one') || e.target.closest('.mc-cb')) return;
        var cb = row.querySelector('.mc-cb');
        if (cb && !cb.disabled) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
      });
    });
    card.querySelector('[data-k="mc-all"]').addEventListener('change', function () {
      var on = this.checked;
      (MEM_IMPORT.sources ?? []).forEach(function (s) { if (!s.imported) s.on = on; });
      refresh();
    });
    card.querySelectorAll('[data-k="mc-scope"]').forEach(function (seg) {
      seg.addEventListener('click', function () {
        MEM_IMPORT.scope = seg.getAttribute('data-v');
        refresh();
        toast('导入范围：' + (MEM_IMPORT.scope === 'all' ? '全部项目（各归各桶）' : '仅当前项目'));
      });
    });
    card.querySelector('[data-k="mc-polish"]').addEventListener('click', function () {
      MEM_IMPORT.polish = !MEM_IMPORT.polish;
      refresh();
      toast('用模型整理：' + (MEM_IMPORT.polish ? '开（导入时逐条整理，一次性消耗 token）' : '关'));
    });
    card.querySelectorAll('[data-one]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        memImport(page, [btn.getAttribute('data-one')]);
      });
    });
    card.querySelector('[data-k="mc-import"]').addEventListener('click', function () {
      var ids = (MEM_IMPORT.sources ?? []).filter(function (s) { return s.on && !s.imported; }).map(function (s) { return s.id; });
      memImport(page, ids);
    });
  }
  /** 执行导入（单源/勾选集同口）：POST {ids, organize, mode} → 标已导 + 人话 toast + 静默重取计数。 */
  function memImport(page, ids) {
    var mi = MEM_IMPORT;
    if (mi.busy || ids.length === 0) return;
    mi.busy = true;
    var redraw = function () { var c = page.querySelector('.mem-card'); if (c) { c.outerHTML = memCardHtml(); bindMemCard(page); } };
    redraw();
    A.fetchJson('/api/settings/memory/import', { method: 'POST', body: JSON.stringify({ ids: ids, organize: mi.polish, mode: mi.scope }) }).then(function (r) {
      mi.busy = false;
      ids.forEach(function (id) { var s = (mi.sources ?? []).find(function (x) { return x.id === id; }); if (s) s.imported = true; });
      toast(memResultText(r));
      /* 静默重取计数（newCount 归零实况）——保留 imported 标 */
      A.fetchJson('/api/settings/memory').then(function (d) {
        (d.sources ?? []).forEach(function (f) {
          var s = (mi.sources ?? []).find(function (x) { return x.id === f.id; });
          if (s) { s.count = f.count; s.newCount = f.newCount; }
        });
        redraw();
      }, function () { redraw(); });
    }, function (err) {
      mi.busy = false;
      toast('导入失败：' + err.message);
      redraw();
    });
  }
  function pageMemory(page) {
    pageLoading(page);
    A.fetchJson('/api/settings/memory').then(function (d) {
      var ws = !!d.workspaceMemory;
      var peers = !!d.sessionPeers;
      MEM_IMPORT.sources = (d.sources ?? []).map(function (s) { return { id: s.id, label: s.label, dir: s.dir, count: s.count, newCount: s.newCount, global: s.global, on: true, imported: false }; });
      renderMemPage(page, ws, peers);
    }, function (err) { pageLoadError(page, err); });
  }
  function renderMemPage(page, ws, peers) {
    page.innerHTML = spTitle('记忆', 'MEMORY · tool-peers') +
      swRowHtml('工作区记忆', '共享笔记 + 索引注入：本会话写、其他会话读；开启后系统提示带记忆索引，有 token 消耗', ws, 'mem', 'ws') +
      swRowHtml('会话感知', '查同伴 / 文件占用：peers 查询对每个活会话按需做一句话总结，有 token 消耗', peers, 'mem', 'peers') +
      memCardHtml() +
      '<div class="sp-note">浏览窗在 更多 ▸ 模块总览（tool-peers 启动器）。</div>';
    setPageHandler = function (e) {
      if (e.target.closest('[data-v="ws"]')) {
        A.fetchJson('/api/settings/memory', { method: 'POST', body: JSON.stringify({ key: 'workspaceMemory', value: !ws }) }).then(function () {
          toast('工作区记忆：' + (!ws ? '开' : '关') + '（已写 [tool-peers] workspaceMemory）');
          renderMemPage(page, !ws, peers);
        }, function (err) { toast('设置失败：' + err.message); });
      } else if (e.target.closest('[data-v="peers"]')) {
        A.fetchJson('/api/settings/memory', { method: 'POST', body: JSON.stringify({ key: 'sessionPeers', value: !peers }) }).then(function () {
          toast('会话感知：' + (!peers ? '开' : '关') + '（已写 [tool-peers] sessionPeers）');
          renderMemPage(page, ws, !peers);
        }, function (err) { toast('设置失败：' + err.message); });
      }
    };
    bindMemCard(page);
  }

  /* ── F1b 外观（原型 v2：主题卡 + 明暗 + 整体字号 + 语言——原「切换语言」页并入；语言写 config
   *    会话侧即时生效，页面自身不切〔web 中文直写〕；FONT_SCALES/applyFontScale/applyTheme 在顶栏
   *    主题区块同位声明——boot 与本页共用）。 ── */
  var LANG_EN = { 'zh-CN': 'Chinese Simplified', 'zh-TW': 'Chinese Traditional', 'en-US': 'English', en: 'English', ja: 'Japanese', ko: 'Korean', de: 'German', fr: 'French', es: 'Spanish' };
  function langRowHtml(l, cur, pack) {
    return '<div class="ap-lang' + (cur ? ' cur' : '') + ' ap-fade" data-k="ap-lang" data-v="' + esc(l.tag) + '" role="radio" aria-checked="' + cur + '">' +
      '<span class="ap-radio"></span>' +
      '<span class="al-txt"><span class="al-native">' + esc(l.label) + '</span><span class="al-label">' + esc(LANG_EN[l.tag] ?? l.tag) + '</span></span>' +
      (pack ? '<span class="al-tag pack">语言包</span>' : '<span class="al-tag">内置</span>') +
      (cur ? '<span class="al-cur">当前</span>' : '') + '</div>';
  }
  function pageAppearance(page) {
    pageLoading(page);
    A.fetchJson('/api/settings/locale').then(function (d) {
      var current = String(d.current ?? '');
      var locales = d.locales ?? [];
      var builtins = locales.filter(function (l) { return !l.module; });
      var packs = locales.filter(function (l) { return !!l.module; });
      var light = document.body.classList.contains('light');
      var fs = fontScaleIdx;
      page.innerHTML = spTitle('外观', 'APPEARANCE') +
        subHeadT('主题', 1) +
        '<div class="ap-themes">' +
          '<div class="ap-theme cur"><span class="at-prev"><span class="half d"><i></i></span><span class="half l"><i></i></span></span>' +
          '<span class="at-name">连山<span class="at-en">LIANSHAN</span><span class="at-cur">当前主题</span></span>' +
          '<span class="at-desc">每个主题含深色 / 浅色两套模式——用下方「明暗模式」切换</span></div>' +
          '<div class="ap-theme ghost">更多主题即将到来</div>' +
        '</div>' +
        subHeadT('明暗模式', 1) +
        '<div class="sp-swrow static"><span class="sw-txt"><span class="sw-name">界面明暗</span>' +
          '<span class="sw-sub">与主界面右上角 ☀ / ☾ 按钮联动，即时生效并记忆</span></span>' +
          '<span class="mc-seg">' +
          '<button class="seg' + (!light ? ' cur' : '') + '" data-k="ap-mode" data-v="dark">深色</button>' +
          '<button class="seg' + (light ? ' cur' : '') + '" data-k="ap-mode" data-v="light">浅色</button>' +
          '</span></div>' +
        subHeadT('整体字号', 1) +
        '<div class="sp-swrow static"><span class="sw-txt"><span class="sw-name">界面字号</span>' +
          '<span class="sw-sub" id="ap-fs-sub">当前：' + FONT_SCALES[fs].name + '（' + Math.round(FONT_SCALES[fs].scale * 100) + '%）· 仅放大界面文字——框架与布局尺寸不变</span></span>' +
          '<span class="mc-seg">' + FONT_SCALES.map(function (f, i) {
            return '<button class="seg' + (i === fs ? ' cur' : '') + '" data-k="ap-scale" data-v="' + i + '">' + f.name + '</button>';
          }).join('') + '</span></div>' +
        subHeadT('语言', 1) +
        '<div id="ap-langs">' +
        (current === '' ? '<div class="ap-lang cur" data-k="ap-lang" data-v="" role="radio" aria-checked="true"><span class="ap-radio"></span><span class="al-txt"><span class="al-native">随系统</span><span class="al-label">跟随操作系统语言</span></span><span class="al-cur">当前</span></div>' : '') +
        builtins.map(function (l) { return langRowHtml(l, current === l.tag, false); }).join('') +
        '</div>' +
        (packs.length > 0 ? '<div id="ap-langpack">' + packs.map(function (l) { return langRowHtml(l, current === l.tag, true); }).join('') + '</div>' : '') +
        '<div class="sp-note">切换写入 config 即时生效（会话侧 t() 与新会话）——页面自身不切语言；语言包由 multilang 模块挂载后在此列出。</div>';
      setPageHandler = function (e) {
        var t;
        if ((t = e.target.closest('[data-k="ap-mode"]'))) {
          var toLight = t.getAttribute('data-v') === 'light';
          if (toLight !== document.body.classList.contains('light')) {
            applyTheme(toLight);
            toast(toLight ? '已切换浅色模式——连山 · 宣纸' : '已切换深色模式——连山 · 玄墨');
          }
          var seg1 = t.parentNode.querySelectorAll('.seg');
          seg1.forEach(function (s) { s.classList.toggle('cur', s === t); });
          return;
        }
        if ((t = e.target.closest('[data-k="ap-scale"]'))) {
          var i = parseInt(t.getAttribute('data-v'), 10);
          var changed = i !== fontScaleIdx;
          applyFontScale(i);
          t.parentNode.querySelectorAll('.seg').forEach(function (s) { s.classList.toggle('cur', s === t); });
          var sub = page.querySelector('#ap-fs-sub');
          if (sub) sub.textContent = '当前：' + FONT_SCALES[i].name + '（' + Math.round(FONT_SCALES[i].scale * 100) + '%）· 仅放大界面文字——框架与布局尺寸不变';
          if (changed) toast('字号已调整为「' + FONT_SCALES[i].name + '」（' + Math.round(FONT_SCALES[i].scale * 100) + '%）');
          return;
        }
        if ((t = e.target.closest('[data-k="ap-lang"]'))) {
          var tag = t.getAttribute('data-v');
          if (tag === current) { toast('当前已是该语言'); return; }
          A.fetchJson('/api/settings/locale', { method: 'POST', body: JSON.stringify({ tag: tag }) }).then(function () {
            toast('语言已切换（已写入 config，新会话生效）——页面自身不切语言');
            pageAppearance(page);
          }, function (err) { toast(err.status === 409 ? '暂无当前会话——语言切换需要会话承载（先新建或选择一个会话）' : '切换失败：' + err.message); });
        }
      };
    }, function (err) { pageLoadError(page, err); });
  }

  /* ── F9 更新检查（GET/POST /api/settings/update——[update] check 开关，下次启动生效） ── */
  function pageUpdate(page) {
    pageLoading(page);
    A.fetchJson('/api/settings/update').then(function (d) {
      var enabled = !!d.enabled;
      page.innerHTML = spTitle('更新检查', 'UPDATE') +
        optRow('开（启动时自动检测新版本）', '', enabled, 'update', '1') +
        optRow('关（不联网检测；orosus upgrade 手动口不受影响）', '', !enabled, 'update', '0') +
        '<div class="sp-note">当前版本 ' + esc(String(d.current ?? '?')) + (d.latest ? ' · 已知最新 ' + esc(String(d.latest)) : '') + '——开关写盘下次启动生效。</div>';
      setPageHandler = function (e) {
        var row = e.target.closest('[data-k="update"]');
        if (!row) return;
        var v = row.getAttribute('data-v') === '1';
        A.fetchJson('/api/settings/update', { method: 'POST', body: JSON.stringify({ enabled: v }) }).then(function () {
          toast(v ? '已开启更新检查——下次启动生效' : '已关闭更新检查——横幅与自动检测停用，orosus upgrade 仍可用');
          renderSetPage(9); /* 更新检查页（外观插位后 8→9） */
        }, function (err) { toast('设置失败：' + err.message); });
      };
    }, function (err) { pageLoadError(page, err); });
  }

  /* ── F10 已归档的会话（GET /api/archived + POST unarchive；排序/筛选/分组 = OrosusArchived 纯函数） ── */
  var arState = { q: '', ws: '', sort: 'archived' };
  var arData = [];
  function pageArchived(page) {
    pageLoading(page);
    A.fetchJson('/api/archived').then(function (d) {
      arData = d.items ?? [];
      renderArchivedPage(page);
    }, function (err) { pageLoadError(page, err); });
  }
  function renderArchivedPage(page) {
    var wsList = [];
    arData.forEach(function (a) { if (a.cwd && !wsList.includes(a.cwd)) wsList.push(a.cwd); });
    var groups = AV.archivedView(arData, arState);
    var body = '<div class="ar-tools">' +
      '<input class="fi" id="ar-q" placeholder="搜索已归档会话" value="' + esc(arState.q) + '" />' +
      '<select class="fsel" id="ar-ws"><option value="">所有工作区</option>' + wsList.map(function (w) {
        var nm = w.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || w;
        return '<option' + (arState.ws === w ? ' selected' : '') + ' value="' + esc(w) + '">' + esc(nm) + '</option>';
      }).join('') + '</select>' +
      '<span class="ar-sort">' +
        '<button data-ar-sort="archived" class="' + (arState.sort === 'archived' ? 'sel' : '') + '">归档时间</button>' +
        '<button data-ar-sort="created" class="' + (arState.sort === 'created' ? 'sel' : '') + '">创建时间</button>' +
        '<button data-ar-sort="alpha" class="' + (arState.sort === 'alpha' ? 'sel' : '') + '">按字母顺序</button>' +
      '</span></div>';
    if (groups.length === 0) {
      body += '<div class="sp-note">（没有匹配的已归档会话——归档入口：会话行悬停归档钮 / 右键菜单）</div>';
    }
    groups.forEach(function (g) {
      body += '<div class="ar-group" title="' + esc(g.key) + '"><span>📁 ' + esc(g.name || g.key) + '</span><span class="ar-count">' + g.items.length + ' 个会话</span></div>';
      g.items.forEach(function (a) {
        var title = a.title !== '' ? a.title : '（未命名会话）';
        body += '<div class="ar-card"><span><span class="ar-title">' + esc(title) + '</span><br/><span class="ar-time">归档 ' + esc(fmtDateTime(a.archivedAt)) + ' · 创建 ' + esc(fmtDateTime(a.createdAt)) + '</span></span><button class="btn ar-restore" data-ar="' + esc(a.sid) + '">↩ 恢复</button></div>';
      });
    });
    page.innerHTML = spTitle('已归档的会话', 'ARCHIVED') +
      '<div class="sp-note">查看已归档会话，确认其所属工作区路径、会话名称和归档时间，并可恢复到会话列表（其工作区若已被移除将一并找回）。</div>' + body;
    var q = page.querySelector('#ar-q');
    q.addEventListener('input', function () {
      arState.q = q.value;
      var pos = q.selectionStart;
      renderArchivedPage(page);
      var q2 = page.querySelector('#ar-q');
      q2.focus();
      q2.setSelectionRange(pos ?? q2.value.length, pos ?? q2.value.length);
    });
    page.querySelector('#ar-ws').addEventListener('change', function () { arState.ws = this.value; renderArchivedPage(page); });
    setPageHandler = function (e) {
      var sort = e.target.closest('[data-ar-sort]');
      if (sort) { arState.sort = sort.getAttribute('data-ar-sort'); renderArchivedPage(page); return; }
      var card = e.target.closest('[data-ar]');
      if (card) {
        var sid = card.getAttribute('data-ar');
        var a = arData.find(function (x) { return x.sid === sid; });
        if (!a) return;
        A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/unarchive', { method: 'POST', body: '{}' }).then(function () {
          toast('已恢复「' + (a.title !== '' ? a.title : '未命名会话') + '」到会话列表');
          arData = arData.filter(function (x) { return x.sid !== sid; });
          void pollSessions(); /* 左栏即时出新（server 侧已同步 unhide——恢复即找回） */
          renderArchivedPage(page);
        }, function (err) { toast('恢复失败：' + err.message); });
      }
    };
  }

  /* ═══════════ 帮助弹窗（A6：helpText 分区结构 + web 界面操作段；键位表 = web 版） ═══════════ */
  function openHelpModal() {
    UI.closePopup();
    modalClose();
    var secs = [
      ['CLI 命令（会话生命周期）', [
        ['/new', '开始新会话（历史会话走左侧会话栏）'],
        ['/fork', '从当前会话分叉'],
        ['/title', '给会话命名（别名 /rename；引号可选；无参不做任何事）'],
        ['/quit', '关闭当前会话（别名 /exit /q——web 下 server 常驻，仅关会话不退进程）'],
        ['/settings · /sessions', 'web 走界面（⚙ 设置 / 左栏会话列表）——键入报未知命令'],
      ]],
      ['内建命令（模型与状态）', [
        ['/model', '切换当前模型（先平台再模型；同窗横选思考档位；回答进行中也可执行，下一轮生效）'],
        ['/effort', '思考投入档位（档位来自模型目录声明）'],
        ['/reload', '重新加载模块配置'],
        ['/help', '显示此帮助'],
        ['/btw', '旁路侧问选项卡——多轮追问、可读文件查证、只感知主对话'],
      ]],
      ['模块命令', [
        ['/compact', '手动压缩对话历史（摘要查看口 = 顶栏「更多 ▸ 压缩摘要」）'],
        ['/yolo · /auto', '快捷档：需要时候询问 / 从不询问（权限档走输入框 ◆ 芯片小弹窗）'],
      ]],
      ['信息面板', [
        ['/tasks', '打开右侧分栏，为每个子代理开一个选项卡'],
        ['/ps', '本项目活跃会话（谁在跑、谁等审批、谁闲着）'],
      ]],
      ['技能（四轨目录：~/.agents/skills → ~/.orosus/skills → 项目 .agents/skills → 项目 .orosus/skills）', [
        ['输入 /', '斜杠菜单技能区殿后于命令（skill : 名）；点击 = 加载该技能（正文注入模型上下文，流区留单行标记）'],
        ['设置 → 技能', '全部技能列表（含已停用）→ 详情（名称/描述/范围/状态/文件），可启停'],
      ]],
      ['钩子（七事件生命周期 shell 命令）', [
        ['设置 → 钩子', '全部钩子列表（用户级/项目级分节）→ 详情启停；项目层须信任审查'],
        ['更多 ▸ 钩子注入', '本会话钩子注入条目列表（TUI 的 Ctrl+H——浏览器键位冲突，故入顶栏）'],
      ]],
      ['界面与鼠标操作（web 版）', [
        ['左侧会话栏', '顶部「＋ 新会话」；置顶（行悬停 📌，有置顶才显「已置顶」区）与项目分组；当前会话青玉高亮「当前」；顶部 ⇤ 收起为窄轨'],
        ['会话行', '悬停出 置顶/归档 图标钮；右键 = 分叉/置顶/归档/重命名/复制 ID/导出/删除（删除均有确认弹窗）；每组最多 5 条，「∨ 展开更多」每次多 5 条'],
        ['会话行状态', '进行中显示圆弧转圈动画；完成后未选中 → 绿点（待读）/ 红点（失败），选中即消；红绿点持久化——退服务重开仍在'],
        ['右侧状态栏', '页签点击切卡；右上角 ⇥ 收起为窄轨（窄轨上 ⇤ 展开）'],
        ['顶栏红色「更新」', '有新版本的升级提示（非刷新列表）——查看更新内容 / 立即升级'],
        ['设置', '居中双栏十页：常规 / 提供商与模型 / 模型偏好 / 技能 / 钩子 / MCP / 记忆 / 语言 / 更新检查 / 已归档的会话'],
        ['帮助 / 更多', '居中弹窗；子项下钻后「‹ 返回」逐级回退，Esc 同效'],
        ['顶栏 ☀/☾', '浅色（宣纸系）/ 深色（玄墨系）主题切换，记忆选择'],
        ['输入框（多行）', '按钮全部在框内：左下 文件+权限，右下 模型/思考/发送键；最多 6 行文字（超出框内滚动）'],
        ['输入框左上 📁', '切换工作目录——仅空会话可切（已有消息时锁定）'],
        ['流区分页', '消息过多时顶部出现「↑ 加载更早消息」，点击逐页展开'],
        ['用户消息气泡', '居右、宽 ≤80%；超过 5 行半自动收拢可展开；悬停出「⧉ 复制」（✎ 编辑钮已隐藏——撤回能力未落地）；图片方形预览（64×64，最多 6 张）'],
        ['完成的任务', '悬停所在轮出「⧉ 复制 / ⑂ 分支」+ 完成时间；生成中显示「工作中 N 秒」'],
        ['思考块 / diff', '点击块头部或「还有 N 行」展开收起'],
        ['模块行', '点击挂载/卸载；锁定行点按显示原因'],
        ['MCP 连接行', '失败点击重连；「未确认」点击进设置审阅指纹'],
        ['浮层', '悬停选中（详释区联动）、点击确认、✕ 或 Esc 关闭'],
        ['已知边界', 'MCP 项目 .mcp.json 仅对 server 启动目录生效（全局 modules.d/mcp.toml 全项目可用）；/quit = 关闭当前会话（server 常驻）；语言切换作用于会话侧（页面文案一期中文）；同一会话多标签打开时队列与审批共享（先到先得）'],
      ]],
      ['快捷键', [
        ['Enter', '发送；回答进行中 = 排队（输入框上方显示队列，结束后依序发出）'],
        ['Shift + Enter', '输入框内换行'],
        ['Ctrl + V', '粘贴图片——预览条在输入框上方（点 × 撤销），随下一条消息发送'],
        ['Esc', '弹窗逐级返回 / 关浮层；回答进行中双击停止生成与全部子代理'],
        ['/', '行首唤起命令菜单（继续输入过滤；技能区一并过滤）'],
        ['@', '唤起文件引用菜单（点击插入路径）'],
      ]],
    ];
    var h = '';
    secs.forEach(function (sec) {
      h += '<div class="help-sec">' + esc(sec[0]) + '</div>';
      sec[1].forEach(function (r) {
        h += '<div class="help-row"><span class="help-key">' + esc(r[0]) + '</span><span class="help-desc">' + esc(r[1]) + '</span></div>';
      });
    });
    openModal({
      title: '帮助',
      en: 'HELP',
      bodyHtml: '<div class="pu-text"><div class="help help-inline">' + h + '</div></div>',
      foot: '滚动查看 · Esc 关闭',
    });
  }

  /* ═══════════ ⋮ 更多四窗（A7：诊断/总览/注入分桶/压缩摘要——T14 端点） ═══════════ */
  function moreRow(label, desc, key) {
    return '<div class="pu-item" data-mor="' + key + '"><span class="pu-caret">❯</span><span class="pi-name">' + esc(label) + '</span><span class="pi-desc">' + esc(desc) + '</span></div>';
  }
  function openMoreMenu() {
    UI.closePopup();
    modalClose();
    openModal({
      title: '更多功能',
      en: 'TUI 全局键的 web 入口',
      bodyHtml: moreRow('模块诊断', '本会话出过问题的模块（TUI Ctrl+E）', 'diag') +
        moreRow('模块总览', '带界面模块的启动器（TUI Ctrl+P）', 'launcher') +
        moreRow('钩子注入查看', '本会话钩子注入条目（TUI Ctrl+H）', 'hooks') +
        moreRow('压缩摘要', '最近一次压缩的交接摘要（TUI Ctrl+O）', 'compact'),
      foot: '点击下钻 · Esc 返回',
      onClick: function (e) {
        var row = e.target.closest('[data-mor]');
        if (!row) return;
        var k = row.getAttribute('data-mor');
        if (k === 'diag') openDiagWindow();
        else if (k === 'launcher') openLauncherWindow();
        else if (k === 'hooks') openHookActivityWindow();
        else openCompactWindow();
      },
    });
  }
  /** 模块诊断（GET /api/diagnostics——audit() failed 行〔图现态非历史〕+ logDir 指路）。 */
  function openDiagWindow() {
    openModal({ title: '模块诊断', en: 'DIAGNOSTICS', bodyHtml: '<div class="sp-note">加载中…</div>' });
    A.fetchJson('/api/diagnostics').then(function (d) {
      var rows = d.rows ?? [];
      if (rows.length === 0) {
        modalReplace({ title: '模块诊断', en: 'ALL GOOD', bodyHtml: '<div class="pu-text"><span class="ok">✓ 没有出过问题的模块</span>\n\n<span class="dim">诊断面板显示模块图当前状态（挂载/校验失败的模块）；历史日志见 ' + esc(String(d.logDir ?? '')) + '</span></div>', foot: 'Esc 返回' });
        return;
      }
      modalReplace({
        title: '模块诊断',
        en: rows.length + ' 个模块出过问题',
        bodyHtml: rows.map(function (r) {
          return '<div class="pu-item" data-diag="' + esc(r.name) + '"><span class="pu-caret">❯</span><span class="st-err">●</span> <span class="pi-name">' + esc(r.name) + '</span> <span class="pi-desc">' + esc(r.failReason ?? '') + '</span></div>';
        }).join(''),
        foot: '点击进详情 · Esc 返回',
        onClick: function (e) {
          var row = e.target.closest('[data-diag]');
          if (!row) return;
          var r = rows.find(function (x) { return x.name === row.getAttribute('data-diag'); });
          if (!r) return;
          openModal({
            title: '模块诊断 · ' + r.name,
            en: 'DETAIL',
            bodyHtml: '<div class="pu-text">【失败原因】\n' + esc(r.failReason ?? '（无明细）') + '\n\n【修复指引】\n· 检查模块配置与依赖后重试挂载（右栏模块行点击或 /reload）\n· 临时规避：重启进程（新进程按盘上配置干净激活）\n\n· 诊断日志目录：' + esc(String(d.logDir ?? '')) + '</div>',
            foot: '只读窗 · Esc 返回列表',
          });
        },
      });
    }, function (err) { modalReplace({ title: '模块诊断', en: 'ERROR', bodyHtml: '<div class="pu-text bad">加载失败：' + esc(err.message) + '</div>' }); });
  }
  /** 模块总览（GET /api/launchers——cards[].desc 是登记命令：主行「module —— 命令」+ title 说明〔T14
   *  裁定：desc 槽真实内容是命令，当主操作键直示；title 是人类可读名作说明行〕；点击 = 执行该命令）。 */
  function openLauncherWindow() {
    openModal({ title: '模块总览', en: 'LAUNCHERS', bodyHtml: '<div class="sp-note">加载中…</div>' });
    A.fetchJson('/api/launchers').then(function (d) {
      var cards = d.cards ?? [];
      if (cards.length === 0) {
        modalReplace({ title: '模块总览', en: 'LAUNCHERS', bodyHtml: '<div class="pu-text"><span class="dim">（没有带界面的模块在册——launcher 登记面走 collectLaunchers）</span></div>', foot: 'Esc 返回' });
        return;
      }
      modalReplace({
        title: '模块总览',
        en: cards.length + ' 个带界面模块',
        bodyHtml: cards.map(function (c) {
          return '<div class="pu-item" data-launch="' + esc(c.module) + '" title="点击执行 ' + esc(c.desc ?? '') + '"><span class="pu-caret">❯</span><span class="pi-name">' + esc(c.module) + (c.desc ? ' —— <span class="dim">' + esc(c.desc) + '</span>' : '') + '</span><span class="pi-desc">' + esc(c.title ?? '') + '</span></div>';
        }).join(''),
        foot: '点击执行启动命令 · Esc 返回',
        onClick: function (e) {
          var row = e.target.closest('[data-launch]');
          if (!row) return;
          var c = cards.find(function (x) { return x.module === row.getAttribute('data-launch'); });
          if (!c || !c.desc) return;
          modalClose();
          if (currentSid === null) { toast('暂无会话——启动器命令需要一个当前会话来执行'); return; }
          sendCommandText(c.desc);
          toast('已提交 ' + c.desc);
        },
      });
    }, function (err) { modalReplace({ title: '模块总览', en: 'ERROR', bodyHtml: '<div class="pu-text bad">加载失败：' + esc(err.message) + '</div>' }); });
  }
  /** 钩子注入分桶（GET /:sid/hooks-activity——buildHookBuckets 同源：userText/count/injections）。 */
  function openHookActivityWindow() {
    if (currentSid === null) { toast('暂无会话——钩子注入查看需要当前会话'); return; }
    openModal({ title: '钩子活动 · 按消息分组（选择下钻）', en: 'HOOKS', bodyHtml: '<div class="sp-note">加载中…</div>' });
    A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/hooks-activity').then(function (d) {
      var groups = d.groups ?? [];
      if (groups.length === 0) {
        modalReplace({ title: '钩子活动 · 按消息分组', en: 'EMPTY', bodyHtml: '<div class="pu-text"><span class="dim">（本会话还没有钩子活动——钩子在消息生命周期事件上运行，运行了且注入了内容才会出现在这里）</span></div>', foot: 'Esc 返回' });
        return;
      }
      modalReplace({
        title: '钩子活动 · 按消息分组（选择下钻）',
        en: groups.length + ' 组',
        bodyHtml: groups.map(function (g, i) {
          return '<div class="pu-item" data-hk="' + i + '"><span class="pu-caret">❯</span><span class="pi-name">' + esc(g.userText) + '</span><span class="pi-desc">' + g.count + ' 次钩子' + (g.injections && g.injections.length > 0 ? ' · ' + g.injections.length + ' 条注入' : '') + '</span></div>';
        }).join(''),
        foot: '点击看全文 · Esc 返回',
        onClick: function (e) {
          var row = e.target.closest('[data-hk]');
          if (!row) return;
          var g = groups[parseInt(row.getAttribute('data-hk'), 10)];
          if (!g) return;
          if (!g.injections || g.injections.length === 0) {
            toast('这条消息的钩子运行了但没有注入内容（拦截/失败/跳过——这里只看注入）');
            return;
          }
          openModal({
            title: '注入全文 · ' + g.count + ' 次钩子',
            en: 'INJECTIONS',
            bodyHtml: g.injections.map(function (tx) { return '<div class="pu-text md">' + UI.mdHtml(tx) + '</div>'; }).join('<hr class="side-sep" />'),
            foot: '滚动查看 · Esc 返回上一级',
          });
        },
      });
    }, function (err) { modalReplace({ title: '钩子活动', en: 'ERROR', bodyHtml: '<div class="pu-text bad">加载失败：' + esc(err.message) + '</div>' }); });
  }
  /** 压缩摘要（GET /:sid/compaction——末条 summary + 标量 stats；404 = 从未压缩）。 */
  function openCompactWindow() {
    if (currentSid === null) { toast('暂无会话——压缩摘要需要当前会话'); return; }
    A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/compaction').then(function (d) {
      var st = d.stats ?? {};
      var meta = [
        '时间：' + fmtDateTime(d.at ? Date.parse(d.at) : 0),
        st.trigger ? '触发：' + (st.trigger === 'manual' ? '手动 /compact' : st.trigger) : '',
        typeof st.keepUserHead === 'number' ? '保留用户消息 ' + st.keepUserHead + ' 条' : '',
        typeof st.elidedCount === 'number' ? '省略 ' + st.elidedCount + ' 条' : '',
        typeof st.droppedCount === 'number' ? '丢弃 ' + st.droppedCount + ' 条' : '',
      ].filter(Boolean).join(' · ');
      openModal({
        title: '压缩摘要（最近一次）',
        en: 'COMPACTION',
        bodyHtml: '<div class="pu-text"><span class="dim">' + esc(meta) + '</span></div><div class="pu-text md">' + UI.mdHtml(d.summary ?? '') + '</div>',
        foot: '只读窗 · Esc 关闭',
      });
    }, function (err) {
      if (err.status === 404) { toast('本会话还没有压缩摘要（/compact 后可看）'); return; }
      toast('加载失败：' + err.message);
    });
  }

  /* ═══════════ 更新弹窗（A4：GET /api/update——有 notes → marked 渲染；无 → 版本号+落后列表+指引；「立即升级」= 指引文案不 spawn） ═══════════ */
  function openUpdateModal() {
    UI.closePopup();
    modalClose();
    openModal({ title: '版本更新', en: 'UPDATE', bodyHtml: '<div class="pu-text"><span class="dim">正在检查更新…</span></div>' });
    A.fetchJson('/api/update').then(function (u) {
      /* 胶囊可见性新鲜度以 /api/update 为准（懒取侧比 bootstrap 启动检查缓存更新鲜——T12 口径） */
      $('btn-update').hidden = !u.hasUpdate;
      if (!u.hasUpdate) {
        modalReplace({
          title: '版本更新',
          en: 'UPDATE',
          bodyHtml: '<div class="pu-text">✦ 已是最新版本 <b>v' + esc(String(u.latest ?? u.current ?? '?')) + '</b>' + (u.latest ? '（当前 v' + esc(String(u.current ?? '?')) + '）' : '') + '</div>',
          actionsHtml: '<button class="btn" data-act="later">关闭</button>',
          foot: '红色胶囊钮 = 有新版本提示（update.banner 语义）',
          onAction: function () { modalClose(); },
        });
        return;
      }
      var body = '';
      if (typeof u.notes === 'string' && u.notes !== '') {
        body = '<div class="pu-text">✦ 新版本 <b>v' + esc(String(u.latest ?? '?')) + '</b> 可用（当前 v' + esc(String(u.current ?? '?')) + '）</div>' +
          '<div class="pu-text md update-notes">' + UI.mdHtml(u.notes) + '</div>';
      } else {
        var skipped = Array.isArray(u.skipped) ? u.skipped : [];
        body = '<div class="pu-text">✦ 新版本 <b>v' + esc(String(u.latest ?? '?')) + '</b> 可用（当前 v' + esc(String(u.current ?? '?')) + '）</div>' +
          (skipped.length > 0 ? '<div class="pu-text"><span class="dim">落后的中间版本：' + skipped.map(function (s) { return esc(String(s)); }).join('、') + '</span></div>' : '') +
          '<div class="pu-text"><span class="dim">本版更新内容暂不可得（registry 目录未含该版小节或网络失败）。</span></div>';
      }
      body += '<div class="pu-text">升级方式：在终端运行 <b>orosus upgrade</b>（npm/pnpm 全局安装均可）——网页端不代为执行安装。</div>';
      modalReplace({
        title: '版本更新',
        en: 'UPDATE',
        bodyHtml: body,
        actionsHtml: '<button class="btn primary" data-act="go">立即升级</button><button class="btn" data-act="later">稍后</button>',
        foot: '红色胶囊钮 = 有新版本提示（update.banner 语义），不是刷新会话列表',
        onAction: function (act) {
          if (act === 'go') toast('请在终端运行 orosus upgrade 完成升级（web 不代为执行安装）');
          modalClose();
        },
      });
    }, function (err) {
      modalReplace({ title: '版本更新', en: 'UPDATE', bodyHtml: '<div class="pu-text bad">更新检查失败：' + esc(err.message) + '</div>', actionsHtml: '<button class="btn" data-act="later">关闭</button>', onAction: function () { modalClose(); } });
    });
  }

  /* appbar 按钮接线（A4/A5/A6/A7——真内容；主题 A8 在上面已接） */
  $('btn-settings').addEventListener('click', function () { openSettingsRoot(0); });
  $('btn-help').addEventListener('click', openHelpModal);
  $('btn-more').addEventListener('click', openMoreMenu);
  $('btn-update').addEventListener('click', openUpdateModal);

  /* E5 连接行交互（T11/T17 收口）：失败点击重连（ops start——懒启动件）；未确认点击进设置审阅指纹。 */
  $('conn-list').addEventListener('click', function (e) {
    var row = e.target.closest('[data-conn]');
    if (!row) return;
    var name = row.getAttribute('data-conn');
    var st = row.getAttribute('data-cstate');
    /* 走查五轮：idle（已配置未启动）与失败同路径——点击即拉起（懒启动件，ops start） */
    if (st === 'failed' || st === 'idle') {
      A.fetchJson('/api/settings/mcp/ops', { method: 'POST', body: JSON.stringify({ op: 'start', name: name }) }).then(function (r) {
        if (r && r.starting) toast('正在启动 ' + name + '（首次可能需要下载，最长 60 秒）…');
        else toast('已触发启动');
      }, function (err) { toast(err.message); });
    } else if (st === 'pending-confirm') {
      openSettingsRoot(6); /* MCP 页（外观页插位后 idx 5→6） */
      window.setTimeout(function () {
        var page = document.getElementById('set-page');
        if (!page) return;
        A.fetchJson('/api/settings/mcp').then(function (d) {
          var m = (d.servers ?? []).find(function (x) { return x.name === name; });
          if (m) renderMcpDetail(page, m);
        });
      }, 50);
    }
  });

  /* E4 模块插拔交互（2026-10-12 走查五轮落地——TUI fullapp-keys.ts toggleModule 同款语义）：
   * 行点击 → POST toggle 缺省翻转（server 侧闭包：卸载带走硬依赖者/挂载自动补提供者——§3 :233）；
   * 锁定行本地示因不落请求（TUI 同款）；busy 期 409 文案直显（fetchJson 以 body.error 为 message）。 */
  $('mod-list').addEventListener('click', function (e) {
    var row = e.target.closest('[data-mod]');
    if (!row || !currentSid) return;
    var name = row.getAttribute('data-mod');
    var m = (lastModules || []).find(function (x) { return x.name === name; });
    if (m && m.locked) { toast(m.lockedReason ?? '已锁定——不可插拔'); return; }
    A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/modules/' + encodeURIComponent(name) + '/toggle', { method: 'POST', body: JSON.stringify({}) })
      .then(function (r) { if (r && r.toast) toast(r.toast); }, function (err) { toast(err.message); });
  });

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

  /* 切换视图（T16 全接线）：流区重置 + 最新一页回放（events API）→ SSE 续流（after=maxSeq）+
   * status 装配（芯片/cwd）+ 面板即拉。欢迎页显隐归 render（C1 事件数判据——T15 竞态消除）。 */
  function switchTo(sid) {
    /* 切会话前先关浮层——挂起交互的 cancelled 应答仍指向原会话（currentSid 未变） */
    UI.closePopup();
    var fromSid = currentSid; /* 离去会话——W6复核修 Important#2②：在飞 btw 轮结算的归属判据 */
    if (streamCtl) { streamCtl.close(); streamCtl = null; }
    currentSid = sid;
    settleBtwOnSwitch(fromSid); /* 切走结算：离去会话 btw tab 在飞轮落终态 + 活跃者重渲刷 composer 门控（Important#2①） */
    unlockBtwOnReturn(); /* 切回解锁（W6复核修二）：A→B→A 回环——归属新 currentSid 的活跃 btw tab 仍持离去时锁态渲染 */
    /* 服务端游标同步（fire-and-forget）——B1「＋新会话跟随当前项目」与左栏 cur 标记的 server 侧真源 */
    A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/current', { method: 'POST', body: '{}' }).then(null, function () { /* 游标同步失败无碍视图 */ });
    seenSet(sid);
    var f = findRow(sid);
    var label = f && f.row.label !== '' ? f.row.label : '新会话';
    setSessionTitle(label, sid);
    render.open({
      sid: sid,
      stream: streamEl,
      tail: tailEl,
      welcome: welcomeEl,
      pgMore: pgMoreEl,
      toBottom: $('to-bottom'),
      onFork: function (fromSid) {
        createSession({ forkFrom: fromSid }).then(function (r) {
          if (r) toast('已分叉出新会话——继承全部上下文');
        });
      },
      onCopy: copyText,
      onUserSeen: syncCwdGate,
      onAgentOpen: function (id) { openAgentTab(id); }, /* W3：spawn 组卡行点击 → OrosusPane agent open-or-switch */
      cwdOf: function () { return sessionCwd; },
    });
    renderSidebar();
    syncCwdGate();
    /* status 先行（cwd/芯片基准——工具行相对化与 @ 菜单基址），回放随后 */
    var eventsLoaded = fetchStatus(sid).then(function () {
      return A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/events');
    }).then(function (r) {
      if (currentSid !== sid) return;
      render.ingest(r.events ?? [], { page: 'latest' }); /* 首屏有界（§5 律三：每页 ≤200） */
    }, function () { /* 回放失败静默——SSE 续流面兜底 */ });
    eventsLoaded.then(function () {
      if (currentSid !== sid) return;
      streamCtl = A.openStream(sid, render.maxSeq(), {
        onEvent: function (ev) {
          if (currentSid !== sid || !ev) return;
          if (ev.type === 'session/label' && typeof ev.label === 'string') setSessionTitle(ev.label, sid);
          render.ingest([ev]);
        },
        /* 走查六轮：think 帧分路折叠思考块（reasoning 增量不再裸流正文——render.thinkChunk） */
        chunk: function (d) { if (currentSid === sid && d) { if (d.think) render.thinkChunk(d.text); else render.chunk(d.text); } },
        queue: function (d) { if (currentSid === sid) renderQueue(d && d.items); },
        phase: function (d) {
          if (currentSid !== sid || !d) return;
          var wasBusy = busy;
          busy = !!d.busy;
          render.setPhase(d.phase, d.busy);
          if (!busy) render.setCompacting(false); /* 压缩窗收口兜底（turn/compaction 事件为主信号） */
          syncSendBtn();
          /* 相位落定即刷左栏（2026-10-12 走查修——行转圈原本要等下一轮 2s 轮询才收口） */
          if (wasBusy && !busy) void pollSessions();
          if (d.phase === 'error') sactSet(sid, 'failed');
        },
        interaction: function (frame) {
          if (currentSid !== sid || !frame) return;
          UI.openInteraction(frame, answerInteraction);
        },
        btw: function (d) { if (currentSid === sid && d) btwFeed(d); },
        onShutdown: function () { /* api.js 已显「已正常关闭」弹窗并停止重连 */ },
      });
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
  function mainTodoCount() { return panelInfo && panelInfo.data ? (panelInfo.data.tasks ?? []).length : 0; }
  function syncTodoFloat() {
    var railed = rside.classList.contains('rail');
    var split = appBody.classList.contains('split');
    /* 主清单无数据时不显示悬浮条（v2 4323 口径：右栏收窄 || 分栏开，且清单非空） */
    todoFloat.hidden = !(railed || split) || mainTodoCount() === 0;
    if (todoFloat.hidden) { tfCard.hidden = true; todoFloat.classList.remove('open'); }
  }
  $('rs-collapse').addEventListener('click', function () { rside.classList.add('rail'); syncTodoFloat(); });
  $('rs-expand').addEventListener('click', function () { rside.classList.remove('rail'); syncTodoFloat(); });
  $('tf-pill').addEventListener('click', function () {
    var opening = tfCard.hidden;
    tfCard.hidden = !opening;
    todoFloat.classList.toggle('open', opening);
    if (opening) renderTfList();
  });

  /* ═══════════ 详情分栏骨架（问题 2 W1——v2 4351-4389/4710-4734 直裁） ═══════════
   * · `.app-body.split` 类 = 分栏开唯一形态开关：右栏卡片隐藏、主任务悬浮条留主流右上（归属徽标「主」）
   * · 选项卡条内部结构随 W2 到位（本任务空壳 + .pt-empty 空态） */
  var appBody = document.querySelector('.app-body');
  var splitter = $('splitter');
  var pane = $('pane');
  var paneTabsEl = $('pane-tabs');
  var paneBodyEl = $('pane-body');
  /* 走查修③（2026-10-13 用户报障）：分栏回放的点击委派——展开全部/气泡复制/轮复制。
   *  挂常驻 #pane-body（tab 体重渲不换容器，一次绑定永效）；分支钮在回放态不渲染（noFork）。 */
  if (globalThis.OrosusRender && typeof globalThis.OrosusRender.bindTranscriptActions === 'function') {
    globalThis.OrosusRender.bindTranscriptActions(paneBodyEl, { onCopy: copyText });
  }
  function paneIsOpen() { return !pane.hidden; }
  function renderPaneTabs() {
    /* W1 空态分支（v2 renderPaneTabs 同款）——选项卡数据结构随 W2 引入 */
    paneTabsEl.innerHTML = '<span class="pt-empty">暂无打开的选项卡</span>';
  }
  function openPane() {
    if (paneIsOpen()) return;
    pane.hidden = false;
    splitter.hidden = false;
    appBody.classList.add('split');
    /* 主任务悬浮条留在主流右上，不随分栏挪移 */
    syncTodoFloat();
  }
  function closePane() {
    pane.hidden = true;
    splitter.hidden = true;
    appBody.classList.remove('split');
    pane.style.flex = '';
    renderPaneTabs();
    paneBodyEl.innerHTML = '';
    syncTodoFloat();
  }
  /* 导出面（W2-W6 依赖契约）：挂 window.OrosusUI */
  UI.paneIsOpen = paneIsOpen;
  UI.openPane = openPane;
  UI.closePane = closePane;
  /* 分隔条拖拽：默认 50/50（两侧 flex:1），拖动后固定像素宽（分栏下限 300px、主列下限 480px） */
  splitter.addEventListener('mousedown', function (e) {
    e.preventDefault();
    splitter.classList.add('drag');
    var startX = e.clientX;
    var startW = pane.getBoundingClientRect().width;
    var bodyW = appBody.getBoundingClientRect().width;
    function mv(ev) {
      var w = Math.min(Math.max(startW - (ev.clientX - startX), 300), bodyW - 480);
      pane.style.flex = '0 0 ' + Math.round(w) + 'px';
    }
    function up() {
      splitter.classList.remove('drag');
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
    }
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  });
  /* 顶栏入口（v2 4730-4734）：◧ 分栏 = 打开 / 关闭——未开分支 = /tasks 同款（cmdTasks 批量开 tab） */
  $('btn-split').addEventListener('click', function () {
    if (paneIsOpen()) { closePane(); toast('分栏已收回'); return; }
    cmdTasks();
  });

  /* ═══════════ 子代理选项卡（问题 2 W3——v2 4393-4481/4520-4545/4683-4688/2528-2537 直裁） ═══════════
   * · /tasks（cmdTasks）：openPane + 名册每行 open-or-switch 一个 agent tab（有几开几，无列表视图）；
   *   空名册 → 打开空分栏（.pt-empty 空态）；
   * · 主流 spawn 组卡行点击（onAgentOpen → openAgentTab）：OrosusPane open-or-switch（不再进回放窗）；
   * · tab 内容（onBodyRender('agent')）：.ag-wrap = 可选 .ag-approval 审批条（⚠ 工具名 + 原因 +
   *   拒绝/批准一次——data-aga → 既有 POST approval，服务端零改动）+ .ag-stream 回放
   *   （OrosusRender.renderTranscript 复用：事件数门零重渲 + 贴底跟随）+ 运行中尾行 spinner；
   *   回放轮询 2s 仅活跃 tab（addPoll 驱动 + bodyEl 内容脱离 DOM 自摘——GC7）；
   * · 状态点（dotOf 覆写 agentTabDot）：pendingApproval ◉ 先行短路，TASK_ICON 四态（v2 1598-1599）；
   *   updateSpawnGroups 名册轮询同步刷已开 tab 的点（dotOf 注入实现，签名门——名册不变 DOM 零触碰）。 */
  var Pane = window.OrosusPane;
  var AGENT_ICON = { queued: '○', running: '◐', completed: '✓', failed: '✗' }; /* v2 1599 TASK_ICON 四态 */
  var taskRoster = []; /* 最近一次 /tasks 名册（agentTabDot + 审批条数据源——updateSpawnGroups 拍内更新） */
  var taskDotSig = ''; /* 名册签名（id:状态:审批）——不变不重渲 tab 条（§5 律三） */
  function rosterRowOf(id) {
    for (var ri = 0; ri < taskRoster.length; ri++) if (taskRoster[ri].id === id) return taskRoster[ri];
    return null;
  }
  function refreshAgentTabDots() {
    if (document.querySelector('#pt-list .pt-item') === null) return; /* 无已开 tab——零开销 */
    var sig = taskRoster.map(function (r) { return r.id + ':' + (r.status ?? '') + ':' + (r.pendingApproval ? 1 : 0); }).join('|');
    if (sig === taskDotSig) return;
    taskDotSig = sig;
    Pane.renderTabs();
  }
  /* agent 状态点注入（v2 agentTabDot 4393-4396）：审批 ◉ 短路 → 四态图标；非 agent kind / 不在册 → W2 缺省点（v2 4404-4407） */
  var paneDotDefault = Pane.dotOf;
  Pane.dotOf = function (tab) {
    if (!tab || tab.kind !== 'agent') return paneDotDefault(tab); /* btw 等其它 kind 归缺省（W6 并存） */
    var row = rosterRowOf(tab.id);
    if (!row) return paneDotDefault(tab);
    if (row.pendingApproval) return '<span class="pt-dot st-warn">◉</span>';
    var st = SPAWN_ST[row.status] ?? [String(row.status), 'st-run'];
    return '<span class="pt-dot ' + st[1] + '">' + (AGENT_ICON[row.status] ?? '◐') + '</span>';
  };
  /* ＋菜单内容源（走查修③——2026-10-13 用户口令）：只留「✦ 侧问」类型行（点击即开新侧问选项卡，
   *  仿 ZCode 侧聊入口形态）；子代理不再罗列（其入口 = /tasks 批量开卡与主流 spawn 组行点击——
   *  名册罗列在 /tasks 全开后只剩噪音）。原 v2 4683-4688 名册行形态废弃，pane.js 滤除/禁用态逻辑
   *  兼容保留（单行恒可开，不再触达禁用态）。 */
  Pane.plusSource = function () {
    return [{ kind: 'btw', label: '侧问', prefix: '✦ ', open: function () { openBtwTab(); } }];
  };
  /** 拉名册并刷 tab 状态点（cmdTasks / sg-row 点击 / 审批应答共用；sid 守卫——切会话后不回写他话名册）。 */
  function refreshTasks(sid) {
    return A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/tasks').then(function (r) {
      var rows = r.rows ?? [];
      if (sid === currentSid) {
        taskRoster = rows;
        refreshAgentTabDots();
      }
      return rows;
    });
  }
  /** /tasks（v2 cmdTasks 2528-2537 目标形态）：openPane + 名册每行各开一个 agent tab（open-or-switch）；
   *  空名册 → 空分栏（.pt-empty 空态——known-issues.md:99 定案）。 */
  function cmdTasks() {
    if (currentSid === null) { toast('暂无会话——先在左栏「＋ 新会话」或选择一个会话'); return; }
    var sid = currentSid; /* 拉取期间切会话不改写归属（tab 的 data.sid 恒指开栏时会话） */
    refreshTasks(sid).then(function (rows) {
      if (rows.length === 0) {
        UI.openPane();
        toast('暂无在册子代理——分栏已打开（对模型说「派个子代理去 …」后这里会列出）');
        return;
      }
      rows.forEach(function (tk) {
        addAgentTab(sid, tk);
      });
    }, function () { toast('拉取子代理名册失败'); });
  }
  /** 主流 sg-row 点击 → agent open-or-switch（v2 openAgentTab 4431-4441）：名册查证 label 后进分栏。 */
  function openAgentTab(id) {
    if (currentSid === null) return;
    var sid = currentSid;
    var known = rosterRowOf(id);
    if (known !== null) { addAgentTab(sid, known); return; }
    refreshTasks(sid).then(function (rows) {
      var tk = null;
      for (var oi = 0; oi < rows.length; oi++) if (rows[oi].id === id) tk = rows[oi];
      if (!tk) { toast('子代理 ' + id + ' 不在册（可能已清理）'); return; }
      addAgentTab(sid, tk);
    }, function () { toast('拉取子代理名册失败'); });
  }
  function addAgentTab(sid, tk) {
    var label = tk.label || tk.id;
    Pane.addTab({ kind: 'agent', id: tk.id, label: label, data: { sid: sid, id: tk.id, label: label } });
  }
  /* agent tab 内容渲染器（v2 agentTabHtml 4456-4481 直裁——todo 悬浮条 .ag-todo 见下方 W4 段）：
   *  回放轮询走 agentStreamLoads 注册表（boot 内 A.addPoll(2000) 驱动）——.ag-stream 脱离 DOM 即自摘，
   *  切 tab / 关 tab / 收分栏三路全部停轮（GC7 仅活跃 tab 轮询）。 */
  var agentStreamLoads = [];
  Pane.onBodyRender('agent', function (data, bodyEl) {
    bodyEl.innerHTML = '<div class="ag-wrap"><div class="ag-stream">加载中…</div></div>';
    var wrapEl = bodyEl.querySelector('.ag-wrap');
    var streamEl = wrapEl.querySelector('.ag-stream');
    var sid = data.sid, id = data.id;
    var approvalSig = '';
    var pollBusy = false, answerBusy = false, todoBusy = false;
    function syncApproval(row) {
      var pa = row && row.pendingApproval ? row.pendingApproval : null;
      var sig = pa ? (pa.tool ?? '') + '␀' + (pa.reason ?? '') : '';
      if (sig === approvalSig) return;
      approvalSig = sig;
      var old = wrapEl.querySelector('.ag-approval');
      if (old) old.remove();
      if (!pa) return;
      var bar = document.createElement('div');
      bar.className = 'ag-approval';
      bar.innerHTML = '<span class="st-warn">◉</span><span class="aga-text">⚠ ' + esc(pa.tool ?? '') + ' 等待批准——' + esc(pa.reason ?? '') + '</span>' +
        '<button class="btn" data-aga="no">拒绝</button><button class="btn primary" data-aga="yes">批准一次</button>';
      wrapEl.insertBefore(bar, streamEl);
    }
    function syncSpinner(row) {
      var want = !!row && row.status === 'running';
      var has = streamEl.querySelector('.agent-spin') !== null;
      if (want === has) return;
      if (want) {
        var sp = document.createElement('div');
        sp.className = 'line dim agent-spin';
        sp.innerHTML = spinSvg('', 12) + ' 正在生成…';
        streamEl.appendChild(sp);
      } else {
        streamEl.querySelector('.agent-spin').remove();
      }
    }
    /* ═══ 子代理 todo 悬浮条（问题 2 W4——v2 4461-4471 直裁，数据 = GET /subagents/:id/todo） ═══
     * · .todo-float.ag-todo 浮在 .ag-wrap 右上（top:8px;right:14px——style.css W4 段）；
     * · tf-owner 归属徽标 = agentId 前 4 位；卡头「任务清单 · <完整id>」+ done/total 计数；
     * · todos 空 → 整个不渲染（v2 4462 纪律——有数据才出现，清单清空即摘除）；
     * · 签名门 diff（GC7 律三——数据不变 DOM 零触碰）；卡开合态跨刷新保持（数据变重渲不强制收卡）；
     * · 轮询搭 agentStreamLoads 同拍（2s 仅活跃 tab——isConnected 自摘，GC7）。 */
    var agTodoSig = '';
    var agTodoOpen = false;
    var AG_TODO_TICK = { done: '✓', active: '◐', pending: '○' }; /* v2 4456 TODO_TICK 三态 */
    function syncAgTodo(tasks) {
      var sig = tasks.map(function (t) { return t.text + ':' + t.state; }).join('|');
      if (sig === agTodoSig) return; /* 签名门：数据不变零触碰 */
      agTodoSig = sig;
      var old = wrapEl.querySelector('.todo-float.ag-todo');
      if (old) old.remove();
      if (tasks.length === 0) return; /* v2 纪律：无任务数据整个不渲染 */
      var done = tasks.filter(function (t) { return t.state === 'done'; }).length;
      var fl = document.createElement('div');
      fl.className = 'todo-float ag-todo' + (agTodoOpen ? ' open' : '');
      fl.innerHTML = '<button class="tf-pill" data-agtf="' + esc(id) + '" title="该子代理自己的任务清单（与主清单隔离）"><span class="tf-owner">' + esc(id.slice(0, 4)) + '</span><span class="ok">✓</span> <span class="tf-count">' + done + '/' + tasks.length + '</span> 任务 <span class="tf-open">⇲</span></button>' +
        '<div class="tf-card"' + (agTodoOpen ? '' : ' hidden') + '><div class="tf-head"><span>任务清单 · ' + esc(id) + '</span><span>' + done + '/' + tasks.length + '</span></div><div class="tf-list">' +
        tasks.map(function (t) {
          return '<div class="todo" data-state="' + esc(t.state) + '"><span class="tick">' + (AG_TODO_TICK[t.state] ?? '○') + '</span><span class="ttext">' + esc(t.text) + '</span></div>';
        }).join('') + '</div></div>';
      wrapEl.insertBefore(fl, wrapEl.firstChild); /* v2 序：悬浮条居 .ag-wrap 首位（审批条/回放之前） */
    }
    /* 审批条批/拒（v2 bindPaneBody 4532-4543 → 既有 POST approval 真链路）：应答后收条 + 刷名册状态点；
     * W4 todo 悬浮条开合（v2 4526-4531）先行分支——pill 点击展开/收起卡面 */
    wrapEl.addEventListener('click', function (e) {
      var p = e.target.closest('[data-agtf]');
      if (p) {
        var card = wrapEl.querySelector('.ag-todo .tf-card');
        if (card) {
          agTodoOpen = card.hidden;
          card.hidden = !agTodoOpen;
          p.parentElement.classList.toggle('open', agTodoOpen);
        }
        return;
      }
      var b = e.target.closest('[data-aga]');
      if (!b || answerBusy) return;
      answerBusy = true;
      var allow = b.getAttribute('data-aga') === 'yes';
      A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/subagents/' + encodeURIComponent(id) + '/approval', { method: 'POST', body: JSON.stringify({ allow: allow }) })
        .then(function () {
          answerBusy = false;
          toast((allow ? '已批准 ' : '已拒绝 ') + id + ' 的 ' + (data.label || '子代理任务'));
          return refreshTasks(sid);
        }, function (err) {
          answerBusy = false;
          toast('应答失败：' + err.message);
          return null;
        })
        .then(function (rows) {
          if (!wrapEl.isConnected) return; /* tab 已关/切走——收条留给下一拍名册轮询 */
          var row = rows ? rows.find(function (x) { return x.id === id; }) : rosterRowOf(id);
          var old = wrapEl.querySelector('.ag-approval');
          if (old) old.remove();
          approvalSig = '';
          syncApproval(row ?? null);
        });
    });
    var load = function () {
      if (!wrapEl.isConnected) { /* tab 切走/关闭/分栏收回——自摘停轮（GC7 仅活跃 tab） */
        var li = agentStreamLoads.indexOf(load);
        if (li >= 0) agentStreamLoads.splice(li, 1);
        return;
      }
      if (!todoBusy) { /* W4：todo 悬浮条取数与回放同拍（2s 仅活跃 tab——服务端 1s 缓存兜读盘成本） */
        todoBusy = true;
        A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/subagents/' + encodeURIComponent(id) + '/todo', { timeoutMs: 8000 }).then(function (tr) {
          todoBusy = false;
          if (!wrapEl.isConnected) return;
          syncAgTodo(tr.tasks ?? []);
        }, function () {
          todoBusy = false; /* 静默——下一拍再试（悬浮条保持旧态，不闪空） */
        });
      }
      if (pollBusy) return;
      pollBusy = true;
      A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/subagents/' + encodeURIComponent(id) + '/events', { timeoutMs: 8000 }).then(function (er) {
        pollBusy = false;
        if (!wrapEl.isConnected) return;
        var row = rosterRowOf(id);
        syncApproval(row);
        var events = er.events ?? [];
        var n = events.length;
        var cur = streamEl.getAttribute('data-n');
        var pinBottom = false;
        if (cur !== String(n)) { /* 事件数门：无新事件零重渲——滚动位不动（走查六轮同款） */
          pinBottom = cur === null || (streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 40);
          streamEl.setAttribute('data-n', String(n));
          if (globalThis.OrosusRender) globalThis.OrosusRender.renderTranscript(streamEl, events, { noFork: true }); /* 走查修②：子代理回放无分叉面 */
        }
        syncSpinner(row);
        if (pinBottom) streamEl.scrollTop = streamEl.scrollHeight;
      }, function () {
        pollBusy = false;
        if (!wrapEl.isConnected) return;
        if (streamEl.getAttribute('data-n') === null) streamEl.textContent = '（回放拉取失败）';
      });
    };
    agentStreamLoads.push(load);
    load();
  });

  /* ═══════════ btw 选项卡（问题 2 W6——v2 4442-4452/4484-4507/4547-4588 直裁，弹窗形态下线） ═══════════
   * · openBtwTab()：每次新实例（btw-N 自增 id、label「侧问 N」）——＋ 菜单「✦ 侧问选项卡」与 /btw
   *   带参同此（v2 4442）；btwSeq 页面寿命单调不随分栏关回收（防 id 撞 server 侧存活实例的帧落位）；
   * · tab 内容（onBodyRender('btw')）：.btw-scope 说明行 + .btw-stream rounds 渲染（.msg-user 气泡 +
   *   .btw-a 回答中/查证中/失败相位态）+ 裁剪版 composer（.ib-main ❯+textarea rows=2 + .ib-bar 左仅
   *   ＋文件〔= 插入 @〕、右 hint + 发送钮——去 mode/model/effort 三芯片，拍板第 4 条）；Enter 发送 /
   *   Shift+Enter 换行、keydown stopPropagation（v2 4555-4558）、重渲保草稿（rerenderBtwKeepingDraft，
   *   v2 4569-4577 同款——帧面重渲不抢主输入框焦点，原本在侧问框时归还）；
   * · 发送 = POST /btw {tab, q}（W5 askBtw 数据面）+ 本地 push {q, a:null} 占位等帧回填；尾部在飞轮
   *   先弹掉——server per-tab 单飞新问 abort 旧在飞（旧问不入 rounds），对齐本地轮序与帧 round；
   * · SSE btw 帧按 frame.tab 分发（btwFeed）：未开 tab 的 answering/answer 帧自动开 tab（对齐
   *   旧小窗的自动占窗语义——tool/error 不占窗）；仅活跃 tab 重渲（GC7——非活跃只改数据）；
   * · /btw mark 分支（cmdBtw）：带参（handleSendResponse 截获块存的问题文本——mark 响应不带文本）
   *   开新 tab 即发问；无参复用空草稿（未发过问的）btw tab 或新开。 */
  var btwSeq = 0;
  var pendingBtwQuestion = ''; /* /btw 前缀截获块存文（发问源——mark 分支消费后即清） */
  function openBtwTab() {
    btwSeq++;
    var spec = Pane.btwTabSpec(btwSeq);
    spec.data.sid = currentSid; /* 归属会话（POST /btw 落点——切会话后 tab 内发问仍指原会话） */
    Pane.addTab(spec);
    return Pane.activeTab(); /* addTab 尾插即激活——返回新实例（data 与 spec 同引用） */
  }
  function btwLabelOf(tabId) {
    var m = /^btw-(\d+)$/.exec(String(tabId || ''));
    return m !== null ? '侧问 ' + m[1] : String(tabId || '侧问');
  }
  /** /btw mark 分支（v2 cmdBtw 2541-2548）：带参开新 tab 并即发问；无参复用空草稿（rounds 尚空）
   *  btw tab 或新开（v2 无参 toast 分支的「不叠开空 tab」细化——brief 口径「开或复用空草稿」）。
   *  走查修（2026-10-13 用户报障）：无参回看不再弹窗——server 归档轮次经 r.btwRounds 搭载，
   *  水合进目标 tab（仅当目标 tab rounds 为空——不覆写活实例；无归档则空态 tab 引导）。 */
  function cmdBtw(r) {
    var q = pendingBtwQuestion;
    pendingBtwQuestion = '';
    if (q) { sendBtwAsk(openBtwTab(), q); return; }
    var arch = r && Array.isArray(r.btwRounds) ? r.btwRounds : null;
    var tabs = Pane.tabsOf();
    for (var i = tabs.length - 1; i >= 0; i--) {
      var t = tabs[i];
      if (t.kind === 'btw' && t.data && (t.data.rounds ?? []).length === 0) {
        Pane.activateTab(i);
        if (arch && arch.length > 0) { t.data.rounds = arch; Pane.rerenderBody(); }
        return;
      }
    }
    var nt = openBtwTab();
    if (arch && arch.length > 0) { nt.data.rounds = arch; Pane.rerenderBody(); }
  }
  /** 发问（W5 数据面）：本地 push {q,a:null} 占位等帧回填 + POST /btw {tab,q} 受理即回（202）。
   *  POST 失败即标 error 相位（不悬转）。 */
  function sendBtwAsk(tab, q) {
    if (!tab.data.sid) { toast('暂无会话——先在左栏「＋ 新会话」或选择一个会话'); return; } /* 无会话不开问——输入未清（不走重渲），问文保留 */
    var rounds = tab.data.rounds;
    while (rounds.length > 0) { /* 尾部在飞轮先弹：server 单飞 abort 的旧问不入 rounds——对齐帧 round 对位 */
      var last = rounds[rounds.length - 1];
      var inFlight = last.phase === 'answering' || last.phase === 'tool' || (last.a == null && last.phase !== 'error');
      if (!inFlight) break;
      rounds.pop();
    }
    var rd = { q: q, a: null, phase: 'answering' };
    rounds.push(rd);
    if (Pane.activeTab() === tab) {
      /* W6复核修 Important#1（对齐 v2 4578-4581：v2 发送后 renderPaneBody 换空 textarea）：本次发送
       * 成功 push 轮次清空侧问框——清在保草稿重渲之前，重渲读到空草稿即出空 textarea（否则问题文本
       * 残留 composer，再按 Enter 重复发送同一问）。帧驱动的重渲仍走 rerenderBtwKeepingDraft 保未
       * 发送草稿（其他用户在编辑中不被帧清掉——该保留的保留）；仅本 push 轮次路径清空，sid 空守卫
       * 早退（问文保留）与 cmdBtw 新 tab（本空）两路径不受影响。 */
      var bi = document.getElementById('btw-input');
      if (bi !== null) bi.value = '';
      rerenderBtwKeepingDraft();
    }
    A.fetchJson('/api/sessions/' + encodeURIComponent(tab.data.sid) + '/btw', { method: 'POST', body: JSON.stringify({ tab: tab.id, q: q }) }).then(null, function (err) {
      rd.phase = 'error';
      rd.a = '发送失败：' + err.message;
      if (Pane.activeTab() === tab) rerenderBtwKeepingDraft();
    });
  }
  /** SSE btw 帧按 tab 分发（W5 帧形 {tab, phase, text, round}）：落对应实例 rounds；未开 tab 的
   *  answering/answer 帧 = 自动开 tab（对齐旧小窗自动占窗语义）；仅活跃 tab 重渲（GC7）。 */
  function btwFeed(frame) {
    var tabs = Pane.tabsOf();
    var tab = null;
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].kind === 'btw' && tabs[i].id === frame.tab) { tab = tabs[i]; break; }
    }
    if (tab === null) {
      if (frame.phase !== 'answering' && frame.phase !== 'answer') return; /* tool/error 不占窗（旧口径） */
      var spec = { kind: 'btw', id: frame.tab, label: btwLabelOf(frame.tab), data: { sid: currentSid, rounds: [] } };
      Pane.addTab(spec);
      tab = Pane.activeTab();
    }
    Pane.applyBtwFrame(tab.data.rounds, frame);
    if (Pane.activeTab() === tab) {
      /* 走查修②（闪烁根除）：answering/thinking 帧增量渲染（只改末轮两元素，composer 不重建）；
       *  tool 相位切换与 answer/error 终态仍整体重渲（终帧 md 整块渲染兜底）。 */
      if ((frame.phase === 'answering' || frame.phase === 'thinking') && Pane.btwLiveUpdate(frame)) return;
      rerenderBtwKeepingDraft();
    }
  }
  /** 重渲保草稿（v2 4569-4577 同款）：帧驱动重渲不吞侧问框未发草稿 + 焦点归还（原本在侧问框时）——
   *  帧面重渲不抢主输入框焦点（v2 bindPaneBody 无条件 focus 的盲点补丁）。 */
  function rerenderBtwKeepingDraft() {
    var bi = document.getElementById('btw-input');
    var draft = bi ? bi.value : '';
    var hadFocus = bi !== null && bi === document.activeElement;
    btwRenderNoFocus = true; /* 帧驱动重渲不抢焦点（渲染器聚焦位抑制——同步重渲，置位即安全） */
    Pane.rerenderBody();
    btwRenderNoFocus = false;
    var ni = document.getElementById('btw-input');
    if (ni !== null && draft !== '') {
      ni.value = draft;
      var sb = document.getElementById('btw-send');
      if (sb !== null) sb.className = 'sendbtn ' + (draft.trim() ? 'ready' : 'idle');
    }
    if (hadFocus && ni !== null) ni.focus();
  }
  var btwRenderNoFocus = false; /* 帧驱动重渲的 focus 抑制位（rerenderBtwKeepingDraft 置位） */
  /** W6复核修 Important#2②（切走结算——tab 设计为跨会话存活）：switchTo 关旧 SSE 流后遍历已开 btw
   *  tabs，凡 data.sid === 离去 sid 者，在飞轮次经 Pane.settleBtwRounds 本地结算为终态（a 落
   *  「〔已中断：切换会话〕」标记——消除永转「回答中…」；btw 帧只在归属会话的流里，旧流已关，永无
   *  回填）。零服务端往返（btw D6 零落盘无归档端点可查——本地结算即诚实口径）。活跃的离去会话 btw
   *  tab 无论有无在飞轮都重渲：既显结算标记，也把 composer 切到 sid 门控禁用态（Important#2①——
   *  防「切会话后旧表单未重渲仍可发」的滞留窗）。 */
  function settleBtwOnSwitch(fromSid) {
    var tabs = Pane.tabsOf();
    var refresh = false;
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (!t || t.kind !== 'btw' || !t.data || t.data.sid !== fromSid) continue;
      Pane.settleBtwRounds(t.data.rounds);
      if (Pane.activeTab() === t) refresh = true;
    }
    if (refresh) rerenderBtwKeepingDraft(); /* currentSid 已换新——重渲即出 locked composer；草稿保留 */
  }
  /** W6复核修二（切回解锁——settleBtwOnSwitch 的对偶面）：A→B→A 回环后，活跃 btw tab 若归属新
   *  currentSid（切回原会话），其 DOM 仍是离去时锁态渲染（composer disabled + .btw-locked 提示行）——
   *  切走结算只理离去 sid（t.data.sid !== fromSid 跳过），切回方向无人重渲（locked 是渲染期派生态，
   *  data.sid === currentSid 复成立也不会让旧 DOM 自动解锁）。GC7 签名门（只在必要时重渲）：活跃
   *  tab 非 btw / data.sid !== currentSid / 当前渲染无锁态（.btw-locked 缺席——首次归属渲染本就不锁，
   *  切走路径 settleBtwOnSwitch 刚渲出的锁属离去 sid，此处 sid 门先弹）任一即早退零触碰；保草稿/
   *  焦点归还走 rerenderBtwKeepingDraft——与 settleBtwOnSwitch 同一口径，不改离去结算语义。 */
  function unlockBtwOnReturn() {
    var t = Pane.activeTab();
    if (!t || t.kind !== 'btw' || !t.data || t.data.sid !== currentSid) return;
    var body = document.getElementById('pane-body');
    if (!body || body.querySelector('.btw-locked') === null) return; /* 渲染即签名——无锁态零重渲 */
    rerenderBtwKeepingDraft();
  }
  Pane.onBodyRender('btw', function (data, bodyEl) {
    var locked = data.sid !== currentSid; /* Important#2①：跨会话门控——非归属会话的 btw 帧已随旧流关闭，发问将永无回填 */
    bodyEl.innerHTML = Pane.btwTabHtml(data, locked);
    var bForm = bodyEl.querySelector('#btw-form');
    var bInput = bodyEl.querySelector('#btw-input');
    var bSend = bodyEl.querySelector('#btw-send');
    function syncBtn() { if (bSend.hasAttribute('data-btwstop')) return; bSend.className = 'sendbtn ' + (bInput.value.trim() ? 'ready' : 'idle'); }
    if (!btwRenderNoFocus) bInput.focus(); /* 用户驱动开 tab/切换即聚焦（v2 4551）；帧驱动重渲不抢焦点 */
    bInput.addEventListener('input', syncBtn);
    bInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !bSend.hasAttribute('data-btwstop')) { e.preventDefault(); bForm.requestSubmit(); }
      e.stopPropagation(); /* 不触发主输入框的 Esc / 快捷键逻辑（v2 4555-4558） */
    });
    bForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = bInput.value.trim();
      if (!q) return;
      sendBtwAsk(Pane.activeTab(), q); /* 活跃 tab 即本渲染器所属实例（换 tab 时旧表单已随重渲摘除） */
    });
    /* 走查修④（2026-10-13 用户报障）：在飞时发送钮已变 ■ 停止（type=button 不走 submit）——
     * 点击 = POST {tab, abort:true}，server 侧 abortBtw 结算在飞轮（〔已停止〕尾注回落）。 */
    if (bSend.hasAttribute('data-btwstop')) bSend.addEventListener('click', function () {
      var tab = Pane.activeTab();
      if (!tab || !tab.data.sid) return;
      bSend.className = 'sendbtn idle'; /* 即时落灰（帧回填后重渲归真——不等网络） */
      A.fetchJson('/api/sessions/' + encodeURIComponent(tab.data.sid) + '/btw', { method: 'POST', body: JSON.stringify({ tab: tab.id, abort: true }) }).then(null, function () { toast('停止失败——网络或服务异常'); });
    });
    bodyEl.querySelector('#btw-file').addEventListener('click', function () { /* ＋文件 = 插入 @（光标位） */
      bInput.focus();
      var s = bInput.selectionStart ?? bInput.value.length;
      var epos = bInput.selectionEnd ?? s;
      var pad = s > 0 && bInput.value.charAt(s - 1) !== ' ' ? ' ' : '';
      bInput.value = bInput.value.slice(0, s) + pad + '@' + bInput.value.slice(epos);
      var pos = s + pad.length + 1;
      bInput.setSelectionRange(pos, pos);
      syncBtn();
    });
    var bs = bodyEl.querySelector('#btw-stream');
    bs.scrollTop = bs.scrollHeight; /* 贴底（v2 4565-4566） */
  });

  /* 面板渲染（2s 轮询 + 签名门——数据不变 DOM 零触碰；运行时间跳秒本地自增） */
  var TICK = { pending: '○', active: '◐', done: '✓' };
  var MOD_STATE_TEXT = { mounted: '已挂载', loading: '挂载中', off: '未挂载', pendingConfirm: '待确认' };
  var kvSig = '', modSig = '', connSig = '', peerSig = '', todoSig = '';
  /* 模块挂载 / 网络·MCP 连接两列表统一分页（用户走查口径：运行状态页不出滚动条——
   *  列表区 flex 界高 overflow:hidden，超幅走页脚分页器；页大小量高自适应视口） */
  var modListEl = $('mod-list'), connListEl = $('conn-list');
  var modPagerEl = $('mod-pager'), connPagerEl = $('conn-pager');
  var lastModules = [], lastConns = [];
  var modPage = 0, connPage = 0, modSize = 6, connSize = 6;
  var modRenderKey = '', connRenderKey = '';
  function listPageSize(listEl, lastSize) {
    var h = listEl.clientHeight; /* .plist flex:1 界高——与内容行数无关，测量稳定 */
    if (h <= 0) return lastSize; /* 隐藏页签量不到——保留旧值 */
    var row = listEl.querySelector('.mod');
    var rh = row !== null ? row.getBoundingClientRect().height : 0;
    if (rh <= 0) rh = 30; /* 首渲兜底行高（.mod padding 4×2 + 12.5px×1.75 行高 ≈ 30px） */
    return Math.max(1, Math.floor(h / rh));
  }
  function syncPager(pagerEl, pg) {
    pagerEl.hidden = pg.pages <= 1;
    if (pagerEl.hidden) return;
    var ind = pagerEl.querySelector('.pg-ind');
    if (ind) ind.textContent = (pg.page + 1) + '/' + pg.pages;
    var prev = pagerEl.querySelector('[data-pg="prev"]'), next = pagerEl.querySelector('[data-pg="next"]');
    if (prev) prev.disabled = pg.page <= 0;
    if (next) next.disabled = pg.page >= pg.pages - 1;
  }
  function modRowHtml(m) {
    var dot = m.state === 'mounted' ? '●' : (m.state === 'loading' || m.state === 'pendingConfirm') ? '◐' : '○';
    var tip = m.locked ? (m.lockedReason ?? '已锁定——不可插拔') : (MOD_STATE_TEXT[m.state] ?? m.state);
    return '<div class="mod ' + esc(m.state) + '" data-mod="' + esc(m.name) + '" title="' + esc(tip) + '">' +
      '<span class="dot">' + dot + '</span><span class="mname">' + esc(m.name) + (m.locked ? '<span class="locktag"> · 锁定</span>' : '') + '</span>' +
      '<span class="mdesc">' + esc(m.desc ?? '') + '</span><span class="mstate">' + (MOD_STATE_TEXT[m.state] ?? m.state) + '</span></div>';
  }
  function connRowHtml(c) {
    var cls = c.state === 'connected' ? 'mounted' : c.state === 'failed' ? 'failed' : c.state === 'pending-confirm' ? 'failed pending' : 'off';
    /* 2026-10-12 走查二轮：状态文字退役——绿=已连接（尾注连接耗时）/红=失败·未确认/灰=停用·待启动 */
    var dot = c.state === 'connected' ? '<span class="mdot ok">●</span>'
      : (c.state === 'failed' || c.state === 'pending-confirm') ? '<span class="mdot bad">●</span>'
      : '<span class="mdot off">○</span>';
    var right = c.state === 'connected' && c.connectMs !== undefined ? c.connectMs + 'ms' : '';
    return '<div class="mod ' + cls + '" data-conn="' + esc(c.name) + '" data-cstate="' + esc(c.state) + '" title="' + esc(c.desc) + '">' + dot + '<span class="mname">' + esc(c.name) + '</span><span class="mdesc">' + esc(c.desc) + '</span><span class="mstate">' + esc(right) + '</span></div>';
  }
  function renderModPage() {
    modSize = listPageSize(modListEl, modSize);
    var pg = render.pageSlice(lastModules.length, modPage, modSize);
    modPage = pg.page;
    var key = modSig + '#' + pg.page + 'x' + modSize;
    if (key !== modRenderKey) {
      modRenderKey = key;
      modListEl.innerHTML = lastModules.slice(pg.from, pg.to).map(modRowHtml).join('');
    }
    syncPager(modPagerEl, pg);
  }
  function renderConnPage() {
    connSize = listPageSize(connListEl, connSize);
    var pg = render.pageSlice(lastConns.length, connPage, connSize);
    connPage = pg.page;
    var key = connSig + '#' + pg.page + 'x' + connSize;
    if (key !== connRenderKey) {
      connRenderKey = key;
      connListEl.innerHTML = lastConns.slice(pg.from, pg.to).map(connRowHtml).join('') || '<div class="panel-hint">（无 MCP 连接配置）</div>';
    }
    syncPager(connPagerEl, pg);
  }
  modPagerEl.addEventListener('click', function (e) {
    var b = e.target.closest('[data-pg]');
    if (!b) return;
    modPage += b.getAttribute('data-pg') === 'next' ? 1 : -1;
    renderModPage();
  });
  connPagerEl.addEventListener('click', function (e) {
    var b = e.target.closest('[data-pg]');
    if (!b) return;
    connPage += b.getAttribute('data-pg') === 'next' ? 1 : -1;
    renderConnPage();
  });
  if (typeof ResizeObserver === 'function') {
    /* 视口驱动（GC11）：窗高变化 → 列表界高变 → 页大小重算（隐藏页签显示时同样触发） */
    var panelRO = new ResizeObserver(function () {
      A.rafFlush(function () { renderModPage(); renderConnPage(); });
    });
    panelRO.observe(modListEl);
    panelRO.observe(connListEl);
  }
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
    /* 模块挂载（E4 显示面；插拔交互归 T16/T17）——分页渲染（页脚分页器） */
    var ms = (data.modules ?? []).map(function (m) { return m.name + ':' + m.state + (m.locked ? 'L' : ''); }).join('|');
    if (ms !== modSig) {
      modSig = ms;
      lastModules = data.modules ?? [];
    }
    renderModPage();
    /* 网络 · MCP 连接（E5 显示面）——分页渲染（与模块挂载统一） */
    var conns = (data.network && data.network.connections) ?? [];
    var cs = conns.map(function (c) { return c.name + ':' + c.state + ':' + (c.connectMs ?? ''); }).join('|');
    if (cs !== connSig) {
      connSig = cs;
      lastConns = conns;
      $('kv-proxy').textContent = (data.network && data.network.proxy) ?? '—';
      $('kv-modelsvc').textContent = (data.network && data.network.modelService) ?? '—';
    }
    renderConnPage();
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
        if (!(peers.list ?? []).length) html2 += '<div class="panel-hint">（无其它进程——同项目 TUI 会话运行时会出现在这里）</div>';
      } else {
        html2 = '<div class="panel-hint">（暂无协同数据）</div>';
      }
      $('peer-list').innerHTML = html2;
    }
    /* 任务清单（E7）+ 悬浮卡计数同步（E8）。空态进度条显隐在签名门外——空清单签名恒等于
     *  初值（''），门内永不会跑（走查三轮：0/0 时空进度条仍显示的根因）。 */
    var tasks = data.tasks ?? [];
    var tp = document.querySelector('.todo-progress');
    if (tp) tp.classList.toggle('empty', tasks.length === 0);
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
      syncTodoFloat(); /* 清单空 ↔ 非空切换时悬浮条可见性跟随（v2 静态 todos 的实数据适配——签名门内，数据不变不碰 DOM） */
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
    return A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/panel', { timeoutMs: 9000 }).then(function (data) {
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
      projectsPool = Array.isArray(bs.projects) ? bs.projects : []; /* cwd 芯片候选池（D5——含 hidden 找回） */
      return pollSessions().then(function () {
        var target = null;
        if (bs.currentSid && findRow(bs.currentSid)) target = bs.currentSid; /* /web 交接会话优先 */
        else if (sessionsData.groups.length > 0 && sessionsData.groups[0].sessions.length > 0) {
          target = sessionsData.groups[0].sessions[0].sid; /* 无当前 → 最新活动会话（组间最新在前） */
        } else if (sessionsData.pinned.length > 0) target = sessionsData.pinned[0].sid;
        if (target) return switchTo(target);
        setSessionTitle('', '');
        showWelcome(true);
        syncCwdGate();
        tailEl.textContent = '暂无会话——点击左栏「＋ 新会话」开始';
        return undefined;
      });
    }).then(function () {
      /* 轮询节拍器：sessions 2s / panel 2s 错峰 1s（自创值登记口径） */
      A.addPoll(2000, 0, pollSessions);
      A.addPoll(2000, 1000, function () { return fetchPanel(currentSid); });
      /* spawn 组卡名册轮询（走查六轮）：页面有组卡行才取 /tasks——行态/标题校正 + 头行聚合（W3：已开 agent tab 同驱动） */
      A.addPoll(2000, 500, pollSpawnGroups);
      /* agent tab 回放轮询（W3/GC7 仅活跃 tab）：装载器自检 isConnected——脱离 DOM 即自摘，倒序遍历防遍历中摘除 */
      A.addPoll(2000, 1500, function () {
        for (var ai = agentStreamLoads.length - 1; ai >= 0; ai--) agentStreamLoads[ai]();
      });
    }, function () {
      A.showDisconnect('lost');
    });
  }

  /* ── spawn 组卡状态轮询（render.js 零 fetch 纪律的配套面——DOM 钩子驱动） ── */
  var SPAWN_ST = { queued: ['排队中', 'st-run'], running: ['运行中', 'st-run'], completed: ['已完成', 'st-ok'], failed: ['失败', 'st-err'] };
  function pollSpawnGroups() {
    if (!currentSid) return undefined;
    /* W3：已开 agent tab 也驱动名册轮询（状态点/审批条新鲜）——组卡行或选项卡条任一在即取 */
    if (document.querySelector('.spawn-group .sg-row') === null && document.querySelector('#pt-list .pt-item') === null) return undefined;
    return A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/tasks', { timeoutMs: 9000 }).then(function (r) {
      updateSpawnGroups(r.rows ?? []);
    }, function () { /* 静默——下一拍再试 */ });
  }
  function updateSpawnGroups(rows) {
    taskRoster = rows; /* 名册缓存（agentTabDot 状态点 + 审批条数据源——W3） */
    refreshAgentTabDots(); /* 已开 agent tab 状态点联动（dotOf 注入实现，签名门） */
    document.querySelectorAll('.spawn-group').forEach(function (g) {
      var n = 0, running = 0, done = 0, failed = 0;
      g.querySelectorAll('.sg-row[data-agent-id]').forEach(function (row) {
        n++;
        var id = row.getAttribute('data-agent-id');
        var e = rows.find(function (x) { return x.id === id; });
        if (!e) return;
        var st = SPAWN_ST[e.status] ?? [String(e.status), 'st-run'];
        var stEl = row.querySelector('.sg-st');
        if (stEl) {
          stEl.textContent = st[0] + (e.pendingApproval ? ' · 等审批' : '');
          stEl.className = 'sg-st ' + st[1] + (e.pendingApproval ? ' st-warn' : '');
        }
        if (e.status === 'running' || e.status === 'queued') running++;
        else if (e.status === 'completed') done++;
        else if (e.status === 'failed') failed++;
      });
      var sum = g.querySelector('.sg-sum');
      if (sum && n > 0) {
        /* 头行聚合（TUI agentGroupLines 同款四态）：活动>0 运行中 M；全成 已完成；全败 失败；混合 M/N 完成 */
        sum.textContent = '· ' + n + ' 个任务 · ' +
          (running > 0 ? '运行中 ' + running + (done + failed > 0 ? ' · 已终 ' + (done + failed) : '')
            : failed === 0 ? '全部完成'
            : done === 0 ? '全部失败'
            : done + '/' + n + ' 完成');
      }
    });
  }
  /* 全局 Esc（输入框外）：确认层/居中弹窗让位（T15 处理器管）→ 浮层 → 悬浮卡 → 双击停止 */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (document.activeElement !== input) handleEscGlobal();
  });
  boot();
})();
