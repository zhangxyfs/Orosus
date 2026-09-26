import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 工种文件加载器（M4.5 T3 / 决策 8-9）：定义一类子代理的说明书——markdown 文件，
 * 头部几行 YAML frontmatter（name/description 必填；tools/disallowedTools/model/maxTurns/writePaths 选填），
 * 正文 = 给它看的系统提示词。
 *
 * 放哪里（决策 9 已拍板，四级优先级同名覆盖）：
 *   项目 `<项目>/.orosus/agents/`（品牌，最高）> 项目 `<项目>/.agents/agents/`（通用）
 *   > 用户 `~/.orosus/agents/`（品牌）> 用户 `~/.agents/agents/`（通用）。
 * 「品牌 + 通用双目录」照 kimi 模式——通用目录让一份工种文件被多个工具共用。
 *
 * YAML 解析是自写子集（不新增第三方依赖）：只认单行 `key: value` 与紧随的 `- 条目` 列表——
 * 工种文件七键全在这个子集内；超出子集的行报错（fail-closed，不静默丢字段）。
 */

/** 工种文件解析产物（spawn 请求的数据源——字段与 SubagentSpawnRequest 对齐）。 */
export interface RoleFile {
  /** 工种名（kebab-case——派活工具的 role 参数引用它）。 */
  name: string;
  /** 一句话说明（菜单/列表展示）。 */
  description: string;
  /** 工具白名单（模块全名；只能减不能加——不在主对话工具面里的名字无效）。 */
  tools?: string[];
  /** 工具黑名单（从白名单之外再减）。 */
  disallowedTools?: string[];
  /** 模型（三来源之一：settings > 工种 > 父）。 */
  model?: string;
  /** 轮数上限（有效值 = min(此值, 40)）。 */
  maxTurns?: number;
  /** 写路径报备（决策 24①——工种预声明，spawn 显式给的以 spawn 为准）。 */
  writePaths?: string[];
  /** 正文 = 系统提示词主体。 */
  prompt: string;
  /** 来源文件绝对路径（诊断与显示用）。 */
  source: string;
}

/** 工种目录组（四级——按优先级从高到低排列；同名后加载的被先加载的压住）。 */
export interface RoleDirs {
  projectBrand: string;
  projectGeneric: string;
  userBrand: string;
  userGeneric: string;
}

/** 缺省目录组（决策 9）：项目品牌 .orosus/agents > 项目通用 .agents/agents > 用户品牌 ~/.orosus/agents > 用户通用 ~/.agents/agents。 */
export function defaultRoleDirs(cwd: string, home: string): RoleDirs {
  return {
    projectBrand: join(cwd, ".orosus", "agents"),
    projectGeneric: join(cwd, ".agents", "agents"),
    userBrand: join(home, ".orosus", "agents"),
    userGeneric: join(home, ".agents", "agents"),
  };
}

export type ParseResult = RoleFile | { error: string };

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 剥引号（单双都认）；不闭合的引号按原文返回（fail-closed 由键校验兜住）。 */
const unquote = (v: string): string => {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
};

/** YAML 子集解析：`key: value` 单行标量 + 紧随 key 的 `- 条目` 列表（缩进不敏感、空行与整行注释跳过）。 */
function parseFrontmatter(fm: string, file: string): Record<string, string | string[]> | { error: string } {
  const out: Record<string, string | string[]> = {};
  const lines = fm.split(/\r?\n/);
  let currentListKey: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("- ")) {
      if (currentListKey === undefined) {
        return { error: `${file}：frontmatter 列表项出现在任何键之前（"${line}"）` };
      }
      const item = unquote(line.slice(2));
      if (item === "") return { error: `${file}：frontmatter 列表项为空串（${currentListKey}）` };
      const cur = out[currentListKey];
      if (Array.isArray(cur)) cur.push(item);
      else return { error: `${file}：键 "${currentListKey}" 先给了标量又给列表` };
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (m === null) return { error: `${file}：frontmatter 行不认识（"${line}"）——只认 "key: value" 与 "- 条目" 列表` };
    const key = m[1]!;
    const value = m[2]!.trim();
    if (value === "") {
      out[key] = []; // 空值 = 列表开头（待 "- 条目" 填充；若最终仍空数组则键校验报错）
      currentListKey = key;
    } else {
      out[key] = unquote(value);
      currentListKey = undefined;
    }
  }
  return out;
}

