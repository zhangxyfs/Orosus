/** `orosus web` 子命令（web 批 T1 对外口——main.ts 拦截块接线）：
 *  引导门（G16——needsProviderSetup 同源判定，未引导指路终端退出 1）→ 双开复用（G12——活实例打印/
 *  打开既有 URL 退出 0，不起第二个 server）→ 起服（端口换号 G13；token 沿用 G15）→ URL 横幅
 *  （G11 三行式：地址 / 手动指路 / 终端存亡提示）+ 自动开浏览器（失败不炸——横幅兜底）。
 *  runWebSubcommand 长驻：直到 server 关停（SIGINT 清退序——server.ts）才返回。
 *  T2 起：起服后建 HostPool（webHostPool() 访问位）+ onShutdown 清退接线（SSE shutdown 帧广播 +
 *  pool.closeAll——G15 供给侧）；handover（/web 形态切换——T2 接线）作为首个托管会话 + 当前游标。 */
import { join } from "node:path";
import { orosusHome } from "@orosus/contracts/home";
import { loadConfig, locateSessionFile } from "@orosus/core";
import { needsProviderSetup, readConfigModel } from "../onboarding.ts";
import { t } from "../i18n/app.ts";
import { findLiveInstance, writeInstance } from "./instance.ts";
import { openBrowser } from "./open-browser.ts";
import { onShutdown, startWebServer } from "./server.ts";
import { HostPool } from "./hostpool.ts";
import { webCommandUiFactory } from "./bridge-ui.ts";
import { broadcastShutdownFrames } from "./sse.ts";
import "./api-session.ts"; // T3 会话组端点注册（GET events/stream——模块加载期进路由表，readiness 序）
import "./api-files.ts"; // T4 文件面端点注册（uploads/media/at——readiness 序同上；api-session 经它解析 imageIds）
import "./api-panel.ts"; // T7 面板数据端点注册（tasks 名册/子代理审批/transcript 回放——readiness 序同上）
import "./api-model.ts"; // T8 模型/思考档位/权限/命令表端点注册（readiness 序同上）

export function isWebSubcommand(argv: string[]): boolean {
  return argv[0] === "web";
}

export interface WebFlags {
  port?: number;
  noOpen: boolean;
}

const WEB_USAGE = (): string => t("web.usage");

