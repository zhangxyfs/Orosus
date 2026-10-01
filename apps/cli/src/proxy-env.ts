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
