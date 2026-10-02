import { createInterface } from "node:readline/promises";
import { orosusHome } from "@orosus/contracts/home";
import { OROSUS_VERSION } from "@orosus/contracts/version";
import { dirname, join } from "node:path";
import { createHarness, discoverModules, encodeCwd, isEmptySessionHead, locateSessionFile, loadSecretsEnv, purgeSessionDir, readSessionHead, sweepEmptySessions } from "@orosus/core";
import type { Harness, SessionEvent } from "@orosus/core";
import type { HostInfo, SettingsService, SubagentRosterEntry } from "@orosus/contracts/module";
import { BUILTIN_MODULES } from "./builtins.ts";
import { compactionSummaryView } from "./compaction-view.ts";
import { createCliUi } from "./uiface.ts";
import { computeModulePreset, planModulePreset, presetBaseline } from "./modpreset.ts";
import { confirmDialogWidgets, type PendingModuleInfo } from "./module-confirm.ts";
import { trustModule } from "@orosus/core";
import { createSilenceableOutput } from "./menu.ts";
import { createModal, watchEsc, type KeyEvent } from "./keys.ts";
import { pick } from "./picker.ts";
import { formatSessions, harnessOptionsFor, listSessions, pickSessionNumber, readTitle, relativeTime, resolveTarget, sessionCommand, setTitle } from "./sessions.ts";
import { parseArgs, type CliArgs } from "./args.ts";
import { tuiSidebarPersist, tuiSidebarRead } from "./tui-config.ts";
import { isProviderSubcommand, runProviderSubcommand } from "./provider-cmd.ts";
import { isHomeSubcommand, runHomeSubcommand } from "./home-cmd.ts";
import { execFileSync } from "node:child_process";
import { isModuleSubcommand, runModuleSubcommand } from "./module-cmd.ts";
import { banner } from "./banner.ts";
import { needsProviderSetup, } from "./onboarding.ts";
import { realReadModel, startupGate } from "./startup.ts";
import { isSessionsSubcommand, runPruneSubcommand } from "./prune.ts";
import { renderHistoryLines, historyPage, attachRender as attachRenderTo, TOOL_MERGE, registerToolLabels } from "./render.ts";
import { ringTurnBell } from "./bell.ts";
import { resolveBellMode, playTurnChime } from "./chime.ts";
import { createStreamView, type StreamChunk } from "./tui/streamview.ts";
import { DocModel } from "./tui/docmodel.ts";
import { FullApp, type PanelData, type PanelNetwork, type SlashItem, msText } from "./tui/fullapp.ts";
import * as theme from "./theme.ts";

import { lookupModelVision, readCatalogDiskCache, defaultCatalogCacheFile, defaultMenuDeps, snapshotProviderView, catalogPreferredListModels, diskFirstCatalogLoader, openaiListModels, anthropicListModels, seedBundledCatalog, catalogProviderView, type ProviderEntry } from "@orosus/provider-custom";
import { persistToolWebSearch, upsertSecret } from "@orosus/tool-web";
import { persistVisionModel, readVisionModel } from "@orosus/tool-media";
import { killAllBackgroundJobs } from "@orosus/tool-shell";
import type { OnboardingDeps } from "./tui/onboarding.ts";
import { readFileSync, existsSync } from "node:fs";
import { pasteImage, imagesFor, extractImageRefs, PASTE_EMPTY, imageChipLabel, readClipboardText } from "./paste.ts";
import { attachAltVPaste } from "./altpaste.ts";
import { runPrint } from "./print.ts";
import { resolveAtRefs } from "./atfile.ts";
import { commandCompleter, HELP_TEXT } from "./help.ts";
import { runSubagentApprovalSetting, runSubagentMaxTurnsSetting, runSubagentModelSetting } from "./subagent-settings.ts";
import { readSkillDisabled, seedFactorySkills, skillDetailText, skillListRow, toggleSkillDisabled, type SkillCatalogRow } from "./skill-settings.ts";
import { agentEventsFromFile, emptyTasksRow, loadHistoricalSubagents, renderAgentView, sortNewestFirst, subagentUnloadBlock, taskIdOfRow, tasksListRows } from "./tasks-cmd.ts";
import { backgroundRunningCount } from "./subagent-status.ts";
import { isCompactCommand, withCompactHint } from "./compact-hint.ts";
import { setModuleEnabledInConfig } from "./module-toggle.ts";
import { migrateModulesSections } from "./config-migrate.ts";
import { loadConfig } from "@orosus/core"; // 读配置单一事实源(m4-8 T2.5；路由/窗口兜底链随族迁 config-face.ts)
import { configFace, configFaceTui, configFaceTuiBell, configFaceTuiLatex, modelSlotList, moduleConfigFileFor, subagentConfigFile } from "./config-face.ts";
import { ctxUsageText, diskUsageText, lastRequestMsOf, lastUsageOf, runtimeStatusText, shortenPath, tokenUsageText } from "./usage-text.ts";
import { toggleResultText } from "./module-toggle-result.ts";
import { runMcpCommand, defaultMcpCmdDeps, type McpCmdDeps } from "./mcp-cmd.ts";
import { mcpListRow, mcpDetailText } from "./mcp-settings.ts";
import { openMcpAddWindow } from "./mcp-add-window.ts";
import type { McpCatalogRow } from "@orosus/mcp";
import { computeMountClosure, computeUnmountClosure } from "./module-deps.ts";
import { formatStartupError } from "./startup-error.ts";
import { readDiagnostics, readDiagRawLines, renderDetail, moduleOf } from "./module-diagnostics.ts";
import { panelTasksFromEvent } from "./todo-panel.ts";
import { resolveTuiMode, resolveLatexFlag } from "./tuicfg.ts";
import { parse as tomlParse } from "smol-toml";
import { setLatexEnabled } from "./md/latex.ts";
import { maybeEnableEnvProxy, envProxyUrl, proxyDisplayText, readWindowsSystemProxy, detectTunProxy } from "./proxy-env.ts";

// 批 D（2026-10-01 拍板 A+B）：代理环境自动接线——机理与副作用披露见 proxy-env.ts；
// 必须赶在任何 fetch 发生前（undici 全局分发器首用时读取 NODE_USE_ENV_PROXY）
maybeEnableEnvProxy();

/** 「网络 · MCP」卡代理态（2026-10-01 走查修准「开了代理却显直连」）：三源检测——
 *  ① 环境变量（流量真走——批 D 已接线 NODE_USE_ENV_PROXY）；② TUN 网卡（Clash Meta/v2rayN 的 TUN 模式
 *  透明路由——系统代理关着、env 不设，双源都漏，但全流量实际在走；实测本机 Mihomo→198.18.0.1）；
 *  ③ Windows 系统代理（注册表 ProxyEnable——Clash 类「系统代理」档写的这里，本进程 fetch 不认它）。
 *  ②纯内存调用；③ reg query 启动后异步取一次（~20ms）。展示专用不参与流量接线；启动期定形语义
 *  （会话中切换代理模式不追帧，下次启动自会反映）。 */
const systemProxyOnce = readWindowsSystemProxy().catch(() => undefined);
const proxyStateText = async (): Promise<string> => proxyDisplayText(envProxyUrl(), await systemProxyOnce, detectTunProxy());

/** CM-06②（2026-09-28 code review）：console 输出在管道/重定向下是异步写——`process.exit` 立即退可能
 *  赶在缓冲 flush 之前截断尾部输出（provider list 全量目录恰是大输出；--print 路径的 exitCode 自然退出
 *  是正解，子命令拦截面之后还有整段 REPL 装配、不能自然流过）。先排空 stdout/stderr 再退。
 *  kimi-code 同款教训（其 main.ts 注释原话：an immediate process.exit could terminate before buffered
 *  output is flushed when the command is piped——headless 一律 exitCode + 排空）。 */
const exitCli = async (code: number): Promise<never> => {
  process.exitCode = code;
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
    new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
  ]);
  process.exit(code);
};

// 子命令拦截（M2 接口总表：互斥于 flag 之外先解析）——M2 补账：T8/T13 处理器此前从未接线，
// `orosus provider ...` / `orosus module ...` 会被 flag 解析器当未知参数拒收
{
  const argv = process.argv.slice(2);
  const homeDir = orosusHome();
  try {
    if (isProviderSubcommand(argv)) {
      // CM-06①：处理器抛错（坏 TOML parse/IO 拒绝）此前穿透模块顶层 = Node 裸堆栈——整块兜底转人话 + 退出码 1
      await exitCli(await runProviderSubcommand(argv, {
        configPath: join(homeDir, "config.toml"),
        secretsPath: join(homeDir, "secrets.env"),
        env: process.env,
        out: (l) => console.log(l),
      }));
    }
    // `orosus sessions prune`（M4-1 T2/D47）：显式清理——缺省 dry-run、--apply 才删、不做启动自动 GC
    if (isSessionsSubcommand(argv)) {
      await exitCli(await runPruneSubcommand(argv, { out: (l) => console.log(l) }));
    }
    // `orosus home path|migrate`（M4-2.5 T6）：OROSUS_HOME 单一解析点 + 一键迁移（dry-run/apply、留证不删）
    if (isHomeSubcommand(argv)) {
      await exitCli(await runHomeSubcommand(argv, {
        sourceHome: orosusHome(),
        env: process.env,
        out: (l) => console.log(l),
        ...(process.platform === "win32" ? { setEnv: (v) => { execFileSync("setx", ["OROSUS_HOME", v], { stdio: "ignore" }); } } : {}),
      }));
    }
    if (isModuleSubcommand(argv)) {
      const discovered = await discoverModules({
        userDir: join(homeDir, "modules"),
        projectDir: join(process.cwd(), ".orosus", "modules"),
        userFile: join(homeDir, "config.toml"),
        sink: { write: () => {}, flush: () => Promise.resolve(), close: () => Promise.resolve() },
      });
      await exitCli(await runModuleSubcommand(argv, {
        configPath: join(homeDir, "config.toml"),
        trustFile: join(homeDir, "trust.json"),
        discovered: discovered.map((m) => ({ name: m.def.name, root: m.root, entryHash: m.entryHash, layer: m.layer })),
        out: (l) => console.log(l),
      }));
    }
  } catch (err) {
    // CM-06①：兜底面按「harness 创建」划界的旧口径漏掉子命令——坏 config 遇 `provider list` 即裸堆栈；
    // 政策与 formatStartupError 同族（人话 + 非零退出，不带栈）
    console.error(`[错误] 子命令失败：${err instanceof Error ? err.message : String(err)}`);
    await exitCli(1);
  }
}

// CM-05（2026-09-28 code review）：parseArgs 对未知 flag/缺值/非法枚举同步 throw，此前在模块顶层裸调——
// 错误穿透整段模块求值，用户看到 Node 完整调用栈而非「错误 + 用法 + 退出码」（formatStartupError 口径的
// 界外漏网）。args.ts 非本修域，兜底落位本处；参数错 = 退出码 2（kimi-code validateOptions 同族形态）
let args: CliArgs;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err)); // message 已含 USAGE（args.ts throw 原文）
  await exitCli(2);
  throw err; // 不可达（exitCli 已排空并 process.exit）——只为满足明确赋值分析
}
// 会话目录分桶（M4-1 T1/D46）：根 = ~/.orosus/sessions；新会话落当前项目桶 sessionsRoot/<encodeCwd(cwd)>/
const sessionsRoot = join(orosusHome(), "sessions");
const currentBucket = encodeCwd(process.cwd()); // 会话树批 #17：交互面只认当前项目桶
const sessionsDir = join(sessionsRoot, currentBucket);
// --resume 定位（会话树批 T2 目录化 + #17 桶限定）：只认当前项目桶的新形态会话；找不到 = 全新空会话（M3 既有语义）
const resumeLoc = args.resume !== undefined ? locateSessionFile(sessionsRoot, args.resume.sessionId, { bucket: currentBucket }) : undefined;
// activeDir 语义 = 桶目录（/fork 父定位与 createSession 回退的写侧桶）——目录化后 scan 条目 dir 是会话目录，取其父
let activeDir = (resumeLoc !== undefined ? dirname(resumeLoc.dir) : undefined) ?? sessionsDir;

// 空会话残留清扫（2026-10-01 用户拍板清理批②）：启动即扫当前项目桶，清掉上次异常退出留下的 0 消息壳
// （正常退出由 sessionLoop 退出漏斗就地清——走不到漏斗的进程被杀/崩溃壳归这里兜底）。只扫当前桶：他桶
// 等该项目下次打开时自清。豁免 --resume 目标（用户点名要打开的空会话不能进门就被清）；他实例活锁占用
// 的跳过。MCP 模块 activate 即写 mcp/manifest 令每次启动物化会话文件——不发消息退出即壳，这是壳的主源
{
  const swept = sweepEmptySessions(sessionsDir, new Set(args.resume !== undefined ? [args.resume.sessionId] : []));
  if (swept.removed.length > 0) console.error(`已清理 ${swept.removed.length} 个空会话残留（上次退出的 0 消息壳）`);
}

/** 空会话退出即清（2026-10-01 用户拍板清理批②）：刚关的会话 0 消息 → 整目录不留（判定 = core
 *  isEmptySessionHead，fork 子体除外——投影含父辈）。异常退出走不到此（进程被杀）——残留壳由下次
 *  启动 sweepEmptySessions 兜底。purge 前置条件 = store 已 close（Windows 活句柄删不动）。 */
const purgeIfEmptySession = (sid: string): void => {
  const loc = locateSessionFile(sessionsRoot, sid);
  if (loc === undefined) return;
  const head = readSessionHead(loc.file);
  if (head !== undefined && isEmptySessionHead(head)) purgeSessionDir(dirname(loc.dir), sid);
};

// rl 与交互 UI（D35，T10）：先于 harness 创建——/model、/provider 等菜单命令经 commandUi 注入。
// M3 口子：审批模块的 waterfall 询问流将复用同一 UI 注入路径（届时经 ctx 扩展，形态随 M3 方案审查定）。
// 输出走可静默代理：密钥询问期间 rl 回显全吞（盲输，ssh/docker 同款）——逐键 * 回显在真实 Windows
// 终端层会碎成孤星（走查实录），静默在任意终端层行为一致。terminal/列宽透传给代理保住行编辑。
const stdoutEcho = createSilenceableOutput(process.stdout);
const RUN_STARTED_AT = new Date().toISOString(); // 运行时间锚（F5 九轮⑤ 用户拍板：本次进程运行时长，非会话年龄）
if (process.stdout.isTTY === true) {
  Object.defineProperty(stdoutEcho, "isTTY", { value: true });
  Object.defineProperty(stdoutEcho, "columns", { get: () => process.stdout.columns });
}
// Tab 补全（M4-2 T21 + m5 T15 第三职）：模块命令参数经 graph 现读委托（completeArg 抛错当无候选 + host 日志）
const rlCompleter = (line: string): Promise<[string[], string]> =>
  Promise.resolve(commandCompleter(line, process.cwd(), h.graph().commands.map((c) => ({ name: `/${c.name}`, ...(c.completeArg !== undefined ? { completeArg: c.completeArg } : {}) })), (name, err) => {
    h.log("host.completer.error", `模块参数补全抛错，当无候选：${name}`, { error: String(err instanceof Error ? err.message : err) });
  }));
const rl = createInterface({ input: process.stdin, output: stdoutEcho, completer: rlCompleter });
// 行队列：readline 的 question() 会丢弃两次询问之间到达的行（管道喂多条命令丢行），
// 且 EOF 落在 await 间隙时已关闭接口上的 question 永不 settle（退出码 13 挂起）——REPL 一律走队列兜底。
const pendingLines: string[] = [];
let lineWake: (() => void) | undefined;
let stdinClosed = false;
let askActive = false; // 菜单询问期间的行归询问消费（REPL 不抢答）
rl.on("line", (l) => {
  if (askActive) return;
  // 全屏期 readline 与 FullApp 共用同一 stdin（rl 不摘——行模式回切还要用）：按键两头都到，
  // rl 会把全屏输入框里的回车也酿成 line 事件——不丢则回行模式后陈旧命令连环重放（F5 走查实证）
  if (activeApp !== undefined) {
    const w2 = rl as unknown as { line: string; cursor: number };
    w2.line = "";
    w2.cursor = 0;
    return;
  }
  pendingLines.push(l);
  const w = lineWake;
  lineWake = undefined;
  w?.();
});
// Ctrl+C 在 raw 模式以 \x03 数据字节到达，readline 默认行为是关闭接口（无 SIGINT 监听时）——
// 关掉 rl 会 pause stdin，FullApp 随之断粮冻结。挂空监听拦住默认关闭；退出决策归 FullApp/REPL。
rl.on("SIGINT", () => { /* 全屏期防 rl 自闭；行模式 SIGINT 由 process 级处理器取消 turn */ });
rl.once("close", () => {
  stdinClosed = true;
  const w = lineWake;
  lineWake = undefined;
  w?.();
});
const nextLine = async (): Promise<string | null> => {
  for (;;) {
    const l = pendingLines.shift();
    if (l !== undefined) return l;
    if (stdinClosed) return null;
    await new Promise<void>((r) => { lineWake = r; });
  }
};
// 行询问公共内核（TUI 批 T3）：EOF 竞速监听逐次挂摘（不用 standing promise——正常退出时
// rl.close() 不产生无人消费的 rejection）；TTY 下 watchEsc 多播监听按键流（与 readline 行编辑
// 共存，同字节不抢占），单 Esc 命中 abort rl.question → 带内抛「已取消（Esc）」（机制③，
// D35 拒绝式同族）；方向键等 CSI/SS3 序列被解析器吞掉不取消（v1.8 修正）。非 TTY 不挂监听
const askLine = (prompt: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const ac = new AbortController();
    const stopEsc = process.stdin.isTTY === true ? watchEsc(process.stdin, () => ac.abort()) : undefined;
    const onClose = (): void => {
      cleanup();
      reject(new Error("无交互环境（stdin 已关闭）——交互式命令不可用（D35 fail-closed）"));
    };
    const cleanup = (): void => {
      rl.removeListener("close", onClose);
      stopEsc?.();
    };
    rl.once("close", onClose);
    rl.question(prompt, { signal: ac.signal }).then(
      (v) => { cleanup(); resolve(v); },
      (e: unknown) => { cleanup(); reject(ac.signal.aborted ? new Error("已取消（Esc）") : e); },
    );
  });
const rlQuestion = async (q: string): Promise<string> => {
  askActive = true;
  try {
    // 命令开始前已到的行（管道脚本/用户预打字）优先喂给询问——否则队列与 question 各等各的（脑裂挂起）
    const queued = pendingLines.shift();
    if (queued !== undefined) return queued;
    return await askLine(q);
  } finally {
    askActive = false;
  }
};
// 密钥询问（静默盲输）：提示语写真 stdout（明示不回显），rl 回显经代理全吞——
// 结束后补换行（回车回显也被吞了）。管道预输行直接采纳——非 TTY 无回显，天然不泄漏。
// Esc 取消（T3）经 askLine 同款抛错，finally 保证静默开/关成对
const rlSecretQuestion = async (q: string): Promise<string> => {
  askActive = true;
  try {
    const queued = pendingLines.shift();
    if (queued !== undefined) return queued;
    process.stdout.write(`${q}（输入不回显）: `);
    stdoutEcho.silence(true);
    try {
      return await askLine("");
    } finally {
      stdoutEcho.silence(false);
      process.stdout.write("\n");
    }
  } finally {
    askActive = false;
  }
};
// 全屏 CommandUi 适配层（F3–F5，spike adapter.ts 实证形态）：全屏激活期 ask/askSecret/choose
// 经 FullApp 的 overlay/输入行接管（readline 系件在 alt-screen 下毁屏）；Esc → 「已取消（Esc）」
// 带内抛错（机制③同族）；非全屏或应用未起 → readline 原路径。
let activeApp: FullApp | undefined;
const question = async (q: string): Promise<string> => {
  if (activeApp !== undefined) {
    const v = await activeApp.promptInput(q, false);
    if (v === undefined) throw new Error("已取消（Esc）");
    return v;
  }
  return rlQuestion(q);
};
const secretQuestion = async (q: string): Promise<string> => {
  if (activeApp !== undefined) {
    const v = await activeApp.promptInput(q, true);
    if (v === undefined) throw new Error("已取消（Esc）");
    return v;
  }
  return rlSecretQuestion(q);
};

// 流式活动区（TUI 批 T4）——装配序先于菜单与渲染：菜单写面（picker/标题行）同接 lv.write
// （v1.8 B5：审批 choose 首帧与 tool/call 行落屏的竞速由「任何写先固化活动区」天然消解）；
// 非 TTY lv.write 为直通（T1–T3 行为不变）
const lv = createStreamView({
  write: (s) => process.stdout.write(s),
  isTTY: process.stdout.isTTY === true,
  columns: () => process.stdout.columns ?? 80,
});
// 键盘菜单引擎（TUI 批 T1/T2）：TTY 下 choose 与 /sessions 选号走 picker（上下键/Esc/数字直达/
// 滚动视口）——模态管理器接管期间 readline 行编辑停摆（keys.ts 文件头注）；非 TTY 不注入，
// 编号读序号现状回落。视口高度 = 设计空白公式 max(3, min(终端行数−8, 15))（v1.8 B4 修正版）
const terminalMenuIo = () => {
  const modal = createModal({ input: process.stdin, isTTY: true, write: (s) => lv.write(s) });
  return {
    isTTY: true,
    height: Math.max(3, Math.min((process.stdout.rows ?? 24) - 8, 15)),
    runModal: <T,>(fn: (rk: () => Promise<KeyEvent>) => Promise<T>): Promise<T> => modal.run(fn),
    write: (s: string): void => lv.write(s),
    numberQuestion: question,
  };
};
const pickFace =
  process.stdin.isTTY === true
    ? {
        pick: async (title: string, items: string[]): Promise<number> => {
          // 全屏 CommandUi 适配层：全屏激活期 choose 走 FullApp overlay（readline picker 毁屏）
          if (activeApp !== undefined) {
            const n = await activeApp.pickOverlay(title, items);
            if (n === undefined) throw new Error("已取消（Esc）");
            return n;
          }
          lv.write(`== ${title} ==
`);
          const n = await pick(items, terminalMenuIo());
          if (n === undefined) throw new Error("已取消（Esc）");
          return n;
        },
      }
    : {};
