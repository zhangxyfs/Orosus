/* 迷你语法高亮：给 <pre><code class="language-ts|bash"> 上色（连山主题）。
 * 单遍正则交替（注释|字符串|关键字|数字），对已转义文本安全。 */
(function () {
  "use strict";
  var TS_KW = ["import","export","default","const","let","var","async","await","function","return","if","else","for","of","in","new","interface","type","extends","implements","from","as","typeof","true","false","null","undefined","this","class","get","set"];
  var SH_KW = ["git","cd","pnpm","npm","node","npx","echo","printf","mv","rm","ls","clone","install","run","vitest","orosus"];

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function highlight(lang, src) {
    var kw = lang === "bash" ? SH_KW : TS_KW;
    var comment = lang === "bash" ? "#[^\\n]*" : "//[^\\n]*";
    var str = "\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`";
    var re = new RegExp(
      "(" + comment + ")|" +
      "(" + str + ")|" +
      "\\b(" + kw.join("|") + ")\\b|\\b(\\d+(?:\\.\\d+)?)\\b",
      "g"
    );
    var out = "", last = 0, m;
    while ((m = re.exec(src)) !== null) {
      out += esc(src.slice(last, m.index));
      var seg = esc(m[0]);
      if (m[1] !== undefined) out += '<span class="c">' + seg + "</span>";
      else if (m[2] !== undefined) out += '<span class="s">' + seg + "</span>";
      else if (m[3] !== undefined) out += '<span class="k">' + seg + "</span>";
      else out += '<span class="n">' + seg + "</span>";
      last = m.index + m[0].length;
    }
    return out + esc(src.slice(last));
  }

  document.querySelectorAll("pre code[class*=language-]").forEach(function (el) {
    var lang = /language-(\w+)/.exec(el.className);
    el.innerHTML = highlight(lang ? lang[1] : "ts", el.textContent);
  });
})();
