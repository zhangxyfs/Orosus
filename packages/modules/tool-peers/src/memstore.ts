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
  const s = title.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return s === "" ? "note" : s;   // CJK 全消 → note
}

export function noteFileName(title: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = `${now.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${now.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}-${slugify(title)}.md`;
}

export function noteBody(title: string, summary: string, content: string, type: "project" | "reference" = "project"): string {
  const t = typeof title === "string" ? oneLine(title) : "note";
  const s = typeof summary === "string" ? oneLine(summary) : "";
  const capped = content.length > BODY_MAX_CHARS
    ? `${content.slice(0, BODY_MAX_CHARS)}\n\n<!-- NOTE: body truncated at ${BODY_MAX_CHARS} chars on write. -->`
    : content;
  return `---\nname: ${t}\ndescription: ${s}\nmetadata:\n  type: ${type}\n---\n\n${capped}\n`;
}

export interface NoteMeta { file: string; title: string; summary: string; updatedAtMs: number }

/** frontmatter 剥取：name 行裸值（写入侧 oneLine 保证单行）。 */
const frontmatterField = (text: string, key: "name" | "description"): string | undefined => {
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
      notes.push({ file: name, title, summary: frontmatterField(text, "description") ?? "", updatedAtMs: statSync(file).mtimeMs });
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

export function writeNote(dir: string, title: string, summary: string, content: string, now: Date, type: "project" | "reference" = "project"): string {
  mkdirSync(dir, { recursive: true });
  // D25 写前查重：同标题（frontmatter name）更新原文件，不建重复
  const existing = listNotes(dir).find(n => n.title === oneLine(title));
  if (existing !== undefined) {
    atomicWrite(join(dir, existing.file), noteBody(title, summary, content, type));
    rebuildIndex(dir);
    return existing.file;
  }
  let file = noteFileName(title, now);
  for (let n = 2; existsSync(join(dir, file)); n++) file = noteFileName(title, now).replace(/\.md$/, `-${n}.md`);
  atomicWrite(join(dir, file), noteBody(title, summary, content, type));
  rebuildIndex(dir);
  return file;
}

export function readNote(dir: string, file: string): string | undefined {
  if (file !== basename(file) || !file.endsWith(".md") || file === "MEMORY.md") return undefined;   // 防穿越
  try { return readFileSync(join(dir, file), "utf8"); } catch { return undefined; }
}
