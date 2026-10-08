/** CLI 入口（启动序 + 子命令拦截 + 命令路由 + 全屏运行器 + 渲染装配——这四段是本件的留守本体）。
 *  拆分说明（m5-split-main，2026-10-02）：本件曾堆到 2818 行——apps/cli/src 本有「一功能一平铺
 *  小文件」惯例，但 2026-09 后各批「全屏 + 行模式双态接线」的函数族全塞进这里，多个并行批
 *  同改一文件必撞车。九个功能家族已拆到平级新件：配置读取 config-face / 用量文本 usage-text /
 *  视觉贴图 vision-media / 会话切换 session-io / MCP 面板 mcp-ui / 技能菜单 skills-ui / 设置面板
 *  settings-ui / 模块面板 modules-ui / 行模式 IO repl-io（openTasks 另归并进既有 tasks-cmd.ts）。
 *  留守不动：runFullScreen / attachRender 渲染装配段（与 FullApp 实例和主循环穿线最深，随
 *  fullapp 壳同命运评估）；processReplLine 就是「命令路由」本体，属留守职责。
 *  限制：跨件依赖一律函数签名注入（D2——不建全局状态仓；activeDir/activeApp 等可变单例经新件
 *  export 的 get/set 访问器，见各 deps 注记）；族内缓存保持模块级私有变量形态，不额外封装。
 *  纯搬移零行为变；方案与收官对账见 docs/superpowers/plans/2026-10-02-m5-split-main.md。 */
import { orosusHome } from "@orosus/contracts/home";
import { OROSUS_VERSION } from "@orosus/contracts/version";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { appendInput, discoverModules, isEmptySessionHead, locateSessionFile, loadSecretsEnv, purgeSessionDir, readSessionHead, sweepEmptySessions, refreshEventIndex, defaultEventIndexFile } from "@orosus/core";
import type { Harness } from "@orosus/core";
import type { HostInfo, SettingsService, SubagentRosterEntry } from "@orosus/contracts/module";
import { compactionSummaryView } from "./compaction-view.ts";
import { createCliUi } from "./uiface.ts";
import { confirmDialogWidgets, type PendingModuleInfo } from "./module-confirm.ts";
import { trustModule } from "@orosus/core";
import { createModal, type KeyEvent } from "./keys.ts";
import { pick } from "./picker.ts";
import { formatSessions, harnessOptionsFor, listSessions, pickSessionNumber, readTitle, relativeTime, resolveTarget, sessionCommand, setTitle } from "./sessions.ts";
import { parseArgs, parseEarlyFlags, type CliArgs } from "./args.ts";
import { tuiSidebarPersist, tuiSidebarRead } from "./tui-config.ts";
import { isProviderSubcommand, runProviderSubcommand } from "./provider-cmd.ts";
import { isHomeSubcommand, runHomeSubcommand } from "./home-cmd.ts";
import { execFileSync } from "node:child_process";
import { isModuleSubcommand, runModuleSubcommand } from "./module-cmd.ts";
import { banner } from "./banner.ts";
import { needsProviderSetup, } from "./onboarding.ts";
import { realReadModel, startupGate } from "./startup.ts";
import { isSessionsSubcommand, runPruneSubcommand } from "./prune.ts";
import { attachRender as attachRenderTo, TOOL_MERGE, registerToolLabels } from "./render.ts";
import { ringTurnBell } from "./bell.ts";
import { resolveBellMode, playTurnChime } from "./chime.ts";
import { createStreamView, type StreamChunk } from "./tui/streamview.ts";
import { DocModel } from "./tui/docmodel.ts";
import { FullApp, type SlashItem } from "./tui/fullapp.ts";
import * as theme from "./theme.ts";

import { lookupModelVision, readCatalogDiskCache, defaultCatalogCacheFile, defaultMenuDeps, snapshotProviderView, catalogPreferredListModels, diskFirstCatalogLoader, openaiListModels, anthropicListModels, seedBundledCatalog, catalogProviderView } from "@orosus/provider-custom";
import { persistToolWebSearch, upsertSecret } from "@orosus/tool-web";
import { persistVisionModel } from "@orosus/tool-media";
import { detectSources, findGitRoot, importMirror, importNotesProgressive, mergeLegacyMemory, memoryBucketKey, readSourceNotes, scanMirrorSources, type LlmStream, type PeerHomes } from "@orosus/tool-peers";
import { collectLaunchers } from "./module-launcher.ts";
import { killAllBackgroundJobs } from "@orosus/tool-shell";
import type { OnboardingDeps } from "./tui/onboarding.ts";
import type { ImportScope } from "./peers-settings.ts";
import { existsSync } from "node:fs";
import { imagesFor, extractImageRefs, PASTE_EMPTY, readClipboardText } from "./paste.ts";
import { attachAltVPaste } from "./altpaste.ts";
import { runPrint } from "./print.ts";
import { resolveAtRefs } from "./atfile.ts";
import { helpText } from "./help.ts";
import { seedFactorySkills } from "./skill-settings.ts";
import { loadHistoricalSubagents, openTasks, subagentUnloadBlock } from "./tasks-cmd.ts";
import { createLocaleStore, detectSystemLocale } from "./i18n/index.ts";
import { mainTables } from "./locales/index.ts";
import { bindAppLocale, t } from "./i18n/app.ts";
import { BTW_USAGE_HINT, openBtw, reopenBtw, type BtwDeps } from "./btw-cmd.ts";
import { backgroundRunningCount } from "./subagent-status.ts";
import { isCompactCommand, withCompactHint } from "./compact-hint.ts";
import { setModuleEnabledInConfig } from "./module-toggle.ts";
import { loadConfig } from "@orosus/core"; // 读配置单一事实源(m4-8 T2.5；路由/窗口兜底链随族迁 config-face.ts)
import { configFace, configFaceTui, configFaceTuiBell, configFaceTuiLatex, moduleConfigFileFor } from "./config-face.ts";
import { shortenPath, withLiveTokens } from "./usage-text.ts";
import { abortVisionTranscribe, attachPendingImage, eyeModelUsable, imageSeqNow, pasteImageToMedia, pendingImageFiles, pendingLineSeqsRef, resetPendingLineSeqs, visionCandidates, visionTranscribing, waitVisionTranscribe } from "./vision-media.ts";
import { activeDirRef, applySwitch, createSession, currentBucket, echoHistory, initActiveDir, inputHistoryFor, INPUT_ECHO_EVENT, prepareSwitch, purgeIfEmptySession, sessionsDir, sessionsRoot, setActiveDir, switchBusyGate, switchStepsFor, switchTo, type SessionDeps } from "./session-io.ts";
import { mcpConnRows, type McpUiDeps } from "./mcp-ui.ts";
import { refreshSkillMenu, skillInjectText, skillMenuTtl, skillTypedName, type SkillUiDeps } from "./skills-ui.ts";
import { SKILL_MARK_PREFIX } from "./i18n/protocol-strings.ts";
import { openSettingsLine, openSettingsPanel, type SettingsUiDeps } from "./settings-ui.ts";
import { fireStartupUpdateCheck, markBannerRendered, shouldSkipStartupCheck, updateInfoNow } from "./update-check.ts";
import { isUpgradeSubcommand, runUpgradeSubcommand } from "./upgrade-cmd.ts";
import { readUpdateCheckEnabled } from "./update-settings.ts";
import { buildHookBuckets, injectionRowsOf, type HooksUiDeps } from "./hooks-ui.ts";
import { initReplIo, nextLine, notify, question, rl, secretQuestion, settleCommandError, stdoutEcho } from "./repl-io.ts";
import { activeModuleNames, applyModulePresetImpl, closeGoneModuleUi, getPanelCache, lockReasonFor, moduleCards, modulePresetOf, permissionOf, refreshPanel, reloadModulesIdle, sessionLabelOf, setPanelCache, type ModulesUiDeps } from "./modules-ui.ts";
import { toggleResultText } from "./module-toggle-result.ts";
import { computeMountClosure, computeUnmountClosure } from "./module-deps.ts";
import { formatStartupError } from "./startup-error.ts";
import { readDiagnostics, readDiagRawLines, renderDetail, moduleOf } from "./module-diagnostics.ts";
import { atMenuEntries as atMenuEntriesHost } from "./at-menu-entries.ts";
import { panelTasksFromEvent } from "./todo-panel.ts";
import { resolveTuiMode, resolveLatexFlag } from "./tuicfg.ts";
import { setLatexEnabled } from "./md/latex.ts";
import { maybeEnableEnvProxy, envProxyUrl, proxyDisplayText, readWindowsSystemProxy, detectTunProxy } from "./proxy-env.ts";
import { ESC_CANCELLED } from "./i18n/protocol-strings.ts";

// 批 D（2026-10-01 拍板 A+B）：代理环境自动接线——机理与副作用披露见 proxy-env.ts；
// 必须赶在任何 fetch 发生前（undici 全局分发器首用时读取 NODE_USE_ENV_PROXY）
maybeEnableEnvProxy();

// m5-update-check：启动期更新检测点火（D2/D5）——必须在代理接线后（fetch 走系统代理）。
// 守卫：[update] check 开关（缺省开，项目压用户）+ dev 形态（0.0.0-dev）+ 头less（--print/--version/子命令）。
fireStartupUpdateCheck({
  enabled: readUpdateCheckEnabled(join(orosusHome(), "config.toml"), join(process.cwd(), ".orosus", "config.toml"))
    && OROSUS_VERSION !== "0.0.0-dev"
    && !shouldSkipStartupCheck(process.argv.slice(2)),
  lateNotify: (line) => notify(line),
});

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

// T1（release-npm）：`orosus --version` / `-v` 早退——单行版本号即退（G3：无 ASCII banner，banner 属
// TUI 启动面），先于子命令拦截与 parseArgs（parseArgs 不识 --version 会按未知参数报错）
{
  if (parseEarlyFlags(process.argv.slice(2)).version) {
    console.log(`orosus ${OROSUS_VERSION}`);
    await exitCli(0);
  }
}

