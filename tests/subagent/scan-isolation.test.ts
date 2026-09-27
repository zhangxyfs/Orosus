import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanBucketSessions, scanSessionFiles } from "@orosus/core";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

/** 会话树扫描排除钉（M4.5 T13 / 决策 19）：子代理会话文件嵌在 <桶>/<主sid>/agents/agents_<编号>/agents/
 *  ——扫描只认 <桶>/<sid>/agents/ 直属主文件、不递归，子/孙目录都不被当成独立会话（树污染复发防线）。 */
describe("会话树扫描排除（子代理目录不当独立会话）", () => {
  it("㊼ scanBucketSessions：agents/ 下的子代理目录（含孙代理同层目录）不被扫出；主会话照常在册", () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-scan-"));
    const bucket = join(dir, "proj-bucket");
    // 主会话
    mkdirSync(join(bucket, "sess-main", "agents"), { recursive: true });
    writeFileSync(join(bucket, "sess-main", "agents", "session.jsonl"), JSON.stringify({ v: 1, id: "e1", type: "session/header" }) + "\n", "utf8");
    // 子代理 + 孙代理（同层嵌在主会话文件夹）
    for (const sid of ["agents_a3f9c2e1", "agents_b7d2f0a3"]) {
      mkdirSync(join(bucket, "sess-main", "agents", sid, "agents"), { recursive: true });
      writeFileSync(join(bucket, "sess-main", "agents", sid, "agents", "session.jsonl"), JSON.stringify({ v: 1, id: "e1", type: "session/header", parentSession: "sess-main" }) + "\n", "utf8");
    }
    const found = scanBucketSessions(bucket);
    expect(found.map((f) => f.id)).toEqual(["sess-main"]); // 只有主会话——子/孙都不是独立会话

    const acrossRoot = scanSessionFiles(dir); // 全根扫同样免疫
    expect(acrossRoot.map((f) => f.id)).toEqual(["sess-main"]);
  });
});
