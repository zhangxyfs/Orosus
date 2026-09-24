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
  const core = { ...base.core, ...over.core };
  // 模型键分层归一（F5 十轮）：上层出现 provider/model 任一键即删除下层另一键——
  // 防用户层 provider 与 CLI 层 model 双键并存时「provider ?? model」永取用户层（--model 失效）
  if ("provider" in over.core) delete core.model;
  else if ("model" in over.core) delete core.provider;
  return {
    core,
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
  // 递归 walk（修复：嵌套对象内的 $ENV 占位符从不被解析——如 [provider-custom] section 的
  // providers.zhipuai.apiKey = "$ENV:ZHIPU_API_KEY" 深层值原样透传给适配器 → 字面量当 key → 401）
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
          return [k, v];
        }
        // 嵌套纯对象递归（数组内元素不递归——数组不承载 $ENV 占位符的约定场景）
        if (typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date)) {
          return [k, walk(v as Record<string, unknown>)];
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
      const raw = readFileSync(file, "utf8").replace(/^﻿/, "");
      // SW-20（M4-3 T1d）：解析失败从炸穿启动改为降级——warnings 记录 + 该层跳过（出厂默认层兜底），
      // 宿主据此触发首次使用引导（此前 parse 抛错 = 启动即崩，手改坏一行配置整台不可用）
      try {
        acc = merge(acc, splitDoc(parse(raw) as Record<string, unknown>));
      } catch (err) {
        warnings.push(`配置文件 ${file} 解析失败：${err instanceof Error ? err.message : String(err)}——该层已跳过，按其余层与出厂默认运行（SW-20）`);
      }
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

/** 本地密钥文件（D37）：KEY=VALUE 行解析——坏行跳过并计数（调用方 warn，不因手改坏一行丢失全部密钥）。 */
export function loadSecretsEnv(file: string): { vars: Record<string, string>; badLines: number } {
  const vars: Record<string, string> = {};
  let badLines = 0;
  if (!existsSync(file)) return { vars, badLines };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) {
      badLines++;
      continue;
    }
    vars[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return { vars, badLines };
}

/** env 层合并（D37 优先级）：显式 env 参数（调用方短路）> process.env > secrets.env——显式环境是用户当下意图，secrets 只补缺。 */
export function mergeEnvLayer(processEnv: Record<string, string | undefined>, secrets: Record<string, string>): Record<string, string | undefined> {
  return { ...secrets, ...processEnv };
}
