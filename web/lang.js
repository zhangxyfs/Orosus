/* 中英切换机制：html.en 类驱动 CSS 显隐（[data-zh] / [data-en]），偏好存 localStorage。
 * 页面 <head> 里放一段内联早脚本防闪烁：
 *   <script>try{if(localStorage.getItem("orosus-lang")==="en")document.documentElement.classList.add("en")}catch(e){}</script>
 * 切换按钮：class="lang-toggle"，点击调 Lang.toggle()（docs 页传回调做文档级切换）。 */
(function () {
  "use strict";
  var KEY = "orosus-lang";

  function cur() {
    try { return localStorage.getItem(KEY) === "en" ? "en" : "zh"; } catch (e) { return "zh"; }
  }

  function apply(lang) {
    document.documentElement.classList.toggle("en", lang === "en");
    document.documentElement.setAttribute("lang", lang === "en" ? "en" : "zh-CN");
    var t = document.querySelector("title[data-en]");
    if (t) document.title = (lang === "en" ? t.getAttribute("data-en") : (t.getAttribute("data-zh") || t.textContent)) || t.textContent;
    document.querySelectorAll(".lang-toggle").forEach(function (b) {
      b.textContent = lang === "en" ? "中文" : "EN";
      b.title = lang === "en" ? "切换到中文" : "Switch to English";
    });
  }

  function set(lang) {
    try { localStorage.setItem(KEY, lang); } catch (e) { /* 隐私模式等：偏好丢就丢 */ }
    apply(lang);
  }

  window.Lang = {
    cur: cur,
    set: set,
    toggle: function (onChange) {
      var next = cur() === "en" ? "zh" : "en";
      set(next);
      if (onChange) onChange(next);
      return next;
    },
  };

  apply(cur());
})();
