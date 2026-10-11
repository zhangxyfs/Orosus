/** B11-B13 会话动作（web 批 T9）：归档标记（B12 盘上标记文件）/ 删除守卫（B11 活锁守卫 + 本进程
 *  托管先 close 再删）/ 导出 markdown 渲染（B11）/ 已归档列表（F10 数据面）。
 *  - 归档：标记 `<bucket>/<sid>/agents/archived`（内容 = 归档时刻 ISO 一行；恢复 = 删文件）。
 *    fresh 空会话拒归档（B12「fresh 不出现归档钮」的服务端口径——400 由调用方定形）。
 *    边界注记：CLI/TUI 无归档概念（红线不动）——归档仅 web 左栏/已归档页语义。
 *  - 删除守卫（B11 口径）：外部进程活会话（live.json pid 活且非本进程 / lock 活锁）→ 409；
 *    本进程 pool 托管会话（含当前与非当前）一律先 close（presence 撤 → h.close）再删——
 *    自身 presence 不作锁，否则本次运行内开过的会话全删不掉。
 *  - renderMarkdown：SessionEvent 流 → markdown（user/assistant 分节 + thinking 折叠引用 +
 *    工具行摘要）——纯函数，端点侧补标题头。 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isEmptySessionHead, locateSessionFile, purgeSessionDir, readSessionHead, scanBucketSessions, scanSessionFiles,
} from "@orosus/core";
import type { SessionEvent } from "@orosus/core";
import { liveSessionActive, lockHeldByOther } from "../ps.ts";
import { bucketCwd } from "./buckets.ts";
import type { HostPool } from "./hostpool.ts";

/** 归档标记文件路径（会话目录内 agents/ 下——与主文件同位，随 purgeSessionDir 连带清）。 */
export const archivedMarkerPath = (sessionDir: string): string => join(sessionDir, "agents", "archived");

const isArchived = (sessionDir: string): boolean => existsSync(archivedMarkerPath(sessionDir));

// ---------- 归档（B12）----------

export type ActionResult = { ok: true } | { ok: false; status: 400 | 404; error: string };

/** 归档：写标记文件（内容 = ISO 一行）。fresh 空会话 → 400（B12）；不在桶内 → 404。
 *  fresh 判据 = isEmptySessionHead（core 导出——B13 同源；hosted 无盘 fresh 会话的拦截在路由层）。 */
export function archiveSession(bucketDir: string, sid: string): ActionResult {
  const entry = scanBucketSessions(bucketDir).find((e) => e.id === sid);
  if (entry === undefined) return { ok: false, status: 404, error: "会话不存在" };
  const head = readSessionHead(entry.file);
  if (head !== undefined && isEmptySessionHead(head)) return { ok: false, status: 400, error: "空会话不能归档" };
  writeFileSync(archivedMarkerPath(entry.dir), `${new Date().toISOString()}\n`, "utf8");
  return { ok: true };
}

/** 恢复：删标记文件（幂等——无标记 = no-op false，路由仍回 ok）。 */
export function unarchiveSession(bucketDir: string, sid: string): boolean {
  const marker = archivedMarkerPath(join(bucketDir, sid));
  if (!existsSync(marker)) return false;
  rmSync(marker, { force: true });
  return true;
}

/** 已归档条目（GET /api/archived items——§3 形状；双时间 = 归档时刻（标记内容 ISO，mtime 兜底）
 *  + 创建时刻（min(birth, mtime)——listSessions 同口径），均 epoch ms）。 */
export interface ArchivedItem {
  sid: string;
  title: string;
  cwd: string;
  archivedAt: number;
  createdAt: number;
}

/** 全根扫描已归档会话（归档时刻倒序）。cwd 经 bucketCwd 反查（缓存命中——§5 律三）。 */
export function listArchived(root: string): ArchivedItem[] {
  const out: ArchivedItem[] = [];
  for (const e of scanSessionFiles(root)) {
    if (!isArchived(e.dir)) continue;
    let archivedAt = e.mtimeMs;
    try {
      archivedAt = statSync(archivedMarkerPath(e.dir)).mtimeMs;
      const t = Date.parse(readFileSync(archivedMarkerPath(e.dir), "utf8").trim());
      if (Number.isFinite(t)) archivedAt = t; // 标记内容 ISO 优先（mtime 会随后续触碰漂移）
    } catch { /* 坏标记按 mtime 兜底 */ }
    const head = readSessionHead(e.file);
    let createdAt = e.mtimeMs;
    try {
      const b = statSync(e.file).birthtimeMs; // 「创建早于一切修改」（listSessions 手法）
      if (b > 0 && Number.isFinite(b)) createdAt = Math.min(b, e.mtimeMs);
    } catch { /* mtime 回退 */ }
    out.push({
      sid: e.id,
      title: head?.label ?? head?.firstUser ?? "",
      cwd: bucketCwd(root, e.bucket) ?? "",
      archivedAt,
      createdAt,
    });
  }
  return out.toSorted((a, b) => b.archivedAt - a.archivedAt);
}

