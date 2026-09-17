import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PkgJson {
  name: string;
  orosus?: { module?: boolean; contract?: boolean };
  dependencies?: Record<string, string>;
}

// fileURLToPath 双侧归一：win32 上 URL.pathname 带前导 "/"、process.argv[1] 是反斜杠盘符路径——
// 直接拼接/比较会全盘失配（扫描循环整体跳过 + 主模块判断永假，脚本静默空转）
const ROOT = fileURLToPath(new URL("..", import.meta.url));

export function checkPackage(pkg: PkgJson, _files: string[]): string[] {
  const violations: string[] = [];
  const deps = Object.keys(pkg.dependencies ?? {});
  if (pkg.orosus?.module) {
    for (const d of deps) {
      if (d.startsWith("@orosus/") && d !== "@orosus/contracts") {
        violations.push(`模块 ${pkg.name} 依赖 ${d}（铁律 2：模块只能 import @orosus/contracts）`);
      }
    }
  }
  if (pkg.orosus?.contract) {
    for (const d of deps) {
      if (d !== "zod") violations.push(`契约包 ${pkg.name} 有运行时依赖 ${d}（§11.1：契约包零运行时依赖，zod type-only 除外）`);
    }
  }
  if (pkg.name === "@orosus/core") {
    for (const d of deps) {
      if (d.startsWith("@orosus/") && d !== "@orosus/contracts") {
        violations.push(`core 依赖 ${d}（铁律 3：core 禁止 import 任何模块）`);
      }
    }
  }
  return violations;
}

export function run(): number {
  const dirs = ["packages", join("packages", "contracts"), join("packages", "modules"), "apps"]; // modules 组目录无 package.json，由本条目下探一层
  let all: string[] = [];
  for (const dir of dirs) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const sub of readdirSync(abs)) {
      const pj = join(abs, sub, "package.json");
      if (!existsSync(pj)) continue;
      const pkg = JSON.parse(readFileSync(pj, "utf8")) as PkgJson;
      all = all.concat(checkPackage(pkg, []));
    }
  }
  if (all.length) {
    console.error("import 边界违规：\n" + all.map((v) => `  - ${v}`).join("\n"));
    return 1;
  }
  console.log("import 边界检查通过");
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(run());
