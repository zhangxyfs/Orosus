import { scanSessionFiles, type SessionFileEntry } from "@orosus/core";

/** /sessions：双层扫描（M4-1 T1/D46）——根平铺（存量）+ 桶目录（现行），复用 core 统一件
 *  scanSessionFiles（不另造目录遍历）；mtime 降序取前 10；bucket 标注来源（平铺 = 存量原地兼容）。 */
export function listSessions(root: string): SessionFileEntry[] {
  return scanSessionFiles(root).slice(0, 10);
}

/** CLI 拦截层会话命令（D41/D38 第一层——宿主操作）：/new /fork /sessions。
 *  /new 与 /fork 需要换 harness 实例——REPL 外层会话循环消费 SessionDirective。 */
export type SessionDirective =
  | { kind: "quit" }
  | { kind: "new" }
  | { kind: "fork"; parentSessionId: string; atEntryId?: string };

/** 退出命令的同义集（用户要求 2026-09-18：/quit = /exit = /q）。 */
const QUIT_COMMANDS = new Set(["/quit", "/exit", "/q"]);

/** 输入是否是会话生命周期命令；是则给出指令（/fork 的分叉点 = 当前流上最后见到的事件 id）。 */
export function sessionCommand(input: string, current: { sessionId: string; lastEventId?: string | undefined }): SessionDirective | { kind: "none" } {
  const t = input.trim();
  if (QUIT_COMMANDS.has(t)) return { kind: "quit" };
  if (t === "/new") return { kind: "new" };
  if (t === "/fork") return { kind: "fork", parentSessionId: current.sessionId, ...(current.lastEventId !== undefined ? { atEntryId: current.lastEventId } : {}) };
  return { kind: "none" };
}

/** 会话切换的构造参数（外层循环据此建新 harness）。parentDir（T1/D46）：父会话所在目录——
 *  fork 子会话落当前项目桶，父会话可能在别的桶或平铺（resume 旧会话后 /fork 的场景），由外层填。 */
export function harnessOptionsFor(
  directive: SessionDirective,
  opts: { parentDir?: string } = {},
): { fork?: { parentSessionId: string; atEntryId?: string; parentDir?: string } } {
  if (directive.kind === "fork") {
    return {
      fork: {
        parentSessionId: directive.parentSessionId,
        ...(directive.atEntryId !== undefined ? { atEntryId: directive.atEntryId } : {}),
        ...(opts.parentDir !== undefined ? { parentDir: opts.parentDir } : {}),
      },
    };
  }
  return {};
}

export function formatSessions(root: string): string {
  const sessions = listSessions(root);
  if (sessions.length === 0) return "（暂无会话——发送第一条消息即创建）";
  return sessions.map((s, i) => `  ${i + 1}. ${s.id}［${s.bucket ?? "平铺"}］（${new Date(s.mtimeMs).toLocaleString()}）`).join("\n");
}
