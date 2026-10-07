import { createInterface } from "node:readline/promises";
import type { Harness } from "@orosus/core";
import type { FullApp } from "./tui/fullapp.ts";
import { createSilenceableOutput } from "./menu.ts";
import { watchEsc } from "./keys.ts";
import { commandCompleter } from "./help.ts";
import { ESC_CANCELLED } from "./i18n/protocol-strings.ts";
import { t } from "./i18n/app.ts";

/** m5-split-main T11：行模式 IO 族自 main.ts 搬入（人人依赖，最后拆）。
 *  h/activeApp 两件留守单例经 initReplIo 晚绑定注入（D2 的零参热路径形态——question/notify 被
 *  全仓 50+ 处零参调用，穿 deps 参数将造成大面积非纯改写；两引用全部运行期解引用，main.ts 在
 *  两单例声明后即刻 init，时序等价于原闭包直读——D5 升格注记，T12 登记）。 */
export type ReplIoRefs = {
  getH: () => Harness;
  getActiveApp: () => FullApp | undefined;
};
let refs: ReplIoRefs;
export const initReplIo = (r: ReplIoRefs): void => { refs = r; };

// rl 与交互 UI（D35，T10）：先于 harness 创建——/model、/provider 等菜单命令经 commandUi 注入。
// M3 口子：审批模块的 waterfall 询问流将复用同一 UI 注入路径（届时经 ctx 扩展，形态随 M3 方案审查定）。
// 输出走可静默代理：密钥询问期间 rl 回显全吞（盲输，ssh/docker 同款）——逐键 * 回显在真实 Windows
// 终端层会碎成孤星（走查实录），静默在任意终端层行为一致。terminal/列宽透传给代理保住行编辑。
export const stdoutEcho = createSilenceableOutput(process.stdout);
if (process.stdout.isTTY === true) {
  Object.defineProperty(stdoutEcho, "isTTY", { value: true });
  Object.defineProperty(stdoutEcho, "columns", { get: () => process.stdout.columns });
}
// Tab 补全（M4-2 T21 + m5 T15 第三职）：模块命令参数经 graph 现读委托（completeArg 抛错当无候选 + host 日志）
const rlCompleter = (line: string): Promise<[string[], string]> =>
  Promise.resolve(commandCompleter(line, process.cwd(), refs.getH().graph().commands.map((c) => ({ name: `/${c.name}`, ...(c.completeArg !== undefined ? { completeArg: c.completeArg } : {}) })), (name, err) => {
    refs.getH().log("host.completer.error", `模块参数补全抛错，当无候选：${name}`, { error: String(err instanceof Error ? err.message : err) }); // i18n:diag 诊断面不翻
  }));
export const rl = createInterface({ input: process.stdin, output: stdoutEcho, completer: rlCompleter });
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
  if (refs.getActiveApp() !== undefined) {
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
export const nextLine = async (): Promise<string | null> => {
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
      reject(new Error(t("replio.noTty")));
    };
    const cleanup = (): void => {
      rl.removeListener("close", onClose);
      stopEsc?.();
    };
    rl.once("close", onClose);
    rl.question(prompt, { signal: ac.signal }).then(
      (v) => { cleanup(); resolve(v); },
      (e: unknown) => { cleanup(); reject(ac.signal.aborted ? new Error(ESC_CANCELLED) : e); },
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
    process.stdout.write(t("replio.secretSuffix", { q }) + " ");
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
export const question = async (q: string): Promise<string> => {
  const activeApp = refs.getActiveApp();
  if (activeApp !== undefined) {
    const v = await activeApp.promptInput(q, false);
    if (v === undefined) throw new Error(ESC_CANCELLED);
    return v;
  }
  return rlQuestion(q);
};
export const secretQuestion = async (q: string): Promise<string> => {
  const activeApp = refs.getActiveApp();
  if (activeApp !== undefined) {
    const v = await activeApp.promptInput(q, true);
    if (v === undefined) throw new Error(ESC_CANCELLED);
    return v;
  }
  return rlSecretQuestion(q);
};

/** 瞬时提示统一出口（2026-09-23 用户拍板 toast 化）：全屏 → 浮动 toast（黄字 3s 自消、3 行封顶）；
 *  行模式 → 单行 console（形态不变）。命令错误/拦截/退役指路/模型错误等瞬时面一律走此口，
 *  不再落流区（命令结果 md / 会话生命周期回显 / 工具行失败仍带内——见 ROADMAP toast 化条目）。 */
export const notify = (t: string, opts?: { durationMs?: number }): void => {
  // 行模式无时长概念（console 单行即走）；全屏透传 durationMs（m5 T3——缺省 3000 不变）
  const activeApp = refs.getActiveApp();
  if (activeApp !== undefined) activeApp.showToast(t, opts?.durationMs);
  else console.log(t);
};

/** 命令面错误统一落点（2026-09-24 M4-3 走查实锤收口——/settings 弹窗 Esc 取消无人接、进程 exit 7 前案）：
 *  Esc 带内取消静默（TUI 批 T3/D52③ 拍板）+ 其余瞬时错误 toast 化（2026-09-23 拍板）。
 *  processReplLine catch-all 与 runSubmit 网兜共用此政策——模块命令的 choose/ask Esc 抛错必须穿透
 *  处理器（/model 收窄 catch 同款约定），接住它们 = 宿主这两处。 */
export const settleCommandError = (err: unknown): void => {
  if (err instanceof Error && err.message === ESC_CANCELLED) return;
  notify(err instanceof Error ? err.message : String(err));
};
