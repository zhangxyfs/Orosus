import type { ModuleDefinition } from "@orosus/contracts/module";
import { createLogger, type DiagSink } from "../diag/logger.ts";
import type { SessionStore } from "../session/types.ts";
import { createEventBus, type EventBus } from "./bus.ts";
import { createToolRegistry, type ToolRegistry } from "../tool/registry.ts";
import { validateModule } from "./validate.ts";
import { resolveTopo } from "./topo.ts";
import { activateModules, type ServiceResolver } from "./activate.ts";
import { resolveSections } from "../config/validate.ts";
import type { AuditEntry, ModuleRecord } from "./types.ts";

/** 核心保留 -100 段：harness 身份（§6.5 promptSection 秩序）。 */
export const HARNESS_IDENTITY_SECTION = "你是 Orosus，一个模块化 AI agent harness。经由模块提供的工具完成任务。";

export interface ModuleGraph {
  records: readonly ModuleRecord[];
  tools: ToolRegistry;
  services: ServiceResolver;
  bus: EventBus;
  promptSections(): string;
  audit(): AuditEntry[];
  catalog(): string;
  dispose(): Promise<void>;
}

export interface LoadModulesInput {
  defs: { def: ModuleDefinition; source: "builtin" | "inline" }[];
  cli: { enable?: string[]; disable?: string[]; noModules?: boolean; module?: string[] };
  sections: Map<string, Record<string, unknown>>;
  session: SessionStore;
  sink: DiagSink;
  spillDir: string;
}

/** §4.2 第 4–6 步串接：启停过滤 → 静态校验 → 拓扑 → 激活 → required 护栏。 */
export async function loadModules(input: LoadModulesInput): Promise<ModuleGraph> {
  const log = createLogger(input.sink, "kernel");
  const defs = input.defs.map((d) => d.def);
  const sections = resolveSections(input.sections, defs, input.cli);
  for (const orphan of sections.orphanSections) {
    log.warn("kernel.config.orphan-section", `配置 section [${orphan}] 无对应已安装模块（拼写错误或卸载残留）`);
  }

  // 启停过滤（§5.4）+ 重名检查（§5.1 name 字段）
  const disabled = new Set<string>();
  const seen = new Map<string, number>();
  for (const def of defs) {
    seen.set(def.name, (seen.get(def.name) ?? 0) + 1);
    if (!sections.isEnabled(def)) disabled.add(def.name);
  }
  const disabledNames = new Set<string>(); // 禁用 ≠ 降级：仍进 records/audit（state "discovered"，--dump-modules 可见，§5.4）
  const staticFailed: { name: string; reason: string }[] = [];
  const candidates: ModuleDefinition[] = [];
  for (const def of [...defs].sort((a, b) => a.name.localeCompare(b.name))) {
    if (disabled.has(def.name)) { disabledNames.add(def.name); continue; }
    if ((seen.get(def.name) ?? 0) > 1) {
      if (!staticFailed.some((f) => f.name === def.name)) staticFailed.push({ name: def.name, reason: "模块名冲突（全局唯一，§5.1）" }); // 每模块一行：重名的两副本只记一条
      continue;
    }
    const violations = validateModule(def);
    if (violations.length > 0) {
      staticFailed.push({ name: def.name, reason: violations.join("；") });
      continue;
    }
    candidates.push(def);
  }

  const { order, degraded } = resolveTopo({ defs: candidates, disabled });
  const bus = createEventBus(input.sink);
  const tools = createToolRegistry({ bus, sink: input.sink, spillDir: input.spillDir });
  const act = await activateModules({
    ordered: order, sectionResolution: sections, session: input.session, sink: input.sink, bus, tools,
  });

  // required 安全护栏（§10）：失败分级在启动处阻断
  const allFailed = [
    ...staticFailed,
    ...degraded,
    ...act.records.filter((r) => r.state === "failed").map((r) => ({ name: r.name, reason: r.failReason ?? "未知" })),
  ];
  const requiredFailed = allFailed.filter((f) => sections.isRequired(f.name));
  if (requiredFailed.length > 0) {
    await act.disposeAll();
    throw new Error(
      `required = true 的模块失败，阻断启动（§10 安全护栏）：${requiredFailed.map((f) => `${f.name}（${f.reason}）`).join("、")}`,
    );
  }

  const byName = new Map(input.defs.map((d) => [d.def.name, d]));
  // 原地回填 source（不展开复制）：disposeAll 原地改 state，graph.records 必须与 act.records 共享对象，
  // 否则停用后审计仍谎报 active
  for (const r of act.records) {
    const src = byName.get(r.name)?.source;
    if (src !== undefined) r.source = src;
  }
  const records: ModuleRecord[] = [
    ...act.records,
    ...allFailed
      .filter((f) => !act.records.some((r) => r.name === f.name))
      .map((f) => ({
        def: byName.get(f.name)!.def, name: f.name, source: byName.get(f.name)!.source,
        state: "failed" as const, failReason: f.reason, generation: 1,
      })),
    ...[...disabledNames].map((name) => ({
      def: byName.get(name)!.def, name, source: byName.get(name)!.source,
      state: "discovered" as const, failReason: "未启用（defaultEnabled=false 或配置/CLI 禁用，§5.4）", generation: 1,
    })),
  ];

  const graph: ModuleGraph = {
    records,
    tools,
    services: act.services,
    bus,

    promptSections() {
      const all = [...act.promptSections].sort((a, b) => a.order - b.order);
      return [HARNESS_IDENTITY_SECTION, ...all.map((s) => s.text)].join("\n\n");
    },

    audit() {
      return [...records]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => ({
          name: r.name,
          version: r.def.version,
          source: r.source,
          state: r.state,
          provides: r.def.provides ?? [],
          dependsOn: (r.def.dependsOn ?? []).map((d) => (typeof d === "string" ? d : `${d.capability}?`)),
          contributes: act.contributes.get(r.name) ?? [],
          ...(r.failReason !== undefined ? { failReason: r.failReason } : {}),
        }));
    },

    catalog() {
      const header = "name            version  source   tier  state   provides  dependsOn      contributes";
      const rows = graph.audit().map((a) =>
        [
          a.name.padEnd(15), a.version.padEnd(8), a.source.padEnd(8), "L0".padEnd(5),
          (a.state + (a.failReason ? ` (${a.failReason})` : "")).padEnd(7),
          (a.provides.join(",") || "—").padEnd(9),
          (a.dependsOn.join(",") || "—").padEnd(14),
          a.contributes.join("; ") || "—",
        ].join(" "),
      );
      return [header, ...rows].join("\n");
    },

    dispose: () => act.disposeAll(),
  };
  return graph;
}
