import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listNotes, rebuildIndex, slugify, writeNoteFile, type NoteType } from "./memstore.ts";

/** 五源导入件（m5-peers T6d，v3/v5 走查定案）：纯函数——探测/格式转换/标题去重/整理通道。
 *  导入 = 一次性搬运（D18，重复导入靠标题去重）；模型整理 = 依赖注入 llmStream（D20，默认关零 token）。 */

export interface SourceNote { title: string; summary: string; content: string; type: NoteType }
export interface MemorySource {
  id: "claude-code" | "zcode" | "qwen" | "codex" | "reasonix"; label: string; dir: string | undefined; count: number;
  /** 坑 3（m5-peers-import-fix T2）：全局源标注——仅 codex 恒 true（无项目维度，UI 侧显示「含所有项目的笔记」）。 */
  global?: boolean;
  /** D7 已导计数：给出 destDir 时每源算「源标题集 − 现有判重键」差集大小；0 = 已全部导入。 */
  newCount?: number;
}

/** git root → 目录段（cc/qwen 同款形态：`D:\develop\Orosus` → `D--develop-Orosus`——非字母数字逐字符替换为 -，
 *  冒号/分隔符各成一杠、不折叠；本仓桶名 D--develop-Orosus-524861ea 实形态吻合）。 */
const sanitizeRoot = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+|-+$/g, "");

/** Reasonix 当前 Go 版 WorkspaceSlug 复刻（上游 config/paths.go:568）：win 小写 + `/`、`\`、`:`
 *  全替换 `-`、255 字节封顶。**与 sanitizeRoot 折叠规则不同**（那个是非字母数字逐字符替换、不折叠端部）——
 *  两键算法各自对齐各自上游，勿混用。 */
const reasonixSlug = (p: string): string => {
  let s = (process.platform === "win32" ? p.toLowerCase() : p).replace(/[\\/:]/g, "-");
  while (Buffer.byteLength(s, "utf8") > 255) s = s.slice(0, -1);   // 255 字节封顶（上游同款）
  return s;
};

/** G7：Reasonix 实机 sha1 键——原始大小写 cwd（与 zcode 键的小写化预处理不同，各自对齐）。 */
export const sha1hex16 = (cwd: string): string => createHash("sha1").update(cwd).digest("hex").slice(0, 16);

/** ZCode 桶名键（detectSources 与 mirror.ts 镜像匹配共源——抽公共件防两处漂移）：
 *  `slugify(basename)-<sha256(小写 cwd)[:16]>`（小写化仅 win，2026-10-06 本机 sha256 实测形态）。 */
export function zcodeBucketKey(cwd: string): string {
  const cwdKey = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  const hash16 = createHash("sha256").update(cwdKey).digest("hex").slice(0, 16);
  return `${slugify(cwd.split(/[\\/]/).pop() ?? "project")}-${hash16}`;
}

/** 计数口径（mirror.ts 镜像扫描同款：跳 MEMORY.md 索引、只数 .md）。 */
export const countNotes = (dir: string | undefined): number => {
  if (dir === undefined || !existsSync(dir)) return 0;
  try { return readdirSync(dir).filter(n => n.endsWith(".md") && n !== "MEMORY.md").length; } catch { return 0; }
};

const dirIf = (dir: string): string | undefined => (existsSync(dir) ? dir : undefined);

/** 五源探测（D19，路径锚 = 九仓调研档；m5-peers-import-fix T2 勘误：qwen 小写候选 / Reasonix 双形态 /
 *  codex global / destDir 给出时算 newCount）：目录不存在 = dir undefined + count 0（页面标「未安装/0 条」）。
 *  Reasonix 双形态（D3）：sha1 实机形态优先、projects-slug（当前 Go 版）次之，任一命中即该源 dir。 */
