import type { ModuleDefinition } from "@orosus/contracts/module";

/** reload diff 输入（§5.5）：def + 来源 + 入口 hash（目录模块）+ 配置自有 key 有效值。 */
export interface GraphDef {
  def: ModuleDefinition;
  source: string;
  entryHash?: string | undefined;
  configValue: unknown;
}

export interface ReloadReport {
  added: string[];
  removed: string[];
  reloaded: string[];
  unchanged: string[];
  failed: { name: string; reason: string }[];
}

const stableStringify = (v: unknown): string => {
  if (v === undefined) return "undefined";
  if (typeof v !== "object" || v === null) return JSON.stringify(v) ?? String(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
};

/** §5.5 diff 判定：Reloaded = entryHash 变化（目录模块）或 def 引用变化（内置/编程）或配置自有 key 有效值不等；
 *  enabled 变化不在此（走 Added/Removed——调用侧按启停过滤 defs 后再 diff）。 */
export function diffGraphs(oldDefs: GraphDef[], newDefs: GraphDef[]): { added: string[]; removed: string[]; reloaded: string[]; unchanged: string[] } {
  const oldByName = new Map(oldDefs.map((g) => [g.def.name, g]));
  const newByName = new Map(newDefs.map((g) => [g.def.name, g]));
  const added = [...newByName.keys()].filter((n) => !oldByName.has(n)).sort();
  const removed = [...oldByName.keys()].filter((n) => !newByName.has(n)).sort();
  const reloaded: string[] = [];
  const unchanged: string[] = [];
  for (const [name, next] of [...newByName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const prev = oldByName.get(name);
    if (prev === undefined) continue; // added
    const hashChanged = prev.entryHash !== next.entryHash;
    const defChanged = prev.def !== next.def;
    const configChanged = stableStringify(prev.configValue) !== stableStringify(next.configValue);
    if (hashChanged || defChanged || configChanged) reloaded.push(name);
    else unchanged.push(name);
  }
  return { added, removed, reloaded, unchanged };
}
