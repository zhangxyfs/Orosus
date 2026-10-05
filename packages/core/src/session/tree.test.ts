import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionTree, countNewlines, readSessionHead } from "./tree.ts";
import { sqliteAvailable } from "./sqlite.ts";

// T2（m5-resume-perf）读法审计：node:fs ESM 命名空间不可 spyOn，部分替换 mock 拦截 readFileSync——
// 包装 actual 行为零变化，仅多记账（断言「读全文但不带 encoding=Buffer、未做全量 utf8 decode」）。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

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
    // 夹具对齐 skillInjectText 真实输出（2026-10-01 修）：file 属性必随（940ef4e 起恒在、排在 args 后）——
    // 旧夹具无 file，掩盖了「正则以 > 收尾遇追加属性即失配、参数全体丢显」的实机坑（用户会话列表只见
    // [技能] doc-review 不见参数）；file 省略 = 2026-10-01 前老会话形态
    const skillBody = (name: string, args?: string, file?: string) =>
      `（用户通过菜单手动加载技能 "${name}"——请按该技能正文行事）\n<skill name="${name}"${args !== undefined ? ` args="${args}"` : ""}${file === undefined ? "" : ` file="${file}"`}>\n# 技能正文一大堆\n不该当标题\n</skill>`;
    const f1 = seed(d, "s_skill", [
      ev("e1", "session/header", {}),
      ev("e2", "user/message", { content: [{ kind: "text", text: skillBody("doc-review", "2026-09-27-m4-3c-mcp-production.md 全量", "C:\\skills\\doc-review\\SKILL.md") }] }),
    ]);
    expect(readSessionHead(f1)!.firstUser).toBe("[技能] doc-review 2026-09-27-m4-3c-mcp-production.md 全量"); // 帽放宽到 60 后全显（行宽截断归显示侧）
    // 手敲形态（2026-09-30 二轮 + 2026-10-01 实机坑回归钉）：消息 = 标记 + 原话行 + <skill> 合成一条、
    // file 恒在场——参数必须上标题（实机见「[技能] doc-review」丢参，正则失配根因）
    const f1b = seed(d, "s_skill_typed", [
      ev("e1", "session/header", {}),
      ev("e2", "user/message", { content: [{ kind: "text", text: `（用户通过菜单手动加载技能 "doc-review"——请按该技能正文行事）\n/skill : doc-review 2026-09-30-m5-media-multimedia.md 全量\n<skill name="doc-review" args="2026-09-30-m5-media-multimedia.md 全量" file="C:\\Users\\Administrator\\.agents\\skills\\doc-review\\SKILL.md">\n# 技能正文\n</skill>` }] }),
    ]);
    expect(readSessionHead(f1b)!.firstUser).toBe("[技能] doc-review 2026-09-30-m5-media-multimedia.md 全量");
    // 60 帽仍守住：超长参数截断且不带尾随空格
    const longArgs = "长".repeat(80);
    const f1c = seed(d, "s_skill_long", [
      ev("e1", "session/header", {}),
      ev("e2", "user/message", { content: [{ kind: "text", text: skillBody("x".repeat(30), longArgs, "C:\\s\\SKILL.md") }] }),
    ]);
    expect(readSessionHead(f1c)!.firstUser).toBe(`[技能] ${"x".repeat(30)} ${"长".repeat(24)}`);
    const f2 = seed(d, "s_skill_old", [
      ev("e1", "session/header", {}),
      ev("e2", "user/message", { content: [{ kind: "text", text: skillBody("ask-matt") }] }),
    ]);
    expect(readSessionHead(f2)!.firstUser).toBe("[技能] ask-matt"); // 老形态无参数只显名字
    // 新形态无参数（菜单 Enter：file 在场无 args）——不显幻影参数
    const f2b = seed(d, "s_skill_noargs", [
      ev("e1", "session/header", {}),
      ev("e2", "user/message", { content: [{ kind: "text", text: skillBody("ask-matt", undefined, "C:\\skills\\ask-matt\\SKILL.md") }] }),
    ]);
    expect(readSessionHead(f2b)!.firstUser).toBe("[技能] ask-matt");
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

