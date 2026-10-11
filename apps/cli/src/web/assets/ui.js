/* Orosus web 浮层/菜单/审批（web 批 T16）——ui.js：dock 浮层三 kind（menu/pick/view）+
 * mini 锚定 + 键盘（↑↓/Enter/Esc）+ 详释区（原型 :1449-1582 直裁）；
 * 斜杠菜单（命令 + 技能殿后 + 前缀/模糊过滤 + 零命中关窗）、@ 文件菜单（两级下钻）、
 * 审批浮层（interaction 帧 → POST /answer；ask/askSecret/confirm/chooseEx/chooseSide 同族）、
 * 模型/档位/权限芯片菜单、/tasks 浮层、/btw 小窗、cwd 芯片菜单。
 * 依赖：window.OrosusAPI（fetchJson/esc）；宿主回调经 init 注入（app.js）。 */
(function () {
  'use strict';

  var A = globalThis.OrosusAPI;
  var H = null; /* 宿主回调（app.js init 注入） */

  /* ═══════════ dock 浮层框架（三 kind：menu 斜杠菜单 / pick 选择列表 / view 只读窗） ═══════════ */
  var popup = null, pu = null;
  var pendingInteraction = null; /* 当前挂起 interaction（id + answer 口——Esc 取消面） */

  function ensureDom() {
    if (popup !== null) return;
    popup = document.getElementById('popup');
    popup.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) { closePopup(); focusInput(); return; }
      var sw = e.target.closest('[data-sw]');
      if (sw && pu && pu.switchRow) {
        pu.switchRow.idx = parseInt(sw.getAttribute('data-sw'), 10);
        renderPopup();
        return;
      }
      var act = e.target.closest('[data-act]');
      if (act && pu && pu.onAction) { pu.onAction(act.getAttribute('data-act')); return; }
      var item = e.target.closest('.pu-item[data-i]');
      if (!item || !pu) return;
      pu.sel = parseInt(item.getAttribute('data-i'), 10);
      if (pu.onPick) pu.onPick(pu.sel);
    });
    popup.addEventListener('mousemove', function (e) {
      var item = e.target.closest('.pu-item[data-i]');
      if (!item || !pu || pu.kind === 'view') return;
      var i = parseInt(item.getAttribute('data-i'), 10);
      if (i === pu.sel) return;
      pu.sel = i;
      popup.querySelectorAll('.pu-item').forEach(function (el) {
        el.classList.toggle('sel', el.getAttribute('data-i') === String(i));
      });
      if (pu.longOf) {
        var longEl = popup.querySelector('#pu-long');
        if (longEl) longEl.innerHTML = pu.longOf(pu.rows[i], i);
      }
    });
    /* 点击浮层外部 = 关闭（含输入框；豁免各开启控件——composedPath 取派发时刻链）。
     *  挂起的 interaction（审批/问询）不随外击关闭——误触外区不应吞掉审批卡（Esc/✕ 走显式 cancelled）。 */
    document.addEventListener('click', function (e) {
      if (!pu) return;
      if (pendingInteraction) return;
      var path = e.composedPath ? e.composedPath() : [];
      if (path.includes(popup)) return;
      if (e.target.closest('#mode-chip, #model-chip, #effort-chip, #cwd-chip, #btn-file, #kv-model, #send-btn')) return;
      closePopup();
    }, true);
  }

  function esc(s) { return A.esc(String(s ?? '')); }
  function focusInput() { var i = document.getElementById('prompt-input'); if (i) i.focus(); }

  function closePopup() {
    ensureDom();
    popup.hidden = true;
    popup.innerHTML = '';
    popup.classList.remove('anchor-right', 'anchor-left', 'mini-pop');
    popup.style.left = '';
    popup.style.right = '';
    popup.style.bottom = '';
    var p = pu;
    pu = null;
    pendingInteraction = null;
    /* 交互浮层（审批/问询）经 ✕/Esc/外击关闭且未被应答 → onClose 连带 cancelled（T5：Esc =
     *  拒绝并 throw「已取消（Esc）」——静默关窗会把 turn 挂死在等待）。应答路径先置 _answered 再关窗。 */
    if (p && p.onClose && !p.answered) p.onClose();
  }

  /* 两段式渲染（pickLabel 口径）：尾部括注组 / 首个「——」为说明段 */
  function splitLabel(raw) {
    var m = /^(.*?)\s*[（(]([^（）()]*)[）)]\s*$/.exec(raw);
    if (m && m[1].trim() !== '') return { title: m[1], desc: '（' + m[2] + '）' };
    var d = raw.indexOf('——');
    if (d > 0) return { title: raw.slice(0, d), desc: raw.slice(d) };
    return { title: raw, desc: '' };
  }
  function itemRowHtml(text, opts) {
    opts = opts || {};
    var parts = splitLabel(text);
    var check = opts.check === true ? '<span class="pu-check">✓</span>' : (opts.checkBox ? '<span class="pu-check"></span>' : '');
    /* 评审 Important-5：title/desc/right 注入前一律 esc——interaction 的 items 是 server/模型侧
     * 可控原文（审批卡），无转义可注入伪造行/标记（CSP 挡脚本但不挡标记注入） */
    var right = opts.right ? '<span class="pi-right">' + esc(opts.right) + '</span>' : '';
    return '<span class="pu-caret">❯</span>' + check +
      '<span class="pi-name">' + esc(parts.title) + '</span>' +
      (parts.desc ? '<span class="pi-desc">' + esc(parts.desc) + '</span>' : (opts.desc ? '<span class="pi-desc">' + esc(opts.desc) + '</span>' : '')) +
      right;
  }

  /* 通用渲染：pu = { kind, title, en, rows:[{html,cls,sep}], sel, longOf, foot, switchRow, onPick, onClose, syncSwitch } */
  function renderPopup() {
    ensureDom();
    if (pu === null) { popup.hidden = true; return; }
    if (pu.syncSwitch) pu.syncSwitch(); /* sel 变更联动（chooseSide 横选候选随行） */
    var html = '<div class="pu-head"><span class="pu-title">' + pu.title + '</span>' +
      (pu.en ? '<span class="pu-en">' + pu.en + '</span>' : '<span class="pu-en"></span>') +
      '<span class="pu-close" data-close title="关闭（Esc）">✕</span></div>';
    html += '<div class="pu-body" id="pu-body">';
    if (pu.kind === 'view') {
      html += pu.bodyHtml;
    } else {
      pu.rows.forEach(function (r, i) {
        html += '<div class="pu-item' + (i === pu.sel ? ' sel' : '') + (r.cls ? ' ' + r.cls : '') + '"' + (r.sep ? '' : ' data-i="' + i + '"') + '>' + r.html + '</div>';
      });
    }
    html += '</div>';
    if (pu.kind !== 'view' && pu.longOf !== undefined) {
      var cur = pu.rows[pu.sel];
      var long = cur ? pu.longOf(cur, pu.sel) : '';
      html += '<div class="pu-long" id="pu-long">' + long + '</div>';
    }
    if (pu.switchRow !== undefined) {
      var sw = pu.switchRow;
      html += '<div class="pu-switch"><span class="sw-label">' + sw.label + '</span>';
      if (sw.values === undefined || sw.values.length === 0) html += '<span class="sw-none">——</span>';
      else {
        sw.values.forEach(function (v, i) {
          html += '<span class="sw-val' + (i === sw.idx ? ' cur' : '') + '" data-sw="' + i + '">' + esc(v) + '</span>';
        });
      }
      html += '</div>';
    }
    if (pu.actionsHtml) html += '<div class="pu-actions">' + pu.actionsHtml + '</div>';
    if (pu.foot) html += '<div class="pu-foot">' + pu.foot + '</div>';
    popup.innerHTML = html;
    popup.hidden = false;
    popup.classList.toggle('anchor-right', pu.mini === 'right' || pu.mini === true);
    popup.classList.toggle('anchor-left', pu.mini === 'left');
    popup.classList.toggle('mini-pop', !!pu.mini);
    /* 锚定弹窗：底边贴芯片上缘（不压按钮），水平与芯片对齐 */
    if (pu.anchor) {
      var wrapR = popup.parentElement.getBoundingClientRect();
      var ar = pu.anchor.getBoundingClientRect();
      popup.style.bottom = Math.round(wrapR.bottom - ar.top + 6) + 'px';
      if (pu.mini === 'left') {
        popup.style.left = Math.max(4, Math.round(ar.left - wrapR.left)) + 'px';
        popup.style.right = 'auto';
      } else {
        popup.style.right = Math.max(4, Math.round(wrapR.right - ar.right)) + 'px';
        popup.style.left = 'auto';
      }
    }
    /* 选中行滚入视野 */
    var selEl = popup.querySelector('.pu-item.sel');
    var body = popup.querySelector('#pu-body');
    if (selEl && body) {
      var st = selEl.offsetTop, sb = st + selEl.offsetHeight;
      if (st < body.scrollTop) body.scrollTop = st;
      else if (sb > body.scrollTop + body.clientHeight) body.scrollTop = sb - body.clientHeight;
    }
  }

  function openPick(opts) {
    pu = {
      kind: 'pick',
      mini: opts.mini,
      anchor: opts.anchor,
      title: opts.title,
      en: opts.en ?? '',
      rows: opts.items.map(function (it) { return typeof it === 'string' ? { html: itemRowHtml(it) } : it; }),
      sel: opts.sel ?? 0,
      foot: opts.foot ?? '点击选定 · Esc 取消',
      longOf: opts.longOf,
      switchRow: opts.switchRow,
      onPick: function (i) {
        var sw = pu.switchRow ? (pu.switchRow.values ?? [])[pu.switchRow.idx] : undefined;
        closePopup();
        focusInput();
        opts.onPick(i, sw);
      },
    };
    renderPopup();
  }

  function openView(opts) {
    pu = {
      kind: 'view',
      title: opts.title,
      en: opts.en ?? '',
      bodyHtml: opts.bodyHtml,
      actionsHtml: opts.actionsHtml,
      foot: opts.foot ?? '滚动查看 · Esc 关闭',
      onAction: opts.onAction,
    };
    renderPopup();
  }
  function viewLines(lines) {
    return '<div class="pu-text">' + lines.map(function (l) { return l === '' ? '&nbsp;' : esc(l); }).join('\n') + '</div>';
  }

  /** 键盘导航的下一可选行（纯函数——node 直测）：环回跳过 sep 分隔行；
   *  空 rows / 全分隔行 → -1（无可选行不动——防「纯分隔行浮层」死循环冻结整页，
   *  评审 Critical-1：@ 菜单零匹配·目录不存在、/tasks 空名册均走 sep 兜底行）。 */
  function nextRowIdx(rows, from, dir) {
    var n = (rows || []).length;
    if (n === 0) return -1;
    var i = from;
    var guard = 0;
    do {
      i = (i + dir + n) % n;
      if (++guard > n) return -1; /* 走满一圈仍全是 sep——无 outlet */
    } while (rows[i] && rows[i].sep);
    return i;
  }

  /* 键盘（↑↓/Enter/Esc）——app.js 的 input keydown 首先转交本口；返回 true = 已消费 */
  function handleInputKey(e) {
    ensureDom();
    if (pu && (pu.kind === 'menu' || pu.kind === 'pick' || pu.kind === 'at')) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var d = e.key === 'ArrowDown' ? 1 : -1;
        var ni = nextRowIdx(pu.rows, pu.sel, d);
        if (ni >= 0 && ni !== pu.sel) {
          pu.sel = ni;
          renderPopup();
        }
        return true;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (pu.onPick) pu.onPick(pu.sel);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closePopup();
        focusInput();
        return true;
      }
      return true; /* 菜单开着时其余键不落入输入框语义 */
    }
    if (pu && pu.kind === 'view' && e.key === 'Escape') {
      e.preventDefault();
      closePopup();
      focusInput();
      return true;
    }
    return false;
  }
  function isOpen() { ensureDom(); return !popup.hidden; }
  function isMenuOpen() { ensureDom(); return !popup.hidden && pu !== null && (pu.kind === 'menu' || pu.kind === 'at'); }
  /** 发送键在浮层开着时 = 确认当前选中行（与 Enter 同效——原型 form submit 分支）。
   *  返回 true = 已消费（菜选确认）；view 窗无 onPick → false（不拦截发送）。 */
  function pickCurrent() {
    if (pu && pu.onPick) { pu.onPick(pu.sel); return true; }
    return false;
  }

  /* ═══════════ 斜杠菜单（D13：命令区 + 技能区殿后 + 详释区 + 过滤 + 零命中关窗） ═══════════ */
  var cmdsCache = { at: 0, items: [] };
  var skillsCache = { at: 0, items: [] };
  var CACHE_MS = 30000;

  function fetchCommands() {
    if (Date.now() - cmdsCache.at < CACHE_MS && cmdsCache.items.length > 0) return Promise.resolve(cmdsCache.items);
    return A.fetchJson('/api/commands' + (H.getSid() ? '?sid=' + encodeURIComponent(H.getSid()) : '')).then(function (r) {
      cmdsCache = { at: Date.now(), items: r.items ?? [] };
      return cmdsCache.items;
    }, function () { return []; });
  }
  function fetchSkills() {
    if (Date.now() - skillsCache.at < CACHE_MS) return Promise.resolve(skillsCache.items);
    return A.fetchJson('/api/settings/skills').then(function (r) {
      skillsCache = { at: Date.now(), items: r.skills ?? [] };
      return skillsCache.items;
    }, function () { return []; });
  }
  function invalidateCaches() { cmdsCache.at = 0; skillsCache.at = 0; }

  function menuFilterQ(input) {
    return input.value.trim().replace(/^\//, '').toLowerCase();
  }
  function menuCmdRows(q, cmds) {
    return cmds.filter(function (c) {
      if (String(c.name).slice(1).indexOf(q) === 0) return true;
      return (c.aliases ?? []).some(function (a) { return String(a).indexOf(q) === 0; });
    });
  }
  function menuSkillRows(q, skills) {
    var avail = skills.filter(function (s) { return !s.disabled; });
    if (q === '') return avail;
    /* 三档：前缀命中 > 包含 > 模糊（子序列） */
    var hit = [], mid = [], fuzzy = [];
    avail.forEach(function (s) {
      var n = String(s.name).toLowerCase(), label = 'skill : ' + n;
      if (n.indexOf(q) === 0 || label.indexOf(q) === 0) hit.push(s);
      else if (n.includes(q) || label.includes(q)) mid.push(s);
      else {
        var i = 0;
        for (var k = 0; k < label.length; k++) if (label[k] === q[i]) i++;
        if (i === q.length) fuzzy.push(s);
      }
    });
    return hit.concat(mid, fuzzy);
  }
  function openMenu(input) {
    Promise.all([fetchCommands(), fetchSkills()]).then(function (res) {
      var cmds = res[0], skills = res[1];
      var q = menuFilterQ(input);
      var cmdRows = menuCmdRows(q, cmds);
      var skillRows = menuSkillRows(q, skills);
      if (cmdRows.length === 0 && skillRows.length === 0) { closePopup(); return; } /* 零命中关窗（拍板） */
      var rows = cmdRows.map(function (c) {
        var alias = c.aliases && c.aliases.length ? ' <span class="dim">（' + c.aliases.join(', ') + '）</span>' : '';
        return { html: '<span class="pu-caret">❯</span><span class="pi-name">' + esc(c.name) + alias + (c.module ? ' <span class="dim">· 模块</span>' : '') + '</span><span class="pi-desc">' + esc(c.desc ?? '') + '</span>', data: c };
      });
      if (skillRows.length > 0) {
        rows.push({ html: '<span class="dim">── 技能</span><span class="sep-line"></span>', cls: 'sep', sep: true });
        skillRows.forEach(function (s) {
          rows.push({ html: '<span class="pu-caret">❯</span><span class="pi-name">skill : ' + esc(s.name) + '</span><span class="pi-desc">' + esc(s.desc ?? '') + '</span>', cls: 'skill-row', data: s, skill: true });
        });
      }
      pu = {
        kind: 'menu',
        title: '斜杠命令',
        en: cmdRows.length + ' 个命令' + (skillRows.length ? ' · ' + skillRows.length + ' 个技能' : ''),
        rows: rows,
        sel: 0,
        longOf: function (row) {
          if (row.sep) return '<div class="ln"></div><div class="ln"></div><div class="ln dim">↑↓ 选择 · Enter 执行 · Esc 关闭</div>';
          if (row.skill) {
            return '<div class="ln dim">' + esc(row.data.desc ?? '') + '</div><div class="ln"></div>' +
              '<div class="ln dim">' + (row.data.usage ? '适用：' + esc(row.data.usage) : '') + '</div>';
          }
          return '<div class="ln dim">' + esc(row.data.long ?? row.data.desc ?? '') + '</div>' +
            '<div class="ln dim">↑↓ 选择 · Enter 执行 · Esc 关闭</div>';
        },
        onPick: function (i) {
          var row = pu.rows[i];
          if (!row || row.sep) return;
          input.value = '';
          closePopup();
          focusInput();
          H.onCommandSubmit(row.skill ? '/skill : ' + row.data.name : row.data.name);
        },
      };
      renderPopup();
    });
  }

  /* 输入框 input 事件派发：@ 菜单优先（词尾 @）；斜杠菜单其次（行首 / 词） */
  function inputChanged(input) {
    ensureDom();
    var v = input.value;
    if (/(?:^|\s)@[^\s]*$/.test(v)) { openAtMenu(input); return; }
    if (pu && pu.kind === 'at') closePopup();
    var lead = v.trimStart();
    if (lead.indexOf('/') === 0 && !/\s/.test(lead) && !v.includes('\n')) {
      openMenu(input);
    } else if (pu && pu.kind === 'menu') {
      closePopup();
    }
  }

  /* ═══════════ @ 文件菜单（D7：两级目录下钻 + 前缀过滤；数据 GET /api/at） ═══════════ */
  var atDir = '';
  function atMenuQuery(input) {
    var m = /(?:^|\s)@([^\s]*)$/.exec(input.value);
    return m ? m[1] : null;
  }
  function openAtMenu(input) {
    var q = atMenuQuery(input);
    if (q === null) { if (pu && pu.kind === 'at') closePopup(); return; }
    var slash = Math.max(q.lastIndexOf('/'), q.lastIndexOf('\\'));
    var dirPart = slash >= 0 ? q.slice(0, slash + 1).replace(/\/$/, '') : '';
    var stem = slash >= 0 ? q.slice(slash + 1) : q;
    var dir = dirPart !== '' ? dirPart : atDir;
    var cwd = H.getCwd();
    A.fetchJson('/api/at?cwd=' + encodeURIComponent(cwd) + '&dir=' + encodeURIComponent(dir) + '&q=' + encodeURIComponent(stem))
      .then(function (r) {
        if (atMenuQuery(input) === null) return; /* 输入已变——弃渲染 */
        var entries = r.entries ?? [];
        if (dirPart !== '') atDir = dirPart;
        var dirs = entries.filter(function (e2) { return e2.dir; }).length;
        var rows = entries.map(function (e2) {
          return {
            html: '<span class="pu-caret">❯</span><span class="pi-name"' + (e2.dir ? ' style="color:var(--accent)"' : '') + '>' + esc(e2.name) + (e2.dir ? '/' : '') + '</span>',
            data: e2,
          };
        });
        if (rows.length === 0) rows = [{ html: '<span class="dim">（' + (entries.length === 0 ? '目录不存在——检查路径' : '无匹配文件') + '）</span>', cls: 'sep', sep: true }];
        pu = {
          kind: 'at',
          title: dir === '' ? '@ 文件' : '@ ' + dir + '/',
          en: dirs + ' 个目录 · ' + (entries.length - dirs) + ' 个文件',
          rows: rows,
          sel: 0,
          foot: '点击插入路径 · 目录点击进下层 · Esc 返回',
          onPick: function (i) {
            var e2 = rows[i].data;
            if (!e2) return;
            if (e2.dir) {
              input.value = input.value.replace(/@[^\s]*$/, '@' + (dir === '' ? '' : dir + '/') + e2.name + '/');
              openAtMenu(input);
              input.focus();
            } else {
              input.value = input.value.replace(/@[^\s]*$/, '@' + (dir === '' ? '' : dir + '/') + e2.name + ' ');
              closePopup();
              input.focus();
            }
          },
        };
        renderPopup();
      }, function () { /* 拉取失败静默关窗 */ if (pu && pu.kind === 'at') closePopup(); });
  }

  /* ═══════════ 审批浮层 + interaction 全族（D14：interaction 帧 → POST /answer） ═══════════ */
  function mdHtml(text) {
    try {
      if (typeof globalThis.marked !== 'undefined' && typeof globalThis.DOMPurify !== 'undefined') {
        return globalThis.DOMPurify.sanitize(globalThis.marked.parse(String(text), { breaks: true, gfm: true }));
      }
    } catch { /* 兜底纯文本 */ }
    return '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
  }

  function openInteraction(frame, answer) {
    ensureDom();
    var kind = String(frame.kind ?? 'choose');
    if (kind === 'notice') {
      closePopup();
      H.toast(String(frame.text ?? ''), frame.durationMs);
      return;
    }
    if (kind === 'viewText') {
      pendingInteraction = null;
      pu = {
        kind: 'view',
        title: '查看',
        en: 'VIEW',
        bodyHtml: '<div class="pu-text md">' + (frame.markdown ? mdHtml(frame.text) : esc(frame.text)) + '</div>',
        foot: '滚动查看（单向消息，无需应答） · Esc 关闭',
      };
      renderPopup();
      return;
    }
    /* 可应答族：挂起登记 + 关窗连带 cancelled（应答路径先置 _answered） */
    pendingInteraction = { id: frame.id, answer: answer };
    var cancelOnClose = function () { answer({ id: frame.id, cancelled: true }); };
    if (kind === 'ask' || kind === 'askSecret') {
      openAsk(frame, answer, cancelOnClose);
      return;
    }
    if (kind === 'confirm') {
      pu = {
        kind: 'pick',
        title: esc(frame.title ?? '确认'),
        en: 'CONFIRM',
        rows: [
          { html: itemRowHtml('确认') },
          { html: itemRowHtml('取消') },
        ],
        sel: 0,
        foot: '点击选定 · Esc = 取消',
        onClose: cancelOnClose,
        onPick: function (i) {
          if (pu) pu.answered = true;
          closePopup();
          focusInput();
          answer({ id: frame.id, value: i === 0 ? 'true' : 'false' });
        },
      };
      renderPopup();
      return;
    }
    if (kind === 'chooseEx') {
      openChooseEx(frame, answer, cancelOnClose);
      return;
    }
    if (kind === 'chooseSide') {
      openChooseSide(frame, answer, cancelOnClose);
      return;
    }
    /* choose——含 approval 弹窗（title 多行 = 工具/规则/访问/原因四行，items 原样展示、点击回传原文） */
    var lines = String(frame.title ?? '').split('\n');
    var titleHtml = esc(lines[0] ?? '选择');
    var headExtra = '';
    for (var i = 1; i < lines.length; i++) {
      headExtra += '<div class="appr-line">' + esc(lines[i]) + '</div>';
    }
    var items = Array.isArray(frame.items) ? frame.items : [];
    pu = {
      kind: 'pick',
      title: titleHtml,
      en: lines.length > 1 ? 'APPROVAL' : 'CHOOSE',
      rows: items.map(function (it) { return { html: itemRowHtml(String(it)) }; }),
      sel: 0,
      foot: '点击选定 · Esc = 拒绝并关闭',
      onClose: cancelOnClose,
      onPick: function (idx) {
        if (pu) pu.answered = true;
        closePopup();
        focusInput();
        answer({ id: frame.id, value: items[idx] });
      },
    };
    renderPopup();
    if (headExtra !== '') {
      var body = popup.querySelector('#pu-body');
      if (body) {
        var head = document.createElement('div');
        head.className = 'appr-head';
        head.innerHTML = headExtra;
        body.insertBefore(head, body.firstChild);
      }
    }
  }

  function openAsk(frame, answer, cancelOnClose) {
    var secret = frame.kind === 'askSecret';
    pu = {
      kind: 'view',
      title: esc(frame.title ?? '输入'),
      en: secret ? 'SECRET' : 'ASK',
      bodyHtml:
        '<div class="ask-row"><input class="fi" id="pu-ask-input" type="' + (secret ? 'password' : 'text') + '" autocomplete="off" placeholder="' + (secret ? '输入（掩码）…' : '输入…') + '" />' +
        '<button type="button" class="btn primary" data-act="send">提交</button></div>',
      actionsHtml: '',
      foot: 'Enter 提交 · Esc 取消',
      onClose: cancelOnClose,
      onAction: function (act) {
        if (act !== 'send') return;
        var inp = popup.querySelector('#pu-ask-input');
        if (!inp) return;
        var v = inp.value;
        if (v === '') { inp.focus(); return; }
        if (pu) pu.answered = true;
        closePopup();
        focusInput();
        answer({ id: frame.id, value: v });
      },
    };
    renderPopup();
    var inp = popup.querySelector('#pu-ask-input');
    if (inp) {
      inp.focus();
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (pu && pu.onAction) pu.onAction('send');
        }
      });
    }
  }

  function openChooseEx(frame, answer, cancelOnClose) {
    var items = Array.isArray(frame.items) ? frame.items : [];
    var picked = new Set();
    var bodyHtml = (function () {
      var html = '<div class="pu-text"><span class="dim">可多选（点击行切换勾选）——Enter / 提交按钮发送所选</span></div><div class="cx-list">';
      items.forEach(function (it, i) {
        html += '<div class="pu-item cx-item' + (picked.has(i) ? ' sel' : '') + '" data-cx="' + i + '">' + itemRowHtml(String(it), { check: picked.has(i) }) + '</div>';
      });
      html += '</div>';
      return html;
    })();
    pu = {
      kind: 'view',
      title: esc(frame.title ?? '多选'),
      en: 'CHOOSE-EX',
      bodyHtml: bodyHtml,
      actionsHtml: '<span class="spacer"></span><button type="button" class="btn" data-act="cancel">取消</button><button type="button" class="btn primary" data-act="send">提交所选（0）</button>',
      foot: '点击行切换勾选 · Enter 提交 · Esc 取消',
      onClose: cancelOnClose,
      onAction: function (act) {
        if (act === 'cancel') {
          if (pu) pu.answered = true;
          closePopup();
          answer({ id: frame.id, cancelled: true });
          return;
        }
        if (act === 'send') {
          var vals = items.filter(function (_, i) { return picked.has(i); });
          if (pu) pu.answered = true;
          closePopup();
          focusInput();
          answer({ id: frame.id, value: vals });
        }
      },
    };
    renderPopup();
    var bodyEl = popup.querySelector('.pu-body');
    if (bodyEl) {
      bodyEl.addEventListener('click', function (e) {
        var row = e.target.closest('[data-cx]');
        if (!row) return;
        var i = parseInt(row.getAttribute('data-cx'), 10);
        if (picked.has(i)) picked.delete(i); else picked.add(i);
        row.classList.toggle('sel', picked.has(i));
        var chk = row.querySelector('.pu-check');
        if (chk) chk.textContent = picked.has(i) ? '✓' : '';
        var btn = popup.querySelector('[data-act="send"]');
        if (btn) btn.textContent = '提交所选（' + picked.size + '）';
      });
    }
  }

  function openChooseSide(frame, answer, cancelOnClose) {
    var items = Array.isArray(frame.items) ? frame.items : [];
    var valueMap = (frame.values && typeof frame.values === 'object' && !Array.isArray(frame.values)) ? frame.values : {};
    var sidesOf = function (item) { return Array.isArray(valueMap[item]) ? valueMap[item] : []; };
    pu = {
      kind: 'pick',
      title: esc(frame.title ?? '选择'),
      en: 'CHOOSE-SIDE',
      rows: items.map(function (it) { return { html: itemRowHtml(String(it)) }; }),
      sel: 0,
      switchRow: { label: frame.sideLabel ?? '档位', values: sidesOf(items[0]), idx: 0 },
      foot: '点击选定（横选档位随行提交）· Esc 取消',
      onClose: cancelOnClose,
      syncSwitch: function () {
        var it = items[pu.sel];
        var sides = sidesOf(it);
        if (pu.switchRow.idx >= sides.length) pu.switchRow.idx = 0;
        pu.switchRow.values = sides;
      },
      onPick: function (i, sw) {
        var item = items[i];
        var sides = sidesOf(item);
        var val = sides.length > 0 ? (sw !== undefined && sides.includes(sw) ? sw : sides[0]) : undefined;
        if (pu) pu.answered = true;
        closePopup();
        focusInput();
        answer({ id: frame.id, value: { item: item, value: val } });
      },
    };
    renderPopup();
  }

  /** 挂起 interaction 的取消口（app.js 双击 Esc / 停止键连带 POST /answer {cancelled}——T5/T7 指针）。 */
  function cancelPending() {
    if (pendingInteraction === null) return null;
    var p = pendingInteraction;
    pendingInteraction = null;
    if (pu) closePopup();
    return p;
  }
  function pendingId() { return pendingInteraction ? pendingInteraction.id : null; }

  /* ═══════════ 模型 / 档位 / 权限芯片菜单（D8/D9/D10） ═══════════ */
  var MODES = [
    { key: 'ask-always', label: '每次都询问', desc: '每次工具调用都确认', long: '最高安全档：每一次工具调用（包括只读文件）都要你确认后才执行。浏览陌生代码库、敏感目录或不信任的会话时用。' },
    { key: 'ask-risky', label: '需要时候询问', desc: '仅危险操作确认', long: '日常默认档：只读操作（读文件、列目录）直接放行，写文件、执行命令、网络请求等有副作用的操作才确认。' },
    { key: 'never', label: '从不询问', desc: '全自动，有问题模型自行判断', long: '全自动档：所有工具批准都自动处理（含危险命令）；只有你手写的 deny 规则仍会拦。完全信任当前会话、追求连续执行时用。' },
  ];

  function fetchModels() {
    var sid = H.getSid();
    return A.fetchJson('/api/models' + (sid ? '?sid=' + encodeURIComponent(sid) : ''));
  }
  /** 模型两级菜单（D9）：提供商 → 模型（✓ 勾标 + 「管理模型」入口 + 未配置提示）。 */
  function openModelMenu(anchor) {
    fetchModels().then(function (data) {
      var current = String(data.current ?? '');
      var curPlatform = current.indexOf('/') === 0 ? '' : current.split('/')[0];
      var rows = (data.providers ?? []).map(function (p) {
        return {
          html: '<span class="pu-caret">❯</span><span class="pu-check">' + (p.key === curPlatform ? '✓' : '') + '</span><span class="pi-name">' + esc(p.displayName) + '</span><span class="pi-desc">' + (p.models && p.models.length ? p.models.length + ' 个模型' : '未配置') + '</span><span class="pi-right">›</span>',
          data: p,
        };
      });
      rows.push({ html: '<span class="dim">──</span><span class="sep-line"></span>', cls: 'sep', sep: true });
      rows.push({ html: '<span class="pu-caret">❯</span><span class="pi-name">管理模型</span><span class="pi-desc">设置 → 提供商与模型</span>', data: 'manage' });
      openPick({
        mini: 'right',
        anchor: anchor,
        title: '模型',
        en: 'MODEL',
        items: rows,
        foot: '点提供商展开模型 · Esc 关闭',
        onPick: function (i) {
          var r = rows[i];
          if (!r || r.sep) return;
          if (r.data === 'manage') { H.toast('模型管理在 设置 → 提供商与模型（建设中）'); return; }
          var p = r.data;
          if (!p.models || p.models.length === 0) { H.toast(p.displayName + ' 未配置端点——设置 → 提供商与模型 添加'); return; }
          openProviderModels(anchor, p);
        },
      });
    }, function () { H.toast('拉取模型清单失败'); });
  }
  function openProviderModels(anchor, p) {
    var rows = [{ html: '<span class="pi-name" style="color:var(--info)">‹ 返回</span>', data: 'back' }].concat(
      p.models.map(function (m) {
        return { html: '<span class="pu-caret">❯</span><span class="pu-check">' + (m.cur ? '✓' : '') + '</span><span class="pi-name">' + esc(m.name) + '</span>', data: m };
      }),
    );
    openPick({
      mini: 'right',
      anchor: anchor,
      title: p.displayName,
      en: 'MODELS',
      items: rows,
      foot: '点击切换 · Esc 关闭',
      onPick: function (i) {
        if (i === 0) { openModelMenu(anchor); return; }
        var m = p.models[i - 1];
        A.fetchJson('/api/sessions/' + encodeURIComponent(H.getSid()) + '/model', { method: 'POST', body: JSON.stringify({ platform: p.key, model: m.name }) })
          .then(function () {
            H.toast('模型已切换 → ' + p.key + '/' + m.name + '（下一轮生效）');
            H.onStatusChanged();
          }, function (err) { H.toast('切换失败：' + err.message); });
      },
    });
  }
  /** 思考档位菜单（D10：仅正常思考档位列表——无 auto 项；菜单只列模型目录声明的档位）。 */
  function openEffortMenu(anchor) {
    fetchModels().then(function (data) {
      var current = String(data.current ?? '');
      var plat = (data.providers ?? []).find(function (p) { return current.indexOf(p.key + '/') === 0; });
      var modelName = current.indexOf('/') >= 0 ? current.slice(current.indexOf('/') + 1) : current;
      var entry = plat ? (plat.models ?? []).find(function (m) { return m.name === modelName; }) : null;
      var efforts = (entry && entry.efforts) || [];
      if (efforts.length === 0) {
        H.toast('模型 ' + (modelName || '（未配置）') + ' 无思考档位信息（目录未声明 effort 档）——可直敲 /effort <档位> 手动指定');
        return;
      }
      var curEffort = H.getEffort();
      openPick({
        mini: 'right',
        anchor: anchor,
        title: '思考投入',
        en: 'EFFORT',
        items: efforts.map(function (v) {
          return { html: '<span class="pu-caret">❯</span><span class="pu-check">' + (v === curEffort ? '✓' : '') + '</span><span class="pi-name">' + esc(v) + '</span>', data: v };
        }),
        foot: '点击选定（档位来自模型目录）',
        onPick: function (i) {
          var v = efforts[i];
          if (v === curEffort) return;
          A.fetchJson('/api/sessions/' + encodeURIComponent(H.getSid()) + '/effort', { method: 'POST', body: JSON.stringify({ level: v }) })
            .then(function () {
              H.toast('思考档位已设为 ' + v + '（已写入 config）');
              H.onStatusChanged();
            }, function (err) { H.toast('设置失败：' + err.message); });
        },
      });
    }, function () { H.toast('拉取模型清单失败'); });
  }
  /** 权限三档小弹窗（D8：芯片上方 mini 锚定 + never 警示黄）。 */
  function openPermMenu(anchor, current) {
    openPick({
      mini: 'left',
      anchor: anchor,
      title: '权限模式',
      en: 'PERMISSION',
      items: MODES.map(function (m) {
        return {
          html: '<span class="pu-caret">❯</span><span class="pu-check">' + (m.key === current ? '✓' : '') + '</span><span class="pi-name">' + m.label + '</span><span class="pi-desc">' + esc(m.desc) + '</span>',
          data: m,
        };
      }),
      sel: Math.max(0, MODES.findIndex(function (m) { return m.key === current; })),
      longOf: function (row) { return '<div class="ln dim">' + esc(row.data.long) + '</div>'; },
      foot: '点击选定，立即生效并写入配置 · Esc 关闭',
      onPick: function (i) {
        var m = MODES[i];
        A.fetchJson('/api/sessions/' + encodeURIComponent(H.getSid()) + '/permission', { method: 'POST', body: JSON.stringify({ mode: m.key }) })
          .then(function () {
            H.toast('权限模式 → ' + m.label + '（已写入配置）');
            H.onStatusChanged();
          }, function (err) { H.toast('设置失败：' + err.message); });
      },
    });
  }

  /* ═══════════ /tasks 浮层（T7 数据面：名册 + 等审批应答 + transcript 回放窗） ═══════════ */
  var TASK_STATUS = { queued: ['排队中', 'st-run'], running: ['运行中', 'st-run'], completed: ['已完成', 'st-ok'], failed: ['失败', 'st-err'] };

  function openTasksPanel() {
    var sid = H.getSid();
    A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/tasks').then(function (r) {
      var rows = (r.rows ?? []).map(function (tk) {
        var rel = tk.depth === 2 ? tk.parentId + ' - ' + tk.id : tk.id;
        var st = TASK_STATUS[tk.status] ?? [String(tk.status), 'st-run'];
        var tag = (tk.pendingApproval ? ' <span class="st-warn">· 等审批</span>' : '') + (tk.background ? ' <span class="dim">· 后台</span>' : '');
        return {
          html: '<span class="pu-caret">❯</span><span class="' + st[1] + '">[' + (tk.depth === 2 ? '孙代理' : '子代理') + '] ' + esc(rel) + '</span><span class="pi-desc">' + esc(tk.label ?? '') + ' · ' + st[0] + tag + '</span>',
          data: tk,
        };
      });
      if (rows.length === 0) {
        rows = [{ html: '<span class="dim">（暂无在册子代理——对模型说「派个子代理去 …」后这里会列出；后台跑完结论自动送回对话）</span>', cls: 'sep', sep: true }];
      }
      openPick({
        title: '子代理任务（选择查看 · 等审批的可应答）',
        en: (r.rows ?? []).length + ' 个任务',
        items: rows,
        onPick: function (i) {
          var row = rows[i];
          if (!row || row.sep || !row.data) return;
          var tk = row.data;
          if (tk.pendingApproval) {
            openPick({
              title: '子代理审批 ' + tk.id + ' · ' + (tk.label ?? '') + ' · ' + tk.pendingApproval.tool + '（' + tk.pendingApproval.reason + '）',
              items: ['批准一次', '拒绝'].map(function (s) { return { html: itemRowHtml(s) }; }),
              onPick: function (j) {
                A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/subagents/' + encodeURIComponent(tk.id) + '/approval', { method: 'POST', body: JSON.stringify({ allow: j === 0 }) })
                  .then(function () {
                    H.toast((j === 0 ? '已批准 ' : '已拒绝 ') + tk.id + ' 的 ' + (tk.label ?? ''));
                    openTasksPanel(); /* 行刷新 */
                  }, function (err) { H.toast('应答失败：' + err.message); });
              },
            });
            return;
          }
          /* transcript 回放窗（T7：末 500 事件——render.renderTranscript 同款渲染） */
          var st = TASK_STATUS[tk.status] ?? [String(tk.status), 'st-run'];
          openView({
            title: '子代理 ' + tk.id + ' · ' + (tk.label ?? ''),
            en: 'TRANSCRIPT',
            bodyHtml: '<div class="pu-text"><span class="' + st[1] + '">状态：' + st[0] + ' · ' + (tk.turns ?? 0) + ' 轮' + (tk.background ? ' · 后台' : '') + (tk.error ? ' · ' + esc(tk.error) : '') + '</span></div><div class="mini-stream" id="pu-transcript">加载中…</div>',
            foot: '滚动查看 · Esc 返回列表',
          });
          A.fetchJson('/api/sessions/' + encodeURIComponent(sid) + '/subagents/' + encodeURIComponent(tk.id) + '/events').then(function (er) {
            var box = document.getElementById('pu-transcript');
            if (box && globalThis.OrosusRender) {
              box.innerHTML = '';
              globalThis.OrosusRender.renderTranscript(box, er.events ?? []);
            }
          }, function () {
            var box = document.getElementById('pu-transcript');
            if (box) box.textContent = '（回放拉取失败）';
          });
        },
      });
    }, function () { H.toast('拉取子代理名册失败'); });
  }

  /* ═══════════ /btw 小窗（T6：answering 累积整段替换 / answer·error 终态；零落盘不可重放） ═══════════ */
  var btw = { q: '', open: false };

  function btwTitle(q) {
    var s = String(q ?? '');
    return '侧问 · ' + (s.length > 16 ? s.slice(0, 16) + '…' : s);
  }
  function btwOpen(q) {
    btw = { q: String(q ?? ''), open: true };
    openView({
      title: btwTitle(btw.q),
      en: 'SIDE',
      bodyHtml: '<div class="pu-text"><span class="dim">带着当前对话上下文快问——不进主对话流、不留痕</span></div><div class="pu-text" id="pu-btw-body">…</div>',
      foot: 'Esc 关闭（关窗不中断——答案落定后可无参 /btw 回看）',
    });
  }
  function btwSetQuestion(q) { btw.q = String(q ?? ''); }
  function btwFrame(frame) {
    if (!btw.open) {
      if (frame.phase === 'answering' || frame.phase === 'answer') btwOpen(btw.q || '');
      else return;
    }
    var body = document.getElementById('pu-btw-body');
    if (!body) return;
    if (frame.phase === 'answering') body.innerHTML = '<span class="dim">回答中</span><br><br>' + esc(frame.text ?? '');
    else if (frame.phase === 'answer') body.innerHTML = esc(frame.text ?? '');
    else if (frame.phase === 'error') body.innerHTML = '<span class="bad">侧问失败：' + esc(frame.text ?? '') + '</span>';
  }

  /* ═══════════ cwd 芯片菜单（D5：仅空会话；候选 = 项目池） ═══════════ */
  function openCwdMenu(anchor, projects, currentCwd) {
    var rows = projects.map(function (p) {
      return {
        html: '<span class="pu-caret">❯</span><span class="pu-check">' + (p.cwd === currentCwd ? '✓' : '') + '</span><span class="pi-name">' + esc(p.name) + '</span><span class="pi-desc">' + esc(p.cwd) + (p.hidden ? '（已移除——选择即找回）' : '') + '</span>',
        data: p,
      };
    });
    openPick({
      mini: 'right',
      anchor: anchor,
      title: '切换工作目录',
      en: 'CWD',
      items: rows,
      foot: '选择后在所选目录开会话（当前空会话保留）· Esc 关闭',
      onPick: function (i) {
        var p = rows[i] && rows[i].data;
        if (!p) return;
        H.onCwdPick(p.cwd, p.name);
      },
    });
  }

  /* ═══════════ 导出面（app.js 消费） ═══════════ */
  globalThis.OrosusUI = {
    init: function (host) {
      H = host; /* { toast, getSid, getCwd, getEffort, onStatusChanged, onCommandSubmit, onCwdPick } */
      ensureDom();
    },
    closePopup: closePopup,
    isOpen: isOpen,
    isMenuOpen: isMenuOpen,
    pickCurrent: pickCurrent,
    handleInputKey: handleInputKey,
    inputChanged: inputChanged,
    openSlashMenu: function (input) { openMenu(input); },
    openInteraction: openInteraction,
    cancelPending: cancelPending,
    pendingId: pendingId,
    openModelMenu: openModelMenu,
    openEffortMenu: openEffortMenu,
    openPermMenu: openPermMenu,
    openTasksPanel: openTasksPanel,
    openView: openView,
    viewLines: viewLines,
    btwOpen: btwOpen,
    btwSetQuestion: btwSetQuestion,
    btwFrame: btwFrame,
    openCwdMenu: openCwdMenu,
    invalidateCaches: invalidateCaches,
    nextRowIdx: nextRowIdx,
    MODES: MODES,
  };
})();
