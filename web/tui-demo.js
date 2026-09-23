/* 首页终端演示：普通终端里敲 `pnpm orosus` → 清屏进入全屏 TUI（FullApp 形态）。
 * 进入视口自动播一次；点击窗口重播。TUI 阶段恒为夜山。 */
(function () {
  "use strict";
  var term = document.getElementById("heroTerm");
  if (!term) return;
  var boot = document.getElementById("bootBody");
  var typed = document.getElementById("typedText");
  var tui = document.getElementById("heroTui");
  var CMD = "pnpm orosus";
  var timer = null;

  function run() {
    if (timer) clearInterval(timer);
    term.classList.remove("tui-on");
    tui.hidden = true;
    boot.style.display = "";
    typed.textContent = "";
    var i = 0;
    timer = setInterval(function () {
      i++;
      typed.textContent = CMD.slice(0, i);
      if (i >= CMD.length) {
        clearInterval(timer);
        timer = null;
        setTimeout(function () {
          boot.style.display = "none";
          tui.hidden = false;
          term.classList.add("tui-on");
        }, 700);
      }
    }, 110);
  }

  // 滚进视口再播，避免首屏外空跑
  if ("IntersectionObserver" in window) {
    var played = false;
    new IntersectionObserver(function (entries, ob) {
      entries.forEach(function (e) {
        if (e.isIntersecting && !played) { played = true; run(); ob.disconnect(); }
      });
    }, { threshold: 0.3 }).observe(term);
  } else {
    run();
  }

  term.addEventListener("click", run);
})();
