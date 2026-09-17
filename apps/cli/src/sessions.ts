import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** /sessions：列出会话目录里的最近会话（mtime 降序，前 10）。jsonl/sqlite 两种后端文件都认。 */
export function listSessions(dir: string): { id: string; file: string; mtimeMs: number }[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") || f.endsWith(".sqlite"))
      .map((f) => {
        const file = join(dir, f);
        return { id: f.replace(/\.(jsonl|sqlite)$/, ""), file, mtimeMs: statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 10);
  } catch {
    return []; // 目录不存在（尚未有会话）
  }
}

/** CLI 拦截层会话命令（D41/D38 第一层——宿主操作）：/new /fork /sessions。
 *  /new 与 /fork 需要换 harness 实例——REPL 外层会话循环消费 SessionDirective。 */
export type SessionDirective =
  | { kind: "quit" }
  | { kind: "new" }
  | { kind: "fork"; parentSessionId: string; atEntryId?: string };

/** 输入是否是会话生命周期命令；是则给出指令（/fork 的分叉点 = 当前流上最后见到的事件 id）。 */
export function sessionCommand(input: string, current: { sessionId: string; lastEventId?: string | undefined }): SessionDirective | { kind: "none" } {
  const t = input.trim();
  if (t === "/new") return { kind: "new" };
  if (t === "/fork") return { kind: "fork", parentSessionId: current.sessionId, ...(current.lastEventId !== undefined ? { atEntryId: current.lastEventId } : {}) };
  return { kind: "none" };
}

/** 会话切换的构造参数（外层循环据此建新 harness）。 */
export function harnessOptionsFor(directive: SessionDirective): { fork?: { parentSessionId: string; atEntryId?: string } } {
  if (directive.kind === "fork") {
    return { fork: { parentSessionId: directive.parentSessionId, ...(directive.atEntryId !== undefined ? { atEntryId: directive.atEntryId } : {}) } };
  }
  return {};
}

export function formatSessions(dir: string): string {
  const sessions = listSessions(dir);
  if (sessions.length === 0) return "（暂无会话——发送第一条消息即创建）";
  return sessions.map((s, i) => `  ${i + 1}. ${s.id}（${new Date(s.mtimeMs).toLocaleString()}）`).join("\n");
}
