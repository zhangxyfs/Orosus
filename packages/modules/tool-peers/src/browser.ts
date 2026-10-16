import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { noteMetaOfText } from "./memstore.ts";

/** 记忆浏览窗数据件（m5-peers T6c，v3 走查二轮）：列表序/标题/相对时间/正文读取。
 *  窗交互在 index.ts（命令接线：dialog 控件窗列表 + viewText 正文——PopupKey 无选中态，执行期核实走
 *  session-tree__view 同款 interactive list；「Esc 返回列表」降级为重开命令，偏差记档 T7）。 */

/** 翻译口（宿主 ctx.t 注入；缺省回落作者中文——approval/compaction 模块同款模式，2026-10-07 走查接线）。 */
export type BrowserT = (key: string, params?: Record<string, string | number>, fallback?: string) => string;

export interface BrowserEntry { file: string; title: string; summary: string; updatedAtMs: number; isIndex: boolean }

/** 列表项：第一项恒 MEMORY.md 本体；其后按索引引用顺序。孤儿笔记（有文件无索引行——手工文件/
 *  写盘中途）按 mtime 补尾不丢内容。
 *  性能口径（2026-10-15 用户走查「加载记忆列表卡」→ 2026-10-16 报障「弹窗还是慢」再硬化）：标题/
 *  简介取自**索引行本身**（模块写入侧 buildIndex 与笔记同源维护），mtime/孤儿扫描走 **fs/promises
 *  并行**（Promise.all）——串行 statSync 在慢盘/杀软过滤驱动下每文件 1-3ms、百级文件数百 ms，并行
 *  后墙钟压到单次盘往返量级；开窗**不读任何索引成员正文**（孤儿仍现读取题，不丢）。正文延迟到
 *  Enter 打开时单篇读（browserBody 本就如此）。代价：手工改笔记 frontmatter 后索引行标题滞后到
 *  下次写/重建（「索引即缓存」）。此前实现经 listNotes 逐篇 readFileSync，百篇级在 Windows 上
 *  开窗显著卡顿。 */
const INDEX_LINE_RE = /- \[([^\]]*)\]\(([^)]+)\)(?: — (.*))?/g;

export async function browserEntries(memoryDir: string): Promise<BrowserEntry[]> {
  const indexFile = join(memoryDir, "MEMORY.md");
  if (!existsSync(indexFile)) return [];
  const indexText = readFileSync(indexFile, "utf8");
  const indexMtime = await stat(indexFile).then((s) => s.mtimeMs, () => 0);
  const entries: BrowserEntry[] = [{
    file: "MEMORY.md",
    title: "共享记忆索引（MEMORY.md）",
    summary: "",
    updatedAtMs: indexMtime,
    isIndex: true,
  }];
  const seen = new Set<string>(["MEMORY.md"]);
  const matches = [...indexText.matchAll(INDEX_LINE_RE)];
  const mtimes = await Promise.all(matches.map((m) => stat(join(memoryDir, m[2] ?? "")).then((s) => s.mtimeMs, () => null)));
  matches.forEach((m, i) => {
    const file = m[2] ?? "";
    if (seen.has(file) || mtimes[i] === null) return; // 引用指向不存在的文件 → 跳过
    seen.add(file);
    entries.push({ file, title: m[1] ?? "", summary: m[3] ?? "", updatedAtMs: mtimes[i]!, isIndex: false });
  });
  // 孤儿扫描：名单级对比（readdir，索引成员零正文读）——仅孤儿行现读正文取题（noteMetaOfText 与写入侧同源）
  const names = await readdir(memoryDir).then((ns) => ns, () => [] as string[]);
  const orphanNames = names.filter(n => n.endsWith(".md") && n !== "MEMORY.md" && !seen.has(n));
  const [orphanStats, orphanTexts] = await Promise.all([
    Promise.all(orphanNames.map(n => stat(join(memoryDir, n)).then((s) => s.mtimeMs, () => null))),
    Promise.all(orphanNames.map(n => readFile(join(memoryDir, n), "utf8").then((t) => t, () => null))),
  ]);
  const orphans = orphanNames
    .map((n, i) => orphanStats[i] === null || orphanTexts[i] === null ? undefined : noteMetaOfText(n, orphanTexts[i]!, orphanStats[i]!))
    .filter((x): x is NonNullable<typeof x> => x !== undefined)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || (a.file < b.file ? -1 : 1));
  for (const o of orphans) {
    entries.push({ file: o.file, title: o.title, summary: o.summary, updatedAtMs: o.updatedAtMs, isIndex: false });
  }
  return entries;
}

