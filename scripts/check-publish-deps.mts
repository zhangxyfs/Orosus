/** release-npm T5 依赖漂移门禁：bundled 包 external 并集 vs apps/cli dependencies 对账——
 *  npm 装机只按 apps/cli（→发行 manifest）的 dependencies 装，bundled 各包的外部依赖缺一件
 *  装机就缺一件运行时；多件则是安装面长霉。缺/多皆红（exit 1）。 */
import { readFileSync, readdirSync } from "node:fs";
import { externalUnion, repoLoader, type PkgManifest } from "./release-lib.mts";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** workspace 名→目录映射（pnpm-workspace 三层：packages/*、packages/modules/*、apps/*）。 */
function workspaceMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const dir of ["packages", "packages/modules", "apps"]) {
    for (const entry of readdirSync(`${repoRoot}/${dir}`, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const m = JSON.parse(readFileSync(`${repoRoot}/${dir}/${entry.name}/package.json`, "utf8")) as PkgManifest;
        map.set(m.name, `${dir}/${entry.name}`);
      } catch { /* 无 package.json 的目录跳过 */ }
    }
  }
  return map;
}

const cliPkg = JSON.parse(readFileSync(`${repoRoot}/apps/cli/package.json`, "utf8")) as PkgManifest;
const union = externalUnion(cliPkg, repoLoader(repoRoot, workspaceMap()));
const cliExternals = new Set(Object.keys(cliPkg.dependencies ?? {}).filter((n) => !cliPkg.dependencies![n]!.startsWith("workspace:")));

const missing = Object.keys(union).filter((n) => !cliExternals.has(n));
const extra = [...cliExternals].filter((n) => !(n in union));

if (missing.length > 0 || extra.length > 0) {
  if (missing.length > 0) console.error(`[check-publish-deps] 缺件（bundled 包运行时依赖未声明进 apps/cli dependencies——装机即缺）：\n  ${missing.join("\n  ")}`);
  if (extra.length > 0) console.error(`[check-publish-deps] 多件（apps/cli 声明了 bundled 面不用的外部依赖）：\n  ${extra.join("\n  ")}`);
  process.exit(1);
}
console.log(`[check-publish-deps] OK：${Object.keys(union).length} 件外部运行时依赖对账一致（${Object.keys(union).join(", ")}）`);
