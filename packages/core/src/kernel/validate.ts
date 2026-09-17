import { MODULE_API_VERSION, type ModuleDefinition } from "@orosus/contracts/module";

/** contracts 登记的公共能力短名（规则 1）。新增公共能力 = contracts 加包 + 本表加名。 */
export const PUBLIC_CAPABILITY_KEYS = ["fs", "shell", "mcp", "skill"] as const;

/** 核心保留槽（§7.2）：走 provide 注册、不计入 provides 声明。 */
export const CORE_RESERVED_SLOT_PREFIXES = ["provider:"] as const;
export const CORE_RESERVED_SLOT_KEYS = ["auth.apikey", "loop.next-turn"] as const;

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+/;

/** §4.2 第 4 步静态校验。返回违规清单（空 = 通过）；校验失败 → 该模块降级，不阻断其余。 */
export function validateModule(def: ModuleDefinition): string[] {
  const v: string[] = [];
  if (!KEBAB.test(def.name)) v.push(`name "${def.name}" 非 kebab-case`);
  if (!SEMVER.test(def.version)) v.push(`version "${def.version}" 非 semver`);
  if (def.description.trim() === "") v.push("description 为空");
  if (def.api !== MODULE_API_VERSION && def.api !== MODULE_API_VERSION - 1) {
    v.push(`api ${def.api} 超出核心兼容窗口（支持 ${MODULE_API_VERSION} 与 ${MODULE_API_VERSION - 1}）`);
  }
  for (const key of def.provides ?? []) {
    if (CORE_RESERVED_SLOT_KEYS.includes(key as (typeof CORE_RESERVED_SLOT_KEYS)[number]) ||
        CORE_RESERVED_SLOT_PREFIXES.some((p) => key.startsWith(p))) {
      v.push(`provides 含核心保留槽 key "${key}"（§7.2：保留槽不计入 provides 声明、由 provide 注册）`);
      continue;
    }
    const isPublic = (PUBLIC_CAPABILITY_KEYS as readonly string[]).includes(key);
    const isPrefixed = key.startsWith(`${def.name}.`);
    if (!isPublic && !isPrefixed) {
      v.push(`provides 的 key "${key}" 既非 contracts 登记的公共短名、也未带模块名前缀 "${def.name}."（规则 1）`);
    }
  }
  for (const t of def.logEvents ?? []) {
    if (!t.startsWith(`${def.name}/`) && !MODULE_WRITABLE_CORE_LOG_TYPES.has(t)) {
      v.push(`logEvents 的 "${t}" 未带 "${def.name}/" 前缀且非模块可写核心类型（规则 4/v25 例外清单）`);
    }
  }
  return v;
}

/** 模块可写核心日志类型（v25/M3）：核心定义、由指定模块经 logEvents 声明后可写的核心事件。
 *  收敛为一个反直觉事实的两面：turn/compaction 由 compaction 模块写入（策略归模块），
 *  而投影应用它的 deriveMessages 是核心——核心不得认识 <module>/* 类型（铁律 3 的反向推论）。 */
export const MODULE_WRITABLE_CORE_LOG_TYPES: ReadonlySet<string> = new Set(["turn/compaction"]);
