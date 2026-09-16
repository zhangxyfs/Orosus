import type { ModuleDefinition } from "@orosus/contracts/module";

export interface TopoInput {
  defs: ModuleDefinition[];
  disabled: ReadonlySet<string>;
}

export interface TopoResult {
  order: ModuleDefinition[];
  degraded: { name: string; reason: string }[];
}

interface HardDep {
  consumer: string;
  key: string;
}

const hardDeps = (def: ModuleDefinition): HardDep[] =>
  (def.dependsOn ?? [])
    .filter((d): d is string => typeof d === "string")
    .map((key) => ({ consumer: def.name, key }));

/** §4.2 第 5 步：能力解析 → 冲突/缺失/环降级（级联到不动点）→ Kahn（同级字典序，§11.3 确定性）。 */
export function resolveTopo(input: TopoInput): TopoResult {
  const degraded = new Map<string, string>();
  const active = new Map<string, ModuleDefinition>();

  for (const def of [...input.defs].sort((a, b) => a.name.localeCompare(b.name))) {
    if (input.disabled.has(def.name)) {
      degraded.set(def.name, "已被配置或 CLI 禁用（§5.4）");
    } else {
      active.set(def.name, def);
    }
  }

  // 不动点循环：冲突/依赖缺失/环的降级会移除 provides，可能级联出新的缺失
  for (;;) {
    let changed = false;

    // 1. 能力 key → 提供者（唯一）；第二提供者 → 冲突双方降级（单所有者，§7.2）
    const providers = new Map<string, string[]>();
    for (const def of active.values()) {
      for (const key of def.provides ?? []) {
        providers.set(key, [...(providers.get(key) ?? []), def.name]);
      }
    }
    for (const [key, owners] of providers) {
      if (owners.length > 1) {
        for (const owner of owners) {
          if (active.delete(owner)) {
            degraded.set(owner, `能力 "${key}" 有两个激活提供者（${owners.sort().join("、")}），冲突双方降级`);
            changed = true;
          }
        }
      }
    }

    // 2. 硬依赖解析：无提供者 → 依赖者降级（级联在下一轮发生）
    const soleProvider = new Map<string, string>();
    for (const def of active.values()) {
      for (const key of def.provides ?? []) soleProvider.set(key, def.name);
    }
    // 全量提供者索引（含已降级/被禁用者）——降级原因必须点名提供者（§5.4 审计要求）
    const allProviders = new Map<string, string[]>();
    for (const def of input.defs) {
      for (const key of def.provides ?? []) {
        allProviders.set(key, [...(allProviders.get(key) ?? []), def.name]);
      }
    }
    for (const def of [...active.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      for (const dep of hardDeps(def)) {
        if (!soleProvider.has(dep.key)) {
          active.delete(def.name);
          const owners = (allProviders.get(dep.key) ?? []).sort();
          degraded.set(
            def.name,
            owners.length === 0
              ? `硬依赖能力 "${dep.key}" 无可用提供者（未安装/未声明）`
              : `硬依赖能力 "${dep.key}" 的提供者 ${owners.join("、")} 不可用（${owners.map((o) => degraded.get(o) ?? "缺失").join("；")}）`,
          );
          changed = true;
          break;
        }
      }
    }

    if (!changed) break;
  }

  // 3. 建图（provider → consumer，optional 不建边）+ Kahn
  const providerOf = new Map<string, string>();
  for (const def of active.values()) {
    for (const key of def.provides ?? []) providerOf.set(key, def.name);
  }
  const outEdges = new Map<string, Set<string>>(); // provider → consumers
  const inDegree = new Map<string, number>();
  for (const name of active.keys()) {
    outEdges.set(name, new Set());
    inDegree.set(name, 0);
  }
  for (const def of active.values()) {
    for (const dep of hardDeps(def)) {
      const provider = providerOf.get(dep.key)!; // 第 2 步已保证存在
      if (!outEdges.get(provider)!.has(def.name)) {
        outEdges.get(provider)!.add(def.name);
        inDegree.set(def.name, inDegree.get(def.name)! + 1);
      }
    }
  }

  const ready = [...active.keys()].filter((n) => inDegree.get(n) === 0).sort();
  const order: ModuleDefinition[] = [];
  const emitted = new Set<string>();
  while (ready.length > 0) {
    const name = ready.shift()!;
    if (emitted.has(name)) continue;
    emitted.add(name);
    order.push(active.get(name)!);
    for (const next of [...outEdges.get(name)!].sort()) {
      inDegree.set(next, inDegree.get(next)! - 1);
      if (inDegree.get(next) === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }

  // 4. 剩余 = 硬环及其下游：先精确找出环节点（迭代剔除剩余集中无出度的下游节点），
  //    环上模块全部记环因（§5.2 规则 2 机制 3："发现环即把环上模块全部降级，审计打印整条环"），再级联其消费者
  const remaining = new Set([...active.keys()].filter((n) => !emitted.has(n)));
  for (;;) {
    let trimmed = false;
    const snapshot = [...remaining]; // 快照迭代：本轮剔除中删除元素不影响本轮遍历集
    for (const n of snapshot) {
      if (![...(outEdges.get(n) ?? [])].some((m) => remaining.has(m))) {
        remaining.delete(n);
        trimmed = true;
      }
    }
    if (!trimmed) break;
  }
  const inCycle = [...remaining].sort();
  if (inCycle.length > 0) {
    const cycleDesc = inCycle
      .map((n) => {
        const deps = hardDeps(active.get(n)!).map((d) => providerOf.get(d.key)).filter((p): p is string => p !== undefined && inCycle.includes(p));
        return deps.length > 0 ? `${n} → ${deps.sort().join("/")}` : null;
      })
      .filter(Boolean)
      .join("；");
    for (const name of inCycle) {
      active.delete(name);
      degraded.set(name, `硬循环依赖（环：${cycleDesc}），环上模块全部降级`);
    }
    // 级联环外消费者到不动点（与第 2 步同形的降级波）
    for (;;) {
      let changed = false;
      for (const def of [...active.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        for (const dep of hardDeps(def)) {
          const p = providerOf.get(dep.key);
          if (p !== undefined && degraded.has(p) && !degraded.has(def.name)) {
            active.delete(def.name);
            degraded.set(def.name, `硬依赖能力 "${dep.key}" 的提供者 ${p} 已降级（级联）`);
            changed = true;
            break;
          }
        }
      }
      if (!changed) break;
    }
  }

  return {
    order,
    degraded: [...degraded.entries()].map(([name, reason]) => ({ name, reason })),
  };
}
