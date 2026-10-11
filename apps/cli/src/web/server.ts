/** web server 骨架（web 批 T1，GC2 零新网络依赖——node:http + 手写路由，无 express/ws/hono）。
 *  中间件序（brief T1 定档）：Host 白名单（GC4 防 DNS rebinding）→ token（/ 与 /assets/* 豁免——
 *  页面首开与静态资产不带 token，页面内 api.js 从 ?token= 收纳后再走头）→ JSON-only POST 护栏
 *  （写方法须 content-type: application/json）→ 路由分发。
 *  每请求 catch 兜底：单请求失败（含坏 %-escape 解码抛错）一律 400 JSON 壳，绝不杀进程（⑩ 护栏）。
 *  路由注册位：registerRoute(method, pattern, handler)——api-* 件（T2+）注册进模块级表；pattern
 *  段级匹配，":name" 捕获段，尾段 "*" 前缀匹配（/assets/* 静态树用——T15）。
 *  SIGINT 清退序（骨架自带实例文件清理——Ctrl+C 后实例文件删）：broadcastShutdown（T2 注册：
 *  SSE shutdown 帧广播 + HostPool.closeAll——G15 清退序在此填充）→ 关 server（含全部连接）→
 *  删实例文件。
 *  端口策略（G13）：pickFreePort listen 探测（占用换随机，≤10 次；首选 5317——原型口径）；真 listen
 *  的 EADDRINUSE 竞态窗由重试兜底；只绑 127.0.0.1（GC4 本机纪律）。 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, statSync, type Stats } from "node:fs";
import { dirname, extname, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { orosusHome } from "@orosus/contracts/home";
import { OROSUS_VERSION } from "@orosus/contracts/version";
import { checkToken, hostAllowed } from "./auth.ts";
import { removeInstance, reuseOrMintToken } from "./instance.ts";

/** 无 --port 时的首选端口（原型口径；自创值登记——改值先查方案 §5 表）。 */
export const DEFAULT_WEB_PORT = 5317;
/** 端口换号重试上限（自创值登记）。 */
const PORT_RETRIES = 10;

// ---------- 路由表 ----------

