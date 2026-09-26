import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { scanSessionFiles, locateSessionFile, type SessionFileEntry } from "@orosus/core";

/** 会话列表条目（M4-2 B9 用户拉前，2026-09-19 走查人性化）：title 优先 session/label（首轮问答自动标题），
 *  兜底首问文本；创建时间 = birthtime（Windows 可得）回退 mtime。 */
export interface SessionListItem extends SessionFileEntry {
  title: string;
  createdAtMs: number;
}

/** readTitle 读取预算（M4-2.5 T2——日志调研 P5）：64 行或 16KB 先到先赢，超限退 sid——标题尽力而为，列表速度优先。 */
const READ_TITLE_MAX_LINES = 64;
const READ_TITLE_MAX_BYTES = 16 * 1024;

/** 从会话文件提取标题：最后的 session/label → 首个 user/message 文本截断 → sid（sqlite/无对话）。
 *  文件已是完成事件形态（D45 断流后小文件），逐行读到命中即停；读取带硬预算（超限退 sid——
 *  无 label 无对话的大文件不再拖慢 /sessions 列表，cc/dsh 头窗同思路）。
 *  取「最后」而非首枚：手动 /title 追加的新 label 须覆盖自动标题（M4-2 T0 走查实录——
 *  首枚短路使 /title 后列表仍显示旧名，单测全绿但真机不可用）。 */
export function readTitle(file: string, id: string): string {
  if (file.endsWith(".sqlite")) return id;
  try {
    let firstUser: string | undefined;
    let label: string | undefined;
    let lines = 0;
    let bytes = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line === "") continue;
      lines++;
      bytes += line.length;
      if (lines > READ_TITLE_MAX_LINES || bytes > READ_TITLE_MAX_BYTES) break; // 预算硬上限
      let e: { type?: string; label?: unknown; content?: unknown };
      try { e = JSON.parse(line) as typeof e; } catch { continue; }
      if (e.type === "session/label" && typeof e.label === "string" && e.label !== "") label = e.label;
      if (firstUser === undefined && e.type === "user/message") {
        const parts = (e.content ?? []) as { kind?: string; text?: string }[];
        const text = parts.filter((p) => p.kind !== "reasoning").map((p) => p.text ?? "").join("").replace(/\s+/g, " ").trim();
        if (text !== "") firstUser = text.slice(0, 20);
      }
    }
    return label ?? firstUser ?? id;
  } catch {
    return id;
  }
}

/** 相对时间（走查要求：几年/月/天/小时/分钟前——不显示绝对时间戳）。 */
export function relativeTime(then: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return `${Math.floor(d / 365)} 年前`;
}

/** /sessions 列表（B9 形态）：按创建时间倒序（最新在最前）取前 10，带标题与创建时间。
 *  创建时间 = min(birthtime, mtime)——正常时 birth ≤ mtime 恒取 birth；mtime 被倒拨（迁移/测试）时
 *  取倒拨值，保持「创建早于一切修改」语义。
 *  bucket（会话树批 #17 项目内封闭）：传 = 只列当前项目桶；不传 = 全域（测试与宿主级消费）。 */
export function listSessions(root: string, bucket?: string): SessionListItem[] {
  return scanSessionFiles(root)
    .filter((e) => bucket === undefined || e.bucket === bucket)
    .map((e) => {
      let createdAtMs = e.mtimeMs;
      try {
        const b = statSync(e.file).birthtimeMs;
        if (b > 0 && Number.isFinite(b)) createdAtMs = Math.min(b, e.mtimeMs);
      } catch { /* mtime 回退 */ }
      return { ...e, createdAtMs, title: readTitle(e.file, e.id) };
    })
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 10);
}

const BOLD_CYAN = "\x1b[1;36m";
const RESET = "\x1b[0m";

