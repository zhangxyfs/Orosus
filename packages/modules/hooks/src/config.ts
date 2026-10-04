import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { orosusHome } from "@orosus/contracts/home";

/** 七事件（事件名与 ZCode/Claude 同名同义——生态脚本直接兼容；配置里事件名即表名）。 */
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "PermissionRequest"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const hookEntrySchema = z.object({
  command: z.string().min(1).describe("shell 命令（win32 走 Git Bash；${OROSUS_PROJECT_DIR}/${CLAUDE_PROJECT_DIR} 模板可用）"),
  timeout: z.number().int().min(0).optional().describe("秒；缺省或 = 0 = 用全局 timeoutMs（哨兵语义，非零超时）"),
  disabled: z.boolean().optional().describe("停用——/settings 钩子面 e 键写盘（不删除配置，重新启用即恢复）"),
});
const eventTableSchema = z.object({
  matcher: z.string().optional().describe("正则（大小写敏感、不隐式锚定，全名匹配须自带 ^$）；作用于事件匹配值——工具事件=工具名、SessionStart=source；省略 = 全匹配"),
  hooks: z.array(hookEntrySchema).min(1).describe("该表下串行执行的钩子命令"),
});

/** 模块 config schema（z.object 声明后放行+strip——模块配置硬规则）。事件表与路径注入均经通用
 *  config 层喂入；表数组的权威执行序由 loadHooksConfig 自读两份 TOML 追加合并（通用 mergeDeep 对
 *  数组整值替换——项目层会顶掉用户层，不能当执行源）。 */
export const configSchema = z.object({
  enabled: z.boolean().default(true).describe("总闸——false 零监听"),
  timeoutMs: z.number().int().min(1000).default(60_000).describe("全局默认超时（毫秒）"),
  userConfigFile: z.string().optional().describe("用户层配置文件路径（缺省 ~/.orosus/modules.d/hooks.toml；测试密封注入位）"),
  projectConfigFile: z.string().optional().describe("项目层配置文件路径（缺省 <cwd>/.orosus/modules.d/hooks.toml；测试密封注入位）"),
  trustFile: z.string().optional().describe("信任记录文件路径（缺省 ~/.orosus/hooks/hooks-trust.json；测试密封注入位）"),
  ...Object.fromEntries(HOOK_EVENTS.map((e) => [e, z.array(eventTableSchema).optional().describe(`${e} 事件表`)])),
});
export type HooksModuleConfig = z.infer<typeof configSchema>;

/** 编译产物：matcher 已编译（非法正则 → 永不匹配的哨兵 + warn——kimi「静默不匹配」可观测化）；
 *  origin 标层（信任门按层过滤——项目层未过 sha256 审查整层不执行，T9）。 */
export interface CompiledHook {
  command: string;
  timeoutSec?: number;
  disabled?: boolean; // /settings e 键写盘位——dispatch 跳过（配置保留）
}
export interface CompiledTable {
  origin: "user" | "project";
  matcherSource?: string;
  match: (value: string | undefined) => boolean;
  hooks: CompiledHook[];
}
export interface HooksConfig {
  enabled: boolean;
  timeoutMs: number;
  /** 两层追加合并（同事件同 matcher 不去重、执行序用户层在前——T9 口径）。 */
  tables: Partial<Record<HookEvent, CompiledTable[]>>;
}

export const defaultUserConfigFile = (): string => join(orosusHome(), "modules.d", "hooks.toml");
export const defaultProjectConfigFile = (cwd: string): string => join(cwd, ".orosus", "modules.d", "hooks.toml");

/** 非法正则哨兵：空负向前瞻任何输入都不匹配（$^ 对空串可同时命中首尾位——不可用）。 */
const NEVER_MATCH = /(?!)/;

const compileMatcher = (source: string | undefined, warn: (msg: string) => void): { matcherSource?: string; match: (value: string | undefined) => boolean } => {
  if (source === undefined) return { match: () => true };
  try {
    const re = new RegExp(source);
    return { matcherSource: source, match: (value) => re.test(value ?? "") };
  } catch {
    warn(`matcher 非法正则 "${source}"——该 matcher 永不匹配（配置加载不炸）`);
    return { matcherSource: source, match: () => false };
  }
};

/** 读一份 TOML（剥 BOM——Windows PowerShell/记事本先例 load.ts:149）；不存在/坏文件 = 该层无贡献（fail-open，坏文件 generic 层已 warning）。
 *  真实文件形态带 [hooks] 节头（modules.d 装载纪律：顶层标量会漏进 core——splitDoc 按纯对象归节）；裸节体形态（测试/手拼）同样认。 */
const readToml = (file: string): Record<string, unknown> | undefined => {
  try {
    if (!existsSync(file)) return undefined;
    const doc = parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const wrapped = doc["hooks"];
    return typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped) ? wrapped as Record<string, unknown> : doc;
  } catch {
    return undefined;
  }
};

const parseTables = (doc: Record<string, unknown> | undefined, origin: "user" | "project", warn: (msg: string) => void): Partial<Record<HookEvent, CompiledTable[]>> => {
  const out: Partial<Record<HookEvent, CompiledTable[]>> = {};
  if (doc === undefined) return out;
  for (const event of HOOK_EVENTS) {
    const raw = doc[event];
    if (!Array.isArray(raw)) continue;
    const tables: CompiledTable[] = [];
    for (const t of raw) {
      const entry = eventTableSchema.safeParse(t);
      if (!entry.success) {
        warn(`[${event}] 表项形状不合法已跳过：${entry.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        continue;
      }
      const { matcherSource, match } = compileMatcher(entry.data.matcher, warn);
      tables.push({ origin, ...(matcherSource !== undefined ? { matcherSource } : {}), match, hooks: entry.data.hooks.map((h) => ({ command: h.command, ...(h.timeout !== undefined ? { timeoutSec: h.timeout } : {}), ...(h.disabled === true ? { disabled: true } : {}) })) });
    }
    if (tables.length > 0) out[event] = tables;
  }
  return out;
};

/** 两层装载：标量（enabled/timeoutMs）走通用合并值（项目层覆盖用户层——mergeDeep 标量语义正确）；
 *  事件表自读两份 TOML 追加合并（用户层在前）。自读门 = 通用 section 里出现过任一事件表——密封测试
 *  （hermetic config 指向 tmpdir）下真实 home 的 hooks.toml 不进通用层，自读随之关闭，出厂件零旁路。 */
export function loadHooksConfig(opts: {
  sectionHasTables: boolean;
  userFile: string;
  projectFile: string;
  enabled: boolean;
  timeoutMs: number;
  warn: (msg: string) => void;
}): HooksConfig {
  const tables: Partial<Record<HookEvent, CompiledTable[]>> = {};
  if (opts.sectionHasTables) {
    // 用户层在前、项目层追加（执行序口径：设计空白表「多钩子执行序」行）；origin 标层供信任门过滤（T9）
    const layers: [("user" | "project"), Record<string, unknown> | undefined][] = [["user", readToml(opts.userFile)], ["project", readToml(opts.projectFile)]];
    for (const [origin, doc] of layers) {
      const layer = parseTables(doc, origin, opts.warn);
      for (const event of HOOK_EVENTS) {
        if (layer[event] !== undefined) tables[event] = [...(tables[event] ?? []), ...layer[event]!];
      }
    }
  }
  return { enabled: opts.enabled, timeoutMs: opts.timeoutMs, tables };
}
