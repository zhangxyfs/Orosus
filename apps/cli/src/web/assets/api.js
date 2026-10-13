/* Orosus web 前端基建（web 批 T15）——api.js：token 链 / fetchJson / SSE openStream（断线重连）/
 * rafFlush 合帧器 / 轮询统一节拍器 / 断连弹窗（G15 两档）。
 * 导出面挂 window.OrosusAPI（app.js/render.js(T16)/ui.js(T17) 消费；经典脚本零构建）。
 * 性能律（§5 律二/律三）：轮询回调里做字段 diff 后按需更新 DOM——本件只供机制，diff 在消费侧。 */
(function () {
  'use strict';

  /* ═══════════ token 链（T1 口径）：?token= → sessionStorage → X-Orosus-Token 头 + SSE URL 带 token ═══════════ */
  var TOKEN_KEY = 'orosus-web-token';
  var token = '';
  (function bootToken() {
    try {
      var t = new URLSearchParams(location.search).get('token');
      if (t !== null && /^[0-9a-f]{64}$/i.test(t)) {
        sessionStorage.setItem(TOKEN_KEY, t);
        /* 从地址栏摘除 token（历史记录/复制链接不再带令牌；刷新后走 sessionStorage） */
        history.replaceState(null, '', location.pathname);
      }
      token = sessionStorage.getItem(TOKEN_KEY) || '';
    } catch { /* 隐私模式等存储拒绝——token 留空，断连弹窗会指路 */ }
  })();
  function getToken() { return token; }
  function authHeaders() { return token ? { 'x-orosus-token': token } : {}; }

  /** fetch JSON 封装：非 2xx 抛 Error（status/body 附体；error 字段优先为文案）。
   *  DELETE 无 body 也带 content-type: application/json——server 写方法护栏对 DELETE 同样生效
   *  （T1 护栏；T16 修复：队列撤回/会话删除的无 body DELETE 此前会被 415 拦下）。 */
  function fetchJson(path, init) {
    init = Object.assign({}, init);
    /* 超时护栏（2026-10-12 走查六根因修）：fetch 无超时——一个永不 settle 的请求会把调用方的
     *  in-flight 互斥（轮询 p.busy）永久卡死，sessions/panel 轮询整页冻结、运行中转圈不显示即此。
     *  init.timeoutMs（非 fetch 标准键——摘除不进 init）到期 AbortController 中止 → reject 走原失败面。 */
    var timer = null;
    if (typeof init.timeoutMs === 'number' && init.timeoutMs > 0) {
      var ctrl = new AbortController();
      init.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, init.timeoutMs);
    }
    delete init.timeoutMs;
    var headers = Object.assign({}, authHeaders(), init.headers || {});
    if (init.body !== undefined || (init.method || 'GET') === 'DELETE') headers['content-type'] = 'application/json';
    var done = fetch(path, Object.assign({}, init, { headers: headers })).then(function (res) {
      return res.text().then(function (text) {
        var body = {};
        try { body = text ? JSON.parse(text) : {}; } catch { /* 非 JSON 错误壳 */ }
        if (!res.ok) {
          var err = new Error(body && body.error ? body.error : 'HTTP ' + res.status);
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });
    });
    if (timer !== null) done.finally(function () { clearTimeout(timer); });
    return done;
  }

  /* ═══════════ rafFlush：全局合帧器（§5 律二）——同帧多次调用同一 fn 只执行一次。
   *  rAF + 200ms 定时器兜底（2026-10-12 走查三轮——调研 §2.7 Reasonix rafBatch 同款）：后台标签/
   *  WebView 节流时 rAF 停摆但 timer 仍触发——面板渲染等 rafFlush 链不再整体卡死；rAF 先到则取消
   *  timer（前台零行为变化）。 */
  var rafPending = new Map();
  function rafFlush(fn) {
    if (rafPending.has(fn)) return;
    var entry = {};
    rafPending.set(fn, entry);
    var run = function () {
      if (!rafPending.has(fn)) return;
      rafPending.delete(fn);
      if (entry.raf !== undefined) cancelAnimationFrame(entry.raf);
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      fn();
    };
    entry.raf = requestAnimationFrame(run);
    entry.timer = setTimeout(run, 200);
  }

  /* ═══════════ 轮询统一节拍器（§5）：1s 基拍；sessions（2s）与 panel（2s）同拍错峰 1s ═══════════ */
  var TICK_MS = 1000;
  var tickN = 0;
  var pollers = [];
  setInterval(function () {
    tickN++;
    for (var i = 0; i < pollers.length; i++) {
      var p = pollers[i];
      if (p.stopped || p.busy) continue;
      if ((tickN - p.offset) % p.every === 0) runPoll(p);
    }
  }, TICK_MS);
  function runPoll(p) {
    p.busy = true;
    /* 看门狗（2026-10-12 走查六根因修）：fn 内请求挂起（fetch 原生无超时）时 12s 兜底释放互斥——
     *  此前一次挂起即永久卡死（sessions/panel 轮询整页冻结、运行中侧栏不转圈的根因）。迟到响应
     *  写回无害（渲染幂等）；fn 侧另有 timeoutMs 中止档（真正掐断请求）。 */
    var release = function () { p.busy = false; };
    Promise.resolve().then(p.fn).catch(function () { /* 轮询失败静默（断连面由 SSE 看门狗管） */ }).then(release);
    setTimeout(release, 12000);
  }
  /** 注册轮询（intervalMs/offsetMs 以秒级取整；返回 {stop}）。in-flight 互斥：上一次未回不发下一次。 */
  function addPoll(intervalMs, offsetMs, fn) {
    var p = { every: Math.max(1, Math.round(intervalMs / TICK_MS)), offset: Math.max(0, Math.round((offsetMs || 0) / TICK_MS)), fn: fn, busy: false, stopped: false };
    pollers.push(p);
    return { stop: function () { p.stopped = true; } };
  }

  /* ═══════════ 断连弹窗（G15）——两档：lost（重连耗尽，可重试）/ shutdown（已正常关闭，停重连） ═══════════ */
  var DISC_LOST_MS_TITLE = '与 Orosus server 的连接已断开';
  var overlayDisc, discTitle, discBody, discRetry;
  function ensureDiscDom() {
    if (overlayDisc !== undefined) return;
    overlayDisc = document.getElementById('overlay-disc');
    discTitle = document.getElementById('disc-title');
    discBody = document.getElementById('disc-body');
    discRetry = document.getElementById('disc-retry');
    if (discRetry) discRetry.addEventListener('click', function () {
      discRetry.textContent = '正在重试…';
      if (discRetryFn) discRetryFn();
      /* 兜底探测：立即打一次 /api/health（token 沿用——同端口重启即可成功，G15 恢复链） */
      fetchJson('/api/health').then(function () {
        /* health 活——若流尚未自动复连（无 openStream 的启动期），刷新整页走完整启动序 */
        if (discRetryFn === null) location.reload();
      }, function () { /* 仍在断开——弹窗保留，后台持续重连 */ });
    });
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /** 显示断连弹窗。variant：'lost'（断开——重试按钮后台持续重连，成功自动消）| 'shutdown'（server 已
   *  正常关闭——停止重连）| 'notoken'（本页无令牌——指路终端网址）。onRetry 由 openStream 注入。 */
  var discRetryFn = null;
  function showDisconnect(variant, onRetry) {
    ensureDiscDom();
    if (onRetry) discRetryFn = onRetry;
    if (variant === 'shutdown') {
      discRetryFn = null; /* 停止自动重连——重试钮转为手动恢复口（health 活即整页重启动序） */
      discTitle.textContent = 'server 已正常关闭';
      discBody.innerHTML = 'server 进程已正常退出（收到关闭信号）。<br>' +
        '请回到终端重新运行 <b>orosus web</b>（或 TUI 中 <b>/web</b>），然后点击重试或刷新本页。' +
        '<div class="dim disc-hint">若重试持续失败，server 可能已换用新端口——请以终端最新打印的网址打开。</div>';
      discRetry.hidden = false;
      discRetry.textContent = '重试连接';
    } else if (variant === 'notoken') {
      discRetryFn = null;
      discTitle.textContent = '本页缺少访问令牌';
      discBody.innerHTML = '本页未携带访问令牌（token）。<br>' +
        '请回到终端查看 <b>orosus web</b> 打印的网址（含 <b>?token=</b> 参数），用该网址打开本页。' +
        '<div class="dim disc-hint">令牌只在首次打开时随网址带入，随后保存在本标签页会话存储中。</div>';
      discRetry.hidden = true;
    } else {
      discTitle.textContent = DISC_LOST_MS_TITLE;
      discBody.innerHTML = 'server 进程可能已退出（终端被关闭或已 Ctrl+C）。<br>' +
        '请回到终端重新运行 <b>orosus web</b>（或 TUI 中 <b>/web</b>），然后点击重试或刷新本页。' +
        '<div class="dim disc-hint">若重试持续失败，server 可能已换用新端口——请以终端最新打印的网址打开。</div>';
      discRetry.hidden = false;
      discRetry.textContent = '重试连接';
    }
    overlayDisc.hidden = false;
  }
  function hideDisconnect() {
    ensureDiscDom();
    overlayDisc.hidden = true;
  }

  /* ═══════════ openStream：EventSource 封装 + 断线重连（指数退避 ≤3 次短窗，随后 8s 慢拍） ═══════════
   * 帧面（§3）：ev（id=seq 游标推进）/ chunk / interaction / queue / phase / btw / shutdown；
   * ping 为注释帧不派发。断连判定：首断起 ≈15s 未复连 → lost 弹窗（G15——心跳同频自创值口径）；
   * /api/health 5s 探测兜底（活即立刻补连）。 */
  var FRAME_EVENTS = ['chunk', 'interaction', 'queue', 'phase', 'btw'];
  var DISC_AFTER_MS = 15000;
  var HEALTH_PROBE_MS = 5000;
  var RETRY_FAST = [1000, 2000, 4000]; /* 短窗三次指数退避 */
  var RETRY_SLOW = 8000; /* 短窗后慢拍持续重连（重试按钮同源——成功自动消弹窗） */

  function openStream(sid, after, handlers) {
    handlers = handlers || {};
    var cursor = after || 0;
    var closed = false;
    var shutdownSeen = false;
    var es = null;
    var retryTimer = null;
    var probeTimer = null;
    var firstDropAt = 0;
    var overlayShown = false;
    var attempts = 0; /* 短窗内已失败次数（复连成功归零——退避序随之重计） */

    function streamUrl() {
      return '/api/sessions/' + encodeURIComponent(sid) + '/stream?after=' + cursor + (token ? '&token=' + encodeURIComponent(token) : '');
    }
    function notifyState(st) { if (handlers.onState) handlers.onState(st); }
    function connect() {
      if (closed || shutdownSeen) return;
      es = new EventSource(streamUrl());
      es.addEventListener('open', function () {
        firstDropAt = 0;
        attempts = 0;
        overlayShown = false;
        hideDisconnect();
        notifyState('open');
        if (handlers.onOpen) handlers.onOpen();
      });
      es.addEventListener('ev', function (e) {
        var d = null;
        try { d = JSON.parse(e.data); } catch { return; }
        if (d && typeof d.seq === 'number' && d.seq > cursor) cursor = d.seq;
        if (handlers.onEvent) handlers.onEvent(d);
      });
      FRAME_EVENTS.forEach(function (name) {
        es.addEventListener(name, function (e) {
          var d = null;
          try { d = JSON.parse(e.data); } catch { return; }
          if (handlers[name]) handlers[name](d);
        });
      });
      es.addEventListener('shutdown', function (e) {
        shutdownSeen = true;
        var d = null;
        try { d = JSON.parse(e.data); } catch { /* 帧体可缺 */ }
        teardown();
        showDisconnect('shutdown');
        notifyState('shutdown');
        if (handlers.onShutdown) handlers.onShutdown(d);
      });
      es.addEventListener('error', function () {
        if (closed || shutdownSeen) return;
        teardown();
        scheduleRetry();
      });
    }
    function teardown() {
      if (es) { try { es.close(); } catch { /* 已关 */ } es = null; }
    }
    function scheduleRetry() {
      if (closed || shutdownSeen) return;
      if (firstDropAt === 0) firstDropAt = Date.now();
      var since = Date.now() - firstDropAt;
      if (since >= DISC_AFTER_MS && !overlayShown) {
        overlayShown = true;
        showDisconnect('lost', retryNow);
      }
      var idx = retryCount();
      var delay = idx < RETRY_FAST.length ? RETRY_FAST[idx] : RETRY_SLOW;
      notifyState('disconnected');
      retryTimer = setTimeout(connect, delay);
      startProbe();
    }
    /* 重试序号（短窗内 = 已失败次数；复连成功归零） */
    function retryCount() { return attempts++; }
    function startProbe() {
      if (probeTimer !== null) return;
      probeTimer = setInterval(function () {
        if (closed || shutdownSeen) { stopProbe(); return; }
        fetchJson('/api/health').then(function () {
          /* server 活着而流断着——立刻补连（不必等退避到点） */
          if (!closed && !shutdownSeen && es === null && retryTimer !== null) {
            clearTimeout(retryTimer);
            retryTimer = null;
            connect();
          }
        }, function () { /* 探测也失败 = server 确不可达——弹窗文案已涵盖指引 */ });
      }, HEALTH_PROBE_MS);
    }
    function stopProbe() { if (probeTimer !== null) { clearInterval(probeTimer); probeTimer = null; } }
    function retryNow() {
      if (closed || shutdownSeen) return;
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      connect();
      startProbe();
    }

    connect();
    return {
      close: function () { closed = true; stopProbe(); if (retryTimer !== null) clearTimeout(retryTimer); teardown(); },
      retryNow: retryNow,
      get cursor() { return cursor; },
    };
  }

  /* ═══════════ 导出面（T16/T17 消费） ═══════════ */
  window.OrosusAPI = {
    getToken: getToken,
    fetchJson: fetchJson,
    openStream: openStream,
    rafFlush: rafFlush,
    addPoll: addPoll,
    showDisconnect: showDisconnect,
    hideDisconnect: hideDisconnect,
    esc: esc,
  };
})();