/** 瞬时提示统一出口（2026-09-23 用户拍板 toast 化）：全屏 → 浮动 toast（黄字 3s 自消、3 行封顶）；
 *  行模式 → 单行 console（形态不变）。命令错误/拦截/退役指路/模型错误等瞬时面一律走此口，
 *  不再落流区（命令结果 md / 会话生命周期回显 / 工具行失败仍带内——见 ROADMAP toast 化条目）。 */
const notify = (t: string, opts?: { durationMs?: number }): void => {
  // 行模式无时长概念（console 单行即走）；全屏透传 durationMs（m5 T3——缺省 3000 不变）
  if (activeApp !== undefined) activeApp.showToast(t, opts?.durationMs);
  else console.log(t);
};

/** 命令面错误统一落点（2026-09-24 M4-3 走查实锤收口——/settings 弹窗 Esc 取消无人接、进程 exit 7 前案）：
 *  Esc 带内取消静默（TUI 批 T3/D52③ 拍板）+ 其余瞬时错误 toast 化（2026-09-23 拍板）。
 *  processReplLine catch-all 与 runSubmit 网兜共用此政策——模块命令的 choose/ask Esc 抛错必须穿透
 *  处理器（/model 收窄 catch 同款约定），接住它们 = 宿主这两处。 */
const settleCommandError = (err: unknown): void => {
  if (err instanceof Error && err.message === "已取消（Esc）") return;
  notify(err instanceof Error ? err.message : String(err));
};

// m5 T2：viewText 上契约（全屏走 FullApp 弹窗——新几何/自定义键/排队；行模式落 console 多行）。
// 装配件独立在 uiface.ts（main.ts 是顶层脚本 import 即跑——装配层测试进不去）。
const commandUi = createCliUi({
  question,
  secretQuestion,
  ...pickFace,
  notice: notify, // 瞬时提示出口（批⑧契约口）：模块侧 ui.notice 同走 toast
  activeApp: () => activeApp,
  // m5 T4：贴图 = 注册表登记 + chip token 进输入框光标位（Alt+V 同款链路）；路径校验不过走 toast
  attachImage: (app, path) => {
    if (!existsSync(path)) {
      app.showToast(`贴图失败：文件不存在（${path}）`);
      return;
    }
    app.insertAtCursor(attachPendingImage(path));
  },
});

