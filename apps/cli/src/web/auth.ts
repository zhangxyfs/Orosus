/** web 骨架鉴权（web 批 T1，GC2 零新网络依赖）：token 铸/校/沿用 + Host 头白名单。
 *  token 口径（§2 auth.ts 行）：头 X-Orosus-Token 或 ?token=（浏览器首开 URL 带来——api.js T15
 *  收纳 sessionStorage 后统一走头）；逐实例沿用不重铸（G15 恢复链前提：同端口重启后旧标签页
 *  「重试连接」直接成功；端口换号时旧标签源失效，弹窗指路新网址——T15 侧兜底）。
 *  Host 白名单（GC4 防 DNS rebinding）：127.0.0.1 | localhost | [::1]，两侧 lowercase 后比对，
 *  带端口的 Host 形态先剥端口再比。 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** token 传输头（§3 协议面约定；?token= 为浏览器首开同源形态）。 */
export const TOKEN_HEADER = "x-orosus-token";

/** 新铸 token：randomBytes(32).hex（64 位小写十六进制）。 */
export function mintToken(): string {
  return randomBytes(32).toString("hex");
}

/** 「合法可沿用」判据：mintToken 产物形状（64 位 hex）——实例文件里存了畸形值/旧版本值则不沿用。 */
export function isValidTokenShape(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

/** 从请求提取 token（头 X-Orosus-Token 优先，?token= 兜底；无则空串）。
 *  query 侧仅手解析目标键——不 URL.parse 整串（坏 %-escape 由调用侧 per-request catch 转 400）。 */
export function tokenFromRequest(req: IncomingMessage): string {
  const header = req.headers[TOKEN_HEADER];
  if (typeof header === "string" && header !== "") return header;
  const url = req.url ?? "";
  const qi = url.indexOf("?");
  if (qi < 0) return "";
  for (const pair of url.slice(qi + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq >= 0 && pair.slice(0, eq) === "token") return pair.slice(eq + 1);
  }
  return "";
}

/** token 校验（API/SSE 全量——GC4；/ 与 /assets/* 豁免由 server.ts 中间件序决定）。 */
export function checkToken(req: IncomingMessage, token: string): boolean {
  const got = tokenFromRequest(req);
  return got !== "" && got === token;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Host 头白名单（GC4）：本机三形态（剥端口后比对；[::1]:5317 的 IPv6 带端口形态先截到 "]"）。
 *  无 Host 头（HTTP/1.0 形态）不放行——现代浏览器与 fetch 恒带。 */
export function hostAllowed(req: IncomingMessage): boolean {
  const raw = (req.headers.host ?? "").trim().toLowerCase();
  let name = raw;
  if (raw.startsWith("[")) name = raw.slice(0, raw.indexOf("]") + 1);
  else if (raw.includes(":")) name = raw.slice(0, raw.lastIndexOf(":"));
  return LOCAL_HOSTS.has(name);
}
