/** web 命令路由（web 批 T6）——浏览器斜杠命令的 web 化：表驱动路由 + host 命令自写 + 模块命令
 *  透传 + BUSY 分级（§1 G1/D15 口径）。
 *  三层路由（对齐 CLI「宿主拦截 + core 路由」分工）：
 *  ① host 命令自写（CLI 宿主拦截件同族——core 不认识，透传会撞「未知命令」）：
 *     - /quit 族（/exit /q 同义）：web 语义 = 关当前会话（G10 差异——HostedSession.close 同 CLI
 *       退出序列，server 常驻），返回 mark:"quit" 由 server 侧执行（api-session send 端点）。
 *     - /new /fork：mark:"new"/"fork" 信号——前端开新会话（T9 POST /api/sessions 消费；G7/G8）。
 *     - /model：core 的 choose 菜单内嵌在命令里（harness.ts:881-976）——web 不走 choose 桥
 *       （§4-5：结构化 API /api/models + setModel），返回 mark:"menu:model" 由前端开菜单（D9）。
 *     - /tasks /task：mark:"tasks" 信号——前端开任务面板（G3 数据面 GET /tasks 是 T7 交付）。
 *     - /title /rename：h.setLabel 活写口（session/label 事件回流；无参静默——CLI 批⑦拍板同款）。
 *     - /ps：scanWithSelf/formatPsList 文本（ps.ts 纯函数直 import；ANSI 剥离——web 输出面是 HTML）。
 *     - /btw：runBtw 旁路直调（h.llm().stream 零落盘；流经 HostedSession.onBtw 扇出 SSE btw 帧）。
 *     - /skill：目录解析 + 标记行合成体（G6——CLI 是宿主拦截递归走消息管线，web 同构：返回 submit
 *       由分流点走消息路径，busy 排队语义保留）。
 *  ② core 内建（/effort /help /reload /context）+ 别名表（/yolo /auto /permission /provider /compact）
 *     + 一切 `__` 模块命令：透传 h.prompt 闭环（命令不落 user/message——harness.ts:1334 注记；choose
 *     类经 T5 WebCommandUi 桥）。/context 原型 CMDS 无此项但 TUI 可打（slashItems 不列、h.prompt
 *     直达）——web 同样放行、输出走 toast（G1）。
 *  ③ 其余（/settings /sessions /web 等 CLI 宿主拦截件）：web 不自写——透传后 core 报未知命令，
 *     错误文案即输出（toast 面；G1 键入行为分家：/settings /sessions 报未知，/provider /permission
 *     经 core 别名表仍可达）。
 *  BUSY 分级（D15）表与判定函数在本件，消费在 hosted.ts 的 routeCommand 分流点：EXEC 表 + `__`
 *  模块命令 busy 期立即执行（core 命令路由在单并发守卫之前，harness.ts:1275）；BLOCK 表（/new
 *  /fork）→ 409 语义 {error}；两表外默认档 = 与消息同队（对齐 TUI「其余命令与消息照旧排队」
 *  main.ts:1401）；/quit 族 busy 特例 = 先 cancel 再关当前会话（TUI :1400 立即打断同款）。 */
import { readFileSync } from "node:fs";
import { buildBtwRequest, BTW_USAGE_HINT } from "../btw-cmd.ts";
import { formatPsList, scanWithSelf } from "../ps.ts";
import { t } from "../i18n/app.ts";
import { SKILL_MARK_PREFIX, SKILL_MARK_TAIL } from "../i18n/protocol-strings.ts";
import type { HostedSession } from "./hosted.ts";

/** busy 即改档表（原型 :1445-1447 的表逐字——web 版无 /permission /settings /config 项：原型口径）：
 *  busy 期直接执行不排队（core 命令路由在单并发守卫前，harness.ts:1275）。`__` 模块命令不在表内
 *  ——由 busyExecutable 的 includes("__") 补入（D15 web 侧补充：模块命令 = 纯操作面）。 */
export const WEB_BUSY_EXEC: ReadonlySet<string> = new Set([
  "/model", "/effort", "/yolo", "/auto", "/title", "/rename", "/tasks", "/task", "/btw", "/ps",
]);