const createSession = async (extra: { fork?: { parentSessionId: string; atEntryId?: string; parentDir?: string }; resume?: { sessionId: string }; sessionsDir?: string } = {}) => {
  // m4-8 T2 存量迁移（D1 自动搬）：老 config.toml 里的模块节整节搬 modules.d/<名>.toml（.bak 备份、幂等、
  // 白名单 = 内置模块名——第三方已挂载模块发现后才知名，首轮不搬、下轮启动自然补搬）；
  // OROSUS_NO_MIGRATE 非空可关。用户层与项目层各迁一次（层各自的 config.toml 与 modules.d）
  if (process.env.OROSUS_NO_MIGRATE === undefined || process.env.OROSUS_NO_MIGRATE === "") {
    const knownNames = BUILTIN_MODULES.map((m) => m.name);
    for (const [cfg, modDir] of [
      [join(orosusHome(), "config.toml"), join(orosusHome(), "modules.d")],
      [join(process.cwd(), ".orosus", "config.toml"), join(process.cwd(), ".orosus", "modules.d")],
    ] as const) {
      try {
        migrateModulesSections(cfg, modDir, knownNames);
      } catch (err) {
        console.error(`[迁移跳过] ${cfg}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const h = await createHarness({
    builtinModules: BUILTIN_MODULES,
    commandUi,
    settings: settingsService, // m5 T9 口子四：经内核装配成 ctx.settings（mounts "settings" 门）
    host: hostInfo,             // m5 T9 读面：ctx.host 直挂无门
    autoTitle: true, // B9 拉前：首轮问答完成自动起会话标题（核心缺省关，CLI 显式开——装配层）
    sessionsDir: extra.sessionsDir ?? activeDir,
    sessionsRoot, // 会话树批 T1：fork 祖先链跨桶定位兜底（存量跨桶链只读兼容；新链恒同桶走快路径）
    // 会话树批 T11：宿主切换缝（ctx.session.switchTo 背后）——立即返回语义（决策点 9）：返回 true = 已受理，
    // 切换异步走（void 不等待——等待 = 永远等不到，调用方 harness 即将随切换销毁）；#17 桶闸：locate 限当前
    // 项目桶，他桶/不存在 = false（契约「false = 会话不存在」的唯一出处——模块不能借 switchTo 跳进别项目）
    sessionSwitch: async (sid: string) => {
      const loc = locateSessionFile(sessionsRoot, sid, { bucket: currentBucket });
      if (loc === undefined) return false;
      // CM-12①（2026-09-28 code review）：switchTo 内 createSession 可抛（桶目录 mkdir 失败、配置在会话间
      // 被改坏）——void-async 无 rejection 落点 = 进程杀手（runSubmit 网兜同源认知，1851 一带先例注释的推广）；
      // 契约已先返回 true（受理），失败面走 settleCommandError（Esc 静默、其余 toast/单行），宿主进程不崩
      void switchTo(sid).catch((err) => settleCommandError(err));
      return true;
    },
    ...((extra.resume ?? args.resume) !== undefined ? { resume: extra.resume ?? args.resume } : {}),
    ...(extra.fork !== undefined ? { fork: extra.fork } : {}),
    config: {
      enableModules: args.enable,
      disableModules: args.disable,
      noModules: args.noModules,
      module: args.module,
      ...(args.model !== undefined ? { cliOverrides: { model: args.model } } : {}),
    },
  });
  // 工具显示名喂给渲染层（label 优先呈现——2026-09-24 用户拍板）；reload 会换工具集合，四处 reload 位同步重喂
  registerToolLabels(h.graph().tools.toolInfos());
  return h;
};

// 历史回显（B9 走查补 + 分页）：尾页优先（最新对话先可见），TTY 下回车向前翻页、q 结束；
// 非交互（管道）只出尾页——巨量历史不再刷爆终端（单行截断在 renderHistoryLines）
const echoHistory = async (h: Harness, out: (s: string) => void = (s) => console.log(s)): Promise<void> => {
  const lines = renderHistoryLines(await h.history(), process.stdout.columns ?? 80);
  const PAGE = 30;
  let { shown, hiddenBefore } = historyPage(lines, PAGE);
  if (hiddenBefore > 0) out(`…（历史共 ${lines.length} 行，先显示最近 ${shown.length} 行——完整原文在会话文件）`);
  for (const l of shown) out(l);
  while (hiddenBefore > 0 && process.stdin.isTTY) {
    let more: string;
    try {
      more = await commandUi.ask(`…（前面还有 ${hiddenBefore} 行）回车=继续往前翻，q/Esc=停止回显`);
    } catch {
      break; // Esc（已取消）= 停止翻页，语义同 q——echoHistory 调用点在 REPL catch 面外（TUI 批 T3 过账：不接则 Esc 未捕获异常炸进程）
    }
    if (more.trim().toLowerCase() === "q") break;
    const end = hiddenBefore;
    const start = Math.max(0, end - PAGE);
    for (let i = start; i < end; i++) out(lines[i]!);
    hiddenBefore = start;
  }
};

// 全屏会话切换的回显延期槽（F5 二轮⑯）：switch 后 dm 在 sessionLoop 顶重建——
// 当场回显等于写进即弃的旧 dm（用户实测：/sessions 切换后历史「没加载」）。
let pendingEcho: { notice: string; history: boolean } | undefined;

// 顶层兜底 catch（T6/S7）：createHarness 抛错（坏配置 TOML、required 护栏阻断、T5 没盖住的）不再裸堆栈退出。
// 模块顶层 await——catch 内不能 return、也不能只设 exitCode 放行（后续 REPL 带着未初始化的 h 继续跑），
// process.exit(1) 直接拦住（同文件 --dump-modules 的 exit(0) 先例）
// ---- 口子四：设置服务写面 + 宿主状态读面（m5 T9；h 经模块级 let 引用——服务闭包调用期现读活会话）----

/** 挂载模式现算三态（设计空白 17）：启用集 ⊆ 保底名单 → minimal；全启用 → full；其余 → custom。
 *  现算不靠记忆——用户切完极简又手动插拔，「上次切的档」会撒谎。保底名单 = lockReasonFor 三款同款（核心 + approval + 当前活跃 provider）。 */
const modulePresetOf = (): "full" | "minimal" | "custom" => {
  const providerV = realReadModel(process.cwd())() ?? "";
  return computeModulePreset(h.graph().audit(), presetBaseline(providerV === "" ? "" : providerV.split("/")[0]!));
};

/** 宿主状态快照（m5 T9 读面，决策点 24）：harness 现成读口 + 提纯投影 + preset 现算——零新增读口。 */
const hostInfo: HostInfo = {
  current: async () => {
    const st = h.status();
    const events = await h.history();
    const cfg = configFace();
    const usage = await h.usage();
    const label = sessionLabelOf(events);
    return {
      model: st.model,
      modelOverridden: st.overridden,
      ...(st.effort !== undefined ? { effort: st.effort } : {}),
      preset: modulePresetOf(),
      theme: theme.activeThemeName(), // m5 T12：注册表 active 名（本批仓内恒「连山」）
      permission: permissionOf(events, cfg.approvalMode),
      ...(label !== undefined ? { sessionLabel: label } : {}),
      ...(activeApp !== undefined ? { sidebar: activeApp.stateRef.sidebarVisible } : {}),
      ...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
      usage,
    };
  },
};

/** 挂载预设状态（m5 T10，设计空白 16）：极简模式自己关掉的模块名单（会话内存）——
 *  切回完整只恢复这批（用户手动关过的不会被误开）；undefined = 从未切过极简。 */
let minimalClosed: Set<string> | undefined;

/** applyModulePreset 实现（m5 T10）：算关闭集（纯计划器）→ 硬依赖级联闭包展开 →
 *  逐模块写盘（单节失败记日志继续，失败清单带内返回——决策点 21）→ 统一 reload 一次
 *  （关消失模块的挂起窗、面板刷新、标签表重喂——toggleModule 链同款收尾）。 */
const applyModulePresetImpl = async (preset: "full" | "minimal"): Promise<{ failed: string[] }> => {
  const audit = h.graph().audit();
  const providerV = realReadModel(process.cwd())() ?? "";
  const baseline = presetBaseline(providerV === "" ? "" : providerV.split("/")[0]!);
  const plan = planModulePreset({
    preset,
    activeNames: audit.filter((a) => a.state === "active").map((a) => a.name),
    baseline,
    minimalClosed,
  });
  if (plan.writes.length === 0) return { failed: plan.failed };
  let writeList: string[];
  if (preset === "minimal") {
    // 级联：卸载带走依赖者（computeUnmountClosure——toggleModule 同款）；撞锁定（保底成了被拔者的依赖）拒绝整次带拒因
    const depRows = audit.map((a) => ({ name: a.name, provides: a.provides, dependsOn: a.dependsOn, state: a.state }));
    const lockedNames = audit.filter((a) => lockReasonFor(a.name) !== undefined).map((a) => a.name);
    const closure = computeUnmountClosure(plan.writes.map((w) => w.name), depRows, lockedNames);
    if (!closure.ok) return { failed: [closure.blocked] };
    writeList = closure.write;
  } else {
    writeList = plan.writes.map((w) => w.name);
  }
  const failed: string[] = [];
  for (const name of writeList) {
    try {
      setModuleEnabledInConfig(name, preset === "minimal" ? false : true, moduleConfigFileFor(name, h));
    } catch (err) {
      h.log("host.preset.write-failed", `预设写盘失败：${name}`, { preset, error: String(err instanceof Error ? err.message : err) });
      failed.push(name);
    }
  }
  if (preset === "minimal") {
    minimalClosed = new Set(writeList); // 幂等：空关闭集不到这里（早退）——不覆盖原记录
  } else {
    minimalClosed = undefined; // 恢复完清记录（再切 minimal 重新记）
  }
  const namesBefore = activeModuleNames(); // m5 T7：关消失模块的挂起窗
  try {
    await h.reload();
  } catch (err) {
    h.log("host.preset.reload-failed", `预设 reload 失败（已写盘——可 /reload 或重启对齐）`, { preset, error: String(err instanceof Error ? err.message : err) });
    return { failed: [...failed, "(reload)"] };
  }
  closeGoneModuleUi(namesBefore);
  registerToolLabels(h.graph().tools.toolInfos());
  await refreshPanel();
  return { failed };
};

/** 设置服务（m5 T9 骨架）：setModel/setEffort/setLabel 走 harness 同源出口（单一写者）；
 *  setTheme/applyModulePreset 为必选成员占位——本批 T12/T10 落地（中间提交拒绝带明话）；
 *  setSidebar/readClipboard 可选成员不装（T11 落地时装配）。 */
const settingsService: SettingsService = {
  setModel: async (qualified) => {
    const before = h.status().model;
    await h.setModel(qualified);
    notify(`模型已切换：${before} → ${qualified}`); // reportModelSwitch 同族——toast diff
  },
  setEffort: async (level) => {
    h.setEffort(level);
    notify(level === "auto" ? "思考档位：跟随目录默认" : `思考档位：${level}`);
  },
  setTheme: async (name) => {
    theme.setTheme(name); // 未知名抛错 = reject（模块自行 catch；契约口径——本批仓内仅连山一套，机制就绪）
    activeApp?.repaint(); // 新渲染面换新色（历史行旧色不重刷——设计空白 11 预期行为）
    notify(`主题已切换：${name}`);
  },
  applyModulePreset: async (preset) => {
    const { failed } = await applyModulePresetImpl(preset);
    notify(failed.length > 0
      ? `预设切换部分失败：${failed.join("、")}（已写盘部分可 /reload 对齐）`
      : preset === "minimal" ? "已切到极简模式（核心 + 审批 + 当前模型）" : "已切回完整模式");
    return { failed };
  },
  setLabel: (label) => h.setLabel(label),
  setSidebar: async (visible) => {
    // 行模式无侧栏 = false（无全屏 app 或被拒均 false——契约加宽 Promise<boolean>，m5-render-perf T5：
    // 消费方向后兼容，模块拿到明确拒绝；kernel activate.ts 包装器自动透传返回值）
    return activeApp?.setSidebar(visible) ?? false;
  },
  readClipboard: () => readClipboardText(),
};

let h: Awaited<ReturnType<typeof createSession>>;
/** Alt+V 取图落点（m5-media F8）：当前会话媒资库 <sid>/media/（随桶清理）；会话未就绪/切换中回落旧 tmp 位。 */
const pasteImageToMedia = (): Promise<{ file: string } | undefined> => {
  try {
    return pasteImage(join(sessionsDir, h.sessionId, "media"));
  } catch {
    return pasteImage();
  }
};
try {
  h = await createSession();
} catch (err) {
  console.error(formatStartupError(err, orosusHome(), new Date()));
  process.exit(1);
}
if (args.dumpModules) {
  console.log(h.graph().catalog());
  await h.close();
  purgeIfEmptySession(h.sessionId); // 空会话退出即清（2026-10-01 拍板②）——工具模式不带消息，壳不留
  process.exit(0);
}

// --print（M4-2 T17）：非交互单发——三格式输出后以 exitCode 收尾，不进 REPL、不触发首启引导/历史回显
if (args.print !== undefined) {
  // CM-04（2026-09-28 code review）：无头旁路此前不在任何 try/finally 内——h.prompt reject（并发守卫/
  // store IO 失败）时收尾三件套全跳过、模块顶层裸堆栈退出；且 killAllBackgroundJobs 只挂 sessionLoop 的
  // finally，print 不进循环——模型 spawn 的后台 shell 作业进程退出后成孤儿。收口对齐 sessionLoop 同款。
  try {
    const outcome = await runPrint(h, args.print, args, (s) => console.log(s));
    // CM-04③：查 turn 终态——provider 401/网络错误空正文不再静默 exit 0（脚本消费方靠退出码分辨失败）
    process.exitCode = outcome.turnEndKind === undefined || outcome.turnEndKind === "completed" ? 0 : 1;
  } catch (err) {
    console.error(formatStartupError(err, orosusHome(), new Date()));
    process.exitCode = 1;
  } finally {
    rl.close();
    killAllBackgroundJobs(); // 无头一轮的后台作业同样收杀（与 sessionLoop finally 同收口——此前 print 独漏）
    await h.close(); // runPrint 内部已 close（事件收集收口件）——此处幂等兜底错误路径
  }
} else if (args.resume !== undefined) {
  // --resume 启动同样回显历史（B9 走查补——此前只有 REPL /resume 有）；
  // 全屏模式延期到 dm 重建后（F5 二轮⑯——tuiMode 此时未定，按 TTY 实况同口径预判）
  // 恢复回放（横幅退役同上——空 notice 只回放）；全屏延期到 dm 重建后（F5 二轮⑯——tuiMode 此时
  // 未定，按 TTY 实况同口径预判）
  if (args.tui !== "line" && process.stdout.isTTY === true && process.stdin.isTTY === true) {
    pendingEcho = { notice: "", history: true };
  } else {
    await echoHistory(h);
  }
}

// 启动审计横幅在 sessionLoop 首轮统一打印（banner.ts 可测抽取；分级规则见彼处注释——B7 提前落地）

/** 清屏（用户走查 2026-09-19）：/new 与 /fork 换会话时清残屏。TTY only——
 *  管道/重定向下吐 ANSI 转义只会污染输出（走查与脚本消费方都要干净 stdout）。 */
const clearScreen = (): void => {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // 屏+回滚缓冲清空、光标归位
};

// 首启引导（模型发现 T0——M3 T9 欠账接线）：TTY 且需要配置 → 确认转 /provider 向导 → /reload → 复检回显；
// 非交互跳过；只挂首会话（/new、/fork 换出的会话不再触发，M3 T9 定案）；--print 单发不触发。
// 全屏模式不再引导（F5 七轮用户拍板）：直接进主窗口，未配置时提问走带内提示（见 processReplLine）
const willFullscreen = args.tui !== "line" && process.stdout.isTTY === true && process.stdin.isTTY === true;
if (args.print === undefined && process.stdin.isTTY && !willFullscreen) {
  const out = await startupGate({ h, ui: commandUi, readModel: realReadModel(process.cwd()), isTty: true });
  if (out !== undefined) console.log(out);
}

// 事件渲染：会话日志的实时投影（append 即转发，§6.7）；lastEventId 供 /fork 选分叉点
// 渲染面抽至 render.ts（M3 补强 T8：压缩/裁剪可见性 + 可测性注入）
let lastEventId: string | undefined;
// Alt + V 挂起的图片注册表（2026-09-23 走查拍板重构）：seq → 文件（序号会话内累计）；
// chip [image #N (宽×高)] 全屏期是输入框文内 token（光标位插入、可删），行模式期是挂起序号列
//（pendingLineSeqs——行模式输入不经 token）。提交时从文本 token/行模式列收集 seq → 查表取文件。
const pendingImageFiles = new Map<number, string>();
let pendingLineSeqs: number[] = [];
let imageSeq = 0;
const attachPendingImage = (file: string): string => {
  imageSeq++;
  pendingImageFiles.set(imageSeq, file);
  return imageChipLabel(imageSeq, file);
};
// Alt+V 按键粘贴（TUI 批 T5）：keypress 多播拦截——与敲 /paste 完全同效；非 TTY 不挂（按键零处理）。
// keypress 事件发在输入流上（emitKeypressEvents(process.stdin)，与 rl.input 同一对象）；
// rl.line/rl.cursor 运行时可写（readline 公开属性）——@types/node 的 promises 变体声明为 readonly，窄化断言
attachAltVPaste({
  input: process.stdin,
  isTTY: process.stdin.isTTY === true,
  pasteImage: pasteImageToMedia,
  write: (s) => lv.write(s),
  clearInputLine: () => {
    const w = rl as unknown as { line: string; cursor: number };
    w.line = "";
    w.cursor = 0;
  },
  setPendingImage: (file) => {
    const label = attachPendingImage(file);
    pendingLineSeqs.push(imageSeq); // 行模式无文内 token——挂起序号列（提交时并入）
    return label;
  },
  enabled: () => activeApp === undefined, // 全屏期 Alt+V 归 FullApp（F5 走查：此处直写 lv 毁屏）
});
// Ctrl+O 行模式查看压缩摘要（2026-09-23 用户拍板：/summary 命令退役后的唯一入口；摘要逐行灰色 muted）。
// keypress 多播同 altpaste 模式；全屏期让位（FullApp 的 ctrl+o 经 io.showCompactionSummary 出 overlay）。
  if (process.stdin.isTTY === true) {
  process.stdin.on("keypress", (_s, k) => {
    if (activeApp !== undefined) return;
    if (k?.name !== "o" || k?.ctrl !== true) return;
    void (async () => {
      const view = compactionSummaryView(await h.history(), { width: Math.max(20, (process.stdout.columns ?? 80) - 6) }); // 2026-09-27：与全屏口同源——全部历史列出 + 按终端宽预折行
      const lines = view === undefined
        ? [theme.fg("info", "本会话还没有压缩摘要（/compact 后可看）")]
        : view.text.split("\n");
      const w = rl as unknown as { line: string; cursor: number };
      w.line = "";
      w.cursor = 0;
      process.stdout.write("\r\x1b[K");
      for (const l of lines) console.log(l);
      process.stdout.write("> ");
    })();
  });
}
// 渲染汇点多路复用（F3 双模式）：sink 指向当前模式的渲染出口——滚动流 = lv（streamview/DiffScreen），
// 全屏 = DocModel（FullApp 的行源）。模式切换只换 sink 指向，attachRender 订阅每会话一次不重挂。
let dm = new DocModel();
// kimi 式轮次滑窗（m5-render-perf T7）：主窗实例显式启用（renderAgentView 一次性渲染实例
// 不启用不裁剪——查看窗自有 500 条帽不叠第二轮窗）；视口探针 = fullapp layoutFrame 投影（阅读保护）
dm.turnWindowEnabled = true;
dm.viewportProbe = () => activeApp?.viewportRange();
/** 新会话重建 dm 时保持滑窗启用（sessionLoop 顶——同款三行收口一处）。 */
const newMainDocModel = (): DocModel => {
  const d = new DocModel();
  d.turnWindowEnabled = true;
  d.viewportProbe = () => activeApp?.viewportRange();
  return d;
};

/** 压缩完成行双色（2026-09-23 用户拍板）：「上下文压缩完成」石青（info）+ 两段括号灰（muted）——
 *  模块返回纯文本一行（数字与指针），CLI 按括号段拆分上色；不匹配的形态原样返回（防御）。 */
const renderCompactDoneLine = (s: string): string => {
  const m = s.match(/^(上下文压缩完成) (\([^)]*\)) (\([^)]*\))$/);
  if (m === null) return s;
  return `${theme.fg("info", m[1]!)} ${theme.fg("muted", m[2]!)} ${theme.fg("muted", m[3]!)}`;
};
// 全屏流区宽 = 左栏内容宽（F5 三轮②③——此前按整屏宽折行，流区只有左栏，每行尾部被截）
const streamW = (): number =>
  tuiMode === "full" ? (activeApp?.streamCols ?? process.stdout.columns ?? 80) : (process.stdout.columns ?? 80);
const sinkFor = (): { write(s: string): void; activity(c: StreamChunk): void; end(): void } =>
  tuiMode === "full"
    ? {
        write: (s) => dm.write(s, streamW()),
        activity: (c) => dm.activity(c, streamW()),
        end: () => dm.end(streamW()),
      }
    : {
        write: (s) => {
          // 工具结果哨兵（F5 五轮①）行模式转独立缩进行（全屏 DocModel 才做原位合并）
          lv.write(s.startsWith(TOOL_MERGE) ? `  ${theme.dim("↳ · " + s.slice(1))}
` : s);
        },
        activity: (c) => lv.activity(c),
        end: () => lv.end(),
      };

// 界面模式（F3）：TTY 缺省 full（全屏双栏主模式），--tui line 显式降级滚动流；非 TTY 恒 line（硬保底）。
// 界面模式（F6）：--tui 旗标 > 配置 [tui] mode > TTY 缺省（resolveTuiMode 纯函数可测；
// 运行期不切换——Ctrl+T 互切已下线，用户拍板）
const cfgTuiMode = configFaceTui();
let tuiMode: "line" | "full" = resolveTuiMode(args.tui, cfgTuiMode, process.stdout.isTTY === true && process.stdin.isTTY === true);
// LaTeX 数学渲染开关（mdpipe 批 T7，设计空白 #12/#13）：[tui] latex 缺省开，启动读一次注入，
// 改配置重启生效（/reload 热切换不做——本仓配置面无热读口，诚实登记）
setLatexEnabled(resolveLatexFlag(configFaceTuiLatex()));
// 回合结束提示音（2026-09-30 用户拍板）：[tui] bell 缺省开——完成 1 响/中断 2 响/错误 3 响（bell.ts）；
// 同 latex 式启动读一次。响铃只认 TTY（--print 管道静默），静音另一路 = 终端自身 bell 设置。
const bellMode = resolveBellMode(configFaceTuiBell()); // 2026-10-01 三态：chime（缺省——开箱即有完成音）/bel/off
// 侧栏可见性持久化（F5 十二轮② 用户拍板：Ctrl+T 状态跨会话保留）——[tui] sidebar，缺省可见。
// 实现抽 tui-config.ts（CM-01 修复：读盘剥 BOM + 解析失败拒写防整盘覆写毁配置）。



// Ctrl+T 运行期互切已下线（用户拍板：界面模式只由 --tui 旗标 / [tui] mode 配置在启动时选定）。

function attachRender(h: Harness): void {
  // 双写面（T4/v1.8；F3 多路复用）：chunk 路 TTY 进 sink.activity，事件路 sink.write（直写）；
  // 非 TTY 只传 write = 现状等价。onEvent 升级完整事件——turn/end 驱动 sink.end() 定格终稿
  // 全屏追加工具结构化口（2026-09-23 走查批）：tool/call / tool/result 带 args/output 进 DocModel
  // （diff/失败体渲染）；行模式不传 = renderEvent 文本形态不变
  // M4.5（2026-09-27 拍板）：spawn 工具行合并为 agent 组（kimi 定式——绝不显示「Using Spawn」）。
  // 取数 = 活名册 + 盘上历史按需补挂（重载后回放组全员终态，条目从盘上 agents/ 目录重建）——
  // 只补 DocModel 组实际引用的编号（groupIds 现算）：未引用的历史条目不进 provider，防
  // claimAgents 把旧面孔错认领进末组；盘读每会话一次备忘（attachRender 随会话切换重建，天然失效）
  let histRoster: { sid: string; entries: SubagentRosterEntry[] } | undefined;
  if (tuiMode === "full")
    dm.agentProvider = () => {
      const live = h.subagents();
      const want = dm.groupIds();
      if (want.size === 0) return live;
      const liveIds = new Set(live.map((e) => e.id));
      if (histRoster?.sid !== h.sessionId) histRoster = { sid: h.sessionId, entries: loadHistoricalSubagents(sessionsDir, h.sessionId) };
      const extra = histRoster.entries.filter((e) => want.has(e.id) && !liveIds.has(e.id));
      return extra.length > 0 ? [...live, ...extra] : live;
    };
  const toolIo =
    tuiMode === "full"
      ? {
          toolCall: (name: string, args: Record<string, unknown> | undefined, callId?: string) => {
            if (name === "tool-subagent__spawn") dm.agentGroupCall();
            else dm.toolCall(name, args, callId);
          },
          toolResult: (output: unknown, isError: unknown, callId?: string, images?: unknown) => dm.toolResult(output, isError, callId, images),
        }
      : {};
  attachRenderTo(
    h,
    {
      write: (s) => sinkFor().write(s),
      // TTY 才挂 activity/onError：非 TTY（--print 管道）错误走 write 旧管道形，console.log 不污染管道输出
      ...(process.stdout.isTTY === true ? { activity: (c) => sinkFor().activity(c), onError: notify } : {}),
      ...toolIo,
    },
    (e) => {
      lastEventId = e.id;
      if (e.type === "turn/end") {
        sinkFor().end();
        if (tuiMode === "full") dm.turnEnd(); // 轮边界记账 + 滑窗裁剪（T7——settle 之后条目已定格）
        void refreshPanel(); // 面板数据随 turn 刷新（F4）
        // 回合提示音（2026-09-30 用户拍板）：完成 1 响/中断 2 响/错误 3 响——events() 是实时通道
        //（恢复回放走 pendingEcho/DocModel 重建，不经此），只响活体回合；TTY 且 [tui] bell 开才响
        if (bellMode !== "off" && process.stdout.isTTY === true) {
          if (bellMode === "chime") playTurnChime(e.kind, { // 自带音频一声（不分结局——响数区分是 BEL 档语义）
            onError: (stage, err) => h.log("tui.chime.error", `回合提示音播放失败（${stage}）：${err instanceof Error ? err.message : String(err)}`, { stage: String(stage) }),
          });
          else ringTurnBell(e.kind, (s) => process.stdout.write(s));
        }
      }
      // m4-7 T5：压缩完成点清 skill 模块去重集——skill__load 正文是 tool result，compact 会被压掉，
      // 去重集不清 = 模型重调只得到确认句却没有正文（qwen 明确处理的坑）。/compact 手动与阈值自动
      // 同型走本口；会话边界免挂（换会话 createSession → loadModules 模块重建，内存态自然清零）。
      // getOptional 惰性取——skill 模块不在则跳过（优雅降级）
      if (e.type === "turn/compaction") {
        void h.graph().services.getOptional("skill.resetLoaded").then((reset) => {
          if (typeof reset === "function") (reset as () => void)();
        });
      }
      // 任务清单实时投影（2026-09-23 用户拍板）：载荷即全量清单，到一条改一条——不再等 turn 结束检查点。
      // panelCache 未就绪（启动历史重放先于首刷）跳过，refreshPanel 稍后自会从历史取 .at(-1)；
      // 全屏 FullApp 秒 tick 自动重绘，行模式无面板，改快照无害
      const todoTasks = panelTasksFromEvent(e);
      if (todoTasks !== undefined && panelCache !== undefined) panelCache = { ...panelCache, tasks: todoTasks };
    },
  );
}

process.on("SIGINT", () => h.cancel()); // Ctrl-C 中止当前 turn，不退出（h 为当前会话）

// 恢复会话（B9 拉前 → 会话树批 T2/#17）：当前桶定位 → 续写；scan 条目 dir 是会话目录，store 要桶 = dirname
const switchTo = async (sid: string, out: (s: string) => void = (s) => console.log(s)): Promise<void> => {
  const loc = locateSessionFile(sessionsRoot, sid, { bucket: currentBucket });
  if (loc === undefined) { out(`未找到会话 ${sid}（/sessions 查看列表）`); return; }
  await h.close();
  h = await createSession({ resume: { sessionId: sid }, sessionsDir: dirname(loc.dir) });
  activeDir = dirname(loc.dir);
  // CS-05①（2026-09-28 code review）：换会话重置 lastEventId——它只经 attachRender 的 onEvent 喂（切回的
  // 会话存量历史不重放事件流），不重置则切会话后立即 /fork 会把上一会话的事件 id 当 atEntryId 带进新
  // 会话；session 域已把投影外 atEntryId 从宽容降级改为 throw（fork.ts CS-05），此路径会响亮报错。
  // 重置为 undefined = /fork 走「父投影尾事件」缺省（createHarness fork 分支与 h.fork 两出口同款兜底），
  // 语义恰是 /fork 的「从最新位置分叉」。sessionSwitch 缝（ctx.session.switchTo）背后也走本函数，同点覆盖。
  lastEventId = undefined;
  // 恢复横幅整条退役（2026-09-30 用户拍板三轮：[已恢复] 与 ❯ 标题行都不要——历史回放即提示，
  // 顶上再压一行看着难受）；notice 留空串走回放，消费口跳过空行
  if (tuiMode === "full") {
    pendingEcho = { notice: "", history: true }; // 延期到 dm 重建后（F5 二轮⑯）
  } else {
    await echoHistory(h, out); // 回显存量对话（B9 走查补 + 分页）
  }
};

/** 单行处理（REPL 与全屏共用——F3 抽取）：会话生命周期指令 → "switch"（重挂横幅/渲染）；
 *  /quit → "quit"；其余 → "again"。out = 输出通道（REPL=console.log，全屏=DocModel.pushLine——
 *  全屏 alt-screen 下 console 输出会毁屏，一切带内输出必须进流区）。 */
const processReplLine = async (text: string, out: (s: string) => void): Promise<"again" | "switch" | "quit"> => {
      const directive = sessionCommand(text, { sessionId: h.sessionId, lastEventId });
      if (directive.kind === "quit") return "quit"; // /quit 同义 /exit /q（用户要求 2026-09-18）——经 sessionCommand 可测面
      if (directive.kind === "pick") {
        // /sessions（别名 /resume）无参：列表 + choose 选中即 resume（B9 形态；非交互指路直达）
        if (!process.stdin.isTTY) { out(formatSessions(sessionsRoot, h.sessionId, currentBucket) + "\n（非交互环境——用 /resume <序号|sid> 直达恢复）"); return "again"; }
        const items = listSessions(sessionsRoot, currentBucket);
        if (items.length === 0) { notify("暂无会话——发送第一条消息即创建"); return "again"; }
        // 走查定案（2026-09-19）：不选即取消——空输入 = 取消（专门「取消」项退役）。
        // TUI 批 T2：TTY 注入 picker 闭包（列表即菜单，序号/相对时间/（当前）标记同行；
        // 不再先打印静态表格——picker 自带列表渲染），Esc reject 在 pickSessionNumber 内转 undefined
        const n = await pickSessionNumber(
          (q) => commandUi.ask(q),
          items.length,
          async () => {
            const labels = items.map(
              // 两段式（2026-09-28 用户拍板：子界面与斜杠主菜单同形）——标题白、相对时间灰、「（当前）」标记青玉
              (s, i) => `${i + 1}. ${s.title} ${theme.dim(`· ${relativeTime(s.createdAtMs)}`)}${s.id === h.sessionId ? theme.fg("accent", "（当前）") : ""}`,
            );
            // 全屏期走 FullApp overlay（F5 走查实证：readline picker 的 modal 与 FullApp 抢 stdin 卡死）
            const n0 = activeApp !== undefined
              ? await activeApp.pickOverlay("选择会话", labels)
              : await pick(labels, terminalMenuIo());
            if (n0 === undefined) throw new Error("已取消（Esc）");
            return n0 + 1; // picker 0-based → 序号 1-based（与回落路径同口径）
          },
        );
        if (n === undefined) return "again";
        await switchTo(items[n - 1]!.id);
        return "switch"; // 换 harness 后重挂横幅与渲染
      }
      if (directive.kind === "title") {
        // /title（批⑦）：无参 = 静默零输出零写入（旧「当前会话：…——/title <名> 命名」行退役——2026-09-22 用户拍板无意义）
        if (directive.name === undefined) return "again";
        // 当前会话（或目标解析回当前）走活 harness 写口——批⑦a 破链修复：旁路新建 store 写活文件
        // 会让活 store 内存 lastId/seq 失真，后续事件 parentId 链断裂；序号/sid 指定的非活会话保持旁路（单写者安全）
        const targetSid = directive.target !== undefined ? resolveTarget(directive.target, sessionsRoot, currentBucket) : undefined;
        if (directive.target !== undefined && targetSid === undefined) { notify("未找到目标会话"); return "again"; }
        if (targetSid === undefined || targetSid === h.sessionId) {
          await h.setLabel(directive.name);
          // 命名确认走浮动 toast（2026-09-23 用户拍板——瞬时确认不落流区，/model 切换反馈同族）
          if (activeApp !== undefined) activeApp.showToast(`已命名 → ${directive.name}`);
          else out(`[已命名 → ${directive.name}]`);
        } else {
          const r = await setTitle(sessionsRoot, h.sessionId, directive.target, directive.name, currentBucket);
          if (r !== undefined) {
            if (activeApp !== undefined) activeApp.showToast(`已命名 ${r.sid} → ${directive.name}`);
            else out(`[已命名 ${r.sid} → ${directive.name}]`);
          } else notify(`未找到目标会话 ${directive.target}`); // toast 化（2026-09-23 拍板）——目标回显在文案里补上下文
        }
        return "again";
      }
      if (directive.kind === "resume") {
        const sid = resolveTarget(directive.sessionId, sessionsRoot, currentBucket);
        if (sid === undefined) { notify(`未找到会话「${directive.sessionId}」——/sessions 查看列表`); return "again"; }
        await switchTo(sid);
        return "switch";
      }
      if (directive.kind === "new" || directive.kind === "fork") {
        // 空会话 /new 就地刷新（2026-10-01 用户拍板清理批③）：当前会话 0 消息且非 fork 子体 → 不另起新
        // 会话（否则旧壳留尸 + 新壳又生），关店 → 清壳 → 同 sid 重开——文件 birthtime 归零即「创建时间
        // 已刷新」，header 也由重开的空会话按当下时刻懒写。fork 子体排除：投影含父辈历史，「新」不成立。
        // 文件未物化/读不出 = 走下方常规 /new（无壳可清，换 sid 无落盘代价）
        if (directive.kind === "new") {
          const loc = locateSessionFile(sessionsRoot, h.sessionId);
          const head = loc !== undefined ? readSessionHead(loc.file) : undefined;
          if (loc !== undefined && head !== undefined && isEmptySessionHead(head)) {
            const sid = h.sessionId;
            const bucketDir = dirname(loc.dir);
            await h.close();
            purgeSessionDir(bucketDir, sid);
            h = await createSession({ resume: { sessionId: sid }, sessionsDir: bucketDir }); // 同 sid 空档重开
            activeDir = bucketDir;
            lastEventId = undefined; // 与常规换会话同款重置（CS-05②：三处换会话缝一个口径）
            clearScreen();
            const notice = `[已是空会话——沿用本会话 ${sid}，创建时间已刷新]`;
            if (tuiMode === "full") pendingEcho = { notice, history: false }; // F5 二轮⑯ 延期
            else out(notice);
            return "switch";
          }
        }
        const from = directive.kind === "fork" ? directive.parentSessionId : undefined;
        // fork 自动命名（2026-09-22 用户拍板）：「fork <父标题>」——/sessions 里父子一眼可辨；
        // 经 h.setLabel 活写口（header 已由 harness fork 分支即刻落盘，链序 header→fork→label）
        const parentTitle = from !== undefined
          ? (() => { const loc = locateSessionFile(sessionsRoot, from, { bucket: currentBucket }); return loc !== undefined ? readTitle(loc.file, from) : from; })()
          : undefined;
        await h.close();
        // 新会话/fork 子会话一律落当前项目桶；fork 父会话按 activeDir 定位（可能在平铺或他桶——resume 旧会话后 /fork）
        h = await createSession(directive.kind === "fork"
          ? { ...harnessOptionsFor(directive, { parentDir: activeDir }), sessionsDir }
          : { sessionsDir });
        if (from !== undefined && parentTitle !== undefined) await h.setLabel(`fork ${parentTitle}`);
        activeDir = sessionsDir;
        // CS-05②：/new 与 /fork 换会话同款重置——/new 的新会话尚无事件（header 懒写），残留旧会话尾事件
        // id 时立即 /fork 必 throw（投影外 atEntryId）；/fork 分支的重置是口径统一（父尾 id 虽仍在子投影
        // 内合法，统一回 undefined 走尾缺省——三处换会话缝一个口径，勿再单点漏）
        lastEventId = undefined;
        clearScreen(); // 用户走查（2026-09-19）：换会话清屏——旧会话残屏与"历史丢失"错觉同源
        const notice = from !== undefined
          ? `[已从 ${from} 分叉——新会话 ${h.sessionId}，继承历史如下]` // fork 继承父上下文（ForkedSessionStore 投影实证）——回显让继承可见
          : `[新会话 ${h.sessionId}]`;
        if (tuiMode === "full") pendingEcho = { notice, history: from !== undefined }; // F5 二轮⑯ 延期
        else {
          out(notice);
          if (from !== undefined) await echoHistory(h);
        }
        return "switch"; // 重挂横幅与渲染（新事件流）
      }
      // /help（M4-2 T21）：CLI 层拦截带说明版（D38 第一层——core 简版被遮蔽，非 CLI 宿主仍走 core 版）
      // CM-15①（2026-09-28 code review）：精确小写等值改走 cmdNameOf（归一 + 小写）——/HELP、/Help、
      // "/ help"（斜杠后空格抹除）与 core 路由口径一致（core 2026-09-27 起命令词忽略大小写），不再漏到
      // 「未知命令」；非命令文本（无斜杠）cmdNameOf 原样返回不匹配，直通不受影响
      if (cmdNameOf(text) === "/help") { out(HELP_TEXT); return "again"; }
      // /settings（M4-3 T1c/D9：/other 改名——别名平移 /config；/other 旧名直接消失〔2026-09-24 用户拍板，
      // 不留指路不转别名〕——打字面撞「未知命令」即知新家）
      // 注记（同日走查实锤）：本条拦截须在下方 try 的 catch-all 覆盖内——弹窗配置流的 choose/ask Esc
      // 抛「已取消（Esc）」，try 外无人接 = 进程 exit 7 前案；移入 try 后与 /model 等同政策静默
      // 退役命令指路（批⑤⑥——打字面肌肉记忆；/paste 先例是干净移除，此二条有明确新家故留一行）
      if (/^\/usage\s*$/.test(text.trim())) { notify("已退役：/usage 并入 /settings → Token 用量"); return "again"; }
      if (/^\/status\s*$/.test(text.trim())) { notify("已退役：/status 并入 /settings → 运行状态"); return "again"; }
      // 模型未配置拦截（F5 七轮用户拍板）：仅提问——斜杠命令（/provider 向导本身！）必须放行，
      // 否则「让你去配 /provider」结果 /provider 也被拦（八轮用户实测怒点）
      const isCmdLine = text.trim().startsWith("/");
      if (
        !isCmdLine &&
        needsProviderSetup({ model: realReadModel(process.cwd())(), providers: h.graph().services.listProviders().map((p) => p.name) })
      ) {
        notify("还没有配置任何平台和模型——输入 /provider 打开配置向导（选平台 → 填端点与密钥 → 配好后直接提问）");
        return "again";
      }
      try {
        // /settings 拦截在 try 内首条——嵌套模块配置流（tool-web__settings 三级流）的 Esc 抛错落 catch-all 静默
        // CM-15①：精确小写等值改 cmdNameOf（/HELP 同款——大小写/斜杠后空格归一）
        if (cmdNameOf(text) === "/settings" || cmdNameOf(text) === "/config") {
          if (activeApp !== undefined) {
            await openSettingsPanel(activeApp);
          } else {
            await openSettingsLine(out);
          }
          return "again";
        }
        // /tasks（M4.5 T11）：子代理任务列表 + 查看窗 + 挂起审批应答（/task 单数同达——用户 2026-09-27）
        // CM-15①：精确小写等值改 cmdNameOf（/HELP 同款）
        if (cmdNameOf(text) === "/tasks" || cmdNameOf(text) === "/task") {
          await openTasks(activeApp, out);
          return "again";
        }
        // /skill : 名（2026-09-30 用户拍板：菜单技能条目 Tab ≠ Enter——回车直接执行技能，Tab 填
        // 「/skill : 名」可输入形态，本层解析该格式后与菜单 Enter 同路注入正文）。格式宽松：
        // /skill:名 /skill : 名 /SKILL 同达（命令词忽略大小写，core 2026-09-27 口径）；宿主级拦截
        // 先于 h.prompt 路由——graph 若注册 /skill 命令以本形态为准（技能区是宿主面）；解析成功
        // 递归走用户消息管线（回显/vision 闸/busy 排队语义与菜单 Enter 一致，正文不以 / 开头无二次解析）
        // 防重入（2026-09-30 三轮走查修卡死）：本分支产出的合成消息同样以 /skill : 开头，而下面的
        // 空白折叠会把换行压平——正则会再次命中、typed 连标记带技能正文整条吞进「参数」再包一层
        // 递归提交，无限自缠绕 = CPU 死循环界面卡死（用户实机复现）。含机器标记行 = 已是合成体，
        // 跳过解析直送消息管线。
        const skillM = text.includes("（用户通过菜单手动加载技能")
          ? null
          : /^\/skill\s*:\s*(.*)$/i.exec(text.trim().replace(/^\/\s+/, "/").replace(/\s+/g, " "));
        if (skillM !== null) {
          // 名字与参数分家（2026-09-30 用户拍板：首个空格后的尾巴是给技能的参数——kimi skillArgs 同款）
          const typed = skillM[1]!.trim();
          const sp = typed.indexOf(" ");
          const namePart = sp === -1 ? typed : typed.slice(0, sp);
          const skillArgs = sp === -1 ? undefined : typed.slice(sp + 1).trim() || undefined;
          const canonical = namePart === "" ? undefined : skillTypedName(namePart);
          if (canonical === undefined) {
            notify(namePart === "" ? "用法：/skill : <技能名> [参数]——斜杠菜单技能区 Tab 填入" : `未找到技能「${namePart}」——/reload 后重试或从 / 菜单技能区选择`);
            return "again";
          }
          const body = skillInjectText(canonical, skillArgs);
          if (body === undefined) {
            notify(`技能 "${canonical}" 正文读取失败——文件可能已被移动或删除（/reload 后重试）`);
            return "again";
          }
          // 原话行持久化（2026-09-30 拍板「我输入啥就显示啥」含回放）：嵌在标记行之后、<skill> 正文
          // 之前——不放开头：/ 开头的合成消息会被管线尾部当命令路由（未知命令，消息根本不发——
          // 三轮走查实机踩坑），且重入技能解析。消息以「（」开头 → isCmdLine 为 false 走内建回显，
          // docmodel 拆分渲染 = 原话块 + ● 行，实时与回放同一口同形（无需本层显式回显）
          const bodyNl = body.indexOf("\n");
          return await processReplLine(`${body.slice(0, bodyNl)}\n${text}\n${body.slice(bodyNl + 1)}`, out);
        }
        // 图片收集（2026-09-23 走查拍板）：全屏 = 文内 [image #N] token（extractImageRefs 剥除后进正文），
        // 行模式 = 挂起序号列；token 被用户删掉即不匹配 = 图不发出。chip 剥除在 @引用解析之前。
        const imgRefs = extractImageRefs(text);
        const textNoImg = imgRefs.cleaned;
        const imgSeqs = [...pendingLineSeqs, ...imgRefs.seqs];
        const imgs = imgSeqs.map((q) => pendingImageFiles.get(q)).filter((f): f is string => f !== undefined);
        // 转述等待期不收第二条（走查四——单等待口：并发提交会在 harness 单并发守卫炸「已有进行中的
        // turn」丢消息；双 Esc 可中止后重发）
        if (visionWaitAbort !== undefined) {
          notify("视觉转述进行中——稍候再发（双击 Esc 可中止）");
          activeApp?.restoreInput(text);
          return "again";
        }
        // 非 vision 模型拦截（F5 二轮⑭）+ F14 眼睛模型旁路（2026-10-02 用户口令「视觉模型启用了就不能再拦截」）：
        // 主模型明确不吃图时三态——① 视觉模型可用（三态解析过：auto=当前模型视觉 / 指定=槽在且目录证实多模态）
        // → 放行：回车即回显 + 窗口内「◐ 转述中 → ● 结果」两态条目（走查四拍板——转述等待不黑屏，
        // toast 双发退役；行模式无 dm 落 toast 退化），await 转述落盘后才发——首请求占位即带描述
        // （b6b8505 竞态修不变）；vtNote 随 prompt 紧随 user/message 落日志（回放行源）。
        // ② 配置了但不可用 → 仍拦截、文案带眼因（auto 且当前非视觉 / 槽未配置 / 目录证实非多模态）；
        // ③ 未配置 → 原文案。（坏消息落日志后每轮重发 = 会话永久报废的拦截理由不变——旁路不把图发给
        // 不吃图的模型，只换占位+摘要。）
        let vtNote: { model: string; ok: boolean; text?: string } | undefined;
        let echoed = false; // 旁路分支已回显——下方「确认发出点」跳过（拦截分支不回显纪律不变）
        if (imgs.length > 0) {
          const modelNow = realReadModel(process.cwd())() ?? "";
          const catalogAll = readCatalogDiskCache(defaultCatalogCacheFile()) ?? {};
          if (lookupModelVision(catalogAll, modelNow) === false) {
            const eye = await eyeModelUsable(modelNow, catalogAll);
            if (eye.usable) {
              const eyeModel = eye.model ?? ""; // usable=true 恒带 model（三态解析同源）
              if (!isCmdLine && tuiMode === "full") {
                dm.userPrompt(text);
                dm.visionTranscribeStart(eyeModel);
                echoed = true;
              } else notify(`视觉模型 ${eyeModel} 转述图片中…`);
              const res = await waitVisionTranscribe(imgs, tuiMode === "full" ? (d) => dm.visionDelta(d.kind, d.text) : undefined);
              if (res.state === "aborted") {
                if (tuiMode === "full") dm.visionTranscribeEnd(eyeModel, undefined, "aborted");
                notify("已中止转述——消息未发出，输入与图片已回挂（重发即续：已生成的转述有缓存）");
                activeApp?.restoreInput(text);
                return "again";
              }
              if (res.state === "done") {
                if (tuiMode === "full") dm.visionTranscribeEnd(eyeModel, res.text, "done");
                else notify(`已发送——图片已由视觉模型 ${eyeModel} 转述（可继续追问）`);
                vtNote = { model: eyeModel, ok: true, text: res.text };
              } else {
                if (tuiMode === "full") dm.visionTranscribeEnd(eyeModel, undefined, "failed");
                else notify(`视觉转述失败——按无图占位发送（/settings 查视觉模型配置）`);
                vtNote = { model: eyeModel, ok: false };
              }
            } else {
              const why = eye.configured ? `，且视觉模型不可用（${eye.why}——/settings 修复）` : "（或在 /settings 配置视觉模型转述）";
              notify(`已拦截：当前模型 ${modelNow || "（未配置）"} 不支持图片输入${why}——消息未发送，图片仍挂起（/model 换视觉模型后再发）`);
              activeApp?.restoreInput(text); // 全屏：输入原文（含 chip token）回挂——提交已清输入框
              return "again";
            }
          }
        }
        // @文件引用（M4-2 T18）：引用替换为附着内容（限 5 个/50KB，超限提示带内）
        const { text: cleaned, attachments } = resolveAtRefs(textNoImg, process.cwd());
        const withAt = attachments.length > 0 ? `${cleaned}\n\n${attachments.join("\n\n")}` : cleaned;
        // 用户消息回显放在「确认发出」点（2026-09-23 用户拍板：被拦截的消息不留痕迹）——
        // 上方非 vision/未配置模型两道拦截已 return，走到这里 = 消息真要发了；流区只显示发出的消息。
        // 旁路分支（echoed）已在转述前回显——回车即见（走查四）。原提交即回显（runSubmit）会把被拦截
        // 的消息留在流区成孤条。回显原文含图片 chip token，形态不变
        if (!isCmdLine && tuiMode === "full" && !echoed) dm.userPrompt(text);
        // 命令输入时 harness.prompt 返回命令输出（D38）——必须回显（M2 补账：原实现从不打印，命令「敲了没反应」）
        // /compact 进度指示（TUI 批 T7）：行模式经 lv 活动行、全屏经 busy spinner 专属形态（2026-09-23 用户拍板：
        // 「上下文压缩中…」石青色）；settle 后行模式 discard 擦除、全屏退出专属形态——结果由下方输出替换。
        // isTTY 取 stdout（写侧关切，与 lv/attachRender 双写面同口径——输出入管时硬保证不被指示行污染）
        // /reload 走 h.prompt 内建路由（报表不透出到 CLI 调用点）——m5 T7 关消失模块挂起窗：
        // 进 prompt 前快照活跃集，回来后 diff 关窗（报表解析口径不一，直接 diff 激活集更稳）
        const reloadShot = cmdNameOf(text) === "/reload" ? activeModuleNames() : undefined;
        const cmdOut = await withCompactHint(
          text,
          {
            isTTY: process.stdout.isTTY === true,
            activity: (s) => { if (activeApp === undefined) lv.activity({ kind: "text", text: s }); },
            discard: () => { if (activeApp === undefined) lv.discard(); },
            // 局部捕获（闭包执行时 activeApp 可能已换界——全屏/行模式切换中）：捕获时定钩子归属
            fullscreen: (() => {
              const app = activeApp;
              return app !== undefined
                ? { enter: () => app.setCompacting(true), exit: () => app.setCompacting(false) }
                : undefined;
            })(),
          },
          () => h.prompt(withAt, { // 挂起的图以 image part 随本条消息发出（M4-2.5 T5；文内 token 形态自 2026-09-23）
            ...imagesFor(imgs),
            // 转述旁注（走查四）：紧随 user/message 落盘——回放行序「问题→转述→回答」；不进上下文
            ...(vtNote !== undefined ? { afterUserEvent: { type: "host/vision-transcribe", fields: vtNote } } : {}),
          }),
        );
        for (const q of imgSeqs) pendingImageFiles.delete(q); // 已发出的图出注册表（取消/错误保留——旧口径）
        pendingLineSeqs = [];
        // /provider 写盘后自动重载模块图（2026-09-24 走查 bug 前案：会话内新加平台不进激活槽——/settings 的
        // LLM 钉模型清单读活槽，不重载即缺席；「设为当前默认」写的顶层 provider 键同理随重载即时生效）；
        // 只在写盘结果后重载（取消与未写入不动图）
        if (cmdNameOf(text) === "/provider" && PROVIDER_WRITE_DONE.test(cmdOut ?? "")) {
          const namesBefore = activeModuleNames(); // m5 T7：关消失模块的挂起窗
          await h.reload();
          closeGoneModuleUi(namesBefore);
          notify("平台配置已即时生效（模块图已重载）");
        }
        if (reloadShot !== undefined) closeGoneModuleUi(reloadShot);
        if (cmdNameOf(text) === "/reload") { registerToolLabels(h.graph().tools.toolInfos()); void refreshSkillMenu(); } // 标签表与技能菜单缓存随图重喂
        // 空串 = 静默约定（2026-09-22 用户拍板——/permission /yolo 切换成功不落流区行，面板 chip 自反映）
        if (cmdOut !== undefined && cmdOut !== "") {
          // 压缩完成行（2026-09-23 用户拍板）：石青（info）正文 + 灰（muted）括号段——ANSI 行必须走 raw
          // 通道不经 md 渲染（pushMd 会吃掉转义序列）；行模式 console 直出同款
          if (isCompactCommand(text) && cmdOut.startsWith("上下文压缩完成")) {
            const line = renderCompactDoneLine(cmdOut);
            if (activeApp !== undefined) dm.pushLine(line);
            else console.log(line);
          } else out(cmdOut);
        }
      } catch (err) {
        // Esc 带内取消（TUI 批 T3/D52③）静默回提示符——「[错误] 已取消（Esc）」行是噪音
        // （2026-09-20 用户实测拍板，推翻方案 v1.9「[错误] 呈现为可接受取舍」的留档）。机制不变：
        // 取消仍以抛错带内表达，仅 REPL 呈现面不再按错误打印。
        // 其余错误 toast 化（2026-09-23 用户拍板）：未知命令/路由失败等瞬时错误不落流区（消息原文本就自描述）
        settleCommandError(err); // 政策件提取（2026-09-24）——runSubmit 网兜共用同一政策
      }
  return "again";
};

/** 全屏模式循环（TUI 批阶段三 F3）：FullApp 接管终端（alt-screen 双栏），
 *  Ctrl+T → 切回滚动流（requestLineMode 改写 tuiMode）；Ctrl+C → 退出；会话生命周期指令 → switch 重挂。
 *  提交走 processReplLine 共用体（输出通道 = dm.pushLine——console 输出在全屏下毁屏）。 */
// ---------- 全屏面板数据与斜杠清单（F4——真实数据源接线；原型图右栏组件清单逐行） ----------

/** /settings 二级菜单五项（SW-18 定案——/other 改名 /settings，别名 /config；前四项渲染原四子项面板，
 *  第五项「配置网络搜索」进 tool-web__settings 三级配置流。数据源 = harness 读口 h.usage()/h.status()）。 */

const SETTINGS_ITEMS = [
	"磁盘占用（各目录大小与清理口径）",
	"上下文用量（窗口占用与输入输出累计）",
	"Token 用量（本会话与项目累计）",
	"运行状态（模型 / 会话 / 模块图）",
	"子代理（模型 / 审批模式 / 轮数上限）",
	"技能（查看 / 启停——四轨目录全部技能）",
	"MCP（查看 / 开关 / 删除——server 管理与添加）",
	"配置视觉模型（停用 / 自动 / 指定——给非多模态模型提供视觉）",
	"配置网络搜索（LLM Web Search / Tavily / Brave）",
];
/** 第五项 = 调 web 模块自有命令（模块命令 + host 挂菜单的 approval__permission 先例）；空串 = 静默成功/取消（notice 承担反馈）。 */
const runSearchSettings = async (): Promise<string> => ((await h.prompt("/tool-web__settings")) ?? "").trim();
/** 已配置槽的多模态模型清单（F14——§2.5 遮蔽坑免疫：按槽条目内**精确键**逐槽查，禁全目录尾段扫；
 *  live /models 出的目录外模型无法验视觉能力——不列〔诚实〕；目录缺席 = 空清单走空态指路）。 */
const visionCandidates = async (): Promise<string[]> => {
	const providers = await defaultMenuDeps().loadProviders();
	const catalog = readCatalogDiskCache(defaultCatalogCacheFile()) ?? {}; // 与拦截段同源（provider-custom 盘上缓存口）
	const out: string[] = [];
	for (const slot of Object.keys(providers)) {
		const entry = catalog[slot];
		if (entry === undefined) continue;
		for (const [key, m] of Object.entries(entry.models ?? {})) {
			if (m.modalities?.input?.includes("image") === true) out.push(`${slot}/${key}`);
		}
	}
	return out;
};

/** F14 视觉模型配置流（chooseVia = 子代理三件同款双态抽象）。D12 三态；写盘后 /reload 生效（模块配置）。 */
const runVisionSetting = async (
	chooseVia: (title: string, items: string[]) => Promise<string>,
	configFile: () => string,
): Promise<{ wrote: boolean; message: string }> => {
	const cur = readVisionModel(configFile());
	const curNote = cur === "off" ? "停用" : cur === "auto" ? "自动" : cur;
	const OPTS = ["停用（默认——不生成视觉摘要，降级图只留路径标签）", "自动（当前模型支持图片时直接用它）", "指定模型（从已配置提供商的多模态模型中选）"];
	const picked = await chooseVia(`配置视觉模型（当前：${curNote}）`, OPTS);
	if (picked === OPTS[0]) {
		persistVisionModel(configFile(), "off");
		return { wrote: true, message: "已设为停用" };
	}
	if (picked === OPTS[1]) {
		persistVisionModel(configFile(), "auto");
		return { wrote: true, message: "已设为自动" };
	}
	const candidates = await visionCandidates();
	if (candidates.length === 0) {
		return { wrote: false, message: "已配置的提供商里没有目录可证的多模态模型——先 /provider 配置视觉模型所在的提供商（或给模型正确的目录名）" };
	}
	const model = await chooseVia("指定视觉模型（多模态模型 · 已按提供商过滤）", candidates);
	persistVisionModel(configFile(), model);
	return { wrote: true, message: `已指定视觉模型 ${model}` };
};

/** F14 眼睛模型可用性（发送闸旁路判定——与 tool-media/vision.ts eyeModelOf 同判定口径的 CLI 侧实读）：
 *  读 [tool-media] visionModel 三态：off=未配置；auto=当前模型视觉才可用（跨槽挑模块侧不可达，同收窄口径）；
 *  指定=槽已配置且目录**条目内精确键**证实多模态（遮蔽坑免疫）。configured=true 但 usable=false 时 why 带原因。 */
const eyeModelUsable = async (
  modelNow: string,
  catalogAll: import("@orosus/provider-custom").Catalog,
): Promise<{ configured: boolean; usable: boolean; model?: string; why?: string }> => {
  const v = readVisionModel(moduleConfigFileFor("tool-media", h));
  if (v === "off") return { configured: false, usable: false };
  if (v === "auto") {
    if (lookupModelVision(catalogAll, modelNow) === true) return { configured: true, usable: true, model: modelNow };
    return { configured: true, usable: false, why: `auto 档且当前模型 ${modelNow || "（未配置）"} 非视觉` };
  }
  const slot = v.split("/")[0] ?? "";
  const key = v.slice(slot.length + 1);
  const providers = await defaultMenuDeps().loadProviders();
  if (providers[slot] === undefined) return { configured: true, usable: false, why: `槽 "${slot}" 未配置` };
  const mm = catalogAll[slot]?.models?.[key];
  if (mm === undefined) return { configured: true, usable: false, why: `目录无 ${v}` };
  if (mm.modalities?.input?.includes("image") !== true) return { configured: true, usable: false, why: `目录证实 ${v} 非多模态` };
  return { configured: true, usable: true, model: v };
};

/** 扩展名 → 图片 mime（describe 参数用——贴图/媒资库件均按扩展名落盘）。 */
const extImageMime = (path: string): "image/png" | "image/jpeg" | "image/webp" | "image/gif" => {
  const e = path.slice(path.lastIndexOf(".")).toLowerCase();
  return e === ".jpg" || e === ".jpeg" ? "image/jpeg" : e === ".webp" ? "image/webp" : e === ".gif" ? "image/gif" : "image/png";
};

/** 转述等待结果（走查四）：done=至少一图转述成功（text=逐图文本聚合）；failed=全失败/服务缺席
 *  （回落纯占位照发）；aborted=双 Esc 中止（不发送、输入回挂）。 */
type VisionWaitResult = { state: "done"; text: string } | { state: "failed" } | { state: "aborted" };
/** 转述等待中止口（模块级单等待——等待期二次提交被发送闸拦；fullapp 双击 Esc 经 io 触发）。 */
let visionWaitAbort: (() => void) | undefined;

/** 转述等待（可中止）：服务缺席静默回落 failed；底层 describe 调用不掐——中止后结果照常落
 *  .summary.txt（重发命中缓存零等待——「中止不白等」），占位富化最终一致口径不变。
 *  onDelta（A 案 2026-10-02 拍板）：流式增量喂 DocModel 转述活动块（思考/正文流式显示防卡死感）。 */
const waitVisionTranscribe = async (imgs: string[], onDelta?: (d: { kind: "thinking" | "text"; text: string }) => void): Promise<VisionWaitResult> => {
  const svc = await h.graph().services.getOptional("tool-media.vision-summary" as never).catch(() => undefined);
  const describe = (svc as { describe?: (images: { path: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }[], onDelta?: (d: { kind: "thinking" | "text"; text: string }) => void) => Promise<{ path: string; text?: string }[]> } | undefined)?.describe;
  const aborted = new Promise<{ state: "aborted" }>((resolve) => { visionWaitAbort = () => resolve({ state: "aborted" }); });
  // live 旗（A 案泄漏口）：中止后底层调用不掐、增量还会来——迟到增量不得复活已清空的活动块
  let live = true;
  const feed = onDelta === undefined ? undefined : (d: { kind: "thinking" | "text"; text: string }) => { if (live) onDelta(d); };
  try {
    const raced: VisionWaitResult | undefined = describe === undefined
      ? undefined
      : await Promise.race([
          describe(imgs.map((path) => ({ path, mimeType: extImageMime(path) })), feed)
            .then((entries): VisionWaitResult => {
              const texts = entries.map((x) => x.text).filter((t): t is string => t !== undefined && t !== "");
              return texts.length > 0 ? { state: "done", text: texts.join("\n") } : { state: "failed" };
            })
            .catch((): VisionWaitResult => ({ state: "failed" })),
          aborted,
        ]);
    return raced ?? { state: "failed" };
  } finally {
    live = false;
    visionWaitAbort = undefined;
  }
};


/** /tasks（M4.5 T11 / 决策 21-22）：子代理任务列表（含孙代理亲缘分组）→ 回车看查看窗 / 应答挂起审批。
 *  全屏走 app.pickOverlay（原生列表弹窗）；行模式走 commandUi.choose（readline）。
 *  2026-09-27 拍板：查看窗 Esc 关闭后回列表页（不是一路关到底）——全屏循环里查看窗之后的
 *  pickOverlay 落 m5 T2 的 FIFO 队列（pendingUi 被查看窗占着），关窗即自动回列表；行模式无弹窗栈，一轮即止。 */
const openTasks = async (app: FullApp | undefined, out: (s: string) => void): Promise<void> => {
	for (;;) {
		// 名册合并（2026-09-27 拍板：不删旧数据就得能查看）：活名册（本进程）∪ 盘上历史（agents/ 目录重建，
		// 简述/后台/工种从主会话 spawn 调用回查），按 id 去重——活名册优先（状态新鲜带 truncated）；
		// 排序最新在最上（用户拍板：第一页永远是最新，上一轮对话的派单自然沉为历史）。每轮现取——
		// 查看窗停留期间状态会变（跑完/新增），回列表该是新鲜册
		const live = h.subagents();
		const liveIds = new Set(live.map((e) => e.id));
		const entries = sortNewestFirst([...live, ...loadHistoricalSubagents(sessionsDir, h.sessionId).filter((e) => !liveIds.has(e.id))]);
		// 空册也开列表（用户拍板 2026-09-27：/tasks 无条件开）——占位行说明派活方式，回车无事发生
		const rows = entries.length > 0 ? tasksListRows(entries) : [emptyTasksRow()];
		let idx: number;
		if (app !== undefined) {
			const picked = await app.pickOverlay("子代理任务（回车查看 · 等审批的可应答）", rows);
			if (picked === undefined || entries.length === 0) return; // Esc / 空态占位行
			idx = picked;
		} else {
			const picked = await commandUi.choose("子代理任务（回车查看 · 等审批的可应答）", rows);
			if (entries.length === 0) return;
			idx = rows.indexOf(picked);
			if (idx < 0) return;
		}
		// 选中行 → 名册条目（CM-02 修复）：rows 经 tasksListRows 亲缘重排（孙行紧跟父行、孤儿孙补位），
		// 显示行下标与 entries（sortNewestFirst 时间序）位次错开——孙代理在场时 entries[idx] 是另一条
		// （选 A 执行 B：查看窗开错会话流、审批答错子代理）。经 taskIdOfRow 从选中行反查编号、再按 id
		// 找真条目（tasks-cmd 既有件，行模式 choose 回串解析同源）。
		const pickedId = taskIdOfRow(rows[idx]!);
		const entry = pickedId === undefined ? undefined : entries.find((e) => e.id === pickedId);
		if (entry === undefined) return; // 行解析不出编号（理论不可达）——安全退出而非错配条目
		// 等审批的行 → 应答（决策 3 第二层「有空再批」的出口；同 commandUi 串行队列）——应答完回列表；
		// 应答菜单的 Esc 不答也不退出（2026-09-28 拍板「Esc 返回上一级」）——回任务列表
		if (entry.pendingApproval !== undefined) {
			try {
				const ans = await commandUi.choose(`子代理审批 ${entry.id} ${entry.label} · ${entry.pendingApproval.tool}（${entry.pendingApproval.reason}）`, ["批准一次", "拒绝"]);
				const allow = ans === "批准一次";
				h.answerSubagentApproval(entry.id, allow);
				notify(allow ? `已批准 ${entry.id} 的 ${entry.pendingApproval.tool}` : `已拒绝 ${entry.id} 的 ${entry.pendingApproval.tool}`);
			} catch (err) {
				if (err instanceof Error && err.message === "已取消（Esc）") continue; // Esc → 回列表（审批保持挂起）
				throw err;
			}
			continue;
		}
		// 查看窗（决策 22：顶栏 + 消息流主窗口同款渲染；跑着的实时刷——live 每帧现读会话文件）。
		// 折行宽 = 全终端宽 − 盒框 4 列（2026-09-27 拍板：按全窗口大小折行，不是 78 定宽——live 每帧现取，拖宽即时回流）
		const viewW = (): number => Math.max(40, (process.stdout.columns ?? 80) - 4);
		// 内容快捷键与主窗一致（走查④，2026-09-29）：Alt+E/O/F 切查看窗内思考/工具明细/失败体折叠态——
		// 折叠态在闭包（跨 live 刷新保持，每次开窗默认收起与主窗同）；键提示行显示「思考 · 明细 · 失败」
		const fold: import("./tasks-cmd.ts").AgentViewFoldState = { thinkOpen: false, toolOpen: false, errOpen: false };
		const eventsNow = (): readonly { type: string; [k: string]: unknown }[] => agentEventsFromFile(sessionsDir, h.sessionId, entry.id);
		const renderNow = (): string =>
			renderAgentView(h.subagents().find((e) => e.id === entry.id) ?? entry, eventsNow(), viewW(), fold);
		const liveView = entry.status === "queued" || entry.status === "running" ? () => renderNow() : undefined;
		const body = renderNow();
		if (app !== undefined) {
			app.viewText(`子代理 ${entry.id} · ${entry.label}`, body, {
				layout: "full",
				bottom: true, // 2026-09-27 拍板：全屏 + 自动滚底（实时刷跟随末页）
				...(liveView !== undefined ? { live: liveView } : {}),
				keys: {
					"alt+e": { label: "思考", run: () => { fold.thinkOpen = !fold.thinkOpen; return renderNow(); } },
					"alt+o": { label: "明细", run: () => { fold.toolOpen = !fold.toolOpen; return renderNow(); } },
					"alt+f": { label: "失败", run: () => { fold.errOpen = !fold.errOpen; return renderNow(); } },
				},
			});
			continue; // 查看窗排在 pendingUi——Esc 关窗后队里的列表自动顶上（回列表页拍板）
		}
		out(body);
		return; // 行模式一轮即止（无弹窗栈可回）
	}
};

/** /settings → 技能（m4-7 T8/T9，原型图 2/3/4）：列表页（全收口径——含停用与仅手动者）→ 详情页
 *  （五字段 + Alt + K 启停）。数据源 = skill.catalog 服务现取（与 T7 菜单同链）+ disabled 现读盘覆盖
 *  （busy 期 reload 缓挂、catalog 停用快照滞后——盘是 Alt + K 即时写的，以盘为准）。 */
const skillCatalogRows = async (): Promise<SkillCatalogRow[]> => {
	const catalog = await h.graph().services.getOptional("skill.catalog");
	const rows = typeof catalog === "function" ? (catalog as () => SkillCatalogRow[])() : [];
	const disabledNow = new Set(readSkillDisabled(subagentConfigFile()));
	for (const r of rows) r.disabled = disabledNow.has(r.name);
	return rows;
};
/** Alt + K 写配置后的收尾（T9）：空闲走 /reload 同链（清单即刻生效——/reload 自有完成反馈不另 toast）；
 *  busy 不 reload 只 toast（图 4 三要素：动作 · 原因 · 出路）。返回 toast 文案（空 = 空闲路径无 toast）。
 *  busy 判定 = 全屏 stateRef.busy 现读（inflight 是 runFullScreen 局部，模块级取不到）；行模式
 *  /settings 在 busy 期排队到 turn 结束才执行——走到这里必然空闲，直接 reload 安全。 */
/** 写模块配置后的收尾（共用件——Alt+K 技能启停 T9 / F14 视觉模型两处）：空闲走 /reload 同链
 *  （清单即刻生效——reload 链自带标签表/技能菜单/面板重喂；失败 toast 三要素）；busy 不 reload 只 toast。
 *  busy 判定 = 全屏 stateRef.busy 现读（inflight 是 runFullScreen 局部，模块级取不到）；行模式
 *  /settings 在 busy 期排队到 turn 结束才执行——走到这里必然空闲，直接 reload 安全。 */
const reloadModulesIdle = (app: FullApp | undefined, busyToast: string): string => {
	if (app === undefined || !app.stateRef.busy) {
		void (async () => {
			try {
				const namesBefore = activeModuleNames();
				await h.reload();
				closeGoneModuleUi(namesBefore);
				registerToolLabels(h.graph().tools.toolInfos());
				void refreshSkillMenu();
				await refreshPanel();
			} catch (err) {
				(app ?? activeApp)?.showToast(`重载失败：${err instanceof Error ? err.message : String(err)}（已写配置，可 /reload 或重启对齐）`);
			}
		})();
		return "";
	}
	return busyToast;
};

/** Alt + K 写配置后的收尾（T9）：共用件之上拼技能启停文案（图 4 三要素：动作 · 原因 · 出路）。 */
const afterSkillToggle = (app: FullApp | undefined, name: string, nowDisabled: boolean): string =>
	reloadModulesIdle(app, `${nowDisabled ? "已停用" : "已启用"} ${name} · 有任务在执行，稍后请输入 /reload 重新加载`);
const openSkillsPanel = async (app: FullApp): Promise<void> => {
	let selAt = 0; // 详情 Esc 回列表——选中行回到该技能（原型图 3 要点；pickOverlay selAt 参数）
	for (;;) {
		const rows = await skillCatalogRows();
		if (rows.length === 0) {
			app.showToast("没有可用技能（扫描 ~/.agents/skills 等四轨目录，每目录下 <名>/SKILL.md）");
			return;
		}
		// 行宽与 pick 渲染同源（m4-7 走查修 2026-09-27：原按全终端列数拼行——侧栏在场时超宽把右框 │ 推错位）
		const w = app.pickRowWidth();
		// items 数组长期持有（2026-09-27 用户走查拍板「改变状态后要更新上一级列表」）：详情 Alt + K 后
		// 原地重拼该行——Esc 回列表顶上的正是这个排队的 pickOverlay（持同数组引用），状态列即时新
		const items = rows.map((r) => skillListRow(w, r));
		const picked = await app.pickOverlay("技能（回车查看详情）", items, selAt);
		if (picked === undefined || picked < 0 || picked >= rows.length) return; // Esc 返回设置
		selAt = picked;
		const row = rows[picked]!;
		const detail = (): string => skillDetailText(w, row); // dock 窗（贴输入框上缘、左栏同宽）行预算
		// dock（2026-09-27 用户拍板：原 center80 居中弹窗位置/宽度都不对——贴输入框上边缘 + 与输入框同宽）
		app.viewText("技能详情", detail(), { layout: "dock", keys: {
				"alt+k": {
					label: "Alt + K 启用或停用",
					run: (): string => {
						const nowDisabled = toggleSkillDisabled(row.name, subagentConfigFile());
						row.disabled = nowDisabled;
						items[picked] = skillListRow(w, row); // 上一级列表行原地更新（回列表即见新状态）
						const toast = afterSkillToggle(app, row.name, nowDisabled);
						if (toast !== "") app.showToast(toast); // busy 缓后（图 4）
						return detail(); // 状态行即时翻转（内容替换）
					},
				},
			},
		});
		// viewText 入队不 await——Esc 关详情后循环重入的 pickOverlay 排队顶上（回列表；openTasks 同款结构）
	}
};
/** 行模式对等件（m4-7 T8/T9）：列表 choose → 详情文本直出 → 动作菜单（停用/启用 · 返回列表）。 */
const openSkillsLine = async (out: (s: string) => void): Promise<void> => {
	for (;;) {
		const rows = await skillCatalogRows();
		if (rows.length === 0) { out("没有可用技能（扫描 ~/.agents/skills 等四轨目录，每目录下 <名>/SKILL.md）"); return; }
		const names = rows.map((r) => skillListRow(76, r));
		const picked = await commandUi.choose("技能（回车查看详情）", names);
		const i = names.indexOf(picked);
		if (i < 0) return;
		const row = rows[i]!;
		out(skillDetailText(76, row));
		try {
			const action = await commandUi.choose(row.name, [row.disabled ? "启用" : "停用（Alt + K 同款）", "返回列表"]);
			if (action === "启用" || action === "停用（Alt + K 同款）") {
				const nowDisabled = toggleSkillDisabled(row.name, subagentConfigFile());
				const toast = afterSkillToggle(undefined, row.name, nowDisabled);
				out(toast !== "" ? toast : `已${nowDisabled ? "停用" : "启用"} ${row.name}（模块已重载，清单即刻生效）`);
			}
		} catch (err) {
			if (err instanceof Error && err.message === "已取消（Esc）") continue; // Esc → 回技能列表（2026-09-28 拍板）
			throw err;
		}
	}
};

const isEsc = (err: unknown): boolean => err instanceof Error && err.message === "已取消（Esc）";

// ---------- MCP 管理面（m4-3c T17——列表四段行 / 详情六字段 / Alt + K 启停 / d 两拍删除 / Alt + N 添加窗） ----------

/** mcp.catalog 服务现取（模块未启用 = 空表——面板给指路文案）。 */
const mcpCatalogRows = async (): Promise<McpCatalogRow[]> => {
	const catalog = await h.graph().services.getOptional("mcp.catalog");
	return typeof catalog === "function" ? (catalog as () => McpCatalogRow[])() : [];
};
let mcpPanelCatalog: (() => McpCatalogRow[]) | undefined; // 面板期缓存上一轮服务值（runMcpCommand 同步消费）
const mcpWarmCatalog = (): void => {
	void h.graph().services.getOptional("mcp.catalog").then((cat) => { mcpPanelCatalog = typeof cat === "function" ? (cat as () => McpCatalogRow[]) : undefined; }).catch(() => undefined);
};
/** 面板版命令依赖（catalog 服务现取——启停与删除共用 /mcp 命令族的写盘与守卫）。 */
const mcpPanelDeps = (): McpCmdDeps => ({ ...defaultMcpCmdDeps(), ...(mcpPanelCatalog !== undefined ? { catalogRows: mcpPanelCatalog } : {}) });

// ---------- 「网络 · MCP」卡供数（2026-10-01 拍板填实：被动真值——首连耗时/末次请求耗时，不做主动探测） ----------

/** mcp.catalog 服务行 → 卡连接行投影（五态原文照传，渲染期映射点色；说明段 = 传输型 + 工具数）。 */
const mcpConnRows = (): PanelNetwork["connections"] => {
	mcpWarmCatalog(); // panelData 每秒 tick 现读——顺带保温服务缓存（模块未启用 = 空表）
	const rows = mcpPanelCatalog?.() ?? [];
	return rows.map((r) => ({
		name: r.name,
		state: r.state,
		desc: `${r.transport === "http" ? "HTTP" : "stdio"}${r.toolCount !== undefined ? ` · ${r.toolCount} 工具` : ""}`,
		...(r.state === "connected" && r.connectMs !== undefined ? { connectMs: r.connectMs } : {}),
	}));
};

/** provider 条目表 TTL 缓存（skillMenu 5s 同款惯例——/provider 菜单改端点后最迟 5s 反映到卡）。 */
let providersCache: { at: number; providers: Record<string, ProviderEntry> } | undefined;
const providersTtl = async (): Promise<Record<string, ProviderEntry>> => {
	const now = Date.now();
	if (providersCache === undefined || now - providersCache.at > 5000) {
		providersCache = { at: now, providers: await defaultMenuDeps().loadProviders() };
	}
	return providersCache.providers;
};

/** 模型服务信息行（2026-10-01 拍板②按倾向留——纯信息行不主张连接状态）：端点域名 + 末次请求耗时
 *  （assistant/message.durationMs 投影，老会话无字段则只显端点）。refreshPanel 异步预取进 panelCache。 */
const modelServiceOf = async (events: SessionEvent[]): Promise<string> => {
	const v = realReadModel(process.cwd())() ?? "";
	if (v === "") return "（未配置——/provider 配置）";
	const providerName = v.includes("/") ? v.split("/")[0]! : v;
	const entry = (await providersTtl())[providerName];
	let host = providerName;
	if (entry !== undefined) {
		try {
			host = new URL(entry.baseUrl).host;
		} catch {
			host = entry.baseUrl; // 无 scheme 形态原样显示（kvRow 行内截断兜底）
		}
	}
	const lastMs = lastRequestMsOf(events);
	return lastMs === undefined ? host : `${host} · 末次 ${msText(lastMs)}`;
};
/** 配置文件里的原表值（修改窗预填——名称锁定的真身）。 */
const configuredMcpServer = (name: string): Record<string, unknown> => {
	try {
		const p = defaultMcpCmdDeps().configPath();
		const doc = tomlParse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")) as { mcp?: { servers?: Record<string, Record<string, unknown>> } };
		return doc.mcp?.servers?.[name] ?? {};
	} catch { return {}; }
};
/** MCP 写配置后的收尾（同 afterSkillToggle 口径）：空闲重载生效、busy 缓后 toast。 */
const afterMcpWrite = (app: FullApp | undefined, doneText: string): string => {
	if (app === undefined || !app.stateRef.busy) {
		void (async () => {
			try {
				const namesBefore = activeModuleNames();
				await h.reload();
				closeGoneModuleUi(namesBefore);
				registerToolLabels(h.graph().tools.toolInfos());
				void refreshSkillMenu();
				await refreshPanel();
			} catch (err) {
				(app ?? activeApp)?.showToast(`重载失败：${err instanceof Error ? err.message : String(err)}（已写配置，可 /reload 或重启对齐）`);
			}
		})();
		return doneText;
	}
	return `${doneText} · 有任务在执行，稍后请输入 /reload 重新加载`;
};
const runMcpToggle = async (app: FullApp | undefined, row: McpCatalogRow): Promise<string> => {
	// 懒 server 的「启动」语义（2026-09-30「待启动态按启停=被停用」陷阱修）：待启动/首启失败的预装件，
	// 用户按 Alt + K 的意图是「启动它」不是「停用它」——触发手动连接（mcp.start 服务；与首调共用
	// memoized 连接，schema 补丁/落盘缓存照常走）。停用路径留给已连接态与停用态翻转。
	if (row.deferred === true && (row.state === "idle" || row.state === "failed")) {
		if (app === undefined) return "";
		try {
			const start = await h.graph().services.getOptional("mcp.start");
			if (typeof start !== "function") {
				app.showToast("mcp 模块未提供启动口——重启 CLI 后再试");
				return "";
			}
			app.showToast(`正在启动 ${row.name}（首次可能需要下载，最长 60 秒）…`);
			await (start as (name: string) => Promise<void>)(row.name);
			app.showToast(`已连接 ${row.name}——工具就绪`);
		} catch (err) {
			app.showToast(`启动 ${row.name} 失败：${err instanceof Error ? err.message : String(err)}`);
		}
		return "";
	}
	const enable = row.state === "disabled";
	const r = await runMcpCommand(`${enable ? "on" : "off"} ${row.name}`, mcpPanelDeps());
	row.state = enable ? (row.source === "preload" ? "idle" : "failed") : "disabled"; // 重载前乐观翻转（重载后 catalog 重算）
	return afterMcpWrite(app, r.text);
};

const openMcpPanel = async (app: FullApp): Promise<void> => {
	let selAt = 0;
	for (;;) {
		mcpWarmCatalog();
		const rows = await mcpCatalogRows();
		const w = app.pickRowWidth();
		const items = [
			...rows.map((r) => mcpListRow(w, r)),
			...(rows.length === 0 ? [theme.fg("muted", "（还没有 MCP server——按 Alt + N 或回车添加第一个）")] : []),
		];
		let addRequested = false;
		const picked = await app.pickOverlay(
			`MCP（${rows.length} 个 server${rows.length === 0 ? "" : " · 预装按需启动"}）`,
			items,
			selAt,
			{
				"alt+n": { label: "Alt + N 添加", run: (ctrl): boolean => { addRequested = true; ctrl.close(); return true; } },
				"alt+k": { label: "Alt + K 启停", run: (): boolean => { app.showToast("列表页拿不准选中行——回车进详情再 Alt + K"); return true; } },
			},
		);
		if (addRequested || (rows.length === 0 && picked !== undefined)) {
			mcpWarmCatalog();
			const existing = (await mcpCatalogRows()).map((r) => r.name);
			openMcpAddWindow(app, {
				mode: "add",
				configPath: defaultMcpCmdDeps().configPath(),
				existingNames: existing,
				onSaved: (name) => { void afterMcpWrite(app, `已添加 ${name}（模块图重载中）`); },
			});
			continue; // 窗 Esc 关后循环重开列表（行集现取）
		}
		if (picked === undefined) return; // Esc → 回设置根列表
		if (picked < 0 || picked >= rows.length) continue;
		selAt = picked;
		const row = rows[picked]!;
		items[picked] = mcpListRow(w, row);
		app.viewText(`${row.name} · MCP server`, mcpDetailText(w, row), { layout: "dock", keys: mcpDetailKeys(app, row, items, picked) });
	}
};

/** 详情窗键位构造（T17 主循环与 T18 菜单直达共用）：Alt + K 启停 / Alt + N 修改 / d 两拍删除。 */
const mcpDetailKeys = (app: FullApp, row: McpCatalogRow, items: string[], picked: number): Record<string, import("@orosus/contracts/module").PopupKey> => {
	let deleteArm = false;
	let detailMsg = "";
	const w = app.pickRowWidth();
	const detail = (): string => (detailMsg === "" ? mcpDetailText(w, row) : `${mcpDetailText(w, row)}\n${theme.fg("muted", detailMsg)}`);
	return {
		"alt+k": {
			label: "Alt + K 启停",
			run: (): string => {
				void runMcpToggle(app, row).then((t) => { if (t !== "") app.showToast(t); });
				items[picked] = mcpListRow(w, row);
				return detail();
			},
		},
		"alt+n": {
			label: "Alt + N 修改",
			run: (): string => {
				if (row.source !== "config") {
					detailMsg = row.source === "project"
						? "此 server 来自项目 .mcp.json——Orosus 不改它的来源；停用用 Alt + K（用户层覆盖）"
						: "预装 server 不可修改——只能停用（Alt + K）";
					return detail();
				}
				mcpWarmCatalog();
				openMcpAddWindow(app, {
					mode: "edit",
					row,
					original: configuredMcpServer(row.name),
					configPath: defaultMcpCmdDeps().configPath(),
					existingNames: [],
					onSaved: (name) => { void afterMcpWrite(app, `已修改 ${name}（模块图重载中）`); },
				});
				return detail();
			},
		},
		// d 删除只挂手写条目（2026-09-30 用户拍板「预装不允许删除」）：预装/项目行不注册 d——
		// 键位行不显示、按下走浮层默认键（不引导尝试；详情文本另有「只能停用不能删除」说明行）
		...(row.source === "config" ? {
			d: {
				label: "d 删除",
				run: (): string => {
					if (!deleteArm) {
						deleteArm = true; // 两拍制（设计空白拍板：弹窗里误按一下不该直接删配置）
						detailMsg = `再按一次 d 确认删除 ${row.name} · 按其他键取消`;
						return detail();
					}
					void runMcpCommand(`remove ${row.name}`, mcpPanelDeps()).then((r) => {
						const t = r.wrote ? afterMcpWrite(app, r.text) : r.text;
						if (t !== "") app.showToast(t);
					});
					return "close";
				},
			},
		} : {}),
		t: {
			// 确认信任（2026-09-30 /mcp 命令退役后确认门的新家）：仅未确认态生效——核对指纹后按 t
			// 写 mcp-trust.json 并重载连接；其余态按下无感（键位行恒定防闪烁——标签只随未确认态显示提示）
			label: row.state === "pending-confirm" ? "t 确认" : "",
			run: (): string => {
				if (row.state !== "pending-confirm") return detail();
				void runMcpCommand(`trust ${row.name}`, mcpPanelDeps()).then((r) => {
					const t = r.wrote ? afterMcpWrite(app, r.text) : r.text;
					if (t !== "") app.showToast(t);
				});
				return "close"; // 确认即收窗回列表（重载后状态翻绿）
			},
		},
	};
};

/** 行模式对等件（m4-3c T17）：列表 choose → 详情直出 → 动作菜单。 */
const openMcpLine = async (out: (s: string) => void): Promise<void> => {
	for (;;) {
		mcpWarmCatalog();
		const rows = await mcpCatalogRows();
		const w = 76;
		const items = [...rows.map((r) => mcpListRow(w, r)), ...(rows.length === 0 ? ["（还没有 MCP server——添加用 /mcp add 名字 命令或URL）"] : [])];
		let picked: number;
		try {
			const chosen = await commandUi.choose("MCP（回车查看详情）", items);
			picked = items.indexOf(chosen);
		} catch (err) {
			if (isEsc(err)) return;
			throw err;
		}
		if (picked < 0) return;
		if (rows.length === 0 || picked >= rows.length) continue;
		const row = rows[picked]!;
		out(mcpDetailText(w, row));
		try {
			const actions = [row.state === "disabled" ? "启用（Alt + K 同款）" : "停用（Alt + K 同款）"];
			if (row.state === "pending-confirm") actions.push("确认（信任 t 键同款）");
			if (row.source === "config") actions.push("删除");
			actions.push("返回列表");
			const action = await commandUi.choose(row.name, actions);
			if (action === "启用（Alt + K 同款）" || action === "停用（Alt + K 同款）") {
				out(await runMcpToggle(undefined, row));
			} else if (action === "确认（信任 t 键同款）") {
				const r = await runMcpCommand(`trust ${row.name}`, mcpPanelDeps());
				out(r.wrote ? afterMcpWrite(undefined, r.text) : r.text);
			} else if (action === "删除") {
				const r = await runMcpCommand(`remove ${row.name}`, mcpPanelDeps());
				out(r.wrote ? afterMcpWrite(undefined, r.text) : r.text);
			}
		} catch (err) {
			if (err instanceof Error && err.message === "已取消（Esc）") continue;
			throw err;
		}
	}
};

const openSettingsPanel = async (app: FullApp): Promise<void> => {
	// 子菜单/子窗 Esc 返回根列表（2026-09-28 用户拍板「子菜单 Esc 返回上一级」）：根列表本身的 Esc = 收面。
	// 只读子窗走 /tasks 同款 FIFO——viewText 占槽期循环重入的 pickOverlay 排队，关窗即自动顶上回根列表
	for (;;) {
		const picked = await app.pickOverlay("设置", SETTINGS_ITEMS);
		if (picked === undefined) return; // 根列表 Esc：整面收起
		// 五个只读子窗一律 dock（2026-09-28 用户走查打回 m5 T2 的居中长相：贴输入框上缘——技能详情窗同款）
		if (picked === 0) app.viewText("磁盘占用", diskUsageText(), { layout: "dock" });
		else if (picked === 1) app.viewText("上下文用量", ctxUsageText(panelCache), { layout: "dock" });
		else if (picked === 2) app.viewText("Token 用量", await tokenUsageText(h), { layout: "dock" });
		else if (picked === 3) app.viewText("运行状态", runtimeStatusText(h), { layout: "dock" });
		else if (picked === 4) {
			// M4.5 T12：子代理分组项 → 两子项（决策 7/23）——模型复用 /model 两段选换数据源、审批三档中文名。
			// 子菜单循环：子项内的 Esc 回子菜单（配置未写零副作用），子菜单的 Esc 回设置根列表
			for (;;) {
				const sub = await app.pickOverlay("子代理", ["子代理模型", "审批模式", "轮数上限"]);
				if (sub === undefined) break; // Esc → 回设置根列表
				const chooseVia = async (t: string, items: string[]): Promise<string> => {
					const i = await app.pickOverlay(t, items);
					if (i === undefined) throw new Error("已取消（Esc）");
					return items[i] ?? "";
				};
				try {
					if (sub === 0) {
						const res = await runSubagentModelSetting(chooseVia, subagentConfigFile(), modelSlotList(h));
						if (res !== "") app.showToast(res);
					} else if (sub === 1) {
						const res = await runSubagentApprovalSetting(chooseVia, subagentConfigFile());
						if (res !== "") app.showToast(res);
					} else if (sub === 2) {
						const res = await runSubagentMaxTurnsSetting(chooseVia, (t) => app.promptInput(t, false).then((v) => { if (v === undefined) throw new Error("已取消（Esc）"); return v; }), subagentConfigFile());
						if (res !== "") app.showToast(res);
					}
				} catch (err) {
					if (err instanceof Error && err.message === "已取消（Esc）") continue; // 子项内 Esc → 回子菜单
					throw err;
				}
			}
		}
		else if (picked === 5) await openSkillsPanel(app); // 技能面板自身管列表↔详情逐级返回；其根列表 Esc = 退出面板 → 回设置根列表
		else if (picked === 6) await openMcpPanel(app); // MCP 管理面（m4-3c T17）：面板自身管逐级返回
		else if (picked === 7) {
			// F14 视觉模型：chooseVia 内取消（Esc）= 整支放弃回设置根列表
			try {
				const res = await runVisionSetting(
					async (t, items) => { const i = await app.pickOverlay(t, items); if (i === undefined) throw new Error("已取消（Esc）"); return items[i] ?? ""; },
					() => moduleConfigFileFor("tool-media", h),
				);
				// 写盘即自动重载（空闲）；busy（消息接收中）不 reload 只提示——reloadModulesIdle 共用件
				if (res.wrote) {
					const busyNote = reloadModulesIdle(app, "有任务在执行，稍后 /reload 生效");
					app.showToast(busyNote === "" ? `${res.message}，已重载生效` : `${res.message}——${busyNote}`);
				} else app.showToast(res.message);
			} catch (err) {
				if (err instanceof Error && err.message === "已取消（Esc）") continue;
				throw err;
			}
		}
		else if (picked === 8) {
			// 顶层后端菜单的 Esc → 回设置根列表（更深的 Esc 已在 tool-web 模块内逐级返回）
			try {
				const res = await runSearchSettings();
				if (res !== "") app.viewText("配置网络搜索", res, { layout: "dock" }); // 成功路径走 notice/toast 静默约定——非空输出才落面板
			} catch (err) {
				if (err instanceof Error && err.message === "已取消（Esc）") continue;
				throw err;
			}
		}
	}
};
/** 行模式对等件（2026-09-24 T1c：/other 时代行模式只有指路——配置流两态都要能走，菜单随之对等）：
 *  同一五项经 commandUi.choose（readline）；面板文本直出（out = processReplLine 的输出通道参数）。 */
const openSettingsLine = async (out: (s: string) => void): Promise<void> => {
	// Esc 逐级返回（2026-09-28 用户拍板，全屏对等件）：根菜单 Esc 穿透（宿主静默）；子级 Esc 回上级
	for (;;) {
		const picked = await commandUi.choose("设置", SETTINGS_ITEMS); // 根 Esc 穿透——整面收起
		const idx = SETTINGS_ITEMS.indexOf(picked);
		if (idx === 0) out(diskUsageText());
		else if (idx === 1) out(ctxUsageText(panelCache));
		else if (idx === 2) out(await tokenUsageText(h));
		else if (idx === 3) out(runtimeStatusText(h));
		else if (idx === 4) {
			// M4.5 T12 行模式对等件：子代理分组（模型 / 审批模式 / 轮数上限）——子级 Esc 回子菜单，子菜单 Esc 回根
			for (;;) {
				let subIdx: string;
				try {
					subIdx = await commandUi.choose("子代理", ["子代理模型", "审批模式", "轮数上限"]);
				} catch (err) {
					if (isEsc(err)) break; // Esc → 回设置根菜单
					throw err;
				}
				try {
					if (subIdx === "子代理模型") {
						const res = await runSubagentModelSetting((t, items) => commandUi.choose(t, items), subagentConfigFile(), modelSlotList(h));
						if (res !== "") out(res);
					} else if (subIdx === "审批模式") {
						const res = await runSubagentApprovalSetting((t, items) => commandUi.choose(t, items), subagentConfigFile());
						if (res !== "") out(res);
					} else if (subIdx === "轮数上限") {
						const res = await runSubagentMaxTurnsSetting((t, items) => commandUi.choose(t, items), (t) => commandUi.ask(t), subagentConfigFile());
						if (res !== "") out(res);
					}
				} catch (err) {
					if (isEsc(err)) continue; // 子项内 Esc → 回子菜单
					throw err;
				}
			}
		}
		else if (idx === 5) await openSkillsLine(out);
		else if (idx === 6) await openMcpLine(out);
		else if (idx === 7) {
			try {
				const res = await runVisionSetting(async (t, items) => commandUi.choose(t, items), () => moduleConfigFileFor("tool-media", h));
				// 写盘即自动重载——行模式 /settings busy 期排队到 turn 结束，此处必然空闲（共用件口径）
				if (res.wrote) { reloadModulesIdle(undefined, ""); out(`${res.message}，已重载生效`); }
				else out(res.message);
			} catch (err) {
				if (isEsc(err)) continue; // Esc → 回设置根菜单
				throw err;
			}
		}
		else if (idx === 8) {
			try {
				const res = await runSearchSettings();
				if (res !== "") out(res);
			} catch (err) {
				if (isEsc(err)) continue; // 顶层后端菜单 Esc → 回设置根菜单（更深的已在模块内逐级返回）
				throw err;
			}
		}
	}
};

// busy 期命令分级（2026-09-22 批①②④⑦d 用户拍板）：
// BUSY_EXEC = 即改档——busy 期直接执行（/model 下一轮生效；/permission /yolo 本轮生效；/title 改名）；
// BUSY_BLOCK = 拦回车档——submitGate 拦在提交前（会话/配置操作没理由排队，也不写历史提示行）
const BUSY_EXEC = new Set(["/model", "/effort", "/permission", "/yolo", "/auto", "/title", "/rename", "/tasks", "/task", "/settings", "/config"]); // /tasks 即档（2026-09-27 用户拍板：busy 期也要能立即看列表/应答审批——只读面不动 turn） // /settings 即档（m4-7 §3.7 前置：busy 期可开技能管理面——Alt + K 走「即改档但副作用缓挂」新档：写配置即时、reload 缓到空闲后用户手 /reload） // /auto 与 /yolo 同族（批⑧）；/effort 即改档同 /model（下一轮生效，2026-09-25）
// /summary 已退役（2026-09-23 用户拍板——查看口 Ctrl+O），拦回车档同步摘除
const BUSY_BLOCK = new Set(["/new", "/sessions", "/session", "/resume", "/provider"]);
const cmdNameOf = (text: string): string => text.trim().replace(/^\/\s+/, "/").split(" ")[0]!.toLowerCase();
/** /provider 写盘成功回报的输出前缀（CM-19③（2026-09-28 code review）抽常量——原正则内联在 processReplLine）。
 *  来源三处，改动须与本清单同步：provider-custom 向导 runProviderMenu（packages/modules/provider-custom/src/menu.ts）
 *  「设为当前默认」→ `已设为当前默认（provider = …）`、「移除」→ `已移除 <名>（…）`、
 *  添加平台校验通过 → `success：已写入并完成校验`；CLI 子命令面 provider-cmd import 的
 *  `success：已写入 …`（apps/cli/src/provider-cmd.ts）共用 success 前缀。取消/未写入回报（「已取消」「未更新…」）
 *  不在清单内——不动模块图。 */
const PROVIDER_WRITE_DONE = /^(?:success|已设为当前默认|已移除)/;

/** /model 切换反馈（2026-09-22 用户拍板：harness 静默返回，流区不落行）：前后 diff h.status().model——
 *  变了才反馈；全屏走浮动 toast（输入框上边缘黄字 3s 自消），行模式单行打印。面板「运行状态」卡随 refreshPanel 同步。 */
const reportModelSwitch = (before: string): void => {
	const now = h.status().model;
	if (now === before) return; // Esc/原样选择 = 未切换，零反馈
	const msg = `模型已切换 → ${now}（已写入 config）`;
	if (activeApp !== undefined) activeApp.showToast(msg);
	else console.log(`[${msg}]`);
};

/** /effort 切换反馈（/model 同约，2026-09-25）：前后 diff h.status().effort——含「首设」「清除」两态的措辞分野。 */
const reportEffortSwitch = (before: string | undefined): void => {
	const now = h.status().effort;
	if (now === before) return; // Esc/原样重选 = 未变化，零反馈
	const msg = now === undefined
		? "思考档位已清除（回端点默认，已写入 config）"
		: before === undefined ? `思考档位已设为 ${now}（已写入 config）` : `思考档位已切换 ${before} → ${now}（已写入 config）`;
	if (activeApp !== undefined) activeApp.showToast(msg);
	else console.log(`[${msg}]`);
};

const PERM_CYCLE = ["ask-risky", "ask-always", "never"];
/** 权限三档元数据（F5 十轮⑤ 拍板：档名 + 短解释 + 详细解释——菜单/芯片同源；2026-09-26 拍板显示名改中文，内部档名不变）。 */
const PERM_META: Record<string, { label: string; desc: string; long: string }> = {
	"ask-always": { label: "每次都询问", desc: "每次工具调用都确认", long: "最高安全档：每一次工具调用（包括只读文件）都要你确认后才执行。浏览陌生代码库、敏感目录或不信任的会话时用。" },
	"ask-risky": { label: "需要时候询问", desc: "仅危险操作确认", long: "日常默认档：只读操作（读文件、列目录）直接放行，写文件、执行命令、网络请求等有副作用的操作才确认。" },
	never: { label: "从不询问", desc: "全自动，有问题模型自行判断", long: "全自动档：此模式开启期间，所有工具批准都自动处理（含危险命令）；就算有问题也是模型自行判断，不会向你提问。只有你手写的 deny 规则仍会拦。完全信任当前会话、追求连续执行时用。" },
};
let panelCache: PanelData | undefined;

/** 面板锁定规则（2026-09-23 用户拍板 + T4 联动闭包复用）：① orosus-core = 核心本体（伪模块）；
 *  ② approval = 安全护栏（出厂 required=true，想松绑走 /permission never 正道）；
 *  ③ 当前活跃 provider 模块 = 拔了当场断模型（换 provider 后旧的自动解锁）。 */
const lockReasonFor = (name: string): string | undefined => {
	const activeProviderModule = (() => {
		const v = realReadModel(process.cwd())() ?? "";
		return v === "" ? "" : v.split("/")[0]!;
	})();
	return name === "orosus-core" ? "核心本体，不可插拔"
		: name === "approval" ? "安全护栏模块（出厂 required），放松审批走 /permission never"
		: name === activeProviderModule ? "当前使用的 provider，拔了会断模型（先 /model 换到别的）"
		: undefined;
};

/** reload 后关消失模块的挂起窗（m5 T7——/reload、toggleModule、applyModulePreset 三处 reload 调用点共用）：
 *  拆卡不需要通知（panelData 每秒现读自然消失），窗是持久态必须主动关。
 *  比对 reload 前后的活跃集（报表解析在各调用点口径不一，直接 diff 激活集更稳）。 */
const activeModuleNames = (): Set<string> => new Set(h.graph().audit().filter((a) => a.state === "active").map((a) => a.name));
const closeGoneModuleUi = (before: Set<string>): void => {
  if (activeApp === undefined) return;
  const after = activeModuleNames();
  for (const n of before) if (!after.has(n)) activeApp.closeModuleUi(n);
};

/** 权限投影（m5 T9 从 refreshPanel 提纯共用——host.current() 同源）：末条 approval/policy 事件 ?? 配置档。 */
const permissionOf = (events: { type: string; mode?: unknown }[], fallback: string): string => {
  const lastPolicy = events.filter((e) => e.type === "approval/policy").at(-1) as { mode?: string } | undefined;
  return lastPolicy?.mode ?? fallback;
};
/** 会话名投影（同款提纯）：末条 session/label 事件；未命名 = undefined（显示侧自定「新会话」）。 */
const sessionLabelOf = (events: { type: string; label?: unknown }[]): string | undefined => {
  const lastLabel = events.filter((e) => e.type === "session/label").at(-1) as { label?: string } | undefined;
  return lastLabel?.label;
};

/** 面板数据异步刷新（渲染是同步路径——历史/审计读取只能预取）：会话顶/turn 结束/定时三驱。 */
const refreshPanel = async (): Promise<void> => {
	const events = await h.history();
	const cfg = configFace();
	const permission = permissionOf(events, cfg.approvalMode); // m5 T9：提纯投影（host.current() 共用）
	const lastTodo = events.filter((e) => e.type === "tool-todo/write").at(-1) as
		| { type: string; todos?: unknown }
		| undefined;
	const next = PERM_CYCLE[(PERM_CYCLE.indexOf(permission) + 1 + PERM_CYCLE.length) % PERM_CYCLE.length]!;
	panelCache = {
		model: (() => {
			// F5 十三轮② 用户实测：裸 provider 值不能直接当模型名显示——解析槽的 defaultModel
			const v = realReadModel(process.cwd())() ?? "";
			if (v === "") return "（未配置——/provider 配置）";
			if (v.includes("/")) return v.split("/").pop()!;
			const slot = h.graph().services.provider(v) as { defaultModel?: string } | undefined;
			return slot?.defaultModel ?? v;
		})(),
    session: (() => {
      // 会话项显示标题（2026-09-23 用户拍板——sid 不可读）；未命名显示「新会话」直到 /title 或 fork 命名
      return sessionLabelOf(events) ?? "新会话";
    })(),
		cwd: shortenPath(process.cwd(), 26),
		tokens: lastUsageOf(events),
		startedAt: RUN_STARTED_AT, // 本次进程启动（F5 九轮⑤：resume 旧会话不再显示历史年龄）
		contextWindow: cfg.contextWindow,
		modules: h
			.graph()
			.audit()
			.map((a) => {
				const lockedReason = lockReasonFor(a.name);
				return {
					name: a.name,
					desc: a.name === "orosus-core" ? "核心循环" : "",
					state: a.state === "active" ? ("mounted" as const) : a.state === "pending-confirm" ? ("pendingConfirm" as const) : ("off" as const), // m5 T17 第四态
					...(lockedReason !== undefined ? { locked: true, lockedReason } : {}),
				};
			}),
		tasks: (lastTodo !== undefined ? panelTasksFromEvent(lastTodo) : undefined) ?? [],
		permission,
		permissionNext: () => `/permission ${next}`,
		// 「网络 · MCP」卡预取面（2026-10-01）：代理态静态、模型服务行要读 provider 条目（异步预取）；
		// 连接行走 mcp.catalog 现读不进快照——panelData() 装配期合并
		network: { proxy: await proxyStateText(), modelService: await modelServiceOf(events), connections: [] },
	};
};

/** 模块卡现读（m5 T6 口子二）：不走 panelCache 快照——panelData() 每次现调 getter（FullApp 1 秒 tick
 *  驱动重渲，现问现答）；getter 抛错 = 该卡当帧剔除 + host 日志 warn（设计空白 15——不记黑名单，
 *  下帧恢复即回）。卸载拆卡不需要通知：卡注册表随 reload 变化，此处每秒现读自然消失。 */
const moduleCards = (): PanelData["cards"] => {
	const out: NonNullable<PanelData["cards"]> = [];
	for (const c of h.graph().cards) {
		try {
			out.push({ area: c.spec.area, order: c.spec.order, title: c.spec.title, widgets: c.spec.widgets });
		} catch (err) {
			h.log("host.card.read-error", `模块卡读取抛错，当帧剔除：${c.owner}/${c.spec.title}`, { owner: c.owner, title: c.spec.title, error: String(err instanceof Error ? err.message : err) });
		}
	}
	return out.sort((a, b) => a.order - b.order);
};

/** 斜杠命令清单（长说明——斜杠菜单详细说明区数据源；children = 二级列表命令）。 */
const SLASH_ITEMS: SlashItem[] = [
	// /yolo /auto 提至 /help 前（2026-09-22 用户拍板——高频切档键优先于帮助）
	// 2026-09-26 拍板 D2 交叉互换（2026-09-28 走查修）：/yolo==需要时候询问（ask-risky）——详细文案用户拍板原文，档名对齐 /permission 菜单显示名
	{ name: "/yolo", desc: "仅危险操作确认", long: "需要时候询问模式：常规编辑和命令自动运行；风险操作、问题和计划仍需手动确认。等同于 /permission ask-risky。回答进行中也可执行，本轮生效。" },
	// 2026-09-26 拍板：/auto 文案按「从不询问」档名表述（D8 显示名），语义 = 就算有问题也是模型自行判断；行为换绑 never 由本批 T2 落地（D1 拍板），沿革见 ROADMAP 走查三批与 m3b 方案
	{ name: "/auto", desc: "从不询问模式", long: "从不打断你，一切运行并自动决定——就算有问题也是模型自行判断。" },
	{ name: "/help", desc: "帮助与快捷键", long: "显示全部斜杠命令与快捷键的对照表。快捷键三区焦点循环：Tab 在输入区、模块面板、任务面板之间移动；Esc 忙碌时取消回答、闲时返回输入区。" },
	{ name: "/model", desc: "切换模型槽位", long: "列出当前厂商下已配置的模型槽位，上下键选择后回车即热切换，会话不中断。槽位为空时会引导先走 /provider 配置端点。" },
	{ name: "/effort", desc: "思考投入档位", long: "控制 Agent 思考投入程度：推理深度、自检次数、是否多方案推演。菜单列出 off（关思考）与模型目录声明的档位（如 low / high / max），当前档以选中色标注；未设置时自动用目录默认档（档位中位项）。也可直敲 /effort <档位>（目录外模型手动指定）或 /effort auto（回默认档）。回答进行中也可执行，下一轮生效。" },
	{ name: "/provider", desc: "厂商向导", long: "交互式配置模型厂商：选平台、选数据源、从厂商目录选厂商、填端点与密钥。全程支持上下键导航与 Esc 逐级取消。" },
	{
		name: "/permission", desc: "权限模式", long: "切换工具执行的审批策略，切换立即生效并写入配置。三档：每次都询问（全确认）/ 需要时候询问（危险才确认）/ 从不询问（全放行，有问题模型自行判断）。", children: [...PERM_CYCLE], childMeta: PERM_META,
	},
	{ name: "/compact", desc: "压缩上下文", long: "立即压缩当前会话的上下文：把历史折叠成一份交接摘要（用户消息按策略保留原话），释放 token 空间。压缩期间显示进度指示，完成后可用 Ctrl+O 回看压缩摘要。" },
	{ name: "/sessions", aliases: ["resume"], desc: "会话列表", long: "列出本机全部会话（标题、更新时间、消息数），上下键选择回车切换；带序号或会话 ID 可直达恢复。/fork 可从当前会话分叉副本。" },
	// /summary 菜单条目已退役（2026-09-23 用户拍板）——查看口 = Ctrl+O（全屏 overlay/行模式直出）
	{
		name: "/settings", aliases: ["config"], desc: "设置与详细信息", long: "设置面板五项：磁盘占用（~/.orosus 各目录大小与清理口径）、上下文用量（窗口占用与输入输出累计）、Token 用量（本会话与项目累计）、运行状态（模型 / 会话 / 模块图——/usage /status 已并入此处）、配置网络搜索（LLM Web Search / Tavily / Brave 后端与 key）。「子代理」组内配模型 / 审批模式 / 轮数上限。",
	},
	{ name: "/tasks", aliases: ["task"], desc: "子代理任务列表", long: "列出当前会话的全部子代理与孙代理（父编号 - 孙编号标注亲缘、孙行紧跟父行；空册也开列表并附派活指引），回车进它的消息查看窗（主窗口同款渲染、跑着的实时刷新）；挂着审批的行回车即可批准或拒绝。" },
	{ name: "/quit", aliases: ["exit", "q"], desc: "退出 Orosus", long: "退出应用并恢复终端状态（光标、屏幕缓冲区、粘贴模式全部还原）。空闲时双击 Ctrl + C 同效。" },
	// F5 二轮⑨：既有命令全部进菜单（此前只有 10 条——/new /fork /resume /title /yolo /usage /status /reload 能打但菜单不可见）
	// 批⑤⑥：/usage /status 退役出菜单（并入 /settings 面板；打字面留指路）
	{ name: "/new", desc: "新会话", long: "开一场全新会话（当前会话保留，/sessions 可切回）。" },
	{ name: "/fork", desc: "分叉会话", long: "从当前会话的最新位置分叉出一个副本会话，继承全部上下文。" },
	{ name: "/title", aliases: ["rename"], desc: "会话命名", long: "给当前会话起名字（/title 名字，引号可选），在 /sessions 列表里按名字找会话。无参不做任何事。" },
	{ name: "/reload", desc: "重载模块", long: "重新加载配置与模块（改了 config.toml 或模块文件后用）。" },
];

// ---------- 技能菜单（m4-7 T7——服务倒挂：宿主消费 skill.catalog，模块不在优雅降级为零技能） ----------

/** catalog 行消费面类型（圈地纪律：消费侧类型结构本地声明）。 */
interface SkillMenuRow {
	name: string;
	description: string;
	whenToUse?: string;
	disabled: boolean;
	file: string;
}
let skillMenu: SlashItem[] = [];
const skillFiles = new Map<string, string>(); // 技能真名 → SKILL.md 实路径（Enter 注入读正文用）
let skillMenuAt = 0;
/** 菜单缓存刷新：catalog 是 Promise 口而菜单渲染同步——TTL 惰性（skillItems 被调时隔 5s 触发一次）
 *  + 显式点（/reload 收尾、模块插拔 reload 后、启动）。disabled 不进菜单（D7：停用双摘；
 *  disable-model-invocation 照显——用户手动路径不受限）。 */
const refreshSkillMenu = async (): Promise<void> => {
	// CM-12②（2026-09-28 code review）：catalog 是模块代码——同步抛错使本 Promise reject，而五个调用点全是
	// void 调用 = unhandledRejection 直崩进程（Node 22 起缺省 throw）；与 moduleCards「模块卡读取抛错当帧剔除」
	// 同政策：失败 = 菜单清空 + host 日志，技能面降级不带走宿主
	try {
		const catalog = await h.graph().services.getOptional("skill.catalog");
		if (typeof catalog !== "function") {
			skillMenu = [];
			skillFiles.clear();
			return;
		}
		const rows = (catalog as () => SkillMenuRow[])();
		skillFiles.clear();
		for (const r of rows) skillFiles.set(r.name, r.file);
		skillMenu = rows.filter((r) => !r.disabled).map((r) => ({
			name: `skill : ${r.name}`,
			desc: r.description,
			long: r.description, // 详释行 1-2 = description 折行截断（原型图 1）
			...(r.whenToUse !== undefined ? { usage: r.whenToUse } : {}),
			skill: r.name,
		}));
	} catch (err) {
		skillMenu = [];
		skillFiles.clear();
		h.log("host.skillmenu.error", `技能菜单刷新抛错，当帧清空：${err instanceof Error ? err.message : String(err)}`);
	}
};

/** 技能条目 Enter 注入（D3 拍板）：正文剥 frontmatter 后包 <skill> 块，以用户消息提交——
 *  pi/kimi 同款形态，走主输入口零新机制（busy 期照排队语义，不打断 turn）。读不到 = undefined（菜单提示）。 */
const skillInjectText = (name: string, args?: string): string | undefined => {
	const file = skillFiles.get(name);
	if (file === undefined) return undefined;
	try {
		const body = readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, ""); // 剥 frontmatter
			// 参数挂 <skill> 块属性（kimi renderSkillLoadedBlock 的 args="..." 同款，引号转义防早闭）；
			// 标记行保持首位原样——docmodel 的 ● 行识别按该行前缀，菜单 Enter 路不传 args 形态不变
			const attrs = args !== undefined ? ` args="${args.replace(/"/g, "&quot;")}"` : "";
			// 2026-10-01 诊断批：file 属性给模型提供相对路径解析基准（正文引用 references/… 不再按项目
			// cwd 落空——与 skill__load 输出首行带路径同因）；首行协议串不动（docmodel ● 行识别 + 防重入
			// 标记都按精确形态匹配它）；skill 块正文不进对话流，属性追加对用户可见面零影响
			return `（用户通过菜单手动加载技能 "${name}"——请按该技能正文行事）\n<skill name="${name}"${attrs} file="${file.replace(/"/g, "&quot;")}">\n${body}\n</skill>`;
	} catch {
		return undefined;
	}
};

/** /skill : 名 提交解析的真名归位（2026-09-30）：目录真名精确命中优先，落空整表小写比对
 *  （命令词忽略大小写同口径——手输大小写不齐也能筛到）。 */
const skillTypedName = (typed: string): string | undefined => {
	if (skillFiles.has(typed)) return typed;
	const lower = typed.toLowerCase();
	return [...skillFiles.keys()].find((k) => k.toLowerCase() === lower);
};

/** ASCII 字 banner（第三轮走查设计——大框 + OROSUS 块字 + 可变版本号 + slogan 两行 + 框下快捷键导引一行）。 */
const ASCII_BANNER = (VERSION: string): string[] => [
	"",
	theme.fg("accent", "╭──────────────────────────────────────────────────────────╮"),
	theme.fg("accent", "│") + theme.fg("accent", "  ██████╗ ██████╗  ██████╗ ███████╗██╗   ██╗███████╗") + "      " + theme.fg("accent", "│"),
	theme.fg("accent", "│") + theme.fg("accent", " ██╔═══██╗██╔══██╗██╔═══██╗██╔════╝██║   ██║██╔════╝") + "      " + theme.fg("accent", "│"),
	theme.fg("accent", "│") + theme.fg("accent", " ██║   ██║██████╔╝██║   ██║███████╗██║   ██║███████╗") + "      " + theme.fg("accent", "│"),
	theme.fg("accent", "│") + theme.fg("accent", " ██║   ██║██╔══██╗██║   ██║╚════██║██║   ██║╚════██║") + "      " + theme.fg("accent", "│"),
	theme.fg("accent", "│") + theme.fg("accent", " ╚██████╔╝██║  ██║╚██████╔╝███████║╚██████╔╝███████║") + "      " + theme.fg("accent", "│"),
	theme.fg("accent", "│") + theme.fg("accent", "  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝ ╚══════╝ ╚══════╝") + "     " + theme.fg("accent", "│"),
	theme.fg("accent", "│") + "                                                          " + theme.fg("accent", "│"),
	theme.fg("accent", "│") + ` ${theme.bold(theme.fg("fg", `v${VERSION}`))}${theme.dim(" — 模块化 AI Agent Harness")}                         ` + theme.fg("accent", "│"),
	theme.fg("accent", "│") + theme.fg("muted", " 玄墨为基，青玉点睛，石青、暖金、赭石各载其义。") + "           " + theme.fg("accent", "│"),
	theme.fg("accent", "│") + theme.fg("muted", " 如层峦绵亘，灵脉贯通。") + "                                   " + theme.fg("accent", "│"),
	theme.fg("accent", "╰──────────────────────────────────────────────────────────╯"),
	// 快捷键导引（2026-09-27 拍板：移出框外置框下，定两行——行 1 到 Ctrl + T 缩放侧栏、行 2 Alt + V 起头）
	theme.dim(" Tab 切换焦点 · Shift + Tab 切换权限 · Alt + E 缩放思考 · /<命令> · Ctrl + T 缩放侧栏"),
	theme.dim(" Alt + V 贴图 · Ctrl + E 诊断"),
	"",
];

const runFullScreen = async (): Promise<"switch" | "quit"> => {
  let action: "switch" | "quit" | undefined;
  void refreshSkillMenu(); // m4-7 T7：技能菜单首刷（异步先取，菜单首开即有数据；后续走 TTL + reload 显式点）
  const app = new FullApp({
    columns: () => process.stdout.columns ?? 80,
    rows: () => process.stdout.rows ?? 24,
    // m5-render-perf T5 窗口化行源：全量整拷退役——streamW() 现值传入，宽度变化（Ctrl+T/resize）
    // 经 DocModel.reconcile 键失配自动全量重折（D8 定案，几何立即全对）
    docTotal: () => dm.totalLines(streamW()),
    docWindow: (start, count) => dm.frameWindow(streamW(), start, count),
    docHeadShift: () => dm.headShiftTotal(), // 走查⑦：滑窗裁剪的头部平移——主窗滚动补偿区分平移与尾部增缩
    submit: (text) => {
      // /help（F5 二轮⑪）：只读翻页浮层（↑↓/PgUp/PgDn 翻页、Esc 关闭），不进命令管线不留气泡。
      // dock（2026-09-28 用户拍板）：贴输入框上缘 + 与输入框同宽同左缘——左右边框与输入框连成直线
      const cmd = text.trim().replace(/^\/\s+/, "/").replace(/\s+/g, " ");
      if (cmd === "/help") {
        app.viewText("帮助", HELP_TEXT, { layout: "dock" });
        return;
      }
      // busy 命令策略（批①②④⑦d 重构）：/quit 族立即打断退出；即改档（BUSY_EXEC）busy 期直接执行；
      // 拦回车档（BUSY_BLOCK）已由 submitGate 拦在提交前（到不了这里）；其余命令与消息照旧排队
      const cmdN = cmdNameOf(text);
      if (inflight) {
        if (cmdN === "/quit" || cmdN === "/exit" || cmdN === "/q") {
          void h.cancel(); // 打断当前消息输出
          action = "quit";
          return;
        }
        if (BUSY_EXEC.has(cmdN)) { runSubmit(text, true); return; }
        pendingSubmits.push(text); // 队列区逐条显示（2026-09-23 队列批——尾行计数 chip 退役）
        return;
      }
      runSubmit(text);
    },
    submitGate: (text) => {
      // 批④：拦回车档的拒因（返回串 = 拦截——FullApp 尾行瞬显，输入保留不进历史）
      const c = cmdNameOf(text);
      return inflight && BUSY_BLOCK.has(c) ? `回答进行中——${c} 本轮不可执行（Esc 取消当前回答；结束后原文再按回车即发）` : undefined;
    },
    // CTU-11（2026-09-28 code review）：requestExit 死接口三方删除（本实现 + fullapp.ts 声明 + 测试桩）——
    // 2026-09-23 拍板 Ctrl+C 不占用、退出走 /quit 后成遗迹，全仓 grep 零真实调用方
    requestCancel: () => {
      h.cancel(); // Esc 忙碌时取消当前 turn（SIGINT 同效——修复轮②）
    },
    // 视觉转述等待期（走查四）：双击 Esc 中止口——visionWaitAbort 模块级单等待
    visionTranscribing: () => visionWaitAbort !== undefined,
    abortVisionTranscribe: () => { visionWaitAbort?.(); },
    panelData: () => ({
      ...(panelCache ?? {
        model: "…",
        session: "新会话", // 首刷前占位——未命名口径与 refreshPanel 一致（sid 不可读）
        cwd: shortenPath(process.cwd(), 26),
        tokens: { input: 0, output: 0 },
        startedAt: undefined,
        contextWindow: configFace().contextWindow,
        modules: [],
        tasks: [],
        permission: configFace().approvalMode,
        permissionNext: () => "/permission ask-always",
      }),
      cards: moduleCards(), // m5 T6：卡片恒现读——不进 panelCache 快照（getter 每秒被读一次）
      network: panelCache?.network === undefined ? undefined : { ...panelCache.network, connections: mcpConnRows() }, // 连接行每秒现读（mcp.catalog），KV 串用 refreshPanel 预取
    }),
    slashCommands: () => SLASH_ITEMS,
    // 技能区（m4-7 T7）：TTL 惰性刷新——菜单渲染同步口吃缓存，被调时隔 5s 后台刷一次；
    // /reload 收尾与模块插拔后另有显式刷新点
    skillItems: () => {
      const now = Date.now();
      if (now - skillMenuAt > 5000) {
        skillMenuAt = now;
        void refreshSkillMenu();
      }
      return skillMenu;
    },
    skillInject: skillInjectText,
    slashCurrent: (cmd) => (cmd === "/permission" ? (panelCache?.permission ?? configFace().approvalMode) : ""),
    // 参数阶段数据源（m5 T15）：graph 现读模块命令的 completeArg；抛错兜底空表 + host 日志（菜单层当无候选）
    slashArgComplete: (cmd, word, args) => {
      const c = h.graph().commands.find((x) => `/${x.name}` === cmd);
      if (c?.completeArg === undefined) return undefined;
      try {
        return c.completeArg(word, args);
      } catch (err) {
        h.log("host.completer.error", `模块参数补全抛错，当无候选：${cmd}`, { error: String(err instanceof Error ? err.message : err) });
        return [];
      }
    },
    sidebarInit: () => tuiSidebarRead(), // 即时读（F5 十四轮：会话切换重建 FullApp——不能用进程启动快照）
    onSidebarChange: (visible) => tuiSidebarPersist(visible), // Ctrl+T 状态持久化
    // Ctrl+O = 查看压缩摘要（2026-09-23 用户拍板：/summary 命令退役后的唯一入口；摘要文本灰色 muted）
    showCompactionSummary: async () => {
      const view = compactionSummaryView(await h.history(), { width: Math.max(20, (process.stdout.columns ?? 80) - 6) });
      if (view === undefined) {
        app.showToast("本会话还没有压缩摘要（/compact 后可看）");
        return;
      }
      // 全屏窗形态（2026-09-27 用户拍板：参照子代理查看窗）；全部压缩历史最新在最上、静态文档自顶读——
      // 不贴底（bottom 是 live 跟随用的）。折行宽 = full 弹窗内容区（ow−2 内衬 −2 内容边 −1 前导空格 = cols−6）
      app.viewText(view.title, view.text, { layout: "full" });
    },
    // 模块卡回车 = 热插拔（2026-09-23 用户拍板）：锁定项 toast 锁因；可插拔项行级写 config enabled + h.reload()
    // T4 联动启停：硬依赖传递闭包——卸载带走依赖者、挂载自动补上提供者；撞锁定拒绝整次（S1）
    toggleModule: (name, lockedReason) => {
      if (lockedReason !== undefined) {
        app.showToast(`${name} · 锁定——${lockedReason}`);
        return;
      }
      if (inflight) {
        app.showToast("回答进行中不可插拔（等本轮结束后再试）");
        return;
      }
      const mounted = panelCache?.modules.find((m) => m.name === name)?.state === "mounted";
      const target = !mounted;
      // 卸载 tool-subagent 守卫（2026-09-27）：在跑/排队/挂审批的子代理在册不许卸——
      // 内核 runner 不随模块死，但派活/停止工具面会消失，模型侧就管不着了
      if (!target && name === "tool-subagent") {
        const block = subagentUnloadBlock(h.subagents());
        if (block !== undefined) {
          app.showToast(block);
          return;
        }
      }
      const audit = h.graph().audit();
      const depRows = audit.map((a) => ({ name: a.name, provides: a.provides, dependsOn: a.dependsOn, state: a.state }));
      const lockedNames = audit.filter((a) => lockReasonFor(a.name) !== undefined).map((a) => a.name);
      const closure = target
        ? computeMountClosure([name], depRows, lockedNames)
        : computeUnmountClosure([name], depRows, lockedNames);
      if (!closure.ok) {
        app.showToast(closure.blocked);
        return;
      }
      const writeList = closure.write;
      const cascaded = writeList.filter((n) => n !== name);
      // 写盘段独立 try（与图级 reload 失败两语义分开）：中途失败时已落部分——提示对齐路径，安全方向 = 漏写侧下次 reload 走 topo 降级
      let written = 0;
      let writeFailed = false;
      for (const n of writeList) {
        try {
          setModuleEnabledInConfig(n, target, moduleConfigFileFor(n, h));
          written++;
        } catch {
          writeFailed = true;
          break;
        }
      }
      if (writeFailed) {
        app.showToast(`配置写盘中途失败（已写 ${written}/${writeList.length} 个模块，可 /reload 或重启对齐）`);
        return;
      }
      if (cascaded.length > 0) {
        // S10 拍板：toast 只报目标模块（上方 toggleResultText），连带名单写诊断日志——host.module.cascade
        h.log("host.module.cascade", `联动${target ? "挂载" : "卸载"} ${name}：连带${target ? "启用" : "停用"} ${cascaded.join("、")}`, { action: target ? "mount" : "unmount", target: name, cascaded });
      }
      void (async () => {
        try {
          const namesBefore = activeModuleNames(); // m5 T7：关消失模块的挂起窗
          const r = await h.reload();
          closeGoneModuleUi(namesBefore);
          registerToolLabels(h.graph().tools.toolInfos()); // 插拔改变工具集合——标签表随图重喂
          void refreshSkillMenu(); // m4-7 T7：技能菜单缓存随图刷新（停用后插拔即时生效）
          await refreshPanel();
          app.showToast(toggleResultText(target ? "mount" : "unmount", name, r)); // 读 failed 清单——失败明说，不再假报成功（T2）
        } catch (err) {
          app.showToast(`插拔失败：${err instanceof Error ? err.message : String(err)}（已回写配置，可 /reload 或重启恢复）`);
        }
      })();
    },
    thinkOpen: () => dm.thinkOpen,
    toggleThink: () => {
      dm.thinkOpen = !dm.thinkOpen;
    },
    // 模块诊断弹窗数据源（T9）：打开时现读（定案）——当天 + 前一天诊断日志过滤聚合（T8 读取器）
    diagEntries: () => readDiagnostics(join(orosusHome(), "logs"), new Date()),
    // 二级详情文本（T10）：T8 条目 + 原始日志行（本模块事件 + 点名本模块的事件——主犯拖累反查）拼装
    diagDetail: (name: string): string => {
      const now = new Date();
      const dir = join(orosusHome(), "logs");
      const entry = readDiagnostics(dir, now).find((e) => e.name === name);
      if (entry === undefined) return "（该模块没有诊断记录）";
      const raw = readDiagRawLines(dir, now).filter((e) => moduleOf(e) === name || e.msg.includes(`的提供者 ${name}`));
      return renderDetail(entry, raw);
    },
    // 宿主日志口（m5 T2）：UI 层事件留痕——弹窗保留键注册即拒等（h.log 走 host 通道）
    logWarn: (code, msg, data) => h.log(code, msg, data),
    // 待确认模块回车 = 首挂确认弹窗（m5 T17）：声明面人话清单 → 确认 = trustModule 登记 + 写盘 enabled +
    // reload 一次（三动作照 toggleModule 链）；取消零副作用（Esc 关窗即取消）。行模式回退 CLI 提示。
    confirmModule: (name) => {
      const info = h.pendingConfirms().find((p) => p.name === name);
      if (info === undefined) return;
      if (activeApp === undefined) {
        notify(`行模式请在终端运行：orosus module trust ${name}`);
        return;
      }
      const handle = activeApp.openDialog({
        title: `启用模块 ${name}？`,
        widgets: confirmDialogWidgets(info satisfies PendingModuleInfo & Record<string, unknown>),
        onEvent: (e) => {
          if (e.type !== "activate" || e.index !== 0) return undefined;
          void (async () => {
            try {
              trustModule(join(orosusHome(), "trust.json"), info.root, info.entryHash); // 动作 1：登记（项目级 hash 门/用户级认登记共用 trust.json——零新存储）
              setModuleEnabledInConfig(name, true, moduleConfigFileFor(name, h)); // 动作 2：写盘 enabled
              await h.reload(); // 动作 3：重跑信任判定 → 挂载
              registerToolLabels(h.graph().tools.toolInfos());
              await refreshPanel();
              notify(`已确认并启用 ${name}`);
            } catch (err) {
              notify(`确认失败：${err instanceof Error ? err.message : String(err)}`);
            }
          })();
          handle?.close();
          return undefined;
        },
      });
    },
    toggleTool: () => {
      dm.toolOpen = !dm.toolOpen;
    },
    toggleErr: () => {
      dm.errOpen = !dm.errOpen;
    },
    // 消息队列三件套（2026-09-23 队列批——kimi 方案改 Ctrl+U）：队列区数据源 / ↑ 召回队尾 / steer 注入
    queueItems: () => [...pendingSubmits],
    // M4.5（2026-09-27 改版）：前台显示走流区 agent 组（DocModel 组条目）；此口只剩双击 Esc 全停门槛判定
    subagentActive: () => h.subagents().some((a) => a.status === "queued" || a.status === "running"),
    // M4.5 T13：输入行「N 任务正在执行」——只数后台运行中（前台走状态行）；为零整段消失
    subagentRunningCount: () => backgroundRunningCount(h.subagents()),
    // M4.5 T14：双击 Esc 全停（空闲有子代理 = 全停；忙时 = 停生成 + 全停）——未答审批自动回绝
    stopAllSubagents: () => h.stopAllSubagents(),
    recallQueued: () => pendingSubmits.pop(), // LIFO 队尾召回（kimi recallLastQueued 同语义）
    requestSteer: (texts) => {
      if (!inflight) { // 无进行中 turn：首条直接发、其余照旧排队（kimi Ctrl-S 空闲 = 直接提交）
        const [first, ...rest] = texts;
        if (first !== undefined) runSubmit(first);
        pendingSubmits.push(...rest);
        return;
      }
      const remain: string[] = [];
      for (const t of texts) {
        // 命令类不可 steer（kimi 同口径——/ 开头留队，防顺序错乱）；steer 落空（turn 已收尾）同样留队
        if (t.trimStart().startsWith("/") || !h.steer(t)) {
          remain.push(t);
          continue;
        }
        dm.userPrompt(t); // steer 回声（kimi：steered 消息作为 user 条目进 transcript）
      }
      pendingSubmits.length = 0;
      pendingSubmits.push(...remain);
    },
    // Alt + V 全屏接线（2026-09-23 修订）：取图 → chip token 插入输入框光标位；无图提示进流区
    requestPasteImage: () => {
      void (async () => {
        const img = await pasteImageToMedia();
        if (img === undefined) {
          notify(PASTE_EMPTY); // toast 化（2026-09-23 拍板）——无图提示不落流区
          return;
        }
        app.insertAtCursor(attachPendingImage(img.file)); // chip token 进输入框光标位（删除键可删 = 撤销挂图）
      })();
    },
  });
  // 输入历史播种（2026-09-23 实测：/sessions 恢复后 ↑ 无历史可召——FullApp 随会话重建即清零）：
  // 会话的 user/message + steering 文本作为可召回历史；图片 chip token 剥除（seq 注册表已随旧会话失效）
  {
    const hist = await h.history();
    const seedTexts: string[] = [];
    for (const e of hist) {
      if (e.type === "user/message") {
        const t = ((e.content ?? []) as { kind?: string; text?: string }[]).filter((p2) => p2.kind === "text").map((p2) => p2.text ?? "").join("");
        const { cleaned } = extractImageRefs(t);
        if (cleaned !== "") seedTexts.push(cleaned);
      } else if (e.type === "agent/steering-message") {
        // 用户 steer 的话可召回；日期系统行（host/date）不进输入历史——↑ 翻出「系统提醒：今天是…」是系统噪音（2026-09-28）
        for (const m of (e.messages ?? []) as { text?: string; sourceModule?: string }[])
          if (typeof m.text === "string" && m.text !== "" && m.sourceModule !== "host/date") seedTexts.push(m.text);
      }
    }
    app.seedHistory(seedTexts);
  }
  // 流式排队面（F5 四轮）：turn 进行中的提交入队，结束后依序执行——消息带气泡、命令不带，
  // 全程不触碰活动 markdown/think 块（插队输出会把 DocModel 活动块 settle 掉 = 渲染乱）
  const pendingSubmits: string[] = [];
  let inflight = false;
  // busyExec = busy 即改档（批①②⑦d）：不占有/释放 inflight 与 busy（归进行中的 turn 所有），
  // 结果走单行 pushLine（md 块会 settle 活动流块——busy 期 [提示] 直写先例）；命令不产生 switch/quit 语义
  const runSubmit = (text: string, busyExec = false): void => {
    if (!busyExec) {
      inflight = true;
      app.setBusy(true);
    }
    void (async () => {
      const modelBefore = cmdNameOf(text) === "/model" ? h.status().model : undefined; // /model 静默化：反馈靠前后 diff
      const effortCmd = cmdNameOf(text) === "/effort" || cmdNameOf(text) === "/model"; // /effort 反馈 + /model 档位跟随重解析播报（首设态 before=undefined 也要反馈——布尔门区分「未捕获」）
      const effortBefore = effortCmd ? h.status().effort : undefined;
      try {
        const emit = busyExec ? (s: string) => dm.pushLine(s) : (s: string) => dm.pushMd(s, streamW()); // 命令结果含 md（/compact 摘要等）——渲染后入流（F5 六轮②）
        const r = await processReplLine(text, emit);
        if (modelBefore !== undefined) reportModelSwitch(modelBefore);
        if (effortCmd) reportEffortSwitch(effortBefore);
        if (!busyExec) {
          if (r === "switch") action = "switch";
          else if (r === "quit") action = "quit";
        }
      } catch (err) {
        // runSubmit 网兜（2026-09-24 走查实锤前案）：void-async 无 rejection 落点 = 进程杀手——
        // 拦截区（try 覆盖之外的 /help、会话切换等）逃逸的错误此前直通 FullApp 崩溃钩子 exit 7；
        // 与 processReplLine catch-all 同政策（Esc 静默、其余 toast）
        settleCommandError(err);
      } finally {
        // busy 即改档不占有/释放 inflight——turn 的 finally 归原属主（条件块形态：finally 里不写 return——oxlint no-unsafe-finally）
        if (!busyExec) {
          inflight = false;
          app.setBusy(false);
          // 命令类提交（/permission /model…）不产生 turn/end——面板在此刷新（F5 走查：chip 陈旧）
          void refreshPanel();
          const next = pendingSubmits.shift();
          if (next !== undefined && action === undefined) runSubmit(next);
        } else {
          void refreshPanel(); // busy 即改档（/title /permission…）也要即时刷面板（2026-09-23：/title 改名单元格陈旧前案）
        }
      }
    })();
  };

  activeApp = app; // 全屏 CommandUi 适配层激活（模块 choose/ask 经 overlay/输入行接管）
  stdoutEcho.silence(true); // readline 与 FullApp 共用 stdin——全屏期 rl 回显全吞（F5 走查实证毁屏）
  app.start();
  // 首次使用引导（M4-3 T1d）：触发即开弹窗（一次性——会话切换不重开）；完成 → reload 生效 + toast 留痕
  if (onboardingTrigger !== null) {
    const trigger = onboardingTrigger;
    onboardingTrigger = null;
    if (trigger.reason === "broken") app.showToast("配置文件无法读取，已按默认配置进入引导"); // SW-20 定案话术
    else if (trigger.reason === "degraded") app.showToast("部分模块配置无效已降级——已按默认配置进入引导");
    // 出厂技能固化（2026-10-01 拍板）：弹窗弹出时刻把 bundled/ 出厂件（件数随版本浮动）拷入用户级
    // ~/.orosus/skills——打包布局变化不再影响已初始化用户（引导完成后 h.reload 重扫即入清单；quit 路径下次启动拾取）
    seedFactorySkills({ fresh: trigger.reason === "fresh", notify, showToast: (m) => app.showToast(m) });
    // 目录预装固化（2026-10-02 用户拍板「打开程序时候拷到 cache 下」）：预装 models-dev.json 全量信封
    // 缺/坏才拷入 ~/.orosus/cache/——引导第 2 页提供商与第 4 页模型清单离线首跑即全量；在线拉取的
    // 更新数据不被回滚（缺/坏判据在 seed 内部）
    seedBundledCatalog(defaultCatalogCacheFile());
    const outcome = await app.runOnboarding(buildOnboardingDeps(), await onboardingInitial());
    if (outcome.kind === "quit") {
      action = "quit"; // Ctrl + Q（仅第 1 页）= /quit 同款
    } else {
      await h.reload(); // provider 槽/search 后端进图——配置即时生效（调用时解析的另一翼 = tool-web 闭包活态）
      registerToolLabels(h.graph().tools.toolInfos()); // 引导激活的模块（tool-web 等）标签进表
      app.showToast("引导完成 · 配置已写入并即时生效");
    }
  }
  while (action === undefined) {
    await new Promise((r) => setTimeout(r, 40));
  }
  activeApp = undefined;
  app.stop();
  stdoutEcho.silence(false);
  return action;
};

// REPL（--print 单发模式不进——M4-2 T17：runPrint 已收尾）

// 首次使用引导触发判定（M4-3 T1d，D10/SW-20——推翻 M4-2「空配置直进主窗」旧拍板）：
// ① config.toml 不存在（fresh）② 解析失败（broken——load.ts 已降级不炸穿，此处独立 preflight 取证）
// ③ 模块 config 校验失败（degraded——信号 = 激活期失败列表）。仅全屏形态（行模式既有 startupGate 向导路径不动）。
let onboardingTrigger: { reason: "fresh" | "broken" | "degraded" } | null = null;
if (tuiMode === "full" && args.print === undefined) {
	const userConfigPath = join(orosusHome(), "config.toml");
	if (!existsSync(userConfigPath)) {
		onboardingTrigger = { reason: "fresh" };
	} else {
		// m4-8 T2.5 收口 loadConfig：warnings 本就产出解析失败信号(SW-20);modules.d 坏文件走目录层
		// 容错字样不计入 broken(设计 §3.6——目录坏文件只降级不触发引导)
		const broken = loadConfig({ userFile: userConfigPath }).warnings.some((w) => w.includes(userConfigPath) && w.includes("解析失败"));
		if (broken) onboardingTrigger = { reason: "broken" };
	}
	if (onboardingTrigger === null && h.graph().audit().some((a) => a.state === "failed")) {
		onboardingTrigger = { reason: "degraded" };
	}
}

/** 引导弹窗副作用接线（写盘全走既有件：menuDeps 闭环 / tool-web persist 面——零平行写路）。 */
const buildOnboardingDeps = (): OnboardingDeps => {
	const menuDeps = defaultMenuDeps();
	const secretsFile = join(orosusHome(), "secrets.env");
	return {
		// 2026-10-02 用户拍板：提供商正源 = 盘上目录缓存（预装 models-dev.json 已 seed 固化，见 runOnboarding
		// 调用前）——全量派生视图（过滤 + 头部优先排序）；盘上无缓存/坏文件回退烤码 7 家快照（末位兜底）
		providers: catalogProviderView(defaultCatalogCacheFile()) ?? snapshotProviderView(),
		writeProvider: (p) => {
			// CM-12③（2026-09-28 code review）：引导写盘 void 裸奔——IO 拒绝（EACCES/ENOSPC）即 unhandledRejection
			// 崩进程，用户视角「填完密钥程序炸了」；rejection 落 toast（notify：全屏=引导弹窗外浮层、行模式=单行），进程存活
			void (async () => {
				const cur = await menuDeps.loadProviders();
				await menuDeps.saveProviders({
					...cur,
					[p.id]: { type: p.type, baseUrl: p.baseUrl, ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}) },
				});
			})().catch((err) => notify(`平台配置写盘失败：${err instanceof Error ? err.message : String(err)}`));
		},
		// secrets 统一走 upsertSecret（原位更新不累积重复行——引导内可重复输同一家 key；
		// provider/search 两类 key 同享，与 /settings 配置流同落点同语义）
		appendSecret: (envKey, value) => { upsertSecret(secretsFile, envKey, value); },
		setModel: (slot) => {
			// CM-12③：同上——setModel 写盘失败落 toast，不崩引导
			void menuDeps.setModel(slot).catch((err) => notify(`默认平台写盘失败：${err instanceof Error ? err.message : String(err)}`));
		},
		// m4-8 T4/C5：[tool-web] 路由新家 modules.d/tool-web.toml（D7 例外——模块侧写动作保持，
		// 目标路径由宿主按 sectionPath 算好传入；模块不 import core）
		writeSearch: (patch) => persistToolWebSearch(moduleConfigFileFor("tool-web", h), patch),
			// F14 视觉模型页（第 3/4 页）：写 [tool-media] visionModel；清单 = 已配置槽逐槽查目录（遮蔽坑免疫）
			writeVision: (value) => persistVisionModel(moduleConfigFileFor("tool-media", h), value),
			visionModels: () => visionCandidates(),
		listModels: async (slot) => {
			// SW-24：引导期槽未激活——按裸条目直组「目录优选 + live 兜底」（与槽内 listModels 同口径）
			const entry = (await menuDeps.loadProviders())[slot];
			if (entry === undefined) throw new Error(`槽 "${slot}" 未配置`);
			const secrets = loadSecretsEnv(secretsFile).vars;
			const key = entry.apiKey?.startsWith("$ENV:") ? secrets[entry.apiKey.slice(5)] : entry.apiKey;
			const glue = { baseUrl: entry.baseUrl, ...(key !== undefined ? { apiKey: key } : {}) };
			const live = entry.type === "anthropic" ? anthropicListModels(glue) : openaiListModels(glue);
			return catalogPreferredListModels(slot, live, diskFirstCatalogLoader())();
		},
	};
};