/** 列表展示：`标题 · N 分钟前`，当前会话整行加粗青色（走查要求：加重/换色）。bucket = 当前项目桶（#17）。 */
export function formatSessions(root: string, currentSessionId?: string, bucket?: string): string {
  const sessions = listSessions(root, bucket);
  if (sessions.length === 0) return "（暂无会话——发送第一条消息即创建）";
  return sessions
    .map((s, i) => {
      const line = `  ${i + 1}. ${s.title} · ${relativeTime(s.createdAtMs)}`;
      return s.id === currentSessionId ? `${BOLD_CYAN}${line}${RESET}` : line;
    })
    .join("\n");
}

/** CLI 拦截层会话命令（D41/D38 第一层——宿主操作）：/new /fork /sessions /resume /quit。
 *  B9 形态（2026-09-18 三轮定案，2026-09-19 走查拉前落地）：`/sessions`（别名 `/resume`）无参 = 列表 +
 *  choose 选中即 resume；`<序号|sid>` 直达 resume。 */
export type SessionDirective =
  | { kind: "quit" }
  | { kind: "new" }
  | { kind: "fork"; parentSessionId: string; atEntryId?: string }
  | { kind: "pick" }
  | { kind: "resume"; sessionId: string }
  | { kind: "title"; name?: string; target?: string };

/** 退出命令的同义集（用户要求 2026-09-18：/quit = /exit = /q）。 */
const QUIT_COMMANDS = new Set(["/quit", "/exit", "/q"]);

/** 输入是否是会话生命周期命令；是则给出指令（/fork 的分叉点 = 当前流上最后见到的事件 id）。
 *  命令归一化（2026-09-19 用户走查）：`/ exit`、`/resume  2`、` /quit ` 一律可解析——
 *  trim + 斜杠后空格抹除 + 连续空白折叠为单空格（不认就当聊天发出是缺陷，不是特性）。 */
export function sessionCommand(input: string, current: { sessionId: string; lastEventId?: string | undefined }): SessionDirective | { kind: "none" } {
  const t = input.trim().replace(/^\/\s+/, "/").replace(/\s+/g, " ");
  if (QUIT_COMMANDS.has(t)) return { kind: "quit" };
  if (t === "/new") return { kind: "new" };
  if (t === "/fork") return { kind: "fork", parentSessionId: current.sessionId, ...(current.lastEventId !== undefined ? { atEntryId: current.lastEventId } : {}) };
  // /session 单数同义（F5 用户实测：少打个 s 被路由成「未知命令」气泡，观感 = 消息被吞）
  const m = /^\/(sessions?|resume)(?:\s+(\S+))?$/.exec(t);
  if (m !== null) {
    const arg = m[2];
    return arg === undefined ? { kind: "pick" } : { kind: "resume", sessionId: arg };
  }
  const tm = /^\/(title|rename)(?:\s+([\s\S]+))?$/.exec(t);
  if (tm !== null) {
    const raw = tm[2]?.trim();
    if (raw === undefined || raw === "") return { kind: "title" };
    // 首位纯数字 → target + name；否则全部是 name。名字成对引号剥离（批⑦c——/title "名字" 的引号是分隔符不是名字一部分）
    const sm = /^(\d+)\s+(.+)$/.exec(raw);
    if (sm !== null) {
      const name = unquote(sm[2]!.trim());
      if (name === "") return { kind: "title" };
      return { kind: "title", target: sm[1]!, name };
    }
    const name = unquote(raw);
    if (name === "") return { kind: "title" };
    return { kind: "title", name };
  }
  return { kind: "none" };
}

/** 成对引号剥离（批⑦c）：ASCII/中文弯引号/书名号式「」——两端成对才剥，不对称原样保留（名字内容可能 legit 带引号尾）。 */
function unquote(s: string): string {
  const close: Record<string, string> = { '"': '"', "'": "'", "“": "”", "「": "」" };
  const c = close[s[0] ?? ""];
  return c !== undefined && s.length >= 2 && s.endsWith(c) ? s.slice(1, -1).trim() : s;
}

