import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { listNotes } from "./memstore.ts";

/** 记忆浏览窗数据件（m5-peers T6c，v3 走查二轮）：纯函数——列表序/标题/相对时间/正文读取。
 *  窗交互在 index.ts（命令接线：dialog 控件窗列表 + viewText 正文——PopupKey 无选中态，执行期核实走
 *  session-tree__view 同款 interactive list；「Esc 返回列表」降级为重开命令，偏差记档 T7）。 */

export interface BrowserEntry { file: string; title: string; updatedAtMs: number; isIndex: boolean }

/** 列表项：第一项恒 MEMORY.md 本体；其后按索引引用顺序；标题三级（frontmatter name → 首个 # → 文件名兜底——
 *  listNotes 内建）。孤儿笔记（有文件无索引行——手工文件/写盘中途）按 mtime 补尾不丢内容。 */
export function browserEntries(memoryDir: string): BrowserEntry[] {
  const indexFile = join(memoryDir, "MEMORY.md");
  if (!existsSync(indexFile)) return [];
  const indexText = readFileSync(indexFile, "utf8");
  const notes = listNotes(memoryDir);
  const metaByFile = new Map(notes.map(n => [n.file, n]));
  const entries: BrowserEntry[] = [{
    file: "MEMORY.md",
    title: "共享记忆索引（MEMORY.md）",
    updatedAtMs: statSync(indexFile).mtimeMs,
    isIndex: true,
  }];
  const seen = new Set<string>(["MEMORY.md"]);
  for (const m of indexText.matchAll(/- \[([^\]]*)\]\(([^)]+)\)/g)) {
    const file = m[2] ?? "";
    if (seen.has(file)) continue;
    const meta = metaByFile.get(file);
    if (meta === undefined) continue;   // 引用指向不存在的文件 → 跳过
    seen.add(file);
    entries.push({ file, title: meta.title, updatedAtMs: meta.updatedAtMs, isIndex: false });
  }
  for (const n of notes) {
    if (!seen.has(n.file)) entries.push({ file: n.file, title: n.title, updatedAtMs: n.updatedAtMs, isIndex: false });
  }
  return entries;
}

/** mtime 相对时间：/sessions relativeTime 同款口径（刚刚/N 分钟/N 小时/N 天）；超 30 天落日期
 *  （同年 MM-DD、跨年 YYYY-MM-DD——spec §5.5 简图「09-28」形态）。 */
export function relativeTime(then: number, now: number): string {
  const s = Math.max(0, Math.floor((now - then) / 1_000));
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const t = new Date(then);
  const mm = `${t.getMonth() + 1}`.padStart(2, "0");
  const dd = `${t.getDate()}`.padStart(2, "0");
  return t.getFullYear() === new Date(now).getFullYear() ? `${mm}-${dd}` : `${t.getFullYear()}-${mm}-${dd}`;
}

/** 列表行：「◆ 标题 · 相对时间」（sessions.ts 列表行同族形态；◆ = 索引行）。 */
export function renderBrowserList(entries: BrowserEntry[], now: number): string[] {
  return entries.map(e => `${e.isIndex ? "◆" : " "} ${e.title} · ${relativeTime(e.updatedAtMs, now)}`);
}

/** 正文读取：MEMORY.md 本体或笔记原文；basename 防穿越。 */
export function browserBody(memoryDir: string, file: string): string | undefined {
  if (file !== basename(file) || !file.endsWith(".md")) return undefined;
  try { return readFileSync(join(memoryDir, file), "utf8"); } catch { return undefined; }
}
