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

const ORGANIZE_SYSTEM = `You deduplicate and organize imported memory notes. Input: numbered list of "index. title — summary". Task: group notes that describe the SAME underlying fact or practice (different titles, same topic) and rewrite a one-line summary for each merged group.
Reply with ONLY a JSON array, one element per group: {"members":[indexes],"summary":"one-line merged summary"}. Single-note groups: {"members":[i]} (summary optional). Keep every index exactly once. No prose, no markdown fence.`;

/** 模型去重整理（D20，v5）：语义去重（标题不同但同主题合并）+ 摘要重写。
 *  llm 缺省 / 失败 / 超时 / 解析坏 = 原样返回（降级机械导入，零假设零炸）。合并正文 = 各成员依序拼接（模型不碰正文，防失真）。 */
export async function organizeNotes(notes: SourceNote[], llm?: LlmStream): Promise<{ notes: SourceNote[]; merged: number }> {
  if (llm === undefined || notes.length < 2) return { notes, merged: 0 };
  let text = "";
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      const list = notes.map((n, i) => `${i}. ${n.title} — ${n.summary}`).join("\n");
      for await (const c of llm({ system: ORGANIZE_SYSTEM, messages: [{ role: "user", content: [{ kind: "text", text: list }] }], maxTokens: 2000 })) {
        if (c.type === "text/delta" && typeof c.text === "string") text += c.text;
        else if (c.type === "finish" && c.kind === "error") { text = ""; break; }
      }
    } finally { clearTimeout(timer); }
  } catch { return { notes, merged: 0 }; }
  const fence = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);   // 剥 markdown 栅栏
  let groups: unknown;
  try { groups = JSON.parse(fence); } catch { return { notes, merged: 0 }; }
  if (!Array.isArray(groups)) return { notes, merged: 0 };
  const taken = new Set<number>();
  const out: SourceNote[] = [];
  let merged = 0;
  for (const g of groups) {
    const members = Array.isArray((g as { members?: unknown }).members)
      ? ((g as { members: unknown[] }).members as unknown[]).filter(x => typeof x === "number" && Number.isInteger(x) && x >= 0 && x < notes.length && !taken.has(x)) as number[]
      : [];
    const newSummary = typeof (g as { summary?: unknown }).summary === "string" ? ((g as { summary: string }).summary).trim() : "";
    if (members.length === 0) continue;
    for (const i of members) taken.add(i);
    const parts = members.map(i => notes[i]!);
    if (members.length > 1) {
      merged++;
      out.push({
        title: parts[0]!.title,
        summary: newSummary !== "" ? newSummary : parts.map(p => p.summary).join("; ").slice(0, 120),
        content: parts.map(p => `## ${p.title}\n\n${p.content}`).join("\n\n"),
        type: parts[0]!.type,
      });
    } else {
      out.push(newSummary !== "" ? { ...parts[0]!, summary: newSummary } : parts[0]!);
    }
  }
  for (const [i, n] of notes.entries()) if (!taken.has(i)) out.push(n);   // 模型漏掉的条目原样补尾不丢
  return { notes: out, merged };
}
