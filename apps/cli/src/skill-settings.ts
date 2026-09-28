import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orosusHome } from "@orosus/contracts/home";
import { fg, dim } from "./theme.ts";
import { truncateToWidth, visibleWidth } from "./tui/width.ts";

/**
 * 技能设置（m4-7 T8/T9，原型图 2/3/4）：/settings →「技能」→ 列表页（全收口径——含停用与
 * disable-model-invocation 者，管理面与消费面口径分离）→ 详情页（五字段 + Alt + K 启停）。
 * 停用清单存 [skill] 节 disabled 数组键（D4 拍板——配置即持久，不新增文件）；
 * 行级节区感知写（subagent-settings / module-toggle 同款纪律：不洗注释与键序、保行尾风格、缺键删除）。
 */

/** catalog 行（消费面类型本地声明——圈地纪律；字段与 skill 模块 skill.catalog 服务对齐）。 */
export interface SkillCatalogRow {
  name: string;
  description: string;
  whenToUse?: string;
  layer: "user" | "project" | "bundled";
  source: string;
  file: string;
  disabled: boolean;
  modelInvocable: boolean;
}

/** 读 [skill] 节 disabled 数组键（缺文件/缺节/缺键/坏值 = 空表）。 */
export function readSkillDisabled(filePath = join(orosusHome(), "config.toml")): string[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return [];
  }
  const sectionRe = /^\s*\[\s*([^\]#]+?)\s*\]/;
  let inSection = false;
  for (const line of raw.split(/\r?\n/)) {
    const sm = line.match(sectionRe);
    if (sm !== null) {
      inSection = sm[1] === "skill";
      continue;
    }
    if (!inSection) continue;
    const km = line.match(/^\s*disabled\s*=\s*\[(.*)\]/);
    if (km === null) continue;
    return (km[1] ?? "").match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1)) ?? [];
  }
  return [];
}

/** 翻转停用态：增/删单名后整替 disabled 键（空表 = 删键回缺省态）；返回翻转后的停用态。 */
export function toggleSkillDisabled(name: string, filePath = join(orosusHome(), "config.toml")): boolean {
  const cur = readSkillDisabled(filePath);
  const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
  const nowDisabled = next.includes(name);
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    /* 缺文件从空起 */
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw === "" ? [] : raw.split(/\r?\n/);
  const sectionRe = /^\s*\[\s*([^\]#]+?)\s*\]/;
  const kvLine = next.length === 0 ? null : `disabled = [${next.map((n) => `"${n}"`).join(", ")}]`;
  let inSection = false;
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(sectionRe);
    if (m !== null) {
      if (inSection) { insertAt = i; break; }
      inSection = m[1] === "skill";
    } else if (inSection && /^\s*disabled\s*=/.test(lines[i]!)) {
      if (kvLine === null) {
        lines.splice(i, 1); // 空表删键（回缺省态）
        i--;
      } else {
        lines[i] = kvLine; // 整替（数组键无部分编辑）
      }
      writeFileSync(filePath, lines.join(eol), "utf8");
      return nowDisabled;
    }
  }
  if (kvLine === null) return nowDisabled; // 删空（键本就不在）
  if (inSection && insertAt === -1) insertAt = lines.length; // 目标节是最后一节
  if (insertAt === -1) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push("[skill]", kvLine);
  } else {
    lines.splice(insertAt, 0, kvLine);
  }
  writeFileSync(filePath, lines.join(eol), "utf8");
  return nowDisabled;
}

/** 范围三值映射（原型图 3 要点：括号内文字照写，禁缩写）。 */
export function skillScopeLabel(layer: SkillCatalogRow["layer"]): string {
  if (layer === "user") return "个人（用户级）";
  if (layer === "project") return "所有人（项目级）";
  return "内置（出厂自带）";
}

/** 词原子截断（m4-7 走查修 2026-09-27 用户拍板「显示不下就在最后 …」）：在词边界截断加省略号——
 *  CJK 单字原子、ASCII 词/路径段整词不劈半；预算留 1 列给 …。 */
export function truncateAtWord(text: string, w: number): string {
  if (visibleWidth(text) <= w) return text;
  if (w < 4) return truncateToWidth(text, w);
  const atoms = text.match(/[A-Za-z0-9_./\\:-]+|\s|[^\sA-Za-z0-9_./\\:-]/g) ?? [];
  let cur = "";
  let curW = 0;
  let last = ""; // 最后一个以非空白收尾的完整串
  for (const a of atoms) {
    const aw = [...a].reduce((n, ch) => n + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0); // 初值 0 必带——缺省时首字符当累加器（字符串拼接，宽全乱）
    if (curW + aw > w - 1) break;
    cur += a;
    curW += aw;
    if (!/\s$/.test(cur)) last = cur; // /\s*$/ 零宽恒真——必须 /\s$/（末尾恰一个空白才排除该累积态）
  }
  return last === "" ? truncateToWidth(text, w) : `${last}…`;
}

/** 列表页行（原型图 2）：三列——名（左）/描述（中，词原子截断）/状态（右，「停用」灰、「启用」常规色）。
 *  w = 宿主从 pickRowWidth() 拿的行可用宽（左栏内宽——拼行与 pick 渲染同源，防超宽推错右框）。
 *  描述列灰（2026-09-28 用户拍板：子界面与斜杠主菜单同形——标题白、简单说明灰）。 */
export function skillListRow(w: number, row: SkillCatalogRow): string {
  const status = row.disabled ? fg("muted", "停用") : fg("accent", "启用"); // 启用绿/停用灰（2026-09-27 用户走查拍板）
  const statusW = 4; // 启用/停用两字（ANSI 不占宽）
  const nameW = Math.min(20, Math.max(8, Math.floor((w - statusW - 4) / 3)));
  const name = row.name.length > nameW ? `${row.name.slice(0, nameW - 1)}…` : row.name.padEnd(nameW);
  const descW = w - 8 - nameW; // 行首 1 + 名后 1 + 状态前 ≥1 空隙 + 状态 4 + 冗余 1——描述预算扣足保证行宽 = w−1
  const desc = descW >= 6 ? dim(truncateAtWord(row.description.split("\n")[0] ?? "", descW)) : "";
  const leftW = 1 + nameW + (desc === "" ? 0 : 1 + visibleWidth(desc));
  const gap = Math.max(1, w - 1 - leftW - statusW);
  return ` ${name}${desc === "" ? "" : ` ${desc}`}${" ".repeat(gap)}${status}`;
}

/** 详情页文本（原型图 3 + m4-7 走查修 2026-09-27 用户拍板）：五字段竖排——名称/描述/范围/状态/文件；
 *  值超宽不折行、词原子截断末尾加 …（截断值是纯文本——ANSI 标签不进宽计算）。
 *  底部键位行由 viewText keys 的 label 自动显示（Alt + K 启用或停用 · Esc 关闭=返回列表）。 */
export function skillDetailText(w: number, row: SkillCatalogRow): string {
  const label = (s: string) => `${fg("muted", s)}    `; // 标签两字 + 4 空格（标签列 8 列，原型图 3 形态）
  const field = (name: string, value: string): string => `${label(name)}${truncateAtWord(value, w - 2 - 8)}`;
  return [
    field("名称", row.name),
    field("描述", row.description === "" ? "（无描述）" : row.description),
    field("范围", skillScopeLabel(row.layer)),
    field("状态", row.disabled ? "停用" : "启用"),
    field("文件", row.file),
  ].join("\n");
}
