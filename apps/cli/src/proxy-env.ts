import { networkInterfaces } from "node:os";

/** 批 D（2026-10-01 拍板 A+B）：代理环境自动接线——检测到代理环境变量且 Node ≥24 时自动设
 *  NODE_USE_ENV_PROXY=1（用户未显式设才设——显式 =0 是用户明示直连，尊重）。Node 内置 fetch（undici）
 *  不读代理环境变量也不走系统代理；fake-ip 型代理（Clash 类）下 DNS 把公网域名解析成 fc00::/7 假 IP，
 *  tool-web 抓取全被 SSRF 防线误拦（2026-10-01 doc-review 任务 14 次「解析到私网地址」实锤）。
 *  调用方（main.ts import 区后第一段）必须赶在任何 fetch 发生前——undici 全局分发器首用时读取。
 *  副作用如实披露：整个进程的一切 fetch（含模型 API 流量）此后都经代理。nodeMajor 为测试注入位。 */
export function maybeEnableEnvProxy(
  env: NodeJS.ProcessEnv = process.env,
  nodeMajor: number = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10),
): boolean {
  const proxyEnv = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (proxyEnv !== undefined && env.NODE_USE_ENV_PROXY === undefined && nodeMajor >= 24) {
    env.NODE_USE_ENV_PROXY = "1";
    return true;
  }
  return false;
}

/** 环境变量里的代理地址（展示层同源取值——与 maybeEnableEnvProxy 同一优先级链）。 */
export const envProxyUrl = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;

/** host 提取（显示用）：带 scheme 的 URL 取 host，裸 host:port 原样，解析失败也原样（kvRow 行内截断兜底）。 */
export const proxyHostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  }
};

/** Windows 系统代理读取（2026-10-01 走查实锤「开了代理却显直连」）：Clash/v2rayN 类「系统代理」写的是
 *  注册表 HKCU\...\Internet Settings（ProxyEnable/ProxyServer），不设环境变量——只查 env 会漏报。
 *  reg query 一次约 20ms，宿主启动后异步取一次缓存（展示专用，不参与流量接线——undici 不读系统代理，
 *  系统代理态下本进程流量仍直连，文案须如实）。PAC（AutoConfigURL）不查：脚本代理无法静态取址。
 *  exec/platform 为测试注入位；非 win32 / 未启用 / 读失败 / 解析不出 → undefined。 */
export async function readWindowsSystemProxy(
  opts: { platform?: NodeJS.Platform; query?: (name: "ProxyEnable" | "ProxyServer") => Promise<string> } = {},
): Promise<string | undefined> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const reg = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const fallbackQuery: NonNullable<typeof opts.query> = async (name) => {
    const { exec } = await import("node:child_process");
    return await new Promise<string>((resolve, reject) => {
      exec(`reg query "${reg}" /v ${name}`, { windowsHide: true }, (err, stdout) => (err === null ? resolve(stdout) : reject(err)));
    });
  };
  const q = opts.query ?? fallbackQuery;
  try {
    const enableOut = await q("ProxyEnable");
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enableOut)) return undefined;
    const serverOut = await q("ProxyServer");
    const m = serverOut.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
    if (m === null) return undefined;
    const raw = m[1]!;
    if (raw === "") return undefined;
    // per-protocol 形态 "http=h1:p1;https=h2:p2"：优先 https 段，退 http 段；整体形（"127.0.0.1:7890"）原样
    if (raw.includes("=")) {
      const parts = raw.split(";").map((p) => p.trim());
      const https = parts.find((p) => p.toLowerCase().startsWith("https="));
      const http = parts.find((p) => p.toLowerCase().startsWith("http="));
      const chosen = https ?? http;
      if (chosen === undefined) return undefined;
      return proxyHostOf(chosen.slice(chosen.indexOf("=") + 1));
    }
    return proxyHostOf(raw);
  } catch {
    return undefined;
  }
}

/** 代理态显示文案（「网络 · MCP」卡 KV 行数据源）：env 代理 = 流量真走（批 D 已接线）；
 *  TUN 网卡 = 透明路由，全流量（含本进程 fetch）被虚拟网卡接管——流量也真走；
 *  仅系统代理 = 开着但本进程 fetch 不认它（undici 不读 WinINET）——如实标注，免「开了代理为何还慢」困惑；
 *  都无 = 直连。优先级 env > TUN > 系统代理 > 直连。 */
export function proxyDisplayText(envUrl: string | undefined, systemProxy: string | undefined, tunAdapter: string | undefined): string {
  if (envUrl !== undefined) return `已启用 · ${proxyHostOf(envUrl)}`;
  if (tunAdapter !== undefined) return `TUN · ${tunAdapter}（透明路由）`;
  if (systemProxy !== undefined) return `系统代理 · ${systemProxy}（本进程未走）`;
  return "直连 · 未检测到代理";
}

/** TUN 网卡探测（2026-10-01 走查实锤三连漏的第三源）：Clash Verge/Meta、v2rayN 等的 TUN 模式走虚拟网卡
 *  透明路由——系统代理开关关着（ProxyEnable=0）、环境变量不设，env/注册表双源都查不到，但全流量
 *  （含本进程 fetch）实际都在走。判据（win32 限定）：网卡名命中代理工具关键词，或网卡持 fake-ip 基准
 *  网段 198.18.x.x（RFC 2544 benchmark 段——正常组网不会用；实测 Mihomo → 198.18.0.1）。
 *  ZeroTier/WLAN 等组网网卡不命中。纯 os.networkInterfaces() 内存调用零开销。返回命中的网卡名。 */
export function detectTunProxy(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return undefined;
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (/mihomo|clash|wintun|sing-?box|v2ray|tun/i.test(name)) return name;
    if ((addrs ?? []).some((a) => a.family === "IPv4" && a.address.startsWith("198.18."))) return name;
  }
  return undefined;
}