// 子命令拦截（M2 接口总表：互斥于 flag 之外先解析）——M2 补账：T8/T13 处理器此前从未接线，
// `orosus provider ...` / `orosus module ...` 会被 flag 解析器当未知参数拒收
{
  const argv = process.argv.slice(2);
  const homeDir = orosusHome();
  try {
    if (isProviderSubcommand(argv)) {
      // CM-06①：处理器抛错（坏 TOML parse/IO 拒绝）此前穿透模块顶层 = Node 裸堆栈——整块兜底转人话 + 退出码 1
      const code = await runProviderSubcommand(argv, {
        configPath: join(homeDir, "config.toml"),
        secretsPath: join(homeDir, "secrets.env"),
        env: process.env,
        out: (l) => console.log(l),
      });
      // 防御性驻留（2026-10-07 实测定档）：fetch 后紧接 process.exit 在 Node v24 win32 撕 undici 池句柄
      // （libuv 断言 exit 127）——upgrade 快路径实证三连炸；provider 冷缓存基线 exit 0（取数后的写盘/
      // 输出工作量天然错开竞态窗）但无防御，统一收口同款 150ms
      await new Promise((r) => setTimeout(r, 150));
      await exitCli(code);
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
    if (isUpgradeSubcommand(argv)) {
      // m5-update-check T4：`orosus upgrade` 自升级子命令（D3）——独立取数，不受 [update] check 开关影响（D4）
      const code = await runUpgradeSubcommand(argv, {
        configPath: join(homeDir, "config.toml"),
        tmpDir: join(homeDir, "tmp"),
        out: (l) => console.log(l),
      });
      // Node v24 win32 实测（2026-10-07 最小复现实锚）：fetch 后紧接 process.exit 撕 undici 池句柄 →
      // libuv 断言 exit 127。150ms 驻留让池安定再走排空退出；自然退出路径同验干净但拦截面后还有
      // 整段 REPL 装配、不能自然流过（CM-06② 同源约束）。provider 子命令冷缓存同款隐患（邻近既有，未动）
      await new Promise((r) => setTimeout(r, 150));
      await exitCli(code);
    }
  } catch (err) {
    // CM-06①：兜底面按「harness 创建」划界的旧口径漏掉子命令——坏 config 遇 `provider list` 即裸堆栈；
    // 政策与 formatStartupError 同族（人话 + 非零退出，不带栈）
    console.error(t("main.subCmdFail", { err: err instanceof Error ? err.message : String(err) })); // i18n:diag stderr 诊断面——键化走查定
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
// 会话目录分桶三件（sessionsRoot/currentBucket/sessionsDir）与 activeDir/purgeIfEmptySession/
// createSession/echoHistory/switchTo 随会话族迁 session-io.ts（m5-split-main T5）；
// activeDir 初始化在原位调用（求值时机不变：locate → 初值，先于下方清扫块）
initActiveDir(args.resume);

// 空会话残留清扫（2026-10-01 用户拍板清理批②）：启动即扫当前项目桶，清掉上次异常退出留下的 0 消息壳
// （正常退出由 sessionLoop 退出漏斗就地清——走不到漏斗的进程被杀/崩溃壳归这里兜底）。只扫当前桶：他桶
// 等该项目下次打开时自清。豁免 --resume 目标（用户点名要打开的空会话不能进门就被清）；他实例活锁占用
// 的跳过。MCP 模块 activate 即写 mcp/manifest 令每次启动物化会话文件——不发消息退出即壳，这是壳的主源
{
  const swept = sweepEmptySessions(sessionsDir, new Set(args.resume !== undefined ? [args.resume.sessionId] : []));
  if (swept.removed.length > 0) console.error(t("main.sweep.done", { n: swept.removed.length })); // i18n:diag stderr
}

// 行模式 IO 族（stdoutEcho/rl/行队列/询问四件/notify/settleCommandError）迁 repl-io.ts（m5-split-main T11）——
// repl-io 模块体在 import 期即建 rl（先于本文件体执行，早于原位——无 fetch、无事件泵参与，行为等价）
const RUN_STARTED_AT = new Date().toISOString(); // 运行时间锚（F5 九轮⑤ 用户拍板：本次进程运行时长，非会话年龄）
let activeApp: FullApp | undefined;
// repl-io 晚绑定注入（m5-split-main T11）：两闭包运行期解引用，时序等价原模块内直读
initReplIo({ getH: () => h, getActiveApp: () => activeApp });

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
const terminalMenuIo = (tty = true) => {
  const modal = createModal({ input: process.stdin, isTTY: tty, write: (s) => lv.write(s) });
  return {
    isTTY: tty,
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
            if (n === undefined) throw new Error(ESC_CANCELLED);
            return n;
          }
          lv.write(`${t("main.pick.header", { title: title })}
`);
          const n = await pick(items, terminalMenuIo());
          if (n === undefined) throw new Error(ESC_CANCELLED);
          return n;
        },
      }
    : {};

// m5-ask-multi（T4）：chooseEx 增强挑选面装配——三路：全屏 pickOverlay opts（合成索引快照组装
// string[]）/ 行模式 pick(opts)（键路同 kimi 语义表，「其他」恒尾在此组装）/ 非 TTY pick 的 D13
// 编号/文本回落（chooseExFace 不随 pickFace 的 TTY 门——管道喂「3」/「1,3」/自由文本照常工作）。
// undefined = Esc（createReadlineUi chooseEx 侧统一转「已取消（Esc）」，MB-08 穿透不动）。
const chooseExFace = async (title: string, items: string[], opts?: { multi?: boolean }): Promise<string[] | undefined> => {
  if (activeApp !== undefined) return await activeApp.pickOverlay(title, items, 0, undefined, { custom: true, ...opts });
  lv.write(`${t("main.pick.header", { title: title })}
`);
  const r = await pick(items, terminalMenuIo(process.stdin.isTTY === true), opts ?? {});
  if (r === undefined) return undefined;
  const out = r.picked.map((i) => items[i]!);
  if (r.custom !== undefined) out.push(r.custom); // 「其他」恒尾语义（T3 组装纪律）
  return out;
};

// m5 T2：viewText 上契约（全屏走 FullApp 弹窗——新几何/自定义键/排队；行模式落 console 多行）。
// 装配件独立在 uiface.ts（main.ts 是顶层脚本 import 即跑——装配层测试进不去）。
const commandUi = createCliUi({
  question,
  secretQuestion,
  ...pickFace,
  chooseExFace,
  notice: notify, // 瞬时提示出口（批⑧契约口）：模块侧 ui.notice 同走 toast
  activeApp: () => activeApp,
  // m5 T4：贴图 = 注册表登记 + chip token 进输入框光标位（Alt+V 同款链路）；路径校验不过走 toast
  attachImage: (app, path) => {
    if (!existsSync(path)) {
      app.showToast(`${t("main.paste.missing", { path: path })}`);
      return;
    }
    app.insertAtCursor(attachPendingImage(path));
  },
});

// 全屏会话切换的回显延期槽（F5 二轮⑯）：switch 后 dm 在 sessionLoop 顶重建——
// 当场回显等于写进即弃的旧 dm（用户实测：/sessions 切换后历史「没加载」）。
let pendingEcho: { notice: string; history: boolean } | undefined;
// T4（m5-resume-perf）先画后注水：full 模式切换只登记目标 sid 即返回（重活 createSession 不在
// processReplLine 里 await——FullApp 不冻屏）；sessionLoop 顶画框架后异步装载注水。
// isSwitching 门拦注水完成前的提交/再切换（切换不可逆：旧会话已 close，Esc 不中断）。
let pendingSwitchSid: string | undefined;
// T4b：/fork 就地换页意图（full 模式 processReplLine 只登记不干活——重活挪 forkInPlace 异步走）
let pendingForkIntent: { parentSessionId: string; atEntryId?: string; parentDir: string } | undefined;
let isSwitching = false;

// 顶层兜底 catch（T6/S7）：createHarness 抛错（坏配置 TOML、required 护栏阻断、T5 没盖住的）不再裸堆栈退出。
// 模块顶层 await——catch 内不能 return、也不能只设 exitCode 放行（后续 REPL 带着未初始化的 h 继续跑），
// process.exit(1) 直接拦住（同文件 --dump-modules 的 exit(0) 先例）
// ---- 口子四：设置服务写面 + 宿主状态读面（m5 T9；h 经模块级 let 引用——服务闭包调用期现读活会话）----

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
      preset: modulePresetOf(modulesDeps),
      theme: theme.activeThemeName(), // m5 T12：注册表 active 名（本批仓内恒「连山」）
      permission: permissionOf(events, cfg.approvalMode),
      ...(label !== undefined ? { sessionLabel: label } : {}),
      ...(activeApp !== undefined ? { sidebar: activeApp.stateRef.sidebarVisible } : {}),
      ...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
      usage,
    };
  },
};

/** 设置服务（m5 T9 骨架）：setModel/setEffort/setLabel 走 harness 同源出口（单一写者）；
 *  setTheme/applyModulePreset 为必选成员占位——本批 T12/T10 落地（中间提交拒绝带明话）；
 *  setSidebar/readClipboard 可选成员不装（T11 落地时装配）。 */
