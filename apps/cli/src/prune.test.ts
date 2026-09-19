import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrunePlan, isSessionsSubcommand, parsePruneFlags, runPruneSubcommand, type PruneEntry } from "./prune.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-prune-")));
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const entry = (over: Partial<PruneEntry> & { id: string }): PruneEntry => ({
  file: `/x/${over.id}.jsonl`, dir: "/x", mtimeMs: NOW - 10 * DAY, eventCount: 5, ...over,
});

describe("buildPrunePlan（D47 纯函数：清单+事件数+mtime → 保留/删除计划）", () => {
  it("① 空文件清扫：0 字节与仅 header（事件数 0）无论龄必删；有事件且未过期保留", () => {
    const plan = buildPrunePlan(
      [entry({ id: "zero", eventCount: 0 }), entry({ id: "header-only", eventCount: 0 }), entry({ id: "live", mtimeMs: NOW - 1 * DAY })],
      { days: 30, now: NOW },
    );
    expect(plan.deletions.map((d) => d.id).sort()).toEqual(["header-only", "zero"]);
    expect(plan.deletions.every((d) => d.reason === "empty")).toBe(true);
    expect(plan.kept).toBe(1);
  });

  it("② 按龄：mtime 早于 now-days 删（reason=stale）；「当前会话」保守代理——全域 mtime 最新恒不动（即使空）", () => {
    const plan = buildPrunePlan(
      [entry({ id: "old", mtimeMs: NOW - 31 * DAY }), entry({ id: "edge", mtimeMs: NOW - 30 * DAY }), entry({ id: "newest-but-empty", mtimeMs: NOW - 1 * DAY, eventCount: 0 })],
      { days: 30, now: NOW },
    );
    const ids = plan.deletions.map((d) => d.id);
    expect(ids).toContain("old"); // 过期删
    expect(ids).not.toContain("edge"); // == cutoff 不删（②b 精确钉边界）
    expect(ids).not.toContain("newest-but-empty"); // 最新恒不动（D47 钉死：子命令无会话态，取最新为保守代理）
  });

  it("②b 边界精确：mtime == now-days 不删；mtime == now-days-1ms 删", () => {
    const plan = buildPrunePlan(
      [entry({ id: "at-cutoff", mtimeMs: NOW - 30 * DAY }), entry({ id: "past-cutoff", mtimeMs: NOW - 30 * DAY - 1 })],
      { days: 30, now: NOW },
    );
    expect(plan.deletions.map((d) => d.id)).toEqual(["past-cutoff"]);
  });
});

describe("子命令解析与装配（硬约束 1——拿掉 isSessionsSubcommand/flags 接线必红）", () => {
  it("③ isSessionsSubcommand 只认 sessions prune；flags 缺省 dry-run 30 天，--days/--apply 生效", () => {
    expect(isSessionsSubcommand(["sessions", "prune"])).toBe(true);
    expect(isSessionsSubcommand(["sessions"])).toBe(false);
    expect(isSessionsSubcommand(["prune"])).toBe(false);
    expect(parsePruneFlags([])).toEqual({ days: 30, apply: false });
    expect(parsePruneFlags(["--days", "7", "--apply"])).toEqual({ days: 7, apply: true });
    expect(parsePruneFlags(["--dry-run"])).toEqual({ days: 30, apply: false });
    expect(() => parsePruneFlags(["--days"])).toThrow();
    expect(() => parsePruneFlags(["--days", "abc"])).toThrow();
    expect(() => parsePruneFlags(["--wat"])).toThrow();
  });

  it("④ dry-run 不删文件（缺省）；--apply 删过期与空、保留最新、清空桶目录", async () => {
    const root = fresh();
    writeFileSync(join(root, "s_old.jsonl"), "h\nu\na\n"); // 有事件但过期
    utimesSync(join(root, "s_old.jsonl"), new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
    writeFileSync(join(root, "s_empty.jsonl"), "h\n"); // 仅 header——空
    const bucket = "D--proj-a1b2c3d4";
    mkdirSync(join(root, bucket));
    writeFileSync(join(root, bucket, "s_new.jsonl"), "h\nu\na\n"); // 最新（当前会话代理）
    utimesSync(join(root, bucket, "s_new.jsonl"), new Date(NOW - 1 * DAY), new Date(NOW - 1 * DAY));
    const lines: string[] = [];
    const dry = await runPruneSubcommand(["sessions", "prune"], { out: (s) => lines.push(s), root, now: NOW });
    expect(dry).toBe(0);
    expect(lines.some((l) => l.includes("dry-run"))).toBe(true);
    expect(existsSync(join(root, "s_old.jsonl"))).toBe(true); // 未删
    lines.length = 0;
    const code = await runPruneSubcommand(["sessions", "prune", "--apply"], { out: (s) => lines.push(s), root, now: NOW });
    expect(code).toBe(0);
    expect(existsSync(join(root, "s_old.jsonl"))).toBe(false); // 过期删
    expect(existsSync(join(root, "s_empty.jsonl"))).toBe(false); // 空删
    expect(existsSync(join(root, bucket, "s_new.jsonl"))).toBe(true); // 最新不动
    expect(lines.some((l) => l.includes("已删除 2"))).toBe(true);
  });

  it("⑤ --apply 后桶目录清空则目录一并移除（不留空壳桶）", async () => {
    const root = fresh();
    const bucket = "D--dead-b0b0b0b0";
    mkdirSync(join(root, bucket));
    writeFileSync(join(root, bucket, "s_stale.jsonl"), "h\nu\na\n");
    utimesSync(join(root, bucket, "s_stale.jsonl"), new Date(NOW - 60 * DAY), new Date(NOW - 60 * DAY));
    writeFileSync(join(root, "s_keeper.jsonl"), "h\nu\na\n"); // 最新
    utimesSync(join(root, "s_keeper.jsonl"), new Date(NOW - 1 * DAY), new Date(NOW - 1 * DAY));
    await runPruneSubcommand(["sessions", "prune", "--apply"], { out: () => {}, root, now: NOW });
    expect(readdirSync(root)).toEqual(["s_keeper.jsonl"]); // 空桶目录已移除
  });
});
