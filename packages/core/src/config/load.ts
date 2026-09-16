import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";

export interface EffectiveConfig {
  core: Record<string, unknown>;
  sections: Map<string, Record<string, unknown>>;
  warnings: string[];
}

interface Doc {
  core: Record<string, unknown>;
  sections: Record<string, Record<string, unknown>>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

function splitDoc(raw: Record<string, unknown>): Doc {
  const core: Record<string, unknown> = {};
  const sections: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isPlainObject(v)) sections[k] = v;
    else core[k] = v;
  }
  return { core, sections };
}

/** 出厂默认层：审批/权限模块 required = true（§6.6；M3 前属"未来配置"，只产生孤儿 warning）。 */
function defaults(): Doc {
  return { core: {}, sections: { approval: { required: true } } };
}

function merge(base: Doc, over: Doc): Doc {
  return {
    core: { ...base.core, ...over.core },
    sections: Object.fromEntries(
      [...new Set([...Object.keys(base.sections), ...Object.keys(over.sections)])].map((k) => [
        k,
        { ...base.sections[k], ...over.sections[k] },
      ]),
    ),
  };
}

const ENV_PLACEHOLDER = /^\$ENV:([A-Z][A-Z0-9_]*)$/;

function resolveEnvPlaceholders(doc: Doc, env: NodeJS.ProcessEnv, warnings: string[]): Doc {
  const walk = (obj: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(obj).map(([k, v]) => {
        if (typeof v === "string") {
          const m = ENV_PLACEHOLDER.exec(v);
          if (m) {
            const value = env[m[1]!];
            if (value === undefined) {
              warnings.push(`环境变量 ${m[1]} 未设置，占位 "$ENV:${m[1]}" 保留未解析（§6.6）`);
              return [k, v];
            }
            return [k, value];
          }
        }
        return [k, v];
      }),
    );
  return {
    core: walk(doc.core),
    sections: Object.fromEntries(Object.entries(doc.sections).map(([k, v]) => [k, walk(v)])),
  };
}

/** §6.6 分层合并：内置默认 → 全局用户 → 项目 → 环境变量（仅核心顶层）→ CLI flag。 */
export function loadConfig(opts: {
  userFile?: string;
  projectFile?: string;
  cliOverrides?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): EffectiveConfig {
  const env = opts.env ?? process.env;
  const warnings: string[] = [];
  let acc = defaults();
  for (const file of [opts.userFile, opts.projectFile]) {
    if (file && existsSync(file)) {
      // 剥 UTF-8 BOM：Windows PowerShell 5.1 的 Out-File -Encoding utf8 / 旧版记事本会写 BOM，smol-toml 拒收
      const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      acc = merge(acc, splitDoc(parse(raw) as Record<string, unknown>));
    }
  }
  // env 层：仅核心顶层 key，命名 OROSUS_<KEY>（§6.6）
  const envCore: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("OROSUS_") && v !== undefined) envCore[k.slice(7).toLowerCase()] = v;
  }
  acc = merge(acc, { core: envCore, sections: {} });
  acc = merge(acc, { core: opts.cliOverrides ?? {}, sections: {} });
  acc = resolveEnvPlaceholders(acc, env, warnings);
  return { core: acc.core, sections: new Map(Object.entries(acc.sections)), warnings };
}
