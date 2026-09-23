import { createInterface } from "node:readline/promises";
import { orosusHome } from "@orosus/contracts/home";
import { OROSUS_VERSION } from "@orosus/contracts/version";
import { join } from "node:path";
import { createHarness, discoverModules, encodeCwd, locateSessionFile } from "@orosus/core";
import { deriveMessages } from "@orosus/core";
import { estimateTokens } from "@orosus/compaction";
import type { Harness, SessionEvent } from "@orosus/core";
import { BUILTIN_MODULES } from "./builtins.ts";
import { createReadlineUi, createSilenceableOutput } from "./menu.ts";
import { createModal, watchEsc, type KeyEvent } from "./keys.ts";
import { pick } from "./picker.ts";
import { formatSessions, harnessOptionsFor, listSessions, pickSessionNumber, readTitle, relativeTime, resolveTarget, sessionCommand, setTitle } from "./sessions.ts";
import { parseArgs } from "./args.ts";
import { isProviderSubcommand, runProviderSubcommand } from "./provider-cmd.ts";
import { isHomeSubcommand, runHomeSubcommand } from "./home-cmd.ts";
import { execFileSync } from "node:child_process";
import { isModuleSubcommand, runModuleSubcommand } from "./module-cmd.ts";
import { banner } from "./banner.ts";
import { needsProviderSetup, } from "./onboarding.ts";
import { realReadModel, startupGate } from "./startup.ts";
import { isSessionsSubcommand, runPruneSubcommand } from "./prune.ts";
import { renderHistoryLines, historyPage, attachRender as attachRenderTo, TOOL_MERGE } from "./render.ts";
import { createStreamView, type StreamChunk } from "./tui/streamview.ts";
import { DocModel } from "./tui/docmodel.ts";
import { FullApp, type PanelData, type SlashItem } from "./tui/fullapp.ts";
import * as theme from "./theme.ts";
import { parse, stringify } from "smol-toml";
import { lookupModelVision, readCatalogDiskCache, defaultCatalogCacheFile } from "@orosus/provider-custom";
import { readFileSync, writeFileSync } from "node:fs";
import { pasteImage, imagesFor, extractImageRefs, PASTE_EMPTY, imageChipLabel } from "./paste.ts";
import { attachAltVPaste } from "./altpaste.ts";
import { runPrint } from "./print.ts";
import { resolveAtRefs } from "./atfile.ts";
import { commandCompleter, HELP_TEXT } from "./help.ts";
import { withCompactHint } from "./compact-hint.ts";
import { resolveTuiMode, resolveLatexFlag, formatBytes, dirUsage } from "./tuicfg.ts";
import { setLatexEnabled } from "./md/latex.ts";

