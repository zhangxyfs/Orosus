import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, formatSessions, harnessOptionsFor } from "./sessions.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = (): string => { dir = mkdtempSync(join(tmpdir(), "orosus-sessions-")); return dir; };

describe("listSessions 双层扫描（M4-1 T1/D46：根平铺 + 桶目录，复用 core 统一件）", () => {
  it("① 双层可见且带 bucket 标注：平铺 undefined、桶项 = 桶目录名；mtime 降序", () => {
    const root = fresh();
    writeFileSync(join(root, "s_old.jsonl"), "{}\n");
    const bucket = "D--proj-a1b2c3d4";
    mkdirSync(join(root, bucket));
    writeFileSync(join(root, bucket, "s_new.jsonl"), "{}\n");
    const list = listSessions(root);
    const ids = list.map((s) => s.id);
    expect(ids).toContain("s_old");
    expect(ids).toContain("s_new");
    const old = list.find((s) => s.id === "s_old")!;
    const fresh2 = list.find((s) => s.id === "s_new")!;
    expect(old.bucket).toBeUndefined(); // 存量平铺——原地兼容（D46：不迁移不强搬）
    expect(fresh2.bucket).toBe(bucket);
  });

  it("② formatSessions 标注来源：平铺项［平铺］、桶项含桶名", () => {
    const root = fresh();
    writeFileSync(join(root, "s_old.jsonl"), "{}\n");
    const bucket = "D--proj-a1b2c3d4";
    mkdirSync(join(root, bucket));
    writeFileSync(join(root, bucket, "s_new.jsonl"), "{}\n");
    const out = formatSessions(root);
    expect(out).toContain("s_old");
    expect(out).toContain("［平铺］");
    expect(out).toContain(bucket);
  });

  it("③ harnessOptionsFor 透传 parentDir（fork 跨目录定位父会话——REPL 外层装配填当前会话所在目录）", () => {
    const opts = harnessOptionsFor({ kind: "fork", parentSessionId: "s_parent", atEntryId: "e_last" }, { parentDir: "/flat/root" });
    expect(opts).toEqual({ fork: { parentSessionId: "s_parent", atEntryId: "e_last", parentDir: "/flat/root" } });
    expect(harnessOptionsFor({ kind: "new" })).toEqual({});
  });
});
