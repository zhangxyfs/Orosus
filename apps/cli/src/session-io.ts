import { join, dirname } from "node:path";
import { orosusHome } from "@orosus/contracts/home";
import { createHarness, locateSessionFile, readSessionHead, isEmptySessionHead, purgeSessionDir, encodeCwd } from "@orosus/core";
import type { Harness, SessionEvent } from "@orosus/core";
import type { CommandUi, HostInfo, SettingsService } from "@orosus/contracts/module";
import { BUILTIN_MODULES } from "./builtins.ts";
import { registerToolLabels, renderHistoryLines, historyPage } from "./render.ts";
import { migrateModulesSections, seedHooksTemplate } from "./config-migrate.ts";
import { extractImageRefs } from "./paste.ts";
import { SKILL_MARK_RE } from "./skills-ui.ts";
import type { CliArgs } from "./args.ts";

// 会话目录分桶（M4-1 T1/D46）：根 = ~/.orosus/sessions；新会话落当前项目桶 sessionsRoot/<encodeCwd(cwd)>/
// m5-split-main T5：自 main.ts 搬入（纯常量三件直出；activeDir 可变单例经访问器——D2）。
export const sessionsRoot = join(orosusHome(), "sessions");
export const currentBucket = encodeCwd(process.cwd()); // 会话树批 #17：交互面只认当前项目桶
export const sessionsDir = join(sessionsRoot, currentBucket);
// activeDir 语义 = 桶目录（/fork 父定位与 createSession 回退的写侧桶）——目录化后 scan 条目 dir 是会话目录，取其父
// --resume 定位（会话树批 T2 目录化 + #17 桶限定）：只认当前项目桶的新形态会话；找不到 = 全新空会话（M3 既有语义）
let activeDir: string;
/** 启动期初始化（main.ts 顶层序原位调用——求值时机与搬移前逐语句一致：locate → activeDir 初值；
 *  与搬移前同款 ?? sessionsDir 兜底，类型恒 string）。 */
export const initActiveDir = (resume: { sessionId: string } | undefined): void => {
  const resumeLoc = resume !== undefined ? locateSessionFile(sessionsRoot, resume.sessionId, { bucket: currentBucket }) : undefined;
  activeDir = (resumeLoc !== undefined ? dirname(resumeLoc.dir) : undefined) ?? sessionsDir;
};
export const activeDirRef = (): string => activeDir;
export const setActiveDir = (dir: string): void => { activeDir = dir; };

/** 空会话退出即清（2026-10-01 用户拍板清理批②）：刚关的会话 0 消息 → 整目录不留（判定 = core
 *  isEmptySessionHead，fork 子体除外——投影含父辈）。异常退出走不到此（进程被杀）——残留壳由下次
 *  启动 sweepEmptySessions 兜底。purge 前置条件 = store 已 close（Windows 活句柄删不动）。 */
export const purgeIfEmptySession = (sid: string): void => {
  const loc = locateSessionFile(sessionsRoot, sid);
  if (loc === undefined) return;
  const head = readSessionHead(loc.file);
  if (head !== undefined && isEmptySessionHead(head)) purgeSessionDir(dirname(loc.dir), sid);
};

/** 会话装配依赖（m5-split-main T5，D2 签名注入）：args/commandUi/settingsService/hostInfo/
 *  settleCommandError 均为 main.ts 留守件；getH/setH/resetLastEventId/isFullscreen/deferEcho 是
 *  switchTo 对 main.ts 可变单例（h/lastEventId/tuiMode/pendingEcho）的最小访问面。 */
export type SessionDeps = {
  args: CliArgs;
  commandUi: CommandUi;
  settingsService: SettingsService;
  hostInfo: HostInfo;
  settleCommandError: (err: unknown) => void;
  getH: () => Harness;
  setH: (h: Harness) => void;
  resetLastEventId: () => void;
  isFullscreen: () => boolean;
  deferEcho: () => void;
};