export function detectSources(
  homes: { claude?: string; zcode?: string; qwen?: string; codex?: string; reasonix?: string },
  gitRoot: string,
  cwd: string,
  destDir?: string,
): MemorySource[] {
  const root = sanitizeRoot(gitRoot);
  const defs: { id: MemorySource["id"]; label: string; dir: string | undefined; global?: boolean }[] = [
    { id: "claude-code", label: "Claude Code", dir: dirIf(join(homes.claude ?? "", "projects", root, "memory")) },
    { id: "zcode", label: "ZCode", dir: dirIf(join(homes.zcode ?? "", "cli", "memories", "projects", zcodeBucketKey(cwd), "memory")) },
    // D8：qwen 目录键全小写（实机形态）——小写候选优先、原样次之（mac/Linux 不靠大小写不敏感碰运气）
    { id: "qwen", label: "qwen-code", dir: dirIf(join(homes.qwen ?? "", "projects", root.toLowerCase(), "memory")) ?? dirIf(join(homes.qwen ?? "", "projects", root, "memory")) },
    { id: "codex", label: "codex", dir: dirIf(join(homes.codex ?? "", "memories")), global: true },
    { id: "reasonix", label: "DeepSeek-Reasonix", dir: dirIf(join(homes.reasonix ?? "", "memory", sha1hex16(cwd))) ?? dirIf(join(homes.reasonix ?? "", "projects", reasonixSlug(cwd), "memory")) },
  ];
  return defs.map(s => ({
    ...s,
    count: countNotes(s.dir),
    ...(destDir !== undefined ? { newCount: sourceNewCount(s.dir, destDir) } : {}),
  }));
}

/** D7 已导计数：源标题集对 destDir 现有判重键（标题 ∪ source_name）的差集大小。 */
const sourceNewCount = (dir: string | undefined, destDir: string): number => {
  const existing = existingKeys(destDir);
  const titles = new Set(readSourceNotes(dir).map(n => n.title));
  let n = 0;
  for (const t of titles) if (!existing.has(t)) n++;
  return n;
};

/** frontmatter 剥取（五家共识形状：name/description/metadata.type——一事实一文件 + frontmatter，调研档差异轴一）。
 *  D13 四类直认：user/feedback/project/reference 原样保留（导入保真），未知/缺失仍归 project。 */
