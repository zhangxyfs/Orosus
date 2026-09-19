import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createHarness, discoverModules, encodeCwd, locateSessionFile } from "@orosus/core";
import type { Harness } from "@orosus/core";
import { BUILTIN_MODULES } from "./builtins.ts";
import { createReadlineUi, createSilenceableOutput } from "./menu.ts";
import { formatSessions, harnessOptionsFor, listSessions, pickSessionNumber, readTitle, resolveTarget, sessionCommand, setTitle } from "./sessions.ts";
import { parseArgs } from "./args.ts";
import { isProviderSubcommand, runProviderSubcommand } from "./provider-cmd.ts";
import { isModuleSubcommand, runModuleSubcommand } from "./module-cmd.ts";
import { banner } from "./banner.ts";
import { needsProviderSetup, } from "./onboarding.ts";
import { realReadModel, startupGate } from "./startup.ts";
import { isSessionsSubcommand, runPruneSubcommand } from "./prune.ts";
import { renderHistoryLines, historyPage, attachRender as attachRenderTo } from "./render.ts";
import { pasteImage, withImageRef } from "./paste.ts";
import { runPrint } from "./print.ts";
import { resolveAtRefs } from "./atfile.ts";
import { commandCompleter, HELP_TEXT } from "./help.ts";

// 子命令拦截（M2 接口总表：互斥于 flag 之外先解析）——M2 补账：T8/T13 处理器此前从未接线，
// `orosus provider ...` / `orosus module ...` 会被 flag 解析器当未知参数拒收
{
  const argv = process.argv.slice(2);
  const orosusHome = join(homedir(), ".orosus");
  if (isProviderSubcommand(argv)) {
    process.exit(await runProviderSubcommand(argv, {
      configPath: join(orosusHome, "config.toml"),
      secretsPath: join(orosusHome, "secrets.env"),
      env: process.env,
      out: (l) => console.log(l),
    }));
  }
  // `orosus sessions prune`（M4-1 T2/D47）：显式清理——缺省 dry-run、--apply 才删、不做启动自动 GC
  if (isSessionsSubcommand(argv)) {
    process.exit(await runPruneSubcommand(argv, { out: (l) => console.log(l) }));
  }
  if (isModuleSubcommand(argv)) {
    const discovered = await discoverModules({
      userDir: join(orosusHome, "modules"),
      projectDir: join(process.cwd(), ".orosus", "modules"),
      userFile: join(orosusHome, "config.toml"),
      sink: { write: () => {}, flush: () => Promise.resolve(), close: () => Promise.resolve() },
    });
    process.exit(await runModuleSubcommand(argv, {
      configPath: join(orosusHome, "config.toml"),
      trustFile: join(orosusHome, "trust.json"),
      discovered: discovered.map((m) => ({ name: m.def.name, root: m.root, entryHash: m.entryHash, layer: m.layer })),
      out: (l) => console.log(l),
    }));
  }
}

const args = parseArgs(process.argv.slice(2));
// 会话目录分桶（M4-1 T1/D46）：根 = ~/.orosus/sessions；新会话落当前项目桶 sessionsRoot/<encodeCwd(cwd)>/
const sessionsRoot = join(homedir(), ".orosus", "sessions");
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
const commandUi = createReadlineUi({
  question: async (q) => {
    askActive = true;
    try {
      // 命令开始前已到的行（管道脚本/用户预打字）优先喂给询问——否则队列与 question 各等各的（脑裂挂起）
      const queued = pendingLines.shift();
      if (queued !== undefined) return queued;
      // EOF 竞速：stdin 关闭后（或期间）的询问以拒绝收场——命令带内失败（D35 fail-closed 语义）。
      // 监听逐次挂摘（不用 standing promise）：正常退出时 rl.close() 不产生无人消费的 rejection
      return await new Promise<string>((resolve, reject) => {
        const onClose = (): void => reject(new Error("无交互环境（stdin 已关闭）——交互式命令不可用（D35 fail-closed）"));
        rl.once("close", onClose);
        rl.question(q).then(
          (v) => { rl.removeListener("close", onClose); resolve(v); },
          (e) => { rl.removeListener("close", onClose); reject(e); },
        );
      });
    } finally {
      askActive = false;
    }
  },
  // 密钥询问（静默盲输）：提示语写真 stdout（明示不回显），rl 回显经代理全吞——
  // 结束后补换行（回车回显也被吞了）。管道预输行直接采纳——非 TTY 无回显，天然不泄漏
  secretQuestion: async (q) => {
    askActive = true;
    try {
      const queued = pendingLines.shift();
      if (queued !== undefined) return queued;
      process.stdout.write(`${q}（输入不回显）: `);
      stdoutEcho.silence(true);
      try {
        return await new Promise<string>((resolve, reject) => {
          const onClose = (): void => reject(new Error("无交互环境（stdin 已关闭）——交互式命令不可用（D35 fail-closed）"));
          rl.once("close", onClose);
          rl.question("").then(
            (v) => { rl.removeListener("close", onClose); resolve(v); },
            (e) => { rl.removeListener("close", onClose); reject(e); },
          );
        });
      } finally {
        stdoutEcho.silence(false);
        process.stdout.write("\n");
      }
    } finally {
      askActive = false;
    }
  },
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
const echoHistory = async (h: Harness): Promise<void> => {
  const lines = renderHistoryLines(await h.history());
  const PAGE = 30;
  let { shown, hiddenBefore } = historyPage(lines, PAGE);
  if (hiddenBefore > 0) console.log(`…（历史共 ${lines.length} 行，先显示最近 ${shown.length} 行——完整原文在会话文件）`);
  for (const l of shown) console.log(l);
  while (hiddenBefore > 0 && process.stdin.isTTY) {
    const more = await commandUi.ask(`…（前面还有 ${hiddenBefore} 行）回车=继续往前翻，q=停止回显`);
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
function attachRender(h: Harness): void {
  attachRenderTo(h, (s) => process.stdout.write(s), (id) => { lastEventId = id; });
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
        // 走查定案（2026-09-19）：不选即取消——菜单自绘（序号/高亮/相对时间），ask 循环选号，
        // 空输入 = 取消（专门「取消」项退役——占序号位且多一步）
        console.log(formatSessions(sessionsRoot, h.sessionId));
        const n = await pickSessionNumber((q) => commandUi.ask(q), items.length);
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
      // /paste（M4-2 T10，别名 /image）：剪贴板图存临时文件，随下一条消息以路径引用（真实喂图 V.2）
      if (text === "/paste" || text === "/image") {
        const img = await pasteImage();
        if (img === undefined) { console.log("（剪贴板中没有图片——截图后重试，或检查终端权限）"); continue; }
        console.log(`[已粘贴图片: ${basename(img.file)}]——将随下一条消息发送（M4-2 以文件路径随消息；模型直接看图属 V.2）`);
        pendingImage = img.file;
        continue;
      }
      try {
        // @文件引用（M4-2 T18）：引用替换为附着内容（限 5 个/50KB，超限提示带内）
        const { text: cleaned, attachments } = resolveAtRefs(text, process.cwd());
        const withAt = attachments.length > 0 ? `${cleaned}\n\n${attachments.join("\n\n")}` : cleaned;
        // 命令输入时 harness.prompt 返回命令输出（D38）——必须回显（M2 补账：原实现从不打印，命令「敲了没反应」）
        const out = await h.prompt(withImageRef(withAt, pendingImage)); // /paste 挂起的图随本条消息发出
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
