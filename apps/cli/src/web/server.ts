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

const sendOk = (res: ServerResponse, status: number, extra: Record<string, unknown> = {}): void =>
  sendJson(res, status, { ok: true, ...extra });
const sendErr = (res: ServerResponse, status: number, error: string): void =>
  sendJson(res, status, { ok: false, error });

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
        // 中间件 3：JSON-only POST 护栏（写方法要求 application/json——SSE/GET 不受限）
        if (WRITE_METHODS.has(req.method ?? "") && !(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
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

/** 清退监听注册位（brief「后续任务消费」行——T2 填充：SSE shutdown 帧广播 + HostPool.closeAll）。 */
export function onShutdown(fn: (reason: string) => void): void {
  shutdownListeners.push(fn);
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

/** 触发清退序（SIGINT 钩子与测试同口；幂等）：广播 shutdown 监听（T2 的 SSE 帧 + pool.closeAll）
 *  → 删实例文件 → 关 server（closeAllConnections 保证长驻连接不拖死关停——SSE 时代同口）。 */
export function shutdownWebServer(reason: string): void {
  if (armed === undefined) return;
  const { server, home } = armed;
  armed = undefined;
  broadcastShutdown(reason);
  removeInstance(home);
  server.close(() => undefined);
  server.closeAllConnections?.();
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
