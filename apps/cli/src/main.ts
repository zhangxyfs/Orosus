import { createInterface } from "node:readline/promises";
import { orosusHome } from "@orosus/contracts/home";
import { basename, join } from "node:path";
import { createHarness, discoverModules, encodeCwd, locateSessionFile } from "@orosus/core";
import type { Harness } from "@orosus/core";
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
import { renderHistoryLines, historyPage, attachRender as attachRenderTo } from "./render.ts";
import { createLiveView } from "./liveview.ts";
import { pasteImage, imagesFor, PASTE_EMPTY, pasteOkHint } from "./paste.ts";
import { attachAltVPaste } from "./altpaste.ts";
import { runPrint } from "./print.ts";
import { resolveAtRefs } from "./atfile.ts";
import { commandCompleter, HELP_TEXT } from "./help.ts";
import { withCompactHint } from "./compact-hint.ts";

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
  pendingLines.push(l);
  const w = lineWake;
  lineWake = undefined;
  w?.();
});
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
const question = async (q: string): Promise<string> => {
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
const secretQuestion = async (q: string): Promise<string> => {
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
// 流式活动区（TUI 批 T4）——装配序先于菜单与渲染：菜单写面（picker/标题行）同接 lv.write
// （v1.8 B5：审批 choose 首帧与 tool/call 行落屏的竞速由「任何写先固化活动区」天然消解）；
// 非 TTY lv.write 为直通（T1–T3 行为不变）
const lv = createLiveView({
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
          lv.write(`== ${title} ==\n`);
          const n = await pick(items, terminalMenuIo());
          if (n === undefined) throw new Error("已取消（Esc）");
          return n;
        },
      }
    : {};
const commandUi = createReadlineUi({ question, secretQuestion, ...pickFace });

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
const echoHistory = async (h: Harness): Promise<void> => {
  const lines = renderHistoryLines(await h.history());
  const PAGE = 30;
  let { shown, hiddenBefore } = historyPage(lines, PAGE);
  if (hiddenBefore > 0) console.log(`…（历史共 ${lines.length} 行，先显示最近 ${shown.length} 行——完整原文在会话文件）`);
  for (const l of shown) console.log(l);
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
    for (let i = start; i < end; i++) console.log(lines[i]!);
    hiddenBefore = start;
  }
};

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
  // --resume 启动同样回显历史（B9 走查补——此前只有 REPL /resume 有）
  console.log(`[已恢复 ${h.sessionId}——历史对话如下]`);
  await echoHistory(h);
}

// 启动审计横幅在 sessionLoop 首轮统一打印（banner.ts 可测抽取；分级规则见彼处注释——B7 提前落地）

/** 清屏（用户走查 2026-09-19）：/new 与 /fork 换会话时清残屏。TTY only——
 *  管道/重定向下吐 ANSI 转义只会污染输出（走查与脚本消费方都要干净 stdout）。 */
const clearScreen = (): void => {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // 屏+回滚缓冲清空、光标归位
};

// 首启引导（模型发现 T0——M3 T9 欠账接线）：TTY 且需要配置 → 确认转 /provider 向导 → /reload → 复检回显；
// 非交互跳过；只挂首会话（/new、/fork 换出的会话不再触发，M3 T9 定案）；--print 单发不触发
if (args.print === undefined && process.stdin.isTTY) {
  const out = await startupGate({ h, ui: commandUi, readModel: realReadModel(process.cwd()), isTty: true });
  if (out !== undefined) console.log(out);
}

// 事件渲染：会话日志的实时投影（append 即转发，§6.7）；lastEventId 供 /fork 选分叉点
// 渲染面抽至 render.ts（M3 补强 T8：压缩/裁剪可见性 + 可测性注入）
let lastEventId: string | undefined;
let pendingImage: string | undefined; // /paste 挂起的图片文件——随下一条消息以路径引用（M4-2 T10）
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
    pendingImage = file;
  },
});
function attachRender(h: Harness): void {
  // 双写面（T4/v1.8）：chunk 路 TTY 进 lv.activity（节流重绘），事件路 lv.write（直写）；
  // 非 TTY 只传 write = 现状等价。onEvent 升级完整事件——turn/end 驱动 lv.end() 定格终稿
  attachRenderTo(
    h,
    { write: (s) => lv.write(s), ...(process.stdout.isTTY === true ? { activity: (s) => lv.activity(s) } : {}) },
    (e) => {
      lastEventId = e.id;
      if (e.type === "turn/end") lv.end();
    },
  );
}

process.on("SIGINT", () => h.cancel()); // Ctrl-C 中止当前 turn，不退出（h 为当前会话）

// 恢复会话（B9 拉前）：双层定位 → 原位续写（新事件仍进原文件——平铺/他桶均在原位）
const switchTo = async (sid: string): Promise<void> => {
  const loc = locateSessionFile(sessionsRoot, sid);
  if (loc === undefined) { console.log(`未找到会话 ${sid}（/sessions 查看列表）`); return; }
  await h.close();
  h = await createSession({ resume: { sessionId: sid }, sessionsDir: loc.dir });
  activeDir = loc.dir;
  console.log(`[已恢复 ${readTitle(loc.file, sid)}（${sid}）——历史对话如下]`);
  await echoHistory(h); // 回显存量对话（B9 走查补 + 分页）
};