/** busy 拦截表（原型仅 /new + web 补 /fork——busy 期分叉危险；D15 两处 web 侧补充之一）。 */
export const WEB_BUSY_BLOCK: ReadonlySet<string> = new Set(["/new", "/fork"]);

/** /quit 族（/exit /q 别名——原型 CMDS 同表，sessions.ts QUIT_COMMANDS 同义集）。 */
export const QUIT_CMDS: ReadonlySet<string> = new Set(["/quit", "/exit", "/q"]);

/** busy 期可立即执行的判定（D15）：EXEC 表命中或 `__` 模块命令（模块命令 core 路由在守卫前）。 */
export const busyExecutable = (name: string): boolean => WEB_BUSY_EXEC.has(name) || name.includes("__");

/** 命令词归一 + 切分（core harness 同款规则：trim + 斜杠后空格抹除 + 连续空白折叠；命令词小写——
 *  参数原样保留）。hosted.ts 的 busy 分级与透传面共用。 */
export function commandNameOf(raw: string): { name: string; args: string } {
  const normalized = raw.trim().replace(/^\/\s+/, "/").replace(/\s+/g, " ");
  const sp = normalized.indexOf(" ");
  if (sp === -1) return { name: normalized.toLowerCase(), args: "" };
  return { name: normalized.slice(0, sp).toLowerCase(), args: normalized.slice(sp + 1).trim() };
}

/** 路由结果标记（分流点透传到 send 响应，前端消费）：new/fork = 开会话动作（T9）；quit = 关当前
 *  会话（server 执行）；skill = 技能合成体已提交（T16 收菜单/流区标记行）；menu:model = 前端开
 *  模型菜单（§1 D9 差异口径——brief 接口的 mark 并集 + Steps 点名的 menu:model 信号）；
 *  tasks = 前端开任务面板（G3——T7 数据面）。 */
export type CommandMark = "new" | "fork" | "quit" | "skill" | "menu:model" | "tasks";

export interface CommandResult {
  /** 命令输出文本（§4-4：命令返回值是文本、静默命令 ""——D16 命令行不进流区，输出走 toast/浮层）。 */
  output: string;
  mark?: CommandMark;
  /** /skill 合成体——分流点以消息路径重新提交（CLI 递归管线的 web 同构：busy 排队语义保留）。
   *  busy 期 /skill 根本不进本件（默认档入队的是原文，出队时再解析）。 */
  submit?: string;
}

/** ANSI SGR 剥离（/ps 文本透传 web 输出面——theme 色码是终端概念，HTML 渲染不留垃圾字节；
 *  匹配对象是转义序列本身，no-control-regex 误伤——ansi.ts 同款定点豁免）。 */
// oxlint-disable-next-line no-control-regex
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_SGR_RE, "");

/** 成对引号剥离（sessions.ts unquote 同款语义：两端成对才剥——/title "名字" 的引号是分隔符）。 */
const unquote = (s: string): string => {
  const close: Record<string, string> = { '"': '"', "'": "'", "“": "”", "「": "」" };
  const c = close[s[0] ?? ""];
  return c !== undefined && s.length >= 2 && s.endsWith(c) ? s.slice(1, -1).trim() : s;
};

/** 表驱动路由（brief 签名）。闲时与 busy-EXEC 同径（命令不建 turn——core 路由在守卫前）；
 *  命令错误（含未知命令）throw 由分流点折为 output（toast 面，D16）。 */