describe("T2 m5-resume-perf: readSessionHead 字节级行数（/sessions 列表免全文件 utf8 decode）", () => {
  it("countNewlines：\n 计数 + 末行无 \n 补 1（语义=行数非换行符数；多字节不炸）", () => {
    expect(countNewlines(Buffer.from("a\nb\nc"))).toBe(3);
    expect(countNewlines(Buffer.from("a\nb\nc\n"))).toBe(3);
    expect(countNewlines(Buffer.from(""))).toBe(0);
    expect(countNewlines(Buffer.from("中文一行\n第二行"))).toBe(2);
    expect(countNewlines(Buffer.from("\n"))).toBe(1); // 单换行 = 一空行内容——计数口径从字节层出发
  });

  it("2MB 预算外大文件：ownLines 全行真值 + 元数据仍正确（预算内行才 decode）", () => {
    const d = fresh();
    const filler = JSON.stringify({ v: 1, id: "e_fill", parentId: null, seq: 9, ts: "t", type: "assistant/chunk", chunk: { type: "text", text: "x".repeat(200) } });
    const lines = [
      ev("e1", "session/header", { parentSession: null }),
      ev("e2", "user/message", { content: [{ kind: "text", text: "大问" }] }),
      ev("e3", "session/label", { label: "大标题" }),
      ...Array(10000).fill(filler),
    ];
    const f = seed(d, "s_big", lines);
    const h = readSessionHead(f)!;
    expect(h.ownLines).toBe(lines.length); // 行数要真——10003 行
    expect(h.label).toBe("大标题");
    expect(h.firstUser).toBe("大问");
    expect(h.parentSession).toBeNull();
  });

  it("对照钉：与旧 utf8 split 全读法 deep equal（同一文件两读法同果）", () => {
    const d = fresh();
    const lines = [
      ev("e1", "session/header", { parentSession: "s0" }),
      ev("e2", "session/fork", { sourceEntryId: "e0", parentSession: "s0" }),
      ev("e3", "user/message", { content: [{ kind: "text", text: "对照问" }] }),
      ev("e4", "session/label", { label: "对照名" }),
      ev("e5", "assistant/message", { content: [{ kind: "text", text: "答" }] }),
    ];
    const f = seed(d, "s_cmp", lines);
    // 旧实现 oracle（改前原文内联——utf8 全读 + 非空行 split）
    const raw = readFileSync(f, "utf8");
    const allLines = raw.split("\n").filter((l) => l !== "");
    const oracle = { ownLines: allLines.length, sourceEntryId: null } as Record<string, unknown>;
    let n = 0;
    let bytes = 0;
    for (const line of allLines) {
      n++;
      bytes += line.length;
      if (n > 64 || bytes > 16 * 1024) break;
      let e: Record<string, unknown>;
      try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (e.type === "session/header" && oracle.parentSession === undefined) oracle.parentSession = typeof e.parentSession === "string" ? e.parentSession : null;
      if (e.type === "session/fork") oracle.sourceEntryId = typeof e.sourceEntryId === "string" ? e.sourceEntryId : null;
      if (e.type === "session/label" && typeof e.label === "string" && e.label !== "") oracle.label = e.label;
      if (oracle.firstUser === undefined && e.type === "user/message") {
        const parts = (e.content ?? []) as { kind?: string; text?: string }[];
        const t = parts.filter((p) => p.kind !== "reasoning").map((p) => p.text ?? "").join("").replace(/\s+/g, " ").trim();
        if (t !== "") oracle.firstUser = t.slice(0, 60);
      }
    }
    const h = readSessionHead(f)!;
    expect({ label: h.label, firstUser: h.firstUser, parentSession: h.parentSession, sourceEntryId: h.sourceEntryId, ownLines: h.ownLines })
      .toEqual({ label: oracle.label, firstUser: oracle.firstUser, parentSession: oracle.parentSession, sourceEntryId: oracle.sourceEntryId, ownLines: oracle.ownLines });
  });

  it("readFileSync 不带 encoding 调用（拿 Buffer 走字节层——全量 utf8 decode 不再发生）", () => {
    const d = fresh();
    const f = seed(d, "s_enc", [ev("e1", "session/header", { parentSession: null }), ev("e2", "user/message", { content: [{ kind: "text", text: "编码" }] })]);
    vi.mocked(readFileSync).mockClear();
    readSessionHead(f);
    const calls = vi.mocked(readFileSync).mock.calls.filter((c) => c[0] === f);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBeUndefined(); // 无 encoding 参数 = Buffer 读（T2 前 = "utf8"）
  });
});