/** 路由参数（":name" 捕获段；尾 "*" 的剩余路径收在 params["*"]）。 */
export interface RouteParams {
  [key: string]: string;
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void | Promise<void>;

interface RouteEntry {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

/** 模块级路由表（key = "METHOD pattern"；后注册覆盖先注册——同键重注册以最新为准）。 */
const routes = new Map<string, RouteEntry>();

/** 路由注册位（T2+ 的 api-* 件消费——brief「后续任务消费」行）：注册须发生在起服/横幅之前
 *  （readiness 纪律——防浏览器先到 404）。 */
export function registerRoute(method: string, pattern: string, handler: RouteHandler): void {
  const m = method.toUpperCase();
  routes.set(`${m} ${pattern}`, { method: m, segments: pattern.split("/").filter((s) => s !== ""), handler });
}

/** pattern 段与请求路径段匹配：段数相等逐段比（":name" 捕获、静态段全等）；pattern 尾段 "*" =
 *  前缀匹配（剩余段收 params["*"]）。入参 pathSegs 已解码（见分发处——坏 %-escape 在解码期即抛，
 *  由 per-request catch 转 400）。 */
function matchPath(segments: string[], pathSegs: string[]): RouteParams | undefined {
  const params: RouteParams = {};
  for (let i = 0; i < segments.length; i++) {
    const pat = segments[i]!;
    const seg = pathSegs[i];
    if (pat === "*") {
      params["*"] = pathSegs.slice(i).join("/");
      return params;
    }
    if (seg === undefined) return undefined;
    if (pat.startsWith(":")) params[pat.slice(1)] = seg;
    else if (pat !== seg) return undefined;
  }
  return pathSegs.length === segments.length ? params : undefined;
}

// ---------- JSON 壳 ----------

export function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 请求体读取（T4：POST send 的 JSON 体与 POST uploads 的二进制体共用）：聚合 data 块至 cap——
 *  content-length 预检 + 流式累计双保险（chunked 无预检可用）；超限返回 "too-large"（调用方回 413，
 *  并自行延迟销毁连接让响应先落地——余体不吞不停读，settled 后续块为 no-op）。客户端中断 reject
 *  （per-request catch → 400）。 */
export function readBody(req: IncomingMessage, capBytes: number): Promise<Buffer | "too-large"> {
  const declared = Number(req.headers["content-length"] ?? "");
  if (Number.isFinite(declared) && declared > capBytes) return Promise.resolve("too-large");
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > capBytes) {
        settled = true;
        resolve("too-large");
        return;
      }
      parts.push(c);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(parts));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

const sendOk = (res: ServerResponse, status: number, extra: Record<string, unknown> = {}): void =>
  sendJson(res, status, { ok: true, ...extra });
const sendErr = (res: ServerResponse, status: number, error: string): void =>
  sendJson(res, status, { ok: false, error });

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** JSON-only 护栏豁免面（T4）：POST /api/uploads 为二进制图体（?name=&sid= 查询参携带元数据，
 *  content-type 是 image/* 而非 application/json）——按路径显式豁免。取舍：枚举路径集可读性最好、
 *  单点豁免不值得为它扩 registerRoute 签名（路由元数据开关方案弃——记录于 T4 报告）；后续二进制
 *  写端点（若有）须同此登记。 */
const JSON_GUARD_EXEMPT = new Set(["/api/uploads"]);

/** token 豁免面（brief T1 定档）：/ （页面首开——token 在 query 里随 URL 带来）与 /assets/*（静态树）。 */
function tokenExempt(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/assets/");
}

/** 请求处理管线：三道中间件 + 分发 + per-request catch（⑩：单请求失败 400，进程与 server 存活）。 */
function makeRequestHandler(token: string): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        // 中间件 1：Host 白名单（先于 token——rebinding 场景下对端无 token 也须先被拒）
        if (!hostAllowed(req)) {
          sendErr(res, 403, "host not allowed");
          return;
        }
        const url = req.url ?? "";
        const qi = url.indexOf("?");
        const pathname = qi >= 0 ? url.slice(0, qi) : url;
        // 中间件 2：token（豁免面外全量校验——API/SSE 一律带）
        if (!tokenExempt(pathname) && !checkToken(req, token)) {
          sendErr(res, 401, "unauthorized");
          return;
        }
        // 中间件 3：JSON-only POST 护栏（写方法要求 application/json——SSE/GET 不受限；二进制写端点
        // 豁免面见 JSON_GUARD_EXEMPT）
        if (WRITE_METHODS.has(req.method ?? "") && !JSON_GUARD_EXEMPT.has(pathname) && !(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          sendErr(res, 415, "content-type must be application/json");
          return;
        }
        // 分发（首个匹配即停；无匹配 → 404）。路径段先统一 %-decode：坏 escape 在此抛错 →
        // per-request catch 转 400（⑩）；解码后匹配也让 /api/%68ealth 一类形态按语义路由
        const pathSegs = pathname.split("/").filter((s) => s !== "").map(decodeURIComponent);
        for (const entry of routes.values()) {
          if (entry.method !== (req.method ?? "")) continue;
          const params = matchPath(entry.segments, pathSegs);
          if (params === undefined) continue;
          await entry.handler(req, res, params);
          return;
        }
        sendErr(res, 404, "not found");
      } catch {
        // 兜底：坏 %-escape 解码 / handler 抛错 / 已破坏的请求 —— 400 且进程存活
        if (!res.headersSent) sendErr(res, 400, "bad request");
        else res.destroy();
      }
    })();
  };
}

// 内建路由：GET /api/health（§3：{ok:true, version, pid}——实例活探测（G12）与存活判定同源）
registerRoute("GET", "/api/health", (_req, res) => {
  sendOk(res, 200, { version: OROSUS_VERSION, pid: process.pid });
});

// ---------- 静态资产（T15：原型裁剪的零构建前端 + vendor UMD） ----------

/** assets 树根（server.ts 同目录 assets/——index.html/style.css/api.js/app.js，T16/T17 续 render.js/ui.js）。 */
const ASSETS_ROOT = join(fileURLToPath(new URL("./", import.meta.url)), "assets");

/** CSP（§8-4 验收项）：脚本/样式/连接全部同源，零内联（index.html 全外引）；img-src 追加 data:
 *  仅因原型 style.css 的下拉箭头用 data: SVG 背景（mp-ctl .fsel——T17 设置页消费面）。 */
