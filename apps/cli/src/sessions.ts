import { readFileSync, statSync } from "node:fs";
import { scanSessionFiles, locateSessionFile, type SessionFileEntry } from "@orosus/core";

/** 会话列表条目（M4-2 B9 用户拉前，2026-09-19 走查人性化）：title 优先 session/label（首轮问答自动标题），
 *  兜底首问文本；创建时间 = birthtime（Windows 可得）回退 mtime。 */
export interface SessionListItem extends SessionFileEntry {
  title: string;
  createdAtMs: number;
}

/** 从会话文件提取标题：最后的 session/label → 首个 user/message 文本截断 → sid（sqlite/无对话）。
 *  文件已是完成事件形态（D45 断流后小文件），逐行读到命中即停。 */
export function readTitle(file: string, id: string): string {
  if (file.endsWith(".sqlite")) return id;
  try {
    let firstUser: string | undefined;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line === "") continue;
      let e: { type?: string; label?: unknown; content?: unknown };
      try { e = JSON.parse(line) as typeof e; } catch { continue; }
      if (e.type === "session/label" && typeof e.label === "string" && e.label !== "") return e.label;
      if (firstUser === undefined && e.type === "user/message") {
        const parts = (e.content ?? []) as { kind?: string; text?: string }[];
        const text = parts.filter((p) => p.kind !== "reasoning").map((p) => p.text ?? "").join("").replace(/\s+/g, " ").trim();
        if (text !== "") firstUser = text.slice(0, 20);
      }
    }
    return firstUser ?? id;
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
 *  取倒拨值，保持「创建早于一切修改」语义。 */
export function listSessions(root: string): SessionListItem[] {
  return scanSessionFiles(root)
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

/** 列表展示：`标题 · N 分钟前`，当前会话整行加粗青色（走查要求：加重/换色）。 */
export function formatSessions(root: string, currentSessionId?: string): string {
  const sessions = listSessions(root);
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
  | { kind: "resume"; sessionId: string };

/** 退出命令的同义集（用户要求 2026-09-18：/quit = /exit = /q）。 */
const QUIT_COMMANDS = new Set(["/quit", "/exit", "/q"]);

/** 输入是否是会话生命周期命令；是则给出指令（/fork 的分叉点 = 当前流上最后见到的事件 id）。 */
export function sessionCommand(input: string, current: { sessionId: string; lastEventId?: string | undefined }): SessionDirective | { kind: "none" } {
  const t = input.trim();
  if (QUIT_COMMANDS.has(t)) return { kind: "quit" };
  if (t === "/new") return { kind: "new" };
  if (t === "/fork") return { kind: "fork", parentSessionId: current.sessionId, ...(current.lastEventId !== undefined ? { atEntryId: current.lastEventId } : {}) };
  const m = /^\/(sessions|resume)(?:\s+(\S+))?$/.exec(t);
  if (m !== null) {
    const arg = m[2];
    return arg === undefined ? { kind: "pick" } : { kind: "resume", sessionId: arg };
  }
  return { kind: "none" };
}

/** 序号/sid → 会话 id（pick 选中或直达共用）。序号按当前列表（创建时间倒序前 10）；
 *  sid 经双层定位（不限前 10）。 */
export function resolveTarget(target: string, root: string): string | undefined {
  if (/^\d+$/.test(target)) {
    const n = Number(target);
    const list = listSessions(root);
    return n >= 1 && n <= list.length ? list[n - 1]!.id : undefined;
  }
  return locateSessionFile(root, target) !== undefined ? target : undefined;
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
