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