export async function routeCommand(hs: HostedSession, raw: string): Promise<CommandResult> {
  const { name, args } = commandNameOf(raw);
  const h = hs.core;
  if (h === undefined) throw new Error("会话装配失败");

  // ——— ① host 命令自写 ———
  if (QUIT_CMDS.has(name)) return { output: "", mark: "quit" }; // G10：关当前会话——server 侧执行
  if (name === "/new") return { output: "", mark: "new" }; // G8：前端 POST /api/sessions + 清流区
  if (name === "/fork") return { output: "", mark: "fork" }; // G7：前端 POST /api/sessions {forkFrom}
  if (name === "/model") return { output: "", mark: "menu:model" }; // §4-5/D9：不走 choose 桥——前端开结构化菜单
  if (name === "/tasks" || name === "/task") return { output: "", mark: "tasks" }; // G3：T7 数据面 + 前端面板
  if (name === "/title" || name === "/rename") {
    if (args === "") return { output: "" }; // 无参静默零写入（CLI 批⑦拍板同款）
    const label = unquote(args);
    if (label === "") return { output: "" };
    await h.setLabel(label); // session/label 事件回流（SSE ev 帧）
    return { output: t("main.title.renamedToast", { name: label }) }; // 确认 toast（t 键同族——G4）
  }
  if (name === "/ps") {
    const pd = scanWithSelf(hs.sessionsDir, hs.sid); // ps.ts 纯函数直 import（数据面同源）
    const lines = formatPsList(pd.list, pd.self !== undefined ? { self: pd.self } : {});
    return { output: stripAnsi(lines.join("\n")) };
  }
  if (name === "/btw") {
    if (args === "") {
      const last = lastBtwOf(hs);
      return { output: last === undefined ? BTW_USAGE_HINT : btwArchiveText(last) }; // 无参回看（D7 内存槽）
    }
    // 参数式：受理即回——runBtw 后台收流经 onBtw 扇出（SSE btw 帧小窗）；完成归档 lastBtw
    let acc = "";
    void runBtw(hs, args, (delta) => {
      acc += delta;
      hs.emitBtw({ phase: "answering", text: acc }); // 累积式（前端晚开窗也能整段渲染）
    }).then(
      (text) => { hs.emitBtw({ phase: "answer", text }); },
      (err) => {
        if (err instanceof Error && err.message === BTW_REPLACED) return; // 被新侧问取代——新问占窗，不投终态
        hs.emitBtw({ phase: "error", text: err instanceof Error ? err.message : String(err) });
      },
    );
    return { output: "" };
  }
  if (name === "/skill") {
    const inject = await skillSubmitOf(h, args);
    if (typeof inject === "string") return { output: inject }; // 用法/未找到文案（toast 面）
    return { output: "", mark: "skill", submit: inject.submit };
  }

  // ——— ②③ 透传：core 内建 + 别名 + `__` 模块命令；其余 core 报未知命令（throw → 分流点折 output） ———
  return { output: (await h.prompt(raw)) ?? "" }; // 消息路径返回 undefined——命令路径 string（§4-4）
}

// ---------- /btw（G2：旁路快问——不打断主对话、零落盘、lastBtw server 持） ----------

/** 每会话 btw 状态：单飞控制器（新问先中止旧在飞——CLI 进程级单件的会话级化）+ 回看归档。 */
interface BtwState {
  ctrl?: AbortController;
  last?: { question: string; text: string };
  hooked?: boolean; // close 钩子已注册（会话关停时中止在飞侧问）
}
const btwBySession = new WeakMap<HostedSession, BtwState>();

/** 被新侧问取代的哨兵（btw-cmd.ts openBtw 同字面量——终态不投帧，新问接管小窗）。 */
const BTW_REPLACED = "已被新侧问取代";

/** 无参 /btw 回看数据口（D7）：lastBtw 内存槽（仅 answer 态归档——被中止/失败的问不入）。 */
export function lastBtwOf(hs: HostedSession): { question: string; text: string } | undefined {
  return btwBySession.get(hs)?.last;
}

/** 回看文本形态（CLI 行模式 `[侧问] 问\n答` 同形——前端 view 窗整段渲染）。 */
const btwArchiveText = (last: { question: string; text: string }): string => `[侧问] ${last.question}\n${last.text}`;

/** 带参侧问（brief 签名）：buildBtwRequest（btw-cmd.ts 纯函数）+ h.llm().stream 直调收流——
 *  零落盘（不经 store/loop，events 无 user/message）；onChunk 收 text/delta 增量；错误带内
 *  （finish/error 不抛——消费侧此刻才升级）与 AbortError 统一 throw。单飞：同会话新问先 abort
 *  旧在飞（旧问以 BTW_REPLACED 收场、不入归档）。完成归档 lastBtw 并返回答案全文。 */
