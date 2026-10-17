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
      toast(ok ? okMsg : OrosusI18N.t('web.common.copyFail'));
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
      if (draftActive) { /* 走查修⑮⑦：草稿态选目录只改草稿归属——首条消息才落桶（不提前建会话） */
        draftCwd = cwd;
        syncCwdGate();
        toast(OrosusI18N.t('web.cwd.toastPrefix') + name + OrosusI18N.t('web.cwd.draftNote'));
        return;
      }
      createSession({ cwd: cwd }).then(function (r) {
        if (r) toast('工作目录 → ' + name + '（已在该目录开会话，原空会话保留）');
      });
    },
    onBrowseFolder: function () { openDirPicker(); }, /* cwd 菜单「📂 浏览文件夹…」（走查八轮：重新选择文件夹——任意目录下钻） */
    onManageModels: function () { openSettingsRoot(2); }, /* 模型菜单「管理模型」→ 设置·提供商页（外观页插位后 idx 1→2） */
  });

  /* web-dialog 批 T8：dialog 上行口与大窗壳注入（app.js 在 ui.js/dialog.js 之后装配——经注入口，不反向依赖）。
   * 上行：sid 在事件入队时捕获（dialog.js 持开窗会话）——切会话后在途事件仍回旧会话端点，对端幂等 noop；
   * 失败 toast 不阻断队列（设计 §6.5）。大窗壳：viewText full/center80 走 modalStack（空白登记 #8——单向
   * 消息窗，关闭纯本地不发 dialog-event）。 */
  UI.setViewModal(function (o) {
    var lb = launcherBack; launcherBack = false; /* 走查②标记转移：总览→窗→笔记链——正文窗关闭时的回跳归属见 modalClose */
    openModal({ title: o.title, en: 'VIEW', bodyHtml: o.bodyHtml, view: true, foot: OrosusI18N.t('web.ui.view.footText'), ...(o.back ? { backCmd: o.back, keepLauncher: lb } : { backLauncher: lb }) });
  });
  if (globalThis.OrosusDialog && typeof globalThis.OrosusDialog.wire === 'function') {
    globalThis.OrosusDialog.wire({
      post: function (sid, body) {
        return A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/dialog-event', { method: 'POST', body: JSON.stringify(body) });
      },
      getSid: function () { return currentSid ?? ''; },
      toast: function () { toast(OrosusI18N.t('web.toast.dialogSendFail'), 3200); },
      onUserClose: function () { /* 走查（2026-10-16 用户口令②）：用户 Esc/✕ 关窗——总览来源则回总览页（supersede 关不触发） */
        if (launcherBack) { launcherBack = false; openLauncherWindow(); }
      },
    });
  }

  /* 走查修（2026-10-15 用户报障「索引里头点了报错」）：相对引用点击提示——MEMORY.md 索引类 viewText
   * 里的 [标题](笔记.md) 经 render.js 链接加固钩子剥 href 标 md-ref（无 HTTP 路由，点了会整页 unauthorized）。
   * document 级委托收口——流区/dock 浮层/大窗弹层三面的 a.md-ref 一处通用。 */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a.md-ref') : null;
    if (a) toast('「' + (a.getAttribute('data-ref') || '') + OrosusI18N.t('web.toast.mdRefPost'), 3200);
  });

  /* ── 发送管线（命令与消息统一口：202 受理即回——output/mark/queued 按 T6 协议分发） ── */
  var BTW_PREFIX_RE = /^\/btw(\s|$)/i; /* /btw 前缀判定唯一口径（W6复核修 Minor#1）：截获存文（handleSendResponse）与失败清存（handleSendError）共用——ignoreCase 交集，杜绝大小写漏捕/误捕 */
  function sendCore(text, imageIds, promptId) {
    launcherBack = false; /* 新命令出手即换源（走查②：总览回跳标记只属上一条启动器命令——启动器 onClick 在 sendCommandText 返回后重置） */
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
    toast(OrosusI18N.t('web.toast.sendFail') + err.message);
  }
  function submit() {
    if (UI.pickCurrent()) return; /* 浮层开着时点发送键 = 确认当前选中行（与 Enter 同效；view 窗不拦截） */
    var text = input.value.trim();
    if (text === '') return;
    if (draftActive) { sendDraft(text, attachments.slice()); return; } /* 走查修⑮⑦：草稿态首条消息 = 先建后发 */
    if (currentSid === null) { toast(OrosusI18N.t('web.welcome.noSession.pick')); return; }
    var imgs = attachments.slice();
    if (imgs.some(function (a) { return a.failed; })) { toast(OrosusI18N.t('web.toast.attachFailed')); return; }
    if (imgs.some(function (a) { return !a.id; })) { toast(OrosusI18N.t('web.toast.attachUploading')); return; }
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
  /** 走查修⑮⑦（2026-10-14 用户口令）：草稿态首发——先建会话（落 draftCwd 所在桶）再发消息。
   *  createSession 内部已完成 pollSessions + switchTo（currentSid 就位），随后走正常 sendCore 链。
   *  建失败（toast 已示）= 还原输入并复位，不携 draftCwd 重试。 */
  function sendDraft(text, imgs) {
    if (imgs.some(function (a) { return a.failed; })) { toast(OrosusI18N.t('web.toast.attachFailed')); return; }
    if (imgs.some(function (a) { return !a.id; })) { toast(OrosusI18N.t('web.toast.attachUploading')); return; }
    var ids = imgs.map(function (a) { return a.id; });
    input.value = '';
    autogrow();
    sendingNow = true;
    syncSendBtn();
    createSession({ cwd: draftCwd }).then(function (r) {
      if (!r) { /* 建会话失败（createSession 已 toast）——还原输入并复位发送态 */
        sendingNow = false;
        input.value = text;
        autogrow();
        syncSendBtn();
        return;
      }
      draftActive = false;
      return sendCore(text, ids, newPromptId());
    }).then(
      function (r) { if (r) handleSendResponse(r, text); },
      function (err) { handleSendError(err, text); },
    );
  }
  /** 斜杠菜单技能区/命令区选中 → 提交（ui.js 已清输入框）。 */
  function sendCommandText(text) {
    if (draftActive) { sendDraft(text, []); return; } /* 走查修⑮⑦：斜杠命令同走首发先建 */
    if (currentSid === null) { toast(OrosusI18N.t('web.welcome.noSession.pick')); return; }
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
      UI.openView({ title: OrosusI18N.t('web.view.cmdOutTitle'), en: 'OUTPUT', bodyHtml: '<div class="pu-text">' + esc(output) + '</div>', foot: OrosusI18N.t('web.ui.view.footDefault') });
    } else {
      toast(output, 6000);
    }
  }
  /** mark 路由信号分发（T6 全集）：quit/new/fork/menu:model/tasks；skill 标记行随 user/message 事件回流。 */
  function handleMark(mark, r) { /* r = send 响应（走查修：btw mark 携带 btwRounds 归档轮次透传 cmdBtw） */
    if (mark === 'quit') {
      toast(OrosusI18N.t('web.toast.quit'));
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
          ? OrosusI18N.t('web.composer.attach.stopChip') /* 失败态静止占位（T16 复核 Minor②——spinner 不再永转） */
          : OrosusI18N.t('web.composer.attach.waitingChip') + spinSvg('', 15);
      return '<span class="attach-thumb">' + inner +
        (a.failed ? OrosusI18N.t('web.composer.attach.failBadge') : '') +
        '<button type="button" class="ax" data-ax="' + i + OrosusI18N.t('web.composer.attach.removeBtn');
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
    if (room <= 0) { toast(OrosusI18N.t('web.composer.attach.limitReached')); return; }
    if (files.length > room) { toast(OrosusI18N.t('web.composer.attach.limitPartial')); files = files.slice(0, room); }
    if (currentSid === null) { toast(OrosusI18N.t('web.welcome.noSession.paste')); return; }
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
        toast(OrosusI18N.t('web.toast.attachUploadFail') + a.name);
      });
    });
    toast(OrosusI18N.t('web.toast.attachPasted'));
  });

  /* ── 队列条（D2：queue 帧整表快照 = 唯一真源；点击撤回） ── */
  function renderQueue(items) {
    if (!items || items.length === 0) { queuebar.classList.remove('has'); queuebar.innerHTML = ''; return; }
    queuebar.classList.add('has');
    queuebar.innerHTML = items.map(function (q) {
      return '<div class="queue-row" data-q="' + q.index + OrosusI18N.t('web.composer.queue.rowTitle') +
        '<span>⌛</span><span class="qtext">' + esc(q.text) + OrosusI18N.t('web.composer.queue.rowState');
    }).join('') + OrosusI18N.t('web.composer.queue.hint');
  }
  queuebar.addEventListener('click', function (e) {
    var row = e.target.closest('.queue-row');
    if (!row || currentSid === null) return;
    var idx = parseInt(row.getAttribute('data-q'), 10);
    A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/queue/' + idx, { method: 'DELETE', body: '' })
      .then(function () {
        toast(OrosusI18N.t('web.toast.queueRecalled'));
      }, function (err) {
        if (err.status === 404) return; /* 并发撤回被 server 表重算吸收——静默 */
        toast(OrosusI18N.t('web.toast.queueRecallFail') + err.message);
      });
  });

  /* ── 发送键四态（D11：idle/ready/sending/stop ■）+ busy 期点击 = 停止 ── */
  function syncSendBtn() {
    sendBtn.classList.remove('idle', 'ready', 'sending', 'stop');
    if (busy) { sendBtn.classList.add('stop'); sendBtn.textContent = '■'; sendBtn.title = OrosusI18N.t('web.composer.send.stopTitle'); return; }
    if (sendingNow) { sendBtn.classList.add('sending'); sendBtn.innerHTML = spinSvg('', 13); sendBtn.title = OrosusI18N.t('web.composer.send.sendingTitle'); return; }
    if (input.value.trim() !== '') { sendBtn.classList.add('ready'); sendBtn.textContent = '↑'; sendBtn.title = OrosusI18N.t('web.composer.send.title'); return; }
    sendBtn.classList.add('idle');
    sendBtn.textContent = '↑';
    sendBtn.title = OrosusI18N.t('web.composer.send.title');
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
        toast(OrosusI18N.t('web.toast.escStopAll'));
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

  /* ── ＋ 文件（D7：光标处插入 @ 并开文件菜单。走查修⑫：@ 菜单开着时再点 = 收——toggle 统一口径） ── */
  $('btn-file').addEventListener('click', function () {
    if (UI.openKind() === 'at') { UI.closePopup(); return; }
    var v = input.value;
    var pos = input.selectionStart ?? v.length;
    input.value = v.slice(0, pos) + '@' + v.slice(pos);
    input.focus();
    input.selectionStart = input.selectionEnd = pos + 1;
    UI.inputChanged(input);
  });

  /* ── cwd 切换芯片（D5：仅空会话——C1 事件数判据；候选 = 项目池含 hidden 找回） ── */
  function syncCwdGate() {
    var empty = draftActive || (currentSid !== null && !render.userSeen()); /* 走查修⑮⑦：草稿态也算空会话（cwd 芯片在场） */
    cwdChip.hidden = !empty;
    var nm = (draftActive ? draftCwd : sessionCwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    $('cwd-name').textContent = nm || OrosusI18N.t('web.cwd.chipPick');
  }
  cwdChip.addEventListener('click', function () {
    if (cwdChip.hidden) { toast(OrosusI18N.t('web.cwd.lockedToast')); return; }
    var pool = projectsPool.slice();
    if (sessionCwd !== '' && !pool.some(function (p) { return p.cwd === sessionCwd; })) {
      pool.push({ cwd: sessionCwd, name: sessionCwd.split(/[\\/]/).pop() || sessionCwd });
    }
    if (pool.length === 0) { openDirPicker(); return; } /* 无已知项目池 → 直接进浏览窗（走查八轮） */
    if (UI.isAnchorOpen(cwdChip)) { UI.closePopup(); return; } /* 走查修⑫：toggle 统一口径 */
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
      title: OrosusI18N.t('web.cwd.pickerTitle'),
      en: 'BROWSE',
      bodyHtml: OrosusI18N.t('web.cwd.pickerBody'),
      actionsHtml: OrosusI18N.t('web.cwd.pickerActions'),
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
      if (up !== null && up !== dpState.path) html += OrosusI18N.t('web.cwd.pickerParent');
      html += dirs.map(function (x) { return '<div class="dp-row" data-dp="' + esc(x.name) + '">📁 ' + esc(x.name) + '</div>'; }).join('');
      if (html === '') html = OrosusI18N.t('web.cwd.pickerNoSub');
      var list = $('dp-list');
      if (list) list.innerHTML = html;
      var inp = $('dp-input');
      if (inp && inp.value !== dpState.path) inp.value = dpState.path;
    }, function () {
      var list = $('dp-list');
      if (list) list.innerHTML = OrosusI18N.t('web.cwd.pickerUnreadable');
    });
  }

  /* ── 芯片：模型（D9）/ 思考档位（D10）/ 权限（D8）——status 装配显示面 ── */
  function modelTail(full) {
    var s = String(full ?? '');
    return s.indexOf('/') >= 0 ? s.slice(s.indexOf('/') + 1) : (s || OrosusI18N.t('web.composer.chipUnset'));
  }
  function syncChips(st) {
    sessionCwd = typeof st.cwd === 'string' ? st.cwd : sessionCwd;
    currentPerm = typeof st.permission === 'string' ? st.permission : currentPerm;
    currentEffort = typeof st.effort === 'string' ? st.effort : currentEffort;
    currentModel = typeof st.model === 'string' ? st.model : currentModel; /* 走查修⑨ */
    modelChip.innerHTML = esc(modelTail(st.model)) + ' <span class="dim">▾</span>';
    /* D10 口径：芯片显示 status.effort（未设置 = 目录默认档名）——永不渲染「自动」二字 */
    effortChip.innerHTML = OrosusI18N.t('web.composer.chipThink') + esc(currentEffort !== '' ? currentEffort : '—') + ' <span class="dim">▾</span>';
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
  /* 走查修⑫（2026-10-14 用户口令②）：芯片点击 toggle——本芯片菜单开着再点 = 关窗；开着别的窗
   *  点本芯片 = openXxx 直接换 pu 重渲（关旧开新同帧完成，无闪烁）。 */
  modelChip.addEventListener('click', function () { if (UI.isAnchorOpen(modelChip)) { UI.closePopup(); return; } UI.openModelMenu(modelChip); });
  effortChip.addEventListener('click', function () { if (UI.isAnchorOpen(effortChip)) { UI.closePopup(); return; } UI.openEffortMenu(effortChip); });
  modeChip.addEventListener('click', function () { if (UI.isAnchorOpen(modeChip)) { UI.closePopup(); return; } UI.openPermMenu(modeChip, currentPerm); });
  $('kv-model').addEventListener('click', function () { if (UI.isAnchorOpen(modelChip)) { UI.closePopup(); return; } UI.openModelMenu(modelChip); });
  syncSendBtn();

  /* ── interaction 应答口（ui.js 审批浮层 → POST /answer） ── */
  function answerInteraction(body) {
    return A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/answer', { method: 'POST', body: JSON.stringify(body) })
      .catch(function (err) {
        toast(OrosusI18N.t('web.toast.answerFail') + err.message);
        UI.invalidateCaches();
      });
  }

  /* ═══════════ GUI 外观：gui/gui.toml 为唯一事实源；localStorage 仅作旧版迁移与读取失败回退 ═══════════ */
  var btnTheme = $('btn-theme');
  var guiTheme = '连山'; /* i18n:brand：zh 系品牌名（glossary 定名）——不翻不键 */
  function applyTheme(light) {
    document.body.classList.toggle('light', light);
    btnTheme.innerHTML = '<span class="bi" aria-hidden="true">' + (light ? '☾ ' : '☀ ') + '</span><span data-i18n="' + (light ? 'web.shell.themeDark' : 'web.shell.themeLight') + '">' + OrosusI18N.t(light ? 'web.shell.themeDark' : 'web.shell.themeLight') + '</span>'; /* E6 机制 C：图标出文本节点（E9 span 结构）+ 随语言重建（chrome onI18NChange 调 applyTheme） */
  }
  function saveGuiAppearance(patch, onError) {
    return A.fetchJson('/api/settings/gui', { method: 'POST', body: JSON.stringify(patch) }).then(null, function (err) {
      if (onError) onError(err);
      toast(OrosusI18N.t('web.toast.guiSaveFail') + err.message);
      return null;
    });
  }
  btnTheme.addEventListener('click', function () {
    var previous = document.body.classList.contains('light');
    var next = !previous;
    applyTheme(next);
    saveGuiAppearance({ mode: next ? 'light' : 'dark' }, function () { applyTheme(previous); });
  });

  /* ═══════════ web-i18n（M4）：data-i18n 水合 + 取表 + 协议级兜底 ═══════════
   * 水合三态：[data-i18n]→textContent（图标挪出文本节点——.bi span 常驻，水合只写文案 span）、
   * [data-i18n-title]→title、[data-i18n-ph]→placeholder（E 任务按同构模式铺开）。
   * 取表 = M2 端点（服务端单一权威 web.* 切片）；失败 = #i18n-fail 协议级兜底（唯一白名单裸文案）。 */
  function hydrateI18n() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = OrosusI18N.t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.title = OrosusI18N.t(el.getAttribute('data-i18n-title')); });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.placeholder = OrosusI18N.t(el.getAttribute('data-i18n-ph')); });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', OrosusI18N.t(el.getAttribute('data-i18n-aria'))); }); /* E6 机制 A：aria 专位水合态（E9 借 -title 载体的过渡形退役——index.html 八处已翻 data-i18n-aria） */
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) { el.innerHTML = OrosusI18N.t(el.getAttribute('data-i18n-html')); }); /* E6 机制 D：HTML 值载体（断连 overlay 正文段——值含 <br>/<b> 标记，textContent 形不容；api.js 动态挂载） */
    document.documentElement.lang = OrosusI18N.cur();
  }
  var i18nListeners = [];
  function onI18NChange(fn) { i18nListeners.push(fn); } // M5 起自有消费（下方 chrome 重渲染注册）——E 任务再扩面
  function loadMessages(tag) {
    return A.fetchJson('/api/i18n/messages' + (tag ? '?tag=' + encodeURIComponent(tag) : '')).then(function (d) {
      OrosusI18N.setMessages(d.tag, d.messages);
      hydrateI18n();
      i18nListeners.forEach(function (fn) { fn(); });
      return d.tag;
    }, function () {
      var f = $('i18n-fail'); if (f) f.hidden = false; /* 协议级兜底（重试钮闭包恢复） */
      throw new Error('i18n messages unavailable');
    });
  }
  $('i18n-retry').addEventListener('click', function () {
    loadMessages(OrosusI18N.cur()).then(function () {
      var f = $('i18n-fail');
      if (f) f.hidden = true; /* 取表恢复——兜底块退场；boot 已拒则断连层在场，其「重试连接」走 health 探活整页重启 */
    }, function () { /* 仍取不到——兜底块保持，可再点 */ });
  });
  /* M5 chrome 重渲染：切语言 = 取表后广播（loadMessages 内 hydrateI18n 已刷静态壳）——此处补壳外随语言重建面。
   * 分栏/选项卡/btw 等轮询驱动面：2s 轮询自然以新语言重建（W3 轮询序既有行为）；进行中流视图的消息体是模型产出，不属界面文案，不重建。 */
  onI18NChange(function () {
    hydrateI18n(); // 静态壳（appbar/侧栏钮/welcome banner 文案）随表刷新
    applyTheme(document.body.classList.contains('light')); // 主题钮文案随语言重建（applyTheme 内含钮面文案）
    document.title = 'Orosus（' + OrosusI18N.t('web.shell.title'); /* E6 机制 B：tab 题合成（键为「连山）· Web」截段——闭半括在值内；boot 取表与切语言两路均经本监听 */
    if (typeof pageAppearance === 'function' && document.querySelector('[data-k="ap-lang"]')) { /* 设置页开着的情形由切换 handler 重建；非外观页的设置子页走各自的 setPageHandler 失效重建——C2 走查面 */ }
  });

  /* 整体字号写 --fz 驱动全表 font-size calc——只放大文字，框架/控件几何恒定。 */
  var FONT_SCALES = [
    { get name() { return OrosusI18N.t('web.settings.font.xs'); }, scale: 0.875 },
    { get name() { return OrosusI18N.t('web.settings.font.default'); }, scale: 1 },
    { get name() { return OrosusI18N.t('web.settings.font.l'); }, scale: 1.125 },
    { get name() { return OrosusI18N.t('web.settings.font.xl'); }, scale: 1.25 },
    { get name() { return OrosusI18N.t('web.settings.font.xxl'); }, scale: 1.4 }
  ];
  var fontScaleIdx = 1;
  function applyFontScale(i) {
    fontScaleIdx = i;
    document.documentElement.style.setProperty('--fz', String(FONT_SCALES[i].scale));
  }
  function fontScaleIndex(scale) {
    var idx = FONT_SCALES.findIndex(function (f) { return f.scale === scale; });
    return idx >= 0 ? idx : 1;
  }
  function clearLegacyAppearance() {
    try {
      localStorage.removeItem('orosus-web-theme');
      localStorage.removeItem('orosus-web-fontscale');
    } catch { /* 存储被拒 */ }
  }
  function loadGuiPreferences() {
    return A.fetchJson('/api/settings/gui').then(function (p) {
      var legacyMode = null;
      var legacyIdx = null;
      try {
        var oldTheme = localStorage.getItem('orosus-web-theme');
        if (oldTheme === 'light' || oldTheme === 'dark') legacyMode = oldTheme;
        var oldScale = parseInt(localStorage.getItem('orosus-web-fontscale') ?? '', 10);
        if (oldScale >= 0 && oldScale < FONT_SCALES.length) legacyIdx = oldScale;
      } catch { /* 存储被拒 */ }
      guiTheme = typeof p.theme === 'string' && p.theme !== '' ? p.theme : '连山'; /* i18n:brand */
      var hasAppearance = p.appearanceConfigured === true;
      var mode = hasAppearance ? p.mode : (legacyMode ?? p.mode);
      var scale = hasAppearance ? fontScaleIndex(p.fontScale) : (legacyIdx ?? fontScaleIndex(p.fontScale));
      applyTheme(mode === 'light');
      applyFontScale(scale);
      btwModelPref = typeof p.btwModel === 'string' && p.btwModel !== '' ? p.btwModel : null;
      btwModelPrefLoaded = true;
      if (hasAppearance) {
        clearLegacyAppearance();
        return null;
      }
      /* 首次迁移：浏览器旧值胜过默认值，完整落一份 GUI 配置后再清 localStorage。 */
      return A.fetchJson('/api/settings/gui', {
        method: 'POST',
        body: JSON.stringify({ theme: guiTheme, mode: mode, fontScale: FONT_SCALES[scale].scale, btwModel: p.btwModel ?? null }),
      }).then(function () { clearLegacyAppearance(); }, function () { /* 保留旧值，下次启动重试 */ });
    }, function () {
      /* 服务配置暂不可读时保持旧版行为，不让启动链断在偏好接口上。 */
      try {
        applyTheme(localStorage.getItem('orosus-web-theme') === 'light');
        var fsInit = parseInt(localStorage.getItem('orosus-web-fontscale') ?? '', 10);
        if (fsInit >= 0 && fsInit < FONT_SCALES.length) applyFontScale(fsInit);
      } catch { /* 存储被拒 */ }
    });
  }

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
  var currentModel = '';          /* 会话当前模型限定形（status.model——btw 芯片默认值的数据源，走查修⑨） */
  var btwModelPref = null;        /* 设置「侧问模型」偏好（gui/gui.toml；GET 启动恢复 + 写面同步） */
  var btwModelPrefLoaded = false;
  var guiPreferencesReady = null;
  var projectsPool = [];          /* cwd 芯片候选（bootstrap.projects——含 hidden 找回，D5） */
  var sendingNow = false;         /* 发送四态之「发送中」（POST 在途） */
  var escArmedAt = 0;             /* Esc 双击停止的 armed 时刻 */
  var launcherBack = false;       /* 走查（2026-10-16 用户口令②）：当前工具界面源自模块总览——用户关窗后回总览页（纯 GUI） */

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
    if (ms < 60 * 1000) return OrosusI18N.t('web.session.relJustNow');
    if (ms < 60 * 60 * 1000) return Math.floor(ms / 60000) + OrosusI18N.t('web.session.relMin');
    if (ms < 24 * 3600 * 1000) return Math.floor(ms / 3600000) + OrosusI18N.t('web.session.relHour');
    if (ms < 48 * 3600 * 1000) return OrosusI18N.t('web.session.relYesterday');
    if (ms < 7 * 24 * 3600 * 1000) return Math.floor(ms / 86400000) + OrosusI18N.t('web.session.relDay');
    if (ms < 14 * 24 * 3600 * 1000) return OrosusI18N.t('web.session.relWeek');
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
    if (s < 60) return s + OrosusI18N.t('web.settings.elapsed.sec');
    var m = Math.floor(s / 60);
    if (m < 60) return m + OrosusI18N.t('web.settings.elapsed.min') + (s % 60) + OrosusI18N.t('web.settings.elapsed.sec');
    var h = Math.floor(m / 60);
    return h + OrosusI18N.t('web.settings.elapsed.hour') + (m % 60) + OrosusI18N.t('web.settings.elapsed.min');
  }

  /* ═══════════ 左栏：渲染（B3/B5/B7/B14/B15） ═══════════ */
  var PHASE_DOT = { running: ['●', 'sdot-run'], 'waiting-approval': ['◉', 'sdot-wait'], 'waiting-input': ['◉', 'sdot-wait'], error: ['✗', 'sdot-err'], idle: ['○', 'sdot-idle'] };
  var PIN_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 7 3.2 3.2V16H6.8v-1.8L10 11 9 4z"/><path d="M12 16v5"/></svg>';
  var ARCHIVE_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h18v4H3z"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>';
  /* 项目组头文件夹标识（2026-10-13 用户口令：文件夹取代 ▾/▸ 小箭头，项目与会话行一眼可分；
   *  开合态用 folder-open/folder 双形表达，点击仍切换折叠） */
  var FOLDER_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
  var FOLDER_OPEN_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';

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
    var title = row.label !== '' ? row.label : (row.fresh ? OrosusI18N.t('web.session.freshTitle') : OrosusI18N.t('web.session.unnamedTitle'));
    return '<div class="ls-item' + (isCur ? ' cur' : '') + (pinned ? ' pinned-row' : '') + '" data-sid="' + esc(row.sid) + '" data-pinned="' + (pinned ? 1 : '') + '">' +
      sactHtml(act) +
      '<span class="stitle" title="' + esc(title) + '">' + esc(title) + '</span>' +
      (isCur ? OrosusI18N.t('web.session.curTag') : '') +
      '<button class="sact-btn spin-pin" data-sact="pin" title="' + (pinned ? OrosusI18N.t('web.session.unpin') : OrosusI18N.t('web.session.pin')) + '">' + PIN_SVG + '</button>' +
      (row.fresh ? '' : '<button class="sact-btn" data-sact="archive" title="' + OrosusI18N.t('web.session.archiveBtn') + '">' + ARCHIVE_SVG + '</button>') +
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
      html += OrosusI18N.t('web.session.pinnedHeader') + sessionsData.pinned.length + OrosusI18N.t('web.session.collapseBtn');
      html += sessionsData.pinned.map(function (s) { return lsRowHtml(s, prevRowMap.get(s.sid), true, sact, seen); }).join('');
    } else {
      html += OrosusI18N.t('web.session.collapseBtnEmpty');
    }
    html += OrosusI18N.t('web.session.projectsHeader') + sessionsData.groups.length + '</span></div>';
    sessionsData.groups.forEach(function (g) {
      var open = groupOpen[g.cwd] !== false;
      var limit = groupShow[g.cwd] ?? 5;
      html += '<div class="ls-group" data-group="' + esc(g.cwd) + '" data-path="' + esc(g.cwd) + '"><span class="gicon">' + (open ? FOLDER_OPEN_SVG : FOLDER_SVG) + '</span><span class="gname">' + esc(g.name) + '</span><span class="gcount">' + g.sessions.length + OrosusI18N.t('web.session.groupActs');
      if (open) {
        html += g.sessions.slice(0, limit).map(function (s) { return lsRowHtml(s, prevRowMap.get(s.sid), false, sact, seen); }).join('');
        if (g.sessions.length > limit) {
          html += '<div class="ls-more" data-more="' + esc(g.cwd) + '">' + OrosusI18N.t('web.session.morePre') + (g.sessions.length - limit) + OrosusI18N.t('web.session.morePost');
        }
      }
    });
    if (sessionsData.groups.length === 0) html += OrosusI18N.t('web.session.noProjects');
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
    return f.row.label !== '' ? f.row.label : (f.row.fresh ? OrosusI18N.t('web.session.freshTitle') : OrosusI18N.t('web.session.unnamedTitle'));
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
  $('btn-new').addEventListener('click', function () { openDraft(); }); /* 走查修⑮⑦：只开新会话窗，首发才落桶 */
  function createSession(body) {
    return A.fetchJson('/api/sessions', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      if (r.reused) toast(OrosusI18N.t('web.toast.sessionReused'));
      /* 先刷新左栏再切视图（2026-10-12 走查修——「新会话不立即出现在列表」根因：switchTo 只重渲
       *  旧 sessionsData，新行要等 2s 轮询；pollSessions 先行让新行与「当前」高亮一步到位） */
      return pollSessions().then(function () { return switchTo(r.sid); }).then(function () { return r; });
    }, function (err) { toast(OrosusI18N.t('web.toast.createFail') + err.message); });
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
    }, function (err) { toast(OrosusI18N.t('web.toast.openFail') + err.message); });
  }
  /* 置顶（B2/B11） */
  function togglePin(sid) {
    A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/pin', { method: 'POST', body: '{}' }).then(function (r) {
      toast(r.pinned ? OrosusI18N.t('web.toast.pinnedPre') + rowTitle(sid) + '」' : OrosusI18N.t('web.toast.unpinnedPre') + rowTitle(sid) + '」');
      void pollSessions();
    }, function (err) { toast(OrosusI18N.t('web.toast.pinFail') + err.message); });
  }
  /* 归档（B12）：归档当前会话 → 切剩余首个（置顶优先） */
  function archiveSession(sid) {
    A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/archive', { method: 'POST', body: '{}' }).then(function () {
      toast(OrosusI18N.t('web.toast.archivedPre') + rowTitle(sid) + OrosusI18N.t('web.toast.archivedPost'));
      return afterMaybeCurrentGone(sid);
    }, function (err) { toast(OrosusI18N.t('web.toast.archiveFail') + err.message); });
  }
  /* 删除（B11）：overlay2 确认层叠于设置弹窗之上 */
  function deleteSession(sid) {
    A.fetchJson('/api/sessions/' + encodeURIComponent(sid), { method: 'DELETE' }).then(function () {
      toast(OrosusI18N.t('web.toast.deletedPre') + rowTitle(sid) + '」');
      var m = sactAll(); delete m[sid]; saveJson(SACT_KEY, m);
      return afterMaybeCurrentGone(sid);
    }, function (err) { toast(OrosusI18N.t(err.status === 409 ? 'web.toast.deleteDenied' : 'web.toast.deleteFail') + err.message); });
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
      tailEl.textContent = OrosusI18N.t('web.welcome.noSession.start');
      return undefined;
    });
  }
  /* 重命名（B11）：弹窗输入 → POST /api/sessions/:sid/title（setTitle 旁路写——任意会话可达，
   *  不碰 host、不切当前会话；T15 审查补漏端点）。 */
  function renameSession(sid) {
    modalClose();
    openModal({
      title: OrosusI18N.t('web.session.renameTitle'),
      en: sid,
      bodyHtml: OrosusI18N.t('web.session.renameRow'),
      actionsHtml: OrosusI18N.t('web.session.renameActions'),
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
      el.value = rowTitle(sid) === OrosusI18N.t('web.session.unnamedTitle') ? '' : rowTitle(sid); /* web-i18n E8：占位符比较改对 t() 源（原对中文裸串比对——译值下重命名预填失配，E7 sec/isProj 同型修） */
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
      toast(OrosusI18N.t('web.toast.renamed') + name);
      /* 本地即时补（旁路写不经 host——无 SSE label 帧）：当前会话顶栏同步 + 左栏行标签刷新 */
      if (sid === currentSid) setSessionTitle(name, sid);
      var f = findRow(sid);
      if (f) f.row.label = name;
      void pollSessions();
    }, function (err) { toast(OrosusI18N.t('web.toast.renameFail') + err.message); });
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
        toast(OrosusI18N.t('web.toast.exported') + a.download);
      });
    }, function (err) { toast(OrosusI18N.t('web.toast.exportFail') + err.message); });
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
    ctxMenu.innerHTML = '<button class="ctx-item" data-ctx="copy">' + ic('copy') + OrosusI18N.t('web.session.ctxCopyPath') +
      '<button class="ctx-item danger" data-ctx="remove">' + ic('folderX') + OrosusI18N.t('web.session.ctxRemoveWs');
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
      '<button class="ctx-item" data-ctx="fork">' + ic('fork') + OrosusI18N.t('web.session.ctxFork') +
      '<button class="ctx-item" data-ctx="pin">' + ic('pin') + (f.pinned ? OrosusI18N.t('web.session.unpin') : OrosusI18N.t('web.session.pin')) + '</button>' +
      (f.row.fresh ? '' : '<button class="ctx-item" data-ctx="archive">' + ic('archive') + OrosusI18N.t('web.session.ctxArchive') + '</button>') +
      '<button class="ctx-item" data-ctx="rename">' + ic('edit') + OrosusI18N.t('web.session.ctxRename') +
      '<button class="ctx-item" data-ctx="copyid">' + ic('copy') + OrosusI18N.t('web.session.ctxCopyId') +
      '<button class="ctx-item" data-ctx="export">' + ic('download') + OrosusI18N.t('web.session.ctxExport') +
      '<button class="ctx-item danger" data-ctx="delete">' + ic('trash') + OrosusI18N.t('web.session.ctxDelete');
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
    if (act === 'copy') copyText(g.cwd, OrosusI18N.t('web.toast.copiedPath'));
    else if (act === 'remove') {
      var currentInGoneWs = currentSid !== null && findGroupOfSid(currentSid)?.cwd === g.cwd;
      openConfirm({
        title: OrosusI18N.t('web.session.removeWsTitle'),
        bodyHtml: OrosusI18N.t('web.session.removeWsPre') + esc(g.name) + '</b>」？\n\n' +
          '<span class="info">' + esc(g.cwd) + '</span>\n\n' +
          OrosusI18N.t('web.session.removeWsNote'),
        confirmText: OrosusI18N.t('web.session.removeConfirm'),
        onConfirm: function () {
          A.fetchJson('/api/workspaces/hide', { method: 'POST', body: JSON.stringify({ cwd: g.cwd }) }).then(function () {
            toast(OrosusI18N.t('web.toast.wsRemovedPre') + g.name + OrosusI18N.t('web.toast.wsRemovedPost'));
            if (currentInGoneWs) return afterMaybeCurrentGone(currentSid);
            return pollSessions();
          }, function (err) { toast(OrosusI18N.t('web.toast.removeFail') + err.message); });
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
      copyText(sid, OrosusI18N.t('web.toast.copiedSid') + sid);
    } else if (act === 'export') {
      exportSession(sid);
    } else if (act === 'delete') {
      openConfirm({
        title: OrosusI18N.t('web.session.deleteTitle'),
        bodyHtml: OrosusI18N.t('web.session.deletePre') + esc(rowTitle(sid)) + OrosusI18N.t('web.session.deletePost') + '\n\n' + OrosusI18N.t('web.session.deleteNote'),
        confirmText: OrosusI18N.t('web.session.deleteConfirm'),
        onConfirm: function () { void deleteSession(sid); },
      });
    }
  }

  /* ═══════════ 确认弹窗层 overlay2（原型 :3569-3591 直裁——叠于设置弹窗之上） ═══════════ */
  var overlay2 = $('overlay2');
  var modal2 = $('modal2');
  var confirmYes = null; /* 当前确认弹窗的「确认」回调（openConfirm/closeConfirm 成对维护） */
  function openConfirm(opts) {
    modal2.innerHTML = '<div class="pu-head"><span class="pu-title">' + opts.title + '</span>' + OrosusI18N.t('web.shell.confirmClose') +
      '<div class="pu-body">' + opts.bodyHtml + '</div>' +
      OrosusI18N.t('web.shell.confirmActions') + (opts.confirmText ?? OrosusI18N.t('web.session.deleteConfirm')) + '</button></div>';
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
    modal.className = 'modal' + (top.wide ? ' settings-modal' : '') + (top.big ? ' compact-modal' : '') + (top.view ? ' view-modal' : ''); /* 走查修⑩②；view-modal = web-dialog 批 T8 viewText 大窗 */
    modal.innerHTML = '<div class="pu-head"><span class="pu-title">' + top.title + '</span>' +
      '<span class="pu-en">' + (top.en ?? '') + '</span>' +
      (modalStack.length > 1 ? OrosusI18N.t('web.shell.modalBack') : '') +
      OrosusI18N.t('web.shell.modalClose') +
      '<div class="pu-body">' + top.bodyHtml + '</div>' +
      (top.actionsHtml ? '<div class="pu-actions right">' + top.actionsHtml + '</div>' : '') +
      (top.foot ? '<div class="pu-foot">' + top.foot + '</div>' : '');
    overlay.hidden = false;
  }
  function openModal(opts) { modalStack.push(opts); renderModal(); }
  function modalReplace(opts) { modalStack[modalStack.length - 1] = opts; renderModal(); }
  function modalBack() { modalStack.pop(); renderModal(); }
  function modalClose() {
    /* 回跳归属（走查②④）：backCmd（模块 viewText back——详情返回列表）优先；无 back 才走总览回跳。
     * keepLauncher 串链：总览→窗→详情→Esc→列表→Esc→总览。 */
    var backCmd = null, keepLauncher = false, hadLb = false;
    modalStack.forEach(function (m) {
      if (m === undefined || m === null) return;
      if (m.backCmd) { backCmd = m.backCmd; keepLauncher = !!m.keepLauncher; }
      if (m.backLauncher) hadLb = true;
    });
    modalStack = [];
    renderModal();
    if (backCmd !== null) {
      sendCommandText(backCmd); /* 走查④（2026-10-16 用户口令「详情页关闭后返回列表页」）：回跑模块返回命令重开列表 */
      if (keepLauncher) launcherBack = true;
      return;
    }
    if (hadLb) openLauncherWindow(); /* 走查②：总览来源的正文大窗关闭 → 回总览页（GUI 专属行为） */
  }
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
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDateTime(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function kvRow(k, v, cls) {
    return '<span class="k">' + esc(k) + '</span><span class="v ' + (cls ?? '') + '">' + v + '</span>'; /* v 由调用方负责转义 */
  }
  function pageLoading(page, text) { setPageHandler = null; page.innerHTML = '<div class="sp-note">' + esc(text ?? OrosusI18N.t('web.common.loading')) + '</div>'; } /* web-i18n M4：默认文案入键（boot 序先取表后开窗） */
  function pageLoadError(page, err) { setPageHandler = null; page.innerHTML = '<div class="sp-note bad">' + esc(OrosusI18N.t('web.settings.loadFail') + (err && err.message ? err.message : OrosusI18N.t('web.settings.netError'))) + '</div>'; }

  var SET_PAGES = [
    { get name() { return OrosusI18N.t('web.settings.nav.general'); }, get desc() { return OrosusI18N.t('web.settings.nav.generalDesc'); }, render: pageGeneral },
    { get name() { return OrosusI18N.t('web.settings.nav.appearance'); }, get desc() { return OrosusI18N.t('web.settings.nav.appearanceDesc'); }, render: pageAppearance },
    { get name() { return OrosusI18N.t('web.settings.nav.providers'); }, get desc() { return OrosusI18N.t('web.settings.nav.providersDesc'); }, render: pageProviders },
    { get name() { return OrosusI18N.t('web.settings.nav.prefs'); }, get desc() { return OrosusI18N.t('web.settings.nav.prefsDesc'); }, render: pageModelPrefs }, /* 走查修⑨③ */
    { get name() { return OrosusI18N.t('web.settings.nav.skills'); }, get desc() { return OrosusI18N.t('web.settings.nav.skillsDesc'); }, render: pageSkills },
    { get name() { return OrosusI18N.t('web.settings.nav.hooks'); }, get desc() { return OrosusI18N.t('web.settings.nav.hooksDesc'); }, render: pageHooks },
    { name: 'MCP', get desc() { return OrosusI18N.t('web.settings.nav.mcpDesc'); }, render: pageMcp },
    { get name() { return OrosusI18N.t('web.settings.nav.memory'); }, get desc() { return OrosusI18N.t('web.settings.nav.memoryDesc'); }, render: pageMemory },
    { get name() { return OrosusI18N.t('web.settings.nav.archived'); }, get desc() { return OrosusI18N.t('web.settings.nav.archivedDesc'); }, render: pageArchived },
  ];

  /** 打开设置弹窗（原型 openSettingsRoot：居中双栏 wide；pageIdx = 初始页（E5 审阅/管理模型直达用））。 */
  function openSettingsRoot(pageIdx) {
    UI.closePopup();
    modalClose();
    openModal({
      wide: true,
      title: OrosusI18N.t('web.shell.settings'),
      en: 'SETTINGS',
      bodyHtml: '<div class="set-grid"><div class="set-nav" id="set-nav"></div><div class="set-page" id="set-page"></div></div>',
      foot: OrosusI18N.t('web.settings.foot'),
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
    return '<svg class="ring-svg' + (hot ? ' ring-hot' : '') + OrosusI18N.t('web.settings.ctxRingAria') + pct + '%">' +
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
      '<span class="dk-size">' + mb.toFixed(1) + ' MB</span><span class="dk-files">' + files + OrosusI18N.t('web.settings.diskFilesPost');
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
      page.innerHTML = spTitle(OrosusI18N.t('web.settings.nav.general'), 'GENERAL') +
        subHeadT(OrosusI18N.t('web.settings.ctxTitle')) +
        '<div class="gen-flex">' + genRingSvg(ctx.pct ?? 0, (ctx.pct ?? 0) >= 80) +
          '<div class="gen-legend">' +
            OrosusI18N.t('web.settings.kvModel') + esc(model) + '</span></div>' +
            OrosusI18N.t('web.settings.kvWindow') + (ctx.window ?? 0).toLocaleString() + ' tokens</span></div>' +
            OrosusI18N.t('web.settings.kvUsed') + (ctx.used ?? 0).toLocaleString() + '</span>（' + (ctx.pct ?? 0) + '%）</span></div>' +
            OrosusI18N.t('web.settings.kvInputTotal') + fmtK(tk.lifetimeInput) + '</span></div>' +
            OrosusI18N.t('web.settings.kvOutputTotal') + fmtK(tk.lifetimeOutput) + '</span></div>' +
          '</div></div>' +
        OrosusI18N.t('web.settings.ctxNote') + esc(fmtElapsed((d.runtime ?? { elapsedMs: 0 }).elapsedMs)) + '。</div>' +
        subHeadT(OrosusI18N.t('web.settings.tokenTitle'), true) +
        '<div class="stat-cards">' +
          genStat(OrosusI18N.t('web.settings.stat.sessionIn'), (tk.input ?? 0).toLocaleString(), 'tokens') +
          genStat(OrosusI18N.t('web.settings.stat.sessionOut'), (tk.output ?? 0).toLocaleString(), 'tokens') +
          genStat(OrosusI18N.t('web.settings.stat.projectIn'), fmtK(tk.lifetimeInput), 'tokens') +
          genStat(OrosusI18N.t('web.settings.stat.projectOut'), fmtK(tk.lifetimeOutput), 'tokens') +
        '</div>' +
        subHeadT(OrosusI18N.t('web.settings.diskTitle'), true) +
        '<div class="disk">' + disk.map(function (r) { return genDiskRow(r.name, r.mb ?? 0, r.files ?? 0); }).join('') + '</div>' +
        (total ? OrosusI18N.t('web.settings.diskTotalPre') + (total.mb ?? 0).toFixed(1) + ' MB · ' + (total.files ?? 0) + OrosusI18N.t('web.settings.diskFilesPost') : '') +
        OrosusI18N.t('web.settings.diskNote');
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
   *    POST /api/providers/cmd〔目录添加——provider import argv，T13 钉形〕；模型表增删 + defaultModel 选择〔走查修⑭〕） ── */
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
      page.innerHTML = '<div class="pf-headrow">' + spTitle(OrosusI18N.t('web.settings.provTitle'), 'PROVIDERS') +
        OrosusI18N.t('web.settings.provAddBtn') +
        '<div class="pf-list">' + provData.providers.map(function (p, pi) {
          return '<div class="pf-vrow" data-k="prov" data-v="' + pi + '">' + provIcon(p.key) +
            '<span class="vname">' + esc(p.name ?? p.key) + '</span><span class="vbadge">' + esc(p.proto ?? 'openai') + '</span>' +
            '<span class="vcount">' + (p.modelCount ?? (p.models ?? []).length) + OrosusI18N.t('web.settings.provCountPost');
        }).join('') + '</div>' +
        OrosusI18N.t('web.settings.provNote');
      paintVicos(page);
      setPageHandler = function (e) {
        var row = e.target.closest('[data-k="prov"]');
        if (row) { renderProviderForm(page, provData.providers[parseInt(row.getAttribute('data-v'), 10)], false); return; }
        if (e.target.closest('[data-k="prov-add"]')) renderProviderAdd(page);
      };
    }, function (err) { pageLoadError(page, err); });
  }
  /** 编辑 / 自定义手填表单（POST /api/providers upsert——writeNestedTable 路线）。
   *  走查修⑭（2026-10-14 用户口令「没有新增模型 id 的功能、自定义供应商啥都没有」）：模型表一期
   *  只读形态退役——编辑页与手填表单同面可增删（行尾 ✕ + 底部添加行，回车同效）。语义：
   *  · 增删后保存 = 声明模型表接管自动发现（槽内 models 键——目录优选/live 兜底让位）；
   *  · 「恢复自动发现」= 保存时摘键（spec.models: []），回到目录/端点发现；
   *  · 未触碰模型表的保存不带 models 键——不把自动发现意外冻结成自定义表；
   *  · 手填新槽可留空——保存后端点 live 清单自动填充，手填即接管。 */
  function renderProviderForm(page, p, isNew) {
    setPageHandler = null;
    var declared = p && Array.isArray(p.declaredModels) && p.declaredModels.length > 0 ? p.declaredModels : null;
    var mf = { /* 模型表工作态（本表单闭包共享） */
      list: (declared || (p && p.models) || []).slice(),
      dirty: false,
      reset: false,
      declared: declared,
    };
    var wantDef = p && p.defaultModel ? p.defaultModel : '';
    page.innerHTML =
      '<span class="pf-back" data-k="pf-back">‹ ' + provIcon(p ? p.key : 'custom') + ' ' + esc(isNew ? OrosusI18N.t('web.settings.formCustom') : (p.name ?? p.key)) + ' <span class="vbadge">' + (isNew ? OrosusI18N.t('web.settings.formManual') : OrosusI18N.t('web.common.edit')) + '</span></span>' +
      OrosusI18N.t('web.settings.fName') + esc(isNew ? '' : (p.key ?? '')) + '" placeholder="my-openai" ' + (isNew ? '' : 'readonly') + ' /></div>' +
      OrosusI18N.t('web.settings.fProto') + (!p || (p.proto ?? 'openai') === 'openai' ? ' selected' : '') + '>OpenAI</option><option value="anthropic"' + (p && p.proto === 'anthropic' ? ' selected' : '') + '>Anthropic</option></select></div>' +
      '<div class="pf-row"><label>API Key</label><div class="pf-key"><input autocomplete="off" class="fi" id="pf-key" type="password" placeholder="' + (!isNew && p && p.hasApiKey ? OrosusI18N.t('web.settings.keyConfigured') : 'sk-…') + OrosusI18N.t('web.settings.fEye') +
      '<div class="pf-row"><label>Base URL <span class="req">*</span></label><input autocomplete="off" class="fi" id="pf-url" value="' + esc(p && p.baseUrl ? p.baseUrl : '') + '" placeholder="https://api.example.com/v1" /></div>' +
      OrosusI18N.t('web.settings.fDefaultLabel') + (isNew
        ? OrosusI18N.t('web.settings.fDefaultPh')
        : '<select class="fsel" id="pf-def"></select>') + '</div>' +
      OrosusI18N.t('web.settings.fCtx') +
      OrosusI18N.t('web.settings.fModelsLabel') +
        '<div class="pf-models">' +
          OrosusI18N.t('web.settings.fModelsHead') +
          '<div id="pf-mrows"></div>' +
          OrosusI18N.t('web.settings.fModelsAdd') +
        '</div>' +
        '<div class="pf-mnote" id="pf-mnote"></div></div>' +
      '<div class="pu-actions"><span class="spacer"></span>' +
        (isNew ? '' : OrosusI18N.t('web.settings.fDeleteBtn')) +
        OrosusI18N.t('web.settings.fCancelBtn') +
        OrosusI18N.t('web.settings.fSaveBtn');
    paintVicos(page);
    page.querySelector('#pf-mnew').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addModelRow(page, mf); }
    });
    renderModelRows(page, mf, wantDef);
    setPageHandler = function (e) { providerFormAct(page, p, isNew, e, mf); };
  }
  /** 模型表工作区重渲（行 + 计数 + 来源/提示文案 + 默认模型下拉联动）。wantDef 仅首开（= 槽值默认）。 */
  function renderModelRows(page, mf, wantDef) {
    page.querySelector('#pf-mcount').textContent = String(mf.list.length);
    var rows = page.querySelector('#pf-mrows');
    var note = page.querySelector('#pf-mnote');
    var src = page.querySelector('#pf-msrc');
    var add = page.querySelector('.pf-madd');
    if (mf.reset) {
      rows.innerHTML = '';
      add.style.display = 'none';
      src.textContent = '';
      note.innerHTML = OrosusI18N.t('web.settings.mResetNote');
    } else {
      add.style.display = '';
      rows.innerHTML = mf.list.map(function (m, i) {
        return '<div class="pf-mrow"><input autocomplete="off" class="fi" value="' + esc(m) + '" readonly /><button type="button" class="pf-mdel" data-k="pf-mdel" data-m="' + i + OrosusI18N.t('web.settings.mDelBtn');
      }).join('');
      src.textContent = mf.declared !== null ? OrosusI18N.t('web.settings.srcCustom') : OrosusI18N.t('web.settings.srcAuto');
      note.innerHTML = (mf.dirty ? OrosusI18N.t('web.settings.mDirtyNote') : '') +
        (mf.declared !== null ? OrosusI18N.t('web.settings.mResetBtn') : '');
    }
    /* 默认模型下拉随表重建（编辑页）：选中值仍在表中则保留；被移出表 → 回落「不设」（保存即清默认） */
    var sel = page.querySelector('#pf-def');
    if (sel && sel.tagName === 'SELECT') {
      var cur = wantDef !== undefined ? wantDef : sel.value;
      sel.innerHTML = OrosusI18N.t('web.settings.noDefaultOpt') + mf.list.map(function (m) {
        return '<option value="' + esc(m) + '">' + esc(m) + '</option>';
      }).join('');
      sel.value = mf.list.indexOf(cur) >= 0 ? cur : '';
    }
  }
  function addModelRow(page, mf) {
    var inp = page.querySelector('#pf-mnew');
    var v = (inp.value || '').trim();
    if (v === '') return;
    if (/\s/.test(v) || v.length > 128) { toast(OrosusI18N.t('web.toast.modelIdInvalid')); return; }
    if (mf.list.indexOf(v) >= 0) { toast('「' + v + OrosusI18N.t('web.toast.modelDupPost')); return; }
    if (mf.list.length >= 64) { toast(OrosusI18N.t('web.toast.modelLimit')); return; }
    if (mf.reset) { mf.reset = false; mf.list = []; } /* 恢复态下又添加 = 取消恢复，从空表重建自定义 */
    mf.list.push(v);
    mf.dirty = true;
    inp.value = '';
    inp.focus();
    renderModelRows(page, mf);
  }
  function providerFormAct(page, p, isNew, e, mf) {
    if (e.target.closest('[data-k="pf-back"]') || e.target.closest('[data-k="pf-cancel"]')) { pageProviders(page); return; }
    if (e.target.closest('[data-k="pf-madd"]')) { addModelRow(page, mf); return; }
    var mdel = e.target.closest('[data-k="pf-mdel"]');
    if (mdel) {
      mf.list.splice(parseInt(mdel.getAttribute('data-m'), 10), 1);
      mf.dirty = true;
      mf.reset = false;
      renderModelRows(page, mf);
      return;
    }
    if (e.target.closest('[data-k="pf-mreset"]')) {
      mf.reset = !mf.reset;
      if (mf.reset) mf.dirty = true; /* 摘键回发现也是改动——保存须携带 models: [] */
      renderModelRows(page, mf);
      return;
    }
    if (e.target.closest('[data-k="pf-eye"]')) {
      var inp = page.querySelector('#pf-key');
      inp.type = inp.type === 'password' ? 'text' : 'password';
      return;
    }
    if (e.target.closest('[data-k="pf-del"]')) {
      openConfirm({
        title: OrosusI18N.t('web.settings.delProvTitle'),
        bodyHtml: OrosusI18N.t('web.settings.delProvPre') + esc(p.name ?? p.key) + OrosusI18N.t('web.settings.delProvPost') + '\n\n' + OrosusI18N.t('web.settings.delProvNote'),
        confirmText: OrosusI18N.t('web.settings.delProvTitle'),
        onConfirm: function () {
          A.fetchJson('/api/providers', { method: 'POST', body: JSON.stringify({ op: 'remove', slot: p.key, removeSecret: true }) }).then(function (r) {
            toast(OrosusI18N.t('web.toast.provRemoved') + (p.name ?? p.key));
            if (r && r.report && r.report.failed && r.report.failed.length) toast(OrosusI18N.t('web.toast.reloadPartialFail') + r.report.failed.map(function (f) { return f.name; }).join(', '));
            pageProviders(page);
          }, function (err) { toast(OrosusI18N.t('web.toast.deleteFail') + err.message); });
        },
      });
      return;
    }
    if (e.target.closest('[data-k="pf-save"]')) {
      var name = (page.querySelector('#pf-name').value || '').trim();
      var url = (page.querySelector('#pf-url').value || '').trim();
      var slot = isNew ? name : (p ? p.key : name);
      if (slot === '' || !/^[A-Za-z0-9_-]+$/.test(slot)) { toast(isNew ? OrosusI18N.t('web.toast.slotNameRequired') : OrosusI18N.t('web.toast.slotInvalid')); return; }
      if (!/^https?:\/\//.test(url)) { toast(OrosusI18N.t('web.toast.urlInvalid')); return; }
      var spec = { type: page.querySelector('#pf-proto').value, baseUrl: url };
      var key = (page.querySelector('#pf-key').value || '').trim(); /* 走查修⑮②：设置文本框统一忽略前后空格 */
      if (key !== '') spec.apiKey = key; /* 缺省 = 保留旧 $ENV: 引用（掩码不重发不清凭据） */
      var defEl = page.querySelector('#pf-def');
      var def = defEl ? (defEl.value || '').trim() : '';
      if (def !== '') spec.defaultModel = def; /* 缺省 = 清除默认（整表替换的普通字段） */
      var ctxW = parseInt((page.querySelector('#pf-ctx').value || '').trim(), 10);
      if (Number.isFinite(ctxW) && ctxW >= 1024) spec.contextWindow = ctxW; /* 缺省不动顶层 */
      /* 走查修⑭：模型表——恢复态 = []（摘键回自动发现）；改动过或本就自定义接管 = 携全表；
       *  未触碰且非接管态 = 不带键（自动发现不被意外冻结） */
      if (mf.reset) spec.models = [];
      else if (mf.dirty || mf.declared !== null) spec.models = mf.list;
      A.fetchJson('/api/providers', { method: 'POST', body: JSON.stringify({ op: 'upsert', slot: slot, spec: spec }) }).then(function (r) {
        toast(OrosusI18N.t('web.toast.savedPre') + slot + '」' + (r && r.report ? OrosusI18N.t('web.toast.savedPost') : ''));
        pageProviders(page);
      }, function (err) { toast(OrosusI18N.t('web.toast.saveFail') + err.message); });
    }
  }
  /** 添加供应商：目录搜索（models.dev 缓存——source 恒 cache）+ 自定义手填。 */
  function renderProviderAdd(page) {
    pageLoading(page);
    A.fetchJson('/api/providers/catalog').then(function (d) {
      /* 走查修⑮③：目录按供应商名排序（原名索引——用户口令「为啥没按提供商和名字排列」） */
      provData.vendors = (d.vendors ?? []).toSorted(function (a, b) {
        var an = String(a.name ?? a.key).toLowerCase(), bn = String(b.name ?? b.key).toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
      page.innerHTML = OrosusI18N.t('web.settings.addBack') +
        OrosusI18N.t('web.settings.provSearch') +
        '<div class="pf-list" id="pf-vlist">' + provData.vendors.map(function (v, vi) {
          return '<div class="pf-vrow" data-k="vend" data-v="' + vi + '" data-name="' + esc(String(v.name ?? '').toLowerCase()) + '">' + provIcon(v.key) +
            '<span class="vname">' + esc(v.name ?? v.key) + '</span><span class="vbadge">' + esc(v.proto ?? 'openai') + '</span>' +
            '<span class="vcount">' + (v.models ?? []).length + OrosusI18N.t('web.settings.vendorCountPost');
        }).join('') +
        '<div class="pf-vrow" data-k="vend-custom">' + provIcon('custom') + OrosusI18N.t('web.settings.customRow') +
        '</div>' +
        OrosusI18N.t('web.settings.addNote');
      paintVicos(page);
      var q = page.querySelector('#pf-q');
      q.addEventListener('input', function () {
        var s = q.value.trim().toLowerCase();
        page.querySelectorAll('#pf-vlist .pf-vrow[data-name]').forEach(function (r) {
          /* 走查修⑮③：过滤失效根因——.pf-vrow 的 display:flex 作者样式压过 UA 的 [hidden] 规则，
           *  r.hidden = true 根本不生效。改类切换（.pf-vrow.hide 置 none）。 */
          r.classList.toggle('hide', !r.getAttribute('data-name').includes(s));
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
      '<span class="pf-back" data-k="pf-back">‹ ' + provIcon(v ? v.key : 'catalog') + ' ' + esc(v ? v.name ?? v.key : OrosusI18N.t('web.settings.catalogName')) + OrosusI18N.t('web.settings.catalogBadge') +
      '<div class="pf-row"><label>API Key <span class="req">*</span></label><input autocomplete="off" class="fi" id="pf-key" type="password" placeholder="sk-…" /></div>' +
      '<div class="pf-row"><label>Base URL <span class="req">*</span></label><input autocomplete="off" class="fi" id="pf-url" value="' + esc(v ? v.baseUrl ?? '' : '') + '" /></div>' +
      OrosusI18N.t('web.settings.impDefaultLabel') +
        models.map(function (m, i) {
          return '<option value="' + esc(m.id) + '"' + (i === 0 ? ' selected' : '') + '>' + esc(m.label ?? m.id) + (m.ctx ? '（' + m.ctx + '）' : '') + '</option>';
        }).join('') + '</select></div>' +
      OrosusI18N.t('web.settings.importNotePre') + (models.length) + OrosusI18N.t('web.settings.importNotePost') +
      '<div class="pu-actions"><span class="spacer"></span>' +
        OrosusI18N.t('web.settings.fCancelBtn') +
        OrosusI18N.t('web.settings.impImportBtn');
    paintVicos(page);
    setPageHandler = function (e) {
      if (e.target.closest('[data-k="pf-back"]') || e.target.closest('[data-k="pf-cancel"]')) { renderProviderAdd(page); return; }
      if (e.target.closest('[data-k="pf-save"]')) {
        var key = (page.querySelector('#pf-key').value || '').trim();
        var url = (page.querySelector('#pf-url').value || '').trim();
        var def = page.querySelector('#pf-def').value;
        if (key === '') { toast(OrosusI18N.t('web.toast.keyRequired')); return; }
        if (!/^https?:\/\//.test(url)) { toast(OrosusI18N.t('web.toast.urlInvalid')); return; }
        var argv = ['provider', 'import', v.key, '--baseUrl', url, '--key', key, '--model', def];
        A.fetchJson('/api/providers/cmd', { method: 'POST', body: JSON.stringify({ argv: argv }) }).then(function (r) {
          if (r.code === 0) {
            toast(OrosusI18N.t('web.toast.importedPre') + (v.name ?? v.key) + '」' + (r.report ? OrosusI18N.t('web.toast.savedPost') : ''));
            pageProviders(page);
          } else {
            toast(r.out || OrosusI18N.t('web.toast.importFailCode') + r.code + '）');
          }
        }, function (err) { toast(OrosusI18N.t('web.toast.importFail') + err.message); });
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
      var btwCur = typeof pf.btwModel === 'string' ? pf.btwModel : ''; /* 走查修⑨③ */
      var visionCur = (vision !== 'off' && vision !== 'auto') ? vision : '';
      var turnCur = sub.maxTurns === null || sub.maxTurns === undefined ? '' : String(sub.maxTurns);
      var turnOpts = [
        { v: '', l: OrosusI18N.t('web.settings.turn.follow') },
        { v: '150', l: OrosusI18N.t('web.settings.turn.t150') },
        { v: '200', l: OrosusI18N.t('web.settings.turn.t200') },
        { v: '-1', l: OrosusI18N.t('web.settings.turn.unlimited') },
      ];
      if (turnCur !== '' && !turnOpts.some(function (o) { return o.v === turnCur; })) turnOpts.push({ v: turnCur, l: OrosusI18N.t('web.settings.turn.current') + turnCur });
      page.innerHTML = spTitle(OrosusI18N.t('web.settings.nav.prefs'), 'PREFERENCES') +
        OrosusI18N.t('web.settings.prefsNote') +
        mpRow(OrosusI18N.t('web.settings.mp.default'), '<select class="fsel" id="mp-model"><option value=""' + (current === '' ? ' selected' : '') + OrosusI18N.t('web.settings.mp.unset') + modelOptGroups(current, providers) + '</select>') +
        mpRow(OrosusI18N.t('web.settings.mp.vision'), '<select class="fsel" id="mp-vision">' +
          '<option value="off"' + (vision === 'off' ? ' selected' : '') + OrosusI18N.t('web.settings.mp.visionOff') +
          '<option value="auto"' + (vision === 'auto' ? ' selected' : '') + OrosusI18N.t('web.settings.mp.visionAuto') +
          (visionCur && !modelOptGroups(visionCur, providers).includes('value="' + esc(visionCur) + '"')
            ? '<option value="' + esc(visionCur) + '" selected>' + esc(visionCur) + OrosusI18N.t('web.settings.mp.current') : '') +
          modelOptGroups(visionCur, providers) + '</select>') +
        mpRow(OrosusI18N.t('web.settings.mp.search'), '<select class="fsel" id="mp-search">' +
          '<option value="auto"' + (search === 'auto' ? ' selected' : '') + OrosusI18N.t('web.settings.mp.searchAuto') +
          '<option value="llm"' + (search === 'llm' ? ' selected' : '') + OrosusI18N.t('web.settings.mp.searchLlm') +
          '<option value="tavily"' + (search === 'tavily' ? ' selected' : '') + OrosusI18N.t('web.settings.mp.searchTavily') +
          '<option value="brave"' + (search === 'brave' ? ' selected' : '') + OrosusI18N.t('web.settings.prefs.optBackendBrave')) +
        mpRow(OrosusI18N.t('web.settings.prefs.sideModel'), '<select class="fsel" id="mp-btwmodel"><option value=""' + (!btwCur ? ' selected' : '') + OrosusI18N.t('web.settings.prefs.optSideFollow') + modelOptGroups(btwCur, providers) + '</select>') + /* 走查修⑨③ */
        mpRow(OrosusI18N.t('web.settings.prefs.subagentModel'), '<select class="fsel" id="mp-submodel"><option value=""' + (!sub.model ? ' selected' : '') + OrosusI18N.t('web.settings.prefs.optSubagentFollow') +
          (sub.model && !modelOptGroups(sub.model, providers).includes('value="' + esc(sub.model) + '"')
            ? '<option value="' + esc(sub.model) + '" selected>' + esc(sub.model) + OrosusI18N.t('web.settings.mp.current') : '') +
          modelOptGroups(sub.model ?? '', providers) + '</select>') +
        mpRow(OrosusI18N.t('web.settings.prefs.approvalMode'), '<select class="fsel" id="mp-subapproval">' +
          '<option value=""' + (!sub.approvalMode ? ' selected' : '') + OrosusI18N.t('web.settings.prefs.optApprovalFollow') +
          '<option value="auto"' + (sub.approvalMode === 'auto' ? ' selected' : '') + OrosusI18N.t('web.settings.prefs.optNeverAsk') +
          '<option value="ask"' + (sub.approvalMode === 'ask' ? ' selected' : '') + OrosusI18N.t('web.settings.prefs.optAskRisky'), true) +
        mpRow(OrosusI18N.t('web.settings.prefs.maxRounds'), '<select class="fsel" id="mp-subturns">' + turnOpts.map(function (o) {
          return '<option value="' + esc(o.v) + '"' + (turnCur === o.v ? ' selected' : '') + '>' + esc(o.l) + '</option>';
        }).join('') + '</select>', true) +
        OrosusI18N.t('web.settings.prefs.noteSubagentItems');
      setPageHandler = null;
      var sel = function (id) { return page.querySelector('#' + id); };
      function postPref(key, value, okMsg, revert) {
        A.fetchJson('/api/settings/prefs', { method: 'POST', body: JSON.stringify({ key: key, value: value }) }).then(function () {
          toast(okMsg);
        }, function (err) {
          toast(OrosusI18N.t('web.toast.settingFail') + err.message);
          if (revert) revert();
        });
      }
      sel('mp-model').addEventListener('change', function () {
        var val = this.value;
        var prev = current;
        if (val === '') { this.value = prev; return; }
        if (currentSid === null) { toast(OrosusI18N.t('web.toast.modelSwitchNeedSession')); this.value = prev; return; }
        var parts = val.split('/');
        var mname = parts.slice(1).join('/');
        A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/model', { method: 'POST', body: JSON.stringify({ platform: parts[0], model: mname }) }).then(function () {
          current = val;
          toast(OrosusI18N.t('web.toast.modelSwitched') + val + OrosusI18N.t('web.toast.writtenConfigNextRound'));
        }, function (err) {
          toast(OrosusI18N.t('web.toast.switchFail') + err.message);
          var el = sel('mp-model');
          if (el) el.value = prev;
        });
      });
      sel('mp-vision').addEventListener('change', function () {
        var el = this; /* revert 闭包捕获元素——strict-mode 裸调用 this === undefined（审查 Important） */
        var v = this.value;
        postPref('visionModel', v, v === 'off' ? OrosusI18N.t('web.toast.visionSetDisabled') : v === 'auto' ? OrosusI18N.t('web.toast.visionSetAuto') : OrosusI18N.t('web.toast.visionSet') + v + OrosusI18N.t('web.toast.writtenToolMedia'), function () { el.value = vision; });
      });
      sel('mp-search').addEventListener('change', function () {
        var el = this;
        var v = this.value;
        var names = { auto: OrosusI18N.t('web.settings.prefs.optAuto'), llm: 'LLM Web Search', tavily: 'Tavily', brave: 'Brave' };
        postPref('search.backend', v, OrosusI18N.t('web.toast.searchBackendSet') + (names[v] ?? v) + OrosusI18N.t('web.toast.writtenToolWeb'), function () { el.value = search; });
      });
      sel('mp-btwmodel').addEventListener('change', function () {
        var el = this;
        var v = this.value;
        postPref('btwModel', v === '' ? null : v, v === '' ? OrosusI18N.t('web.toast.sideModelCleared') : OrosusI18N.t('web.toast.sideModelSet') + v + OrosusI18N.t('web.toast.writtenSideQuestion'), function () { el.value = btwCur; });
        btwModelPref = v === '' ? null : v; /* 芯片默认源同步（免等下次 GET） */
      });
      sel('mp-submodel').addEventListener('change', function () {
        var el = this;
        var v = this.value;
        postPref('model', v === '' ? null : v, v === '' ? OrosusI18N.t('web.toast.subagentModelCleared') : OrosusI18N.t('web.toast.subagentModelSet') + v + OrosusI18N.t('web.toast.writtenSubagentModel'), function () { el.value = sub.model ?? ''; });
      });
      sel('mp-subapproval').addEventListener('change', function () {
        var el = this;
        var v = this.value;
        postPref('approvalMode', v === '' ? null : v, v === '' ? OrosusI18N.t('web.toast.subagentApprovalFollow') : OrosusI18N.t('web.toast.subagentApprovalSet') + (v === 'auto' ? OrosusI18N.t('web.toast.subagentApprovalNever') : OrosusI18N.t('web.toast.subagentApprovalRisky')) + OrosusI18N.t('web.toast.writtenSubagentApproval'), function () { el.value = sub.approvalMode ?? ''; });
      });
      sel('mp-subturns').addEventListener('change', function () {
        var el = this;
        var v = this.value;
        postPref('maxTurns', v === '' ? null : parseInt(v, 10), v === '' ? OrosusI18N.t('web.toast.subagentRoundsFollow') : OrosusI18N.t('web.toast.subagentRoundsSet') + v, function () { el.value = turnCur; });
      });
    }, function (err) { pageLoadError(page, err); });
  }

  /* ── F4 技能（GET /api/settings/skills——行即详情五字段；POST toggle 写 [skill] disabled + reload） ── */
  /* ── F4 技能（2026-10-12 走查七轮重做：平铺名录 → 富列表行——状态点 + 双行文 + 行内启停拨杆 +
   *    范围徽标；点击行仍进详情。TUI 详情窗 Alt+K 的 web 化不变） ── */
  var SKILL_SCOPE = { get user() { return OrosusI18N.t('web.settings.skills.trackUser'); }, get project() { return OrosusI18N.t('web.settings.skills.trackProject'); }, get bundled() { return OrosusI18N.t('web.settings.skills.trackBuiltin'); } };
  function skillRowHtml(s) {
    return '<div class="lr-row' + (s.disabled ? ' off' : '') + '" data-k="skill" data-v="' + esc(s.name) + '">' +
      '<span class="mdot ' + (s.disabled ? 'off">○' : 'ok">●') + '</span>' +
      '<span class="lr-main"><span class="lr-name">' + esc(s.name) +
      ' <span class="lr-tag">' + esc(SKILL_SCOPE[s.scope] ?? s.scope ?? '') + '</span></span>' +
      (s.desc ? '<span class="lr-desc">' + esc(s.desc) + '</span>' : '') + '</span>' +
      '<button class="mc-toggle' + (s.disabled ? '' : ' on') + '" data-sw="' + esc(s.name) + '" role="switch" aria-checked="' + String(!s.disabled) + '" aria-label="' + esc(s.name) + OrosusI18N.t('web.settings.skills.toggleAria') + (s.disabled ? OrosusI18N.t('web.settings.skills.stateEnabled') : OrosusI18N.t('web.settings.skills.stateDisabled')) + '"></button>' +
      '<span class="lr-caret">›</span></div>';
  }
  function pageSkills(page) {
    pageLoading(page);
    A.fetchJson('/api/settings/skills').then(function (d) {
      var skills = d.skills ?? [];
      if (skills.length === 0) {
        page.innerHTML = spTitle(OrosusI18N.t('web.settings.nav.skills'), OrosusI18N.t('web.settings.skills.title')) + OrosusI18N.t('web.settings.skills.emptyNote');
        setPageHandler = null;
        return;
      }
      var offN = skills.filter(function (s) { return s.disabled; }).length;
      page.innerHTML = spTitle(OrosusI18N.t('web.settings.nav.skills'), OrosusI18N.t('web.settings.skills.title')) +
        OrosusI18N.t('web.settings.skills.sumTotal') + skills.length + OrosusI18N.t('web.settings.skills.sumEnabled') + (skills.length - offN) + OrosusI18N.t('web.settings.skills.sumDisabled') + offN + '</div>' +
        skills.map(skillRowHtml).join('') +
        OrosusI18N.t('web.settings.skills.note');
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
            toast((target ? OrosusI18N.t('web.toast.skillDisabled') : OrosusI18N.t('web.toast.skillEnabled')) + name + OrosusI18N.t('web.toast.skillReloaded'));
            UI.invalidateCaches(); /* 斜杠菜单技能区 30s 缓存同步失效 */
            /* 行原位刷新（零整页重拉——点/拨杆/统计三段换装） */
            var rowEl = sw.closest('.lr-row');
            if (rowEl) {
              rowEl.classList.toggle('off', target);
              var dot = rowEl.querySelector('.mdot');
              if (dot) { dot.className = 'mdot ' + (target ? 'off' : 'ok'); dot.textContent = target ? '○' : '●'; }
              sw.classList.toggle('on', !target);
              sw.setAttribute('aria-checked', String(!target));
              sw.title = target ? OrosusI18N.t('web.settings.skills.stateEnabled') : OrosusI18N.t('web.settings.skills.stateDisabled');
            }
            var sumEl = page.querySelector('.lr-sum');
            if (sumEl) {
              var off2 = skills.filter(function (x) { return x.disabled; }).length;
              sumEl.textContent = OrosusI18N.t('web.settings.skills.detailTotal') + skills.length + OrosusI18N.t('web.settings.skills.sumEnabled') + (skills.length - off2) + OrosusI18N.t('web.settings.skills.sumDisabled') + off2;
            }
          }, function (err) { toast(OrosusI18N.t('web.toast.opFail') + err.message); });
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
    page.innerHTML = OrosusI18N.t('web.settings.skills.back') +
      spTitle(OrosusI18N.t('web.settings.skills.detailTitle')) +
      '<div class="pu-kv">' +
      kvRow(OrosusI18N.t('web.settings.skills.fName'), esc(s.name)) +
      kvRow(OrosusI18N.t('web.settings.skills.fDesc'), esc(s.desc ?? '')) +
      (s.usage ? kvRow(OrosusI18N.t('web.settings.skills.fApplies'), esc(s.usage)) : '') +
      kvRow(OrosusI18N.t('web.settings.skills.fScope'), esc(s.scope ?? '')) +
      kvRow(OrosusI18N.t('web.settings.skills.fStatus'), s.disabled ? OrosusI18N.t('web.settings.skills.badgeDisabled') : OrosusI18N.t('web.settings.skills.badgeEnabled')) +
      /* 2026-10-12 走查：文件路径可点击——POST /api/open 系统默认程序打开 */
      kvRow(OrosusI18N.t('web.settings.skills.fFiles'), '<button type="button" class="kv-link" data-k="open-file" data-v="' + esc(s.file ?? '') + OrosusI18N.t('web.settings.skills.openWithTitle') + esc(s.file ?? '') + '</button>', 'info') +
      '</div>' +
      '<div class="pu-actions"><button class="btn" data-k="skill-toggle">' + (s.disabled ? OrosusI18N.t('web.settings.skills.stateEnabled') : OrosusI18N.t('web.settings.skills.stateDisabled')) + '</button></div>';
    setPageHandler = function (e) {
      if (e.target.closest('[data-k="skill-back"]')) { renderSetPage(4); return; } /* 技能页（外观插位后 3→4） */
      if (e.target.closest('[data-k="open-file"]')) {
        var path = e.target.closest('[data-k="open-file"]').getAttribute('data-v');
        A.fetchJson('/api/open', { method: 'POST', body: JSON.stringify({ path: path }) }).then(function () {
          toast(OrosusI18N.t('web.toast.openRequested'));
        }, function (err) { toast(OrosusI18N.t('web.toast.openPlainFail') + err.message); });
        return;
      }
      if (e.target.closest('[data-k="skill-toggle"]')) {
        var target = !s.disabled;
        A.fetchJson('/api/settings/skills/toggle', { method: 'POST', body: JSON.stringify({ name: s.name, disabled: target }) }).then(function () {
          s.disabled = target;
          toast((target ? OrosusI18N.t('web.toast.skillDisabled') : OrosusI18N.t('web.toast.skillEnabled')) + s.name + OrosusI18N.t('web.toast.skillReloaded'));
          UI.invalidateCaches(); /* 斜杠菜单技能区 30s 缓存同步失效 */
          renderSkillDetail(page, s);
        }, function (err) { toast(OrosusI18N.t('web.toast.opFail') + err.message); });
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
      (untrusted ? OrosusI18N.t('web.settings.hooks.tagUntrusted') : '') +
      '</span>' +
      '<span class="lr-desc mono">' + esc(h.command ?? '') + (h.matcher ? '　·　matcher: ' + esc(h.matcher) : '') + '</span></span>' +
      '<button class="mc-toggle' + (h.disabled ? '' : ' on') + '" data-sw="' + esc(comp) + '" role="switch" aria-checked="' + String(!h.disabled) + '" aria-label="' + esc(h.event) + OrosusI18N.t('web.settings.hooks.toggleAria') + (h.disabled ? OrosusI18N.t('web.settings.skills.stateEnabled') : OrosusI18N.t('web.settings.skills.stateDisabled')) + '"></button>' +
      '<span class="lr-caret">›</span></div>';
  }
  function pageHooks(page) {
    pageLoading(page);
    A.fetchJson('/api/settings/hooks').then(function (d) {
      var user = d.user ?? [];
      var proj = d.project ?? [];
      var trusted = !!d.projectTrusted;
      var sec = function (title, rows, isProj) { /* web-i18n E7：项目级判定改显式参（原 title.indexOf('项目') 对译文不稳） */
        return subHeadT(title + '（' + rows.length + '）', isProj) + (rows.length > 0 ? rows.map(function (h) {
          return hookRowHtmlV2(h, trusted);
        }).join('') : OrosusI18N.t('web.settings.hooks.emptyNoteA') + esc(isProj ? OrosusI18N.t('web.settings.hooks.emptyNotePath') : '~/.orosus/hooks') + OrosusI18N.t('web.settings.hooks.emptyNoteB'));
      };
      page.innerHTML = spTitle(OrosusI18N.t('web.settings.nav.hooks'), OrosusI18N.t('web.settings.hooks.title')) +
        sec(OrosusI18N.t('web.settings.hooks.levelUser'), user, false) + sec(OrosusI18N.t('web.settings.hooks.levelProjectTrust'), proj, true) +
        OrosusI18N.t('web.settings.hooks.note');
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
            toast((target ? OrosusI18N.t('web.toast.skillDisabled') : OrosusI18N.t('web.toast.skillEnabled')) + (h2.name ? h2.name : h2.event) + OrosusI18N.t('web.toast.rowWrittenReload'));
            var rowEl = sw.closest('.lr-row');
            if (rowEl) {
              rowEl.classList.toggle('off', target);
              var dot = rowEl.querySelector('.mdot');
              if (dot) { dot.className = 'mdot ' + (target ? 'off' : 'ok'); dot.textContent = target ? '○' : '●'; }
              sw.classList.toggle('on', !target);
              sw.setAttribute('aria-checked', String(!target));
              sw.title = target ? OrosusI18N.t('web.settings.skills.stateEnabled') : OrosusI18N.t('web.settings.skills.stateDisabled');
            }
          }, function (err) { toast(OrosusI18N.t('web.toast.opFail') + err.message); });
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
    page.innerHTML = OrosusI18N.t('web.settings.hooks.back') +
      spTitle(OrosusI18N.t('web.settings.hooks.detailTitle')) +
      '<div class="pu-kv">' +
      (h.name ? kvRow(OrosusI18N.t('web.settings.hooks.fDesc'), esc(h.name)) : '') +
      kvRow(OrosusI18N.t('web.settings.hooks.fEvent'), esc(h.event)) +
      (h.matcher ? kvRow('matcher', esc(h.matcher)) : '') +
      kvRow(OrosusI18N.t('web.settings.hooks.fCommand'), esc(h.command ?? ''), 'info') +
      kvRow(OrosusI18N.t('web.settings.hooks.fTimeout'), esc(String(h.timeout ?? HOOK_TIMEOUT_DEFAULT) + 's')) +
      kvRow(OrosusI18N.t('web.settings.hooks.fSource'), h.origin === 'user' ? OrosusI18N.t('web.settings.hooks.levelUser') : OrosusI18N.t('web.settings.hooks.levelProject')) +
      kvRow(OrosusI18N.t('web.settings.hooks.fTrustState'), h.origin === 'user' ? OrosusI18N.t('web.settings.hooks.userExempt') : (trusted ? OrosusI18N.t('web.settings.hooks.trusted') : OrosusI18N.t('web.settings.hooks.untrustedWarn'))) +
      '</div>' +
      '<div class="pu-actions">' +
      '<button class="btn" data-k="hook-toggle">' + (h.disabled ? OrosusI18N.t('web.settings.skills.stateEnabled') : OrosusI18N.t('web.settings.skills.stateDisabled')) + '</button>' +
      (h.origin === 'project' && !trusted ? OrosusI18N.t('web.settings.hooks.trustBtn') : '') +
      '</div>';
    setPageHandler = function (e) {
      if (e.target.closest('[data-k="hook-back"]')) { renderSetPage(5); return; } /* 钩子页（外观插位后 4→5） */
      if (e.target.closest('[data-k="hook-toggle"]')) {
        var target = !h.disabled;
        A.fetchJson('/api/settings/hooks/toggle', { method: 'POST', body: JSON.stringify({ file: h.file, event: h.event, tableIdx: h.tableIdx, hookIdx: h.hookIdx, disabled: target }) }).then(function () {
          h.disabled = target;
          toast((target ? OrosusI18N.t('web.toast.hookDisabled') : OrosusI18N.t('web.toast.hookEnabled')) + OrosusI18N.t('web.toast.rowWrittenReload'));
          renderHookDetail(page, h, trusted);
        }, function (err) { toast(OrosusI18N.t('web.toast.opFail') + err.message); });
      } else if (e.target.closest('[data-k="hook-trust"]')) {
        A.fetchJson('/api/settings/hooks/trust', { method: 'POST', body: '{}' }).then(function () {
          toast(OrosusI18N.t('web.toast.hookTrusted'));
          pageHooks(page);
        }, function (err) { toast(OrosusI18N.t('web.toast.trustFail') + err.message); });
      }
    };
  }

  /* ── F6 MCP（GET /api/settings/mcp——McpCatalogRow 五态；POST /api/settings/mcp/ops 七 op + 结构化 add）
   *  2026-10-12 走查二轮重构（对齐 TUI）：列表行 = 状态点（绿=已连接 / 红=失败 / 灰=停用·待启动）+
   *  名称 + 传输·工具数 + 行上「启动」（懒启动件）/「详情」钮——右侧状态文字退役；添加/修改窗对齐
   *  TUI Alt+N（mcp-add-window.ts）：手动/JSON 双页签、传输三档、高级区 env/headers/cwd/超时秒。 */
  var MCP_STATE_TEXT = { /* web-i18n E7：模块级标签图改 get 访问器（消费期取表）；disabled 位「已停用」与 hookDisabled 同串复用 */
    get connected() { return OrosusI18N.t('web.settings.mcp.stConnected'); },
    get idle() { return OrosusI18N.t('web.settings.mcp.stLazy'); },
    get failed() { return OrosusI18N.t('web.settings.mcp.stFailed'); },
    get disabled() { return OrosusI18N.t('web.toast.hookDisabled'); },
    get ['pending-confirm']() { return OrosusI18N.t('web.settings.mcp.stUnconfirmed'); },
  };
  var MCP_SOURCE_TEXT = {
    get config() { return OrosusI18N.t('web.settings.mcp.fConfigFile'); },
    get project() { return OrosusI18N.t('web.settings.mcp.projectConfig'); },
    get preload() { return OrosusI18N.t('web.settings.mcp.preinstalled'); },
  };
  var MCP_TRANSPORT_TEXT = {
    get stdio() { return OrosusI18N.t('web.settings.mcp.trStdio'); },
    get http() { return OrosusI18N.t('web.settings.mcp.trHttp'); },
    get sse() { return OrosusI18N.t('web.settings.mcp.trSse'); },
  };
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
    if (m.state === 'connected' && typeof m.toolCount === 'number') desc += ' · ' + m.toolCount + OrosusI18N.t('web.settings.mcp.toolsSuffix');
    var acts = '';
    if (m.deferred === true && (m.state === 'idle' || m.state === 'failed')) {
      acts += '<button class="btn tiny" data-k="mcp-start" data-v="' + esc(m.name) + OrosusI18N.t('web.settings.mcp.startBtnLazy');
    }
    acts += '<button class="btn tiny" data-k="mcp-detail" data-v="' + esc(m.name) + OrosusI18N.t('web.settings.mcp.detailsBtn');
    return mcpDot(m) +
      '<span class="pi-name">' + esc(m.name) + '</span><span class="pi-desc">' + esc(desc) + '</span><span class="pi-right mcp-acts">' + acts + '</span>';
  }
  function pageMcp(page) {
    pageLoading(page);
    A.fetchJson('/api/settings/mcp').then(function (d) {
      var servers = d.servers ?? [];
      page.innerHTML = '<div class="pf-headrow">' + spTitle('MCP', 'SERVERS · ' + servers.length + OrosusI18N.t('web.settings.mcp.sumSuffix')) +
        OrosusI18N.t('web.settings.mcp.addBtn') +
        (servers.length > 0 ? servers.map(function (m) {
          return '<div class="pu-item" data-k="mcp" data-v="' + esc(m.name) + '" title="' + esc(MCP_TRANSPORT_TEXT[m.transport] ?? m.transport ?? 'stdio') + '">' + mcpRowLine(m) + '</div>';
        }).join('') : OrosusI18N.t('web.settings.mcp.emptyNote')) +
        OrosusI18N.t('web.settings.mcp.legendNote');
      setPageHandler = function (e) {
        if (e.target.closest('[data-k="mcp-add"]')) { renderMcpForm(page, 'add'); return; }
        var start = e.target.closest('[data-k="mcp-start"]');
        if (start) {
          var nm = start.getAttribute('data-v');
          A.fetchJson('/api/settings/mcp/ops', { method: 'POST', body: JSON.stringify({ op: 'start', name: nm }) }).then(function (r) {
            toast(r && r.starting ? OrosusI18N.t('web.toast.mcpStarting') + nm + OrosusI18N.t('web.toast.mcpStartingHint') : OrosusI18N.t('web.toast.mcpStartTriggered'));
            window.setTimeout(function () { if (document.getElementById('set-page')) pageMcp(page); }, 5000);
          }, function (err) { toast(err.status === 409 ? err.message : OrosusI18N.t('web.toast.mcpStartFail') + err.message); });
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
    if (m.deferred === true && (m.state === 'idle' || m.state === 'failed')) acts.push(OrosusI18N.t('web.settings.mcp.startBtn'));
    else acts.push('<button class="btn" data-k="mcp-toggle">' + (m.state === 'disabled' ? OrosusI18N.t('web.settings.skills.stateEnabled') : OrosusI18N.t('web.settings.skills.stateDisabled')) + '</button>');
    if (m.source === 'config') {
      acts.push(OrosusI18N.t('web.settings.mcp.editBtn'));
      acts.push(OrosusI18N.t('web.settings.mcp.delBtn'));
    }
    if (m.state === 'pending-confirm') acts.push(OrosusI18N.t('web.settings.mcp.trustBtn'));
    var specDesc = m.instructions ?? ((m.toolCount ?? 0) > 0 ? m.toolCount + OrosusI18N.t('web.settings.mcp.toolsCount') : '—');
    page.innerHTML = OrosusI18N.t('web.settings.mcp.back') +
      spTitle(m.name + ' · MCP server') +
      '<div class="pu-kv">' +
      kvRow(OrosusI18N.t('web.settings.skills.fName'), esc(m.name)) +
      kvRow(OrosusI18N.t('web.settings.hooks.fDesc'), esc(specDesc)) +
      kvRow(OrosusI18N.t('web.settings.skills.fStatus'), esc(MCP_STATE_TEXT[m.state] ?? m.state) + (m.connectMs !== undefined && m.state === 'connected' ? ' · ' + m.connectMs + 'ms' : '')) +
      kvRow(OrosusI18N.t('web.settings.hooks.fSource'), esc(MCP_SOURCE_TEXT[m.source] ?? m.source)) +
      kvRow(OrosusI18N.t('web.settings.mcp.fTransport'), esc(MCP_TRANSPORT_TEXT[m.transport] ?? m.transport ?? 'stdio')) +
      kvRow(m.url ? 'URL' : OrosusI18N.t('web.settings.hooks.fCommand'), esc(m.url ?? m.command ?? '—'), 'info') +
      (m.failReason ? '<span class="k"></span><span class="v dim">' + esc(m.failReason) + '</span>' : '') +
      (m.state === 'pending-confirm' ? OrosusI18N.t('web.settings.mcp.unconfirmedA') + esc((m.fingerprint ?? '').slice(0, 8)) + OrosusI18N.t('web.settings.mcp.unconfirmedB') : '') +
      (m.source === 'preload' ? OrosusI18N.t('web.settings.mcp.preinstalledNote') : '') +
      '</div>' +
      '<div class="pu-actions">' + acts.join('') + '</div>';
    setPageHandler = function (e) {
      if (e.target.closest('[data-k="mcp-back"]')) { renderSetPage(6); return; } /* MCP 页（外观插位后 5→6） */
      if (e.target.closest('[data-k="mcp-toggle"]')) {
        var off = m.state !== 'disabled';
        mcpOp(page, { op: off ? 'off' : 'on', name: m.name }, function () { toast((off ? OrosusI18N.t('web.toast.skillDisabled') : OrosusI18N.t('web.toast.skillEnabled')) + m.name + OrosusI18N.t('web.toast.savedPost')); pageMcp(page); });
        return;
      }
      if (e.target.closest('[data-k="mcp-start"]')) {
        A.fetchJson('/api/settings/mcp/ops', { method: 'POST', body: JSON.stringify({ op: 'start', name: m.name }) }).then(function (r) {
          if (r && r.starting) {
            toast(OrosusI18N.t('web.toast.mcpStarting') + m.name + OrosusI18N.t('web.toast.mcpStartingHint'));
            window.setTimeout(function () { pageMcp(page); }, 5000); /* lazy 态翻转走 catalog（202 排队无失败回执帧） */
          } else {
            toast(OrosusI18N.t('web.toast.mcpStartTriggered'));
            pageMcp(page);
          }
        }, function (err) { toast(err.status === 409 ? err.message : OrosusI18N.t('web.toast.mcpStartFail') + err.message); });
        return;
      }
      if (e.target.closest('[data-k="mcp-trust"]')) {
        mcpOp(page, { op: 'trust', name: m.name }, function () { toast(OrosusI18N.t('web.toast.mcpConfirmed') + m.name + OrosusI18N.t('web.toast.mcpConfirmedReload')); pageMcp(page); });
        return;
      }
      if (e.target.closest('[data-k="mcp-edit"]')) { renderMcpForm(page, 'edit', m); return; }
      if (e.target.closest('[data-k="mcp-del"]')) {
        openConfirm({
          title: OrosusI18N.t('web.settings.mcp.delTitle'),
          bodyHtml: OrosusI18N.t('web.settings.mcp.delTextA') + esc(m.name) + OrosusI18N.t('web.settings.mcp.delTextB'),
          confirmText: OrosusI18N.t('web.common.delete'),
          onConfirm: function () { mcpOp(page, { op: 'remove', name: m.name }, function () { toast(OrosusI18N.t('web.toast.mcpDeleted') + m.name + OrosusI18N.t('web.toast.savedPost')); pageMcp(page); }); },
        });
      }
    };
  }
  /** mcp ops 统一发口：200 → text 服务端成品串 toast；400/404 → error 文案。 */
  function mcpOp(page, body, onOk) {
    A.fetchJson('/api/settings/mcp/ops', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      if (r && typeof r.text === 'string' && r.text !== '') toast(r.text);
      if (r && r.report && r.report.failed && r.report.failed.length) toast(OrosusI18N.t('web.toast.reloadPartialFail') + r.report.failed.map(function (f) { return f.name; }).join(', '));
      if (onOk) onOk(r);
    }, function (err) { toast(OrosusI18N.t('web.toast.opFail') + err.message); });
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
      var html = OrosusI18N.t('web.settings.mcp.backForm') +
        spTitle(isEdit ? OrosusI18N.t('web.settings.mcp.formTitleEdit') + row.name : OrosusI18N.t('web.settings.mcp.formTitleAdd')) +
        '<div class="mcp-tabs">' +
          '<button type="button" class="mcp-tab' + (tab === 'manual' ? ' sel' : '') + OrosusI18N.t('web.settings.mcp.tabManual') +
          '<button type="button" class="mcp-tab' + (tab === 'json' ? ' sel' : '') + '" data-k="mtp-json">JSON</button>' +
          OrosusI18N.t('web.settings.mcp.tabHint');
      if (tab === 'manual') {
        html += (isEdit
            ? OrosusI18N.t('web.settings.mcp.fNameEdit') + esc(draft.name) + '" readonly /></div>'
            : OrosusI18N.t('web.settings.mcp.fNameAdd') + esc(draft.name) + '" /></div>') +
          OrosusI18N.t('web.settings.mcp.fTransportForm') +
            '<option value="stdio"' + (!remote ? ' selected' : '') + OrosusI18N.t('web.settings.mcp.optStdio') +
            '<option value="http"' + (draft.transport === 'http' ? ' selected' : '') + OrosusI18N.t('web.settings.mcp.optHttp') +
            '<option value="sse"' + (draft.transport === 'sse' ? ' selected' : '') + OrosusI18N.t('web.settings.mcp.optSse') +
          '<div class="pf-row"><label>' + (remote ? 'URL <span class="req">*</span>' : OrosusI18N.t('web.settings.mcp.fCommand')) + '</label>' +
            '<input autocomplete="off" class="fi" id="mf-cmd" value="' + esc(draft.cmd) + '" placeholder="' + (remote ? 'https://mcp.internal.example.com/sse' : OrosusI18N.t('web.settings.mcp.cmdPlaceholder')) + '" /></div>' +
          '<div class="pf-row"><button type="button" class="btn" data-k="mf-adv">' + (advOpen ? '▾' : '▸') + OrosusI18N.t('web.settings.mcp.advancedToggle') + (advOpen ? '' : remote ? OrosusI18N.t('web.settings.mcp.advHttpHint') : OrosusI18N.t('web.settings.mcp.advStdioHint')) + '</button></div>';
        if (advOpen) {
          html += OrosusI18N.t('web.settings.mcp.envLabelA') + (isEdit ? OrosusI18N.t('web.settings.mcp.envLabelB') : '') + '）</label><textarea autocomplete="off" class="fi" id="mf-env" rows="2" placeholder="API_KEY=xxx"></textarea></div>';
          if (remote) html += OrosusI18N.t('web.settings.mcp.fHeaders');
          else html += OrosusI18N.t('web.settings.mcp.fCwd') + esc(draft.cwd) + OrosusI18N.t('web.settings.mcp.cwdPlaceholder');
          html += OrosusI18N.t('web.settings.mcp.fTimeout') + esc(draft.timeout) + OrosusI18N.t('web.settings.mcp.timeoutPlaceholder');
        }
      } else {
        html += OrosusI18N.t('web.settings.mcp.jsonNote') +
          '<div class="pf-row"><label>JSON</label><textarea autocomplete="off" class="fi" id="mf-json" rows="8" placeholder="{&quot;mcpServers&quot;: {&quot;my-search&quot;: {&quot;command&quot;: &quot;npx&quot;, &quot;args&quot;: [&quot;-y&quot;, &quot;my-search-mcp&quot;]}}}"></textarea></div>';
      }
      if (msg !== '') html += '<div class="sp-note ' + (msgBad ? 'bad' : '') + '">' + (msgBad ? '✕ ' : '✓ ') + esc(msg) + '</div>';
      html += OrosusI18N.t('web.settings.mcp.cancelBtn') +
        '<button class="btn primary" data-k="mcp-save">' + (isEdit ? OrosusI18N.t('web.common.save') : OrosusI18N.t('web.settings.mcp.addConfirmBtn')) + '</button></div>';
      page.innerHTML = html;
      bind();
    }
    function bind() {
      var q = function (id) { return page.querySelector('#' + id); };
      var nameEl = q('mf-name'), cmdEl = q('mf-cmd'), envEl = q('mf-env'), hdEl = q('mf-headers'), cwdEl = q('mf-cwd'), toEl = q('mf-timeout'), jsonEl = q('mf-json');
      var syncInputs = function () {
        /* 走查修⑮②：设置文本框统一忽略前后空格（读入即 trim——不回写，打字过程不受扰） */
        if (nameEl) draft.name = nameEl.value.trim();
        if (cmdEl) draft.cmd = cmdEl.value.trim();
        if (envEl) draft.env = envEl.value.trim();
        if (hdEl) draft.headers = hdEl.value.trim();
        if (cwdEl) draft.cwd = cwdEl.value.trim();
        if (toEl) draft.timeout = toEl.value.trim();
        if (jsonEl) draft.jsonText = jsonEl.value.trim();
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
        if (name === '' || /\s/.test(name)) { msg = OrosusI18N.t('web.toast.nameRequired'); msgBad = true; paintNow(); return; }
        var built = buildMcpSpec(draft);
        if (built.error !== undefined) { msg = built.error; msgBad = true; paintNow(); return; }
        spec = built.spec;
      }
      A.fetchJson('/api/settings/mcp/ops', { method: 'POST', body: JSON.stringify(isEdit ? { op: 'edit', name: row.name, spec: spec } : { op: 'add', name: name, spec: spec }) }).then(function (r) {
        toast(isEdit ? OrosusI18N.t('web.toast.mcpSaved') + name + OrosusI18N.t('web.toast.savedPost') : OrosusI18N.t('web.toast.mcpAdded') + name + OrosusI18N.t('web.toast.mcpConfirmedReload'));
        if (r && r.report && r.report.failed && r.report.failed.length) toast(OrosusI18N.t('web.toast.reloadPartialFail') + r.report.failed.map(function (f) { return f.name; }).join(', '));
        pageMcp(page);
      }, function (err) { msg = err.message; msgBad = true; paintNow(); });
    }
    if (isEdit) {
      pageLoading(page, OrosusI18N.t('web.toast.readingConfig'));
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
      }, function () { msg = OrosusI18N.t('web.toast.readConfigFail'); msgBad = true; paint(); });
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
      if (eq <= 0) return { error: OrosusI18N.t('web.toast.kvLineInvalid') + line };
      pairs[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return { pairs: pairs };
  }
  function buildMcpSpec(d) {
    var timeoutOf = function (spec) {
      if (d.timeout.trim() === '') return null;
      var s = Number(d.timeout);
      if (!Number.isFinite(s) || s <= 0) return OrosusI18N.t('web.toast.timeoutInvalid');
      spec.timeoutMs = Math.round(s * 1000);
      return null;
    };
    if (d.transport === 'stdio') {
      var parts = splitMcpCmd(d.cmd.trim());
      if (parts === null) return { error: OrosusI18N.t('web.toast.unclosedQuote') };
      if (parts.length === 0) return { error: OrosusI18N.t('web.toast.commandRequired') };
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
    if (!/^https?:\/\//i.test(d.cmd.trim())) return { error: OrosusI18N.t('web.toast.urlScheme') };
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
    try { o = JSON.parse(text); } catch { return { error: OrosusI18N.t('web.toast.jsonParseFail') }; }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return { error: OrosusI18N.t('web.toast.jsonMustBeObject') };
    if (o.mcpServers !== undefined) {
      if (o.mcpServers === null || typeof o.mcpServers !== 'object' || Array.isArray(o.mcpServers)) return { error: OrosusI18N.t('web.toast.mcpServersMustBeObject') };
      o = o.mcpServers;
    }
    var names = Object.keys(o).filter(function (k) { return o[k] !== null && typeof o[k] === 'object'; });
    if (names.length === 0) return { error: OrosusI18N.t('web.toast.missingServerEntry') };
    if (names.length > 1) return { error: OrosusI18N.t('web.toast.oneServerOnlyA') + names.length + OrosusI18N.t('web.toast.oneServerOnlyB') + names.slice(0, 3).join('、') + '）' };
    var name = names[0];
    var entry = o[name];
    var hasCmd = typeof entry.command === 'string' && entry.command !== '';
    var hasUrl = typeof entry.url === 'string' && entry.url !== '';
    if (!hasCmd && !hasUrl) return { error: OrosusI18N.t('web.toast.serverEntryIncomplete') };
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
    if ((r.imported ?? 0) > 0) segs.push(OrosusI18N.t('web.toast.memImportedNewA') + r.imported + OrosusI18N.t('web.toast.memImportedNewB'));
    if ((r.updated ?? 0) > 0) segs.push(OrosusI18N.t('web.toast.memOverwriteA') + r.updated + OrosusI18N.t('web.toast.memOverwriteB'));
    if ((r.skipped ?? 0) > 0) segs.push(OrosusI18N.t('web.toast.memSkippedA') + r.skipped + OrosusI18N.t('web.toast.memSkippedB'));
    if (segs.length === 0) segs.push(OrosusI18N.t('web.toast.memNothingNew'));
    if (r.mirror) segs.push(OrosusI18N.t('web.toast.memMirroredA') + r.mirror.projects + OrosusI18N.t('web.toast.memMirroredB') + (r.mirror.unresolved > 0 ? OrosusI18N.t('web.toast.memUncategorizedA') + r.mirror.unresolved + OrosusI18N.t('web.toast.memUncategorizedB') : ''));
    return segs.join(' · ') + (MEM_IMPORT.polish ? OrosusI18N.t('web.toast.memWithCleanup') : '');
  }
  function memRowHtml(s) {
    var cnt = s.imported
      ? OrosusI18N.t('web.toast.memImportedOkA') + s.count + OrosusI18N.t('web.toast.memImportedOkB')
      : '<span class="mc-count">' + s.count + OrosusI18N.t('web.settings.memory.rowCount') + ((s.newCount ?? 0) > 0 ? OrosusI18N.t('web.settings.memory.tagNew') + s.newCount + '</span>' : OrosusI18N.t('web.settings.memory.tagNewZero')) + '</span>';
    return '<div class="mc-row' + (s.imported ? ' done' : '') + '" data-agent="' + esc(s.id) + '">' +
      '<input autocomplete="off" type="checkbox" class="mc-cb" data-cb="' + esc(s.id) + '"' + (s.on ? ' checked' : '') + (s.imported ? ' disabled' : '') + OrosusI18N.t('web.settings.memory.selectAria') + esc(s.label) + '">' +
      '<span class="mc-agent">' + esc(s.label) + '</span>' +
      (s.global ? OrosusI18N.t('web.settings.memory.tagGlobal') : '') +
      '<span class="mc-path" title="' + esc(s.dir ?? '') + '">' + esc(s.dir ?? '') + '</span>' + cnt +
      '<button class="mc-one" data-one="' + esc(s.id) + '"' + (s.imported || MEM_IMPORT.busy ? ' disabled' : '') + '>' + (s.imported ? OrosusI18N.t('web.settings.memory.srcImported') : OrosusI18N.t('web.settings.memory.importSourceBtn')) + '</button></div>';
  }
  function memCardHtml() {
    var mi = MEM_IMPORT;
    var srcs = mi.sources;
    var scanning = srcs === null;
    var status = scanning
      ? OrosusI18N.t('web.settings.memory.scanning')
      : OrosusI18N.t('web.settings.memory.scannedA') + (srcs ?? []).length + OrosusI18N.t('web.settings.memory.scannedB');
    var list = scanning
      ? OrosusI18N.t('web.settings.memory.enumerating')
      : ((srcs ?? []).length ? (srcs ?? []).map(memRowHtml).join('') : OrosusI18N.t('web.settings.memory.noneDetected'));
    var sel = (srcs ?? []).filter(function (s) { return s.on && !s.imported; });
    var selTotal = sel.reduce(function (n, s) { return n + s.count; }, 0);
    var selNew = sel.reduce(function (n, s) { return n + (s.newCount ?? 0); }, 0);
    var allOn = (srcs ?? []).length > 0 && (srcs ?? []).every(function (s) { return s.on || s.imported; });
    return '<div class="mem-card">' +
      OrosusI18N.t('web.settings.memory.title') + status + '</span>' +
      OrosusI18N.t('web.settings.memory.rescanBtn') +
      '<div id="mc-list">' + list + '</div>' +
      '<div class="mc-opts">' +
      OrosusI18N.t('web.settings.memory.scopeLabel') +
      '<button class="seg' + (mi.scope === 'current' ? ' cur' : '') + OrosusI18N.t('web.settings.memory.scopeCurrentBtn') +
      '<button class="seg' + (mi.scope === 'all' ? ' cur' : '') + OrosusI18N.t('web.settings.memory.scopeAllBtn') +
      OrosusI18N.t('web.settings.memory.cleanupLabel') +
      '<button class="mc-toggle' + (mi.polish ? ' on' : '') + '" data-k="mc-polish" role="switch" aria-checked="' + mi.polish + OrosusI18N.t('web.settings.memory.cleanupAria') +
      OrosusI18N.t('web.settings.memory.cleanupHint') +
      '</div>' +
      '<div class="mc-foot"><label class="mc-all"><input autocomplete="off" type="checkbox" class="mc-cb" data-k="mc-all"' + (allOn ? ' checked' : '') + OrosusI18N.t('web.settings.memory.selectAll') +
      OrosusI18N.t('web.settings.memory.sumSelected') + sel.length + OrosusI18N.t('web.settings.memory.sumSources') + selTotal + OrosusI18N.t('web.settings.memory.sumEntries') + selNew + '</span>' +
      '<button class="btn primary" data-k="mc-import"' + (sel.length === 0 || mi.busy ? ' disabled' : '') + '>' + (mi.busy ? OrosusI18N.t('web.settings.memory.importing') : OrosusI18N.t('web.settings.memory.importSelectedBtn')) + '</button></div>' +
      OrosusI18N.t('web.settings.memory.note') +
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
      }, function (err) { toast(OrosusI18N.t('web.toast.scanFail') + err.message); refresh(); });
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
        toast(OrosusI18N.t('web.toast.scopeSet') + (MEM_IMPORT.scope === 'all' ? OrosusI18N.t('web.toast.scopeAll') : OrosusI18N.t('web.toast.scopeCurrent')));
      });
    });
    card.querySelector('[data-k="mc-polish"]').addEventListener('click', function () {
      MEM_IMPORT.polish = !MEM_IMPORT.polish;
      refresh();
      toast(OrosusI18N.t('web.toast.cleanupSet') + (MEM_IMPORT.polish ? OrosusI18N.t('web.toast.cleanupOn') : OrosusI18N.t('web.toast.cleanupOff')));
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
      toast(OrosusI18N.t('web.toast.importFail') + err.message);
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
    page.innerHTML = spTitle(OrosusI18N.t('web.settings.nav.memory'), 'MEMORY · tool-peers') +
      swRowHtml(OrosusI18N.t('web.settings.memory.workspaceMemory'), OrosusI18N.t('web.settings.memory.workspaceMemoryHint'), ws, 'mem', 'ws') +
      swRowHtml(OrosusI18N.t('web.settings.memory.sessionPeers'), OrosusI18N.t('web.settings.memory.sessionPeersHint'), peers, 'mem', 'peers') +
      memCardHtml() +
      OrosusI18N.t('web.settings.memory.whereNote');
    setPageHandler = function (e) {
      if (e.target.closest('[data-v="ws"]')) {
        A.fetchJson('/api/settings/memory', { method: 'POST', body: JSON.stringify({ key: 'workspaceMemory', value: !ws }) }).then(function () {
          toast(OrosusI18N.t('web.toast.workspaceMemorySet') + (!ws ? OrosusI18N.t('web.toast.togOn') : OrosusI18N.t('web.toast.cleanupOff')) + OrosusI18N.t('web.toast.writtenWorkspaceMemory'));
          renderMemPage(page, !ws, peers);
        }, function (err) { toast(OrosusI18N.t('web.toast.settingFail') + err.message); });
      } else if (e.target.closest('[data-v="peers"]')) {
        A.fetchJson('/api/settings/memory', { method: 'POST', body: JSON.stringify({ key: 'sessionPeers', value: !peers }) }).then(function () {
          toast(OrosusI18N.t('web.toast.sessionPeersSet') + (!peers ? OrosusI18N.t('web.toast.togOn') : OrosusI18N.t('web.toast.cleanupOff')) + OrosusI18N.t('web.toast.writtenSessionPeers'));
          renderMemPage(page, ws, !peers);
        }, function (err) { toast(OrosusI18N.t('web.toast.settingFail') + err.message); });
      }
    };
    bindMemCard(page);
  }

  /* ── F1b 外观（主题卡 + 明暗 + 整体字号 + 语言：前三项写 gui/gui.toml，语言仍写 config.toml；
   *    切换即时生效（M5：重拉表→水合+页面重建）；FONT_SCALES/applyFontScale/applyTheme 与顶栏共用。 ── */
  var LANG_EN = { 'zh-CN': 'Chinese Simplified', 'zh-TW': 'Chinese Traditional', 'en-US': 'English', en: 'English', ja: 'Japanese', ko: 'Korean', de: 'German', fr: 'French', es: 'Spanish' };
  function langRowHtml(l, cur, pack) {
    return '<div class="ap-lang' + (cur ? ' cur' : '') + ' ap-fade" data-k="ap-lang" data-v="' + esc(l.tag) + '" role="radio" aria-checked="' + cur + '">' +
      '<span class="ap-radio"></span>' +
      '<span class="al-txt"><span class="al-native">' + esc(l.label) + '</span><span class="al-label">' + esc(LANG_EN[l.tag] ?? l.tag) + '</span></span>' +
      (pack ? OrosusI18N.t('web.settings.general.tagPack') : OrosusI18N.t('web.settings.general.tagBuiltin')) +
      (cur ? OrosusI18N.t('web.settings.general.tagCurrent') : '') + '</div>';
  }
  function pageAppearance(page) {
    pageLoading(page);
    Promise.all([A.fetchJson('/api/settings/locale'), A.fetchJson('/api/settings/update')]).then(function (res) {
      var d = res[0], upd = res[1];
      var current = String(d.current ?? '');
      var locales = d.locales ?? [];
      var builtins = locales.filter(function (l) { return !l.module; });
      var packs = locales.filter(function (l) { return !!l.module; });
      var updEnabled = !!(upd && upd.enabled);
      var light = document.body.classList.contains('light');
      var fs = fontScaleIdx;
      page.innerHTML = spTitle(OrosusI18N.t('web.settings.nav.appearance'), 'APPEARANCE') +
        subHeadT(OrosusI18N.t('web.settings.appearance.theme'), 1) +
        '<div class="ap-themes">' +
          '<div class="ap-theme cur"><span class="at-prev"><span class="half d"><i></i></span><span class="half l"><i></i></span></span>' +
          '<span class="at-name">' + esc(guiTheme) + OrosusI18N.t('web.settings.appearance.currentTheme') +
          OrosusI18N.t('web.settings.appearance.themeDesc') +
          OrosusI18N.t('web.settings.appearance.moreComing') +
        '</div>' +
        subHeadT(OrosusI18N.t('web.settings.appearance.modeHead'), 1) +
        OrosusI18N.t('web.settings.appearance.modeRowHtml') +
          OrosusI18N.t('web.settings.appearance.modeSubHtml') +
          '<span class="mc-seg">' +
          '<button class="seg' + (!light ? ' cur' : '') + '" data-k="ap-mode" data-v="dark">' + OrosusI18N.t('web.shell.themeDark') + '</button>' +
          '<button class="seg' + (light ? ' cur' : '') + '" data-k="ap-mode" data-v="light">' + OrosusI18N.t('web.shell.themeLight') + '</button>' +
          '</span></div>' +
        subHeadT(OrosusI18N.t('web.settings.appearance.fontHead'), 1) +
        OrosusI18N.t('web.settings.appearance.fontRowHtml') +
          OrosusI18N.t('web.settings.appearance.fontSubHtml') + FONT_SCALES[fs].name + '（' + Math.round(FONT_SCALES[fs].scale * 100) + OrosusI18N.t('web.settings.appearance.fontSubSuffix') +
          '<span class="mc-seg">' + FONT_SCALES.map(function (f, i) {
            return '<button class="seg' + (i === fs ? ' cur' : '') + '" data-k="ap-scale" data-v="' + i + '">' + f.name + '</button>';
          }).join('') + '</span></div>' +
        /* 走查修⑮⑥：更新检测并入外观（原独立页退役）——位置 = 整体字号下、语言上；按钮换 mc-seg 分段式 */
        subHeadT(OrosusI18N.t('web.settings.appearance.updateHead'), 1) +
        OrosusI18N.t('web.settings.appearance.updateRowHtml') +
          OrosusI18N.t('web.settings.appearance.updateSubHtml') +
          '<span class="mc-seg">' +
          '<button class="seg' + (updEnabled ? ' cur' : '') + OrosusI18N.t('web.settings.appearance.onBtn') +
          '<button class="seg' + (!updEnabled ? ' cur' : '') + OrosusI18N.t('web.settings.appearance.offBtn') +
          '</span></div>' +
        OrosusI18N.t('web.settings.appearance.verNoteHtml') + esc(String(upd.current ?? '?')) + (upd.latest ? OrosusI18N.t('web.settings.appearance.verLatestSeg') + esc(String(upd.latest)) : '') + '</div>' +
        subHeadT(OrosusI18N.t('web.settings.appearance.langHead'), 1) +
        '<div id="ap-langs">' +
        (current === '' ? OrosusI18N.t('web.settings.appearance.langSystemHtml') : '') +
        builtins.map(function (l) { return langRowHtml(l, current === l.tag, false); }).join('') +
        '</div>' +
        (packs.length > 0 ? '<div id="ap-langpack">' + packs.map(function (l) { return langRowHtml(l, current === l.tag, true); }).join('') + '</div>' : '') +
        OrosusI18N.t('web.settings.appearance.langNoteHtml');
      setPageHandler = function (e) {
        var t;
        if ((t = e.target.closest('[data-k="ap-update"]'))) {
          var toEnable = t.getAttribute('data-v') === '1';
          if (toEnable !== updEnabled) {
            updEnabled = toEnable;
            A.fetchJson('/api/settings/update', { method: 'POST', body: JSON.stringify({ enabled: toEnable }) }).then(function () {
              toast(toEnable ? OrosusI18N.t('web.settings.appearance.updateOnToast') : OrosusI18N.t('web.settings.appearance.updateOffToast'));
            }, function (err) { toast(OrosusI18N.t('web.ui.effort.setFail', { err: err.message })); });
          }
          t.parentNode.querySelectorAll('.seg').forEach(function (s) { s.classList.toggle('cur', s === t); });
          return;
        }
        if ((t = e.target.closest('[data-k="ap-mode"]'))) {
          var toLight = t.getAttribute('data-v') === 'light';
          if (toLight !== document.body.classList.contains('light')) {
            var previousMode = !toLight;
            applyTheme(toLight);
            saveGuiAppearance({ mode: toLight ? 'light' : 'dark' }, function () { applyTheme(previousMode); });
            toast(toLight ? OrosusI18N.t('web.settings.appearance.lightToast') : OrosusI18N.t('web.settings.appearance.darkToast'));
          }
          var seg1 = t.parentNode.querySelectorAll('.seg');
          seg1.forEach(function (s) { s.classList.toggle('cur', s === t); });
          return;
        }
        if ((t = e.target.closest('[data-k="ap-scale"]'))) {
          var i = parseInt(t.getAttribute('data-v'), 10);
          var changed = i !== fontScaleIdx;
          var previousScale = fontScaleIdx;
          applyFontScale(i);
          saveGuiAppearance({ fontScale: FONT_SCALES[i].scale }, function () { applyFontScale(previousScale); });
          t.parentNode.querySelectorAll('.seg').forEach(function (s) { s.classList.toggle('cur', s === t); });
          var sub = page.querySelector('#ap-fs-sub');
          if (sub) sub.textContent = OrosusI18N.t('web.settings.appearance.fontCurPrefix') + FONT_SCALES[i].name + '（' + Math.round(FONT_SCALES[i].scale * 100) + OrosusI18N.t('web.settings.appearance.fontSubTail');
          if (changed) toast(OrosusI18N.t('web.settings.appearance.fontToastPrefix') + FONT_SCALES[i].name + '」（' + Math.round(FONT_SCALES[i].scale * 100) + '%）');
          return;
        }
        if ((t = e.target.closest('[data-k="ap-lang"]'))) {
          var tag = t.getAttribute('data-v');
          if (tag === current) { toast(OrosusI18N.t('web.settings.langAlready')); return; }
          A.fetchJson('/api/settings/locale', { method: 'POST', body: JSON.stringify({ tag: tag }) }).then(function () {
            return loadMessages(tag === '' ? OrosusI18N.normalizeLocaleTag(navigator.language) : tag).then(function () {
              toast(OrosusI18N.t('web.settings.langSwitched'));
              pageAppearance(page); // 设置·外观页随新表重建（语言区就在本页）
            });
          }, function (err) {
            if (err.status === 409) toast(OrosusI18N.t('web.settings.langNoSession'));
            else toast(OrosusI18N.t('web.toast.switchFail') + err.message);
          });
        }
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
      OrosusI18N.t('web.settings.archive.searchPh') + esc(arState.q) + '" />' +
      OrosusI18N.t('web.settings.archive.allWorkspaces') + wsList.map(function (w) {
        var nm = w.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || w;
        return '<option' + (arState.ws === w ? ' selected' : '') + ' value="' + esc(w) + '">' + esc(nm) + '</option>';
      }).join('') + '</select>' +
      '<span class="ar-sort">' +
        '<button data-ar-sort="archived" class="' + (arState.sort === 'archived' ? 'sel' : '') + OrosusI18N.t('web.settings.archive.sortArchived') +
        '<button data-ar-sort="created" class="' + (arState.sort === 'created' ? 'sel' : '') + OrosusI18N.t('web.settings.archive.sortCreated') +
        '<button data-ar-sort="alpha" class="' + (arState.sort === 'alpha' ? 'sel' : '') + OrosusI18N.t('web.settings.archive.sortAlpha') +
      '</span></div>';
    if (groups.length === 0) {
      body += OrosusI18N.t('web.settings.archive.emptyHtml');
    }
    groups.forEach(function (g) {
      body += '<div class="ar-group" title="' + esc(g.key) + '"><span>📁 ' + esc(g.name || g.key) + '</span><span class="ar-count">' + g.items.length + OrosusI18N.t('web.settings.archive.countTail');
      g.items.forEach(function (a) {
        var title = a.title !== '' ? a.title : OrosusI18N.t('web.session.unnamedTitle');
        body += '<div class="ar-card"><span><span class="ar-title">' + esc(title) + OrosusI18N.t('web.settings.archive.timeArchivedHtml') + esc(fmtDateTime(a.archivedAt)) + OrosusI18N.t('web.settings.archive.timeCreatedSeg') + esc(fmtDateTime(a.createdAt)) + '</span></span><button class="btn ar-restore" data-ar="' + esc(a.sid) + OrosusI18N.t('web.settings.archive.restoreBtnHtml');
      });
    });
    page.innerHTML = spTitle(OrosusI18N.t('web.settings.nav.archived'), 'ARCHIVED') +
      OrosusI18N.t('web.settings.archive.noteHtml') + body;
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
          toast(OrosusI18N.t('web.settings.archive.restoredPrefix') + (a.title !== '' ? a.title : OrosusI18N.t('web.settings.archive.unnamed')) + OrosusI18N.t('web.settings.archive.restoredSuffix'));
          arData = arData.filter(function (x) { return x.sid !== sid; });
          void pollSessions(); /* 左栏即时出新（server 侧已同步 unhide——恢复即找回） */
          renderArchivedPage(page);
        }, function (err) { toast(OrosusI18N.t('web.settings.archive.restoreFail') + err.message); });
      }
    };
  }

  /* ═══════════ 帮助弹窗（A6：helpText 分区结构 + web 界面操作段；键位表 = web 版） ═══════════ */
  function openHelpModal() {
    UI.closePopup();
    modalClose();
    var secs = [
      [OrosusI18N.t('web.misc.help.grpCli'), [
        ['/new', OrosusI18N.t('web.misc.help.cmdNew')],
        ['/fork', OrosusI18N.t('web.misc.help.cmdFork')],
        ['/title', OrosusI18N.t('web.misc.help.cmdTitle')],
        ['/quit', OrosusI18N.t('web.misc.help.cmdQuit')],
        ['/settings · /sessions', OrosusI18N.t('web.misc.help.cmdSettings')],
      ]],
      [OrosusI18N.t('web.misc.help.grpBuiltin'), [
        ['/model', OrosusI18N.t('web.misc.help.cmdModel')],
        ['/effort', OrosusI18N.t('web.misc.help.cmdEffort')],
        ['/reload', OrosusI18N.t('web.misc.help.cmdReload')],
        ['/help', OrosusI18N.t('web.misc.help.cmdHelp')],
        ['/btw', OrosusI18N.t('web.misc.help.cmdBtw')],
      ]],
      [OrosusI18N.t('web.misc.help.grpModules'), [
        ['/compact', OrosusI18N.t('web.misc.help.cmdCompact')],
        ['/yolo · /auto', OrosusI18N.t('web.misc.help.cmdYolo')],
      ]],
      [OrosusI18N.t('web.misc.help.grpPanels'), [
        ['/ps', OrosusI18N.t('web.misc.help.cmdPs')],
      ]],
      [OrosusI18N.t('web.misc.help.skillsHead'), [
        [OrosusI18N.t('web.misc.help.slashKey'), OrosusI18N.t('web.misc.help.slashSkills')],
        [OrosusI18N.t('web.misc.help.skillsPath'), OrosusI18N.t('web.misc.help.skillsPage')],
      ]],
      [OrosusI18N.t('web.misc.help.hooksHead'), [
        [OrosusI18N.t('web.misc.help.hooksPath'), OrosusI18N.t('web.misc.help.hooksPage')],
        [OrosusI18N.t('web.misc.help.hooksInjPath'), OrosusI18N.t('web.misc.help.hooksInjPage')],
      ]],
      [OrosusI18N.t('web.misc.help.grpUi'), [
        [OrosusI18N.t('web.misc.help.uiSidebar'), OrosusI18N.t('web.misc.help.uiSidebarDesc')],
        [OrosusI18N.t('web.misc.help.uiSessRow'), OrosusI18N.t('web.misc.help.uiSessRowDesc')],
        [OrosusI18N.t('web.misc.help.uiSessStatus'), OrosusI18N.t('web.misc.help.uiSessStatusDesc')],
        [OrosusI18N.t('web.misc.help.uiStatusbar'), OrosusI18N.t('web.misc.help.uiStatusbarDesc')],
        [OrosusI18N.t('web.misc.help.uiUpdate'), OrosusI18N.t('web.misc.help.uiUpdateDesc')],
        [OrosusI18N.t('web.shell.settings'), OrosusI18N.t('web.misc.help.uiSettings')],
        [OrosusI18N.t('web.misc.help.uiHelpMore'), OrosusI18N.t('web.misc.help.uiHelpMoreDesc')],
        [OrosusI18N.t('web.misc.help.uiTheme'), OrosusI18N.t('web.misc.help.uiThemeDesc')],
        [OrosusI18N.t('web.misc.help.uiComposer'), OrosusI18N.t('web.misc.help.uiComposerDesc')],
        [OrosusI18N.t('web.misc.help.uiCwd'), OrosusI18N.t('web.misc.help.uiCwdDesc')],
        [OrosusI18N.t('web.misc.help.uiPaging'), OrosusI18N.t('web.misc.help.uiPagingDesc')],
        [OrosusI18N.t('web.misc.help.uiBubble'), OrosusI18N.t('web.misc.help.uiBubbleDesc')],
        [OrosusI18N.t('web.misc.help.uiDoneTask'), OrosusI18N.t('web.misc.help.uiDoneTaskDesc')],
        [OrosusI18N.t('web.misc.help.uiThinkDiff'), OrosusI18N.t('web.misc.help.uiThinkDiffDesc')],
        [OrosusI18N.t('web.misc.help.uiModRow'), OrosusI18N.t('web.misc.help.uiModRowDesc')],
        [OrosusI18N.t('web.misc.help.uiConnRow'), OrosusI18N.t('web.misc.help.uiConnRowDesc')],
        [OrosusI18N.t('web.misc.help.uiPopup'), OrosusI18N.t('web.misc.help.uiPopupDesc')],
        [OrosusI18N.t('web.misc.help.uiLimits'), OrosusI18N.t('web.misc.help.uiLimitsDesc')],
      ]],
      [OrosusI18N.t('web.misc.help.grpKeys'), [
        ['Enter', OrosusI18N.t('web.misc.help.keySend')],
        ['Shift + Enter', OrosusI18N.t('web.misc.help.keyNewline')],
        ['Ctrl + V', OrosusI18N.t('web.misc.help.keyPaste')],
        ['Esc', OrosusI18N.t('web.misc.help.keyEsc')],
        ['/', OrosusI18N.t('web.misc.help.keySlash')],
        ['@', OrosusI18N.t('web.misc.help.keyAt')],
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
      title: OrosusI18N.t('web.shell.help'),
      en: 'HELP',
      bodyHtml: '<div class="pu-text"><div class="help help-inline">' + h + '</div></div>',
      foot: OrosusI18N.t('web.ui.view.footDefault'),
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
      title: OrosusI18N.t('web.misc.more.head'),
      en: OrosusI18N.t('web.misc.more.sub'),
      bodyHtml: moreRow(OrosusI18N.t('web.misc.more.diag'), OrosusI18N.t('web.misc.more.diagDesc'), 'diag') +
        moreRow(OrosusI18N.t('web.misc.more.launcher'), OrosusI18N.t('web.misc.more.launcherDesc'), 'launcher') +
        moreRow(OrosusI18N.t('web.misc.more.hooks'), OrosusI18N.t('web.misc.more.hooksDesc'), 'hooks') +
        moreRow(OrosusI18N.t('web.misc.more.compact'), OrosusI18N.t('web.misc.more.compactDesc'), 'compact'),
      foot: OrosusI18N.t('web.misc.more.foot'),
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
    openModal({ title: OrosusI18N.t('web.misc.more.diag'), en: 'DIAGNOSTICS', bodyHtml: OrosusI18N.t('web.misc.diag.loadingHtml') });
    A.fetchJson('/api/diagnostics').then(function (d) {
      var rows = d.rows ?? [];
      if (rows.length === 0) {
        modalReplace({ title: OrosusI18N.t('web.misc.more.diag'), en: 'ALL GOOD', bodyHtml: OrosusI18N.t('web.misc.diag.allGoodHtml') + esc(String(d.logDir ?? '')) + '</span></div>', foot: OrosusI18N.t('web.misc.diag.footEsc') });
        return;
      }
      modalReplace({
        title: OrosusI18N.t('web.misc.more.diag'),
        en: rows.length + OrosusI18N.t('web.misc.diag.countSeg'),
        bodyHtml: rows.map(function (r) {
          return '<div class="pu-item" data-diag="' + esc(r.name) + '"><span class="pu-caret">❯</span><span class="st-err">●</span> <span class="pi-name">' + esc(r.name) + '</span> <span class="pi-desc">' + esc(r.failReason ?? '') + '</span></div>';
        }).join(''),
        foot: OrosusI18N.t('web.misc.diag.foot'),
        onClick: function (e) {
          var row = e.target.closest('[data-diag]');
          if (!row) return;
          var r = rows.find(function (x) { return x.name === row.getAttribute('data-diag'); });
          if (!r) return;
          openModal({
            title: OrosusI18N.t('web.misc.diag.titleSeg') + r.name,
            en: 'DETAIL',
            bodyHtml: OrosusI18N.t('web.misc.diag.failHeadHtml') + esc(r.failReason ?? OrosusI18N.t('web.misc.diag.noDetail')) + OrosusI18N.t('web.misc.diag.fixGuideHtml') + esc(String(d.logDir ?? '')) + '</div>',
            foot: OrosusI18N.t('web.misc.diag.detailFoot'),
          });
        },
      });
    }, function (err) { modalReplace({ title: OrosusI18N.t('web.misc.more.diag'), en: 'ERROR', bodyHtml: OrosusI18N.t('web.misc.diag.loadFailHtml') + esc(err.message) + '</div>' }); });
  }
  /** 模块总览（GET /api/launchers——cards[].desc 是登记命令：主行「module —— 命令」+ title 说明〔T14
   *  裁定：desc 槽真实内容是命令，当主操作键直示；title 是人类可读名作说明行〕；点击 = 执行该命令）。 */
  function openLauncherWindow() {
    openModal({ title: OrosusI18N.t('web.misc.more.launcher'), en: 'LAUNCHERS', bodyHtml: OrosusI18N.t('web.misc.diag.loadingHtml') });
    A.fetchJson('/api/launchers').then(function (d) {
      var cards = d.cards ?? [];
      if (cards.length === 0) {
        modalReplace({ title: OrosusI18N.t('web.misc.more.launcher'), en: 'LAUNCHERS', bodyHtml: OrosusI18N.t('web.misc.launcher.emptyHtml'), foot: OrosusI18N.t('web.misc.diag.footEsc') });
        return;
      }
      modalReplace({
        title: OrosusI18N.t('web.misc.more.launcher'),
        en: cards.length + OrosusI18N.t('web.misc.launcher.countSeg'),
        bodyHtml: cards.map(function (c) {
          return '<div class="pu-item" data-launch="' + esc(c.module) + OrosusI18N.t('web.misc.launcher.rowTipHtml') + esc(c.desc ?? '') + '"><span class="pu-caret">❯</span><span class="pi-name">' + esc(c.module) + (c.desc ? ' —— <span class="dim">' + esc(c.desc) + '</span>' : '') + '</span><span class="pi-desc">' + esc(c.title ?? '') + '</span></div>';
        }).join(''),
        foot: OrosusI18N.t('web.misc.launcher.foot'),
        onClick: function (e) {
          var row = e.target.closest('[data-launch]');
          if (!row) return;
          var c = cards.find(function (x) { return x.module === row.getAttribute('data-launch'); });
          if (!c || !c.desc) return;
          modalClose();
          if (currentSid === null) { toast(OrosusI18N.t('web.misc.launcher.noSession')); return; }
          sendCommandText(c.desc);
          launcherBack = true; /* 走查（2026-10-16 用户口令②）：此窗源自总览——用户关窗后回总览页 */
          toast(OrosusI18N.t('web.misc.launcher.submitted') + c.desc);
        },
      });
    }, function (err) { modalReplace({ title: OrosusI18N.t('web.misc.more.launcher'), en: 'ERROR', bodyHtml: OrosusI18N.t('web.misc.diag.loadFailHtml') + esc(err.message) + '</div>' }); });
  }
  /** 钩子注入分桶（GET /:sid/hooks-activity——buildHookBuckets 同源：userText/count/injections）。 */
  function openHookActivityWindow() {
    if (currentSid === null) { toast(OrosusI18N.t('web.misc.hooks.noSession')); return; }
    openModal({ title: OrosusI18N.t('web.misc.hooks.titleDrill'), en: 'HOOKS', bodyHtml: OrosusI18N.t('web.misc.diag.loadingHtml') });
    A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/hooks-activity').then(function (d) {
      var groups = d.groups ?? [];
      if (groups.length === 0) {
        modalReplace({ title: OrosusI18N.t('web.misc.hooks.title'), en: 'EMPTY', bodyHtml: OrosusI18N.t('web.misc.hooks.emptyHtml'), foot: OrosusI18N.t('web.misc.diag.footEsc') });
        return;
      }
      modalReplace({
        title: OrosusI18N.t('web.misc.hooks.titleDrill'),
        en: groups.length + OrosusI18N.t('web.misc.hooks.groupsSeg'),
        bodyHtml: groups.map(function (g, i) {
          return '<div class="pu-item" data-hk="' + i + '"><span class="pu-caret">❯</span><span class="pi-name">' + esc(g.userText) + '</span><span class="pi-desc">' + g.count + OrosusI18N.t('web.misc.hooks.runsSeg') + (g.injections && g.injections.length > 0 ? ' · ' + g.injections.length + OrosusI18N.t('web.misc.hooks.injSeg') : '') + '</span></div>';
        }).join(''),
        foot: OrosusI18N.t('web.misc.hooks.foot'),
        onClick: function (e) {
          var row = e.target.closest('[data-hk]');
          if (!row) return;
          var g = groups[parseInt(row.getAttribute('data-hk'), 10)];
          if (!g) return;
          if (!g.injections || g.injections.length === 0) {
            toast(OrosusI18N.t('web.misc.hooks.noInj'));
            return;
          }
          openModal({
            title: OrosusI18N.t('web.misc.hooks.injTitleSeg') + g.count + OrosusI18N.t('web.misc.hooks.runsSeg'),
            en: 'INJECTIONS',
            bodyHtml: g.injections.map(function (tx) { return '<div class="pu-text md">' + UI.mdHtml(tx) + '</div>'; }).join('<hr class="side-sep" />'),
            foot: OrosusI18N.t('web.misc.hooks.scrollFoot'),
          });
        },
      });
    }, function (err) { modalReplace({ title: OrosusI18N.t('web.misc.hooks.errTitle'), en: 'ERROR', bodyHtml: OrosusI18N.t('web.misc.diag.loadFailHtml') + esc(err.message) + '</div>' }); });
  }
  /** 压缩摘要（GET /:sid/compaction——末条 summary + 标量 stats；404 = 从未压缩）。 */
  function openCompactWindow() {
    if (currentSid === null) { toast(OrosusI18N.t('web.misc.compact.noSession')); return; }
    A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/compaction').then(function (d) {
      var st = d.stats ?? {};
      var meta = [
        OrosusI18N.t('web.misc.compact.timeSeg') + fmtDateTime(d.at ? Date.parse(d.at) : 0),
        st.trigger ? OrosusI18N.t('web.misc.compact.triggerSeg') + (st.trigger === 'manual' ? OrosusI18N.t('web.misc.compact.triggerManual') : st.trigger) : '',
        typeof st.keepUserHead === 'number' ? OrosusI18N.t('web.misc.compact.keepSeg') + st.keepUserHead + OrosusI18N.t('web.toast.memSkippedB') : '',
        typeof st.elidedCount === 'number' ? OrosusI18N.t('web.misc.compact.elideSeg') + st.elidedCount + OrosusI18N.t('web.toast.memSkippedB') : '',
        typeof st.droppedCount === 'number' ? OrosusI18N.t('web.misc.compact.dropSeg') + st.droppedCount + OrosusI18N.t('web.toast.memSkippedB') : '',
      ].filter(Boolean).join(' · ');
      openModal({
        title: OrosusI18N.t('web.misc.compact.title'),
        en: 'COMPACTION',
        big: true, /* 走查修⑩②：大屏放宽（compact-modal——用户报障「屏幕这么大只占一点」） */
        bodyHtml: '<div class="pu-text"><span class="dim">' + esc(meta) + '</span></div><div class="pu-text md">' + UI.mdHtml(d.summary ?? '') + '</div>',
        foot: OrosusI18N.t('web.misc.compact.foot'),
      });
    }, function (err) {
      if (err.status === 404) { toast(OrosusI18N.t('web.misc.compact.empty')); return; }
      toast(OrosusI18N.t('web.settings.loadFail') + err.message);
    });
  }

  /* ═══════════ 更新弹窗（A4：GET /api/update——有 notes → marked 渲染；无 → 版本号+落后列表+指引；「立即升级」= 指引文案不 spawn） ═══════════ */
  function openUpdateModal() {
    UI.closePopup();
    modalClose();
    openModal({ title: OrosusI18N.t('web.misc.update.title'), en: 'UPDATE', bodyHtml: OrosusI18N.t('web.misc.update.checkingHtml') });
    A.fetchJson('/api/update').then(function (u) {
      /* 胶囊可见性新鲜度以 /api/update 为准（懒取侧比 bootstrap 启动检查缓存更新鲜——T12 口径） */
      $('btn-update').hidden = !u.hasUpdate;
      if (!u.hasUpdate) {
        modalReplace({
          title: OrosusI18N.t('web.misc.update.title'),
          en: 'UPDATE',
          bodyHtml: OrosusI18N.t('web.misc.update.latestHtml') + esc(String(u.latest ?? u.current ?? '?')) + '</b>' + (u.latest ? OrosusI18N.t('web.misc.update.currentSeg') + esc(String(u.current ?? '?')) + '）' : '') + '</div>',
          actionsHtml: OrosusI18N.t('web.misc.update.closeBtnHtml'),
          foot: OrosusI18N.t('web.misc.update.footIdle'),
          onAction: function () { modalClose(); },
        });
        return;
      }
      var body = '';
      if (typeof u.notes === 'string' && u.notes !== '') {
        body = OrosusI18N.t('web.misc.update.availHtml') + esc(String(u.latest ?? '?')) + '</b>' + OrosusI18N.t('web.misc.update.availSeg') + esc(String(u.current ?? '?')) + '）</div>' +
          '<div class="pu-text md update-notes">' + UI.mdHtml(u.notes) + '</div>';
      } else {
        var skipped = Array.isArray(u.skipped) ? u.skipped : [];
        body = OrosusI18N.t('web.misc.update.availHtml') + esc(String(u.latest ?? '?')) + '</b>' + OrosusI18N.t('web.misc.update.availSeg') + esc(String(u.current ?? '?')) + '）</div>' +
          (skipped.length > 0 ? OrosusI18N.t('web.misc.update.skippedHtml') + skipped.map(function (s) { return esc(String(s)); }).join('、') + '</span></div>' : '') +
          OrosusI18N.t('web.misc.update.noNotesHtml');
      }
      body += OrosusI18N.t('web.misc.update.howHtml');
      modalReplace({
        title: OrosusI18N.t('web.misc.update.title'),
        en: 'UPDATE',
        bodyHtml: body,
        actionsHtml: OrosusI18N.t('web.misc.update.btnsHtml'),
        foot: OrosusI18N.t('web.misc.update.footNew'),
        onAction: function (act) {
          if (act === 'go') toast(OrosusI18N.t('web.misc.update.goToast'));
          modalClose();
        },
      });
    }, function (err) {
      modalReplace({ title: OrosusI18N.t('web.misc.update.title'), en: 'UPDATE', bodyHtml: OrosusI18N.t('web.misc.update.failHtml') + esc(err.message) + '</div>', actionsHtml: OrosusI18N.t('web.misc.update.closeBtnHtml'), onAction: function () { modalClose(); } });
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
        if (r && r.starting) toast(OrosusI18N.t('web.toast.mcpStarting') + name + OrosusI18N.t('web.toast.mcpStartingHint'));
        else toast(OrosusI18N.t('web.toast.mcpStartTriggered'));
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
    if (m && m.locked) { toast(m.lockedReason ?? OrosusI18N.t('web.toast.lockedNoPlug')); return; }
    A.fetchJson('/api/sessions/' + encodeURIComponent(currentSid) + '/modules/' + encodeURIComponent(name) + '/toggle', { method: 'POST', body: JSON.stringify({}) })
      .then(function (r) { if (r && r.toast) toast(r.toast); }, function (err) { toast(err.message); });
  });

  /* ═══════════ 当前会话视图（appbar 标题 / 流区骨架态 / SSE 状态机） ═══════════ */
  var sessionTitleEl = $('session-title');
  var kvSession = $('kv-session');
  function setSessionTitle(name, sid) {
    sessionTitle = name;
    sessionTitleEl.innerHTML = name !== '' ? esc(name) + ' <span class="dim">' + esc(shortSid(sid)) + '</span>' : OrosusI18N.t('web.misc.noSessionHtml');
    kvSession.textContent = name !== '' ? name : '—';
    kvSession.title = name !== '' ? name : ''; /* 走查修⑮：单行省略悬停给全文 */
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
  /* 走查修⑮⑦（2026-10-14 用户口令）：＋新会话 = 只开新会话窗（草稿态），不立即落桶。
   *  draftActive/draftCwd 是本窗态唯一真源——视图 = 无会话空流（welcome + composer + cwd 芯片可改归属）；
   *  首条消息（sendDraft）才 createSession 落桶。切走/首发成功即出草稿态。 */
  var draftActive = false, draftCwd = '';
  function openDraft() {
    UI.closePopup();
    if (streamCtl) { streamCtl.close(); streamCtl = null; }
    draftCwd = sessionCwd; /* 落桶项目 = 点按时刻当前会话所在项目（B1 跟随口径） */
    draftActive = true;
    currentSid = null;
    setSessionTitle(OrosusI18N.t('web.session.freshTitle'), '');
    render.open({
      sid: null, stream: streamEl, tail: tailEl, welcome: welcomeEl, pgMore: pgMoreEl, toBottom: $('to-bottom'),
      onFork: function (fromSid) { createSession({ forkFrom: fromSid }).then(function (r) { if (r) toast('已分叉出新会话——继承全部上下文'); }); },
      onCopy: copyText,
      onUserSeen: syncCwdGate,
      onAgentOpen: function (id) { openAgentTab(id); },
      onCompactionDone: function (text) { toast(text, 6000); },
      onCompactionOpen: function () { openCompactWindow(); },
      cwdOf: function () { return draftCwd; },
    });
    renderSidebar();
    syncCwdGate();
  }
  function switchTo(sid) {
    /* 切会话前先关浮层——挂起交互的 cancelled 应答仍指向原会话（currentSid 未变） */
    UI.closePopup();
    if (globalThis.OrosusDialog) globalThis.OrosusDialog.unmount(); /* web-dialog 批 T8：旧会话控件窗本地清理（在途队列以捕获 sid 自然收尾——设计 §10「先用旧 sid 提交关闭」） */
    launcherBack = false; /* 走查②：换会话即换源——总览回跳标记不跨会话 */
    draftActive = false; /* 走查修⑮⑦：切走即出草稿态（再点 ＋新会话 可重开） */
    var fromSid = currentSid; /* 离去会话——W6复核修 Important#2②：在飞 btw 轮结算的归属判据 */
    if (streamCtl) { streamCtl.close(); streamCtl = null; }
    currentSid = sid;
    settleBtwOnSwitch(fromSid); /* 切走结算：离去会话 btw tab 在飞轮落终态 + 活跃者重渲刷 composer 门控（Important#2①） */
    btwClosedTabs.clear(); /* 走查修⑫：已关 tab 防复活册随切换清——btw 帧只在当前会话 SSE 流里，换流即失效 */
    unlockBtwOnReturn(); /* 切回解锁（W6复核修二）：A→B→A 回环——归属新 currentSid 的活跃 btw tab 仍持离去时锁态渲染 */
    /* 服务端游标同步（fire-and-forget）——B1「＋新会话跟随当前项目」与左栏 cur 标记的 server 侧真源 */
    A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/current', { method: 'POST', body: '{}' }).then(null, function () { /* 游标同步失败无碍视图 */ });
    seenSet(sid);
    var f = findRow(sid);
    var label = f && f.row.label !== '' ? f.row.label : OrosusI18N.t('web.session.freshTitle');
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
      onCompactionDone: function (text) { toast(text, 6000); }, /* 走查修⑩：落定提示挪 toast（不占流区行文） */
      onCompactionOpen: function () { openCompactWindow(); }, /* 走查修⑩：横杠点开摘要弹窗 */
      cwdOf: function () { return sessionCwd; },
    });
    renderSidebar();
    syncCwdGate();
    /* status 先行（cwd/芯片基准——工具行相对化与 @ 菜单基址），回放随后 */
    var wireStream = function (after) {
      if (currentSid !== sid) return;
      streamCtl = A.openStream(sid, after, {
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
    };
    var eventsLoaded = fetchStatus(sid).then(function () {
      return A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/events');
    }).then(function (r) {
      if (currentSid !== sid) return;
      /* 走查（2026-10-16 用户报障「仅 web 启动后第一次开弹窗慢」）：流连接提前到首屏装帧之前——
       * 事件响应一到即连（after = 本页最大 seq），dialog/interaction 帧不再排在 200 条首屏 DOM
       * 装帧之后；装帧与流续读并行（JS 单线程：ingest 同步跑完才轮到 SSE 回调，序不乱）。 */
      var mx = 0;
      (r.events ?? []).forEach(function (e) { if (e && typeof e.seq === 'number' && e.seq > mx) mx = e.seq; });
      wireStream(mx);
      render.ingest(r.events ?? [], { page: 'latest' }); /* 首屏有界（§5 律三：每页 ≤200） */
    }, function () { /* 回放失败静默——SSE 兜底连流（after=0 全量，与旧行为一致） */ wireStream(0); });
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
    paneTabsEl.innerHTML = OrosusI18N.t('web.pane.emptyHtml');
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
  /* 顶栏入口（走查修①——2026-10-13 用户口令，对齐图2 ZCode 形态）：◧ 分栏 = 打开 / 关闭。
   *  打开时零 tab → 「打开标签页」选择器（pane.js 空态承载）；有 tab → 原样恢复（收回不清卡——
   *  未全关的 tab 重开再现，口令第三条）；子代理开卡入口 = 主流 spawn 组行点击（/tasks 已下线）。 */
  $('btn-split').addEventListener('click', function () {
    if (paneIsOpen()) { closePane(); toast(OrosusI18N.t('web.pane.collapsedToast')); return; }
    UI.openPane();
  });

  /* ═══════════ 子代理选项卡（问题 2 W3——v2 4393-4481/4520-4545/4683-4688/2528-2537 直裁） ═══════════
   * · 走查修①（2026-10-13 用户口令）：/tasks 命令入口已下线（原「批量开 tab」形态废弃）——子代理
   *   开卡入口 = 主流 spawn 组行点击 + 名册回填补行（走查修②）；◧ 分栏钮 = 纯开合（选择器/记忆恢复）；
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
    return [{ kind: 'btw', label: OrosusI18N.t('web.btw.plusLabel'), prefix: '✦ ', open: function () { openBtwTab(); } }];
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
  /** 主流 sg-row 点击 → agent open-or-switch（v2 openAgentTab 4431-4441）：名册查证 label 后进分栏。 */
  function openAgentTab(id) {
    if (currentSid === null) return;
    var sid = currentSid;
    var known = rosterRowOf(id);
    if (known !== null) { addAgentTab(sid, known); return; }
    refreshTasks(sid).then(function (rows) {
      var tk = null;
      for (var oi = 0; oi < rows.length; oi++) if (rows[oi].id === id) tk = rows[oi];
      if (!tk) { toast(OrosusI18N.t('web.spawn.notFoundPrefix') + id + OrosusI18N.t('web.spawn.notFoundSuffix')); return; }
      addAgentTab(sid, tk);
    }, function () { toast(OrosusI18N.t('web.spawn.rosterFail')); });
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
    bodyEl.innerHTML = OrosusI18N.t('web.spawn.loadingHtml');
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
      bar.innerHTML = '<span class="st-warn">◉</span><span class="aga-text">⚠ ' + esc(pa.tool ?? '') + OrosusI18N.t('web.spawn.awaitSeg') + esc(pa.reason ?? '') + '</span>' +
        OrosusI18N.t('web.spawn.approvalBtnsHtml');
      wrapEl.insertBefore(bar, streamEl);
    }
    function syncSpinner(row) {
      var want = !!row && row.status === 'running';
      var has = streamEl.querySelector('.agent-spin') !== null;
      if (want === has) return;
      if (want) {
        var sp = document.createElement('div');
        sp.className = 'line dim agent-spin';
        sp.innerHTML = spinSvg('', 12) + OrosusI18N.t('web.spawn.generatingSeg');
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
      fl.innerHTML = '<button class="tf-pill" data-agtf="' + esc(id) + OrosusI18N.t('web.pane.todoBtnTitleHtml') + esc(id.slice(0, 4)) + '</span><span class="ok">✓</span> <span class="tf-count">' + done + '/' + tasks.length + OrosusI18N.t('web.pane.todoBtnSeg') +
        '<div class="tf-card"' + (agTodoOpen ? '' : ' hidden') + OrosusI18N.t('web.pane.todoHeadSeg') + esc(id) + '</span><span>' + done + '/' + tasks.length + '</span></div><div class="tf-list">' +
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
          toast((allow ? OrosusI18N.t('web.spawn.okPrefix') : OrosusI18N.t('web.spawn.denyPrefix')) + id + OrosusI18N.t('web.spawn.possSeg') + (data.label || OrosusI18N.t('web.render.spawn.labelFallback')));
          return refreshTasks(sid);
        }, function (err) {
          answerBusy = false;
          toast(OrosusI18N.t('web.toast.answerFail') + err.message);
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
        if (streamEl.getAttribute('data-n') === null) streamEl.textContent = OrosusI18N.t('web.spawn.replayFail');
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
  function loadBtwModelPref() { /* 走查修⑨③：偏好懒载一次——到达时若活跃 tab 是 btw 即重渲芯片 */
    if (btwModelPrefLoaded) return;
    btwModelPrefLoaded = true;
    A.fetchJson('/api/settings/prefs').then(function (pf) {
      btwModelPref = pf && typeof pf.btwModel === 'string' && pf.btwModel !== '' ? pf.btwModel : null;
      var t = Pane.activeTab();
      if (t && t.kind === 'btw') Pane.rerenderBody();
    }, function () { /* 读失败按无偏好 */ });
  }
  /* 走查修⑫（2026-10-14 用户口令④）：侧问 tab 被关 = 其归属会话的 per-tab 在飞轮立即 abort
   *  （POST /btw {tab, abort:true}——composer ■ 停止同款通道，server abortBtw 落定〔已停止〕）。
   *  边界口径：◧ 分栏收回不是关 tab（走查修①记忆保留——帧照落 data，工作不停）；子代理 tab 不在
   *  本面（server 侧任务自管，关 tab 只是关窗）。已关 tab id 入 btwClosedTabs 册——abort 后迟到帧
   *  不再触发 btwFeed 的自动开 tab（防复活）；册随切会话清（帧只在当前会话流里）。 */
  var btwClosedTabs = new Set();
  Pane.onTabClosed = function (tab) {
    if (!tab || tab.kind !== 'btw' || !tab.data) return;
    btwClosedTabs.add(tab.id);
    var rounds = tab.data.rounds ?? [];
    var last = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    var inFlight = !!last && (last.phase === 'answering' || last.phase === 'tool' || last.phase === 'thinking' || (last.a == null && last.phase !== 'error'));
    if (!inFlight) return; /* 无在飞轮零请求——已落定轮次纯本地态，server 侧无可停 */
    if (!tab.data.sid || tab.data.sid !== currentSid) return; /* 跨会话 tab 切走时已在飞结算（本地口径），其 SSE 流随切走关闭——无帧可等，无流可停 */
    A.fetchJson('/api/sessions/' + encodeURIComponent(tab.data.sid) + '/btw', { method: 'POST', body: JSON.stringify({ tab: tab.id, abort: true }) })
      .then(null, function () { /* abort 失败静默——tab 已关，server 侧残轮随会话关停兜底 abort（btw-service 会话级保险丝） */ });
  };
  function openBtwTab() {
    loadBtwModelPref();
    btwSeq++;
    var spec = Pane.btwTabSpec(btwSeq);
    spec.data.sid = currentSid; /* 归属会话（POST /btw 落点——切会话后 tab 内发问仍指原会话） */
    Pane.addTab(spec);
    return Pane.activeTab(); /* addTab 尾插即激活——返回新实例（data 与 spec 同引用） */
  }
  /* 走查修⑨（2026-10-14 用户口令）：btw 模型覆盖菜单。走查修⑪起复用主两栏 modelmenu（弹窗形态
   *  与主代理一份——平铺限定形长名单退役，前缀截断问题随两栏消解）；tab 级临时覆盖语义经 opts 钩子
   *  注入（写 tab.data.btwModel，下次发问随 POST /btw 携带——主默认面的 POST /model 写会话语义
   *  在此刻意不复用）。「跟随…」行 = 清覆盖（落定 侧问偏好 ?? 会话当前，括注报落定值）。 */
  function openBtwModelMenu(tab, anchorEl) {
    if (!tab) return;
    var effective = tab.data.btwModel || btwModelPref || currentModel; /* 跟随落定值——初始落栏 + 「跟随」行括注 */
    UI.openModelMenu(anchorEl, {
      current: tab.data.btwModel || '', /* 勾标 = 覆盖目标限定形；空串 = 跟随态（仅「跟随」行出勾） */
      focus: effective,
      follow: {
        label: (btwModelPref ? OrosusI18N.t('web.btw.followPrefSeg') : OrosusI18N.t('web.btw.followSessionSeg')) + modelTail(effective) + '）',
        checked: !tab.data.btwModel,
      },
      onSwitch: function (pk, mn) {
        if (pk === null || mn === null) delete tab.data.btwModel; else tab.data.btwModel = pk + '/' + mn;
        Pane.rerenderBody(); /* 芯片现算刷新 */
      },
    });
  }
  /* 思考档覆盖菜单：档位取自生效模型（覆盖模型 ?? 会话当前）的目录声明；无声明按主菜单同款提示。 */
  function openBtwEffortMenu(tab, anchorEl) {
    if (!tab) return;
    UI.fetchModels().then(function (data) {
      if (!data) { toast(OrosusI18N.t('web.ui.model.fetchFail')); return; }
      var effective = tab.data.btwModel || currentModel;
      var plat = (data.providers ?? []).find(function (p) { return effective.indexOf(p.key + '/') === 0 || p.key === effective; });
      var modelName = effective.indexOf('/') >= 0 ? effective.slice(effective.indexOf('/') + 1) : effective;
      var entry = plat ? (plat.models ?? []).find(function (m) { return m.name === modelName; }) : null;
      /* 裸平台键形态（目录的 models[].name 有的带限定形有的不带——两段都试） */
      if (!entry && plat) entry = (plat.models ?? []).find(function (m) { return (plat.key + '/' + m.name) === effective || m.name === effective; });
      var efforts = (entry && entry.efforts) || [];
      if (efforts.length === 0) {
        toast(OrosusI18N.t('web.btw.noEffortPrefix') + (modelName || OrosusI18N.t('web.ui.effort.unconfigured')) + OrosusI18N.t('web.btw.noEffortSeg'));
        return;
      }
      var items = [{ html: '<span class="pu-caret">❯</span><span class="pu-check">' + (!tab.data.btwEffort ? '✓' : '') + OrosusI18N.t('web.btw.followSessionHtml') + esc(currentEffort !== '' ? currentEffort : '—') + '）</span>', data: '' }];
      efforts.forEach(function (v) {
        items.push({ html: '<span class="pu-caret">❯</span><span class="pu-check">' + (tab.data.btwEffort === v ? '✓' : '') + '</span><span class="pi-name">' + esc(v) + '</span>', data: v });
      });
      UI.openPick({
        mini: 'right', anchor: anchorEl, title: OrosusI18N.t('web.btw.effortTitle'), en: 'EFFORT', items: items,
        foot: OrosusI18N.t('web.btw.effortFoot'),
        onPick: function (i) {
          var v = items[i] && items[i].data;
          if (v === undefined) return;
          if (v === '') delete tab.data.btwEffort; else tab.data.btwEffort = v;
          Pane.rerenderBody();
        },
      });
    }, function () { toast(OrosusI18N.t('web.ui.model.fetchFail')); });
  }
  function btwLabelOf(tabId) {
    var m = /^btw-(\d+)$/.exec(String(tabId || ''));
    return m !== null ? OrosusI18N.t('web.btw.labelPrefix') + m[1] : String(tabId || OrosusI18N.t('web.btw.plusLabel'));
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
        UI.openPane(); /* 走查修⑧（用户报障「/btw 打不开分栏」）：复用空草稿也必须开栏——tab 记忆保留
                         *  后，保留的空草稿 tab 在栏关着时仍在册，activateTab 只切显不开栏 */
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
    if (!tab.data.sid) { toast(OrosusI18N.t('web.welcome.noSession.pick')); return; } /* 无会话不开问——输入未清（不走重渲），问文保留 */
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
    A.fetchJson('/api/sessions/' + encodeURIComponent(tab.data.sid) + '/btw', { method: 'POST', body: JSON.stringify({
      tab: tab.id, q: q,
      ...(tab.data.btwModel ? { model: tab.data.btwModel } : {}), /* 走查修⑨：tab 级临时覆盖随问携带 */
      ...(tab.data.btwEffort ? { effort: tab.data.btwEffort } : {}),
    }) }).then(null, function (err) {
      rd.phase = 'error';
      rd.a = OrosusI18N.t('web.toast.sendFail') + err.message;
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
      if (btwClosedTabs.has(frame.tab)) return; /* 走查修⑫：已关 tab 的迟到帧（abort 途中的在飞尾帧）——不复活 */
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
    /* 走查修⑨：芯片显示 = tab 覆盖值 ?? 会话当前（渲染期现算——会话换模型/档后重渲即跟随） */
    data.chipModel = data.btwModel ? modelTail(data.btwModel) : modelTail(btwModelPref || currentModel); /* 走查修⑨③：tab 覆盖 > 侧问偏好 > 会话当前 */
    data.chipEffort = data.btwEffort ? data.btwEffort : (currentEffort !== '' ? currentEffort : '—');
    bodyEl.innerHTML = Pane.btwTabHtml(data, locked);
    var bForm = bodyEl.querySelector('#btw-form');
    var bInput = bodyEl.querySelector('#btw-input');
    var bSend = bodyEl.querySelector('#btw-send');
    function syncBtn() { if (bSend.hasAttribute('data-btwstop')) return; bSend.className = 'sendbtn ' + (bInput.value.trim() ? 'ready' : 'idle'); }
    if (!btwRenderNoFocus) bInput.focus(); /* 用户驱动开 tab/切换即聚焦（v2 4551）；帧驱动重渲不抢焦点 */
    bInput.addEventListener('input', function () {
      syncBtn();
      UI.inputChanged(bInput, { anchor: bForm, atOnly: true }); /* 走查修⑫：@ 文件菜单锚侧问 composer（宽随锚）；atOnly——侧问无斜杠命令语义 */
    });
    bInput.addEventListener('keydown', function (e) {
      if (UI.handleInputKey(e)) { e.stopPropagation(); return; } /* 走查修⑫：@ 菜单/芯片菜单开着时 ↑↓/Enter/Esc/Tab 归浮层（Enter 不再误发送） */
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
      A.fetchJson('/api/sessions/' + encodeURIComponent(tab.data.sid) + '/btw', { method: 'POST', body: JSON.stringify({ tab: tab.id, abort: true }) }).then(null, function () { toast(OrosusI18N.t('web.btw.stopFail')); });
    });
    /* 走查修⑨：模型/思考档芯片——tab 级临时覆盖菜单（写 tab.data.btwModel/btwEffort，下次发问随
     *  POST /btw 携带；「跟随会话当前」行 = 清覆盖）。走查修⑫：toggle 统一口径——本芯片菜单开着再点 = 关。 */
    var bModelChip = bodyEl.querySelector('#btw-model');
    if (bModelChip) bModelChip.addEventListener('click', function () { if (UI.isAnchorOpen(bModelChip)) { UI.closePopup(); return; } openBtwModelMenu(Pane.activeTab(), bModelChip); });
    var bEffortChip = bodyEl.querySelector('#btw-effort');
    if (bEffortChip) bEffortChip.addEventListener('click', function () { if (UI.isAnchorOpen(bEffortChip)) { UI.closePopup(); return; } openBtwEffortMenu(Pane.activeTab(), bEffortChip); });
    bodyEl.querySelector('#btw-file').addEventListener('click', function () { /* ＋文件 = 插入 @（光标位）并开文件菜单（走查修⑫ 前只插 @ 不开窗） */
      if (UI.openKind() === 'at') { UI.closePopup(); return; } /* 再点 = 收（toggle 统一口径） */
      bInput.focus();
      var s = bInput.selectionStart ?? bInput.value.length;
      var epos = bInput.selectionEnd ?? s;
      var pad = s > 0 && bInput.value.charAt(s - 1) !== ' ' ? ' ' : '';
      bInput.value = bInput.value.slice(0, s) + pad + '@' + bInput.value.slice(epos);
      var pos = s + pad.length + 1;
      bInput.setSelectionRange(pos, pos);
      syncBtn();
      UI.inputChanged(bInput, { anchor: bForm, atOnly: true });
    });
    var bs = bodyEl.querySelector('#btw-stream');
    bs.scrollTop = bs.scrollHeight; /* 贴底（v2 4565-4566） */
  });

  /* 面板渲染（2s 轮询 + 签名门——数据不变 DOM 零触碰；运行时间跳秒本地自增） */
  var TICK = { pending: '○', active: '◐', done: '✓' };
  var MOD_STATE_TEXT = { get mounted() { return OrosusI18N.t('web.misc.modSt.mounted'); }, get loading() { return OrosusI18N.t('web.misc.modSt.loading'); }, get off() { return OrosusI18N.t('web.misc.modSt.off'); }, get pendingConfirm() { return OrosusI18N.t('web.misc.modSt.pendingConfirm'); } }; /* web-i18n E8：模块级状态图改惰性取表（getter——E6 SET_PAGES/E7 MCP_STATE_TEXT 先例） */
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
    var tip = m.locked ? (m.lockedReason ?? OrosusI18N.t('web.toast.lockedNoPlug')) : (MOD_STATE_TEXT[m.state] ?? m.state);
    return '<div class="mod ' + esc(m.state) + '" data-mod="' + esc(m.name) + '" title="' + esc(tip) + '">' +
      '<span class="dot">' + dot + '</span><span class="mname">' + esc(m.name) + (m.locked ? OrosusI18N.t('web.misc.modLockHtml') : '') + '</span>' +
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
      connListEl.innerHTML = lastConns.slice(pg.from, pg.to).map(connRowHtml).join('') || OrosusI18N.t('web.misc.connEmptyHtml');
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
      return '<div class="todo" data-state="' + esc(t.state) + OrosusI18N.t('web.misc.todoSyncHtml') + (TICK[t.state] ?? '○') + '</span><span class="ttext">' + esc(t.text) + '</span></div>';
    }).join('');
  }
  function renderTfList() {
    var tasks = panelInfo ? panelInfo.data.tasks ?? [] : [];
    $('tf-list').innerHTML = todoHtml(tasks);
  }
  function renderPanel(data) {
    /* 运行状态 kv + 上下文条。
     *  走查修⑬（2026-10-14 用户报障「右栏会话名恒显新会话」）：kv-session 单写者化——本函数不再写
     *  它。旧面两处写源互踩：panel 轮询写 server 内核投影（sessionLabelOf 只认 session/label 事件——
     *  未 /title 的会话恒「新会话」），把 setSessionTitle 写入的左栏派生名（首条用户消息——顶栏/左栏
     *  同源口径）覆盖掉。data.session 同步出 sig（陈旧值拍动不再触发 kv 重渲）。 */
    var sig = [data.model, data.cwd, data.tokens && data.tokens.input, data.tokens && data.tokens.output, data.tokens && data.tokens.cacheHitPct, data.ctx && data.ctx.pct, data.ctx && data.ctx.used, data.ctx && data.ctx.window].join('|');
    if (sig !== kvSig) {
      kvSig = sig;
      $('kv-model').textContent = data.model ?? '—';
      $('kv-cwd').textContent = data.cwd ?? '—';
      var tk = data.tokens;
      $('kv-tokens').textContent = tk ? '↑ ' + (tk.input ?? 0).toLocaleString() + ' · ↓ ' + (tk.output ?? 0).toLocaleString() + ' · ' + (tk.cacheHitPct === undefined ? '—' : tk.cacheHitPct + '%') : '—';
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
        html2 += OrosusI18N.t('web.misc.peers.headHtml');
        (peers.list ?? []).forEach(function (p) { html2 += peerHtml(p, false); });
        if (!(peers.list ?? []).length) html2 += OrosusI18N.t('web.misc.peers.emptyHtml');
      } else {
        html2 = OrosusI18N.t('web.misc.peers.noDataHtml');
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
      $('todo-list').innerHTML = todoHtml(tasks) || OrosusI18N.t('web.misc.todoEmptyHtml');
      $('todo-count').textContent = done + '/' + tasks.length;
      $('todo-bar').style.width = (tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0) + '%';
      $('tf-count').textContent = done + '/' + tasks.length;
      $('tf-count2').textContent = done + '/' + tasks.length;
      if (!tfCard.hidden) renderTfList();
      syncTodoFloat(); /* 清单空 ↔ 非空切换时悬浮条可见性跟随（v2 静态 todos 的实数据适配——签名门内，数据不变不碰 DOM） */
    }
  }
  function peerHtml(p, self) {
    var map = { running: ['●', 'ph-running', OrosusI18N.t('web.misc.peers.phRunning')], 'waiting-approval': ['◉', 'ph-wait', OrosusI18N.t('web.misc.peers.phApproval')], 'waiting-input': ['◉', 'ph-wait', OrosusI18N.t('web.misc.peers.phInput')], error: ['✗', 'ph-error', OrosusI18N.t('web.render.tail.lastErr')], idle: ['○', 'ph-idle', OrosusI18N.t('web.misc.peers.phIdle')] }; /* web-i18n E8：上轮报错 → web.render.tail.lastErr（w-4 复用节——原键 phError 已并键） */
    var ph = map[p.phase] ?? ['○', 'ph-idle', p.phase ?? ''];
    var label = p.label ?? p.sid;
    var row = '<div class="peer' + (self ? ' self' : '') + '" title="' + esc(label) + (self ? OrosusI18N.t('web.misc.peers.selfTitleSeg') : '') + '">' +
      '<span class="ph ' + ph[1] + '">' + ph[0] + '</span><span class="pname">' + ph[2] + '</span>' +
      '<span class="ptitle">' + esc(label) + '</span><span class="pmeta">' + (self ? OrosusI18N.t('web.misc.peers.self') : esc(fmtRel(Date.now() - (p.lastEventAt ?? Date.now())))) + '</span></div>';
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
      $('ab-addr').textContent = location.host + OrosusI18N.t('web.misc.tokenOkSeg');
      $('welcome-ver').textContent = 'v' + (h.version ?? '?');
      /* web-i18n M4：语言解析与取表并入启动序（Promise.all 门控首渲染——首渲染即目标语言）。
       * current === '' = 随系统 → 浏览器语（spec §3）；取表失败 = loadMessages 自示 #i18n-fail 并抛
       * → 本 all 拒绝 → 下方兜底分支 showDisconnect('lost')（z 80）——兜底块 z 90 压其上，重试钮可点。 */
      return Promise.all([
        A.fetchJson('/api/bootstrap'), guiPreferencesReady,
        A.fetchJson('/api/settings/locale').then(function (lc) {
          var tag = lc.current === '' ? OrosusI18N.normalizeLocaleTag(navigator.language) : lc.current; /* 随系统=浏览器测（spec §3） */
          return loadMessages(tag);
        }),
      ]);
    }, function () {
      A.showDisconnect('lost', function () {
        A.fetchJson('/api/health').then(function () { location.reload(); }, function () { /* 仍断开 */ });
      });
      return null;
    }).then(function (startup) {
      var bs = startup === null ? null : startup[0];
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
        tailEl.textContent = OrosusI18N.t('web.welcome.noSession.start');
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
  var SPAWN_ST = { get queued() { return [OrosusI18N.t('web.spawn.st.queued'), 'st-run']; }, get running() { return [OrosusI18N.t('web.spawn.st.running'), 'st-run']; }, get completed() { return [OrosusI18N.t('web.spawn.st.completed'), 'st-ok']; }, get failed() { return [OrosusI18N.t('web.common.fail'), 'st-err']; } }; /* web-i18n E8：名册状态图惰性取表（失败 → web.common.fail，w-4 复用节） */
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
    /* 走查修②（2026-10-13 用户报障「8 子代理不全可点」）：名册回填——结果文本溢写截断/旧格式
     *  致 spawnIdsIn 漏抠的编号，盘上有会话文件（名册来自目录扫描=真源）就补行进末个组卡，
     *  否则这些子代理在 web 再无入口（/tasks 已随口令下线）。补行带点击（openAgentTab 同款）。 */
    var groups = document.querySelectorAll('.spawn-group');
    var lastG = groups.length > 0 ? groups[groups.length - 1] : null;
    if (lastG !== null) {
      var gList = lastG.querySelector('.sg-list');
      rows.forEach(function (e) {
        if (e.depth !== 1) return; /* 孙代理的行挂在父行下（如有）——本批只补一代行 */
        if (lastG.querySelector('.sg-row[data-agent-id="' + e.id + '"]')) return;
        var st = SPAWN_ST[e.status] ?? [String(e.status), 'st-run'];
        var row = document.createElement('div');
        row.className = 'sg-row';
        row.setAttribute('data-agent-id', e.id);
        row.title = OrosusI18N.t('web.spawn.rowTip');
        var caret = document.createElement('span'); caret.className = 'sg-caret'; caret.textContent = '├─';
        var nm = document.createElement('span'); nm.className = 'sg-name'; nm.textContent = e.label || e.id;
        var idEl = document.createElement('span'); idEl.className = 'sg-id'; idEl.textContent = e.id;
        var stEl = document.createElement('span'); stEl.className = 'sg-st ' + st[1]; stEl.textContent = st[0];
        row.appendChild(caret); row.appendChild(nm); row.appendChild(idEl); row.appendChild(stEl);
        row.addEventListener('click', function () { openAgentTab(e.id); });
        if (gList) gList.appendChild(row);
      });
    }
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
          stEl.textContent = st[0] + (e.pendingApproval ? OrosusI18N.t('web.spawn.awaitSuffix') : '');
          stEl.className = 'sg-st ' + st[1] + (e.pendingApproval ? ' st-warn' : '');
        }
        if (e.status === 'running' || e.status === 'queued') running++;
        else if (e.status === 'completed') done++;
        else if (e.status === 'failed') failed++;
      });
      var sum = g.querySelector('.sg-sum');
      if (sum && n > 0) {
        /* 头行聚合（TUI agentGroupLines 同款四态）：活动>0 运行中 M；全成 已完成；全败 失败；混合 M/N 完成 */
        sum.textContent = '· ' + n + OrosusI18N.t('web.spawn.sumTasksSeg') +
          (running > 0 ? OrosusI18N.t('web.spawn.sumRunningSeg') + running + (done + failed > 0 ? OrosusI18N.t('web.spawn.sumEndedSeg') + (done + failed) : '')
            : failed === 0 ? OrosusI18N.t('web.spawn.sumAllDone')
            : done === 0 ? OrosusI18N.t('web.spawn.sumAllFail')
            : done + '/' + n + OrosusI18N.t('web.spawn.sumDoneSeg'));
      }
    });
  }
  /* 全局 Esc（输入框外）：确认层/居中弹窗让位（T15 处理器管）→ 浮层 → 悬浮卡 → 双击停止 */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (document.activeElement !== input) handleEscGlobal();
  });
  guiPreferencesReady = loadGuiPreferences();
  boot();
})();
