import type { AuditEntry } from "@orosus/core";

/** 联动闭包输入行（audit 行裁剪——只取闭包计算所需四字段）。 */
export interface ModuleDepRow {
  name: string;
  provides: string[];
  dependsOn: string[];
  state: AuditEntry["state"];
}

export type ClosureResult = { ok: true; write: string[] } | { ok: false; blocked: string };

/** 硬依赖能力集（剥掉可选 `?` 后缀——可选依赖缺提供者只是降级不联动，topo 同口径）。 */
const hardCaps = (row: ModuleDepRow): string[] => row.dependsOn.filter((d) => !d.endsWith("?"));

/**
 * 卸载闭包（T4/诊断方向 5）：卸 A 时硬依赖 A 所提供能力的模块跟着停——传递闭包（BFS）。
 * 只沿 active 依赖者走（停用/失败的依赖者无需再写停用）；闭包撞锁定模块 → 拒绝整次操作
 * （S1 拍板：卸了它运行就报错，宁可不动不可半拆）。
 */
export function computeUnmountClosure(names: string[], modules: ModuleDepRow[], lockedNames: string[]): ClosureResult {
  const locked = new Set(lockedNames);
  const closure = new Set<string>();
  const queue = [...names];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (closure.has(cur)) continue;
    closure.add(cur);
    const caps = new Set(modules.find((m) => m.name === cur)?.provides ?? []);
    for (const row of modules) {
      if (row.state !== "active" || closure.has(row.name)) continue;
      if (hardCaps(row).some((c) => caps.has(c))) queue.push(row.name);
    }
  }
  const hit = [...closure].find((n) => locked.has(n) && !names.includes(n));
  if (hit !== undefined) {
    return { ok: false, blocked: `无法卸载：${names.join("、")} 被 ${hit}（锁定）硬依赖` };
  }
  return { ok: true, write: [...closure] };
}

/**
 * 挂载闭包（T4）：挂 B 时它硬依赖的能力的提供者自动带上——沿提供者方向传递闭包（BFS）。
 * write 只含未激活成员（已激活的提供者不需要写盘）；需要写盘的成员撞锁定 → 拒绝整次操作
 * （S1 保守对称：锁定的提供者写不进 enabled，挂上 B 也起不来）。
 */
export function computeMountClosure(names: string[], modules: ModuleDepRow[], lockedNames: string[]): ClosureResult {
  const locked = new Set(lockedNames);
  const byName = new Map(modules.map((m) => [m.name, m]));
  const closure = new Set<string>();
  const queue = [...names];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (closure.has(cur)) continue;
    closure.add(cur);
    for (const cap of hardCaps(byName.get(cur) ?? { name: cur, provides: [], dependsOn: [], state: "discovered" as const })) {
      for (const p of modules.filter((m) => m.provides.includes(cap))) {
        if (!closure.has(p.name)) queue.push(p.name);
      }
    }
  }
  const write = [...closure].filter((n) => byName.get(n)?.state !== "active");
  const hit = write.find((n) => locked.has(n));
  if (hit !== undefined) {
    return { ok: false, blocked: `无法挂载：${names.join("、")} 硬依赖的 ${hit}（锁定）不可启用` };
  }
  return { ok: true, write };
}
