import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PkgJson {
  name: string;
  orosus?: { module?: boolean; contract?: boolean };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** core 允许依赖的 @orosus 包：契约 + i18n 运行时（m5-i18n 起加入——零依赖纯函数库，同 contracts 的叶子地位；
 * 铁律 3 的「任何模块」指模块系统装载的 packages/modules/* 制品，不含纯库包）。 */
export const CORE_ALLOWED_DEPS = new Set(["@orosus/contracts", "@orosus/i18n"]);

/** 包内源文件：path 相对包根（posix 形，如 "src/index.ts"），source 为原文（注释由扫描器剥）。 */
export interface SourceFile {
  path: string;
  source: string;
}

// fileURLToPath 双侧归一：win32 上 URL.pathname 带前导 "/"、process.argv[1] 是反斜杠盘符路径——
// 直接拼接/比较会全盘失配（扫描循环整体跳过 + 主模块判断永假，脚本静默空转）
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** import 说明符提取面（TS-04 代码面）：静态 import/export…from（跨行形态）、裸 import、动态 import()。 */
const IMPORT_RES: RegExp[] = [
  /(?:^|\n)[ \t]*import\s+(?:type\s+)?[\s\S]*?from\s*["']([^"']+)["']/g,
  /(?:^|\n)[ \t]*export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?\s*|\{[^}]*\}\s*)?from\s*["']([^"']+)["']/g,
  /(?:^|\n)[ \t]*import\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** 剥注释（块 + 行）——防注释里的 import 语句误报；字符串字面量含围栏的极端形态会被多剥，只少扫不误报。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 相对说明符从 filePath（相对包根）出发解析，是否越出包目录——allowImportingTsExtensions 下
 *  `../../core/src/...` 这类绕过 package.json 声明面的通道由这里封。 */
function escapesPackage(filePath: string, spec: string): boolean {
  const parts = filePath.split("/");
  parts.pop();
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return true; // 包根再向上 = 越界
      parts.pop();
    } else parts.push(seg);
  }
  return false;
}

export function checkPackage(pkg: PkgJson, files: SourceFile[] = []): string[] {
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
      if (d.startsWith("@orosus/") && !CORE_ALLOWED_DEPS.has(d)) {
        violations.push(`core 依赖 ${d}（铁律 3：core 禁止 import 任何模块——白名单：${[...CORE_ALLOWED_DEPS].join("/")}）`);
      }
    }
  }
  // 代码面（TS-04 修复）：package.json 只是意图声明，import 语句才是事实——对模块包与 core 扫
  // 非测试源码的真实 import。两个绕过通道由此关闭：
  // ① devDependencies 里塞 @orosus/core（声明面查不到）：只要发货代码 import 了它，这里报；
  //    测试文件（*.test.ts）不扫——devDep 供测试用是合法的（如 tool-todo 的 @orosus/testing）。
  // ② 相对路径越出包目录（package.json 零痕迹）：解析后不在本包内即报。
  if (pkg.orosus?.module === true || pkg.name === "@orosus/core") {
    const rule = pkg.name === "@orosus/core" ? "铁律 3：core 禁止 import 任何模块" : "铁律 2：模块只能 import @orosus/contracts";
    for (const f of files) {
      if (f.path.endsWith(".test.ts") || f.path.endsWith(".d.ts")) continue;
      const stripped = stripComments(f.source);
      for (const re of IMPORT_RES) {
        re.lastIndex = 0; // 模块级全局正则复用防护（matchAll 以 lastIndex 为起点）
        for (const m of stripped.matchAll(re)) {
          const spec = m[1]!;
          const allowed = pkg.name === "@orosus/core" ? CORE_ALLOWED_DEPS : new Set(["@orosus/contracts"]);
          const bad = spec.startsWith("@orosus/") && ![...allowed].some((a) => spec === a || spec.startsWith(a + "/"));
          if (bad) {
            violations.push(`${pkg.name} 的 ${f.path} import ${spec}（${rule}）`);
          } else if ((spec.startsWith("./") || spec.startsWith("../")) && escapesPackage(f.path, spec)) {
            violations.push(`${pkg.name} 的 ${f.path} 相对 import 越出包目录：${spec}（绕过 package.json 声明面——包间只能走包名 import）`);
          }
        }
      }
    }
  }
  return violations;
}

/** 收集包内 src 源文件（含 *.test.ts——排除规则在 checkPackage 统一，保持单一定义点）。 */
function collectSources(pkgDir: string): SourceFile[] {
  const srcDir = join(pkgDir, "src");
  if (!existsSync(srcDir)) return [];
  const out: SourceFile[] = [];
  for (const rel of readdirSync(srcDir, { recursive: true })) {
    const norm = String(rel).split("\\").join("/");
    if (norm.split("/").includes("node_modules")) continue;
    if (!norm.endsWith(".ts")) continue;
    out.push({ path: `src/${norm}`, source: readFileSync(join(srcDir, norm), "utf8") });
  }
  return out;
}

export function run(): number {
  // packages/contracts 死条目已清（TS-04）：其下无嵌套 package.json，原条目扫不到任何包；
  // modules 组目录无 package.json，由本条目下探一层
  const dirs = ["packages", join("packages", "modules"), "apps"];
  let all: string[] = [];
  for (const dir of dirs) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const sub of readdirSync(abs)) {
      const pkgDir = join(abs, sub);
      const pj = join(pkgDir, "package.json");
      if (!existsSync(pj)) continue;
      const pkg = JSON.parse(readFileSync(pj, "utf8")) as PkgJson;
      const needsScan = pkg.orosus?.module === true || pkg.name === "@orosus/core";
      all = all.concat(checkPackage(pkg, needsScan ? collectSources(pkgDir) : []));
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