/** 序号选择（B9 走查定案：不选即取消——无需专门取消项）：空输入 = undefined（取消）；
 *  无效序号重问。ask 注入（readline UI / 测试替身）。
 *  可选第三参 ttyPick（TUI 批 T2——保留调用兼容：两参调用面语义不变）：TTY 下 main.ts 注入
 *  picker 闭包走键盘菜单；picker 的 Esc reject 在此转 undefined（「空输入 = 取消」的键盘
 *  对应——reject 不外溢 main.ts 消费面）。缺省 = 非 TTY 回落，既有 ask 循环原样。 */
export async function pickSessionNumber(
  ask: (q: string) => Promise<string>,
  count: number,
  ttyPick?: ((count: number) => Promise<number>) | undefined,
): Promise<number | undefined> {
  if (ttyPick !== undefined) {
    try {
      return await ttyPick(count);
    } catch {
      return undefined;
    }
  }
  for (;;) {
    const ans = (await ask("输入序号恢复（直接回车 = 取消）")).trim();
    if (ans === "") return undefined;
    if (/^\d+$/.test(ans)) {
      const n = Number(ans);
      if (n >= 1 && n <= count) return n;
    }
  }
}

/** 序号/sid → 会话 id（pick 选中或直达共用）。序号按当前列表（创建时间倒序前 10）；
 *  sid 经扫描定位（不限前 10）。bucket（#17）= 当前项目桶——他桶会话序号不可见、sid 直达落空。 */
export function resolveTarget(target: string, root: string, bucket?: string): string | undefined {
  if (/^\d+$/.test(target)) {
    const n = Number(target);
    const list = listSessions(root, bucket);
    return n >= 1 && n <= list.length ? list[n - 1]!.id : undefined;
  }
  return locateSessionFile(root, target, bucket !== undefined ? { bucket } : undefined) !== undefined ? target : undefined;
}

/** /title 命名（M4-2 T0）：当前会话或指定会话追加 session/label。截断 200 字符（kimi 同款）。
 *  会话树批 T2/T5：定位带当前桶（#17）；store 的 dir 参数语义是桶 = 会话目录的父目录（dirname）——
 *  直接喂 scan 条目 dir 会嵌套出 <桶>/<sid>/<sid>/agents/ 假会话文件。 */
export async function setTitle(
  root: string, currentSid: string, target: string | undefined, name: string, bucket?: string,
): Promise<{ sid: string } | undefined> {
  const sid = target !== undefined ? (resolveTarget(target, root, bucket) ?? currentSid) : currentSid;
  const loc = locateSessionFile(root, sid, bucket !== undefined ? { bucket } : undefined);
  if (loc === undefined) return undefined;
  const { JsonlSessionStore } = await import("@orosus/core");
  const store = new JsonlSessionStore({ dir: dirname(loc.dir), sessionId: sid });
  await store.append("session/label", { label: name.slice(0, 200) });
  await store.close();
  return { sid };
}

/** 会话切换的构造参数（外层循环据此建新 harness）。parentDir（T1/D46）：父会话所在目录——
 *  fork 子会话落当前项目桶，父会话可能在别的桶或平铺（resume 旧会话后 /fork 的场景），由外层填。 */
export function harnessOptionsFor(
  directive: SessionDirective,
  opts: { parentDir?: string } = {},
): { fork?: { parentSessionId: string; atEntryId?: string; parentDir?: string }; resume?: { sessionId: string } } {
  if (directive.kind === "fork") {
    return {
      fork: {
        parentSessionId: directive.parentSessionId,
        ...(directive.atEntryId !== undefined ? { atEntryId: directive.atEntryId } : {}),
        ...(opts.parentDir !== undefined ? { parentDir: opts.parentDir } : {}),
      },
    };
  }
  if (directive.kind === "resume") return { resume: { sessionId: directive.sessionId } };
  return {};
}
