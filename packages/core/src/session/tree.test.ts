import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionTree, readSessionHead } from "./tree.ts";
import { sqliteAvailable } from "./sqlite.ts";

let dir: string | undefined;
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-tree-")));
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

const ev = (id: string, type: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, id, parentId: null, seq: 1, ts: "2026-09-01T00:00:00Z", type, ...fields });

/** 新形态夹具：<bucket>/<sid>/agents/session.jsonl；返回主文件路径。 */
const seed = (bucketDir: string, sid: string, lines: string[]): string => {
  const agents = join(bucketDir, sid, "agents");
  mkdirSync(agents, { recursive: true });
  const file = join(agents, "session.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
};

describe("readSessionHead（预算读件下沉 core——T7）", () => {
  it("① 一次遍历出 parentSession/sourceEntryId/label（取最后）/firstUser（取首个）/ownLines（全行真值）", () => {
    const d = fresh();
    const f = seed(d, "s1", [
      ev("e1", "session/header", { parentSession: "s0" }),
      ev("e2", "session/fork", { sourceEntryId: "e0", parentSession: "s0" }),
      ev("e3", "user/message", { content: [{ kind: "text", text: "问一" }] }),
      ev("e4", "session/label", { label: "旧名" }),
      ev("e5", "session/label", { label: "新名" }),
    ]);
    const head = readSessionHead(f)!;
    expect(head.parentSession).toBe("s0");
    expect(head.sourceEntryId).toBe("e0");
    expect(head.label).toBe("新名"); // 取最后（/title 覆盖自动标题）
    expect(head.firstUser).toBe("问一");
    expect(head.ownLines).toBe(5); // 行数要真（设计空白 8——与预算独立）
  });

  it("② 根会话：parentSession = null、无 session/fork → sourceEntryId = null；label 缺省 undefined", () => {
    const d = fresh();
    const f = seed(d, "s_root", [ev("e1", "session/header", { parentSession: null }), ev("e2", "user/message", { content: [{ kind: "text", text: "根问" }] })]);
    const head = readSessionHead(f)!;
    expect(head.parentSession).toBeNull();
    expect(head.sourceEntryId).toBeNull();
    expect(head.label).toBeUndefined();
  });

  it("③ 文件不可读 → undefined（坏文件跳过不炸整体）", () => {
    expect(readSessionHead(join(fresh(), "nope", "agents", "session.jsonl"))).toBeUndefined();
  });

  it("④ 技能会话标题（2026-09-30 用户拍板）：首条消息是技能注入机器标记 → 「[技能] 名字 参数」，标记与正文都不上标题", () => {
    const d = fresh();
    const skillBody = (name: string, args?: string) =>
      `（用户通过菜单手动加载技能 "${name}"——请按该技能正文行事）\n<skill name="${name}"${args !== undefined ? ` args="${args}"` : ""}>\n# 技能正文一大堆\n不该当标题\n</skill>`;
    const f1 = seed(d, "s_skill", [
      ev("e1", "session/header", {}),
      ev("e2", "user/message", { content: [{ kind: "text", text: skillBody("doc-review", "2026-09-27-m4-3c-mcp-production.md 全量") }] }),
    ]);
    expect(readSessionHead(f1)!.firstUser).toBe("[技能] doc-review 2026-09-27-m4-3c-mcp-production.md 全量"); // 帽放宽到 60 后全显（行宽截断归显示侧）
    // 手敲形态（2026-09-30 二轮）：消息 = 原话行 + 标记 + 正文合成一条——标记行不在消息首也识别，原话行不上标题
    const f1b = seed(d, "s_skill_typed", [
      ev("e1", "session/header", {}),
      ev("e2", "user/message", { content: [{ kind: "text", text: `/skill : doc-review 参数甲 参数乙\n${skillBody("doc-review", "参数甲 参数乙")}` }] }),
    ]);
    expect(readSessionHead(f1b)!.firstUser).toBe("[技能] doc-review 参数甲 参数乙");
    // 60 帽仍守住：超长参数截断且不带尾随空格
    const longArgs = "长".repeat(80);
    const f1c = seed(d, "s_skill_long", [
      ev("e1", "session/header", {}),
      ev("e2", "user/message", { content: [{ kind: "text", text: skillBody("x".repeat(30), longArgs) }] }),
    ]);
    expect(readSessionHead(f1c)!.firstUser).toBe(`[技能] ${"x".repeat(30)} ${"长".repeat(24)}`);
    const f2 = seed(d, "s_skill_old", [
      ev("e1", "session/header", {}),
      ev("e2", "user/message", { content: [{ kind: "text", text: skillBody("ask-matt") }] }),
    ]);
    expect(readSessionHead(f2)!.firstUser).toBe("[技能] ask-matt"); // 老形态无参数只显名字
    const f3 = seed(d, "s_plain", [
      ev("e1", "session/header", {}),
      ev("e2", "user/message", { content: [{ kind: "text", text: "普通提问照旧" }] }),
    ]);
    expect(readSessionHead(f3)!.firstUser).toBe("普通提问照旧"); // 非技能消息不受影响
  });
});

describe("buildSessionTree（T7——当前项目桶全量树快照，jsonl 读法）", () => {
  it("① 两层树快照字段齐：根/子节点七字段、ownEvents = 实际行数、时间戳为数值", async () => {
    const d = fresh();
    seed(d, "s_root", [ev("e1", "session/header", { parentSession: null }), ev("e2", "user/message", { content: [{ kind: "text", text: "问" }] }), ev("e3", "session/label", { label: "根会话" })]);
    seed(d, "s_kid", [ev("k1", "session/header", { parentSession: "s_root" }), ev("k2", "session/fork", { sourceEntryId: "e2", parentSession: "s_root" }), ev("k3", "user/message", { content: [{ kind: "text", text: "子问" }] })]);
    const nodes = await buildSessionTree(d);
    expect(nodes).toHaveLength(2);
    const root = nodes.find((n) => n.sessionId === "s_root")!;
    expect(root).toMatchObject({ parentSession: null, sourceEntryId: null, label: "根会话", ownEvents: 3 });
    const kid = nodes.find((n) => n.sessionId === "s_kid")!;
    expect(kid).toMatchObject({ parentSession: "s_root", sourceEntryId: "e2", ownEvents: 3 });
    expect(kid.label).toBeUndefined(); // 未命名 = undefined（契约：显示侧自定「新会话」）
    expect(typeof root.createdAtMs).toBe("number");
    expect(typeof root.updatedAtMs).toBe("number");
  });

  it("② 孤立节点保留（父指向不在扫描集的 sid——原样返回不修复不剔除）", async () => {
    const d = fresh();
    seed(d, "s_orphan", [ev("k1", "session/header", { parentSession: "s_gone" }), ev("k2", "session/fork", { sourceEntryId: "x", parentSession: "s_gone" })]);
    const nodes = await buildSessionTree(d);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ sessionId: "s_orphan", parentSession: "s_gone" });
  });

  it("③ 平铺遗留不进树（拍板钉——T2 扫描只认新形态）；空桶 → 空树", async () => {
    const d = fresh();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "s_flat.jsonl"), `${ev("e1", "session/header", { parentSession: null })}\n`);
    expect(await buildSessionTree(d)).toEqual([]);
    const empty = fresh();
    expect(await buildSessionTree(empty)).toEqual([]);
  });
});