/** 解析单个工种文件文本（文件不存在/读失败由调用方处理；本函数纯文本进出）。 */
export function parseRoleFile(text: string, file: string): ParseResult {
  const normalized = text.replace(/^\uFEFF/, ""); // Windows 配置文件默认带 BOM——解析前必须剥
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (m === null) return { error: `${file}：缺 frontmatter（须以 --- 开头的 YAML 头 + 收口 ---，正文随后）` };
  const fm = parseFrontmatter(m[1]!, file);
  if ("error" in fm) return { error: (fm as { error: string }).error };
  const prompt = normalized.slice(m[0].length).trim();
  if (prompt === "") return { error: `${file}：正文为空——正文就是工种的系统提示词` };

  const name = fm.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return { error: `${file}：name 必填且须 kebab-case（小写字母数字与连字符）` };
  }
  const description = fm.description;
  if (typeof description !== "string" || description.trim() === "") {
    return { error: `${file}：description 必填（一句话说明，列表展示用）` };
  }

  const strList = (key: string): string[] | { error: string } => {
    const v = fm[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length === 0) return { error: `${file}：${key} 须为非空列表（- 条目）` };
    return v;
  };
  const tools = strList("tools");
  if ("error" in tools) return tools;
  const disallowedTools = strList("disallowedTools");
  if ("error" in disallowedTools) return disallowedTools;
  const writePaths = strList("writePaths");
  if ("error" in writePaths) return writePaths;

  let maxTurns: number | undefined;
  if (fm.maxTurns !== undefined) {
    if (typeof fm.maxTurns !== "string" || !/^\d+$/.test(fm.maxTurns) || Number(fm.maxTurns) < 1) {
      return { error: `${file}：maxTurns 须为正整数（得到 ${String(fm.maxTurns)}）` };
    }
    maxTurns = Number(fm.maxTurns);
  }
  let model: string | undefined;
  if (fm.model !== undefined) {
    if (typeof fm.model !== "string" || fm.model === "") return { error: `${file}：model 须为非空字符串` };
    model = fm.model;
  }

  return {
    name,
    description: description.trim(),
    prompt,
    source: file,
    ...(tools.length > 0 ? { tools } : {}),
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    ...(writePaths.length > 0 ? { writePaths } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

export interface LoadRolesResult {
  /** 工种名 → 文件（四级优先级同名覆盖后的胜者）。 */
  roles: Map<string, RoleFile>;
  /** 坏文件与同目录撞名（不炸整目录——逐条收集）。 */
  warnings: string[];
}

/** 扫四个目录加载全部工种（.md 文件；目录不存在 = 跳过）。
 *  优先级实现 = 加载顺序反着来：先通用后品牌、先用户后项目——同名后到先到都进 Map，但**高优先级目录
 *  后加载**，天然覆盖低优先级同名（决策 9：项目 .orosus > 项目 .agents > 用户 .orosus > 用户 .agents）。 */
export function loadRoles(dirs: RoleDirs): LoadRolesResult {
  const roles = new Map<string, RoleFile>();
  const warnings: string[] = [];
  // 从低到高：用户通用 → 用户品牌 → 项目通用 → 项目品牌（高级后加载，同名覆盖低级——决策 9 优先级）
  const ordered: string[] = [dirs.userGeneric, dirs.userBrand, dirs.projectGeneric, dirs.projectBrand];
  for (const dir of ordered) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue; // 目录不存在 = 该级缺席（正常态）
    }
    for (const f of files) {
      const file = join(dir, f);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (err) {
        warnings.push(`工种文件读失败：${file}（${err instanceof Error ? err.message : String(err)}）`);
        continue;
      }
      const parsed = parseRoleFile(text, file);
      if ("error" in parsed) {
        warnings.push(parsed.error);
        continue;
      }
      const existing = roles.get(parsed.name);
      if (existing !== undefined && dirname(existing.source) === dir) {
        warnings.push(`同目录撞名：${parsed.name}（${existing.source} 先入，${file} 被忽略）`);
        continue; // 同级同目录内先者（文件名排序）胜——跨级覆盖才是特性，不告警
      }
      roles.set(parsed.name, parsed);
    }
  }
  return { roles, warnings };
}
