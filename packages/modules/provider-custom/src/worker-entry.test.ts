import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { workerEntryUrl } from "./worker-entry.ts";

// release-npm T3：探测序两态（G4）——伪 dist 布局 tmp：有 .js 用 .js / 无 .js 回 .ts
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("workerEntryUrl（media）探测序", () => {
  it("同目录 media-worker.js 在场（dist 形态）→ .js URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "wk-")); dirs.push(dir);
    writeFileSync(join(dir, "media-worker.js"), "");
    const meta = pathToFileURL(join(dir, "mediapipe.ts")).href;
    expect(workerEntryUrl(meta, "media-worker").href).toBe(pathToFileURL(join(dir, "media-worker.js")).href);
  });

  it("同目录无 .js（dev 源码形态）→ 回退 .ts", () => {
    const dir = mkdtempSync(join(tmpdir(), "wk-")); dirs.push(dir);
    const meta = pathToFileURL(join(dir, "mediapipe.ts")).href;
    expect(workerEntryUrl(meta, "media-worker").href).toBe(pathToFileURL(join(dir, "media-worker.ts")).href);
  });
});
