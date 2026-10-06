import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listNotes, slugify, writeNote } from "./memstore.ts";

/** 五源导入件（m5-peers T6d，v3/v5 走查定案）：纯函数——探测/格式转换/标题去重/整理通道。
 *  导入 = 一次性搬运（D18，重复导入靠标题去重）；模型整理 = 依赖注入 llmStream（D20，默认关零 token）。 */

export interface SourceNote { title: string; summary: string; content: string; type: "project" | "reference" }
export interface MemorySource { id: "claude-code" | "zcode" | "qwen" | "codex" | "reasonix"; label: string; dir: string | undefined; count: number }

/** git root → 目录段（cc/qwen 同款形态：`D:\develop\Orosus` → `D--develop-Orosus`——非字母数字逐字符替换为 -，
 *  冒号/分隔符各成一杠、不折叠；本仓桶名 D--develop-Orosus-524861ea 实形态吻合）。 */
const sanitizeRoot = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+|-+$/g, "");

const countNotes = (dir: string | undefined): number => {
  if (dir === undefined || !existsSync(dir)) return 0;
  try { return readdirSync(dir).filter(n => n.endsWith(".md") && n !== "MEMORY.md").length; } catch { return 0; }
};

const dirIf = (dir: string): string | undefined => (existsSync(dir) ? dir : undefined);

/** 五源探测（D19，路径锚 = 九仓调研档）：目录不存在 = dir undefined + count 0（页面标「未安装/0 条」）。 */
export function detectSources(
  homes: { claude?: string; zcode?: string; qwen?: string; codex?: string; reasonix?: string },
  gitRoot: string,
  cwd: string,
): MemorySource[] {
  const root = sanitizeRoot(gitRoot);
  const cwdKey = process.platform === "win32" ? cwd.toLowerCase() : cwd;   // ZCode hash 实测形态（2026-10-06 本机 sha256 验证）
  const hash16 = createHash("sha256").update(cwdKey).digest("hex").slice(0, 16);
  const zcodeSlug = `${slugify(cwd.split(/[\\/]/).pop() ?? "project")}-${hash16}`;
  const defs: { id: MemorySource["id"]; label: string; dir: string | undefined }[] = [
    { id: "claude-code", label: "Claude Code", dir: dirIf(join(homes.claude ?? "", "projects", root, "memory")) },
    { id: "zcode", label: "ZCode", dir: dirIf(join(homes.zcode ?? "", "cli", "memories", "projects", zcodeSlug, "memory")) },
    { id: "qwen", label: "qwen-code", dir: dirIf(join(homes.qwen ?? "", "projects", root, "memory")) },
    { id: "codex", label: "codex", dir: dirIf(join(homes.codex ?? "", "memories")) },
    { id: "reasonix", label: "DeepSeek-Reasonix", dir: dirIf(join(homes.reasonix ?? "", "projects", cwd.split(/[\\/]/).pop() ?? "", "memory")) },
  ];
  return defs.map(s => ({ ...s, count: countNotes(s.dir) }));
}

/** frontmatter 剥取（五家共识形状：name/description/metadata.type——一事实一文件 + frontmatter，调研档差异轴一）。 */
export function parseSourceNote(raw: string, fileName: string): SourceNote {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  let title = "", summary = "", type: "project" | "reference" = "project", body = raw;
  if (m !== null) {
    body = raw.slice(m[0].length);
    // 缩进感知（metadata.type 在子块——顶层与缩进行都认，首个命中胜）
    const field = (k: string): string | undefined => {
      const l = m[1]!.split("\n").find(x => x.trimStart().startsWith(`${k}:`));
      return l === undefined ? undefined : l.trimStart().slice(k.length + 1).trim();
    };
    title = field("name") ?? "";
    summary = field("description") ?? "";
    type = field("type") === "reference" ? "reference" : "project";
  }
  const bodyLines = body.split("\n").map(l => l.trim());
  if (title === "") {
    const h = bodyLines.find(l => l.startsWith("# "));
    title = h !== undefined ? h.slice(2).trim() : fileName.replace(/\.md$/, "");
  }
  if (summary === "") {
    const first = bodyLines.find(l => l !== "" && !l.startsWith("# "));
    summary = (first ?? "").slice(0, 80);   // 首个非空非标题行
  }
  return { title, summary, content: body.trim(), type };
}

