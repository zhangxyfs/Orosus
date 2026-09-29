import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "smol-toml";
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

/** CM-11 转义（subagent 版整体搬入升级——并一份时吸收；值来自网络返回如模型名，不设防即注入面）：
 *  引号/反斜杠/换行/制表/其余控制字符全部转出 TOML 合法形态（\uXXXX），不产出多行。 */
// oxlint-disable-next-line no-control-regex -- 转义件的职责就是匹配控制字符，非误用
const tomlEscape = (v: string): string => v.replace(/["\\\n\r\t\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (c) => {
  if (c === '"') return '\\"';
  if (c === "\\") return "\\\\";
  if (c === "\n") return "\\n";
  if (c === "\r") return "\\r";
  if (c === "\t") return "\\t";
  return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
});

const serialize = (v: Exclude<SectionValue, null>): string => {
  if (typeof v === "string") return `"${tomlEscape(v)}"`;
  if (Array.isArray(v)) return `[${v.map((x) => `"${tomlEscape(x)}"`).join(", ")}]`;
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
  // CM-01 拒写纪律（tuiSidebarPersist 原语义，收口时继承）：文件在但整文件 parse 失败 = 读不懂的盘——
  // 写入也不生效（加载层 SW-20 会跳过整层）还会动用户的坏文件，宁丢这次写。parse 仅作健康检查，
  // 回写仍走原行（保注释——与 stringify 重写的毁配置风险无关）。
  if (raw !== "") {
    try {
      parse(raw);
    } catch {
      return;
    }
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
