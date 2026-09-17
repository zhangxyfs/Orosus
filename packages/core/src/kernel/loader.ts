import { createJiti } from "jiti";
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
    moduleCache: true,
  });
  return jiti;
}

/** jiti 加载外部模块制品（§8.4）：统一入口——目录扫描的 TS 源码与配置声明的路径 source 共用。 */
export async function loadExternalModule(root: string, entry: string): Promise<ModuleDefinition> {
  const mod = (await getJiti().import(join(root, entry))) as { default?: unknown };
  const def = mod.default ?? mod;
  if (typeof def !== "object" || def === null) {
    throw new Error("非模块制品：default 导出不是对象（期待 defineModule 的返回值）");
  }
  const d = def as Partial<ModuleDefinition>;
  if (typeof d.name !== "string" || typeof d.activate !== "function") {
    throw new Error("非模块制品：缺 name 或 activate（不是 defineModule 形状，§8.4）");
  }
  return def as ModuleDefinition;
}