const CSP = "default-src 'self'; img-src 'self' data:";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** ETag 缓存（内容 sha1 前 32 位强校验；mtime 变更才重算——assets 均小文件）。 */
const etagCache = new Map<string, { mtime: number; etag: string }>();

function etagOf(abs: string, stat: Stats): string {
  const c = etagCache.get(abs);
  if (c !== undefined && c.mtime === stat.mtimeMs) return c.etag;
  const etag = `"${createHash("sha1").update(readFileSync(abs)).digest("hex").slice(0, 32)}"`;
  etagCache.set(abs, { mtime: stat.mtimeMs, etag });
  return etag;
}

/** 静态响应（§5 律三）：index.html 恒 no-cache（入口页必取最新——T16/T17 迭代期不落旧壳）；
 *  其余可缓存（revalidate 形 max-age=0 + ETag——二次加载 304，字节零往返）。CSP + nosniff 全量带。 */
function serveStatic(req: IncomingMessage, res: ServerResponse, abs: string, alwaysFresh: boolean): void {
  let stat: Stats;
  try {
    stat = statSync(abs);
  } catch {
    sendErr(res, 404, "not found");
    return;
  }
  if (!stat.isFile()) {
    sendErr(res, 404, "not found");
    return;
  }
  const etag = etagOf(abs, stat);
  const headers: Record<string, string> = {
    "content-type": MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
    "cache-control": alwaysFresh ? "no-cache" : "public, max-age=0, must-revalidate",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    etag,
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(readFileSync(abs));
}

/** /assets/vendor/* 供给面：node_modules UMD 定位（marked/dompurify——流区 markdown 渲染 T16 消费）。
 *  marked 的 lib/marked.umd.js 不在包 exports 表——经 package.json 定位后拼 lib 路径；dompurify 的
 *  dist/purify.js 在 exports 内直取。resolve 失败（依赖缺席）→ 404 不炸。 */
const vendorRequire = createRequire(import.meta.url);
function vendorFile(name: string): string | undefined {
  try {
    if (name === "marked.js") return join(dirname(vendorRequire.resolve("marked/package.json")), "lib", "marked.umd.js");
    if (name === "purify.js") return vendorRequire.resolve("dompurify/dist/purify.js");
  } catch {
    return undefined;
  }
  return undefined;
}

registerRoute("GET", "/", (req, res) => {
  serveStatic(req, res, join(ASSETS_ROOT, "index.html"), true);
});

registerRoute("GET", "/assets/*", (req, res, params) => {
  const rel = params["*"] ?? "";
  if (rel === "") {
    sendErr(res, 404, "not found");
    return;
  }
  if (rel.startsWith("vendor/")) {
    const name = rel.slice("vendor/".length);
    const abs = name !== "" && !name.includes("/") ? vendorFile(name) : undefined;
    if (abs === undefined) {
      sendErr(res, 404, "not found");
      return;
    }
    serveStatic(req, res, abs, false);
    return;
  }
  // 穿越防护：resolve 后以 path.sep 前缀判归属（Windows 上 resolve 产反斜杠——拼 '/' 后缀会漏判，
  // dsh 实测坑）；根自身不放行。已 %-decode 的 ".." 段被 resolve 折叠后由前缀检查兜住。
  const abs = resolvePath(ASSETS_ROOT, rel);
  if (!abs.startsWith(ASSETS_ROOT + sep)) {
    sendErr(res, 404, "not found");
    return;
  }
  serveStatic(req, res, abs, false);
});

// ---------- 端口探测与监听 ----------

/** listen 探测单个端口（绑 127.0.0.1——与真 server 同接口，防「探测 0.0.0.0 空但 127 被占」误判）；
 *  成功即关并返回该端口；占用/失败 reject。 */
function probePort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => {
      const bound = (probe.address() as { port: number }).port;
      probe.close(() => resolve(bound));
    });
  });
}

/** 空闲端口探测（G13）：preferred 缺省 5317（原型口径）；被占则换随机（listen 0 让 OS 分配），
 *  ≤10 次尝试后仍失败才抛。注意探测与真 listen 之间存在竞态窗——由 startWebServer 的
 *  EADDRINUSE 事件兜底重试收口。 */
