import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { orosusHome } from "@orosus/contracts/home";
import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { Access, defineTool, type Tool } from "@orosus/contracts/tool";

/**
 * skill 模块（M2 T17 最小版 → m4-7 升级为九仓标准形态）：
 * 扫描五轨目录（弱→强：bundled 内置轨〔模块自带 bundled/ 随包分发，垫底——用户/项目同名可覆盖出厂件，
 * m4-7 T11〕→ ~/.agents/skills → ~/.orosus/skills → 项目 .agents 逐层 → 项目根 .orosus；
 * 后入表者胜 = 项目压用户〔随仓库分发的技能对齐协作者环境〕+ 品牌压通用〔用户亲手放自家目录的优先〕）。
 * 每子目录一个 SKILL.md（YAML frontmatter 手写 key: value 行解析；name 必需，
 * description（缺省空串）/when_to_use 简单说明/disable-model-invocation 可选——m4-7 T2；未知键丢弃，宽松派）。
 * 贡献：promptSection（可用技能摘要，order 0 区，4000 字符预算超限降级仅名——T3）+
 * 工具 skill__load（读全文；执行时重扫 + 运行时去重——T4）+ 服务 skill.catalog / skill.resetLoaded
 * （宿主斜杠菜单与 /settings 管理面 / compact 后去重集重置——服务倒挂先例 websearch:endpoints）
 * + 具名导出 seedBundledSkills（引导弹出时刻出厂件固化到 ~/.orosus/skills——宿主首启接线）。
 * m5-skill-trigger（2026-10-03）：清单头时序令 + when_to_use 进条目 + 工具描述强制令/反向令 + 禁调
 * 调用侧拒绝 + 运行期消息英文化——五件新文本全为模型可见面，依该方案 §四语言拍板统一英文（自创值
 * 登记造册位）；UI 元素名（/settings、技能 tab、Alt + K）按屏幕实显专名保留不译。
 */

interface Skill {
  name: string;
  description: string;
  body: string;
  file: string;
  layer: "user" | "project" | "bundled"; // 详情页「范围」三值（m4-7 T11 扩 bundled）
  source: "orosus" | "agents" | "bundled"; // 详情页来源展示（agents = .agents 互操作目录）
  whenToUse?: string;
  disableModelInvocation: boolean;
}

