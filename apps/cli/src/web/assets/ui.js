/* Orosus web 浮层/菜单/审批（web 批 T16）——ui.js：dock 浮层三 kind（menu/pick/view）+
 * mini 锚定 + 键盘（↑↓/Enter/Esc）+ 详释区（原型 :1449-1582 直裁）；
 * 斜杠菜单（命令 + 技能殿后 + 前缀/模糊过滤 + 零命中关窗）、@ 文件菜单（两级下钻）、
 * 审批浮层（interaction 帧 → POST /answer；ask/askSecret/confirm/chooseEx/chooseSide 同族）、
 * 模型/档位/权限芯片菜单、cwd 芯片菜单（/tasks 浮层 W3 下线、/btw 小窗 W6 下线——选项卡形态接管）。
 * 依赖：window.OrosusAPI（fetchJson/esc）；宿主回调经 init 注入（app.js）。 */
(function () {
  'use strict';

  var A = globalThis.OrosusAPI;
  var H = null; /* 宿主回调（app.js init 注入） */

  /* ═══════════ dock 浮层框架（三 kind：menu 斜杠菜单 / pick 选择列表 / view 只读窗） ═══════════ */
  var popup = null, pu = null;
  var extraPopClass = null; /* 本窗附加类（perm-pop 等——开窗换上/关窗摘除，openPick opts.popClass） */
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
      /* 自定义体弹窗（两栏模型菜单等）：data-mmi 行点击委派给 onCustomClick */
      if (pu && pu.kind === 'modelmenu' && pu.onCustomClick) {
        var mi = e.target.closest('[data-mmi]');
        if (mi) { pu.onCustomClick(mi.getAttribute('data-mmi')); return; }
      }
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
      if (e.target.closest('#mode-chip, #model-chip, #effort-chip, #cwd-chip, #btn-file, #kv-model, #send-btn, #btw-model, #btw-effort, #btw-file')) return; /* 走查修⑪⑫：侧问两芯片+两「＋文件」同列豁免——toggle 关窗语义由各自点击处理器显式承担（开着菜单点芯片不再先关后开闪一遍/重复插 @） */
      closePopup();
    }, true);
  }

  function esc(s) { return A.esc(String(s ?? '')); }
  /* 走查修⑫（2026-10-14 用户口令②）：焦点归还位——浮层在哪条 composer 开就还哪条
   *  （侧问面开菜单 Esc/选定后不再抢主输入框）。null = 主输入框（审批/查看等主场面）。 */
  var focusBack = null;
  var viewModalOpener = null; /* web-dialog 批 T8：viewText 大窗壳（app.js 注入——modalStack 宿主，空白登记 #8；不注 = 退回 dock 路径） */
  function focusInput() { var i = focusBack || document.getElementById('prompt-input'); if (i) i.focus(); }
  function anchorInputOf(a) { var f = a && a.closest ? a.closest('form') : null; return f ? f.querySelector('textarea') : null; }

  function closePopup() {
    ensureDom();
    popup.hidden = true;
    popup.innerHTML = '';
    popup.classList.remove('anchor-right', 'anchor-left', 'mini-pop');
    if (extraPopClass !== null) { popup.classList.remove(extraPopClass); extraPopClass = null; }
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
    } else if (pu.customBody !== undefined) {
      html += pu.customBody(); /* 自定义体（两栏模型菜单等——自带行标记 data-mmi 走 onCustomClick） */
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
      html += '<div class="pu-switch"><span class="sw-label">' + esc(sw.label) + '</span>'; /* sideLabel 服务端原文——esc 补位（T16 复核 Minor③） */
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
    popup.classList.toggle('mm2-pop', pu.kind === 'modelmenu');
    if (extraPopClass !== null) { popup.classList.remove(extraPopClass); extraPopClass = null; }
    if (pu.popClass) { popup.classList.add(pu.popClass); extraPopClass = pu.popClass; }
    /* 锚定弹窗：底边贴芯片上缘（不压按钮），水平与芯片对齐。
     *  走查修⑪（2026-10-14 用户报障「侧问芯片弹窗脱锚」）：坐标系 = 偏移父（.inputwrap）相对值，
     *  锚点可在主 composer 之外（侧问栏芯片在右分栏）——旧 Math.max(4,…) 下钳把栏外锚点算出的负值
     *  钳成 4px，弹窗飞回主输入框右缘。改为允许负值（弹窗探出输入框伸进分栏，祖先无 overflow 裁切），
     *  只做视口级钳位（左右各留 4px 边距）；量宽前先双 auto——沿用的内联 left/right 会把
     *  offsetWidth 拉成拉伸宽（left+right 同设的绝对定位宽度受制），类定宽才量得准。
     *  走查修⑫：anchorWide（@ 菜单贴侧问 composer）= 左右缘同时对齐锚元素（dock 同宽口径的锚定版）；
     *  锚元素被重渲摘除（isConnected=false——侧问 composer 帧驱动重建）即关窗，不沿死锚乱飞。 */
    if (pu.anchor) {
      if (!pu.anchor.isConnected) { closePopup(); return; }
      var wrapR = popup.parentElement.getBoundingClientRect();
      var ar = pu.anchor.getBoundingClientRect();
      popup.style.bottom = Math.round(wrapR.bottom - ar.top + 6) + 'px';
      popup.style.left = 'auto';
      popup.style.right = 'auto';
      if (pu.anchorWide) {
        popup.style.left = Math.round(ar.left - wrapR.left) + 'px';
        popup.style.right = Math.round(wrapR.right - ar.right) + 'px';
      } else {
        var pw = popup.offsetWidth;
        if (pu.mini === 'left') {
          var l = Math.round(ar.left - wrapR.left);
          l = Math.max(Math.round(4 - wrapR.left), Math.min(l, Math.round(window.innerWidth - pw - 4 - wrapR.left)));
          popup.style.left = l + 'px';
        } else {
          var r = Math.round(wrapR.right - ar.right);
          r = Math.max(Math.round(wrapR.right - window.innerWidth + 4), Math.min(r, Math.round(wrapR.right - pw - 4)));
          popup.style.right = r + 'px';
        }
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
    focusBack = anchorInputOf(opts.anchor); /* 走查修⑫：焦点归还位 = 芯片所属 composer 的输入框（无锚 = 主输入框） */
    pu = {
      kind: 'pick',
      mini: opts.mini,
      anchor: opts.anchor,
      popClass: opts.popClass,
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
    focusBack = null; /* 只读窗归主输入框 */
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
    if (pu && pu.kind === 'modelmenu') {
      /* 两栏模型菜单：方向/Enter/Tab 全委派 onKey；Esc 本地收 */
      if (e.key === 'Escape') {
        e.preventDefault();
        closePopup();
        focusInput();
        return true;
      }
      if (pu.onKey && pu.onKey(e)) return true;
      if (e.key === 'Tab') e.preventDefault(); /* 不漂移焦点 */
      return true;
    }
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
      /* Tab 补全（2026-10-12 走查——此前 Tab 走浏览器默认焦点漂移，「写几个字母后 tab 无效」）：
       *  斜杠菜单 = 选中行补进输入框（命令名+空格进参数区 / 技能补整形）后收菜单；
       *  @ 菜单 = 同 Enter（目录下钻/文件插入）；pick 窗 = 不换焦点即可。 */
      if (e.key === 'Tab') {
        e.preventDefault();
        var row = pu.rows[pu.sel];
        if (row && !row.sep && row.data !== undefined && row.data !== null) {
          if (pu.kind === 'menu') {
            var inp = document.getElementById('prompt-input');
            if (inp) {
              inp.value = row.skill ? '/skill : ' + row.data.name : String(row.data.name) + ' ';
              closePopup();
              inp.focus();
              return true;
            }
          } else if (pu.kind === 'at') {
            if (pu.onPick) pu.onPick(pu.sel);
            return true;
          }
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
    focusBack = input; /* 斜杠菜单由输入框敲出——归还本框 */
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

  /* 输入框 input 事件派发：@ 菜单优先（词尾 @）；斜杠菜单其次（行首 / 词）。
   *  走查修⑫：opts.anchor = @ 菜单锚定元素（宽随锚——侧问 composer 贴栏形态）；opts.atOnly =
   *  只开 @ 面（侧问输入框无斜杠命令语义，行首 / 不进场）。 */
  function inputChanged(input, opts) {
    ensureDom();
    var v = input.value;
    if (/(?:^|\s)@[^\s]*$/.test(v)) { openAtMenu(input, opts && opts.anchor); return; }
    if (pu && pu.kind === 'at') closePopup();
    if (opts && opts.atOnly) return;
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
  function openAtMenu(input, anchor) {
    focusBack = input; /* @ 菜单由输入框敲出——归还本框（侧问框同口径） */
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
            html: '<span class="pu-caret">❯</span><span class="pi-name' + (e2.dir ? ' dir' : '') + '">' + esc(e2.name) + (e2.dir ? '/' : '') + '</span>',
            data: e2,
          };
        });
        if (rows.length === 0) rows = [{ html: '<span class="dim">（' + (entries.length === 0 ? '目录不存在——检查路径' : '无匹配文件') + '）</span>', cls: 'sep', sep: true }];
        pu = {
          kind: 'at',
          anchor: anchor, /* 走查修⑫：锚定 + 宽随锚（侧问 composer）——缺省 dock 主输入框（旧形态） */
          anchorWide: !!anchor,
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
        /* 链接加固钩子由 render.js 装载期统一注册（全局 DOMPurify 单例）——此处 sanitize 的产物里
         * 外链已补 target=_blank、相对引用（笔记 .md 等）已剥 href 标 md-ref（走查修 2026-10-15）。 */
        return globalThis.DOMPurify.sanitize(globalThis.marked.parse(String(text), { breaks: true, gfm: true }));
      }
    } catch { /* 兜底纯文本 */ }
    return '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
  }

  function openInteraction(frame, answer) {
    ensureDom();
    focusBack = null; /* 审批/问询属主输入框场——归还主框（不沿上次侧问菜单的归还位） */
    var kind = String(frame.kind ?? 'choose');
    if (kind === 'notice') {
      closePopup();
      H.toast(String(frame.text ?? ''), frame.durationMs);
      return;
    }
    if (kind === 'dialog') { /* web-dialog 批 T8：控件窗帧转发 dialog renderer（独立 #dlg-overlay——与 dock/设置页互不复用） */
      pendingInteraction = null;
      if (globalThis.OrosusDialog) globalThis.OrosusDialog.onFrame(frame);
      return;
    }
    if (kind === 'viewText') {
      pendingInteraction = null;
      var lay = frame.layout; /* web-dialog 批 T4/T8：布局与真实标题进帧（设计 §9——不再硬编码「查看」） */
      if ((lay === 'full' || lay === 'center80') && viewModalOpener) {
        /* 大窗壳：单向消息窗——宿主走 app.js openModal modalStack（空白登记 #8），关闭纯本地不发 dialog-event */
        viewModalOpener({ title: frame.title || '查看', bodyHtml: '<div class="pu-text md">' + (frame.markdown ? mdHtml(frame.text) : esc(frame.text)) + '</div>' });
        return;
      }
      pu = {
        kind: 'view',
        title: frame.title || '查看',
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
  /* 走查修⑫（2026-10-14 用户口令③）：权限弹窗底部详释长文区（pu-long/longOf）退役——行改两行式
   *  （图标 + 档位名 + 一行短描述，✓ 右置，仿图3 行式）；MODES.long 随详释区一并摘除。 */
  var PERM_ICONS = {
    'ask-always': '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M9.4 9.3a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1 .8-1 1.6v.4"/><path d="M12 16.9v.3"/></svg>',
    'ask-risky': '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 2.8v5.1c0 4.3-2.9 7.3-7 9.1-4.1-1.8-7-4.8-7-9.1V5.8z"/><path d="M9.3 12.1l1.9 1.9 3.5-4.2"/></svg>',
    'never': '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2.5 4.5 14H11l-1 7.5L18.5 10H12z"/></svg>',
  };
  var MODES = [
    { key: 'ask-always', label: '每次都询问', desc: '每次工具调用都确认' },
    { key: 'ask-risky', label: '需要时候询问', desc: '仅危险操作确认' },
    { key: 'never', label: '从不询问', desc: '全自动，有问题模型自行判断' },
  ];

  function fetchModels() {
    var sid = H.getSid();
    return A.fetchJson('/api/models' + (sid ? '?sid=' + encodeURIComponent(sid) : ''));
  }
  /** 模型两级菜单（D9）：提供商 → 模型（✓ 勾标 + 「管理模型」入口 + 未配置提示）。 */
  /* 模型两级菜单（2026-10-12 走查改版：两栏同弹——左提供商 + 右该商模型表，替代原两次串行弹窗；
   *  ←→ 切提供商、↑↓ 选模型、Enter/点击切换、Esc 关闭；管理模型行进设置提供商页）。
   *  走查修⑪（2026-10-14 用户口令「侧问模型弹窗与主代理一致」）：opts 钩子面——侧问卡复用同弹，
   *  覆盖语义经 opts 注入，UI 形态一份：
   *  · opts.current = 勾标目标限定形（'' = 无勾——跟随态）；缺省 = 会话当前（data.current + m.cur 口径）
   *  · opts.focus   = 初始落栏限定形（缺省 = current 非空则之，否则 data.current）
   *  · opts.follow  = { label, checked }——右栏首行「跟随…」清覆盖行（点选 = onSwitch(null, null)）
   *  · opts.onSwitch = (platformKey|null, modelName|null)——自定义切换面（缺省 = POST 会话模型） */
  function openModelMenu(anchor, opts) {
    opts = opts || {};
    focusBack = anchorInputOf(anchor); /* 走查修⑫：归还位 = 芯片所属 composer（侧问芯片 → 侧问框） */
    fetchModels().then(function (data) {
      if (!data) { H.toast('拉取模型清单失败'); return; }
      var providers = data.providers ?? [];
      var ownCur = opts.current !== undefined; /* 自带勾标目标（侧问覆盖语义）——缺省走会话当前 */
      var current = String(ownCur ? opts.current : (data.current ?? ''));
      var focus = String(opts.focus !== undefined ? opts.focus : (current !== '' ? current : (data.current ?? '')));
      /* 落栏平台解析：focus 形不定（"平台/模型"限定形 | 裸平台键 | 空）——先按首段取，
       *  落空再用模型级 cur 勾标反查（裸模型名/空串两形兜底） */
      var focPlatform = focus.split('/')[0];
      if (!providers.some(function (p) { return p.key === focPlatform; })) {
        var byCur = providers.find(function (p) { return (p.models ?? []).some(function (m) { return m.cur; }); });
        focPlatform = byCur ? byCur.key : '';
      }
      var mm = { pIdx: 0, mIdx: 0 };
      var ci = providers.findIndex(function (p) { return p.key === focPlatform; });
      if (ci >= 0) mm.pIdx = ci;
      var followOff = opts.follow ? 1 : 0; /* 右栏首行「跟随…」占位——mIdx 行号 = 模型序 + followOff */
      var modelsOf = function () { return (providers[mm.pIdx] && providers[mm.pIdx].models) ?? []; };
      /* 勾标两口径：主 = 会话当前（server m.cur 旗标 / 落栏平台出勾）；侧问 = 覆盖目标限定形整串比对 */
      var isCurM = function (p, m) {
        if (ownCur) return current !== '' && p.key + '/' + m.name === current;
        return !!m.cur;
      };
      var isCurP = function (p) {
        if (ownCur) return current !== '' && p.key === current.split('/')[0];
        return p.key === focPlatform;
      };
      var syncCur = function () {
        var ms = modelsOf();
        var ci2 = ms.findIndex(function (m) { return isCurM(providers[mm.pIdx], m); });
        mm.mIdx = ci2 >= 0 ? ci2 + followOff : 0;
      };
      syncCur();
      var doSwitch = function (p, m) { /* (null, null) = 「跟随」行点选（仅自定义面有此语义） */
        if (opts.onSwitch) {
          closePopup();
          focusInput();
          opts.onSwitch(p && m ? p.key : null, p && m ? m.name : null);
          return;
        }
        if (!p || !m) return;
        A.fetchJson('/api/sessions/' + encodeURIComponent(H.getSid()) + '/model', { method: 'POST', body: JSON.stringify({ platform: p.key, model: m.name }) })
          .then(function () {
            closePopup();
            focusInput();
            H.toast('模型已切换 → ' + p.key + '/' + m.name + '（下一轮生效）');
            H.onStatusChanged();
          }, function (err) { H.toast('切换失败：' + err.message); });
      };
      var pickRow = function (i) {
        if (opts.follow && i === 0) { doSwitch(null, null); return; }
        var m = modelsOf()[opts.follow ? i - 1 : i];
        if (m) doSwitch(providers[mm.pIdx], m);
      };
      pu = {
        kind: 'modelmenu',
        mini: 'right',
        anchor: anchor,
        title: '模型',
        en: 'MODEL',
        rows: [],
        foot: '←→ 提供商 · ↑↓ 模型 · Enter 切换 · Esc 关闭',
        customBody: function () {
          var left = providers.map(function (p, i) {
            return '<div class="mm2-p' + (i === mm.pIdx ? ' sel' : '') + '" data-mmi="p:' + i + '">' +
              '<span class="mm2-check">' + (isCurP(p) ? '✓' : '') + '</span>' +
              '<span class="mm2-pname">' + esc(p.displayName) + '</span>' +
              '<span class="mm2-go">›</span></div>';
          }).join('');
          left += '<div class="mm2-p mm2-manage" data-mmi="manage"><span class="mm2-check"></span><span class="mm2-pname">管理模型</span><span class="mm2-go">›</span></div>';
          var ms = modelsOf();
          var right = '';
          if (opts.follow) {
            right += '<div class="mm2-m mm2-follow' + (mm.mIdx === 0 ? ' sel' : '') + '" data-mmi="follow">' +
              '<span class="mm2-mname">' + esc(opts.follow.label) + '</span>' +
              '<span class="mm2-check">' + (opts.follow.checked ? '✓' : '') + '</span></div>';
          }
          right += ms.length === 0
            ? '<div class="mm2-empty">（该提供商未配置端点——设置 → 提供商与模型 添加）</div>'
            : ms.map(function (m, i) {
              return '<div class="mm2-m' + (i + followOff === mm.mIdx ? ' sel' : '') + '" data-mmi="m:' + i + '">' +
                '<span class="mm2-mname">' + esc(m.name) + '</span>' +
                '<span class="mm2-check">' + (isCurM(providers[mm.pIdx], m) ? '✓' : '') + '</span></div>';
            }).join('');
          return '<div class="mm2"><div class="mm2-left">' + left + '</div><div class="mm2-right">' + right + '</div></div>';
        },
        onCustomClick: function (mmi) {
          if (mmi === 'manage') {
            if (H && typeof H.onManageModels === 'function') H.onManageModels();
            else H.toast('模型管理在 设置 → 提供商与模型');
            return;
          }
          if (mmi === 'follow') { pickRow(0); return; }
          var m2 = /^([pm]):(\d+)$/.exec(mmi ?? '');
          if (!m2) return;
          var idx = parseInt(m2[2], 10);
          if (m2[1] === 'p') {
            mm.pIdx = idx;
            syncCur();
            renderPopup();
          } else {
            doSwitch(providers[mm.pIdx], modelsOf()[idx]);
          }
        },
        onKey: function (e) {
          var total = modelsOf().length + followOff;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            var dp = e.key === 'ArrowRight' ? 1 : -1;
            mm.pIdx = Math.min(Math.max(0, mm.pIdx + dp), providers.length - 1);
            syncCur();
            renderPopup();
            return true;
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (total === 0) return true;
            var dm = e.key === 'ArrowDown' ? 1 : -1;
            mm.mIdx = (mm.mIdx + dm + total) % total;
            renderPopup();
            return true;
          }
          if (e.key === 'Enter') {
            pickRow(mm.mIdx);
            return true;
          }
          return false;
        },
      };
      renderPopup();
    }, function () { H.toast('拉取模型清单失败'); });
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
  /** 权限三档小弹窗（D8：芯片上方 mini 锚定。走查修⑫：两行式行——图标 + 档位名 + 短描述，
   *  ✓ 右置；底部详释区退役，never 档警示黄随旧行式一并简化）。 */
  function openPermMenu(anchor, current) {
    openPick({
      mini: 'left',
      anchor: anchor,
      popClass: 'perm-pop',
      title: '权限模式',
      en: 'PERMISSION',
      items: MODES.map(function (m) {
        return {
          html: '<span class="pm-ic">' + (PERM_ICONS[m.key] || '') + '</span>' +
            '<span class="pm-tx"><span class="pm-name">' + m.label + '</span>' +
            '<span class="pm-desc">' + esc(m.desc) + '</span></span>' +
            '<span class="pu-check">' + (m.key === current ? '✓' : '') + '</span>',
          data: m,
          cls: 'perm-row',
        };
      }),
      sel: Math.max(0, MODES.findIndex(function (m) { return m.key === current; })),
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

  /* ═══════════ /tasks 旧浮出面已下线（问题 2 W3——v2 分栏形态接管：app.js cmdTasks 批量开
   *  agent tab + tab 内审批条 + .ag-stream 回放；本块原 /tasks 列表面 + transcript 回放窗 + 组卡
   *  行直进三函数与名册行渲染面整体拆除，导出面同步摘除——残留引用全仓清零） ═══════════ */

  /* ═══════════ /btw 小窗已下线（问题 2 W6——选项卡形态接管：app.js btwFeed 按 tab 分帧 +
   *  pane.js onBodyRender('btw') 裁剪版 composer；本块原弹窗三函数（开窗/存标题/收帧）+ btw 槽
   *  变量 + 标题推导一并拆除，导出面同步摘除——残留引用全仓清零） ═══════════ */

  /* ═══════════ cwd 芯片菜单（D5：仅空会话；候选 = 项目池 + 「浏览文件夹…」直达任意目录〔走查八轮〕） ═══════════ */
  function openCwdMenu(anchor, projects, currentCwd) {
    var rows = [{
      html: '<span class="pu-caret">❯</span><span class="pu-check"></span><span class="pi-name">📂 浏览文件夹…</span><span class="pi-desc">任意目录——下钻 / 上级回退 / 路径直达</span>',
      browse: true,
    }].concat(projects.map(function (p) {
      return {
        html: '<span class="pu-caret">❯</span><span class="pu-check">' + (p.cwd === currentCwd ? '✓' : '') + '</span><span class="pi-name">' + esc(p.name) + '</span><span class="pi-desc">' + esc(p.cwd) + (p.hidden ? '（已移除——选择即找回）' : '') + '</span>',
        data: p,
      };
    }));
    openPick({
      mini: 'right',
      anchor: anchor,
      title: '切换工作目录',
      en: 'CWD',
      items: rows,
      foot: '选择后在所选目录开会话（当前空会话保留）· Esc 关闭',
      onPick: function (i) {
        var row = rows[i];
        if (!row) return;
        if (row.browse) { H.onBrowseFolder(); return; }
        var p = row.data;
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
    setViewModal: function (fn) { viewModalOpener = fn; }, /* web-dialog 批 T8：大窗壳注入口（app.js 装配后注——不反向 import） */
    isOpen: isOpen,
    isMenuOpen: isMenuOpen,
    isAnchorOpen: function (el) { ensureDom(); return !popup.hidden && pu !== null && pu.anchor === el; }, /* 走查修⑫：芯片 toggle——本芯片的菜单开着 → 再点 = 关 */
    openKind: function () { ensureDom(); return popup.hidden || pu === null ? null : pu.kind; }, /* 同——「＋文件」判 @ 菜单在场用 */
    pickCurrent: pickCurrent,
    handleInputKey: handleInputKey,
    inputChanged: inputChanged,
    openSlashMenu: function (input) { openMenu(input); },
    openInteraction: openInteraction,
    cancelPending: cancelPending,
    pendingId: pendingId,
    openModelMenu: openModelMenu,
    openEffortMenu: openEffortMenu,
    openPick: openPick, /* 走查修⑨：btw 芯片 tab 级覆盖菜单复用 */
    fetchModels: fetchModels, /* 同——模型目录数据源 */
    openPermMenu: openPermMenu,
    openView: openView,
    viewLines: viewLines,
    mdHtml: mdHtml, /* marked+DOMPurify 渲染口（T17 更新弹窗/注入全文/压缩摘要消费） */
    openCwdMenu: openCwdMenu,
    invalidateCaches: invalidateCaches,
    nextRowIdx: nextRowIdx,
    MODES: MODES,
  };
})();
