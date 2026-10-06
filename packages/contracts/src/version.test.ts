import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveVersionFrom } from "./version.ts";

// release-npm T4：三级读链三态——仓库形态①命中 / 孤立 dist+自名解析②命中（兼测①的 name 守卫）/ 双失败③兜底
const roots: string[] = [];
afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); });

function layout(files: Record<string, unknown>): string {
  const root = join(tmpdir(), `ver-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

const url = (root: string, rel: string): string => pathToFileURL(join(root, rel)).href;

describe("resolveVersionFrom 三级读链", () => {
  it("① 仓库形态：起点上三级有 name=orosus 的 manifest → 读其 version", () => {
    const root = layout({
      "package.json": { name: "orosus", version: "9.9.9" },
      "packages/contracts/src/version.ts": "",
    });
    expect(resolveVersionFrom(url(root, "packages/contracts/src/version.ts"))).toBe("9.9.9");
  });

  it("② 孤立 dist + 自名解析：上三级撞异物 manifest（name≠orosus，①守卫拒）→ up-walk node_modules/orosus 命中", () => {
    const root = layout({
      "app/package.json": { name: "host-app", version: "1.2.3" }, // ① 的异物：本地安装撞宿主项目形态
      "app/a/b/c/chunk.js": "",
      "app/node_modules/orosus/package.json": { name: "orosus", version: "5.5.5", exports: { "./package.json": "./package.json" } },
    });
    expect(resolveVersionFrom(url(root, "app/a/b/c/chunk.js"))).toBe("5.5.5");
  });

  it("③ 双失败：无上溯 manifest、无自名解析 → 0.0.0-dev 兜底不炸", () => {
    const root = layout({
      "app/package.json": { name: "host-app", version: "1.2.3" }, // ① 撞到但异物
      "app/a/b/c/chunk.js": "", // ② up-walk 无 orosus（布局内无 node_modules/orosus）
    });
    expect(resolveVersionFrom(url(root, "app/a/b/c/chunk.js"))).toBe("0.0.0-dev");
  });
});
