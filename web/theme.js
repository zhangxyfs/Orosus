/* 昼夜切换：html.light 类 + localStorage（orosus-theme），默认黑夜。
 * 页面 <head> 内联早脚本防闪烁（与语言偏好合并为一段）。
 * 切换按钮：class="theme-toggle"，点击调 Theme.toggle()。 */
(function () {
  "use strict";
  var KEY = "orosus-theme";

  function cur() {
    try { return localStorage.getItem(KEY) === "light" ? "light" : "dark"; } catch (e) { return "dark"; }
  }

  function apply(theme) {
    document.documentElement.classList.toggle("light", theme === "light");
    document.querySelectorAll(".theme-toggle").forEach(function (b) {
      b.textContent = theme === "light" ? "☾" : "☀";
      b.title = theme === "light" ? "切换到黑夜" : "切换到白天";
    });
  }

  window.Theme = {
    cur: cur,
    set: function (t) { try { localStorage.setItem(KEY, t); } catch (e) { /* 忽略 */ } apply(t); },
    toggle: function () { var n = cur() === "light" ? "dark" : "light"; this.set(n); return n; },
  };

  // 统一接线：所有 .theme-toggle 按钮（index 用不到内联 onclick 了）
  document.querySelectorAll(".theme-toggle").forEach(function (b) {
    b.addEventListener("click", function () { window.Theme.toggle(); });
  });

  apply(cur());
})();
