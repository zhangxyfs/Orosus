/** API 参考生成（§11.10）：typedoc 对 contracts 四域生成 markdown 到 docs/api/——doc-sync 门禁的生成端。 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// win32 分隔符归一：typedoc 的 glob 输入不接受反斜杠（M1 check-boundaries 同款坑）——一律转 posix
const toPosix = (p: string): string => p.split("\\").join("/");
const { Application } = await import("typedoc");

const app = await Application.bootstrapWithPlugins(
  {
    entryPoints: [
      toPosix(join(ROOT, "packages/contracts/src/module/index.ts")),
      toPosix(join(ROOT, "packages/contracts/src/tool/index.ts")),
      toPosix(join(ROOT, "packages/contracts/src/provider/index.ts")),
      toPosix(join(ROOT, "packages/contracts/src/fs/index.ts")),
      toPosix(join(ROOT, "packages/contracts/src/home/index.ts")),
    ],
    out: toPosix(join(ROOT, "docs/api")),
    githubPages: false,
    readme: "none",
    excludePrivate: true,
    excludeInternal: true,
    // skipLibCheck：zod v4 的 .d.cts（locale 表）在无 esModuleInterop 的库检查下报 TS1259，
    // typedoc 转换整体失败 → 空输出（M2 T19 起的隐性缺陷——doc-sync 门空转；本次修复）
    compilerOptions: { skipLibCheck: true, esModuleInterop: true },
  },
  [],
);

const project = await app.convert();
if (project === undefined) {
  console.error("typedoc convert 失败");
  process.exit(1);
}
await app.generateDocs(project, join(ROOT, "docs/api"));

// 产物非平凡自检（M2 补账教训：typedoc 静默失败时生成空壳站，docs:check 的 diff 空对空恒过）：
// 已知符号必须真实出现在产物里，否则本脚本以非零退出——门禁有货才算数
const OUT = join(ROOT, "docs/api");
const allHtml = readdirSync(OUT, { recursive: true }).filter((f) => String(f).endsWith(".html"));
const haystack = allHtml.map((f) => readFileSync(join(OUT, String(f)), "utf8")).join("\n");
const required = ["defineModule", "CommandUi", "ProviderAdapter", "ToolExecution", "orosusHome"]; // M4-2.5 T6：home 第五入口
const missing = required.filter((sym) => !haystack.includes(sym));
if (allHtml.length < 10 || missing.length > 0) {
  console.error(`API 参考生成产物不完整（${allHtml.length} 页，缺失符号：${missing.join(", ") || "无"}）——疑似 typedoc 静默失败`);
  process.exit(1);
}
console.log(`docs/api 已生成（${allHtml.length} 页，含 ${required.join("/")}）`);