const parseFrontmatter = (raw: string): Omit<Skill, "file" | "layer" | "source"> | undefined => {
  // MI-10 修复（2026-09-28 code review P2）：`\r?` 容忍 CRLF——Windows/别家工具写进来的 SKILL.md（首行实为
  // `---\r\n`）旧正则整体不匹配 → 技能静默从清单消失（主打 .agents 互操作生态的模块不能只认 LF）。
  // 行内 `trim()` 已兜字段尾的 `\r`，body 原样透传。
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (m === null) return undefined;
  const [, head, body] = m;
  const fields = new Map<string, string>();
  for (const line of (head ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const name = fields.get("name");
  const description = fields.get("description") ?? "";
  if (name === undefined || name === "") return undefined;
  const whenToUse = fields.get("when_to_use");
  return {
    name,
    description,
    body: body ?? "",
    ...(whenToUse !== undefined && whenToUse !== "" ? { whenToUse } : {}),
    disableModelInvocation: fields.get("disable-model-invocation") === "true", // 值恰为 true 才算（dsh 同款）
  };
};

interface Track {
  dir: string;
  layer: Skill["layer"];
  source: Skill["source"];
}

/** 坏轨/坏条目告警口（MI-09）：scanSkills 逐层容错的观测面——activate 期抛出会按契约③把整个模块降级
 *  （五轨全丢：内置技能、清单段、load 工具一起消失），运行期抛出也会打断 catalog/load。 */
type ScanWarn = (code: string, msg: string, fields?: Record<string, unknown>) => void;

/** 扫描轨道入表（弱→强，后入表者胜）；目录不存在或条目缺 SKILL.md / name 自然跳过。
 *  MI-09 修复（2026-09-28 code review P2）：单轨/单条目级 try/catch——existsSync 为 true 但不可读
 *  （EACCES）、路径是文件而非目录（ENOTDIR）、SKILL.md 是目录（EISDIR）/读到一半被删（ENOENT）都只
 *  跳过该轨/该条并经 onWarn 报告；一处坏文件系统状态不再拖垮全部技能。 */
function scanSkills(tracks: Track[], onWarn?: ScanWarn): Skill[] {
  const byName = new Map<string, Skill>();
  for (const { dir, layer, source } of tracks) {
    let subs: string[];
    try {
      if (!existsSync(dir)) continue;
      subs = readdirSync(dir).sort();
    } catch (err) {
      onWarn?.("skill.track-scan-failed", `轨道目录不可读，跳过该轨：${dir}`, { dir, error: String(err) });
      continue;
    }
    for (const sub of subs) {
      const file = join(dir, sub, "SKILL.md");
      try {
        if (!existsSync(file)) continue;
        const parsed = parseFrontmatter(readFileSync(file, "utf8"));
        if (parsed === undefined) continue;
        byName.set(parsed.name, { ...parsed, file, layer, source });
      } catch (err) {
        onWarn?.("skill.entry-scan-failed", `技能文件不可读，跳过该条：${file}`, { file, error: String(err) });
        continue;
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 最近 .git 祖先 = 项目根（kimi 同款；worktree 的 .git 是文件也算）；无 .git 祖先 → start 自身兜底。 */
const gitRootOf = (start: string): string => {
  let cur = start;
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return start;
    cur = parent;
  }
};

/** [from, ..., to]（from 须为 to 的祖先或相等）——.agents 逐层链从根到 cwd，靠 cwd 者强（就近覆盖）。 */
const chainTo = (from: string, to: string): string[] => {
  const out: string[] = [];
  let cur = to;
  for (;;) {
    out.push(cur);
    if (cur === from) break;
    cur = dirname(cur);
  }
  return out.reverse();
};

/** 轨道表（弱→强）。项目 .agents 从 cwd 逐层向上到项目根（monorepo 子目录捡得到仓库根技能）；
 *  品牌目录 .orosus/skills 只认项目根本身与用户级（逐层出现多份品牌目录 = 同名多版本混乱，故意收窄）。 */
function skillTracks(cfg: {
  userAgentsDir: string;
  userOrosusDir: string;
  projectAgentsDirs: string[];
  projectOrosusDir: string;
  bundledDir?: string;
}): Track[] {
  return [
    ...(cfg.bundledDir !== undefined ? [{ dir: cfg.bundledDir, layer: "bundled" as const, source: "bundled" as const }] : []),
    { dir: cfg.userAgentsDir, layer: "user" as const, source: "agents" as const },
    { dir: cfg.userOrosusDir, layer: "user" as const, source: "orosus" as const },
    ...cfg.projectAgentsDirs.map((d) => ({ dir: d, layer: "project" as const, source: "agents" as const })),
    { dir: cfg.projectOrosusDir, layer: "project" as const, source: "orosus" as const },
  ];
}

/** 模块 config schema（m4-7 走查修 2026-09-27）：内核规则 = 模块未声明 schema 时拒收一切额外键——
 *  [skill] disabled 一写盘，skill 模块启动校验即失败（audit failed → 引导弹窗 degraded 冒出，用户实机踩中）。
 *  声明后按 z.object 缺省 strip 语义放行已知键（tool-subagent 同款纪律）。 */
export const configSchema = z.object({
  /** 停用清单（T6/D4）：宿主 /settings → 技能 Alt + K 写回；键缺席 = 无停用。 */
  disabled: z.array(z.string()).optional(),
  /** 测试注轨 / 高级覆盖：五轨目录显式指定（缺省 = 真实 home / git 根解析 / 包内 bundled）。 */
  userAgentsDir: z.string().optional(),
  userOrosusDir: z.string().optional(),
  projectAgentsDirs: z.array(z.string()).optional(),
  projectOrosusDir: z.string().optional(),
  bundledDir: z.string().optional(),
});

/** 第五轨内置目录（m4-7 T11）：skill 模块自带 bundled/ 随包分发（包根下，src 的上一级）——
 *  优先级垫底（低于 ~/.agents，skillTracks 首位），用户/项目同名技能可覆盖内置版（九仓惯例）。
 *  铁律（2026-10-01 用户拍板）：本目录只读——宁可出厂技能找不到（打包断链静默降级）也绝不向此
 *  目录落任何文件；一切拷贝单向流出（固化 targetDir 只会是用户目录），停用态写 config 不写这里。 */
const bundledSkillsDir = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "bundled");

/** 出厂技能固化（2026-10-01 拍板「引导弹出时把预置技能拷到 ~/.orosus/skills/」）：bundled/ 出厂件整目录
 *  拷入目标（宿主接线在引导弹窗弹出时刻——首启初始化即解除对 bundled 轨相对定位的路径依赖：打包布局
 *  变化会让 bundled 轨静默断链〔scanSkills 对缺失目录只 continue〕，固化后用户目录里的件不随打包走样）。
 *  同名 SKILL.md 已在目标 → 整技跳过（用户件优先，与轨道优先级同向；删掉固化件 bundled 原件重新浮出）；
 *  整目录拷（含 references/ 等附属件——skill__load 首行带 file 路径后相对路径按技能目录解析）；
 *  逐件容错（MI-09 同款纪律）：单件失败进 failed 不拖垮其余；源目录缺失/不可读 = 无件可固化，静默空回。 */
export function seedBundledSkills(
  targetDir: string = join(orosusHome(), "skills"),
  sourceDir: string = bundledSkillsDir(),
): { copied: string[]; skipped: string[]; failed: Array<{ name: string; error: string }> } {
  const copied: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  let subs: string[];
  try {
    if (!existsSync(sourceDir)) return { copied, skipped, failed };
    subs = readdirSync(sourceDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return { copied, skipped, failed };
  }
  for (const sub of subs) {
    try {
      if (!existsSync(join(sourceDir, sub, "SKILL.md"))) continue; // 与 scanSkills 同口径：缺 SKILL.md 的目录不是技能
      if (existsSync(join(targetDir, sub, "SKILL.md"))) {
        skipped.push(sub);
        continue;
      }
      cpSync(join(sourceDir, sub), join(targetDir, sub), { recursive: true });
      copied.push(sub);
    } catch (err) {
      failed.push({ name: sub, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { copied, skipped, failed };
}

/** 缺省目录解析（config 注入可全覆盖——测试注轨不走真实 home/cwd）。 */
function resolveDirs(cfg: z.infer<typeof configSchema> | undefined): {
  userAgentsDir: string;
  userOrosusDir: string;
  projectAgentsDirs: string[];
  projectOrosusDir: string;
  bundledDir: string;
} {
  const cwd = process.cwd();
  const root = gitRootOf(cwd);
  return {
    userAgentsDir: cfg?.userAgentsDir ?? join(homedir(), ".agents", "skills"),
    userOrosusDir: cfg?.userOrosusDir ?? join(orosusHome(), "skills"),
    projectAgentsDirs: cfg?.projectAgentsDirs ?? chainTo(root, cwd).map((d) => join(d, ".agents", "skills")),
    projectOrosusDir: cfg?.projectOrosusDir ?? join(root, ".orosus", "skills"),
    bundledDir: cfg?.bundledDir ?? bundledSkillsDir(),
  };
}

/** 清单段（T3；m5-skill-trigger 两改）：头句带时序强制令（英文——模型可见面依语言拍板）；条目 =
 *  description 拼上 when_to_use 后**合并**截 250（先拼后截共用一帽，cc 同款——清单只为发现，冗长
 *  说明白占每轮预算不涨缓存命中率）；段总预算 4000 字符，超限整段降级为仅技能名列表（ZCode 降级思路
 *  简化版——skill__load 按名加载，降级不带路径；降级头自带英文标记，不再借旧中文头的全角冒号 replace）。
 *  外层保险沿用 promptSection 单段 32KB 上限（activate.ts 既有纪律）。 */
const SKILL_DESC_LIMIT = 250;
const SKILL_SECTION_BUDGET = 4000;

function listingText(listed: Skill[]): string {
  const head = "The following skills are available for use with the skill__load tool. If the user names a skill, or the task clearly matches a skill's description, call skill__load with the exact name before taking task actions.";
  const rows = listed.map((s) => {
    const combined = s.whenToUse !== undefined ? `${s.description} — ${s.whenToUse}` : s.description;
    return `${s.name} — ${combined.length > SKILL_DESC_LIMIT ? `${combined.slice(0, SKILL_DESC_LIMIT)}…` : combined}`;
  });
  const full = `${head}\n${rows.join("\n")}`;
  if (full.length <= SKILL_SECTION_BUDGET) return full;
  return `Skills list over budget, names only: ${listed.map((s) => s.name).join(" ")}`;
}

/** 斜杠菜单 / /settings 管理面的目录行（T7/T8 数据源）：全收口径——含停用与 disable-model-invocation 者，
 *  消费面（菜单过滤 disabled、模型清单两剔除）各自裁剪。 */
function catalogRow(s: Skill, disabled: Set<string>): {
  name: string;
  description: string;
  whenToUse?: string;
  layer: Skill["layer"];
  source: Skill["source"];
  file: string;
  disabled: boolean;
  modelInvocable: boolean;
} {
  return {
    name: s.name,
    description: s.description,
    ...(s.whenToUse !== undefined ? { whenToUse: s.whenToUse } : {}),
    layer: s.layer,
    source: s.source,
    file: s.file,
    disabled: disabled.has(s.name),
    modelInvocable: !s.disableModelInvocation,
  };
}

function loadTool(tracks: Track[], disabled: Set<string>, loaded: Set<string>, warn: ScanWarn): Tool {
  // MI-16 修复（2026-09-28 code review P3）：accesses 改常量声明。旧实现 resolveExecution（声明期）调
  // hit() 做五轨全量 fs 扫描取「命中技能真实 file」——违契约①「声明期无副作用」，且与 execute 的重扫
  // 构成双扫 TOCTOU（审批等待窗内同名技能被更强轨覆盖 → 审批声明的路径 A ≠ 实读正文的文件 B）。
  // 改按契约 CT-04 的搜索根纪律：fsRead 只收字面路径（无 glob），搜索类工具应声明整个搜索根——五轨根
  // 常量声明后，execute 重扫命中的任何 <root>/<sub>/SKILL.md 都在声明集内（子目录名 ≠ frontmatter
  // name 的技能也覆盖），声明/执行两阶段不再有 IO 缝隙。
  const trackRoots = tracks.map((t) => Access.fsRead(t.dir));
  return defineTool({
    name: "skill__load",
    label: "Skill_load", // 工具行显示名（2026-09-29 用户走查报「Used Load」不可辨——缺 label 走默认剥前缀名 Load；模型/审批面仍用 name）
    // 模型可见面全英（m5-skill-trigger §2.3 语言拍板）：强制令（MUST/BEFORE）+ 禁令（NEVER mention /
    // do not guess）+ 去重告知 + 反向令（keyword overlap 不构成调用理由）——cc 措辞骨架、qwen 防幻觉句、
    // opencode/Reasonix 反向令；刻意只压「一句必须 + 一句禁止 + 一句反向」，塞太满稀释。
    description:
      "Load the full content of a skill (summaries stay in the system prompt; this tool loads the body on demand). " +
      "If the user names a skill, or the task clearly matches a skill's description, you MUST call this tool before taking task actions. " +
      "NEVER mention a skill without actually calling this tool. " +
      "Use only skill names listed in the system prompt — do not guess. " +
      "If a skill is already loaded, do not call it again (the call is intercepted; follow the body already in the conversation). " +
      "A few overlapping keywords alone are not sufficient — confirm the skill's guidance materially helps the task first.",
    parameters: z.object({ name: z.string().describe("The name of a skill from the available-skills list. Do not guess names.") }),
    resolveExecution: async (input) => {
      const { name } = input as { name: string };
      const hit = () => scanSkills(tracks, warn).find((x) => x.name === name); // MI-09：重扫同样容错（坏轨只损该轨）——只归 execute 期用（MI-16）
      return {
        accesses: trackRoots, // 常量声明（MI-16）：声明期零 IO——真实文件的读取发生在 execute 重扫之后，恒在声明集内
        approvalRule: "skill__load",
        execute: async () => {
          if (disabled.has(name)) {
            return { output: `Skill "${name}" is disabled. You can re-enable it under /settings → 技能 (Alt + K).`, isError: true };
          }
          const s = hit(); // 执行时重扫（ZCode）：会话中用户新放的技能指名即加载，清单滞后不碍事
          if (s === undefined) {
            const names = scanSkills(tracks, warn).map((x) => x.name).join(", ");
            return { output: `Skill "${name}" does not exist (available: ${names || "none"})`, isError: true };
          }
          if (s.disableModelInvocation) {
            // 禁调调用侧拒绝（m5-skill-trigger D4）：清单剔除只是建议面，execute 才是强制面（cc 双重执行
            // 主流、与执行时重扫同款分层）；菜单手动触发不经 skill__load，不受影响。
            return { output: `Skill "${name}" has disable-model-invocation set: only the user can trigger it, via the slash menu — ask the user to invoke it manually.`, isError: true };
          }
          if (loaded.has(name)) {
            // 运行时去重（qwen 九仓唯一）：已加载重调只回确认句，省一遍正文 token
            return { output: `Skill "${name}" is already loaded — its body is earlier in the conversation; follow it directly.`, isError: false };
          }
          loaded.add(name);
          // 2026-10-01 诊断批（实况：doc-review 正文引用 references/lenses.md，模型按项目 cwd 找落空，
          // 降级按速查表执行——SKILL.md 的相对路径引用此前无解析基准）：首行附技能文件绝对路径，
          // 模型可据此把 references/… 解析到技能目录（对照：ZCode 技能清单逐条带 file: 路径）。
          return {
            output: `[Skill file for "${name}": ${s.file} — relative paths in the body (e.g. references/…) resolve against this skill file's directory, not the project cwd]\n\n${s.body}`,
            isError: false,
          };
        },
      };
    },
  });
}

export default defineModule({
  name: "skill",
  version: "0.2.0",
  description: "skills 内容系统——五轨目录扫描 SKILL.md（bundled 垫底 → ~/.agents → ~/.orosus → 项目 .agents → 项目根 .orosus），摘要进系统提示 + skill__load 按需加载全文",
  api: 1,
  uses: ["fs.read"],
  provides: ["skill.catalog", "skill.resetLoaded"], // 宿主菜单/管理面/compact 重置消费（服务倒挂——websearch:endpoints 先例）
  config: configSchema,
  activate(ctx) {
    const cfg = ctx.config as z.infer<typeof configSchema> | undefined;
    const dirs = resolveDirs(cfg);
    const tracks = skillTracks(dirs);
    const disabled = new Set(cfg?.disabled ?? []);
    const loaded = new Set<string>();
    // MI-09：坏轨/坏条目经模块日志报告（scanSkills 容错 + 可观测——不静默吞，也不抛出降级）
    const warn: ScanWarn = (code, msg, fields) => ctx.log.warn(code, msg, fields);
    const skills = scanSkills(tracks, warn);
    const listed = skills.filter((s) => !s.disableModelInvocation && !disabled.has(s.name)); // 模型清单两剔除（T2/T6）
    if (listed.length > 0) ctx.contribute.promptSection({ order: 0, text: listingText(listed) });
    // 工具无条件注册（原「无技能零贡献」只省提示段）：执行时重扫要求会话中途新放技能也可指名加载
    ctx.contribute.tool(loadTool(tracks, disabled, loaded, warn));
    // 目录现读（每次调用重扫磁盘——UI 面 / 清单口径可不同步于 activate 快照，菜单/列表页天然活数据）
    ctx.provide("skill.catalog", () => scanSkills(tracks, warn).map((s) => catalogRow(s, disabled)));
    // 去重集重置口：宿主 compact 完成点惰性调用（正文被压掉后重调必须重新给正文）；会话边界经模块重建自然清零
    ctx.provide("skill.resetLoaded", () => { loaded.clear(); });
  },
});