export const createSession = async (deps: SessionDeps, extra: { fork?: { parentSessionId: string; atEntryId?: string; parentDir?: string }; resume?: { sessionId: string }; sessionsDir?: string } = {}) => {
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
      if (modDir === join(orosusHome(), "modules.d")) {
        try {
          seedHooksTemplate(modDir); // m5-hooks D21：用户层播种注释示例（幂等；项目层不播）
        } catch { /* 播种失败零影响——docs/hooks.md 与 /settings 空态是并列指引 */ }
      }
    }
  }
  const h = await createHarness({
    builtinModules: BUILTIN_MODULES,
    commandUi: deps.commandUi,
    settings: deps.settingsService, // m5 T9 口子四：经内核装配成 ctx.settings（mounts "settings" 门）
    host: deps.hostInfo,             // m5 T9 读面：ctx.host 直挂无门
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
      void switchTo(sid, deps).catch((err) => deps.settleCommandError(err));
      return true;
    },
    ...((extra.resume ?? deps.args.resume) !== undefined ? { resume: extra.resume ?? deps.args.resume } : {}),
    ...(extra.fork !== undefined ? { fork: extra.fork } : {}),
    config: {
      enableModules: deps.args.enable,
      disableModules: deps.args.disable,
      noModules: deps.args.noModules,
      module: deps.args.module,
      ...(deps.args.model !== undefined ? { cliOverrides: { model: deps.args.model } } : {}),
    },
  });
  // 工具显示名喂给渲染层（label 优先呈现——2026-09-24 用户拍板）；reload 会换工具集合，四处 reload 位同步重喂
  registerToolLabels(h.graph().tools.toolInfos());
  return h;
};