// 子命令拦截（M2 接口总表：互斥于 flag 之外先解析）——M2 补账：T8/T13 处理器此前从未接线，
// `orosus provider ...` / `orosus module ...` 会被 flag 解析器当未知参数拒收
{
  const argv = process.argv.slice(2);
  const homeDir = orosusHome();
  if (isProviderSubcommand(argv)) {
    process.exit(await runProviderSubcommand(argv, {
      configPath: join(homeDir, "config.toml"),
      secretsPath: join(homeDir, "secrets.env"),
      env: process.env,
      out: (l) => console.log(l),
    }));
  }
  // `orosus sessions prune`（M4-1 T2/D47）：显式清理——缺省 dry-run、--apply 才删、不做启动自动 GC
  if (isSessionsSubcommand(argv)) {
    process.exit(await runPruneSubcommand(argv, { out: (l) => console.log(l) }));
  }
  // `orosus home path|migrate`（M4-2.5 T6）：OROSUS_HOME 单一解析点 + 一键迁移（dry-run/apply、留证不删）
  if (isHomeSubcommand(argv)) {
    process.exit(await runHomeSubcommand(argv, {
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
    process.exit(await runModuleSubcommand(argv, {
      configPath: join(homeDir, "config.toml"),
      trustFile: join(homeDir, "trust.json"),
      discovered: discovered.map((m) => ({ name: m.def.name, root: m.root, entryHash: m.entryHash, layer: m.layer })),
      out: (l) => console.log(l),
    }));
  }
}

const args = parseArgs(process.argv.slice(2));
// 会话目录分桶（M4-1 T1/D46）：根 = ~/.orosus/sessions；新会话落当前项目桶 sessionsRoot/<encodeCwd(cwd)>/
const sessionsRoot = join(orosusHome(), "sessions");
const sessionsDir = join(sessionsRoot, encodeCwd(process.cwd()));
// --resume 双层定位（T1/D46）：旧平铺/他桶会话在原位续写（新事件仍进原文件）；找不到 = 全新空会话（M3 既有语义）
const resumeLoc = args.resume !== undefined ? locateSessionFile(sessionsRoot, args.resume.sessionId) : undefined;
let activeDir = resumeLoc?.dir ?? sessionsDir; // 当前 harness 的会话目录（/fork 的父定位依据）

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
const rl = createInterface({ input: process.stdin, output: stdoutEcho, completer: commandCompleter }); // Tab 补全（M4-2 T21，readline 原生）
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
const commandUi = createReadlineUi({
  question,
  secretQuestion,
  ...pickFace,
  // 瞬时提示出口（批⑧）：全屏 → 浮动 toast；行模式 → 单行
  notice: (t) => { if (activeApp !== undefined) activeApp.showToast(t); else console.log(t); },
});

const createSession = (extra: { fork?: { parentSessionId: string; atEntryId?: string; parentDir?: string }; resume?: { sessionId: string }; sessionsDir?: string } = {}) =>
  createHarness({
    builtinModules: BUILTIN_MODULES,
    commandUi,
    autoTitle: true, // B9 拉前：首轮问答完成自动起会话标题（核心缺省关，CLI 显式开——装配层）
    sessionsDir: extra.sessionsDir ?? activeDir,
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

let h = await createSession();
if (args.dumpModules) {
  console.log(h.graph().catalog());
  await h.close();
  process.exit(0);
}

// --print（M4-2 T17）：非交互单发——三格式输出后以 exitCode 收尾，不进 REPL、不触发首启引导/历史回显
if (args.print !== undefined) {
  await runPrint(h, args.print, args, (s) => console.log(s));
  rl.close();
  await h.close();
  process.exitCode = 0;
} else if (args.resume !== undefined) {
  // --resume 启动同样回显历史（B9 走查补——此前只有 REPL /resume 有）；
  // 全屏模式延期到 dm 重建后（F5 二轮⑯——tuiMode 此时未定，按 TTY 实况同口径预判）
  const notice = `[已恢复 ${h.sessionId}——历史对话如下]`;
  if (args.tui !== "line" && process.stdout.isTTY === true && process.stdin.isTTY === true) {
    pendingEcho = { notice, history: true };
  } else {
    console.log(notice);
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
  pasteImage,
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
// 渲染汇点多路复用（F3 双模式）：sink 指向当前模式的渲染出口——滚动流 = lv（streamview/DiffScreen），
// 全屏 = DocModel（FullApp 的行源）。模式切换只换 sink 指向，attachRender 订阅每会话一次不重挂。
let dm = new DocModel();
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
// 侧栏可见性持久化（F5 十二轮② 用户拍板：Ctrl+T 状态跨会话保留）——[tui] sidebar，缺省可见
function tuiSidebarRead(): boolean {
	for (const f of [join(orosusHome(), "config.toml"), join(process.cwd(), ".orosus", "config.toml")]) {
		try {
			const doc = parse(readFileSync(f, "utf8")) as { tui?: { sidebar?: unknown } };
			if (typeof doc.tui?.sidebar === "boolean") return doc.tui.sidebar;
		} catch {
			/* 缺文件/解析失败用缺省 */
		}
	}
	return true;
}
function tuiSidebarPersist(visible: boolean): void {
	const f = join(orosusHome(), "config.toml");
	let doc: Record<string, unknown> = {};
	try {
		doc = parse(readFileSync(f, "utf8")) as Record<string, unknown>;
	} catch {
		/* 缺文件从空起 */
	}
	doc.tui = { ...(doc.tui as Record<string, unknown>), sidebar: visible };
	writeFileSync(f, stringify(doc), "utf8");
}

// Ctrl+T 运行期互切已下线（用户拍板：界面模式只由 --tui 旗标 / [tui] mode 配置在启动时选定）。

function attachRender(h: Harness): void {
  // 双写面（T4/v1.8；F3 多路复用）：chunk 路 TTY 进 sink.activity，事件路 sink.write（直写）；
  // 非 TTY 只传 write = 现状等价。onEvent 升级完整事件——turn/end 驱动 sink.end() 定格终稿
  // 全屏追加工具结构化口（2026-09-23 走查批）：tool/call / tool/result 带 args/output 进 DocModel
  // （diff/失败体渲染）；行模式不传 = renderEvent 文本形态不变
  const toolIo =
    tuiMode === "full"
      ? {
          toolCall: (name: string, args: Record<string, unknown> | undefined) => dm.toolCall(name, args),
          toolResult: (output: unknown, isError: unknown) => dm.toolResult(output, isError),
        }
      : {};
  attachRenderTo(
    h,
    { write: (s) => sinkFor().write(s), ...(process.stdout.isTTY === true ? { activity: (c) => sinkFor().activity(c) } : {}), ...toolIo },
    (e) => {
      lastEventId = e.id;
      if (e.type === "turn/end") {
        sinkFor().end();
        void refreshPanel(); // 面板数据随 turn 刷新（F4）
      }
    },
  );
}

process.on("SIGINT", () => h.cancel()); // Ctrl-C 中止当前 turn，不退出（h 为当前会话）

// 恢复会话（B9 拉前）：双层定位 → 原位续写（新事件仍进原文件——平铺/他桶均在原位）
const switchTo = async (sid: string, out: (s: string) => void = (s) => console.log(s)): Promise<void> => {
  const loc = locateSessionFile(sessionsRoot, sid);
  if (loc === undefined) { out(`未找到会话 ${sid}（/sessions 查看列表）`); return; }
  await h.close();
  h = await createSession({ resume: { sessionId: sid }, sessionsDir: loc.dir });
  activeDir = loc.dir;
  const notice = `[已恢复 ${readTitle(loc.file, sid)}（${sid}）——历史对话如下]`;
  if (tuiMode === "full") {
    pendingEcho = { notice, history: true }; // 延期到 dm 重建后（F5 二轮⑯）
  } else {
    out(notice);
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
        if (!process.stdin.isTTY) { out(formatSessions(sessionsRoot, h.sessionId) + "\n（非交互环境——用 /resume <序号|sid> 直达恢复）"); return "again"; }
        const items = listSessions(sessionsRoot);
        if (items.length === 0) { out("（暂无会话——发送第一条消息即创建）"); return "again"; }
        // 走查定案（2026-09-19）：不选即取消——空输入 = 取消（专门「取消」项退役）。
        // TUI 批 T2：TTY 注入 picker 闭包（列表即菜单，序号/相对时间/（当前）标记同行；
        // 不再先打印静态表格——picker 自带列表渲染），Esc reject 在 pickSessionNumber 内转 undefined
        const n = await pickSessionNumber(
          (q) => commandUi.ask(q),
          items.length,
          async () => {
            const labels = items.map(
              (s, i) => `${i + 1}. ${s.title} · ${relativeTime(s.createdAtMs)}${s.id === h.sessionId ? "（当前）" : ""}`,
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
        const targetSid = directive.target !== undefined ? resolveTarget(directive.target, sessionsRoot) : undefined;
        if (directive.target !== undefined && targetSid === undefined) { out("[未找到目标会话]"); return "again"; }
        if (targetSid === undefined || targetSid === h.sessionId) {
          await h.setLabel(directive.name);
          // 命名确认走浮动 toast（2026-09-23 用户拍板——瞬时确认不落流区，/model 切换反馈同族）
          if (activeApp !== undefined) activeApp.showToast(`已命名 → ${directive.name}`);
          else out(`[已命名 → ${directive.name}]`);
        } else {
          const r = await setTitle(sessionsRoot, h.sessionId, directive.target, directive.name);
          if (r !== undefined) {
            if (activeApp !== undefined) activeApp.showToast(`已命名 ${r.sid} → ${directive.name}`);
            else out(`[已命名 ${r.sid} → ${directive.name}]`);
          } else out(`[未找到目标会话]`); // 失败保留带内（要可读可回翻）
        }
        return "again";
      }
      if (directive.kind === "resume") {
        const sid = resolveTarget(directive.sessionId, sessionsRoot);
        if (sid === undefined) { out(`未找到会话「${directive.sessionId}」——/sessions 查看列表`); return "again"; }
        await switchTo(sid);
        return "switch";
      }
      if (directive.kind === "new" || directive.kind === "fork") {
        const from = directive.kind === "fork" ? directive.parentSessionId : undefined;
        // fork 自动命名（2026-09-22 用户拍板）：「fork <父标题>」——/sessions 里父子一眼可辨；
        // 经 h.setLabel 活写口（header 已由 harness fork 分支即刻落盘，链序 header→fork→label）
        const parentTitle = from !== undefined
          ? (() => { const loc = locateSessionFile(sessionsRoot, from); return loc !== undefined ? readTitle(loc.file, from) : from; })()
          : undefined;
        await h.close();
        // 新会话/fork 子会话一律落当前项目桶；fork 父会话按 activeDir 定位（可能在平铺或他桶——resume 旧会话后 /fork）
        h = await createSession(directive.kind === "fork"
          ? { ...harnessOptionsFor(directive, { parentDir: activeDir }), sessionsDir }
          : { sessionsDir });
        if (from !== undefined && parentTitle !== undefined) await h.setLabel(`fork ${parentTitle}`);
        activeDir = sessionsDir;
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
      if (text === "/help") { out(HELP_TEXT); return "again"; }
      // /other（F5 十六轮③：config 改名——其他详细信息；磁盘占用 + 上下文用量双子项）；行模式指路
      if (text === "/other" || text === "/config") {
        if (activeApp !== undefined) {
          await openOtherPanel(activeApp);
        } else {
          out("详细信息面板为全屏形态（--tui full 进入）。磁盘占用/上下文用量在行模式可看：du ~/.orosus 与 /context");
        }
        return "again";
      }
      // 退役命令指路（批⑤⑥——打字面肌肉记忆；/paste 先例是干净移除，此二条有明确新家故留一行）
      if (/^\/usage\s*$/.test(text.trim())) { out("[已退役] /usage 并入 /other → Token 用量"); return "again"; }
      if (/^\/status\s*$/.test(text.trim())) { out("[已退役] /status 并入 /other → 运行状态"); return "again"; }
      // 模型未配置拦截（F5 七轮用户拍板）：仅提问——斜杠命令（/provider 向导本身！）必须放行，
      // 否则「让你去配 /provider」结果 /provider 也被拦（八轮用户实测怒点）
      const isCmdLine = text.trim().startsWith("/");
      if (
        !isCmdLine &&
        needsProviderSetup({ model: realReadModel(process.cwd())(), providers: h.graph().services.listProviders().map((p) => p.name) })
      ) {
        out("[提示] 还没有配置任何平台和模型——输入 /provider 打开配置向导（选平台 → 填端点与密钥 → 选模型），配好后直接提问");
        return "again";
      }
      try {
        // 图片收集（2026-09-23 走查拍板）：全屏 = 文内 [image #N] token（extractImageRefs 剥除后进正文），
        // 行模式 = 挂起序号列；token 被用户删掉即不匹配 = 图不发出。chip 剥除在 @引用解析之前。
        const imgRefs = extractImageRefs(text);
        const textNoImg = imgRefs.cleaned;
        const imgSeqs = [...pendingLineSeqs, ...imgRefs.seqs];
        const imgs = imgSeqs.map((q) => pendingImageFiles.get(q)).filter((f): f is string => f !== undefined);
        // 非 vision 模型拦截（F5 二轮⑭）：含图消息先查 models.dev 目录——明确不支持图片输入则拒发
        // （坏消息落日志后每轮重发 = 会话永久报废，用户实测痛点）；目录未命中（自架模型）放行。
        // 注：模型判定走 config 面值——/model 会话内覆盖在 harness 闭包内，CLI 不可见（持久化则同值）。
        if (imgs.length > 0) {
          const modelNow = realReadModel(process.cwd())() ?? "";
          const vision = lookupModelVision(readCatalogDiskCache(defaultCatalogCacheFile()) ?? {}, modelNow);
          if (vision === false) {
            out(`[已拦截] 当前模型 ${modelNow || "（未配置）"} 的目录数据显示不支持图片输入——消息未发送，图片仍挂起（/model 换视觉模型后再发，或 /sessions 另起会话）`);
            activeApp?.restoreInput(text); // 全屏：输入原文（含 chip token）回挂——提交已清输入框
            return "again";
          }
        }
        // @文件引用（M4-2 T18）：引用替换为附着内容（限 5 个/50KB，超限提示带内）
        const { text: cleaned, attachments } = resolveAtRefs(textNoImg, process.cwd());
        const withAt = attachments.length > 0 ? `${cleaned}\n\n${attachments.join("\n\n")}` : cleaned;
        // 命令输入时 harness.prompt 返回命令输出（D38）——必须回显（M2 补账：原实现从不打印，命令「敲了没反应」）
        // /compact 进度指示（TUI 批 T7）：命中时 h.prompt 前经 lv 写指示行，settle 后 discard 擦除——
        // 结果/错误由下方 console 输出（不经 liveview），视觉上指示行被结果替换；非 TTY 零输出变化。
        // isTTY 取 stdout（写侧关切，与 lv/attachRender 双写面同口径——输出入管时硬保证不被指示行污染）
        const cmdOut = await withCompactHint(
          text,
          // 全屏期不走 lv（直写 stdout 毁 alt-screen——F5 走查实证）；忙碌 spinner 已承载进度语义
          {
            isTTY: process.stdout.isTTY === true && activeApp === undefined,
            activity: (s) => lv.activity({ kind: "text", text: s }),
            discard: () => lv.discard(),
          },
          () => h.prompt(withAt, imagesFor(imgs)), // 挂起的图以 image part 随本条消息发出（M4-2.5 T5；文内 token 形态自 2026-09-23）
        );
        for (const q of imgSeqs) pendingImageFiles.delete(q); // 已发出的图出注册表（取消/错误保留——旧口径）
        pendingLineSeqs = [];
        // 空串 = 静默约定（2026-09-22 用户拍板——/permission /yolo 切换成功不落流区行，面板 chip 自反映）
        if (cmdOut !== undefined && cmdOut !== "") out(cmdOut);
      } catch (err) {
        // Esc 带内取消（TUI 批 T3/D52③）静默回提示符——「[错误] 已取消（Esc）」行是噪音
        // （2026-09-20 用户实测拍板，推翻方案 v1.9「[错误] 呈现为可接受取舍」的留档）。机制不变：
        // 取消仍以抛错带内表达，仅 REPL 呈现面不再按错误打印。
        if (!(err instanceof Error && err.message === "已取消（Esc）")) {
          out(`[错误] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
  return "again";
};

/** 全屏模式循环（TUI 批阶段三 F3）：FullApp 接管终端（alt-screen 双栏），
 *  Ctrl+T → 切回滚动流（requestLineMode 改写 tuiMode）；Ctrl+C → 退出；会话生命周期指令 → switch 重挂。
 *  提交走 processReplLine 共用体（输出通道 = dm.pushLine——console 输出在全屏下毁屏）。 */
// ---------- 全屏面板数据与斜杠清单（F4——真实数据源接线；原型图右栏组件清单逐行） ----------

/** 路径压缩（工作目录 KV——v1.11 三档：家目录 → ~ / 头+…+尾两级 / 只留尾两段）。 */
const shortenPath = (p: string, maxW: number): string => {
	const home = orosusHome();
	let s2 = p;
	if (p === home || p.startsWith(home + "\\") || p.startsWith(home + "/")) s2 = "~" + p.slice(home.length);
	if (s2.length <= maxW) return s2;
	const parts = s2.split(/[\\/]/); // F5 走查实修：原 /[\/]/ 只劈正斜杠，Windows 路径整串落入「…\+全路径」
	const tail = parts.slice(-2).join("\\");
	if (parts.length > 3) {
		const cand = parts[0] + "\\…\\" + tail; // 头+…+尾两段（F5 二轮：旧模板 \$ 把插值转义成字面量——rig 实证 C:…${tail}）
		if (cand.length <= maxW) return cand;
	}
	return "…\\" + tail;
};

/** 末条 usage 输入/输出分拆（core jsonl.ts lastUsageTotal 同口径复制——/context 回退锚：末条即最近上下文规模）。
 *  F5 二轮⑤：面板 Tokens 行要 ↑ 输入 · ↓ 输出 分列，不再合并总量。
 *  v3 压缩后口径（2026-09-23 实机首例二：压缩成功但面板仍显示压缩前 73k——末条 usage 停在压缩前的请求，
 *  数字回落被滞后掩盖到下一条消息）：末条 turn/compaction 晚于末条 usage 时，input 换压缩后投影估算
 *  （deriveMessages 已应用压缩事件）并置 postCompaction 标记。 */
const lastUsageOf = (events: SessionEvent[]): { input: number; output: number; postCompaction?: boolean } => {
  let usageSeq = -1;
  let result = { input: 0, output: 0 };
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "assistant/chunk") {
      const c = e.chunk as { type?: string; input?: number; output?: number } | undefined;
      if (c?.type === "usage") { result = { input: c.input ?? 0, output: c.output ?? 0 }; usageSeq = e.seq; break; }
    }
    if (e.type === "assistant/message") {
      const u = e.usage as { input?: number; output?: number } | undefined;
      if (u !== undefined) { result = { input: u.input ?? 0, output: u.output ?? 0 }; usageSeq = e.seq; break; }
    }
  }
  const lastCompaction = events.filter((e) => e.type === "turn/compaction").at(-1) as { seq?: number } | undefined;
  if (lastCompaction !== undefined && (lastCompaction.seq ?? 0) > usageSeq) {
    return { input: estimateTokens(deriveMessages(events)), output: result.output, postCompaction: true };
  }
  return result;
};

/** 配置面读数（contextWindow + approval.mode 缺省——用户层 → 项目层同 §6.6 分层）。 */
const configFace = (): { contextWindow: number; approvalMode: string } => {
	let contextWindow = 200000;
	let approvalMode = "ask-risky";
	for (const f of [join(orosusHome(), "config.toml"), join(process.cwd(), ".orosus", "config.toml")]) {
		try {
			const doc = parse(readFileSync(f, "utf8")) as { contextWindow?: number; approval?: { mode?: string } };
			if (typeof doc.contextWindow === "number") contextWindow = doc.contextWindow;
			if (typeof doc.approval?.mode === "string") approvalMode = doc.approval.mode;
		} catch {
			/* 缺文件/解析失败用缺省 */
		}
	}
	return { contextWindow, approvalMode };
};

/** [tui] latex 读数（mdpipe 批 T7）：boolean | undefined；分层同 configFaceTui。 */
function configFaceTuiLatex(): boolean | undefined {
	for (const f of [join(orosusHome(), "config.toml"), join(process.cwd(), ".orosus", "config.toml")]) {
		try {
			const doc = parse(readFileSync(f, "utf8")) as { tui?: { latex?: unknown } };
			if (typeof doc.tui?.latex === "boolean") return doc.tui.latex;
		} catch {
			/* 缺文件/解析失败用缺省 */
		}
	}
	return undefined;
}

/** [tui] mode 读数（用户层 → 项目层同 §6.6 分层；F6）。function 声明——早处初始化要用（hoisting）。 */
function configFaceTui(): string | undefined {
	for (const f of [join(orosusHome(), "config.toml"), join(process.cwd(), ".orosus", "config.toml")]) {
		try {
			const doc = parse(readFileSync(f, "utf8")) as { tui?: { mode?: string } };
			if (typeof doc.tui?.mode === "string") return doc.tui.mode;
		} catch {
			/* 缺文件/解析失败用缺省 */
		}
	}
	return undefined;
}

/** 磁盘占用视图文本（F6——ROADMAP 缓存目录条目③销账面）。 */
const diskUsageText = (): string => {
	const home = orosusHome();
	const names = ["cache", "sessions", "logs", "tmp", "modules"];
	const lines: string[] = [];
	let total = 0;
	let totalFiles = 0;
	for (const name of names) {
		const u = dirUsage(join(home, name));
		total += u.bytes;
		totalFiles += u.files;
		lines.push(`${name.padEnd(10)}${formatBytes(u.bytes).padStart(10)}   ${u.files} 个文件`);
	}
	lines.push("");
	lines.push(`${"合计".padEnd(10)}${formatBytes(total).padStart(10)}   ${totalFiles} 个文件`);
	lines.push("");
	lines.push(`根目录：${home}`);
	lines.push("清理口径：cache 可安全删除（目录缓存可再拉取）；tmp 为粘贴图片暂存，重启不清、可手动清；sessions 是会话历史（/sessions prune 可清理）。");
	return lines.join("\n");
};

/** 上下文用量视图文本（F5 十六轮③：/context 并入——panelCache 同源数据）。 */
const ctxUsageText = (): string => {
	const cfg = configFace();
	const p = panelCache;
	const model = (() => {
		const v = realReadModel(process.cwd())() ?? "";
		if (v === "") return "（未配置）";
		if (v.includes("/")) return v.split("/").pop()!;
		return v;
	})();
	const used = p?.tokens.input ?? 0;
	const pct = cfg.contextWindow > 0 ? Math.min(100, Math.round((used / cfg.contextWindow) * 100)) : 0;
	return [
		"上下文用量",
		"",
		`模型　　　${model}`,
		`窗口　　　${cfg.contextWindow.toLocaleString()} tokens`,
		`已用　　　~${used.toLocaleString()} tokens（${pct}%）${p?.tokens.postCompaction === true ? "（压缩后估算——下一条消息发出后按实际请求刷新）" : ""}`,
		`输入累计　↑ ${(p?.tokens.input ?? 0).toLocaleString()}`,
		`输出累计　↓ ${(p?.tokens.output ?? 0).toLocaleString()}`,
		"",
		"口径：已用 = 最近一次请求的输入规模（上下文体量；压缩后至下一条消息前 = 压缩后投影估算）；累计 = 本会话末条 usage。上下文增长到阈值会自动压缩（/compact 可手动）。",
	].join("\n");
};

/** /other 详细信息面板（批⑤⑥：四子项 = 磁盘占用 + 上下文用量 + Token 用量 + 运行状态；
 *  数据源 = harness 读口 h.usage()/h.status()——/usage /status 内建命令已退役）。 */
const openOtherPanel = async (app: FullApp): Promise<void> => {
	const picked = await app.pickOverlay("其他详细信息", ["磁盘占用（各目录大小与清理口径）", "上下文用量（窗口占用与输入输出累计）", "Token 用量（本会话与项目累计）", "运行状态（模型 / 会话 / 模块图）"]);
	if (picked === 0) app.viewText("磁盘占用", diskUsageText());
	else if (picked === 1) app.viewText("上下文用量", ctxUsageText());
	else if (picked === 2) {
		try {
			const u = await h.usage();
			const lines = [`当前会话：input ${u.current.input} / output ${u.current.output} tokens`];
			if (u.lifetime !== undefined) lines.push(`累计（当前项目 ${u.lifetime.sessions} 场会话）：input ${u.lifetime.input} / output ${u.lifetime.output} tokens`);
			app.viewText("Token 用量", lines.join("\n"));
		} catch (err) {
			app.viewText("Token 用量", `[错误] ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (picked === 3) {
		const st = h.status();
		app.viewText("运行状态", [
			`model: ${st.model}${st.overridden ? "（运行期覆盖）" : ""}`,
			`session: ${st.sessionId}`,
			`模块图: active ${st.modules.active} / failed ${st.modules.failed} / discovered ${st.modules.discovered}`,
		].join("\n"));
	}
};

// busy 期命令分级（2026-09-22 批①②④⑦d 用户拍板）：
// BUSY_EXEC = 即改档——busy 期直接执行（/model 下一轮生效；/permission /yolo 本轮生效；/title 改名）；
// BUSY_BLOCK = 拦回车档——submitGate 拦在提交前（会话/配置操作没理由排队，也不写历史提示行）
const BUSY_EXEC = new Set(["/model", "/permission", "/yolo", "/auto", "/title", "/rename"]); // /auto 与 /yolo 同族（批⑧）
const BUSY_BLOCK = new Set(["/new", "/sessions", "/session", "/resume", "/provider", "/summary"]);
const cmdNameOf = (text: string): string => text.trim().replace(/^\/\s+/, "/").split(" ")[0]!.toLowerCase();

/** /model 切换反馈（2026-09-22 用户拍板：harness 静默返回，流区不落行）：前后 diff h.status().model——
 *  变了才反馈；全屏走浮动 toast（输入框上边缘黄字 3s 自消），行模式单行打印。面板「运行状态」卡随 refreshPanel 同步。 */
const reportModelSwitch = (before: string): void => {
	const now = h.status().model;
	if (now === before) return; // Esc/原样选择 = 未切换，零反馈
	const msg = `模型已切换 → ${now}（已写入 config）`;
	if (activeApp !== undefined) activeApp.showToast(msg);
	else console.log(`[${msg}]`);
};

const PERM_CYCLE = ["ask-risky", "ask-always", "never"];
/** 权限三档元数据（F5 十轮⑤ 用户拍板：英文档名 + 短解释 + 详细解释——菜单/芯片同源）。 */
const PERM_META: Record<string, { label: string; desc: string; long: string }> = {
	"ask-always": { label: "Always Ask", desc: "每次工具调用都确认", long: "最高安全档：每一次工具调用（包括只读文件）都要你确认后才执行。浏览陌生代码库、敏感目录或不信任的会话时用。" },
	"ask-risky": { label: "Ask When Needed", desc: "仅危险操作确认", long: "日常默认档：只读操作（读文件、列目录）直接放行，写文件、执行命令、网络请求等有副作用的操作才确认。" },
	never: { label: "Never Ask", desc: "全部自动放行", long: "全自动档：此模式开启期间，所有工具批准都自动处理（含危险命令）；只有你手写的 deny 规则仍会拦。完全信任当前会话、追求连续执行时用。" },
};
let panelCache: PanelData | undefined;

/** 面板数据异步刷新（渲染是同步路径——历史/审计读取只能预取）：会话顶/turn 结束/定时三驱。 */
const refreshPanel = async (): Promise<void> => {
	const events = await h.history();
	const cfg = configFace();
	const lastPolicy = events.filter((e) => e.type === "approval/policy").at(-1) as { mode?: string } | undefined;
	const permission = lastPolicy?.mode ?? cfg.approvalMode;
	const lastTodo = events.filter((e) => e.type === "tool-todo/write").at(-1) as
		| { todos?: { content: string; status: "pending" | "in_progress" | "done" }[] }
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
      // 会话项显示标题（2026-09-23 用户拍板——sid 不可读）；未命名回退 sid
      const lastLabel = events.filter((e) => e.type === "session/label").at(-1) as { label?: string } | undefined;
      return lastLabel?.label ?? h.sessionId;
    })(),
		cwd: shortenPath(process.cwd(), 26),
		tokens: lastUsageOf(events),
		startedAt: RUN_STARTED_AT, // 本次进程启动（F5 九轮⑤：resume 旧会话不再显示历史年龄）
		contextWindow: cfg.contextWindow,
		modules: h
			.graph()
			.audit()
			.map((a) => ({
				name: a.name,
				desc: a.name === "orosus-core" ? "核心循环" : "",
				state: a.state === "active" ? ("mounted" as const) : ("off" as const),
				...(a.name === "orosus-core" ? { locked: true } : {}),
			})),
		tasks: (lastTodo?.todos ?? []).map((t) => ({
			text: t.content,
			state: t.status === "done" ? ("done" as const) : t.status === "in_progress" ? ("active" as const) : ("pending" as const),
		})),
		permission,
		permissionNext: () => `/permission ${next}`,
	};
};

/** 斜杠命令清单（长说明——斜杠菜单详细说明区数据源；children = 二级列表命令）。 */
const SLASH_ITEMS: SlashItem[] = [
	// /yolo /auto 提至 /help 前（2026-09-22 用户拍板——高频切档键优先于帮助）
	{ name: "/yolo", desc: "一键从不询问", long: "权限模式直达「从不询问」：所有工具批准自动处理（含危险命令；手写 deny 规则仍拦）。等同于 /permission never。回答进行中也可执行，本轮生效。" },
	{ name: "/auto", desc: "一键日常默认档", long: "权限模式直达「Ask When Needed」（只读放行、危险确认）。等同于 /permission ask-risky。回答进行中也可执行，本轮生效。" },
	{ name: "/help", desc: "帮助与快捷键", long: "显示全部斜杠命令与快捷键的对照表。快捷键三区焦点循环：Tab 在输入区、模块面板、任务面板之间移动；Esc 忙碌时取消回答、闲时返回输入区。" },
	{ name: "/model", desc: "切换模型槽位", long: "列出当前厂商下已配置的模型槽位，上下键选择后回车即热切换，会话不中断。槽位为空时会引导先走 /provider 配置端点。" },
	{ name: "/provider", desc: "厂商向导", long: "交互式配置模型厂商：选平台、选数据源、从厂商目录选厂商、填端点与密钥。全程支持上下键导航与 Esc 逐级取消。" },
	{
		name: "/permission", desc: "权限模式", long: "切换工具执行的审批策略，切换立即生效并写入配置。三档：Always Ask 全确认 / Ask When Needed 危险才确认 / Never Ask 全放行。", children: [...PERM_CYCLE], childMeta: PERM_META,
	},
	{ name: "/compact", desc: "压缩上下文", long: "立即压缩当前会话的上下文：把早期对话折叠成摘要，释放 token 空间。压缩期间显示进度指示，完成后可用 /summary 回看过往摘要。" },
	{ name: "/sessions", aliases: ["resume"], desc: "会话列表", long: "列出本机全部会话（标题、更新时间、消息数），上下键选择回车切换；带序号或会话 ID 可直达恢复。/fork 可从当前会话分叉副本。" },
	{ name: "/summary", desc: "查看压缩摘要", long: "回看最近一次 /compact 产生的上下文摘要全文。" },
	{
		name: "/other", aliases: ["config"], desc: "其他详细信息", long: "详细信息面板：磁盘占用（~/.orosus 各目录大小与清理口径）、上下文用量（窗口占用与输入输出累计）、Token 用量（本会话与项目累计）、运行状态（模型 / 会话 / 模块图——/usage /status 已并入此处）。",
	},
	{ name: "/quit", aliases: ["exit", "q"], desc: "退出 Orosus", long: "退出应用并恢复终端状态（光标、屏幕缓冲区、粘贴模式全部还原）。空闲时双击 Ctrl + C 同效。" },
	// F5 二轮⑨：既有命令全部进菜单（此前只有 10 条——/new /fork /resume /title /yolo /usage /status /reload 能打但菜单不可见）
	// 批⑤⑥：/usage /status 退役出菜单（并入 /other 面板；打字面留指路）
	{ name: "/new", desc: "新会话", long: "开一场全新会话（当前会话保留，/sessions 可切回）。" },
	{ name: "/fork", desc: "分叉会话", long: "从当前会话的最新位置分叉出一个副本会话，继承全部上下文。" },
	{ name: "/title", aliases: ["rename"], desc: "会话命名", long: "给当前会话起名字（/title 名字，引号可选），在 /sessions 列表里按名字找会话。无参不做任何事。" },
	{ name: "/reload", desc: "重载模块", long: "重新加载配置与模块（改了 config.toml 或模块文件后用）。" },
];

/** ASCII 字 banner（第三轮走查设计——大框 + OROSUS 块字 + 可变版本号 + slogan 两行）。 */
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
	// 快捷键导引两行（F5 十二轮③：加 Ctrl + T 侧栏；单行放不下——拆两行，宽 43/38 + 补空 = 内宽 58）
	theme.fg("accent", "│") + theme.dim(" Tab 焦点 · Shift + Tab 权限 · Alt + E 思考") + "               " + theme.fg("accent", "│"),
	theme.fg("accent", "│") + theme.dim(" / 命令 · Ctrl + T 侧栏 · Alt + V 贴图") + "                    " + theme.fg("accent", "│"),
	theme.fg("accent", "╰──────────────────────────────────────────────────────────╯"),
	"",
];

const runFullScreen = async (): Promise<"switch" | "quit"> => {
  let action: "switch" | "quit" | undefined;
  const app = new FullApp({
    columns: () => process.stdout.columns ?? 80,
    rows: () => process.stdout.rows ?? 24,
    doc: () => dm.frameLines(streamW()),
    submit: (text) => {
      // /help（F5 二轮⑪）：只读翻页浮层（↑↓/PgUp/PgDn 翻页、Esc 关闭），不进命令管线不留气泡
      const cmd = text.trim().replace(/^\/\s+/, "/").replace(/\s+/g, " ");
      if (cmd === "/help") {
        app.viewText("帮助", HELP_TEXT);
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
    requestExit: () => {
      action = "quit";
    },
    requestCancel: () => {
      h.cancel(); // Esc 忙碌时取消当前 turn（SIGINT 同效——修复轮②）
    },
    panelData: () =>
      panelCache ?? {
        model: "…",
        session: h.sessionId,
        cwd: shortenPath(process.cwd(), 26),
        tokens: { input: 0, output: 0 },
        startedAt: undefined,
        contextWindow: configFace().contextWindow,
        modules: [],
        tasks: [],
        permission: configFace().approvalMode,
        permissionNext: () => "/permission ask-always",
      },
    slashCommands: () => SLASH_ITEMS,
    slashCurrent: (cmd) => (cmd === "/permission" ? (panelCache?.permission ?? configFace().approvalMode) : ""),
    sidebarInit: () => tuiSidebarRead(), // 即时读（F5 十四轮：会话切换重建 FullApp——不能用进程启动快照）
    onSidebarChange: (visible) => tuiSidebarPersist(visible), // Ctrl+T 状态持久化
    thinkOpen: () => dm.thinkOpen,
    toggleThink: () => {
      dm.thinkOpen = !dm.thinkOpen;
    },
    toggleTool: () => {
      dm.toolOpen = !dm.toolOpen;
    },
    toggleErr: () => {
      dm.errOpen = !dm.errOpen;
    },
    // 消息队列三件套（2026-09-23 队列批——kimi 方案改 Ctrl+U）：队列区数据源 / ↑ 召回队尾 / steer 注入
    queueItems: () => [...pendingSubmits],
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
        const img = await pasteImage();
        if (img === undefined) {
          dm.pushLine(theme.dim(PASTE_EMPTY));
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
        for (const m of (e.messages ?? []) as { text?: string }[]) if (typeof m.text === "string" && m.text !== "") seedTexts.push(m.text);
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
    const cmd = text.trim().replace(/^\/\s+/, "/").replace(/\s+/g, " ");
    if (!cmd.startsWith("/")) {
      dm.userPrompt(text); // 图片 chip 已是文内 token（2026-09-23——不再追加独立 chip 行）
    }
    void (async () => {
      const modelBefore = cmdNameOf(text) === "/model" ? h.status().model : undefined; // /model 静默化：反馈靠前后 diff
      try {
        const emit = busyExec ? (s: string) => dm.pushLine(s) : (s: string) => dm.pushMd(s, streamW()); // 命令结果含 md（/compact 摘要等）——渲染后入流（F5 六轮②）
        const r = await processReplLine(text, emit);
        if (modelBefore !== undefined) reportModelSwitch(modelBefore);
        if (!busyExec) {
          if (r === "switch") action = "switch";
          else if (r === "quit") action = "quit";
        }
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
  while (action === undefined) {
    await new Promise((r) => setTimeout(r, 40));
  }
  activeApp = undefined;
  app.stop();
  stdoutEcho.silence(false);
  return action;
};

// REPL（--print 单发模式不进——M4-2 T17：runPrint 已收尾）
if (args.print === undefined) try {
  sessionLoop: for (;;) {
    // 横幅分流（F3）：全屏模式 console 输出会毁屏——横幅进 DocModel 流区；dm 每会话重置（新会话新文档）
    dm = new DocModel();
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
        dm.pushLine(pe.notice);
        if (pe.history) dm.historyFrom(await h.history(), streamW()); // 结构化摄入（F5 五轮②③④）
      }
    }
    void refreshPanel(); // 面板首刷（F4）
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
      const r = await processReplLine(text, (s) => console.log(s));
      if (mb !== undefined) reportModelSwitch(mb);
      if (r === "quit") break sessionLoop;
      if (r === "switch") continue sessionLoop;
      // CLI 拦截层（D38 第一层）：会话生命周期命令（/new /fork /sessions /resume /quit，D41/T6 + B9 拉前）

    }
  }
} finally {
  rl.close();
  await h.close();
}
