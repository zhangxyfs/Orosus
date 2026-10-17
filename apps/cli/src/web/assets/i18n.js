/* web-i18n M3：@orosus/i18n runtime 的 JS 移植（全语义——插值/可选组/复数/管道缺省/二选一/解析链）。
 *  服务端单一权威下发 web.* 切片（M2 端点）；缺键 → fallback → 键本身。纯函数零依赖，node 直载可测。 */
(function () {
  "use strict";
  /* 移植自 packages/i18n/src/runtime.ts——逐函数照搬（去类型注解、export→IIFE 局部 var/function；语义逐行保真，不改写逻辑）。
   * 模板语法（全部形态来自五语译文对照表实测）：
   * - `{name}`           形参插值（缺参渲染空串；带空格短尾的 `{reason 首行}` 取首 token 查参）
   * - `{name|默认}`       形参带缺省（表内以全角 ｜ 书写，解析前归一为半角）
   * - `{flag?…}`         显式条件段（flag 真值才渲染——表内无内参可选组的实施期改写形态）
   * - `{（… {m} …）}`     可选组：内含形参全部在场才渲染
   * - `{A/B}`            在场二选一：从右找「带参且全在场」段，退回首个无参段（如 轮数上限 {不限…/{raw} 轮}）
   * - `{1:…|2:…|5:…}`    复数三形（ru）；`{one:… / other:…}`（en）——按首个数值形参选形
   * 解析链：active → en-US；zh-TW 特例经 zh-CN（繁体缺键蹦简体好过蹦英文）。缺键 → fallback 参数 → key 本身。 */

  /** 表格转义惯例：单元格里模板管道用全角 ｜ 书写（避免与 Markdown 表列冲突），解析前归一。（源写作 \uFF5C 转义——字面量恒纯 ASCII，CJK 棘轮面零非 ASCII 字面量） */
  var FULLWIDTH_PIPE = "\uFF5C";

  /** 形参名：字母开头，允许 ：. - 与 hh:mm:ss 类冒号；可带一节「空格 + 短尾」（{reason 首行}——查参取首 token）。 */
  var PARAM_RE = /^[A-Za-z_][A-Za-z0-9_:.]*(?: [^\s{}]{1,8})?$/;
  /** 复数形前缀：one/other/few/many 或数字样本形（1:/2:/5:）。 */
  var CAT_RE = /^(one|other|few|many|\d+)\s*:/;

  function paramValue(params, name) {
    if (params === undefined) return undefined;
    var direct = params[name];
    if (direct !== undefined) return direct;
    var head = name.split(" ")[0]; // {reason 首行}——带提示尾的写法按首 token 取参
    return params[head];
  }

  function isPresent(v) {
    return v !== undefined && v !== null && v !== "" && v !== false;
  }

  /** CLDR 复数类（六语够用子集：ru 三形、en 两形、zh/ja/ko 单形）。 */
  function pluralCategory(tag, n) {
    if (!Number.isFinite(n)) return "other";
    var abs = Math.abs(n);
    var i10 = abs % 10;
    var i100 = abs % 100;
    var t = tag.toLowerCase();
    if (t.startsWith("ru")) {
      if (i10 === 1 && i100 !== 11) return "one";
      if (i10 >= 2 && i10 <= 4 && !(i100 >= 12 && i100 <= 14)) return "few";
      return "many";
    }
    if (t.startsWith("en")) return abs === 1 ? "one" : "other";
    return "other";
  }

  /** 首个数值形参（复数选形依据——调用方按序传入计数值）。 */
  function firstNumeric(params) {
    if (params === undefined) return Number.NaN;
    for (var v of Object.values(params)) {
      if (typeof v === "number") return v;
      if (typeof v === "string" && v !== "" && /^\d+$/.test(v)) return Number(v);
    }
    return Number.NaN;
  }

  /** 深度感知的顶层切分（跳过内层 {…} 组；分隔符可为 | 或 /）。 */
  function splitTop(content, sep) {
    var segs = [];
    var depth = 0;
    var cur = "";
    for (var ch of content) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      if (ch === sep && depth === 0) {
        segs.push(cur);
        cur = "";
      } else cur += ch;
    }
    segs.push(cur);
    return segs;
  }

  /** 段内顶层形参名收集（浅层——内层组的形参不属本段判定面）。 */
  function paramNamesOf(segment) {
    var names = [];
    var depth = 0;
    var cur = "";
    for (var ch of segment) {
      if (ch === "{") {
        depth++;
        if (depth === 1) cur = "";
        continue;
      }
      if (ch === "}") {
        depth = Math.max(0, depth - 1);
        if (depth === 0 && cur !== "" && PARAM_RE.test(cur.split(FULLWIDTH_PIPE).join("|"))) names.push(cur.split(" ")[0].split(FULLWIDTH_PIPE)[0].split("|")[0]);
        continue;
      }
      if (depth >= 1) cur += ch;
    }
    return names;
  }

  function interpolate(template, params, tag) {
    var out = "";
    var i = 0;
    while (i < template.length) {
      var ch = template[i];
      if (ch !== "{") {
        out += ch;
        i++;
        continue;
      }
      // 匹配内层平衡的 }（内容可嵌套可选组）
      var depth = 0;
      var j = i;
      for (; j < template.length; j++) {
        if (template[j] === "{") depth++;
        else if (template[j] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (j >= template.length) {
        out += ch; // 未闭合——按字面输出（作者期噪音可见）
        i++;
        continue;
      }
      out += renderChunk(template.slice(i + 1, j), params, tag);
      i = j + 1;
    }
    return out;
  }

  function renderChunk(rawChunk, params, tag) {
    var chunk = rawChunk.split(FULLWIDTH_PIPE).join("|");

    // ① 显式条件段 {flag?…}
    var cond = /^([A-Za-z_][A-Za-z0-9_:.]*)\?([\s\S]+)$/.exec(chunk);
    if (cond) return isPresent(paramValue(params, cond[1])) ? interpolate(cond[2], params, tag) : "";

    // ② 裸形参 {name}
    if (PARAM_RE.test(chunk)) {
      var bare = paramValue(params, chunk);
      return isPresent(bare) ? String(bare) : "";
    }

    // ③ 顶层管道切分
    var pipeSegs = splitTop(chunk, "|");
    if (pipeSegs.length > 1) {
      // ③a 形参带缺省 {name|默认}
      if (PARAM_RE.test(pipeSegs[0])) {
        var piped = paramValue(params, pipeSegs[0]);
        return isPresent(piped) ? String(piped) : interpolate(pipeSegs.slice(1).join("|"), params, tag);
      }
      // ③b 复数形 {1:…|2:…|5:…}
      if (pipeSegs.every((s) => CAT_RE.test(s.trim()))) return selectVariant(pipeSegs, params, tag);
      // ③c 在场多选一
      return pickAlternative(pipeSegs, params, tag);
    }

    // ④ 顶层斜线切分（无管道时才尝试——路径形值含 / 但以管道分组的不受影响）
    var slashSegs = splitTop(chunk, "/");
    if (slashSegs.length > 1) {
      if (slashSegs.every((s) => CAT_RE.test(s.trim()))) return selectVariant(slashSegs, params, tag);
      // 表格既成惯例：{list/无} 斜线书写的形参缺省（首段为形参名 = 与管道同义；枚举槽 {Tavily/Brave}
      // 首段非调用侧形参——抽取任务须改写命名形参，改写前渲染缺省段属已知过渡态）
      if (PARAM_RE.test(slashSegs[0].trim())) {
        var slashed = paramValue(params, slashSegs[0].trim());
        return isPresent(slashed) ? String(slashed) : interpolate(slashSegs.slice(1).join("/"), params, tag);
      }
      return pickAlternative(slashSegs, params, tag);
    }

    // ⑤ 可选组：内含形参全部在场才渲染（{（含 {m} 个…）}）
    var inner = paramNamesOf(chunk);
    if (inner.length > 0) {
      var allPresent = inner.every((n) => isPresent(paramValue(params, n)));
      return allPresent ? interpolate(chunk, params, tag) : "";
    }

    // ⑥ 无形参无分隔的字面组——保留花括号原样（误用可见）
    return `{${rawChunk}}`;
  }

  function selectVariant(segs, params, tag) {
    var variants = new Map();
    for (var seg of segs) {
      var m = CAT_RE.exec(seg.trim());
      if (m) variants.set(m[1], seg.trim().slice(m[0].length));
    }
    var n = firstNumeric(params);
    var cat = pluralCategory(tag, n);
    var exemplar = { one: "1", few: "2", many: "5" };
    var picked = variants.get(cat) ?? (exemplar[cat] !== undefined ? variants.get(exemplar[cat]) : undefined) ?? variants.values().next().value ?? "";
    return interpolate(picked, params, tag);
  }

  function pickAlternative(segs, params, tag) {
    var analyzed = segs.map((s) => {
      var names = paramNamesOf(s);
      return { seg: s, names: names, missing: names.filter((n) => !isPresent(paramValue(params, n))) };
    });
    // 从右找「带参且全在场」的段（更具体的形态优先）；退回首个无参段；再退回首段
    for (var k = analyzed.length - 1; k >= 0; k--) {
      var a = analyzed[k];
      if (a.names.length > 0 && a.missing.length === 0) return interpolate(a.seg, params, tag);
    }
    for (var head of analyzed) if (head.names.length === 0) return interpolate(head.seg, params, tag);
    return interpolate(analyzed[0].seg, params, tag);
  }

  /** 单条模板格式化（公开面——宿主 store 与预算测试直接用）。 */
  function formatTemplate(template, params, tag = "en-US") {
    return interpolate(template, params, tag);
  }

  /** 解析链：zh-TW 特例经 zh-CN；其余 active → en-US（去重）。 */
  function chainFor(tag) {
    if (tag === "zh-TW") return ["zh-TW", "zh-CN", "en-US"];
    if (tag === "en-US") return ["en-US"];
    return [tag, "en-US"];
  }

  /** 语言标签归一（P3 分族）：剥 codeset/修饰后缀（zh_TW.big5 → zh-TW）；zh 裸码与 Hans 系 → zh-CN；
   * Hant 系 → zh-TW；en* → en-US；六语包裸码补全（ja→ja-JP / ko→ko-KR / ru→ru-RU）；
   * 其余区域大写规范化后原样透传。 */
  function normalizeLocaleTag(raw) {
    var t = (raw ?? "").trim().replace(/_/g, "-").toLowerCase().replace(/[.@].*$/, "");
    if (t === "") return "en-US";
    if (t === "zh" || t.startsWith("zh-hans") || t === "zh-cn" || t === "zh-sg" || t === "zh-my") return "zh-CN";
    if (t.startsWith("zh-hant") || t === "zh-tw" || t === "zh-hk" || t === "zh-mo" || t === "zh-hant-tw") return "zh-TW";
    if (t === "en" || t.startsWith("en-")) return "en-US";
    if (t === "ja") return "ja-JP";
    if (t === "ko") return "ko-KR";
    if (t === "ru") return "ru-RU";
    var parts = t.split("-");
    if (parts.length === 2) return `${parts[0]}-${parts[1].toUpperCase()}`;
    return t;
  }

  var curTag = "zh-CN";
  var table = {}; // 单表形态：六侧 parity 平行使链回落恒不触发；chainFor 保留供未来多表
  function t(key, params, fallback) {
    var v = table[key];
    if (v === undefined) return fallback !== undefined ? fallback : key;
    return formatTemplate(v, params, curTag);
  }
  globalThis.OrosusI18N = {
    t: t,
    setMessages: function (tag, m) { curTag = tag; table = m || {}; },
    cur: function () { return curTag; },
    formatTemplate: formatTemplate,
    normalizeLocaleTag: normalizeLocaleTag,
    chainFor: chainFor,
  };
})();