// 历史回显（B9 走查补 + 分页）：尾页优先（最新对话先可见），TTY 下回车向前翻页、q 结束；
// 非交互（管道）只出尾页——巨量历史不再刷爆终端（单行截断在 renderHistoryLines）
// m5-split-main T5：自 main.ts 搬入，commandUi 经参数注入（D2——行模式翻页询问口）。
export const echoHistory = async (h: Harness, commandUi: CommandUi, out: (s: string) => void = (s) => console.log(s)): Promise<void> => {
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

// 恢复会话（B9 拉前 → 会话树批 T2/#17）：当前桶定位 → 续写；scan 条目 dir 是会话目录，store 要桶 = dirname
// m5-split-main T5：自 main.ts 搬入；h/lastEventId/tuiMode/pendingEcho 经 deps 访问器注入（D2）。
export const switchTo = async (sid: string, deps: SessionDeps, out: (s: string) => void = (s) => console.log(s)): Promise<void> => {
  const loc = locateSessionFile(sessionsRoot, sid, { bucket: currentBucket });
  if (loc === undefined) { out(`未找到会话 ${sid}（/sessions 查看列表）`); return; }
  await deps.getH().close();
  deps.setH(await createSession(deps, { resume: { sessionId: sid }, sessionsDir: dirname(loc.dir) }));
  setActiveDir(dirname(loc.dir));
  // CS-05①（2026-09-28 code review）：换会话重置 lastEventId——它只经 attachRender 的 onEvent 喂（切回的
  // 会话存量历史不重放事件流），不重置则切会话后立即 /fork 会把上一会话的事件 id 当 atEntryId 带进新
  // 会话；session 域已把投影外 atEntryId 从宽容降级改为 throw（fork.ts CS-05），此路径会响亮报错。
  // 重置为 undefined = /fork 走「父投影尾事件」缺省（createHarness fork 分支与 h.fork 两出口同款兜底），
  // 语义恰是 /fork 的「从最新位置分叉」。sessionSwitch 缝（ctx.session.switchTo）背后也走本函数，同点覆盖。
  deps.resetLastEventId();
  // 恢复横幅整条退役（2026-09-30 用户拍板三轮：[已恢复] 与 ❯ 标题行都不要——历史回放即提示，
  // 顶上再压一行看着难受）；notice 留空串走回放，消费口跳过空行
  if (deps.isFullscreen()) {
    deps.deferEcho(); // 延期到 dm 重建后（F5 二轮⑯）
  } else {
    await echoHistory(deps.getH(), deps.commandUi, out); // 回显存量对话（B9 走查补 + 分页）
  }
};

/** 输入召回旁注事件类型（host/ 前缀——deriveMessages 未知类型跳过 = 不进模型上下文，只服务
 *  重开会话的输入历史播种）。写侧：main 提交层在「发出文本 ≠ 输入框原文」（技能合成体/@ 引用
 *  展开/图片 chip 剥离）时经 prompt afterUserEvent 紧随 user/message 落盘。 */
export const INPUT_ECHO_EVENT = "host/input-echo";

/** 输入历史播种文本（2026-10-03 用户拍板「按上键召回的必须是我输入的内容」）：从会话事件还原
 *  「输入框原文」，替代此前「user/message 文本照单全收」——技能合成体整条（标记行+原话+<skill>
 *  正文）曾被原样召回（用户实测报 bug）。三层还原，优先级从高到低：
 *  ① host/input-echo 旁注（新落盘会话）：紧随 user/message 的连续 host/* 事件里取原话（与转述
 *    旁注按数组序共存，扫描越过 host/vision-transcribe 等邻居）；
 *  ② 老会话（旁注机制之前落盘的技能合成体）：按 SKILL_MARK_RE 定位标记行，取标记行与 <skill
 *    开栏行之间的原话行（2026-09-30 前的菜单 Enter 旧形态无原话行 → 空串跳过，不召回）；
 *  ③ 其余（普通消息/老会话 @ 展开体——引用已删正文已拼，原话不可逆）按发出体召回（尽力而为）。
 *  全部路径统一剥图片 chip token（seq 注册表随旧会话失效）；steer 文本本就是原文照收，排除
 *  host/date 系统行（2026-09-28：↑ 翻出「系统提醒：今天是…」是系统噪音）。 */
export const inputHistoryTexts = (events: SessionEvent[]): string[] => {
  const texts: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === "user/message") {
      const joined = ((e.content ?? []) as { kind?: string; text?: string }[]).filter((p) => p.kind === "text").map((p) => p.text ?? "").join("");
      // ① 旁注优先：只扫紧随的连续 host/* 事件（旁注块原子紧随落盘；host.date 系统行走 steer 通道不在此）
      let echo: string | undefined;
      for (let j = i + 1; j < events.length && events[j]!.type.startsWith("host/"); j++) {
        if (events[j]!.type === INPUT_ECHO_EVENT && typeof events[j]!.text === "string") echo = events[j]!.text as string;
      }
      let src = echo ?? joined;
      if (echo === undefined) {
        // ② 老会话技能合成体：标记行…行事）\n原话\n<skill name=… ——取中间段（indexOf：原话自身含
        // 同形行时截短召回，好过 lastIndexOf 越过开栏把正文尾巴带回来）
        const m = SKILL_MARK_RE.exec(joined);
        if (m !== null) {
          const rest = joined.slice(m.index + m[0].length);
          const open = rest.indexOf("\n<skill name=");
          src = open > 0 ? rest.slice(1, open) : "";
        }
      }
      const { cleaned } = extractImageRefs(src);
      if (cleaned !== "") texts.push(cleaned);
    } else if (e.type === "agent/steering-message") {
      // 宿主系统行不进召回（host/date 日期行、host/hook 钩子注入、hooks Stop 续跑——m5-hooks T2/T7；召回不重注入，回放侧另有折叠行渲染）
      for (const m of (e.messages ?? []) as { text?: string; sourceModule?: string }[])
        if (typeof m.text === "string" && m.text !== "" && m.sourceModule !== "host/date" && m.sourceModule !== "host/hook" && m.sourceModule !== "hooks") texts.push(m.text);
    }
  }
  return texts;
};
