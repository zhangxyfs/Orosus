import { createJiti } from "jiti";
import { kernelT } from "./i18n.ts";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ModuleDefinition } from "@orosus/contracts/module";

// 宿主单例（§8.4）：alias 把 @orosus/contracts 四子路径钉到宿主 workspace 源码——模块自带 node_modules
// 装第二份的情形被压制（版本一致）。已知限制：jiti 编译产物是独立实例——contracts 全部词汇是结构化的
// （无 instanceof/品牌检查），双实例行为不可观察（M2 计划补空白登记项）。
const CONTRACTS_SRC = fileURLToPath(new URL("../../../contracts/src", import.meta.url));

let jiti: ReturnType<typeof createJiti> | undefined;

function getJiti(): ReturnType<typeof createJiti> {
  jiti ??= createJiti(import.meta.url, {
    alias: {
      "@orosus/contracts/module": join(CONTRACTS_SRC, "module", "index.ts"),
      "@orosus/contracts/tool": join(CONTRACTS_SRC, "tool", "index.ts"),
      "@orosus/contracts/provider": join(CONTRACTS_SRC, "provider", "index.ts"),
      "@orosus/contracts/fs": join(CONTRACTS_SRC, "fs", "index.ts"),
      "@orosus/contracts": join(CONTRACTS_SRC, "module", "index.ts"),
    },
    // CK-01 修复（2026-09-28 code review P0）：moduleCache:true 时 jiti 复用进程级 require 缓存——
    // 外部模块 /reload 永远拿到旧对象（热重载对外部模块静默失效）。改 false：import 前 jiti 主动清
    // 对应 require 缓存条目、重读磁盘；TS 变换产物仍走 jiti fsCache（默认开）磁盘缓存，重载成本可控。
    // contracts 别名随之每载一实例——本就结构化兼容（见上注）。
    moduleCache: false,
  });
  return jiti;
}

/** jiti 加载外部模块制品（§8.4）：统一入口——目录扫描的 TS 源码与配置声明的路径 source 共用。 */
export async function loadExternalModule(root: string, entry: string): Promise<ModuleDefinition> {
  const mod = (await getJiti().import(join(root, entry))) as { default?: unknown };
  const def = mod.default ?? mod;
  if (typeof def !== "object" || def === null) {
    throw new Error(kernelT("core.loader.err.notObject"));
  }
  const d = def as Partial<ModuleDefinition>;
  if (typeof d.name !== "string" || typeof d.activate !== "function") {
    throw new Error(kernelT("core.loader.err.notModule"));
  }
  return def as ModuleDefinition;
}