const settingsService: SettingsService = {
  setModel: async (qualified) => {
    const before = h.status().model;
    await h.setModel(qualified);
    notify(t("main.toast.modelSwitched2", { before, after: qualified })); // reportModelSwitch 同族——toast diff
  },
  setEffort: async (level) => {
    h.setEffort(level);
    notify(level === "auto" ? t("main.toast.effortAuto") : t("main.toast.effortSet", { level }));
  },
  setTheme: async (name) => {
    theme.setTheme(name); // 未知名抛错 = reject（模块自行 catch；契约口径——本批仓内仅连山一套，机制就绪）
    activeApp?.repaint(); // 新渲染面换新色（历史行旧色不重刷——设计空白 11 预期行为）
    notify(`${t("main.toast.themeSwitched", { name: name })}`);
  },
  setLanguage: async (tag) => {
    // m5-i18n T3：与 /locale 同源（h 写盘 + store 重建）；重绘 = 新面换新语言（流区旧行保持——D5 主题同款）
    await h.setLanguage(tag);
    await localeStore.setLanguage(tag);
    activeApp?.repaint(); // 渲染期现取面（菜单/帮助/横幅）立即换语
    // panelCache 冻结面（模块 desc/锁定因/新会话/未配置等快照串）须重算后再补一帧——否则要等下一次
    // 无关的 refreshPanel 触发（命令提交/turn 结束）才换语，用户实机观察到「关弹窗才变」（2026-10-07）
    void refreshPanel(modulesDeps).then(() => activeApp?.repaint()).catch(() => undefined);
    notify(t("main.toast.localeDone"));
  },
  applyModulePreset: async (preset) => {
    const { failed } = await applyModulePresetImpl(modulesDeps, preset);
    notify(failed.length > 0
      ? t("main.toast.presetPartial", { failed: failed.join("、") })
      : preset === "minimal" ? t("main.toast.presetMinimal") : t("main.toast.presetFull"));
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

let h: Harness;
/** m5-i18n T3：宿主语言 store——图槽现读（会话切换图随换代，rebuild 时现解析）；界面主目录 T4 起。 */
const localeStore = createLocaleStore({ getGraph: () => h.graph(), mainTables }); // m5-i18n T4 起主目录参与合并（T9 补接——pipe e2e 实锤）
/** 会话族装配依赖（m5-split-main T5，D2 签名注入）：main.ts 留守件经此穿给 session-io.ts 的
 *  createSession/switchTo（h/lastEventId/tuiMode/pendingEcho 走闭包访问器，调用期现读现写）。 */
const sessionDeps: SessionDeps = {
  args,
  commandUi,
  settingsService,
  hostInfo,
  settleCommandError,
  getH: () => h,
  setH: (nh: Harness) => {
    h = nh;
    nh.setModuleT(localeStore.t); // m5-i18n：换会话换 harness——翻译口重注入（store 跨会话存活）
  },
  resetLastEventId: () => { lastEventId = undefined; },
  isFullscreen: () => tuiMode === "full",
  deferEcho: () => { pendingEcho = { notice: "", history: true }; },
};
/** 模块面板/预设族依赖（m5-split-main T9，D2）：refreshSkillMenu 惰性闭包织入（skillDeps 后建、
 *  调用期现读——防 skills-ui/modules-ui 相互 import 的环）。 */
const modulesDeps: ModulesUiDeps = {
  getH: () => h,
  getActiveApp: () => activeApp,
  refreshSkillMenu: () => void refreshSkillMenu(skillDeps),
  proxyStateText,
  runStartedAt: RUN_STARTED_AT,
  permCycle: () => PERM_CYCLE,
};
/** MCP 面板族依赖（m5-split-main T6，D2）：reload 收尾链与全屏/行模式访问器穿给 mcp-ui.ts
 *  （闭包现读——refreshPanel/refreshSkillMenu 等定义在本文件后段，调用期恒已初始化）。 */
const mcpDeps: McpUiDeps = {
  getH: () => h,
  commandUi,
  activeModuleNames: () => activeModuleNames(modulesDeps),
  closeGoneModuleUi: (before) => closeGoneModuleUi(modulesDeps, before),
  refreshSkillMenu: () => refreshSkillMenu(skillDeps),
  refreshPanel: () => refreshPanel(modulesDeps),
  getActiveApp: () => activeApp,
};
/** 技能菜单族依赖（m5-split-main T7，D2）：reloadModulesIdle 为 T9 留守共用件（闭包现读）。 */
const skillDeps: SkillUiDeps = {
  getH: () => h,
  commandUi,
  reloadModulesIdle: (app, busyToast) => reloadModulesIdle(modulesDeps, app, busyToast),
};
/** 钩子面板族依赖（m5-hooks T10，技能面板同款三件）。 */
const hooksDeps: HooksUiDeps = {
  getH: () => h,
  commandUi,
  reloadModulesIdle: (app, busyToast) => reloadModulesIdle(modulesDeps, app, busyToast),
};
/** m5-peers 五源家目录（T6d——探测纯读，缺目录 = 未安装；settings 与引导两消费方共用，故置顶）。 */
const memorySourceHomes = (): PeerHomes => {
	const home = homedir();
	return {
		claude: join(home, ".claude"),
		zcode: join(home, ".zcode"),
		qwen: join(home, ".qwen"),
		codex: join(home, ".codex"),
		reasonix: join(home, ".reasonix"),
	};
};
/** m5-peers git root 探测（T6d：向上找 .git，找不到回退 cwd——cc/qwen 按项目记忆的定位基准）。
 *  m5-peers-import-fix T1：本体下沉包层 tool-peers/roots.ts（记忆桶键两消费方共用），此处改引。 */
/** 当前项目记忆桶目录（m5-peers-import-fix：git 根键——importWithOrganize / settingsDeps detect /
 *  引导 detectMemorySources 三消费方同桶同键）。 */
const currentMemoryDir = (): string => join(orosusHome(), "memories", "projects", memoryBucketKey(process.cwd()), "memory");
/** 当前项目记忆桶基根（T5 启动合并用）。 */
const memoryBaseDir = (): string => join(orosusHome(), "memories", "projects");
/** m5-peers 记忆导入核心（走查修订三：settings「记忆导入」与引导第 5 页共用）。
 *  逐条单通道本体在包层 importNotesProgressive（走查十一：机械档旧形整段同步+onProgress 没接 =
 *  全程零反应直跳完成态——下沉包层为可测）；目标 = 本项目记忆桶（与 env.memoryDir 同桶）。
 *  m5-peers-import-fix T6：mode="current" 目的地改桶键件 memoryBucketKey（git 根）；mode="all"
 *  按源分流——四家（cc/qwen/zcode/reasonix）走镜像各归各桶（scanMirrorSources 实时探测 +
 *  importMirror），codex（唯一无项目维度的源）仍导当前桶、条数并入结果（G12：projects 不 +1）。 */
const importWithOrganize = async (
	sourceIds: string[],
	organize: boolean,
	mode: ImportScope,
	onProgress?: (done: number, total: number, title: string) => void,
	signal?: AbortSignal,
): Promise<{ imported: number; skipped: number; merged: number; mirror?: { projects: number; unresolved: number } }> => {
	const cwd = process.cwd();
	const homes = memorySourceHomes();
	const memoryBase = memoryBaseDir();
	const llm: LlmStream = (req) => h.llm().stream(req);
	if (mode === "all") {
		const mirrorIds = sourceIds.filter(id => id !== "codex");
		let imported = 0, skipped = 0, merged = 0;
		let mirror: { projects: number; unresolved: number } | undefined;
		if (mirrorIds.length > 0) {
			const buckets = scanMirrorSources(homes).filter(b => mirrorIds.includes(b.sourceId));
			const r = await importMirror(memoryBase, buckets, {
				organize,
				llm,
				...(onProgress !== undefined ? { onProgress } : {}),
				...(signal !== undefined ? { signal } : {}),
			});
			imported += r.imported;
			skipped += r.skipped;
			mirror = { projects: r.projects, unresolved: r.unresolved };
		}
		if (sourceIds.includes("codex")) {
			const srcs = detectSources(homes, findGitRoot(cwd), cwd);
			const all = readSourceNotes(srcs.find(s => s.id === "codex")?.dir);
			const r = await importNotesProgressive(currentMemoryDir(), all, {
				organize,
				llm,
				...(onProgress !== undefined ? { onProgress } : {}),
				...(signal !== undefined ? { signal } : {}),
			});
			imported += r.imported;
			skipped += r.skipped;
			merged += r.merged;
		}
		return { imported, skipped, merged, ...(mirror !== undefined ? { mirror } : {}) };
	}
	const srcs = detectSources(homes, findGitRoot(cwd), cwd);
	const all = sourceIds.flatMap(id => readSourceNotes(srcs.find(s => s.id === id)?.dir));
	return importNotesProgressive(currentMemoryDir(), all, {
		organize,
		llm,
		...(onProgress !== undefined ? { onProgress } : {}),   // exactOptional：undefined 不显式入参
		...(signal !== undefined ? { signal } : {}),
	});
};
/** 设置面板族依赖（m5-split-main T8，D2）：panelCache 访问器 + 子面板族的既有依赖对象。 */
const settingsDeps: SettingsUiDeps = {
  getH: () => h,
  commandUi,
  getPanelCache: () => getPanelCache(),
  reloadModulesIdle: (app, busyToast) => reloadModulesIdle(modulesDeps, app, busyToast),
  skillDeps,
  hooksDeps,
  mcpDeps,
  // m5-peers 走查修订三 + 走查七-①：「记忆导入」数据口（settings 与引导第 5 页共用 importers 核心 + 模型整理）
  // m5-peers-import-fix T6：detect 传 destDir 拿 newCount（D7）+ global（codex 标注）；run 带 mode（D10/D11）
  peersImport: {
    detect: () => {
      const cwd = process.cwd();
      return detectSources(memorySourceHomes(), findGitRoot(cwd), cwd, currentMemoryDir())
        .map(s => ({ id: s.id, label: s.label, count: s.count, ...(s.newCount !== undefined ? { newCount: s.newCount } : {}), ...(s.global === true ? { global: true } : {}) }));
    },
    run: importWithOrganize,
  },
  // m5-i18n T3：「切换语言」行——store 与回执（full = repaint + toast；行模式 = out）
  localeStore,
  localeApplied: (toast) => {
    activeApp?.repaint();
    notify(toast);
  },
};
// 界面模式解析上移（T11 m5-resume-perf）：初始 createSession 的行模式装载判据（deps.isFullscreen）
// 需在 createSession 求值期读到 tuiMode——原声明位（runFullScreen 装配段前）晚于首个 createSession
// 调用，TDZ 炸启动。依赖（args/configFace/TTY）此点全就绪，纯前移零行为变。
// 界面模式（F3）：TTY 缺省 full（全屏双栏主模式），--tui line 显式降级滚动流；非 TTY 恒 line（硬保底）。
// 界面模式（F6）：--tui 旗标 > 配置 [tui] mode > TTY 缺省（resolveTuiMode 纯函数可测；
// 运行期不切换——Ctrl+T 互切已下线，用户拍板）
const cfgTuiMode = configFaceTui();
let tuiMode: "line" | "full" = resolveTuiMode(args.tui, cfgTuiMode, process.stdout.isTTY === true && process.stdin.isTTY === true);
try {
  h = await createSession(sessionDeps);
} catch (err) {
  console.error(formatStartupError(err, orosusHome(), new Date()));
  process.exit(1);
}
// m5-i18n T3：语言解析（config.language > 系统检测 P2 > en-US）+ 模块 ctx.t 注入；
// P1 提示一次（语言包未挂载 → 英文兜底；dump/print 无头路径不 notify 防 stdout 污染）
await localeStore.init(h.configuredLanguage() ?? detectSystemLocale());
h.setModuleT(localeStore.t);
bindAppLocale(localeStore.t); // tui 渲染面同源（试点 T4 起）
// m5-peers-import-fix T5/G8：旧 cwd 键记忆桶启动合并（桶键改 git 根的一次性迁移，D2）——整体 try-catch
// 包死不杀启动（半成品合并幂等可重入：importNotes 标题判重、下次启动重合零重复；唯一风险口 = 未捕获异常）
try {
  const merged = mergeLegacyMemory(memoryBaseDir(), process.cwd());
  if (merged.merged > 0) notify(t("main.peers.legacyMerged", { n: merged.merged }));   // G9 toast
} catch { /* fs 权限/桶损坏——静默跳过，下次启动幂等重试（G8：catch 由实施定） */ }
if (localeStore.packMissing() && args.dumpModules === undefined && args.print === undefined) {
  notify(t("main.locale.packMissing"));
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
    await echoHistory(h, commandUi);
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
// Alt+V 按键粘贴（TUI 批 T5）：keypress 多播拦截——与敲 /paste 完全同效；非 TTY 不挂（按键零处理）。
// keypress 事件发在输入流上（emitKeypressEvents(process.stdin)，与 rl.input 同一对象）；
// rl.line/rl.cursor 运行时可写（readline 公开属性）——@types/node 的 promises 变体声明为 readonly，窄化断言
// （挂起图片注册表与序号列随视觉族迁 vision-media.ts——m5-split-main T4；此处经访问器/注入闭包读写）
attachAltVPaste({
  input: process.stdin,
  isTTY: process.stdin.isTTY === true,
  pasteImage: () => pasteImageToMedia(sessionsDir, h.sessionId),
  write: (s) => lv.write(s),
  clearInputLine: () => {
    const w = rl as unknown as { line: string; cursor: number };
    w.line = "";
    w.cursor = 0;
  },
  setPendingImage: (file) => {
    const label = attachPendingImage(file);
    pendingLineSeqsRef().push(imageSeqNow()); // 行模式无文内 token——挂起序号列（提交时并入）
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
        ? [theme.fg("info", t("main.compact.emptySummary"))]
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
  const runningHooks = new Set<number>(); // hooks/run runId 在飞集（T11 状态行配对清）
  const hooksToasts = { untrusted: false, injectCap: false }; // 一次性提示去重（会话生命周期）
  const toolIo =
    tuiMode === "full"
      ? {
          toolCall: (name: string, args: Record<string, unknown> | undefined, callId?: string) => {
            if (name === "tool-subagent__spawn") dm.agentGroupCall();
            else dm.toolCall(name, args, callId);
          },
          toolResult: (output: unknown, isError: unknown, callId?: string, images?: unknown) => dm.toolResult(output, isError, callId, images),
          // 钩子注入折叠行（m5-hooks T10）：灰字一行直进 DocModel（不经 md 管线）；标签与回放/行模式同源
          injection: (line: string) => dm.pushLine(theme.fg("muted", t("main.fold.injection", { line }))),
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
        void refreshPanel(modulesDeps); // 面板数据随 turn 刷新（F4）
        // 回合提示音（2026-09-30 用户拍板）：完成 1 响/中断 2 响/错误 3 响——events() 是实时通道
        //（恢复回放走 pendingEcho/DocModel 重建，不经此），只响活体回合；TTY 且 [tui] bell 开才响
        if (bellMode !== "off" && process.stdout.isTTY === true) {
          if (bellMode === "chime") playTurnChime(e.kind, { // 自带音频一声（不分结局——响数区分是 BEL 档语义）
            onError: (stage, err) => h.log("tui.chime.error", t("main.bell.fail", { err: `${stage}：${err instanceof Error ? err.message : String(err)}` }), { stage: String(stage) }) // i18n:diag 日志面键化（值即原文）,
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
      // 钩子运行中状态行 + 一次性提示（m5-hooks T11/D20）：running 账到达亮尾行（完成账按 runId 配对清）；
      // skipped-untrusted / skipped-inject-cap 每会话只 toast 一次（闭包去重——reload 重建随新闭包重置）
      if (e.type === "hooks/run") {
        const run = e as { status?: string; runId?: number; hook?: string; name?: string; index?: number; total?: number };
        if (run.status === "running") {
          const counting = run.total !== undefined && run.total > 1 ? `（${run.index}/${run.total}）` : "";
          activeApp?.setHookStatus(t("main.hooks.running", { names: run.name ?? run.hook ?? "" }) + counting); // 显示名 name 优先（走查修：用户配了说明就不亮命令原文）
          runningHooks.add(run.runId ?? -1);
        } else if (run.runId !== undefined && runningHooks.delete(run.runId) && runningHooks.size === 0) {
          activeApp?.setHookStatus(undefined);
        }
        if (run.status === "skipped-untrusted" && !hooksToasts.untrusted) {
          hooksToasts.untrusted = true;
          const msg = t("main.hooks.skippedUntrusted");
          if (activeApp !== undefined) activeApp.showToast(msg); else notify(msg);
        }
        if (run.status === "skipped-inject-cap" && !hooksToasts.injectCap) {
          hooksToasts.injectCap = true;
          const msg = t("main.hooks.injectCap");
          if (activeApp !== undefined) activeApp.showToast(msg); else notify(msg);
        }
      }
      // 任务清单实时投影（2026-09-23 用户拍板）：载荷即全量清单，到一条改一条——不再等 turn 结束检查点。
      // panelCache 未就绪（启动历史重放先于首刷）跳过，refreshPanel 稍后自会从历史取 .at(-1)；
      // 全屏 FullApp 秒 tick 自动重绘，行模式无面板，改快照无害
      const todoTasks = panelTasksFromEvent(e);
      if (todoTasks !== undefined && getPanelCache() !== undefined) setPanelCache({ ...getPanelCache()!, tasks: todoTasks });
      // Tokens/上下文实时刷新（2026-10-04 用户拍板「有变化就得更新」）：模型请求结束（assistant/message
      // 落 usage）与压缩完成（input 换压缩后投影估算）即重算 tokens 就地写回——todo 同款事件级就地更新。
      // refreshPanel 只在 turn 结束重算，turn 进行中（agent 一轮可跑十分钟）面板会停在首刷旧值。
      if (e.type === "assistant/message" || e.type === "turn/compaction") {
        void h.history().then((events) => {
          const next = withLiveTokens(getPanelCache(), events);
          if (next !== undefined) setPanelCache(next);
        });
      }
    },
  );
}

process.on("SIGINT", () => h.cancel()); // Ctrl-C 中止当前 turn，不退出（h 为当前会话）

/** 单行处理（REPL 与全屏共用——F3 抽取）：会话生命周期指令 → "switch"（重挂横幅/渲染）；
 *  /quit → "quit"；其余 → "again"。out = 输出通道（REPL=console.log，全屏=DocModel.pushLine——
 *  全屏 alt-screen 下 console 输出会毁屏，一切带内输出必须进流区）。typedInput = 输入框原文（仅技能
 *  递归传——text 已是「标记行+原话+正文」合成体；旁注据此记原话，↑ 召回口径见 inputHistoryTexts）。 */
const processReplLine = async (text: string, out: (s: string) => void, typedInput?: string): Promise<"again" | "switch" | "quit"> => {
      const directive = sessionCommand(text, { sessionId: h.sessionId, lastEventId });
      if (directive.kind === "quit") return "quit"; // /quit 同义 /exit /q（用户要求 2026-09-18）——经 sessionCommand 可测面
      if (directive.kind === "pick") {
        // /sessions（别名 /resume）无参：列表 + choose 选中即 resume（B9 形态；非交互指路直达）
        if (!process.stdin.isTTY) { out(formatSessions(sessionsRoot, h.sessionId, currentBucket) + "\n" + t("main.sessions.nonTty")); return "again"; }
        const items = listSessions(sessionsRoot, currentBucket);
        if (items.length === 0) { notify(t("main.sessions.empty")); return "again"; }
        // D14 ②（2026-10-05 补接线）：刷会话列表时机后台全库补建事件索引——列表不依赖它（标题走
        // readSessionHead 预算读），void 不挡界面；已索引会话 mtime+size 双判命中零成本跳过
        void refreshEventIndex(defaultEventIndexFile(), sessionsRoot);
        // 走查定案（2026-09-19）：不选即取消——空输入 = 取消（专门「取消」项退役）。
        // TUI 批 T2：TTY 注入 picker 闭包（列表即菜单，序号/相对时间/${t("main.sessions.currentMark")}标记同行；
        // 不再先打印静态表格——picker 自带列表渲染），Esc reject 在 pickSessionNumber 内转 undefined
        const n = await pickSessionNumber(
          (q) => commandUi.ask(q),
          items.length,
          async () => {
            const labels = items.map(
              // 两段式（2026-09-28 用户拍板：子界面与斜杠主菜单同形）——标题白、相对时间灰、「${t("main.sessions.currentMark")}」标记青玉
              (s, i) => `${i + 1}. ${s.title} ${theme.dim(`· ${relativeTime(s.createdAtMs)}`)}${s.id === h.sessionId ? theme.fg("accent", t("main.sessions.currentMark")) : ""}`,
            );
            // 全屏期走 FullApp overlay（F5 走查实证：readline picker 的 modal 与 FullApp 抢 stdin 卡死）
            const n0 = activeApp !== undefined
              ? await activeApp.pickOverlay(t("main.sessions.pickTitle"), labels)
              : await pick(labels, terminalMenuIo());
            if (n0 === undefined) throw new Error(ESC_CANCELLED);
            return n0 + 1; // picker 0-based → 序号 1-based（与回落路径同口径）
          },
        );
        if (n === undefined) return "again";
        // T4（m5-resume-perf）：full 模式先画后注水——登记目标即返回，装载在 sessionLoop 顶异步走；
        // 行模式照旧同步切换（echoHistory 即时回显语义不变）
        if (switchStepsFor(sessionDeps).frameFirst) {
          pendingSwitchSid = items[n - 1]!.id;
          return "switch";
        }
        await switchTo(items[n - 1]!.id, sessionDeps);
        return "switch"; // 换 harness 后重挂横幅与渲染
      }
      if (directive.kind === "title") {
        // /title（批⑦）：无参 = 静默零输出零写入（旧「当前会话：…——/title <名> 命名」行退役——2026-09-22 用户拍板无意义）
        if (directive.name === undefined) return "again";
        // 当前会话（或目标解析回当前）走活 harness 写口——批⑦a 破链修复：旁路新建 store 写活文件
        // 会让活 store 内存 lastId/seq 失真，后续事件 parentId 链断裂；序号/sid 指定的非活会话保持旁路（单写者安全）
        const targetSid = directive.target !== undefined ? resolveTarget(directive.target, sessionsRoot, currentBucket) : undefined;
        if (directive.target !== undefined && targetSid === undefined) { notify(t("main.title.targetNotFound")); return "again"; }
        if (targetSid === undefined || targetSid === h.sessionId) {
          await h.setLabel(directive.name);
          // 命名确认走浮动 toast（2026-09-23 用户拍板——瞬时确认不落流区，/model 切换反馈同族）
          if (activeApp !== undefined) activeApp.showToast(t("main.title.renamedToast", { name: directive.name }));
          else out(t("main.title.renamedLine", { name: directive.name }));
        } else {
          const r = await setTitle(sessionsRoot, h.sessionId, directive.target, directive.name, currentBucket);
          if (r !== undefined) {
            if (activeApp !== undefined) activeApp.showToast(t("main.title.renamedOtherToast", { sid: r.sid, name: directive.name }));
            else out(t("main.title.renamedOtherLine", { sid: r.sid, name: directive.name }));
          } else notify(`${t("main.title.targetNotFound")} ${directive.target}`); // toast 化（2026-09-23 拍板）——目标回显在文案里补上下文
        }
        return "again";
      }
      if (directive.kind === "resume") {
        const sid = resolveTarget(directive.sessionId, sessionsRoot, currentBucket);
        if (sid === undefined) { notify(t("main.sessions.notFound", { sid: directive.sessionId })); return "again"; }
        if (switchStepsFor(sessionDeps).frameFirst) { // T4：先画后注水（同 /sessions 选择）
          pendingSwitchSid = sid;
          return "switch";
        }
        await switchTo(sid, sessionDeps);
        return "switch";
      }
      if (directive.kind === "new" || directive.kind === "fork") {
        // T4b（m5-resume-perf 走查修）：full 模式 /fork 就地换页——重活（父视图装载+建新会话+自动命名）
        // 挪 forkInPlace 异步走，此处只登记意图即返回（行模式与 /new 走下方原同步路径，用户拍板不动）
        if (directive.kind === "fork" && tuiMode === "full") {
          pendingForkIntent = {
            parentSessionId: directive.parentSessionId,
            ...(directive.atEntryId !== undefined ? { atEntryId: directive.atEntryId } : {}),
            parentDir: activeDirRef(),
          };
          return "switch";
        }
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
            h = await createSession(sessionDeps, { resume: { sessionId: sid }, sessionsDir: bucketDir }); // 同 sid 空档重开
            setActiveDir(bucketDir);
            lastEventId = undefined; // 与常规换会话同款重置（CS-05②：三处换会话缝一个口径）
            clearScreen();
            const notice = `${t("main.new.reusedEmpty", { sid: sid })}`;
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
        h = await createSession(sessionDeps, directive.kind === "fork"
          ? { ...harnessOptionsFor(directive, { parentDir: activeDirRef() }), sessionsDir }
          : { sessionsDir });
        if (from !== undefined && parentTitle !== undefined) await h.setLabel(`fork ${parentTitle}`);
        setActiveDir(sessionsDir);
        // CS-05②：/new 与 /fork 换会话同款重置——/new 的新会话尚无事件（header 懒写），残留旧会话尾事件
        // id 时立即 /fork 必 throw（投影外 atEntryId）；/fork 分支的重置是口径统一（父尾 id 虽仍在子投影
        // 内合法，统一回 undefined 走尾缺省——三处换会话缝一个口径，勿再单点漏）
        lastEventId = undefined;
        clearScreen(); // 用户走查（2026-09-19）：换会话清屏——旧会话残屏与"历史丢失"错觉同源
        const notice = from !== undefined
          ? t("main.fold.forkLine", { sid: from, new: h.sessionId }) // fork 继承父上下文（ForkedSessionStore 投影实证）——回显让继承可见
          : t("main.sessions.newLine", { sid: h.sessionId });
        if (tuiMode === "full") pendingEcho = { notice, history: from !== undefined }; // F5 二轮⑯ 延期
        else {
          out(notice);
          if (from !== undefined) await echoHistory(h, commandUi);
        }
        return "switch"; // 重挂横幅与渲染（新事件流）
      }
      // /help（M4-2 T21）：CLI 层拦截带说明版（D38 第一层——core 简版被遮蔽，非 CLI 宿主仍走 core 版）
      // CM-15①（2026-09-28 code review）：精确小写等值改走 cmdNameOf（归一 + 小写）——/HELP、/Help、
      // "/ help"（斜杠后空格抹除）与 core 路由口径一致（core 2026-09-27 起命令词忽略大小写），不再漏到
      // 「未知命令」；非命令文本（无斜杠）cmdNameOf 原样返回不匹配，直通不受影响
      if (cmdNameOf(text) === "/help") { out(helpText()); return "again"; }
      // /settings（M4-3 T1c/D9：/other 改名——别名平移 /config；/other 旧名直接消失〔2026-09-24 用户拍板，
      // 不留指路不转别名〕——打字面撞「未知命令」即知新家）
      // 注记（同日走查实锤）：本条拦截须在下方 try 的 catch-all 覆盖内——弹窗配置流的 choose/ask Esc
      // 抛「已取消（Esc）」，try 外无人接 = 进程 exit 7 前案；移入 try 后与 /model 等同政策静默
      // 退役命令指路（批⑤⑥——打字面肌肉记忆；/paste 先例是干净移除，此二条有明确新家故留一行）
      if (/^\/usage\s*$/.test(text.trim())) { notify(t("main.retired.usage")); return "again"; }
      if (/^\/status\s*$/.test(text.trim())) { notify(t("main.retired.status")); return "again"; }
      // 模型未配置拦截（F5 七轮用户拍板）：仅提问——斜杠命令（/provider 向导本身！）必须放行，
      // 否则「让你去配 /provider」结果 /provider 也被拦（八轮用户实测怒点）
      const isCmdLine = text.trim().startsWith("/");
      if (
        !isCmdLine &&
        needsProviderSetup({ model: realReadModel(process.cwd())(), providers: h.graph().services.listProviders().map((p) => p.name) })
      ) {
        notify(t("main.gate.providerUnconfigured"));
        return "again";
      }
      try {
        // /settings 拦截在 try 内首条——嵌套模块配置流（tool-web__settings 三级流）的 Esc 抛错落 catch-all 静默
        // CM-15①：精确小写等值改 cmdNameOf（/HELP 同款——大小写/斜杠后空格归一）
        if (cmdNameOf(text) === "/settings" || cmdNameOf(text) === "/config") {
          if (activeApp !== undefined) {
            await openSettingsPanel(activeApp, settingsDeps);
          } else {
            await openSettingsLine(out, settingsDeps);
          }
          return "again";
        }
        // /tasks（M4.5 T11）：子代理任务列表 + 查看窗 + 挂起审批应答（/task 单数同达——用户 2026-09-27）
        // CM-15①：精确小写等值改 cmdNameOf（/HELP 同款）
        if (cmdNameOf(text) === "/tasks" || cmdNameOf(text) === "/task") {
          await openTasks(activeApp, out, { getH: () => h, sessionsDir, commandUi, notify });
          return "again";
        }
        // /btw（m5-btw）：侧问——不打断主对话的旁路快问。宿主拦截（D2：md 渲染件在宿主侧、/tasks
        // 同构先例）；BUSY_EXEC 即改档（busy 期立即执行不占 inflight）。问题 = 命令词后的原文（trim、
        // 保持内部换行不重写用户原文——ZCode slashCommands 口径）；无参 = 回看最近一次问答（D7 内存
        // 槽重开窗），无记录/尚无归档 toast 用法提示（在飞问跑完自归档，不重开在飞窗）。out 恒传——
        // 是否回显由 openBtw/reopenBtw 内按 app===undefined（行模式）自裁，full 模式流区零痕迹（D6）
        if (cmdNameOf(text) === "/btw") {
          const btwQuestion = text.trim().replace(/^\/\s+/, "/").replace(/^\/btw/i, "").trim();
          const btwDeps: BtwDeps = { getH: () => h, out };
          if (btwQuestion === "") {
            if (!reopenBtw(activeApp, btwDeps)) notify(BTW_USAGE_HINT);
          } else {
            openBtw(activeApp, btwDeps, btwQuestion);
          }
          return "again";
        }
        // /skill : 名（2026-09-30 用户拍板：菜单技能条目 Tab ≠ Enter——Tab 填「/skill : 名」可输入
        // 形态；2026-10-03 方案 2 起菜单 Enter 也提交该格式——↑ 历史记命令形态，Tab 填形回车/手敲
        // 完整形态/菜单 Enter 三路在本层归一）。格式宽松：
        // /skill:名 /skill : 名 /SKILL 同达（命令词忽略大小写，core 2026-09-27 口径）；宿主级拦截
        // 先于 h.prompt 路由——graph 若注册 /skill 命令以本形态为准（技能区是宿主面）；解析成功
        // 递归走用户消息管线（回显/vision 闸/busy 排队语义三路一致，正文不以 / 开头无二次解析）
        // 防重入（2026-09-30 三轮走查修卡死）：本分支产出的合成消息同样以 /skill : 开头，而下面的
        // 空白折叠会把换行压平——正则会再次命中、typed 连标记带技能正文整条吞进「参数」再包一层
        // 递归提交，无限自缠绕 = CPU 死循环界面卡死（用户实机复现）。含机器标记行 = 已是合成体，
        // 跳过解析直送消息管线。
        const skillM = text.includes(SKILL_MARK_PREFIX)
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
            notify(namePart === "" ? t("main.skill.usage") : t("main.skill.notFound", { name: namePart }));
            return "again";
          }
          const body = skillInjectText(canonical, skillArgs);
          if (body === undefined) {
            notify(t("main.skill.readFail", { name: canonical }));
            return "again";
          }
          // 原话行持久化（2026-09-30 拍板「我输入啥就显示啥」含回放）：嵌在标记行之后、<skill> 正文
          // 之前——不放开头：/ 开头的合成消息会被管线尾部当命令路由（未知命令，消息根本不发——
          // 三轮走查实机踩坑），且重入技能解析。消息以「（」开头 → isCmdLine 为 false 走内建回显，
          // docmodel 拆分渲染 = 原话块 + ● 行，实时与回放同一口同形（无需本层显式回显）
          const bodyNl = body.indexOf("\n");
          return await processReplLine(`${body.slice(0, bodyNl)}\n${text}\n${body.slice(bodyNl + 1)}`, out, text); // typed=原话——合成体不带原话（引用已拼正文），召回旁注靠它
        }
        // 图片收集（2026-09-23 走查拍板）：全屏 = 文内 [image #N] token（extractImageRefs 剥除后进正文），
        // 行模式 = 挂起序号列；token 被用户删掉即不匹配 = 图不发出。chip 剥除在 @引用解析之前。
        const imgRefs = extractImageRefs(text);
        const textNoImg = imgRefs.cleaned;
        const imgSeqs = [...pendingLineSeqsRef(), ...imgRefs.seqs];
        const imgs = imgSeqs.map((q) => pendingImageFiles.get(q)).filter((f): f is string => f !== undefined);
        // 转述等待期不收第二条（走查四——单等待口：并发提交会在 harness 单并发守卫炸「已有进行中的
        // turn」丢消息；双 Esc 可中止后重发）
        if (visionTranscribing()) {
          notify(t("main.vision.busy"));
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
            const eye = await eyeModelUsable(modelNow, catalogAll, h);
            if (eye.usable) {
              const eyeModel = eye.model ?? ""; // usable=true 恒带 model（三态解析同源）
              if (!isCmdLine && tuiMode === "full") {
                dm.userPrompt(text);
                dm.visionTranscribeStart(eyeModel);
                echoed = true;
              } else notify(t("main.vision.transcribing", { model: eyeModel }));
              const res = await waitVisionTranscribe(imgs, tuiMode === "full" ? (d) => dm.visionDelta(d.kind, d.text) : undefined, h);
              if (res.state === "aborted") {
                if (tuiMode === "full") dm.visionTranscribeEnd(eyeModel, undefined, "aborted");
                notify(t("main.vision.aborted"));
                activeApp?.restoreInput(text);
                return "again";
              }
              if (res.state === "done") {
                if (tuiMode === "full") dm.visionTranscribeEnd(eyeModel, res.text, "done");
                else notify(t("main.vision.sent", { model: eyeModel }));
                vtNote = { model: eyeModel, ok: true, text: res.text };
              } else {
                if (tuiMode === "full") dm.visionTranscribeEnd(eyeModel, undefined, "failed");
                else notify(`${t("main.vision.failedLine")}`);
                vtNote = { model: eyeModel, ok: false };
              }
            } else {
              const why = eye.configured ? t("main.vision.noVision", { why: eye.why }) : t("main.vision.whyUnset");
              notify(t("main.vision.blocked", { model: modelNow || t("main.vision.whyNoModel"), why }));
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
        const reloadShot = cmdNameOf(text) === "/reload" ? activeModuleNames(modulesDeps) : undefined;
        // 旁注组装（紧随 user/message 原子落盘，数组形态——core 2026-10-03 放宽）：①转述旁注
        // （走查四，回放行序「问题→转述→回答」）；②输入召回旁注——发出体 ≠ 输入框原文时
        // （技能合成体/@ 引用展开/图片 chip 剥离）原话随盘，重开会话 ↑ 召回取它（2026-10-03
        // 用户拍板「召回的必须是我输入的内容」；此前技能正文整条进召回池——实测报 bug）。
        // 不进上下文：host/ 前缀未知类型 deriveMessages 跳过
        const typedText = typedInput ?? text;
        // T13（m5-resume-perf D3）：输入召回 sidecar 恒落（best-effort）——每条 user/message 记原话
        //（剥图片 chip）；旁注 host/input-echo 照旧只在「发出体≠原话」时落主转录，两者时序天然一致。
        // 命令不记（召回集合不含命令）；模块 steer 文本不经此层（queue steer 通道）天然不记。
        if (!isCmdLine) appendInput(activeDirRef(), h.sessionId, extractImageRefs(typedText).cleaned);
        const afterNotes: { type: string; fields: Record<string, unknown> }[] = [];
        if (vtNote !== undefined) afterNotes.push({ type: "host/vision-transcribe", fields: vtNote });
        if (withAt !== typedText) afterNotes.push({ type: INPUT_ECHO_EVENT, fields: { text: typedText } });
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
            ...(afterNotes.length > 0 ? { afterUserEvent: afterNotes } : {}),
          }),
        );
        for (const q of imgSeqs) pendingImageFiles.delete(q); // 已发出的图出注册表（取消/错误保留——旧口径）
        resetPendingLineSeqs();
        // /provider 写盘后自动重载模块图（2026-09-24 走查 bug 前案：会话内新加平台不进激活槽——/settings 的
        // LLM 钉模型清单读活槽，不重载即缺席；「设为当前默认」写的顶层 provider 键同理随重载即时生效）；
        // 只在写盘结果后重载（取消与未写入不动图）
        if (cmdNameOf(text) === "/provider" && PROVIDER_WRITE_DONE.test(cmdOut ?? "")) {
          const namesBefore = activeModuleNames(modulesDeps); // m5 T7：关消失模块的挂起窗
          await h.reload();
          await localeStore.rebuild(); // m5-i18n：语言包/catalog 槽随图重建
          closeGoneModuleUi(modulesDeps, namesBefore);
          notify(t("main.provider.reloaded"));
        }
        if (reloadShot !== undefined) closeGoneModuleUi(modulesDeps, reloadShot);
        if (cmdNameOf(text) === "/reload") { registerToolLabels(h.graph().tools.toolInfos()); void refreshSkillMenu(skillDeps); } // 标签表与技能菜单缓存随图重喂
        // 空串 = 静默约定（2026-09-22 用户拍板——/permission /yolo 切换成功不落流区行，面板 chip 自反映）
        if (cmdOut !== undefined && cmdOut !== "") {
          // 压缩完成行（2026-09-23 用户拍板）：石青（info）正文 + 灰（muted）括号段——ANSI 行必须走 raw
          // 通道不经 md 渲染（pushMd 会吃掉转义序列）；行模式 console 直出同款
          if (isCompactCommand(text) && (cmdOut.startsWith("上下文压缩完成") || cmdOut.startsWith("Compacted:"))) { // D4 双格式（en 形走查补键）
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

// busy 期命令分级（2026-09-22 批①②④⑦d 用户拍板）：
// BUSY_EXEC = 即改档——busy 期直接执行（/model 下一轮生效；/permission /yolo 本轮生效；/title 改名）；
// BUSY_BLOCK = 拦回车档——submitGate 拦在提交前（会话/配置操作没理由排队，也不写历史提示行）
const BUSY_EXEC = new Set(["/model", "/effort", "/permission", "/yolo", "/auto", "/title", "/rename", "/tasks", "/task", "/settings", "/config", "/btw"]); // /tasks 即档（2026-09-27 用户拍板：busy 期也要能立即看列表/应答审批——只读面不动 turn） // /settings 即档（m4-7 §3.7 前置：busy 期可开技能管理面——Alt + K 走「即改档但副作用缓挂」新档：写配置即时、reload 缓到空闲后用户手 /reload） // /auto 与 /yolo 同族（批⑧）；/effort 即改档同 /model（下一轮生效，2026-09-25） // /btw 即档（m5-btw：busy 期旁路快问立即执行、不占 inflight——侧问永不阻塞主输入；闲时同路径）
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
	const msg = t("main.toast.modelSwitched", { model: now });
	if (activeApp !== undefined) activeApp.showToast(msg);
	else console.log(`[${msg}]`);
};

/** /effort 切换反馈（/model 同约，2026-09-25）：前后 diff h.status().effort——含「首设」「清除」两态的措辞分野。 */
const reportEffortSwitch = (before: string | undefined): void => {
	const now = h.status().effort;
	if (now === before) return; // Esc/原样重选 = 未变化，零反馈
	const msg = now === undefined
		? t("main.toast.effortCleared")
		: before === undefined ? t("main.toast.effortSet2", { level: now }) : t("main.toast.effortSwitched2", { before, after: now });
	if (activeApp !== undefined) activeApp.showToast(msg);
	else console.log(`[${msg}]`);
};

const PERM_CYCLE = ["ask-risky", "ask-always", "never"];
/** 权限三档元数据（F5 十轮⑤ 拍板：档名 + 短解释 + 详细解释——菜单/芯片同源；2026-09-26 拍板显示名改中文，内部档名不变）。 */
/** m5-i18n T6：权限档 meta 改函数（渲染期 t()——切语言菜单随帧换文）；键 = perm.<档>.label/desc/long。 */
const permMeta = (): Record<string, { label: string; desc: string; long: string }> => ({
	"ask-always": { label: t("perm.askAlways.label"), desc: t("perm.askAlways.desc"), long: t("perm.askAlways.long") },
	"ask-risky": { label: t("perm.askRisky.label"), desc: t("perm.askRisky.desc"), long: t("perm.askRisky.long") },
	never: { label: t("perm.never.label"), desc: t("perm.never.desc"), long: t("perm.never.long") },
});
/** 斜杠命令清单（长说明——斜杠菜单详细说明区数据源；children = 二级列表命令）。 */
const slashItems = (): SlashItem[] => [
	// /yolo /auto 提至 /help 前（2026-09-22 用户拍板——高频切档键优先于${t("main.help.dockTitle")}）
	// 2026-09-26 拍板 D2 交叉互换（2026-09-28 走查修）：/yolo==需要时候询问（ask-risky）——详细文案用户拍板原文，档名对齐 /permission 菜单显示名
	{ name: "/yolo", desc: t("slash.items.yolo.desc"), long: t("slash.items.yolo.long") },
	// 2026-09-26 拍板：/auto 文案按「从不询问」档名表述（D8 显示名），语义 = 就算有问题也是模型自行判断；行为换绑 never 由本批 T2 落地（D1 拍板），沿革见 ROADMAP 走查三批与 m3b 方案
	{ name: "/auto", desc: t("slash.items.auto.desc"), long: t("slash.items.auto.long") },
	{ name: "/help", desc: t("slash.items.help.desc"), long: t("slash.items.help.long") },
	{ name: "/model", desc: t("slash.items.model.desc"), long: t("slash.items.model.long") },
	{ name: "/effort", desc: t("slash.items.effort.desc"), long: t("slash.items.effort.long") },
	{ name: "/provider", desc: t("slash.items.provider.desc"), long: t("slash.items.provider.long") },
	{
		name: "/permission", desc: t("slash.items.permission.desc"), long: t("slash.items.permission.long"), children: [...PERM_CYCLE], childMeta: permMeta(),
	},
	{ name: "/compact", desc: t("slash.items.compact.desc"), long: t("slash.items.compact.long") },
	{ name: "/sessions", aliases: ["resume"], desc: t("slash.items.sessions.desc"), long: t("slash.items.sessions.long") },
	// /summary 菜单条目已退役（2026-09-23 用户拍板）——查看口 = Ctrl+O（全屏 overlay/行模式直出）
	{
		name: "/settings", aliases: ["config"], desc: t("slash.items.settings.desc"), long: t("slash.items.settings.long"),
	},
	{ name: "/tasks", aliases: ["task"], desc: t("slash.items.tasks.desc"), long: t("slash.items.tasks.long") },
	{ name: "/btw", desc: t("slash.items.btw.desc"), long: t("slash.items.btw.long") },
	{ name: "/quit", aliases: ["exit", "q"], desc: t("slash.items.quit.desc"), long: t("slash.items.quit.long") },
	// F5 二轮⑨：既有命令全部进菜单（此前只有 10 条——/new /fork /resume /title /yolo /usage /status /reload 能打但菜单不可见）
	// 批⑤⑥：/usage /status 退役出菜单（并入 /settings 面板；打字面留指路）
	{ name: "/new", desc: t("slash.items.new.desc"), long: t("slash.items.new.long") },
	{ name: "/fork", desc: t("slash.items.fork.desc"), long: t("slash.items.fork.long") },
	{ name: "/title", aliases: ["rename"], desc: t("slash.items.title.desc"), long: t("slash.items.title.long") },
	{ name: "/reload", desc: t("slash.items.reload.desc"), long: t("slash.items.reload.long") },
];

// ---------- 技能菜单（m4-7 T7——服务倒挂：宿主消费 skill.catalog，模块不在优雅降级为零技能） ----------

/** catalog 行消费面类型（圈地纪律：消费侧类型结构本地声明）。 */
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
	theme.fg("accent", "│") + ` ${theme.bold(theme.fg("fg", `v${VERSION}`))}${theme.dim(" — 模块化 AI Agent Harness")}                         ` + theme.fg("accent", "│"), // i18n:brand D12 不翻——品牌身份
	theme.fg("accent", "│") + theme.fg("muted", " 玄墨为基，青玉点睛，石青、暖金、赭石各载其义。") + "           " + theme.fg("accent", "│"), // i18n:brand D12 不翻——品牌身份
	theme.fg("accent", "│") + theme.fg("muted", " 如层峦绵亘，灵脉贯通。") + "                                   " + theme.fg("accent", "│"), // i18n:brand D12 不翻——品牌身份
	theme.fg("accent", "╰──────────────────────────────────────────────────────────╯"),
	// 快捷键导引（2026-09-27 拍板：移出框外置框下，定两行——行 1 到 Ctrl + T 缩放侧栏、行 2 Alt + V 起头；
	// m5-peers T6e/D23：行 2 尾追加 Ctrl + P 模块——静态常驻，无登记模块时空态 toast 兜底）。
	// 2026-10-07 用户走查点名：两行是功能提示非品牌——D12 翻案改走键（banner.keys1/2，三语）；slogan 三行维持品牌不翻
	theme.dim(t("banner.keys1")),
	theme.dim(t("banner.keys2")),
	"",
];

const runFullScreen = async (): Promise<"switch" | "quit"> => {
  let action: "switch" | "quit" | undefined;
  void refreshSkillMenu(skillDeps); // m4-7 T7：技能菜单首刷（异步先取，菜单首开即有数据；后续走 TTL + reload 显式点）
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
        app.viewText(t("main.help.dockTitle"), helpText(), { layout: "dock" }); // 题头键归 T14 统一收口
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
        if (BUSY_EXEC.has(cmdN) || cmdN.includes("__")) { runSubmit(text, true); return; }
        // ↑ 走查八-①：模块命令（<module>__<command> 命名纪律）= 纯操作面（开窗/面板），busy 期即改档
        //   立即执行不排队（busyExec 单行输出不碰流块）——用户 busy 期按 /tool-peers__memory 被排队 = 图 1 事故
        pendingSubmits.push(text); // 队列区逐条显示（2026-09-23 队列批——尾行计数 chip 退役）
        return;
      }
      runSubmit(text);
    },
    submitGate: (text) => {
      // 批④：拦回车档的拒因（返回串 = 拦截——FullApp 尾行瞬显，输入保留不进历史）
      const c = cmdNameOf(text);
      return inflight && BUSY_BLOCK.has(c) ? t("main.busy.note", { cmd: c }) : undefined;
    },
    // CTU-11（2026-09-28 code review）：requestExit 死接口三方删除（本实现 + fullapp.ts 声明 + 测试桩）——
    // 2026-09-23 拍板 Ctrl+C 不占用、退出走 /quit 后成遗迹，全仓 grep 零真实调用方
    requestCancel: () => {
      h.cancel(); // Esc 忙碌时取消当前 turn（SIGINT 同效——修复轮②）
    },
    // 视觉转述等待期（走查四）：双击 Esc 中止口——vision-media.ts 模块级单等待（经访问器，m5-split-main T4）
    visionTranscribing: () => visionTranscribing(),
    abortVisionTranscribe: () => { abortVisionTranscribe(); },
    panelData: () => ({
      ...(getPanelCache() ?? {
        model: "…",
        session: t("panel.newSession"), // 首刷前占位——未命名口径与 refreshPanel 一致（sid 不可读）
        cwd: shortenPath(process.cwd(), 26),
        tokens: { input: 0, output: 0 },
        startedAt: undefined,
        contextWindow: configFace().contextWindow,
        modules: [],
        tasks: [],
        permission: configFace().approvalMode,
        permissionNext: () => "/permission ask-always",
      }),
      cards: moduleCards(modulesDeps), // m5 T6：卡片恒现读——不进 panelCache 快照（getter 每秒被读一次）
      network: getPanelCache()?.network === undefined ? undefined : { ...getPanelCache()!.network!, connections: mcpConnRows(mcpDeps) }, // 连接行每秒现读（mcp.catalog），KV 串用 refreshPanel 预取
    }),
    slashCommands: () => slashItems(),
    // 技能区（m4-7 T7）：TTL 惰性刷新——菜单渲染同步口吃缓存，被调时隔 5s 后台刷一次；
    // /reload 收尾与模块插拔后另有显式刷新点
    skillItems: () => skillMenuTtl(skillDeps),
    // （技能条目 Enter 2026-10-03 起提交「/skill : 名」走 processReplLine 解析——skillInject 注入口随旧实现退役）
    slashCurrent: (cmd) => (cmd === "/permission" ? (getPanelCache()?.permission ?? configFace().approvalMode) : ""),
    // 参数阶段数据源（m5 T15）：graph 现读模块命令的 completeArg；抛错兜底空表 + host 日志（菜单层当无候选）
    slashArgComplete: (cmd, word, args) => {
      const c = h.graph().commands.find((x) => `/${x.name}` === cmd);
      if (c?.completeArg === undefined) return undefined;
      try {
        return c.completeArg(word, args);
      } catch (err) {
        h.log("host.completer.error", `模块参数补全抛错，当无候选：${cmd}`, { error: String(err instanceof Error ? err.message : err) }); // i18n:diag 诊断日志面
        return [];
      }
    },
    sidebarInit: () => tuiSidebarRead(), // 即时读（F5 十四轮：会话切换重建 FullApp——不能用进程启动快照）
    onSidebarChange: (visible) => tuiSidebarPersist(visible), // Ctrl+T 状态持久化
    // Ctrl+O = 查看压缩摘要（2026-09-23 用户拍板：/summary 命令退役后的唯一入口；摘要文本灰色 muted）
    showCompactionSummary: async () => {
      const view = compactionSummaryView(await h.history(), { width: Math.max(20, (process.stdout.columns ?? 80) - 6) });
      if (view === undefined) {
        app.showToast(t("main.compact.emptySummary"));
        return;
      }
      // 全屏窗形态（2026-09-27 用户拍板：参照子代理查看窗）；全部压缩历史最新在最上、静态文档自顶读——
      // 不贴底（bottom 是 live 跟随用的）。折行宽 = full 弹窗内容区（ow−2 内衬 −2 内容边 −1 前导空格 = cols−6）
      app.viewText(view.title, view.text, { layout: "full" });
    },
    // Ctrl+H = 钩子活动查看窗（m5-hooks T10 / D19 三件套 + 走查修两级结构——注入多了分不清是哪条消息的）：
    // 一级 = 消息分桶（用户消息原文截断 + 该消息的钩子调用次数；首条消息前的活动〔SessionStart〕
    // 并入第一条消息桶——用户拍板无「会话启动」桶），回车进二级 = 该消息的**注入条目**（现行折叠行
    // 形态 + product 标注，回车看全文——用户拍板二级就是注入列表；运行状态/耗时不进二级，运行账只作
    // 一级计数与 product 归属）。数据源 = 会话日志事件流按位置归桶（buildHookBuckets），不改协议。
    showInjections: async () => {
      const buckets = buildHookBuckets(await h.history());
      if (buckets.length === 0) {
        app.showToast(t("main.hooks.emptyActivity"));
        return;
      }
      for (;;) { // 一级：消息列表
        const items = buckets.map((b) => `${b.label}${t("main.hooks.statLine", { n: b.runs.length, m: b.injections.length })}`); // 统计行整键（m=0 时表值含可选组可再优化——走查定）
        const picked = await app.pickOverlay(t("main.hooks.pickTitle"), items);
        if (picked === undefined) return; // Esc 关窗
        const b = buckets[picked]!;
        for (;;) { // 二级：该消息的注入条目（回车看全文 · Esc 回一级）
          const rows = injectionRowsOf(b);
          if (rows.length === 0) { app.showToast(t("main.hooks.noInjection")); break; }
          const picked2 = await app.pickOverlay(`${b.label}${t("main.hooks.injectFoot")}`, rows.map((r) => r.label));
          if (picked2 === undefined) break; // Esc 回一级
          app.viewText(t("main.hooks.injectFullTitle"), rows[picked2]!.text, { layout: "dock" }); // 不 await——FIFO 顶上回列表（技能面板同款）
        }
      }
    },
    // 模块卡回车 = 热插拔（2026-09-23 用户拍板）：锁定项 toast 锁因；可插拔项行级写 config enabled + h.reload()
    // T4 联动启停：硬依赖传递闭包——卸载带走依赖者、挂载自动补上提供者；撞锁定拒绝整次（S1）
    toggleModule: (name, lockedReason) => {
      if (lockedReason !== undefined) {
        app.showToast(t("main.hooks.lockSuffix", { name, why: lockedReason })); // 表值含前导「 · 」与锁名结构——走查核形
        return;
      }
      if (inflight) {
        app.showToast(t("main.module.busyToggle"));
        return;
      }
      const mounted = getPanelCache()?.modules.find((m) => m.name === name)?.state === "mounted";
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
        app.showToast(t("main.writePartialFail", { n: `${written}/${writeList.length}` }));
        return;
      }
      if (cascaded.length > 0) {
        // S10 拍板：toast 只报目标模块（上方 toggleResultText），连带名单写诊断日志——host.module.cascade
        h.log("host.module.cascade", `${t("main.cascade.verb")}${target ? t("modtoggle.verbMount") : t("modtoggle.verbUnmount")} ${name}${t("main.cascade.colon")}${target ? t("skills.action.enable") : t("mcp.action.disable")} ${cascaded.join("、")}`, { action: target ? "mount" : "unmount", target: name, cascaded }); // i18n:diag 日志面
      }
      void (async () => {
        try {
          const namesBefore = activeModuleNames(modulesDeps); // m5 T7：关消失模块的挂起窗
          const r = await h.reload();
          await localeStore.rebuild(); // m5-i18n：语言包/catalog 槽随图重建
          closeGoneModuleUi(modulesDeps, namesBefore);
          registerToolLabels(h.graph().tools.toolInfos()); // 插拔改变工具集合——标签表随图重喂
          void refreshSkillMenu(skillDeps); // m4-7 T7：技能菜单缓存随图刷新（停用后插拔即时生效）
          await refreshPanel(modulesDeps);
          app.showToast(toggleResultText(target ? "mount" : "unmount", name, r)); // 读 failed 清单——失败明说，不再假报成功（T2）
        } catch (err) {
          app.showToast(t("main.toggle.fail", { err: err instanceof Error ? err.message : String(err) }));
        }
      })();
    },
    thinkOpen: () => dm.thinkOpen,
    toggleThink: () => {
      dm.thinkOpen = !dm.thinkOpen;
    },
    // 模块诊断弹窗数据源（T9）：打开时现读（定案）——当天 + 前一天诊断日志过滤聚合（T8 读取器）
    diagEntries: () => readDiagnostics(join(orosusHome(), "logs"), new Date()),
    // 模块总览启动器数据源（m5-peers T6e）：打开时现读（D24 同款）——active 模块的 launcher 登记
    launcherEntries: () => collectLaunchers(h.graph().audit()),
    // @ 文件菜单数据源（m5-at-menu T5）：导航点现读、不缓存（atfile.ts 同目录件——tui 无 fs 纪律，
    // 宿主供数 UI 只消费）；失败 → miss（目录不存在空态）
    atMenuEntries: (dir) => atMenuEntriesHost(dir),
    // 二级详情文本（T10）：T8 条目 + 原始日志行（本模块事件 + 点名本模块的事件——主犯拖累反查）拼装
    diagDetail: (name: string): string => {
      const now = new Date();
      const dir = join(orosusHome(), "logs");
      const entry = readDiagnostics(dir, now).find((e) => e.name === name);
      if (entry === undefined) return t("main.diag.noRecord");
      const raw = readDiagRawLines(dir, now).filter((e) => moduleOf(e) === name || e.msg.includes(t("main.diag.providerOf") + name)); // i18n:diag 判据跟日志语言（zh 基准）
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
        notify(`${t("main.module.trustLineHint", { name: name })}`);
        return;
      }
      const handle = activeApp.openDialog({
        title: t("main.trust.enableModule", { name }) + "?",
        widgets: confirmDialogWidgets(info satisfies PendingModuleInfo & Record<string, unknown>),
        onEvent: (e) => {
          if (e.type !== "activate" || e.index !== 0) return undefined;
          void (async () => {
            try {
              trustModule(join(orosusHome(), "trust.json"), info.root, info.entryHash); // 动作 1：登记（项目级 hash 门/用户级认登记共用 trust.json——零新存储）
              setModuleEnabledInConfig(name, true, moduleConfigFileFor(name, h)); // 动作 2：写盘 enabled
              await h.reload(); // 动作 3：重跑信任判定 → 挂载
              await localeStore.rebuild(); // m5-i18n：槽随图重建
              registerToolLabels(h.graph().tools.toolInfos());
              await refreshPanel(modulesDeps);
              notify(`${t("main.module.confirmed", { name: name })}`);
            } catch (err) {
              notify(t("main.trust.fail", { err: err instanceof Error ? err.message : String(err) }));
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
    toggleSteps: () => {
      dm.toggleSteps(); // T9：轮内步级折叠（Alt+S）——开=splice 回原位、关=全轮重折，账本 stepsOpen 键收口
    },
    fetchOlderPage: async (): Promise<boolean> => {
      // T14：翻到顶懒分页——h.eventsBefore 索引取段（不设压缩边界，翻过压缩行取压缩前原文）→
      // dm.prependHistory 头部插页。空返 = 到会话开头（fullapp toast + 停触）
      const oldest = dm.oldestLoadedSeq;
      if (oldest === undefined) return false;
      const evs = await h.eventsBefore(h.sessionId, oldest, 500); // 一页 500 事件（qwen 同值——取大页减补页频率）
      if (evs.length === 0) return false;
      dm.prependHistory(evs, streamW());
      return true;
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
        const img = await pasteImageToMedia(sessionsDir, h.sessionId);
        if (img === undefined) {
          notify(PASTE_EMPTY()); // toast 化（2026-09-23 拍板）——无图提示不落流区
          return;
        }
        app.insertAtCursor(attachPendingImage(img.file)); // chip token 进输入框光标位（删除键可删 = 撤销挂图）
      })();
    },
  });
  // 输入历史播种（2026-09-23 实测：/sessions 恢复后 ↑ 无历史可召——FullApp 随会话重建即清零）：
  // 召回 = 我输入的内容（2026-10-03 拍板）——原话旁注优先、老会话技能合成体按标记行还原、图片
  // chip 剥除；推导收口 session-io inputHistoryTexts（行为钉在彼处测试件）
  app.seedHistory(isSwitching ? [] : inputHistoryFor(activeDirRef(), h.sessionId, await h.history())); // T13 sidecar 优先、老会话降级镜像窗口；T4 切换期跳过（注水完成补挂）
  // 流式排队面（F5 四轮）：turn 进行中的提交入队，结束后依序执行——消息带气泡、命令不带，
  // 全程不触碰活动 markdown/think 块（插队输出会把 DocModel 活动块 settle 掉 = 渲染乱）
  const pendingSubmits: string[] = [];
  let inflight = false;
  // busyExec = busy 即改档（批①②⑦d）：不占有/释放 inflight 与 busy（归进行中的 turn 所有），
  // 结果走单行 pushLine（md 块会 settle 活动流块——busy 期 [提示] 直写先例）；命令不产生 switch/quit 语义
  const runSubmit = (text: string, busyExec = false): void => {
    const gate = switchBusyGate(isSwitching); // T4：注水完成前拦回（切换不可逆但未就绪——旧会话已 close）
    if (gate.blocked) { notify(gate.message); return; }
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
        if (r === "switch" && (pendingSwitchSid !== undefined || pendingForkIntent !== undefined)) {
          // T4b：/resume /sessions 切换与 /fork 分叉就地换页——不退出 FullApp（闪空根因），旧内容留屏待原子替换
          const sid = pendingSwitchSid;
          pendingSwitchSid = undefined;
          const forkIntent = pendingForkIntent;
          pendingForkIntent = undefined;
          if (sid !== undefined) switchInPlace(sid);
          else forkInPlace(forkIntent!);
          return; // void-async 内 return：finally 照走（inflight/setBusy 复位 ✓）
        }
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
          void refreshPanel(modulesDeps);
          const next = pendingSubmits.shift();
          if (next !== undefined && action === undefined) runSubmit(next);
        } else {
          void refreshPanel(modulesDeps); // busy 即改档（/title /permission…）也要即时刷面板（2026-09-23：/title 改名单元格陈旧前案）
        }
      }
    })();
  };

  // T4b（m5-resume-perf 走查修）就地换页：full 模式切会话不再退出 FullApp——alt-screen 退出重进
  // 就是「瞬间啥都不显示」的根因。旧内容留屏、isSwitching 门拦提交（toast 反馈装载中）、装载
  // 完成后原子换 dm 上屏（io.docTotal/docWindow 每帧现读模块级 dm——换引用即换行源；新 dm 连同
  // 滑窗/账本在屏下建好再整体换上，旧 dm 整体弃置）。/fork 同走就地换页（forkInPlace——2026-10-05
  // 用户拍板）；/new 与行模式仍走退出重进（用户拍板不动）。
  // 共用换页尾段：新 h 的 dm（横幅+可选通知行+historyFrom 含 resume 即裁）在屏下建好再整体换
  // 引用上屏（io.docTotal/docWindow 每帧现读模块级 dm——换引用即换行源，换页帧即终态、无中间态），
  // 继而 attachRender/seedHistory/UX 态重置/懒分页重置/面板刷新一气呵成。
  const swapSessionIn = async (newH: Harness, opts: { notice?: string } = {}): Promise<void> => {
    const next = newMainDocModel();
    for (const l of ASCII_BANNER(OROSUS_VERSION)) next.pushLine(l);
    for (const line of banner(newH, { modelConfigured: !needsProviderSetup({ model: realReadModel(process.cwd())(), providers: newH.graph().services.listProviders().map((p) => p.name) }) })) next.pushLine(line);
    if (opts.notice !== undefined) next.pushLine(opts.notice);
    const hist = await newH.history();
    next.historyFrom(hist, streamW());
    dm = next;
    attachRender(newH); // 绑新 h 事件流到新 dm（attachRender 闭包现读模块级 dm）
    app.seedHistory(inputHistoryFor(activeDirRef(), newH.sessionId, hist));
    // UX 态重置（对齐旧路径「新 FullApp=干净开局」语义）：滚动贴底/输入清空/弹窗关/队列清
    const st = app.state;
    st.scrollBack = 0;
    st.input = "";
    st.cursor = 0;
    st.inputScroll = 0;
    st.selAnchor = -1;
    st.historyDraft = undefined;
    st.overlayOpen = false;
    st.atMenu = undefined;
    st.diagOpen = false;
    pendingSubmits.length = 0;
    app.sessionSwapped(); // T14 懒分页到头态重置（新会话可重新上翻）
    void refreshPanel(modulesDeps);
    app.scheduler.requestImmediateRender();
  };
  // 就地换页失败兜底（两路共用）：旧会话已 close + 新会话构造失败 → toast + 重建空会话
  const switchFailedFallback = async (err: unknown): Promise<void> => {
    settleCommandError(err);
    try {
      const fresh = await createSession(sessionDeps);
      applySwitch({ h: fresh, dir: activeDirRef() }, sessionDeps);
      attachRender(fresh);
    } catch (fatal) { settleCommandError(fatal); }
  };

  const switchInPlace = (sid: string): void => {
    const gate = switchBusyGate(isSwitching);
    if (gate.blocked) { notify(gate.message); return; }
    isSwitching = true;
    notify(t("main.switch.loading"));
    void (async () => {
      try {
        const prepared = await prepareSwitch(sid, sessionDeps, notify);
        if (prepared === undefined) return; // 未找到：旧会话未动（prepareSwitch 已 toast）
        applySwitch(prepared, sessionDeps);
        await swapSessionIn(prepared.h);
      } catch (err) {
        await switchFailedFallback(err);
      } finally {
        isSwitching = false;
      }
    })();
  };

  // T4b：/fork 就地换页（2026-10-05 用户拍板：fork 修、/new 不动）——父视图装载+建新会话+自动命名
  // 全异步走，旧内容留屏待原子替换；通知行走旧文案（「继承历史如下」——historyFrom 本就带入父前缀）。
  const forkInPlace = (intent: { parentSessionId: string; atEntryId?: string; parentDir: string }): void => {
    const gate = switchBusyGate(isSwitching);
    if (gate.blocked) { notify(gate.message); return; }
    isSwitching = true;
    notify(t("main.switch.forking"));
    void (async () => {
      try {
        const from = intent.parentSessionId;
        // fork 自动命名（2026-09-22 用户拍板）：「fork <父标题>」——/sessions 里父子一眼可辨
        const loc = locateSessionFile(sessionsRoot, from, { bucket: currentBucket });
        const parentTitle = loc !== undefined ? readTitle(loc.file, from) : from;
        await h.close();
        const nh = await createSession(sessionDeps, {
          fork: { parentSessionId: from, ...(intent.atEntryId !== undefined ? { atEntryId: intent.atEntryId } : {}), parentDir: intent.parentDir },
          sessionsDir,
        });
        if (parentTitle !== undefined) await nh.setLabel(`fork ${parentTitle}`);
        h = nh;
        setActiveDir(sessionsDir);
        lastEventId = undefined; // CS-05②：三处换会话缝一个口径（统一回 undefined 走父尾缺省）
        await swapSessionIn(nh, { notice: t("main.fold.forkLine", { sid: from, new: nh.sessionId }) }); // fork 继承父上下文——回显让继承可见
      } catch (err) {
        await switchFailedFallback(err);
      } finally {
        isSwitching = false;
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
    if (trigger.reason === "broken") app.showToast(t("main.onboarding.brokenToast")); // SW-20 定案话术
    else if (trigger.reason === "degraded") app.showToast(t("main.onboarding.degradedToast"));
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
      await localeStore.rebuild(); // m5-i18n：槽随图重建
      registerToolLabels(h.graph().tools.toolInfos()); // 引导激活的模块（tool-web 等）标签进表
      const ir = outcome.importResult;
      if (ir !== undefined) {
        app.showToast(t("main.ob.imported", { n: ir.imported, skip: ir.skipped, org: ir.merged > 0 ? ir.merged : undefined }), 6000);
      } else {
        app.showToast(t("main.onboarding.doneToast"));
      }
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
		const broken = loadConfig({ userFile: userConfigPath }).warnings.some((w) => w.includes(userConfigPath) && (/解析失败|parse/i.test(w))); // i18n:diag 判据双格式
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
		writeProvider: async (p) => {
			// CM-12③（2026-09-28 code review）：引导写盘 void 裸奔——IO 拒绝（EACCES/ENOSPC）即 unhandledRejection
			// 崩进程，用户视角「填完密钥程序炸了」；rejection 落 toast（notify：全屏=引导弹窗外浮层、行模式=单行），进程存活。
			// 2026-10-07 两修：① 展开既有条目（重输 Key 不再抹掉 defaultModel 等字段）；② 返回写盘 Promise
			// ——选模型子态要等条目落盘再 listModels（清单读盘取条目，与写盘竞态会拿空）。
			try {
				const cur = await menuDeps.loadProviders();
				const prev = cur[p.id];
				await menuDeps.saveProviders({
					...cur,
					[p.id]: { ...prev, type: p.type, baseUrl: p.baseUrl, ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}) },
				});
			} catch (err) {
				notify(t("main.provider.writeFail", { err: err instanceof Error ? err.message : String(err) }));
			}
		},
		// 条目补写 defaultModel（读-改-写——保 apiKey 等既有字段）：引导选模型子态选定落盘，
		// setModel 裸名的前置（D32——2026-10-07 引导写盘 bug 修复件）
		writeDefaultModel: (slot, model) => {
			void (async () => {
				const cur = await menuDeps.loadProviders();
				const prev = cur[slot];
				if (prev === undefined) throw new Error(t("main.slot.missing2", { slot }));
				await menuDeps.saveProviders({ ...cur, [slot]: { ...prev, defaultModel: model } });
			})().catch((err) => notify(t("main.provider.writeFail", { err: err instanceof Error ? err.message : String(err) })));
		},
		// secrets 统一走 upsertSecret（原位更新不累积重复行——引导内可重复输同一家 key；
		// provider/search 两类 key 同享，与 /settings 配置流同落点同语义）
		appendSecret: (envKey, value) => { upsertSecret(secretsFile, envKey, value); },
		setModel: (slot) => {
			// CM-12③：同上——setModel 写盘失败落 toast，不崩引导
			void menuDeps.setModel(slot).catch((err) => notify(t("main.provider.defWriteFail", { err: err instanceof Error ? err.message : String(err) })));
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
			if (entry === undefined) throw new Error(t("main.slot.missing2", { slot })); // 被 catch 吞无露出面（清单 §五备查键）
			const secrets = loadSecretsEnv(secretsFile).vars;
			const key = entry.apiKey?.startsWith("$ENV:") ? secrets[entry.apiKey.slice(5)] : entry.apiKey;
			const glue = { baseUrl: entry.baseUrl, ...(key !== undefined ? { apiKey: key } : {}) };
			const live = entry.type === "anthropic" ? anthropicListModels(glue) : openaiListModels(glue);
			return catalogPreferredListModels(slot, live, diskFirstCatalogLoader())();
		},
		// T6d 第 5 页（m5-peers）：五源探测 + 导入——importers 纯函数件经 deps 注入引导（onboarding 无 IO）
		detectMemorySources: () => {
			const cwd = process.cwd();
			const homes = memorySourceHomes();
			const srcs = detectSources(homes, findGitRoot(cwd), cwd, currentMemoryDir());
			return srcs.map(s => ({
				id: s.id, label: s.label, note: s.dir ?? t("main.src.notInstalled"), count: s.count, available: s.dir !== undefined,
				...(s.newCount !== undefined ? { newCount: s.newCount } : {}),
				...(s.global === true ? { global: true } : {}),
			}));
		},
		importMemory: (sourceIds, organize, mode) => importWithOrganize(sourceIds, organize, mode ?? "current"),
		// T8 落点行（G5/D6）：恒指当前项目落点 = git 根绝对路径（引导保持无 IO）
		destLabel: () => findGitRoot(process.cwd()),
	};
};

/** 引导初态：已配置槽 + 当前使用槽（顶层 provider 键的首段；指向不存在的槽按 null——损坏降级面）
 *  + 已带默认模型的槽（modelDone——这批槽 Space/裸名 setModel 合法，其余先进选模型子态）。 */
const onboardingInitial = async (): Promise<{ configured: string[]; active: string | null; modelDone: string[] }> => {
	const cur = await defaultMenuDeps().loadProviders();
	const curModel = realReadModel(process.cwd())();
	const slot = curModel === undefined || curModel === "" ? null : curModel.split("/")[0]!;
	return {
		configured: Object.keys(cur),
		active: slot !== null && cur[slot] !== undefined ? slot : null,
		modelDone: Object.entries(cur).filter(([, e]) => e != null && e.defaultModel !== undefined).map(([id]) => id),
	};
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
    // m5-update-check D1/D5：审计横幅下常驻一行（用户走查验形：与审计行间空一行 + 白字不 dim）——
    // 启动即渲染（盘上状态值/网络现值，无竞速等待）；晚到新发现走 notify 一次（fireStartupUpdateCheck
    // 内闩）；循环重入（/new /fork /sessions 切换）时现值直落
    {
      const upd = updateInfoNow();
      if (upd !== undefined) {
        const line = theme.fg("fg", t("update.banner", { v: upd.latest }));
        if (tuiMode === "full") {
          dm.pushLine("");
          dm.pushLine(line);
        } else {
          console.error("");
          console.error(line);
        }
      }
      markBannerRendered(upd !== undefined);
    }
    // T4b（m5-resume-perf 走查修）：full 模式 /resume /sessions 切换改就地换页（runSubmit 拦截
    // pendingSwitchSid → switchInPlace，不退出 FullApp——闪空根因拆除）；本循环顶只服务启动与
    // /new //fork 退出重进路径。
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
    void refreshPanel(modulesDeps); // 面板首刷（F4）
  // m5 T17：启动期一次性 toast——待确认第三方存在时提示（config 已 enabled 但未确认的也在此列：保持不挂载，回车确认后才启用）
  {
    const pending = h.pendingConfirms();
    if (pending.length > 0) notify(t("main.module.pending2", { n: pending.length }));
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