// ---------- 删除守卫（B11）----------

export type DeleteResult = { ok: true } | { ok: false; status: 409 | 404; error: string };

/** 永久删除（DELETE /api/sessions/:sid——B11 守卫口径）：
 *  1. 本进程 pool 托管（host/viewer，含当前与非当前）→ 先 pool.remove（close 序：presence 撤 →
 *     h.close → purgeIfEmpty——Windows 活句柄纪律）——自身 presence/锁不作删除障碍；
 *  2. 外部守卫（仅未托管时）：live.json 活体（pid 活且非本进程）或 lock 活锁 → 409；
 *  3. purgeSessionDir 剩余目录（托管会话非空时 close 不清，此处删尽；fresh 无盘壳目录也在此收口）。 */
export async function deleteSession(root: string, sid: string, pool: HostPool | undefined): Promise<DeleteResult> {
  const hosted = pool?.lookup(sid);
  if (hosted !== undefined && pool !== undefined) {
    await pool.remove(sid); // 先 close 再删（自身 presence 不作锁——B11 明文）
  }
  const loc = locateSessionFile(root, sid);
  if (loc === undefined) {
    if (hosted !== undefined) {
      purgeSessionDir(join(root, hosted.bucket), sid); // fresh 会话无主文件（header 懒写）——presence 壳目录收口
      return { ok: true };
    }
    return { ok: false, status: 404, error: "会话不存在" };
  }
  const bucketDir = dirname(loc.dir);
  if (hosted === undefined) {
    if (liveSessionActive(loc.dir, process.pid)) {
      return { ok: false, status: 409, error: "会话正被另一个 Orosus 进程使用" };
    }
    const holderPid = lockHeldByOther(bucketDir, sid, process.pid);
    if (holderPid !== null) {
      return { ok: false, status: 409, error: `会话正被另一个 Orosus 进程使用（pid ${holderPid}）` };
    }
  }
  purgeSessionDir(bucketDir, sid);
  return { ok: true };
}

// ---------- 导出渲染（B11）----------

/** 工具行关键参数（render.ts toolCallLine 同族口径——path/file/pattern/command/url/query/name
 *  优先取首个字符串值；截 80 字符防长参数刷屏）。 */
const toolArgSummary = (args: Record<string, unknown> | undefined): string => {
  if (args === undefined) return "";
  for (const key of ["path", "file", "pattern", "command", "url", "query", "name"]) {
    const v = args[key];
    if (typeof v === "string" && v !== "") return ` ${v.slice(0, 80)}`;
  }
  return "";
};

/** SessionEvent 流 → markdown 正文（纯函数）：user/assistant 分节（角色切换才出节头——多轮连续
 *  同角色不重复）、thinking 折叠引用块、image 以路径引用、tool/call 单行摘要（工具行）。
 *  其余事件类型（header/turn/manifest 等）不渲染——导出面只要对话正文与工具轨迹。 */
export function renderMarkdown(events: SessionEvent[]): string {
  const out: string[] = [];
  let lastRole: "user" | "assistant" | undefined;
  for (const e of events) {
    if (e.type === "user/message" || e.type === "assistant/message") {
      const role: "user" | "assistant" = e.type === "user/message" ? "user" : "assistant";
      const parts = (Array.isArray(e.content) ? e.content : []) as { kind?: string; text?: string; path?: string }[];
      if (role !== lastRole) {
        out.push("", role === "user" ? "## 用户" : "## 助手", "");
        lastRole = role;
      }
      for (const p of parts) {
        if (p.kind === "thinking" && (p.text ?? "") !== "") out.push(`> 思考：${p.text}`, "");
        if (p.kind === "text" && (p.text ?? "") !== "") out.push(p.text!, "");
        if (p.kind === "image") out.push(`![图片](${p.path ?? ""})`, "");
      }
    } else if (e.type === "tool/call") {
      out.push(`> 工具 ${String(e.name)}${toolArgSummary(e.args as Record<string, unknown> | undefined)}`, "");
      lastRole = undefined; // 工具行后回到 assistant 时重新出节头（正文与工具轨迹的分隔）
    }
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
