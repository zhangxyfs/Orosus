import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["tool-fs__write", "tool-fs__edit"]); // D2

export interface ToolCallLine { name: string; args: Record<string, unknown>; ts: number }

export function parseToolCallLine(line: string): ToolCallLine | undefined {
  if (!line.endsWith(`,"type":"tool/call"}`)) return undefined;   // 信封末键嗅探（eventindex 同口径）
  try {
    const e = JSON.parse(line) as { name?: unknown; args?: unknown; ts?: unknown };
    if (typeof e.name !== "string") return undefined;
    return { name: e.name, args: (e.args as Record<string, unknown>) ?? {}, ts: typeof e.ts === "string" ? Date.parse(e.ts) : 0 };
  } catch { return undefined; }
}

export function normalizePath(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;      // D3
}

export function deriveRecentWrites(lines: string[], now: number, windowMs: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) {
    const c = parseToolCallLine(line);
    if (c === undefined || !WRITE_TOOL_NAMES.has(c.name) || c.ts <= 0 || now - c.ts > windowMs) continue;
    const p = c.args["path"];
    if (typeof p !== "string" || p === "") continue;
    const key = normalizePath(p);
    if ((out.get(key) ?? 0) < c.ts) out.set(key, c.ts);
  }
  return out;
}

export interface Claim { file: string; since: number; until: number }

export function parseClaims(text: string, now: number): Claim[] {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((c): c is Claim => {
      const x = c as Partial<Claim>;
      return typeof x?.file === "string" && typeof x?.until === "number" && x.until > now
        && (x.since === undefined || typeof x.since === "number");
    }).map(c => ({ file: c.file, since: c.since ?? 0, until: c.until }));
  } catch { return []; }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; }  // jsonl.ts:49 同口径
}

export function isSessionLive(sessionDir: string, now: number, staleMs: number): boolean {
  const lock = join(sessionDir, "agents", "session.lock");
  if (existsSync(lock)) {
    try {
      const pid = Number.parseInt(readFileSync(lock, "utf8").split("\n")[0] ?? "", 10);
      return Number.isInteger(pid) && pid > 0 ? pidAlive(pid) : true;   // 读不出 pid 保守视为活
    } catch { return true; }
  }
  const main = ["session.jsonl", "session.sqlite"].map(n => join(sessionDir, "agents", n)).find(existsSync);
  if (main === undefined) return false;
  return now - statSync(main).mtimeMs <= staleMs;
}

export function readTailLines(file: string, maxBytes = 65_536): string[] {
  const st = statSync(file);
  const len = Math.min(st.size, maxBytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try { readSync(fd, buf, 0, len, st.size - len); } finally { closeSync(fd); }
  const lines = buf.toString("utf8").split("\n");
  if (st.size > maxBytes && lines.length > 0) lines.shift();     // 丢头部半行
  return lines.filter(l => l.trim() !== "");
}

export function readLabel(tailLines: string[], fallback: string): string {
  let label: string | undefined;
  for (const line of tailLines) {
    if (!line.endsWith(`,"type":"session/label"}`)) continue;
    try { const l = (JSON.parse(line) as { label?: unknown }).label; if (typeof l === "string" && l !== "") label = l; } catch { /* 跳行 */ }
  }
  return label ?? fallback;
}