// REPL（--print 单发模式不进——M4-2 T17：runPrint 已收尾）
if (args.print === undefined) try {
  sessionLoop: for (;;) {
    for (const line of banner(h, { modelConfigured: !needsProviderSetup({ model: realReadModel(process.cwd())(), providers: h.graph().services.listProviders().map((p) => p.name) }) })) console.error(line);
    attachRender(h);
    for (;;) {
      process.stdout.write("> ");
      const line = await nextLine(); // EOF（管道耗尽 / Ctrl-D）→ null → 退出
      if (line === null) break sessionLoop;
      const text = line.trim();
      if (text === "") continue;
      // CLI 拦截层（D38 第一层）：会话生命周期命令（/new /fork /sessions /resume /quit，D41/T6 + B9 拉前）
      const directive = sessionCommand(text, { sessionId: h.sessionId, lastEventId });
      if (directive.kind === "quit") break sessionLoop; // /quit 同义 /exit /q（用户要求 2026-09-18）——经 sessionCommand 可测面
      if (directive.kind === "pick") {
        // /sessions（别名 /resume）无参：列表 + choose 选中即 resume（B9 形态；非交互指路直达）
        if (!process.stdin.isTTY) { console.log(formatSessions(sessionsRoot, h.sessionId) + "\n（非交互环境——用 /resume <序号|sid> 直达恢复）"); continue; }
        const items = listSessions(sessionsRoot);
        if (items.length === 0) { console.log("（暂无会话——发送第一条消息即创建）"); continue; }
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
            const n0 = await pick(labels, terminalMenuIo());
            if (n0 === undefined) throw new Error("已取消（Esc）");
            return n0 + 1; // picker 0-based → 序号 1-based（与回落路径同口径）
          },
        );
        if (n === undefined) continue;
        await switchTo(items[n - 1]!.id);
        continue sessionLoop; // 换 harness 后重挂横幅与渲染
      }
      if (directive.kind === "title") {
        // /title（M4-2 T0）：无参 = 查看当前名；有参 = 追加 session/label（当前或序号/sid 指定会话）
        if (directive.name === undefined) {
          const events = await h.history();
          const label = events.filter((e) => e.type === "session/label").at(-1);
          console.log(`当前会话：${label !== undefined ? String(label.label) : "（未命名）"}（${h.sessionId}）——/title <名> 命名`);
        } else {
          const r = await setTitle(sessionsRoot, h.sessionId, directive.target, directive.name);
          console.log(r !== undefined ? `[已命名 ${r.sid} → ${directive.name}]` : `[未找到目标会话]`);
        }
        continue;
      }
      if (directive.kind === "resume") {
        const sid = resolveTarget(directive.sessionId, sessionsRoot);
        if (sid === undefined) { console.log(`未找到会话「${directive.sessionId}」——/sessions 查看列表`); continue; }
        await switchTo(sid);
        continue sessionLoop;
      }
      if (directive.kind === "new" || directive.kind === "fork") {
        const from = directive.kind === "fork" ? directive.parentSessionId : undefined;
        await h.close();
        // 新会话/fork 子会话一律落当前项目桶；fork 父会话按 activeDir 定位（可能在平铺或他桶——resume 旧会话后 /fork）
        h = await createSession(directive.kind === "fork"
          ? { ...harnessOptionsFor(directive, { parentDir: activeDir }), sessionsDir }
          : { sessionsDir });
        activeDir = sessionsDir;
        clearScreen(); // 用户走查（2026-09-19）：换会话清屏——旧会话残屏与"历史丢失"错觉同源
        if (from !== undefined) {
          // fork 继承父上下文（ForkedSessionStore 投影 suau 实证）——回显历史让继承可见，否则像丢了
          console.log(`[已从 ${from} 分叉——新会话 ${h.sessionId}，继承历史如下]`);
          await echoHistory(h);
        } else {
          console.log(`[新会话 ${h.sessionId}]`);
        }
        continue sessionLoop; // 重挂横幅与渲染（新事件流）
      }
      // /help（M4-2 T21）：CLI 层拦截带说明版（D38 第一层——core 简版被遮蔽，非 CLI 宿主仍走 core 版）
      if (text === "/help") { console.log(HELP_TEXT); continue; }
      // /paste（M4-2 T10，别名 /image；M4-2.5 T5 起真实喂图）：剪贴板图存临时文件，随下一条消息以 image part 发给模型
      if (text === "/paste" || text === "/image") {
        const img = await pasteImage();
        if (img === undefined) { console.log(PASTE_EMPTY); continue; }
        console.log(pasteOkHint(basename(img.file)));
        pendingImage = img.file;
        continue;
      }
      try {
        // @文件引用（M4-2 T18）：引用替换为附着内容（限 5 个/50KB，超限提示带内）
        const { text: cleaned, attachments } = resolveAtRefs(text, process.cwd());
        const withAt = attachments.length > 0 ? `${cleaned}\n\n${attachments.join("\n\n")}` : cleaned;
        // 命令输入时 harness.prompt 返回命令输出（D38）——必须回显（M2 补账：原实现从不打印，命令「敲了没反应」）
        // /compact 进度指示（TUI 批 T7）：命中时 h.prompt 前经 lv 写指示行，settle 后 discard 擦除——
        // 结果/错误由下方 console 输出（不经 liveview），视觉上指示行被结果替换；非 TTY 零输出变化。
        // isTTY 取 stdout（写侧关切，与 lv/attachRender 双写面同口径——输出入管时硬保证不被指示行污染）
        const out = await withCompactHint(
          text,
          { isTTY: process.stdout.isTTY === true, activity: (s) => lv.activity(s), discard: () => lv.discard() },
          () => h.prompt(withAt, imagesFor(pendingImage)), // /paste 挂起的图以 image part 随本条消息发出（M4-2.5 T5）
        );
        pendingImage = undefined;
        if (out !== undefined) console.log(out);
      } catch (err) {
        console.error(`[错误] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
} finally {
  rl.close();
  await h.close();
}