/** 引导初态：已配置槽 + 当前使用槽（顶层 provider 键的首段；指向不存在的槽按 null——损坏降级面）。 */
const onboardingInitial = async (): Promise<{ configured: string[]; active: string | null }> => {
	const cur = await defaultMenuDeps().loadProviders();
	const curModel = realReadModel(process.cwd())();
	const slot = curModel === undefined || curModel === "" ? null : curModel.split("/")[0]!;
	return { configured: Object.keys(cur), active: slot !== null && cur[slot] !== undefined ? slot : null };
};

if (args.print === undefined) try {
  sessionLoop: for (;;) {
    // 横幅分流（F3）：全屏模式 console 输出会毁屏——横幅进 DocModel 流区；dm 每会话重置（新会话新文档）
    dm = newMainDocModel();
    if (tuiMode === "full") for (const l of ASCII_BANNER(OROSUS_VERSION)) dm.pushLine(l); // ASCII 字 banner（修复轮①）
    for (const line of banner(h, { modelConfigured: !needsProviderSetup({ model: realReadModel(process.cwd())(), providers: h.graph().services.listProviders().map((p) => p.name) }) })) {
      if (tuiMode === "full") dm.pushLine(line);
      else console.error(line);
    }
    attachRender(h);
    if (pendingEcho !== undefined) {
      // 延期的切换回显落新 dm（F5 二轮⑯）；行模式已在 switchTo 内即时回显，不会走到这
      const pe = pendingEcho;
      pendingEcho = undefined;
      if (tuiMode === "full") {
        if (pe.notice !== "") dm.pushLine(pe.notice); // 空串 = 恢复横幅退役（只回放历史）
        if (pe.history) dm.historyFrom(await h.history(), streamW()); // 结构化摄入（F5 五轮②③④）
      }
    }
    void refreshPanel(); // 面板首刷（F4）
  // m5 T17：启动期一次性 toast——待确认第三方存在时提示（config 已 enabled 但未确认的也在此列：保持不挂载，回车确认后才启用）
  {
    const pending = h.pendingConfirms();
    if (pending.length > 0) notify(`${pending.length} 个模块待确认——面板选中后回车查看声明并确认（或 orosus module trust）`);
  }
    for (;;) {
      // 全屏模式（F3）：FullApp 接管终端（alt-screen 双栏）；返回后按动作分流
      if (tuiMode === "full") {
        const action = await runFullScreen();
        if (action === "quit") break sessionLoop;
        // switch（/new /resume /sessions 切换）回外层循环顶：dm 重建、横幅、attachRender(新 h)、
        // pendingEcho 消费全在那；退出全屏只剩 quit 一途（Ctrl+T 已改管侧栏开关——用户拍板）
        continue sessionLoop;
      }
      process.stdout.write("> ");
      const line = await nextLine(); // EOF（管道耗尽 / Ctrl-D）→ null → 退出
      if (line === null) break sessionLoop;
      const text = line.trim();
      if (text === "") continue;
      const mb = cmdNameOf(text) === "/model" ? h.status().model : undefined; // /model 静默化：切换反馈 diff 前后值
      const effortCmd = cmdNameOf(text) === "/effort" || cmdNameOf(text) === "/model"; // 行模式反馈同全屏（/effort 切档 + /model 档位跟随重解析）
      const effortBefore = effortCmd ? h.status().effort : undefined;
      const r = await processReplLine(text, (s) => console.log(s));
      if (mb !== undefined) reportModelSwitch(mb);
      if (effortCmd) reportEffortSwitch(effortBefore);
      if (r === "quit") break sessionLoop;
      if (r === "switch") continue sessionLoop;
      // CLI 拦截层（D38 第一层）：会话生命周期命令（/new /fork /sessions /resume /quit，D41/T6 + B9 拉前）

    }
  }
} finally {
  rl.close();
  killAllBackgroundJobs(); // M4-3 T3：退出清杀——/quit、行模式 EOF、全屏 quit 全路径统一收口于此
                           // （ModuleContext 无退出缝；SIGINT 不在其列——现状只 cancel 当前 turn 不退出，v4.7 定案）
  await h.close();
  purgeIfEmptySession(h.sessionId); // 空会话退出即清（2026-10-01 拍板②）——h.close 后无句柄可删；h = 最后在开的会话
}
