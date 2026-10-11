/** 文件面端点（web 批 T4）：POST /api/uploads（贴图上传——落会话媒资库）、GET /api/media（图片回显
 *  ——白名单 = 会话 media 目录）、GET /api/at（@ 文件菜单数据源）。
 *  媒资落位 = paste.ts m5-media F8 同款（<bucket>/<sid>/media/，随会话生命周期——core 对 images 是
 *  路径引用透传〔harness.ts:1336-1338 只存路径〕，故必须落会话目录，fork 同桶引用不破）。
 *  上传自创值（方案 §5 表）：≤10MB、仅 image/*、每消息 ≤6 张（D6）。 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { locateSessionFile } from "@orosus/core";
import { registerRoute, readBody, sendJson } from "./server.ts";
import { webHostPool } from "./mod.ts";
import { imageSize } from "../paste.ts";
import { extImageMime } from "../vision-media.ts";

/** 上传大小上限（自创值登记——方案 §5 表：上传 ≤10MB 仅 image/*）。 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** 每消息图片上限（自创值登记——同上：每消息 ≤6 张〔D6〕）。send 端点消费。 */
export const MAX_IMAGES_PER_MESSAGE = 6;
/** 允许的落盘扩展名（?name= 的扩展不在此列按 content-type 映射，再缺省 png）。 */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

const notFound = (res: ServerResponse): void => {
  sendJson(res, 404, { ok: false, error: "not found" });
};

const queryParams = (req: IncomingMessage): URLSearchParams => {
  const url = req.url ?? "";
  const qi = url.indexOf("?");
  return new URLSearchParams(qi >= 0 ? url.slice(qi + 1) : "");
};

/** 码元升序比较（D6——不用 localeCompare，系统 locale 差异让测试漂移；at-menu-entries.ts:13 同款）。 */
const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** GET /api/at?cwd=&dir=&q= → {entries:[{name,dir}]}（§3 形状）。数据源同款 at-menu-entries.ts:15
 *  （D6/D7）：readdirSync withFileTypes + 目录前置 + 码元升序（不用 localeCompare——系统 locale 差异
 *  让测试漂移）+ 符号链接 statSync 跟随判定真实类型（断链按文件）；基址从 process.cwd() 换 cwd 参
 *  （web 单进程多项目托管——§4-8 同精神）。q = 前缀过滤（D7，忽略大小写）；目录不存在/不可读 →
 *  空态不炸（TUI miss 空态同语义）。 */
registerRoute("GET", "/api/at", (req, res) => {
  const qs = queryParams(req);
  const cwd = qs.get("cwd") ?? "";
  if (cwd === "") {
    sendJson(res, 400, { ok: false, error: "cwd required" });
    return;
  }
  const dir = qs.get("dir") ?? "";
  const q = (qs.get("q") ?? "").toLowerCase();
  let entries: { name: string; dir: boolean }[];
  try {
    const base = resolve(cwd, dir);
    const dirents = readdirSync(base, { withFileTypes: true });
    const all = dirents.map((d) => {
      if (!d.isSymbolicLink()) return { name: d.name, dir: d.isDirectory() };
      try {
        return { name: d.name, dir: statSync(join(base, d.name)).isDirectory() };
      } catch {
        return { name: d.name, dir: false }; // 断链按文件（D7——stat 失败不炸不挂）
      }
    });
    entries = [...all.filter((e) => e.dir).toSorted(byName), ...all.filter((e) => !e.dir).toSorted(byName)];
  } catch {
    entries = [];
  }
  const out = q === "" ? entries : entries.filter((e) => e.name.toLowerCase().startsWith(q));
  sendJson(res, 200, { ok: true, entries: out });
});

/** POST /api/uploads（body 二进制图，?name=&sid=）→ {ok,id,path,width,height}（§3 形状——width/
 *  height 经件头解析可读则带，webp 无解析器不带）。id = 落盘文件名 web-<uuid>.<ext>——send 的
 *  imageIds 以 id 引用（解析域 = 该会话 media 目录，见 resolveImageIds）。 */
