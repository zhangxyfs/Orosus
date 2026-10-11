/* Orosus web 已归档视图纯函数（web 批 T17——F10「已归档的会话」页的排序/筛选/分组核）。
 * 原型 :3045-3108 直裁的纯逻辑抽出：搜索（标题子串、不区分大小写）/ 工作区筛选（cwd 精确等值）/
 * 三排序（归档时间倒序〔缺省——GET /api/archived 即此序〕/ 创建时间倒序 / 标题字母 zh-CN）/
 * 按工作区分组（cwd 首次出现序聚合，组名 = basename）。
 * 三算子正交：archivedView(items, {q, ws, sort}) = 分组(排序(筛选(items)))——node 直测零 DOM。
 * 数据源：GET /api/archived → {items:[{sid,title,cwd,archivedAt,createdAt}]}（epoch ms）。
 * 导出面挂 globalThis.OrosusArchived（app.js 消费——经典脚本零构建）。 */
(function () {
  'use strict';

  var SEP_RE = /[\\/]/;

  /** 筛选：q = 标题子串（不区分大小写；空串 = 不过滤）；ws = 工作区 cwd 精确等值（空串 = 全部）。
   *  纯函数——返回新数组，入参零改动。 */
  function filterArchived(items, q, ws) {
    var list = items || [];
    var qs = String(q ?? '').trim().toLowerCase();
    var w = String(ws ?? '');
    return list.filter(function (a) {
      if (w !== '' && a.cwd !== w) return false;
      if (qs !== '' && String(a.title ?? '').toLowerCase().indexOf(qs) < 0) return false;
      return true;
    });
  }

  /** 三排序（返回新数组，入参零改动）：'archived'（归档时间倒序——缺省与未知键同）、'created'（创建
   *  时间倒序）、'alpha'（标题 localeCompare zh-CN，空标题殿后）。 */
  function sortArchived(items, sort) {
    if (sort === 'created') {
      return (items || []).toSorted(function (a, b) { return (b.createdAt ?? 0) - (a.createdAt ?? 0); });
    }
    if (sort === 'alpha') {
      return (items || []).toSorted(function (a, b) {
        var ta = String(a.title ?? '');
        var tb = String(b.title ?? '');
        if (ta === '' && tb !== '') return 1; /* 空标题（未命名）殿后 */
        if (tb === '' && ta !== '') return -1;
        return ta.localeCompare(tb, 'zh-CN');
      });
    }
    return (items || []).toSorted(function (a, b) { return (b.archivedAt ?? 0) - (a.archivedAt ?? 0); });
  }

  /** 按工作区分组：组序 = 传入序（排序后）的首次出现序；组名 = cwd 尾段（basename，正反斜杠皆分）。 */
  function groupArchived(items) {
    var groups = [];
    var idx = {}; /* cwd → groups 下标 */
    (items || []).forEach(function (a) {
      var key = String(a.cwd ?? '');
      if (!(key in idx)) {
        idx[key] = groups.length;
        var segs = key.replace(/[\\/]+$/, '').split(SEP_RE);
        groups.push({ key: key, name: segs.length > 0 ? segs[segs.length - 1] : key, items: [] });
      }
      groups[idx[key]].items.push(a);
    });
    return groups;
  }

  /** 组合口（app.js F10 页消费）：先筛选、再排序、后分组——三算子正交的唯一装配序。 */
  function archivedView(items, state) {
    state = state || {};
    return groupArchived(sortArchived(filterArchived(items, state.q ?? '', state.ws ?? ''), state.sort ?? 'archived'));
  }

  globalThis.OrosusArchived = {
    filterArchived: filterArchived,
    sortArchived: sortArchived,
    groupArchived: groupArchived,
    archivedView: archivedView,
  };
})();