export async function pickFreePort(preferred?: number): Promise<number> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < PORT_RETRIES; attempt++) {
    try {
      return await probePort(attempt === 0 ? (preferred ?? DEFAULT_WEB_PORT) : 0);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("pickFreePort: no free port");
}

function listenServer(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // error 监听留挂（不 removeListener）：listen 期错误走 reject；listen 成功后的意外 error
    // 由同一监吃下（空转 reject）——不让 server 级 error 事件裸炸长驻进程
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

// ---------- SIGINT 清退序（骨架面） ----------

const shutdownListeners: Array<(reason: string) => void> = [];

/** 清退监听注册位（brief「后续任务消费」行——T2 填充：SSE shutdown 帧广播 + HostPool.closeAll）。
 *  返回反注册函数（T3：mod.ts 在 server close 时摘除——进程内多次起停〔测试〕不堆积监听、闭包不持旧池）。 */
export function onShutdown(fn: (reason: string) => void): () => void {
  shutdownListeners.push(fn);
  return () => {
    const i = shutdownListeners.indexOf(fn);
    if (i >= 0) shutdownListeners.splice(i, 1);
  };
}

/** 广播清退（T2 的 SIGINT 清退序在 G15 调用）：逐监听调用，单监听抛错不拦其余与关停。 */
export function broadcastShutdown(reason: string): void {
  for (const fn of shutdownListeners) {
    try {
      fn(reason);
    } catch { /* 单监听失败不拦清退 */ }
  }
}

let armed: { server: Server; home: string } | undefined;

/** 起 server 时武装清退：SIGINT 触发清退序；server 关停（无论路径）后摘 SIGINT 挂钩。 */
function armShutdown(server: Server, home: string): void {
  armed = { server, home };
  const onSigint = () => {
    shutdownWebServer("sigint");
  };
  process.once("SIGINT", onSigint);
  server.once("close", () => {
    process.removeListener("SIGINT", onSigint);
    if (armed?.server === server) armed = undefined;
  });
}

/** SSE shutdown 帧刷出窗（T2）：broadcast 同步写出帧 + end 后，socket 缓冲的落地在后续 tick——
 *  紧跟的 closeAllConnections 会撕掉未刷帧（G15「已正常关闭」变体文案依赖帧到达浏览器）。让出短窗
 *  再拆连接；SIGINT 手感无可感知差异（50ms）。自创值登记同源口径。 */
const CONNECTION_TEARDOWN_MS = 50;

/** 触发清退序（SIGINT 钩子与测试同口；幂等）：广播 shutdown 监听（T2 的 SSE 帧 + pool.closeAll）
 *  → 删实例文件 → 关 server（closeAllConnections 让出 SSE 帧刷出窗后执行，保证长驻连接不拖死
 *  关停——SSE 时代同口）。 */
export function shutdownWebServer(reason: string): void {
  if (armed === undefined) return;
  const { server, home } = armed;
  armed = undefined;
  broadcastShutdown(reason);
  removeInstance(home);
  server.close(() => undefined);
  setTimeout(() => server.closeAllConnections?.(), CONNECTION_TEARDOWN_MS).unref?.();
}

// ---------- 起服 ----------

/** 起服（brief T1 定档签名；home 为实例文件根——缺省 orosusHome()，测试注入隔离）。
 *  token 决策（G15）：实例文件已存合法 token 则沿用（接管/重启——旧标签页重试恢复前提），否则新铸；
 *  实例文件回写由调用方（mod.ts）在拿到实际端口后完成。cwd 为 T2 HostPool 的项目根预留。
 *  返回后 server 已在监听（127.0.0.1:port）且 SIGINT 清退已武装。 */
export async function startWebServer(opts: { port?: number; cwd: string; home?: string }): Promise<{ server: Server; port: number; token: string }> {
  const home = opts.home ?? orosusHome();
  const token = reuseOrMintToken(home);
  const server = createHttpServer(makeRequestHandler(token));
  let port = await pickFreePort(opts.port);
  for (let attempt = 0; ; attempt++) {
    try {
      await listenServer(server, port);
      break;
    } catch (err) {
      // EADDRINUSE 兜底重试（探测与真 listen 的竞态窗；换随机端口 ≤10 次）
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && attempt < PORT_RETRIES - 1) {
        port = await pickFreePort(0);
        continue;
      }
      throw err;
    }
  }
  armShutdown(server, home);
  return { server, port, token };
}