registerRoute("POST", "/api/uploads", async (req, res) => {
  const qs = queryParams(req);
  const sid = qs.get("sid") ?? "";
  const name = qs.get("name") ?? "";
  if (sid === "") {
    sendJson(res, 400, { ok: false, error: "sid required" });
    return;
  }
  const pool = webHostPool();
  if (pool === undefined) {
    notFound(res);
    return;
  }
  // 会话定位：host 优先（桶自算——§4-8）；盘上未托管走 locate（未托管/viewer 会话同可贴图——媒体随会话）
  const hosted = pool.host(sid);
  const sessionDir = hosted !== undefined ? hosted.sessionDir : locateSessionFile(pool.root, sid)?.dir;
  if (sessionDir === undefined) {
    notFound(res);
    return;
  }
  const ct = (req.headers["content-type"] ?? "").toLowerCase();
  if (!ct.startsWith("image/")) {
    sendJson(res, 415, { ok: false, error: "content-type must be image/*" });
    return;
  }
  const body = await readBody(req, UPLOAD_MAX_BYTES);
  if (body === "too-large") {
    sendJson(res, 413, { ok: false, error: "upload exceeds 10MB" });
    setTimeout(() => req.destroy(), 50).unref?.(); // 让 413 响应先落地再拆连接（帧刷出窗同精神）
    return;
  }
  if (body.length === 0) {
    sendJson(res, 400, { ok: false, error: "empty body" });
    return;
  }
  // 扩展名：?name= 的扩展在白名单内用它；否则 content-type 映射；再缺省 png（剪贴板贴图恒 PNG）
  const nameExt = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const ext = IMAGE_EXTS.has(nameExt)
    ? nameExt
    : ct === "image/jpeg" ? "jpg" : ct === "image/webp" ? "webp" : ct === "image/gif" ? "gif" : "png";
  const id = `web-${randomUUID()}.${ext}`;
  const mediaDir = join(sessionDir, "media");
  mkdirSync(mediaDir, { recursive: true });
  const file = join(mediaDir, id);
  writeFileSync(file, body);
  const sz = imageSize(file); // paste.ts 纯读件头（PNG/GIF/JPEG——webp 无解析不带尺寸）
  sendJson(res, 200, { ok: true, id, path: file, ...(sz !== undefined ? { width: sz.w, height: sz.h } : {}) });
});

/** 媒资白名单判定（GET /api/media 的 403 边界）：路径须落在会话 media 目录（<root>/<bucket>/<sid>/
 *  media/<file>——uploads/paste 同位）。判据 = root 内（穿越形态先 resolve 归一）+ 倒数第二段目录名
 *  是 media + 至少 4 段（bucket/sid/media/file）。 */
export function mediaAllowed(root: string, path: string): boolean {
  const abs = resolve(path);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]/);
  return parts.length >= 4 && parts[parts.length - 2] === "media";
}

/** GET /api/media?path= → 图片字节（content-type 按扩展名）。越权（root 外 / root 内非 media 目录）
 *  → 403；白名单内不存在 → 404——存在性与越权两码事。 */
registerRoute("GET", "/api/media", (req, res) => {
  const raw = queryParams(req).get("path") ?? "";
  const pool = webHostPool();
  if (pool === undefined) {
    notFound(res);
    return;
  }
  if (raw === "") {
    sendJson(res, 400, { ok: false, error: "path required" });
    return;
  }
  if (!mediaAllowed(pool.root, raw)) {
    sendJson(res, 403, { ok: false, error: "path not allowed" });
    return;
  }
  const abs = resolve(raw);
  let isFile = false;
  try {
    isFile = statSync(abs).isFile();
  } catch { /* 缺席走 404 */ }
  if (!isFile) {
    notFound(res);
    return;
  }
  try {
    res.writeHead(200, { "content-type": extImageMime(abs), "cache-control": "no-store" });
    res.end(readFileSync(abs));
  } catch {
    if (!res.headersSent) notFound(res);
    else res.destroy();
  }
});

/** send 端点的 imageIds → 绝对路径（§3 POST send {imageIds}）：id = 会话 media 目录内文件名
 *  （uploads 发形 web-<uuid>.<ext>；TUI paste-*.png 同位可引用——handover 会话贴过图不失联）。
 *  纯名校验（无路径段/无 ..）+ 存在性；解析域恒为该会话 media 目录（跨会话引用一步不可越）。
 *  未知/越形 id → error（端点 400）。 */
export function resolveImageIds(sessionDir: string, ids: string[]): { images: string[] } | { error: string } {
  const images: string[] = [];
  for (const id of ids) {
    if (id === "" || id.includes("/") || id.includes("\\") || id.includes("..")) {
      return { error: `未知图片 id：${id}` };
    }
    const p = join(sessionDir, "media", id);
    if (!existsSync(p)) return { error: `未知图片 id：${id}` };
    images.push(p);
  }
  return { images };
}