describe("sqlite 后端树快照读法（会话树批 T8——混合后端同树共览）", () => {
  it.skipIf(!sqliteAvailable())("① sqlite 会话进树且字段与 jsonl 同构（header/fork/label/COUNT 四查）", async () => {
    const d = fresh();
    const { SqliteSessionStore } = await import("./sqlite.ts");
    const root = new SqliteSessionStore({ dir: d, sessionId: "s_root" });
    await root.append("session/header", { format: 1, cwd: d, parentSession: null });
    await root.append("user/message", { content: [{ kind: "text", text: "根问" }] });
    await root.close();
    const kid = new SqliteSessionStore({ dir: d, sessionId: "s_kid" });
    await kid.append("session/header", { format: 1, cwd: d, parentSession: "s_root" });
    await kid.append("session/fork", { sourceEntryId: "e-x", parentSession: "s_root" });
    await kid.append("session/label", { label: "子枝名" });
    await kid.close();
    const nodes = await buildSessionTree(d);
    expect(nodes).toHaveLength(2);
    expect(nodes.find((n) => n.sessionId === "s_root")).toMatchObject({ parentSession: null, sourceEntryId: null, ownEvents: 2 });
    expect(nodes.find((n) => n.sessionId === "s_kid")).toMatchObject({ parentSession: "s_root", sourceEntryId: "e-x", label: "子枝名", ownEvents: 3 });
  });

  it.skipIf(!sqliteAvailable())("② 混合后端目录同树共览（jsonl 根 + sqlite 子同桶一树）", async () => {
    const d = fresh();
    const { SqliteSessionStore } = await import("./sqlite.ts");
    seed(d, "s_j", [ev("e1", "session/header", { parentSession: null })]);
    const sq = new SqliteSessionStore({ dir: d, sessionId: "s_q" });
    await sq.append("session/header", { format: 1, cwd: d, parentSession: "s_j" });
    await sq.close();
    const nodes = await buildSessionTree(d);
    expect(nodes.map((n) => n.sessionId).sort()).toEqual(["s_j", "s_q"]);
  });

  it.skipIf(!sqliteAvailable())("③ 损坏库跳过不炸整体（垃圾 .sqlite 文件 → 该节点缺席、他节点照常）", async () => {
    const d = fresh();
    const agents = join(d, "s_bad", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "session.sqlite"), "this is not a sqlite database at all\n");
    seed(d, "s_ok", [ev("e1", "session/header", { parentSession: null })]);
    const nodes = await buildSessionTree(d);
    expect(nodes.map((n) => n.sessionId)).toEqual(["s_ok"]); // 坏库节点跳过、好节点照常
  });

  it.skipIf(!sqliteAvailable())("④ CS-09（2026-09-28 code review）：readSqliteHead 走 openSessionDbReadOnly（busy_timeout 5000 对齐 store + readOnly 优先/回退兜底）——clean-close（无 -wal/-shm）与活实例两形态节点都不缺席", async () => {
    const d = fresh();
    const { SqliteSessionStore } = await import("./sqlite.ts");
    // 形态一：clean close 后 -wal/-shm 已清——只读开库若撞 WAL 只读限制必须回退读写开（节点不得缺席）
    const a = new SqliteSessionStore({ dir: d, sessionId: "s_closed" });
    await a.append("session/header", { format: 1, cwd: d, parentSession: null });
    await a.append("session/label", { label: "关过的" });
    await a.close();
    expect(existsSync(join(d, "s_closed", "agents", "session.sqlite-wal"))).toBe(false); // 前提钉：clean close 无 WAL 残留
    // 形态二：活实例（句柄在场、可能正被写）——树刷新与之并发（旧实现裸开库无 busy_timeout，撞
    // checkpoint/恢复窗口 SQLITE_BUSY → 该节点静默缺席本次快照）
    const b = new SqliteSessionStore({ dir: d, sessionId: "s_live" });
    await b.append("session/header", { format: 1, cwd: d, parentSession: null });
    await b.append("session/label", { label: "活着的" });
    const nodes = await buildSessionTree(d);
    expect(nodes.find((n) => n.sessionId === "s_closed")?.label).toBe("关过的");
    expect(nodes.find((n) => n.sessionId === "s_live")?.label).toBe("活着的");
    await b.close();
  });
});
