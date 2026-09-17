/** API 参考生成（§11.10）：typedoc 对 contracts 四域生成 markdown 到 docs/api/——doc-sync 门禁的生成端。 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { Application } = await import("typedoc");

const app = await Application.bootstrapWithPlugins(
  {
    entryPoints: [
      join(ROOT, "packages/contracts/src/module/index.ts"),
      join(ROOT, "packages/contracts/src/tool/index.ts"),
      join(ROOT, "packages/contracts/src/provider/index.ts"),
      join(ROOT, "packages/contracts/src/fs/index.ts"),
    ],
    out: join(ROOT, "docs/api"),
    githubPages: false,
    readme: "none",
    excludePrivate: true,
    excludeInternal: true,
  },
  [],
);

const project = await app.convert();
if (project === undefined) {
  console.error("typedoc convert 失败");
  process.exit(1);
}
await app.generateDocs(project, join(ROOT, "docs/api"));
console.log("docs/api 已生成");
