import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildPrunePlan, isSessionsSubcommand, parsePruneFlags, runPruneSubcommand, type PruneEntry } from "./prune.ts";

let dir: string | undefined;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-prune-")));
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const entry = (over: Partial<PruneEntry> & { id: string }): PruneEntry => ({
  file: `/x/${over.id}/agents/session.jsonl`, dir: `/x/${over.id}`, bucket: "B", mtimeMs: NOW - 10 * DAY, eventCount: 5, ...over,
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

  it("④ dry-run 不删文件（缺省）；--apply 删过期与空（整会话目录含 spill/）、保留最新", async () => {
    const root = fresh();
    // 新形态夹具（会话树批 T2 目录化）：<桶>/<sid>/agents/session.jsonl + <sid>/spill/
    const seed = (bucket: string, sid: string, content: string, ageDays?: number): void => {
      const file = join(root, bucket, sid, "agents", "session.jsonl");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      mkdirSync(join(root, bucket, sid, "spill"), { recursive: true });
      if (ageDays !== undefined) utimesSync(file, new Date(NOW - ageDays * DAY), new Date(NOW - ageDays * DAY));
    };
    seed("B-a", "s_old", "h\nu\na\n", 40);   // 有事件但过期
    seed("B-a", "s_empty", "h\n");            // 仅 header——空
    seed("B-b", "s_new", "h\nu\na\n", 1);     // 最新（当前会话代理）
    const lines: string[] = [];
    const dry = await runPruneSubcommand(["sessions", "prune"], { out: (s) => lines.push(s), root, now: NOW });
    expect(dry).toBe(0);
    expect(lines.some((l) => l.includes("dry-run"))).toBe(true);
    expect(existsSync(join(root, "B-a", "s_old"))).toBe(true); // 未删
    lines.length = 0;
    const code = await runPruneSubcommand(["sessions", "prune", "--apply"], { out: (s) => lines.push(s), root, now: NOW });
    expect(code).toBe(0);
    expect(existsSync(join(root, "B-a", "s_old"))).toBe(false); // 过期删——整会话目录（含 agents/ 与 spill/）
    expect(existsSync(join(root, "B-a", "s_empty"))).toBe(false); // 空删
    expect(existsSync(join(root, "B-b", "s_new", "agents", "session.jsonl"))).toBe(true); // 最新不动
    expect(lines.some((l) => l.includes("已删除 2"))).toBe(true);
  });

  it("⑤ --apply 后桶目录清空则目录一并移除（不留空壳桶）", async () => {
    const root = fresh();
    const seed = (bucket: string, sid: string, ageDays: number): void => {
      const file = join(root, bucket, sid, "agents", "session.jsonl");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "h\nu\na\n");
      utimesSync(file, new Date(NOW - ageDays * DAY), new Date(NOW - ageDays * DAY));
    };
    seed("D--dead-b0b0b0b0", "s_stale", 60);
    seed("D--live-a1b2c3d4", "s_keeper", 1); // 最新
    await runPruneSubcommand(["sessions", "prune", "--apply"], { out: () => {}, root, now: NOW });
    expect(readdirSync(root).toSorted()).toEqual(["D--live-a1b2c3d4"]); // 空桶目录已移除
  });
});
