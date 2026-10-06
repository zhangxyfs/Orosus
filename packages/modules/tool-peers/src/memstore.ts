import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** 索引护栏（D5）：200 行 / 25,000 字符——与 promptSection 单段帽（activate.ts:470）同单位同判据（字符判定）。 */
const INDEX_MAX_LINES = 200;
const INDEX_MAX_CHARS = 25_000;
/** 单笔记正文帽（spec §8）：32KB 截断附提示。 */
const BODY_MAX_CHARS = 32_000;
const INDEX_WARNING = `\n<!-- WARNING: index truncated at ${INDEX_MAX_LINES} lines / ${INDEX_MAX_CHARS} chars — read notes directly for the full picture. -->`;

const atomicWrite = (file: string, text: string): void => {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

export function slugify(title: string): string {
  // 走查十二-③：CJK 保留（\p{L}\p{N}）——旧 [^a-z0-9-] 把中文全消成 note，140 条中文记忆全叫 note-2/note-3…
  const s = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return s === "" ? "note" : s;   // 纯符号标题兜底
}

/** 走查十二-③：文件名 = slugify(标题)——与标题一致；**不带日期前缀**（当前日期无意义，排序走 mtime）。 */
export function noteFileName(title: string): string {
  return `${slugify(title)}.md`;
}

export function noteBody(title: string, summary: string, content: string, type: "project" | "reference" = "project", sourceTitle?: string): string {
  const t = typeof title === "string" ? oneLine(title) : "note";
  const s = typeof summary === "string" ? oneLine(summary) : "";
  const capped = content.length > BODY_MAX_CHARS
    ? `${content.slice(0, BODY_MAX_CHARS)}\n\n<!-- NOTE: body truncated at ${BODY_MAX_CHARS} chars on write. -->`
    : content;
  // source_name = 导入源的原题（走查十二-③：模型整理会改英文标题——原题留档，重复导入按它判重不重复进）
  const src = sourceTitle !== undefined && sourceTitle !== t ? `source_name: ${oneLine(sourceTitle)}\n` : "";
  return `---\nname: ${t}\n${src}description: ${s}\nmetadata:\n  type: ${type}\n---\n\n${capped}\n`;
}

export interface NoteMeta { file: string; title: string; summary: string; updatedAtMs: number; sourceTitle: string | undefined }

/** frontmatter 剥取：name 行裸值（写入侧 oneLine 保证单行）。 */
const frontmatterField = (text: string, key: "name" | "description" | "source_name"): string | undefined => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (m === null) return undefined;
  const line = m[1]!.split("\n").find(l => l.startsWith(`${key}:`));
  return line === undefined ? undefined : line.slice(key.length + 1).trim();
};

export function listNotes(dir: string): NoteMeta[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const notes: NoteMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(".md") || name === "MEMORY.md") continue;
    const file = join(dir, name);
    try {
      const text = readFileSync(file, "utf8");
      const fmName = frontmatterField(text, "name");
      let title = fmName ?? "";
      if (title === "") {
        const h = text.split("\n").find(l => l.startsWith("# "));
        title = h !== undefined ? h.slice(2).trim() : name.replace(/\.md$/, "");
      }
      notes.push({ file: name, title, summary: frontmatterField(text, "description") ?? "", updatedAtMs: statSync(file).mtimeMs, sourceTitle: frontmatterField(text, "source_name") });
    } catch { /* 坏文件跳行 */ }
  }
  // mtime 新到旧；同毫秒 tie 按文件名稳定序（防同批写 flaky）
  notes.sort((a, b) => b.updatedAtMs - a.updatedAtMs || (a.file < b.file ? -1 : 1));
  return notes;
}

export function buildIndex(notes: NoteMeta[]): string {
  const lines = notes.map(n => `- [${n.title}](${n.file}) — ${n.summary}`);
  return `# Memory Index\n\n${lines.join("\n")}\n`;
}

export function truncateIndex(text: string): { text: string; truncated: boolean } {
  let out = text;
  let truncated = false;
  const all = out.split("\n");
  if (all.length > INDEX_MAX_LINES) {
    out = all.slice(0, INDEX_MAX_LINES).join("\n");
    truncated = true;
  }
  if (out.length > INDEX_MAX_CHARS) {
    out = out.slice(0, INDEX_MAX_CHARS - INDEX_WARNING.length);
    truncated = true;
  }
  return truncated ? { text: `${out}${INDEX_WARNING}`, truncated } : { text: out, truncated };
}

export function rebuildIndex(dir: string): void {
  atomicWrite(join(dir, "MEMORY.md"), buildIndex(listNotes(dir)));
}

export function writeNote(dir: string, title: string, summary: string, content: string, type: "project" | "reference" = "project", sourceTitle: string | undefined = undefined): string {
  mkdirSync(dir, { recursive: true });
  // D25 写前查重：同标题（frontmatter name）更新原文件，不建重复
  const existing = listNotes(dir).find(n => n.title === oneLine(title));
  if (existing !== undefined) {
    atomicWrite(join(dir, existing.file), noteBody(title, summary, content, type, sourceTitle));
    rebuildIndex(dir);
    return existing.file;
  }
  let file = noteFileName(title);
  for (let n = 2; existsSync(join(dir, file)); n++) file = noteFileName(title).replace(/\.md$/, `-${n}.md`);
  atomicWrite(join(dir, file), noteBody(title, summary, content, type, sourceTitle));
  rebuildIndex(dir);
  return file;
}

/** 单文件写（走查九-①/② 批量路径件）：与 writeNote 同语义（查重/撞名 -2），但**不重建索引**——
 *  批量导入/整理逐条落盘用（每条一个 .md 立即可见、中断不丢），全部写完由调用方 rebuildIndex 一次。 */
export function writeNoteFile(dir: string, title: string, summary: string, content: string, type: "project" | "reference" = "project", sourceTitle: string | undefined = undefined): string {
  mkdirSync(dir, { recursive: true });
  const existing = listNotes(dir).find(n => n.title === oneLine(title));
  if (existing !== undefined) {
    atomicWrite(join(dir, existing.file), noteBody(title, summary, content, type, sourceTitle));
    return existing.file;
  }
  let file = noteFileName(title);
  for (let n = 2; existsSync(join(dir, file)); n++) file = noteFileName(title).replace(/\.md$/, `-${n}.md`);
  atomicWrite(join(dir, file), noteBody(title, summary, content, type, sourceTitle));
  return file;
}

export function readNote(dir: string, file: string): string | undefined {
  if (file !== basename(file) || !file.endsWith(".md") || file === "MEMORY.md") return undefined;   // 防穿越
  try { return readFileSync(join(dir, file), "utf8"); } catch { return undefined; }
}
