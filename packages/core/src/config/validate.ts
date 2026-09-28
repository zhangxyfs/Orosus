import type { ModuleDefinition } from "@orosus/contracts/module";

export interface SectionResolution {
  isEnabled(def: ModuleDefinition): boolean;
  isRequired(name: string): boolean;
  configFor(def: ModuleDefinition): { ok: true; value: unknown } | { ok: false; error: string };
  orphanSections: string[];
}

export const RESERVED_SECTION_KEYS = ["enabled", "source", "required"] as const;

/** §5.4 三层启停 + §6.6 保留 key 剥离 + 模块 schema strict 校验。 */
export function resolveSections(
  sections: Map<string, Record<string, unknown>>,
  defs: ModuleDefinition[],
  cli: { enable?: string[]; disable?: string[]; noModules?: boolean; module?: string[] },
): SectionResolution {
  const names = new Set(defs.map((d) => d.name));
  const orphanSections = [...sections.keys()].filter((k) => !names.has(k)).sort();

  return {
    orphanSections,

    isEnabled(def) {
      // 纯净模式（§5.4/§8.6）：--no-modules 只跑核心 + 显式 --module 指定的模块（与 --enable-module 语义不同，不混用）
      if (cli.noModules === true) return (cli.module ?? []).includes(def.name);
      let enabled = def.defaultEnabled ?? true;
      const section = sections.get(def.name);
      if (typeof section?.enabled === "boolean") enabled = section.enabled;
      if ((cli.enable ?? []).includes(def.name)) enabled = true;
      if ((cli.disable ?? []).includes(def.name)) enabled = false; // disable 优先于 enable（保守方向）
      return enabled;
    },

    isRequired(name) {
      return sections.get(name)?.required === true;
    },

    configFor(def) {
      const section = { ...sections.get(def.name) };
      for (const k of RESERVED_SECTION_KEYS) delete section[k];
      if (!def.config) {
        const extra = Object.keys(section);
        return extra.length > 0
          ? { ok: false, error: `模块未声明 config schema，拒收额外 key：${extra.join(", ")}` }
          : { ok: true, value: undefined };
      }
      const parsed = def.config.safeParse(section);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
      }
      // CH-14② 修复（2026-09-28 code review）：instanceof z.ZodObject 跨 zod 副本失效（jiti 加载的 local
      // 模块若打包了自己的 zod——类实例不同）→ strict 未知 key 检查静默跳过、typo 键被 strip 吞掉。
      // 改鸭式判定：safeParse 产物是对象即做检查（zod strip/passthrough 语义照旧——未知 key 不在 data
      // 即报错；标量 schema 产物非对象，本就无 section 键可对照）。
      if (parsed.data !== null && (typeof parsed.data === "object" || typeof parsed.data === "function")) {
        const unknown = Object.keys(section).filter((k) => !(k in (parsed.data as object)));
        if (unknown.length > 0) return { ok: false, error: `未知配置 key（strict）：${unknown.join(", ")}` };
      }
      return { ok: true, value: parsed.data };
    },
  };
}