/** flag 解析（prune.ts 同款形态）：--port N | --port=N（1-65535）、--no-open；未知参数报用法。 */
export function parseWebFlags(rest: string[]): WebFlags {
  const opts: WebFlags = { noOpen: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const portOf = (raw: string | undefined): number => {
      const n = raw !== undefined ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${t("web.badPort", { v: String(raw) })}\n${WEB_USAGE()}`);
      return n;
    };
    if (a === "--no-open") opts.noOpen = true;
    else if (a === "--port") opts.port = portOf(rest[++i]);
    else if (a.startsWith("--port=")) opts.port = portOf(a.slice("--port=".length));
    else throw new Error(`${t("args.unknown", { v: a })}\n${WEB_USAGE()}`);
  }
  return opts;
}

/** 引导门判定（G16）：needsProviderSetup（onboarding.ts——startup.ts 向导门同源纯函数）。
 *  子命令语境无 harness 图：providers 面取 config 的 [provider-custom].providers 槽名
 *  （provider-custom 模块把每槽贡献为 provider: 服务——两口径同名）。config.toml 不存在或
 *  provider 未配置 → true（禁用 web，指路终端完成首启引导）。 */
function webNeedsSetup(userFile: string, projectFile: string): boolean {
  let providers: string[] = [];
  try {
    const table = loadConfig({ userFile, projectFile }).sections.get("provider-custom")?.providers;
    if (typeof table === "object" && table !== null && !Array.isArray(table)) {
      providers = Object.keys(table as Record<string, unknown>);
    }
  } catch { /* 坏配置按未配置引导（loadConfig 自身降级不抛——双保险） */ }
  return needsProviderSetup({ model: readConfigModel(userFile, projectFile), providers });
}

/** 浏览器入口 URL：token 随 query 带来（/ 豁免 token；页面内 api.js 收纳 sessionStorage 后走头）。 */
function webUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${token}`;
}

/** URL 横幅（G11 三行式：完整地址 / 手动指路 / 终端存亡提示；端口被换时加换用提示行——G13）。 */
export function printUrlBanner(io: { out(line: string): void }, url: string, portSwitched?: { from: number }): void {
  io.out(t("web.banner.address", { url }));
  if (portSwitched !== undefined) {
    io.out(t("web.banner.portSwitched", { from: portSwitched.from, to: Number(new URL(url).port) }));
  }
  io.out(t("web.banner.manualOpen"));
  io.out(t("web.banner.keepTerminal"));
}

/** io 注入面：out 输出行收集；env 环境表（OROSUS_HOME 重定向——测试隔离）；cwd 项目根
 *  （缺省 process.cwd()——测试隔离项目层 config 用）。 */
export interface WebIo {
  out(line: string): void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

// ---------- HostPool 归属（T2）----------
// server 生命周期内单池（runWebSubcommand 每次起服重建）；T3+ 的 api-* 路由与测试经 webHostPool()
// 访问。复用/引导门等早退路径不建池（webHostPool() = undefined）。
let pool: HostPool | undefined;

/** 当前 server 的 HostPool（无活 server = undefined——T3+ 路由消费位）。 */
export function webHostPool(): HostPool | undefined {
  return pool;
}

export async function runWebSubcommand(
  argv: string[],
  io: WebIo,
  handover?: { resumeSid: string; cwd: string },
): Promise<number> {
  const home = orosusHome(io.env ?? process.env);
  const cwd = handover?.cwd ?? io.cwd ?? process.cwd();
  const flags = parseWebFlags(argv.slice(1));
  pool = undefined; // 早退路径（门/复用）不建池——webHostPool() 恒反映当前活 server

  // 引导门（G16）：首装未完成引导 → 指路终端，退出 1，不起 server
  const userFile = join(home, "config.toml");
  const projectFile = join(cwd, ".orosus", "config.toml");
  if (webNeedsSetup(userFile, projectFile)) {
    io.out(t("web.gate.needSetup"));
    return 1;
  }

  // 双开复用（G12）：活实例（pid + /api/health 双确认）→ 打印/打开既有 URL 退出 0；
  // handover 场景同口径（G14：已有活实例时不起新 server，打印既有 URL——T2 接线侧同判）
  const live = await findLiveInstance(home);
  if (live !== undefined) {
    const url = webUrl(live.port, live.token);
    printUrlBanner(io, url);
    if (!flags.noOpen) void openBrowser(url);
    return 0;
  }

  // 起服（token 沿用决策在 startWebServer 内——G15；端口换号 G13）
  const { server, port, token } = await startWebServer({ ...(flags.port !== undefined ? { port: flags.port } : {}), cwd, home });
  writeInstance(home, { v: 1, pid: process.pid, port, startedAt: Date.now(), token });

  // HostPool（T2）：池生命周期 = server 生命周期；SIGINT 清退序（G15 供给侧——填 T1 onShutdown
  // 注册位）= shutdown 帧广播（T3 sse.ts 全会话客户端注册表）→ pool.closeAll（实例文件清理在 T1
  // shutdownWebServer 序内）。commandUi 注入 T5 交互桥工厂（逐会话 WebCommandUi——broadcast 绑
  // 该会话 SSE 扇出、pending 重放源注册、close fail-closed 钩子，见 bridge-ui.ts）
  const p = new HostPool({ home, commandUi: webCommandUiFactory });
  pool = p;
  const off = onShutdown((reason) => {
    broadcastShutdownFrames(reason);
    void p.closeAll();
    pool = undefined; // 契约：清退后 webHostPool() 恒 undefined（T2 审查指针②——closeAll 即失效）
  });
  server.once("close", off); // 进程内多次起停（测试）不堆积 onShutdown 监听（T2 审查指针③）

  // handover 接线（T1 参数在此生效——G14 /web 形态切换）：server 起后作为首个托管会话 + 当前会话
  // 游标（浏览器 bootstrap 默认打开它——/api/bootstrap currentSid，T9 消费）；sid 已被退出序列
  // purge（空会话）→ 跳过交接 server 空启（main.ts 侧 locate 失败不传是第一道，此处同判双保险）
  if (handover !== undefined && locateSessionFile(join(home, "sessions"), handover.resumeSid) !== undefined) {
    try {
      const hs = await p.create({ cwd: handover.cwd, resumeSid: handover.resumeSid });
      p.switchCurrent(hs.sid);
    } catch (err) {
      io.out(t("web.handover.fail", { err: err instanceof Error ? err.message : String(err) })); // GC6：server 侧新用户可见文案走 t()
    }
  }

  // readiness 纪律：URL 横幅与开浏览器必须在全部路由注册完成之后（防「浏览器先到 404」竞态）——
  // T1 无 api-* 附加路由（/api/health 内建）；T2+ 的路由注册发生在 startWebServer 之前、此处之后不变。
  const url = webUrl(port, token);
  printUrlBanner(io, url, flags.port !== undefined && port !== flags.port ? { from: flags.port } : undefined);
  if (!flags.noOpen) void openBrowser(url);

  // 长驻直到 server 关停（SIGINT 清退序 → close 事件）
  await new Promise<void>((resolve) => server.once("close", resolve));
  return 0;
}