export function parseSourceNote(raw: string, fileName: string): SourceNote {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  let title = "", summary = "", type: NoteType = "project", body = raw;
  if (m !== null) {
    body = raw.slice(m[0].length);
    // 缩进感知（metadata.type 在子块——顶层与缩进行都认，首个命中胜）
    const field = (k: string): string | undefined => {
      const l = m[1]!.split("\n").find(x => x.trimStart().startsWith(`${k}:`));
      return l === undefined ? undefined : l.trimStart().slice(k.length + 1).trim();
    };
    title = field("name") ?? "";
    summary = field("description") ?? "";
    const rawType = field("type");
    type = rawType === "user" || rawType === "feedback" || rawType === "project" || rawType === "reference" ? rawType : "project";
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

/** 现有记忆的判重键全集：标题 ∪ source_name（走查十二-③——整理改英文题后原题仍算「已导入」）。 */
const existingKeys = (destDir: string): Set<string> => {
  const s = new Set<string>();
  for (const n of listNotes(destDir)) {
    s.add(n.title);
    if (n.sourceTitle !== undefined) s.add(n.sourceTitle);
  }
  return s;
};

export interface ImportResult { imported: number; skipped: number; notes: SourceNote[] }

/** 一次性搬运（D18）：与现有记忆按标题精确去重（已存在跳过并报数）；**逐条写文件（立即可见、
 *  中断不丢），全部写完 rebuildIndex 一次**（走查九-①——旧形态每条 writeNote 各重建一次索引）。 */
export function importNotes(destDir: string, sources: SourceNote[]): ImportResult {
  const existing = existingKeys(destDir);
  let imported = 0, skipped = 0;
  const landed: SourceNote[] = [];
  for (const n of sources) {
    if (existing.has(n.title)) { skipped++; continue; }
    existing.add(n.title);
    writeNoteFile(destDir, n.title, n.summary, n.content, n.type);
    imported++;
    landed.push(n);
  }
  if (imported > 0) rebuildIndex(destDir);   // 最后一次重建（走查九-①）
  return { imported, skipped, notes: landed };
}

/** 整理通道窄缝（btw-cmd llmStream 同族依赖注入——引导传宿主 h.llm().stream，模块侧将来传 ctx.llm.stream）。 */
export interface LlmStreamReq { system?: string; messages: { role: "user"; content: { kind: "text"; text: string }[] }[]; maxTokens?: number; signal?: AbortSignal }
export type LlmStream = (req: LlmStreamReq) => AsyncIterable<{ type: string; text?: string; kind?: string }>;

const ORGANIZE_SYSTEM = `You clean up one imported memory note. Three outputs:
1. title: a SHORT ENGLISH title (2-6 words, no dates) that names what the note is about — it becomes the file name.
2. description: one line (<= 60 chars, same language as the note content), NO dates.
3. content: rewrite the body ONLY where it is messy (verbatim-fine notes stay verbatim): never lose facts, tighten wording, fix structure (headings/lists/code fences).
Reply with ONLY a JSON object: {"title": "...", "description": "...", "content": "..."}. No prose, no markdown fence.`;

export type OrganizeProgress = (done: number, total: number, title: string) => void;

/** 单条整理（走查九-②：宿主逐条循环件——整理完一条立即落盘一个 .md）：
 *  返回整理后条目（内容/摘要被改）；失败/超时/解析坏 = undefined（调用方落原文）。
 *  signal.aborted 时直接 undefined（强停路径——Alt+C）。 */
export async function organizeNote(n: SourceNote, llm: LlmStream, signal?: AbortSignal): Promise<SourceNote | undefined> {
  let text = "";
  try {
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), 60_000);   // 单条 60s
    try {
      for await (const c of llm({
        system: ORGANIZE_SYSTEM,
        messages: [{ role: "user", content: [{ kind: "text", text: `# ${n.title}\n\n${n.content}` }] }],
        maxTokens: 4096,
        signal: ac.signal,
      })) {
        if (ac.signal.aborted) break;
        if (c.type === "text/delta" && typeof c.text === "string") text += c.text;
        else if (c.type === "finish" && c.kind === "error") { text = ""; break; }
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  } catch { text = ""; }
  if (signal !== undefined && signal.aborted) return undefined;
  const fence = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);   // 剥 markdown 栅栏
  let parsed: { title?: unknown; description?: unknown; content?: unknown } | undefined;
  try { parsed = JSON.parse(fence) as typeof parsed; } catch { parsed = undefined; }
  const newTitle = typeof parsed?.title === "string" && parsed.title.trim() !== "" ? parsed.title.trim() : undefined;
  const newDesc = typeof parsed?.description === "string" && parsed.description.trim() !== "" ? parsed.description.trim() : undefined;
  const newContent = typeof parsed?.content === "string" && parsed.content.trim() !== "" ? parsed.content.trim() : undefined;
  if (newTitle === undefined && newDesc === undefined && newContent === undefined) return undefined;
  return {
    title: newTitle ?? n.title,   // 走查十二-③：整理改英文短题（无日期）——文件名随 slugify(title) 与标题一致
    summary: newDesc ?? n.summary,
    content: newContent ?? n.content,   // 内容乱才动——模型没给 content 就保原文
    type: n.type,
  };
}

/** 模型整理（D20 走查八-③ + 走查九-①）：**逐条**内容优化 + 重写 description；
 *  进度**前置**（每条开始处理前先报——进度条先动、显示"正在整理第 N 条"）；
 *  llm 缺省 / 单条失败 = 该条原样降级；signal.aborted = 剩余条目原样返回（强停——已整理成果保留）。
 *  merged = 被修改条数。批量落盘路径（每条一文件 + 索引末次重建）在宿主 importWithOrganize。 */
export async function organizeNotes(notes: SourceNote[], llm?: LlmStream, onProgress?: OrganizeProgress, signal?: AbortSignal): Promise<{ notes: SourceNote[]; merged: number }> {
  if (llm === undefined || notes.length === 0) {
    for (const [i, n] of notes.entries()) onProgress?.(i + 1, notes.length, n.title);
    return { notes, merged: 0 };
  }
  const out: SourceNote[] = [];
  let merged = 0;
  let aborted = false;
  const isAborted = (): boolean => signal?.aborted === true;   // 闭包现读（TS 属性窄化不跨 await 重置）
  for (const [i, n] of notes.entries()) {
    onProgress?.(i + 1, notes.length, n.title);   // 前置：先推进度再处理数据（走查九-①）
    if (aborted || isAborted()) { out.push(n); continue; }   // 强停：剩余原样
    const organized = await organizeNote(n, llm, signal);
    if (organized !== undefined) { merged++; out.push(organized); }
    else out.push(n);
    if (isAborted()) aborted = true;
  }
  return { notes: out, merged };
}

/** 与现有记忆按标题比对，滤出将被新导入的条目（整理只花钱在新条上——已存在的照旧跳过）。 */
export function filterNewNotes(destDir: string, notes: SourceNote[]): SourceNote[] {
  const existing = existingKeys(destDir);
  return notes.filter(n => !existing.has(n.title));
}

/** 逐条导入单通道（走查十一：settings/引导共用——原 main.ts importWithOrganize 本体下沉）。
 *  机械档与整理档同一循环：**每条先报进度（前置——进度条先动）** → [organize 开启且 llm 在场才过模型]
 *  → **立即落盘一条**（中断不丢成果）→ **让一拍事件循环**（进度窗重绘可见——旧机械档整段同步，
 *  onProgress 没接 + 事件循环锁死 = 140 条全程「正在读取源记忆…」零反应、完成态进度条停在 0/140）。
 *  判重：已存在标题/源内同名互撞跳过（importNotes 同款语义）；整理改题后按 frontmatter source_name
 *  （源原题）判重——重复导入不重复进（走查十二-③）。
 *  强停（signal.aborted，走查十二-④）= **硬中断**：剩余条目不拷不落盘；正在整理中的那条若被取消也不落。 */
export async function importNotesProgressive(
  destDir: string,
  sources: SourceNote[],
  opts: { organize?: boolean; llm?: LlmStream; onProgress?: OrganizeProgress; signal?: AbortSignal } = {},
): Promise<{ imported: number; skipped: number; merged: number }> {
  const { organize = false, llm, onProgress, signal } = opts;
  const isAborted = (): boolean => signal?.aborted === true;   // 闭包现读（TS 属性窄化不跨 await 重置）
  const seen = new Set<string>();
  const fresh = filterNewNotes(destDir, sources).filter(n => {
    if (seen.has(n.title)) return false;   // 源内同名互撞——后到的计跳过（importNotes 同款）
    seen.add(n.title);
    return true;
  });
  let imported = 0;
  let merged = 0;
  for (const [i, n] of fresh.entries()) {
    onProgress?.(i + 1, fresh.length, n.title);   // 前置：先推进度再处理数据（走查九-①）
    if (isAborted()) break;   // 强停：剩余不拷贝不落盘（走查十二-④——旧形「原样落盘照常完成」被用户打回）
    const organized = organize && llm !== undefined ? await organizeNote(n, llm, signal) : undefined;
    if (isAborted() && organized === undefined) break;   // 整理中途被取消——本条不落盘
    const title = organized?.title ?? n.title;
    writeNoteFile(destDir, title, organized?.summary ?? n.summary, organized?.content ?? n.content, n.type,
      title !== n.title ? n.title : undefined);   // 改过题才留 source_name 原题（判重锚）
    imported++;
    if (organized !== undefined) merged++;
    await new Promise<void>(r => setImmediate(r));   // 让一拍——同步批会锁死事件循环、进度窗不重绘
  }
  if (imported > 0) rebuildIndex(destDir);   // 最后一次重建（走查九-①）
  return { imported, skipped: sources.length - fresh.length, merged };
}
