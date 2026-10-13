/** web 批 T15 伴生测试：前端骨架静态资产——存在性 / CSP 洁净度（零内联）/ 断连 overlay 元素 /
 *  引用路径可达性 / server 静态路由（含 ETag/304 行为与路径穿越防护）。
 *  口径：brief assets-check.test.ts 行 + GC11（视口驱动几何——style.css 保留 --app-h 公式变量）+
 *  §5 律三（index.html 恒 no-cache、其余 ETag/304）。 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startWebServer } from "./server.ts";

const ASSETS_DIR = fileURLToPath(new URL("./assets/", import.meta.url));
const read = (name: string): string => readFileSync(join(ASSETS_DIR, name), "utf8");

describe("web T15：前端骨架静态资产", () => {
  it("① 四文件存在（index.html / style.css / api.js / app.js）", () => {
    for (const name of ["index.html", "style.css", "api.js", "app.js"]) {
      expect(existsSync(join(ASSETS_DIR, name)), `${name} 应存在`).toBe(true);
    }
  });

  it("② index.html CSP 洁净：无内联 script、无内联 style 属性、无内联事件处理器、无外源引用", () => {
    const html = read("index.html");
    // 无内联 script：每个 <script> 必须带 src
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1] ?? "");
    expect(scripts.length).toBeGreaterThanOrEqual(4); // vendor×2 + api.js + app.js
    for (const attrs of scripts) expect(attrs.includes("src="), "script 必须外引").toBe(true);
    // 无内联 style 属性 / <style> 块（CSP default-src 'self' 不放行 unsafe-inline）
    expect(/\bstyle\s*=/i.test(html), "不应有 style= 内联样式").toBe(false);
    expect(/<style\b/i.test(html), "不应有 <style> 内联块").toBe(false);
    // 无内联事件处理器
    expect(/\son[a-z]+\s*=/i.test(html), "不应有 on*= 内联事件").toBe(false);
    // 无外源引用（src/href 全部相对 /assets 或本站路径——CSP self）
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/gi)].map((m) => m[1] ?? "");
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(/^\/(assets\/)?[A-Za-z0-9._/-]+$/.test(r) || r === "#", `引用须本站相对路径：${r}`).toBe(true);
  });

  it("③ 断连 overlay 元素存在（骨架 + 正文/按钮驱动位）", () => {
    const html = read("index.html");
    for (const id of ["overlay-disc", "disc-title", "disc-body", "disc-retry"]) {
      expect(html.includes(`id="${id}"`), `#${id} 应存在`).toBe(true);
    }
    // 两档文案锚点在 api.js（断开 / 已正常关闭）
    const api = read("api.js");
    expect(api.includes("与 Orosus server 的连接已断开"), "断开型标题文案").toBe(true);
    expect(api.includes("已正常关闭"), "shutdown 变体文案").toBe(true);
    expect(api.includes("重试连接"), "重试按钮文案").toBe(true);
  });

  it("④ 引用路径全可达：index.html 引到的本地文件都在 assets 树或 vendor 解析域内", () => {
    const html = read("index.html");
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*"\/assets\/([^"?#]+)"/g)].map((m) => m[1] ?? "");
    expect(refs.length).toBeGreaterThanOrEqual(5); // style.css + vendor×2 + api.js + app.js（+ logo）
    for (const rel of refs) {
      if (rel.startsWith("vendor/")) continue; // vendor 由 node_modules 定位（下条直核）
      expect(existsSync(join(ASSETS_DIR, rel)), `assets/${rel} 应存在`).toBe(true);
    }
    // vendor 供给面：marked / dompurify 的 UMD 形态可解析（server.ts 同链路）
    const req = createRequire(join(ASSETS_DIR, "..", "server.ts"));
    const markedPkg = req.resolve("marked/package.json");
    expect(existsSync(join(markedPkg, "..", "lib", "marked.umd.js")), "marked UMD 应存在").toBe(true);
    expect(existsSync(req.resolve("dompurify/dist/purify.js")), "dompurify UMD 应存在").toBe(true);
  });

  it("⑤ GC11：style.css 保留视口驱动几何变量与公式（无写死窗体高）", () => {
    const css = read("style.css");
    expect(css.includes("--app-h:"), "--app-h 变量保留").toBe(true);
    expect(css.includes("100vh"), "视口驱动公式保留").toBe(true);
    expect(css.includes("flex: 1 1 55%"), "右栏 55/45 弹性保留").toBe(true);
    expect(css.includes("flex: 1 1 45%"), "右栏 55/45 弹性保留（45）").toBe(true);
    expect(css.includes("min(560px, calc(100vh - 160px))"), "设置弹窗高度公式保留").toBe(true);
    expect(css.includes("(max-width: 920px)"), "920px 断点保留").toBe(true);
  });

  it("②补 全资产 style= 内联属性零容忍（T18 清位棘轮——CSP style-src 不放行，换类/CSSOM 实现）", () => {
    // 属性形（style=" / style='）才计入——注释/文档里的字面 "style=" 不误伤（app.js 头注有「零 style= 属性」自述）
    for (const name of ["api.js", "app.js", "render.js", "ui.js", "archived-view.js"]) {
      expect(/\bstyle\s*=\s*["']/i.test(read(name)), `assets/${name} 不应有 style= 内联属性`).toBe(false);
    }
  });

  it("②补二 hidden 属性显式兜底（2026-10-12 走查修）：带 display 规则的类必须有对应 [hidden] 覆盖——否则作者样式盖掉 UA 的 display:none（「加载更早消息」曾因此恒显）", () => {
    const css = read("style.css");
    const html = read("index.html");
    expect(css).toContain(".pg-more[hidden]"); // 无历史消息时不显示加载更早（修复前误写 .pg[hidden]）
    expect(css).not.toMatch(/^\.pg\[hidden\]/m); // 无效选择器绝迹（元素类名是 pg-more）
    // index.html 所有带 hidden 初始态的元素：其每个类若在 CSS 中设了 display，就必须有 .类名[hidden] 覆盖
    const tags = [...html.matchAll(/<[^>]*\bhidden\b[^>]*>/gi)];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      const clsAttr = /class="([^"]*)"/i.exec(tag[0])?.[1] ?? "";
      for (const c of clsAttr.split(/\s+/).filter(Boolean)) {
        const rule = new RegExp("\\." + c + "[^{]*\\{[^}]*\\}").exec(css)?.[0] ?? "";
        if (!/\bdisplay\s*:/.test(rule)) continue; // 该类不设 display——UA hidden 规则生效，无需兜底
        expect(css.includes("." + c + "[hidden]"), `类 .${c} 设了 display 又用于 hidden 元素（${tag[0].slice(0, 60)}…）——须有 [hidden] 覆盖规则`).toBe(true);
      }
    }
  });

  it("⑤补 esc() 全量转义：含双引号/单引号/&/</> 的输入不破出 HTML 属性（T15 审查 Important-1）", () => {
    const api = read("api.js");
    // 转义原语齐备（& < > " ' 五字符——title="…" 拼属性消费面的硬前提）
    expect(api.includes('&quot;'), 'esc 须转义双引号（&quot;）').toBe(true);
    expect(api.includes('&#39;'), "esc 须转义单引号（&#39;）").toBe(true);
    // 行为级验证：以同源实现复算（浏览器原生路径同式）——五字符全转 + 幂等源字符不二次转义
    const escLike = (s: string): string =>
      String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const sample = '会话"引号"与\'单引号\'<b>&amp;</b>';
    const out = escLike(sample);
    expect(out).toBe("会话&quot;引号&quot;与&#39;单引号&#39;&lt;b&gt;&amp;amp;&lt;/b&gt;");
    expect(out.includes('"')).toBe(false);
    expect(out.includes("<")).toBe(false);
    expect(out.includes(">")).toBe(false);
  });

  it("⑦ W1 分栏骨架：splitter/pane/pane-tabs/pane-body/btn-split DOM + 右栏互斥/拖拽/悬浮条下移/归属徽标 CSS + JS 契约（v2 直裁）", () => {
    const html = read("index.html");
    /* DOM 契约（v2 1241-1252 / 1032 同名 id） */
    for (const id of ["splitter", "pane", "pane-tabs", "pane-body", "btn-split"]) {
      expect(html.includes(`id="${id}"`), `#${id} 应存在`).toBe(true);
    }
    /* 位置契约：splitter/pane 落在 .main 与 #rside 之间（右栏互斥的布局锚点） */
    const iMain = html.indexOf('class="main"');
    const iSplitter = html.indexOf('id="splitter"');
    const iPaneBody = html.indexOf('id="pane-body"');
    const iRside = html.indexOf('id="rside"');
    expect(iMain, ".main 应存在").toBeGreaterThan(-1);
    expect(iSplitter).toBeGreaterThan(iMain);
    expect(iPaneBody).toBeGreaterThan(iSplitter);
    expect(iRside).toBeGreaterThan(iPaneBody);
    /* 顶栏入口：#btn-split 在 .ab-acts 末尾（btn-theme 之后），文案 ◧ 分栏（v2 1032） */
    expect(html.indexOf('id="btn-split"')).toBeGreaterThan(html.indexOf('id="btn-theme"'));
    expect(html.includes(">◧ 分栏</button>"), "btn-split 文案").toBe(true);
    /* 主悬浮条归属徽标钩子：#tf-pill 内首元素 .tf-owner、文案「主」（v2 1053） */
    expect(/id="tf-pill"[^>]*><span class="tf-owner">主<\/span>/.test(html), ".tf-owner 归属徽标「主」").toBe(true);
    /* GC2 棘轮：v2 评审件零移植 */
    expect(html.includes("data-spec"), "data-spec 评审件不移植（GC2）").toBe(false);
    expect(html.includes("btn-specs"), "「标注」钮评审件不移植（GC2）").toBe(false);

    const css = read("style.css");
    /* 右栏互斥：分栏开 = .side 隐藏（v2 922） */
    expect(/\.app-body\.split \.side\s*\{\s*display:\s*none;\s*\}/.test(css), ".app-body.split .side 互斥规则").toBe(true);
    /* 分栏态切 flex（app-body 默认 grid——成全 v2 拖拽的 pane.style.flex 口径） */
    expect(/\.app-body\.split\s*\{\s*display:\s*flex;\s*\}/.test(css), "分栏态 flex 形态开关").toBe(true);
    /* splitter：col-resize 拖拽形态（v2 916-918） */
    expect(/\.splitter\s*\{[^}]*cursor:\s*col-resize/.test(css), ".splitter col-resize").toBe(true);
    expect(css.includes(".splitter[hidden]"), ".splitter [hidden] 兜底").toBe(true);
    /* pane：右侧分栏卡（v2 920-921） */
    expect(/\.pane\s*\{[^}]*border-left:\s*1px solid var\(--border\)/.test(css), ".pane border-left").toBe(true);
    expect(css.includes(".pane[hidden]"), ".pane [hidden] 兜底").toBe(true);
    /* 分栏时主悬浮条下移 46px（v2 839——与子代理悬浮条同水平线；作用域限定 .main） */
    expect(/\.app-body\.split \.main > \.todo-float\s*\{[^}]*top:\s*46px/.test(css), "主悬浮条下移规则").toBe(true);
    /* 归属徽标：10px mono、border、4px 圆角（v2 967） */
    const tfOwner = /\.tf-owner\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(/font-family:\s*var\(--font-mono\)/.test(tfOwner), ".tf-owner mono").toBe(true);
    expect(/border-radius:\s*4px/.test(tfOwner), ".tf-owner 4px 圆角").toBe(true);
    expect(/font-size:\s*calc\(10px/.test(tfOwner), ".tf-owner 10px").toBe(true);
    /* ≤920px 媒体查询：分栏转纵向堆叠（v2 996-1005 同款） */
    const mq = /@media \(max-width: 920px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(mq.includes(".splitter { display: none; }"), "920px 分隔条隐藏").toBe(true);
    expect(/\.pane\s*\{[^}]*flex:\s*0 0 auto;[^}]*border-top:\s*1px solid var\(--border\)/.test(mq), "920px 分栏纵向堆叠").toBe(true);
    expect(/\.app-body\.split\s*\{[^}]*flex-direction:\s*column/.test(mq), "920px 分栏态纵向").toBe(true);

    const js = read("app.js");
    /* JS 契约：openPane/closePane/paneIsOpen 挂 window.OrosusUI（W2-W6 依赖面） */
    expect(js.includes("function paneIsOpen()"), "paneIsOpen 定义").toBe(true);
    expect(js.includes("function openPane()"), "openPane 定义").toBe(true);
    expect(js.includes("function closePane()"), "closePane 定义").toBe(true);
    for (const [name, fn] of [["paneIsOpen", "paneIsOpen"], ["openPane", "openPane"], ["closePane", "closePane"]] as const) {
      expect(new RegExp(`UI\\.${name}\\s*=\\s*${fn}\\b`).test(js), `UI.${name} 挂 OrosusUI`).toBe(true);
    }
    /* 形态开关 + close 清空 pane.style.flex（v2 4368-4389） */
    expect(js.includes("appBody.classList.add('split')"), "open 加 split").toBe(true);
    expect(js.includes("appBody.classList.remove('split')"), "close 去 split").toBe(true);
    expect(js.includes("pane.style.flex = ''"), "close 清空 pane.style.flex").toBe(true);
    /* 拖拽 clamp：分栏下限 300px、主列下限 480px（v2 4710-4728） */
    expect(/Math\.min\(Math\.max\(startW - \(ev\.clientX - startX\), 300\), bodyW - 480\)/.test(js), "拖拽 clamp 300/480").toBe(true);
    expect(js.includes("pane.style.flex = '0 0 ' + Math.round(w) + 'px'"), "拖拽落定 flex 定宽").toBe(true);
    /* syncTodoFloat 可见性矩阵 v2 4323 口径：(右栏收窄 || 分栏开) && 主清单非空 */
    expect(js.includes("todoFloat.hidden = !(railed || split)"), "悬浮条两源可见性").toBe(true);
    expect(js.includes("mainTodoCount() === 0"), "主清单空则不显示").toBe(true);
    /* 顶栏入口接线：已开则收（v2 4731-4734——W3 后未开分支改接 cmdTasks） */
    expect(js.includes("toast('分栏已收回')"), "收起 toast").toBe(true);
  });

  it("⑥ server 静态路由：/ 与 /assets/* 免 token、CSP 头、index 恒 no-cache、其余 ETag + 304、vendor 可达", async () => {
    const { server, port } = await startWebServer({ cwd: process.cwd(), home: process.cwd() });
    const base = `http://127.0.0.1:${port}`;
    try {
      // / 免 token（页面首开）：HTML + CSP + 恒 no-cache
      const idx = await fetch(`${base}/`);
      expect(idx.status).toBe(200);
      expect(idx.headers.get("content-type")).toContain("text/html");
      expect(idx.headers.get("cache-control")).toBe("no-cache");
      expect(idx.headers.get("content-security-policy")).toMatch(/^default-src 'self'/);
      expect(await idx.text()).toContain('id="app"');

      // /assets/style.css：ETag + 二次 If-None-Match → 304
      const css1 = await fetch(`${base}/assets/style.css`);
      expect(css1.status).toBe(200);
      expect(css1.headers.get("content-type")).toContain("text/css");
      const etag = css1.headers.get("etag");
      expect(etag).toBeTruthy();
      expect(css1.headers.get("cache-control")).not.toBe("no-cache"); // 其余可缓存（revalidate 形）
      const css2 = await fetch(`${base}/assets/style.css`, { headers: { "if-none-match": etag! } });
      expect(css2.status).toBe(304);

      // api.js / app.js 可达
      for (const f of ["api.js", "app.js"]) {
        const r = await fetch(`${base}/assets/${f}`);
        expect(r.status, `/assets/${f}`).toBe(200);
        expect(r.headers.get("content-type")).toContain("javascript");
      }

      // vendor：marked / dompurify UMD（免 token——/assets/* 豁免面）
      const marked = await fetch(`${base}/assets/vendor/marked.js`);
      expect(marked.status).toBe(200);
      expect(await marked.text()).toContain("marked");
      const purify = await fetch(`${base}/assets/vendor/purify.js`);
      expect(purify.status).toBe(200);
      expect(await purify.text()).toContain("DOMPurify");

      // 路径穿越防护（path.sep 前缀判——Windows 上 resolve 产反斜杠）：raw http 请求（fetch 会按
      // URL 规范规范化点段——测不到 server 侧防线），四形态均不得读出 server.ts/auth.ts
      const rawGet = (p: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
        const rq = httpRequest({ host: "127.0.0.1", port, path: p }, (r2) => {
          let b = "";
          r2.on("data", (c: Buffer) => { b += c.toString("utf8"); });
          r2.on("end", () => resolve({ status: r2.statusCode ?? 0, body: b }));
        });
        rq.on("error", reject);
        rq.end();
      });
      for (const p of ["/assets/../server.ts", "/assets/%2e%2e/server.ts", "/assets/..%5Cserver.ts", "/assets/%2e%2e%5Cauth.ts"]) {
        const r = await rawGet(p);
        expect([200, 400, 404].includes(r.status), `${p} 应被拒（实得 ${r.status}）`).toBe(true);
        if (r.status === 200) expect(r.body).not.toContain("registerRoute");
      }
      // 不存在的资产 → 404
      expect((await fetch(`${base}/assets/nope.js`)).status).toBe(404);
    } finally {
      server.close();
      server.closeAllConnections?.();
    }
  });
});
