import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeSessionDir, sweepEmptySessions } from "./cleanup.ts";
import { isEmptySessionHead, readSessionHead } from "./tree.ts";

let dir: string | undefined;
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-cleanup-")));
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

const ev = (id: string, type: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, id, parentId: null, seq: 1, ts: "2026-10-01T00:00:00Z", type, ...fields });

/** 新形态夹具：<bucket>/<sid>/agents/session.jsonl；返回主文件路径。 */
const seed = (bucketDir: string, sid: string, lines: string[]): string => {
  const agents = join(bucketDir, sid, "agents");
  mkdirSync(agents, { recursive: true });
  const file = join(agents, "session.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
};

describe("isEmptySessionHead（2026-10-01 用户拍板清理批：0 消息壳判定）", () => {
  it("① 四要素：无消息/无名/非 fork 子体/行数在预算内——manifest 壳与空 fork 壳都算空", () => {
    // manifest 壳（MCP activate 期物化的典型形态——无 header 无消息）
    expect(isEmptySessionHead(readSessionHead(seed(fresh(), "s_shell", [ev("e1", "mcp/manifest", { digest: "d", servers: {} })]))!)).toBe(true);
    // 根会话 + 无消息（有 header）
    expect(isEmptySessionHead(readSessionHead(seed(fresh(), "s_root_empty", [ev("e1", "session/header", { parentSession: null })]))!)).toBe(true);
  });
  it("② 排除面：有消息/有名/fork 子体/超预算行数——四者任一在场即非空", () => {
    expect(isEmptySessionHead(readSessionHead(seed(fresh(), "s_msg", [ev("e1", "user/message", { content: [{ kind: "text", text: "问" }] })]))!)).toBe(false);
    expect(isEmptySessionHead(readSessionHead(seed(fresh(), "s_labeled", [ev("e1", "session/label", { label: "起过名" })]))!)).toBe(false); // 用户投过意图，保守保留
    // fork 子体：0 自有消息但投影含父辈——可能是用户有意留的分叉点
    expect(isEmptySessionHead(readSessionHead(seed(fresh(), "s_kid", [ev("e1", "session/header", { parentSession: "s_parent" }), ev("e2", "session/fork", { sourceEntryId: "e0", parentSession: "s_parent" })]))!)).toBe(false);
    // 65 行无消息（超 readSessionHead 64 行预算——预算外可能有看不见的 user/message，宁留勿杀）
    const noise = Array.from({ length: 65 }, (_, i) => ev(`e${i}`, "assistant/message", { content: [] }));
    expect(isEmptySessionHead(readSessionHead(seed(fresh(), "s_big", noise))!)).toBe(false);
  });
});

describe("purgeSessionDir（整目录清除）", () => {
  it("① 连带 agents/ 主文件、锁、db/、spill/ 一并清；不存在幂等 false；id 走 CS-12 格式闸", () => {
    const d = fresh();
    const s = join(d, "s_gone");
    mkdirSync(join(s, "agents"), { recursive: true });
    writeFileSync(join(s, "agents", "session.jsonl"), "");
    writeFileSync(join(s, "agents", "session.lock"), "");
    mkdirSync(join(s, "db"));
    mkdirSync(join(s, "spill"));
    expect(purgeSessionDir(d, "s_gone")).toBe(true);
    expect(existsSync(s)).toBe(false);
    expect(purgeSessionDir(d, "s_gone")).toBe(false); // 再删幂等
    expect(purgeSessionDir(d, "../escape")).toBe(false); // 桶逃逸形态拒收
    expect(existsSync(d)).toBe(true); // 桶本身不动
  });
});

describe("sweepEmptySessions（启动清扫异常退出残留壳）", () => {
  it("① 只清空壳：manifest 壳清、有消息会话/起名空会话/fork 子体保留", () => {
    const d = fresh();
    seed(d, "s_shell", [ev("e1", "mcp/manifest", { servers: {} })]);
    seed(d, "s_real", [ev("e1", "session/header", { parentSession: null }), ev("e2", "user/message", { content: [{ kind: "text", text: "真会话" }] })]);
    seed(d, "s_titled", [ev("e1", "session/label", { label: "起了名" })]);
    seed(d, "s_kid", [ev("e1", "session/header", { parentSession: "s_parent" })]);
    const out = sweepEmptySessions(d);
    expect(out.removed).toEqual(["s_shell"]);
    expect(existsSync(join(d, "s_shell"))).toBe(false);
    expect(existsSync(join(d, "s_real"))).toBe(true);
    expect(existsSync(join(d, "s_titled"))).toBe(true);
    expect(existsSync(join(d, "s_kid"))).toBe(true);
  });
  it("② 活锁跳过（他实例正开着这个空会话——pid 活着不清）、stale 锁照清、keep 豁免", () => {
    const d = fresh();
    const f = seed(d, "s_locked", [ev("e1", "mcp/manifest", { servers: {} })]);
    writeFileSync(join(d, "s_locked", "agents", "session.lock"), `${process.pid}\n2026-10-01T00:00:00Z\n`); // 本测试进程 = 活 pid
    seed(d, "s_stale", [ev("e1", "mcp/manifest", { servers: {} })]);
    writeFileSync(join(d, "s_stale", "agents", "session.lock"), "999999999\n2026-10-01T00:00:00Z\n"); // 已死 pid（ESRCH）
    seed(d, "s_keep", [ev("e1", "mcp/manifest", { servers: {} })]);
    const out = sweepEmptySessions(d, new Set(["s_keep"])); // --resume 目标豁免
    expect(out.locked).toEqual(["s_locked"]);
    expect(out.removed).toEqual(["s_stale"]);
    expect(existsSync(f)).toBe(true);
    expect(existsSync(join(d, "s_keep"))).toBe(true);
  });
  it("③ 空桶/不存在桶 = 空结果不炸", () => {
    const d = fresh();
    expect(sweepEmptySessions(join(d, "nope")).removed).toEqual([]);
  });
});