export async function runBtw(hs: HostedSession, q: string, onChunk: (t: string) => void): Promise<string> {
  const st = btwBySession.get(hs) ?? {};
  btwBySession.set(hs, st);
  st.ctrl?.abort(); // 新问先中止旧在飞（qwen cancelBtw 同款）
  const ac = new AbortController();
  st.ctrl = ac;
  if (st.hooked !== true) {
    st.hooked = true;
    hs.onClose(() => st.ctrl?.abort()); // 会话关停 → 在飞侧问中止（CLI「关 CLI 即没」的 web 同构）
  }
  const h = hs.core;
  if (h === undefined) throw new Error("会话装配失败");
  const replaced = (): boolean => ac.signal.aborted;
  const { system, messages } = await buildBtwRequest(h, q);
  if (replaced()) throw new Error(BTW_REPLACED);
  let text = "";
  for await (const c of h.llm().stream({ system, messages, signal: ac.signal })) {
    if (c.type === "text/delta") {
      text += c.text;
      onChunk(c.text);
    } else if (c.type === "finish") {
      if (c.kind === "error") throw new Error(c.errorMessage ?? "llm 调用失败");
      if (c.kind === "aborted" && !ac.signal.aborted) throw new Error("已中止"); // 适配器静默中止——不把半截当答案
      break; // stop/length = 完整答案（无工具单轮）
    }
    // reasoning/usage/server-search：侧问小窗不消费
  }
  if (replaced()) throw new Error(BTW_REPLACED); // 收流途中被新问取代
  st.last = { question: q, text }; // 只有走完的 answer 态归档
  return text;
}

// ---------- /skill（G6：目录解析 + 标记行合成体） ----------

/** skill.catalog 行的最小消费面（圈地纪律：消费侧类型本地声明）。 */
interface SkillCatalogRow {
  name: string;
  file: string;
}

/** "/skill : 名 [参数]" 解析（main.ts 宿主拦截同款正则族：/skill:名 /skill : 名 /SKILL 同达；
 *  名字与参数分家——首个空格后的尾巴是给技能的参数）。 */
const parseSkillArgs = (args: string): { name: string; skillArgs: string | undefined } => {
  const m = /^:\s*(.*)$/.exec(args);
  if (m === null) return { name: "", skillArgs: undefined };
  const typed = m[1]!.trim();
  const sp = typed.indexOf(" ");
  return sp === -1
    ? { name: typed, skillArgs: undefined }
    : { name: typed.slice(0, sp), skillArgs: typed.slice(sp + 1).trim() || undefined };
};

/** 目录解析 + 标记行合成体构造。返回 string = 用法/未找到文案（toast 面）；{submit} = 合成体
 *  （分流点走消息路径）。合成体格式与 skills-ui.ts skillInjectText 逐字同形（SKILL_MARK 前缀/尾段
 *  走协议常量；首行标记 docmodel ● 行识别 + 防重入按精确形态匹配——不能漂移）。 */
async function skillSubmitOf(h: NonNullable<HostedSession["core"]>, args: string): Promise<string | { submit: string }> {
  const { name, skillArgs } = parseSkillArgs(args);
  if (name === "") return t("main.skill.usage");
  let rows: SkillCatalogRow[] = [];
  try {
    // services.getOptional 是异步口（permissionMode 同款消费形态——漏 await 会拿到 Promise 恒非函数）
    const catalog = await h.graph().services.getOptional("skill.catalog" as never);
    rows = typeof catalog === "function" ? (catalog as () => SkillCatalogRow[])() : [];
  } catch {
    rows = []; // 服务面异常按空目录——notFound 文案兜底
  }
  // 真名归位（skillTypedName 同款：精确命中优先，落空整表小写比对）
  const hit = rows.find((r) => r.name === name) ?? rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (hit === undefined) return t("main.skill.notFound", { name });
  let body: string;
  try {
    body = readFileSync(hit.file, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, ""); // 剥 frontmatter
  } catch {
    return t("main.skill.readFail", { name });
  }
  const attrs = skillArgs !== undefined ? ` args="${skillArgs.replace(/"/g, "&quot;")}"` : "";
  return {
    submit: `${SKILL_MARK_PREFIX} "${hit.name}"${SKILL_MARK_TAIL}\n<skill name="${hit.name}"${attrs} file="${hit.file.replace(/"/g, "&quot;")}">\n${body}\n</skill>`,
  };
}
