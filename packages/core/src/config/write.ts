import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 统一写口（m4-8 §3.3，用户拍板「读写配置各一个专用代码文件」）：
 *  - writeSectionKey：行级节区感知写——同一段逻辑原在 module-toggle / subagent-settings / skill-settings
 *    三处复制（写第三份时就是照第二份抄的），在此并一份。行级而非 stringify 重写：保用户注释与键序
 *    （/model 写盘同教训）；行级写不 parse 整文件，坏 TOML 的其他行不动（CM-01 纪律的更强形态）。
 *  - sectionPath：路由——模块节 → modules.d/<名>.toml（不存在则建目录与带节头文件）；留守节 → 原 config。
 *  值序列化：字符串/字符串数组带引号，数值/布尔裸；null = 删键。
 */

type SectionValue = string | number | boolean | string[] | null;

const serialize = (v: Exclude<SectionValue, null>): string => {
  if (typeof v === "string") return `"${v}"`;
  if (Array.isArray(v)) return `[${v.map((x) => `"${x}"`).join(", ")}]`;
  return String(v);
};

const stripBom = (raw: string): string => raw.replace(/^\uFEFF/, "");
const SECTION_RE = /^\s*\[\s*([^\]#]+?)\s*\]/;

export function writeSectionKey(filePath: string, section: string, key: string, value: SectionValue): void {
  let raw = "";
  try {
    raw = stripBom(readFileSync(filePath, "utf8"));
  } catch {
    /* 缺文件从空起 */
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw === "" ? [] : raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && raw !== "") lines.pop(); // 尾空行写回时还原（末尾恒一个 eol）
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  let inSection = false;
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_RE.exec(lines[i]!);
    if (m !== null) {
      if (inSection) { insertAt = i; break; }
      inSection = m[1] === section;
    } else if (inSection && keyRe.test(lines[i]!)) {
      if (value === null) {
        lines.splice(i, 1); // 删键（键不在场分支到不了这里）
        writeFileSync(filePath, lines.join(eol) + eol, "utf8");
        return;
      }
      lines[i] = `${key} = ${serialize(value)}`;
      writeFileSync(filePath, lines.join(eol) + eol, "utf8");
      return;
    }
  }
  if (value === null) return; // 删键但键不在场——无操作
  if (inSection && insertAt === -1) insertAt = lines.length; // 目标节是最后一节——节尾插
  if (insertAt === -1) {
    // 节不存在——文件尾新建（前留空行隔开既有内容）
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push(`[${section}]`, `${key} = ${serialize(value)}`);
  } else {
    lines.splice(insertAt, 0, `${key} = ${serialize(value)}`);
  }
  writeFileSync(filePath, lines.join(eol) + eol, "utf8");
}

export interface SectionPathOpts {
  userConfig: string;
  modulesDir: string;
  isModule: (sectionName: string) => boolean;
}

/** 路由（§3.3）：模块节 → modules.d/<名>.toml（目录不存在建目录、文件不存在建带节头空节——
 *  后续 writeSectionKey 直接命中该节）；留守节 → 原 config 路径（不建文件——留守节总已有宿主）。 */
export function sectionPath(section: string, opts: SectionPathOpts): string {
  if (!opts.isModule(section)) return opts.userConfig;
  const target = join(opts.modulesDir, `${section}.toml`);
  if (!existsSync(target)) {
    mkdirSync(opts.modulesDir, { recursive: true });
    writeFileSync(target, `[${section}]\n`, "utf8");
  }
  return target;
}