/** 分页（2026-10-15 用户走查「能不能分页加载」）：单页行数自创值 50（TUI 视口 ~30-40 行的 1.5 倍
 *  上下，翻页不碎；Web 帧体量恒定）。首页无上一页哨兵；有后继时尾行加「下一页」哨兵——
 *  Enter 哨兵 → handle.update 整窗换页（reset:selection 滚回顶 = 翻页语义天然契合）。 */
export const MEMORY_PAGE_SIZE = 50;

export interface BrowserPage { lines: (string | BrowserRow)[]; page: number; pageCount: number; hasPrev: boolean; hasNext: boolean }

export function browserPage(entries: BrowserEntry[], page: number, now: number, tr?: BrowserT): BrowserPage {
  const t = tr ?? ((_k, _p, f) => f ?? _k);
  const pageCount = Math.max(1, Math.ceil(entries.length / MEMORY_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), pageCount); // 越界钳回（哨兵竞态下双保险）
  const slice = entries.slice((p - 1) * MEMORY_PAGE_SIZE, p * MEMORY_PAGE_SIZE);
  const lines: (string | BrowserRow)[] = renderBrowserList(slice, now, tr);   // 实行结构化 + 首尾哨兵字符串行
  const hasPrev = p > 1;
  const hasNext = p < pageCount;
  if (hasPrev) lines.unshift(t("peers.win.page.prev", undefined, "‹ 上一页"));
  if (hasNext) lines.push(t("peers.win.page.next", { rest: entries.length - p * MEMORY_PAGE_SIZE }, `下一页 ›（还有 ${entries.length - p * MEMORY_PAGE_SIZE} 条）`));
  return { lines, page: p, pageCount, hasPrev, hasNext };
}

/** mtime 相对时间：/sessions relativeTime 同款口径（刚刚/N 分钟/N 小时/N 天）；超 30 天落日期
 *  （同年 MM-DD、跨年 YYYY-MM-DD——spec §5.5 简图「09-28」形态）。串走 tr（peers.reltime.* 键）。 */
export function relativeTime(then: number, now: number, tr?: BrowserT): string {
  const t = tr ?? ((_k, _p, f) => f ?? _k);
  const s = Math.max(0, Math.floor((now - then) / 1_000));
  if (s < 60) return t("peers.reltime.now", undefined, "刚刚");
  const m = Math.floor(s / 60);
  if (m < 60) return t("peers.reltime.min", { m }, `${m} 分钟前`);
  const h = Math.floor(m / 60);
  if (h < 24) return t("peers.reltime.hour", { h }, `${h} 小时前`);
  const d = Math.floor(h / 24);
  if (d < 30) return t("peers.reltime.day", { d }, `${d} 天前`);
  const d2 = new Date(then);
  const mm = `${d2.getMonth() + 1}`.padStart(2, "0");
  const dd = `${d2.getDate()}`.padStart(2, "0");
  return d2.getFullYear() === new Date(now).getFullYear() ? `${mm}-${dd}` : `${d2.getFullYear()}-${mm}-${dd}`;
}

/** 结构行（2026-10-16 用户走查「时间最右、简介显示到时间前面一点」）：text = 标题(+完整简介)、
 *  note = 相对时间——GUI dw-cols 双栏（简介顶到时间前由 CSS ellipsis 截断）；TUI 宿主自适应截断
 *  （主文压到剩余宽度、note 恒可见——widgets.ts renderListItem）。**模块侧不再截简介**（旧 60 字帽
 *  是 TUI 固定宽护时间的粗器，GUI 全宽下浪费；TUI 现按实际宽度自适应）。索引行标题/时间串走 tr。 */
export interface BrowserRow { text: string; note?: string }

export function renderBrowserList(entries: BrowserEntry[], now: number, tr?: BrowserT): BrowserRow[] {
  const t = tr ?? ((_k, _p, f) => f ?? _k);
  return entries.map((e) => {
    const title = e.isIndex ? t("peers.win.index.title", undefined, e.title) : e.title;
    return {
      text: `${e.isIndex ? "◆" : " "} ${title}${e.summary !== "" ? ` · ${e.summary}` : ""}`,
      note: relativeTime(e.updatedAtMs, now, tr),
    };
  });
}

/** 行单串化（行模式只读回落同形消费）：字符串行（翻页哨兵）原样；对象行拼 `text · note`。 */
export function browserRowText(row: string | BrowserRow): string {
  return typeof row === "string" ? row : row.note !== undefined && row.note !== "" ? `${row.text} · ${row.note}` : row.text;
}

/** 正文读取：MEMORY.md 本体或笔记原文；basename 防穿越。 */
export function browserBody(memoryDir: string, file: string): string | undefined {
  if (file !== basename(file) || !file.endsWith(".md")) return undefined;
  try { return readFileSync(join(memoryDir, file), "utf8"); } catch { return undefined; }
}