/** 读一个源目录为 SourceNote 列表（跳 MEMORY.md / 坏文件跳行）。 */
export function readSourceNotes(dir: string | undefined): SourceNote[] {
  if (dir === undefined || !existsSync(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: SourceNote[] = [];
  for (const name of names) {
    if (!name.endsWith(".md") || name === "MEMORY.md") continue;
    try { out.push(parseSourceNote(readFileSync(join(dir, name), "utf8"), name)); } catch { /* 跳行 */ }
  }
  return out;
}

export interface ImportResult { imported: number; skipped: number; notes: SourceNote[] }

/** 一次性搬运（D18）：与现有记忆按标题精确去重（已存在跳过并报数）；写走 writeNote（同标题更新语义兜底 + 索引重建）。 */
export function importNotes(destDir: string, sources: SourceNote[]): ImportResult {
  const existing = new Set(listNotes(destDir).map(n => n.title));
  let imported = 0, skipped = 0;
  const landed: SourceNote[] = [];
  for (const n of sources) {
    if (existing.has(n.title)) { skipped++; continue; }
    existing.add(n.title);
    writeNote(destDir, n.title, n.summary, n.content, new Date(), n.type);
    imported++;
    landed.push(n);
  }
  return { imported, skipped, notes: landed };
}

/** 整理通道窄缝（btw-cmd llmStream 同族依赖注入——引导传宿主 h.llm().stream，模块侧将来传 ctx.llm.stream）。 */
export interface LlmStreamReq { system?: string; messages: { role: "user"; content: { kind: "text"; text: string }[] }[]; maxTokens?: number }
export type LlmStream = (req: LlmStreamReq) => AsyncIterable<{ type: string; text?: string; kind?: string }>;

const ORGANIZE_SYSTEM = `You clean up one imported memory note. Rewrite the body ONLY where it is messy (verbatim-fine notes stay verbatim): never lose facts, tighten wording, fix structure (headings/lists/code fences). Then write a one-line description (<= 60 chars, same language as the note) that best summarizes the RESULTING content.
Reply with ONLY a JSON object: {"description": "...", "content": "..."}. No prose, no markdown fence.`;

export type OrganizeProgress = (done: number, total: number, title: string) => void;

/** 模型整理（D20 走查八-③ 重定义）：**逐条**内容优化（乱才动、保事实）+ 按整理后内容**重写 description**；
 *  索引随落盘自动重建（writeNote 内建）。llm 缺省 / 单条失败 / 超时 / 解析坏 = 该条原样降级（不炸不丢），
 *  整理继续下一条。merged = 被修改（内容或摘要）的条数；onProgress 每条一步（进度条数据源）。 */
export async function organizeNotes(notes: SourceNote[], llm?: LlmStream, onProgress?: OrganizeProgress): Promise<{ notes: SourceNote[]; merged: number }> {
  if (llm === undefined || notes.length === 0) {
    for (const [i, n] of notes.entries()) onProgress?.(i + 1, notes.length, n.title);
    return { notes, merged: 0 };
  }
  const out: SourceNote[] = [];
  let merged = 0;
  for (const [i, n] of notes.entries()) {
    let text = "";
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60_000);   // 单条 60s——整理档整体可进度
      try {
        for await (const c of llm({
          system: ORGANIZE_SYSTEM,
          messages: [{ role: "user", content: [{ kind: "text", text: `# ${n.title}\n\n${n.content}` }] }],
          maxTokens: 4096,
        })) {
          if (c.type === "text/delta" && typeof c.text === "string") text += c.text;
          else if (c.type === "finish" && c.kind === "error") { text = ""; break; }
        }
      } finally { clearTimeout(timer); }
    } catch { text = ""; }
    const fence = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);   // 剥 markdown 栅栏
    let parsed: { description?: unknown; content?: unknown } | undefined;
    try { parsed = JSON.parse(fence) as typeof parsed; } catch { parsed = undefined; }
    const newDesc = typeof parsed?.description === "string" && parsed.description.trim() !== "" ? parsed.description.trim() : undefined;
    const newContent = typeof parsed?.content === "string" && parsed.content.trim() !== "" ? parsed.content.trim() : undefined;
    if (newDesc === undefined && newContent === undefined) {
      out.push(n);   // 整理失败原样降级
    } else {
      merged++;
      out.push({
        title: n.title,
        summary: newDesc ?? n.summary,
        content: newContent ?? n.content,   // 内容乱才动——模型没给 content 就保原文
        type: n.type,
      });
    }
    onProgress?.(i + 1, notes.length, n.title);
  }
  return { notes: out, merged };
}

/** 与现有记忆按标题比对，滤出将被新导入的条目（整理只花钱在新条上——已存在的照旧跳过）。 */
export function filterNewNotes(destDir: string, notes: SourceNote[]): SourceNote[] {
  const existing = new Set(listNotes(destDir).map(n => n.title));
  return notes.filter(n => !existing.has(n.title));
}
