/* docs.html 逻辑：拉取 md 镜像 → marked 渲染 → 链接改写（站内 .md 继续走查看器，
 * docs/api/ 指向站点 /api/，其余相对资源指向 md/ 镜像）。 */
(function () {
  "use strict";
  var content = document.getElementById("content");
  var status = document.getElementById("status");
  var sideLinks = document.querySelectorAll(".docs-side a[data-file]");

  // 有英文对照版的文档（持续补充；键 = 中文版，值 = 英文版，可互跳）
  var PAIRS = { "README.md": "README_EN.md", "README_EN.md": "README.md" };
  var EN = window.Lang ? window.Lang.cur() === "en" : false;

  function dirname(p) { var i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i + 1); }
  function resolve(base, href) {
    // 只处理相对路径；返回规范化路径
    var parts = (base + href).split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (s === "" || s === ".") continue;
      if (s === "..") out.pop(); else out.push(s);
    }
    return out.join("/");
  }

  function rewrite(html, filePath) {
    var box = document.createElement("div");
    box.innerHTML = html;
    // 标题加 id（锚点跳转用）
    box.querySelectorAll("h1, h2, h3, h4").forEach(function (h, i) {
      if (!h.id) h.id = "h-" + (h.textContent || "").trim().replace(/\s+/g, "-").toLowerCase() + "-" + i;
    });
    box.querySelectorAll("a[href]").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (href.indexOf("#") === 0) {
        // 站内锚点：就地滚动，别丢 ?file= 参数
        a.addEventListener("click", function (ev) {
          ev.preventDefault();
          var t = document.getElementById(decodeURIComponent(href.slice(1)));
          if (t) t.scrollIntoView({ behavior: "smooth" });
        });
        return;
      }
      if (/^https?:\/\//.test(href)) { a.target = "_blank"; a.rel = "noopener"; return; }
      var p = resolve(dirname(filePath), href);
      if (p.indexOf("docs/api/") === 0) { a.href = p.slice("docs/".length); a.target = "_blank"; return; } // 站点 /api/
      if (/\.md$/i.test(p)) { a.href = "docs.html?file=" + encodeURIComponent(p); return; }
      a.href = "md/" + p; a.target = "_blank"; // 其他资源（图片等）走镜像原文件
    });
    box.querySelectorAll("img[src]").forEach(function (im) {
      var src = im.getAttribute("src") || "";
      if (/^https?:\/\//.test(src) || src.indexOf("data:") === 0) return;
      im.src = "md/" + resolve(dirname(filePath), src);
      im.loading = "lazy";
    });
    return box;
  }

  function markActive(file) {
    sideLinks.forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-file") === file);
    });
  }

  function load(file) {
    status.textContent = (EN ? "Loading " : "加载 ") + file + (EN ? " …" : " …");
    fetch("md/" + file, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    }).then(function (text) {
      var html = marked.parse(text, { gfm: true, breaks: false });
      content.innerHTML = "";
      content.appendChild(rewrite(html, file));
      status.textContent = file + " · " + (EN ? text.length + " chars" : "共 " + text.length + " 字符") + (PAIRS[file] ? (EN ? " · 中文版可用（点「中文」切换）" : " · English available (switch with EN)") : (EN ? " · no English version yet" : " · 暂无英文版"));
      markActive(file);
      document.title = (content.querySelector("h1") ? content.querySelector("h1").textContent + " — " : "") + "Orosus 连山";
      window.scrollTo({ top: 0 });
    }).catch(function (e) {
      status.textContent = (EN ? "Failed to load " : "加载失败：") + file + " (" + e.message + "). " + (EN ? "The md/ mirror is built by the pages workflow online; build it locally for preview (see web/README.md)." : "线上由 pages workflow 自动构建镜像；本地预览先按 web/README.md 构建 web/md。");
      content.innerHTML = "";
    });
  }

  sideLinks.forEach(function (a) {
    a.addEventListener("click", function () {
      var f = a.getAttribute("data-file");
      location.href = "docs.html?file=" + encodeURIComponent(f);
    });
  });

  // 语言切换：偏好存 localStorage；当前文档有对照版就跳对照版，否则回落到该语言的 README
  var q = new URLSearchParams(location.search).get("file");
  var currentFile = q || (EN ? "README_EN.md" : "README.md");
  var btn = document.getElementById("langBtn");
  if (btn) {
    btn.addEventListener("click", function () {
      var next = window.Lang.toggle();
      var pair = PAIRS[currentFile] || (next === "en" ? "README_EN.md" : "README.md");
      location.href = "docs.html?file=" + encodeURIComponent(pair);
    });
  }

  load(currentFile);
})();
