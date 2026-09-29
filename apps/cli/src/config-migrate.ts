import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 存量迁移（m4-8 T2 / D1 拍板:自动搬）：config.toml 里命中白名单的模块节整节剪到 modules.d/<名>.toml。
 * 规则:
 *  - 白名单 = 内置模块 + 已挂载第三方模块名（调用方喂;不认识的节留守——防误搬用户自定义数据）;
 *  - 含 source 键的模块节整体留守（D4:「宿主怎么找模块」归 config.toml,discover 只认 projectFile）;
 *  - 搬前整文件备份 config.toml.bak（幂等:二次运行无节可搬,不再覆盖 .bak）;
 *  - 行级剪切保注释与 EOL 风格（不 stringify 重写——留守节的注释与键序不动）;
 *  - 节前紧邻的专属注释行（连续 # 行,中间无空行）随节搬走;顶层与留守节注释保留。
 * 环境开关 OROSUS_NO_MIGRATE（任何非空值 = 关）在调用方判定——本函数纯文件操作,便于测试密封。
 */

export interface MigrateResult {
  moved: string[];
  backup?: string;
}

/** 剥 UTF-8 BOM(Windows PowerShell 5.1 / 旧记事本会写,smol-toml 拒收——读侧同款纪律)。 */
const stripBom = (raw: string): string => raw.replace(/^\uFEFF/, "");

/** 段 = [注释行…][空行…][节头 … 直到下一节头/EOF]。切段用,不解析内容。 */
interface Segment {
  headComment: string[]; // 段顶连续注释行(其后紧跟空行再节头的算「专属注释」)
  blank: string[]; // 注释与节头间的空行(格式的一部分)
  body: string[]; // 节头行起(含节头)到段尾
  section: string | null; // 节名;顶层段(文件首到首个节头)= null
}

const SECTION_RE = /^\s*\[\s*([^\]#]+?)\s*\]/;

function segmentLines(lines: string[]): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment = { headComment: [], blank: [], body: [], section: null };
  let inComment = true; // 顶层段开头允许注释
  let seenSection = false;
  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m !== null) {
      if (seenSection || cur.body.length > 0 || cur.headComment.length > 0 || cur.blank.length > 0) segs.push(cur);
      cur = { headComment: [], blank: [], body: [line], section: m[1]! };
      seenSection = true;
      inComment = false;
      continue;
    }
    if (inComment && line.trim().startsWith("#")) {
      cur.headComment.push(line);
      continue;
    }
    if (line.trim() === "") {
      // 注释后、节头前的空行归 blank(专属注释跟随);节体内空行归 body
      if (inComment && cur.headComment.length > 0 && cur.body.length === 0 && !seenSection) cur.blank.push(line);
      else if (!seenSection && cur.body.length === 0 && cur.headComment.length === 0) cur.blank.push(line); // 文件头空行
      else cur.body.push(line);
      continue;
    }
    inComment = false;
    cur.body.push(line);
  }
  segs.push(cur);
  return segs;
}

/** 留守节（§3.5，真机踩中补钉 2026-09-29）：approval/compaction 是内置模块但配置属宿主安全/行为，
 *  provider-custom 是端点家底——三者及其子节（点分名第一段命中）永不进 modules.d。
 *  白名单（内置模块名）与留守清单有交集，迁移判定必须先过留守排除。 */
export const STAY_SECTIONS = ["tui", "approval", "compaction", "provider-custom"];

const isStaySection = (section: string): boolean => {
  const head = section.split(".")[0]!;
  return STAY_SECTIONS.includes(head);
};

export function migrateModulesSections(configPath: string, modulesDir: string, knownModuleNames: string[]): MigrateResult {
  if (!existsSync(configPath)) return { moved: [] };
  const raw = stripBom(readFileSync(configPath, "utf8"));
  if (raw === "") return { moved: [] };
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = raw.endsWith("\n") || raw.endsWith("\r\n");
  const lines = raw.split(/\r?\n/);
  if (trailingNewline && lines[lines.length - 1] === "") lines.pop();
  const segs = segmentLines(lines);
  const known = new Set(knownModuleNames);
  const moved: string[] = [];
  const stay: string[] = [];
  const outFiles: Array<{ name: string; content: string }> = [];
  for (const seg of segs) {
    const name = seg.section;
    // 子节随父节同搬（真机踩中补钉：[tool-web.search] 按第一段 "tool-web" 判归属——与父节同文件，不留守成孤儿）
    const head = name === null ? null : name.split(".")[0]!;
    if (
      name !== null &&
      head !== null &&
      known.has(head) &&
      !isStaySection(name) &&
      !seg.body.some((l) => /^\s*source\s*=/.test(l))
    ) {
      moved.push(name);
      const bodyNoTail = [...seg.body];
      while (bodyNoTail.length > 0 && bodyNoTail[bodyNoTail.length - 1]!.trim() === "") bodyNoTail.pop(); // 段尾分隔空行不随节走
      outFiles.push({ name: head, content: [...seg.headComment, ...bodyNoTail].join(eol) });
    } else {
      stay.push(...seg.headComment, ...seg.blank, ...seg.body);
    }
  }
  if (moved.length === 0) return { moved: [] };
  const backup = `${configPath}.bak`;
  copyFileSync(configPath, backup);
  mkdirSync(modulesDir, { recursive: true });
  for (const f of outFiles) {
    const target = join(modulesDir, `${f.name}.toml`);
    const prev = existsSync(target) ? `${stripBom(readFileSync(target, "utf8")).replace(/\r?\n$/, "")}${eol}` : "";
    // 目标已存在(手放的同名文件)——追加节体(合并语义交给加载层,文件层面简单拼接)
    writeFileSync(target, `${prev}${f.content}${eol}`, "utf8");
  }
  // 原文件重写:去掉搬空段残留的连续空行(段间恒单空行分隔,文件尾保持原换行习惯)
  const kept: string[] = [];
  for (const l of stay) {
    if (l.trim() === "" && kept.length > 0 && kept[kept.length - 1]!.trim() === "") continue;
    kept.push(l);
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  writeFileSync(configPath, `${kept.join(eol)}${trailingNewline ? eol : ""}`, "utf8");
  return { moved, backup };
}
