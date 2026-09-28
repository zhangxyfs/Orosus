import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { orosusHome } from "@orosus/contracts/home";
import { z } from "zod";
import { defineModule } from "@orosus/contracts/module";
import { Access, defineTool, type Tool } from "@orosus/contracts/tool";

/**
 * skill 模块（M2 T17 最小版 → m4-7 升级为九仓标准形态）：
 * 扫描四轨目录（弱→强：~/.agents/skills → ~/.orosus/skills → 项目 .agents 逐层 → 项目根 .orosus；
 * 后入表者胜 = 项目压用户〔随仓库分发的技能对齐协作者环境〕+ 品牌压通用〔用户亲手放自家目录的优先〕）。
 * 每子目录一个 SKILL.md（YAML frontmatter 手写 key: value 行解析；name/description 必需，
 * when_to_use 简单说明与 disable-model-invocation 可选——m4-7 T2；未知键丢弃，宽松派）。
 * 贡献：promptSection（可用技能摘要，order 0 区，4000 字符预算超限降级仅名——T3）+
 * 工具 skill__load（读全文；执行时重扫 + 运行时去重——T4）+ 服务 skill.catalog / skill.resetLoaded
 * （宿主斜杠菜单与 /settings 管理面 / compact 后去重集重置——服务倒挂先例 websearch:endpoints）。
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
  /** 测试注轨 / 高级覆盖：四轨目录显式指定（缺省 = 真实 home / git 根解析）。 */
  userAgentsDir: z.string().optional(),
  userOrosusDir: z.string().optional(),
  projectAgentsDirs: z.array(z.string()).optional(),
  projectOrosusDir: z.string().optional(),
  bundledDir: z.string().optional(),
});

/** 第五轨内置目录（m4-7 T11）：skill 模块自带 bundled/ 随包分发（包根下，src 的上一级）——
 *  优先级垫底（低于 ~/.agents，skillTracks 首位），用户/项目同名技能可覆盖内置版（九仓惯例）。 */
const bundledSkillsDir = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "bundled");

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

/** 清单段（T3）：单条 description 截 250 进摘要（cc 同值——清单只为发现，长描述白占每轮预算）；
 *  段总预算 4000 字符，超限整段降级为仅技能名列表（ZCode 降级思路简化版——skill__load 按名加载，降级不带路径）。
 *  外层保险沿用 promptSection 单段 32KB 上限（activate.ts 既有纪律）。 */
const SKILL_DESC_LIMIT = 250;
const SKILL_SECTION_BUDGET = 4000;

function listingText(listed: Skill[]): string {
  const head = "可用技能（skill__load 按需加载全文）：";
  const rows = listed.map((s) => `${s.name} — ${s.description.length > SKILL_DESC_LIMIT ? `${s.description.slice(0, SKILL_DESC_LIMIT)}…` : s.description}`);
  const full = `${head}\n${rows.join("\n")}`;
  if (full.length <= SKILL_SECTION_BUDGET) return full;
  return `${head.replace("：", "（清单超预算，仅列名）：")}${listed.map((s) => s.name).join(" ")}`;
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
  return defineTool({
    name: "skill__load",
    description: "读取指定技能的完整内容（摘要常驻系统提示，本文按需加载）",
    parameters: z.object({ name: z.string().describe("技能名（见系统提示中的可用技能列表）") }),
    resolveExecution: async (input) => {
      const { name } = input as { name: string };
      const hit = () => scanSkills(tracks, warn).find((x) => x.name === name); // MI-09：重扫同样容错（坏轨只损该轨）
      return {
        // accesses 按命中技能真实 file 声明（m4-7 修 bug：原写死 ~/.orosus/skills/<名>，项目级路径对不上）
        accesses: [Access.fsRead((hit() ?? { file: `~/.orosus/skills/${name}/SKILL.md` }).file)],
        approvalRule: "skill__load",
        execute: async () => {
          if (disabled.has(name)) {
            return { output: `技能 "${name}" 已停用。可在 /settings → 技能 中重新启用（Alt + K）。`, isError: true };
          }
          const s = hit(); // 执行时重扫（ZCode）：会话中用户新放的技能指名即加载，清单滞后不碍事
          if (s === undefined) {
            const names = scanSkills(tracks, warn).map((x) => x.name).join("、");
            return { output: `技能 "${name}" 不存在（可用：${names || "无"}）`, isError: true };
          }
          if (loaded.has(name)) {
            // 运行时去重（qwen 九仓唯一）：已加载重调只回确认句，省一遍正文 token
            return { output: `技能 "${name}" 已加载过，正文在上方对话中，请直接按其行事。`, isError: false };
          }
          loaded.add(name);
          return { output: s.body, isError: false };
        },
      };
    },
  });
}

export default defineModule({
  name: "skill",
  version: "0.2.0",
  description: "skills 内容系统——四轨目录扫描 SKILL.md，摘要进系统提示 + skill__load 按需加载全文",
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
