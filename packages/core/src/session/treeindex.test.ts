import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TreeIndex } from "./treeindex.ts";

let dir: string | undefined;
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-treeindex-")));
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

const ev = (id: string, type: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, id, parentId: null, seq: 1, ts: "2026-09-01T00:00:00Z", type, ...fields });

/** 新形态夹具：<root>/<bucket>/<sid>/agents/session.jsonl。 */
const seed = (root: string, bucket: string, sid: string, lines: string[]): string => {
  const agents = join(root, bucket, sid, "agents");
  mkdirSync(agents, { recursive: true });
  const file = join(agents, "session.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
};

describe("TreeIndex（会话树批 T9——~/.orosus/db/session-tree.sqlite 持久缓存）", () => {
  it("① 首用建目录建库；refresh 出全量节点（桶过滤返回）", async () => {
    const root = fresh();
    seed(root, "B-one", "s_a", [ev("e1", "session/header", { parentSession: null }), ev("e2", "session/label", { label: "甲" })]);
    seed(root, "B-two", "s_b", [ev("e1", "session/header", { parentSession: null })]);
    const file = join(root, "db", "session-tree.sqlite"); // 首用懒建目录
    const idx = new TreeIndex({ file });
    const all = await idx.refresh(root);
    expect(all).toHaveLength(2);
    const one = await idx.refresh(root, { bucket: "B-one" }); // #17：查询按桶过滤
    expect(one.map((n) => n.sessionId)).toEqual(["s_a"]);
    expect(all.find((n) => n.sessionId === "s_a")!.label).toBe("甲");
  });

  it("② 二刷命中缓存：mtime+size 未变 → 内容变化不被读（铁证 = 拨回 mtime 的同尺寸改写不刷新）", async () => {
    const root = fresh();
    const f = seed(root, "B", "s_x", [ev("e1", "session/header", { parentSession: null }), ev("e2", "session/label", { label: "旧名" })]);
    const st0 = { mtime: new Date(), atime: new Date() };
    utimesSync(f, st0.atime, st0.mtime); // 钉住 mtime
    const idx = new TreeIndex({ file: join(root, "db", "t.sqlite") });
    await idx.refresh(root);
    // 同字节数改写 + mtime 拨回原值 → 双判据都命中缓存 → 新内容不可见（没重读源）
    writeFileSync(f, [ev("e1", "session/header", { parentSession: null }), ev("e2", "session/label", { label: "新名" })].join("\n") + "\n");
    utimesSync(f, st0.atime, st0.mtime);
    const nodes = await idx.refresh(root);
    expect(nodes.find((n) => n.sessionId === "s_x")!.label).toBe("旧名"); // 命中缓存铁证
  });

  it("③ 源文件变更（mtime 变）→ 增量刷新该节点", async () => {
    const root = fresh();
    const f = seed(root, "B", "s_y", [ev("e1", "session/header", { parentSession: null }), ev("e2", "session/label", { label: "一步" })]);
    const idx = new TreeIndex({ file: join(root, "db", "t.sqlite") });
    await idx.refresh(root);
    writeFileSync(f, [ev("e1", "session/header", { parentSession: null }), ev("e2", "session/label", { label: "二步" })].join("\n") + "\n"); // mtime 自然前进
    const nodes = await idx.refresh(root);
    expect(nodes.find((n) => n.sessionId === "s_y")!.label).toBe("二步");
  });

  it("④ 会话删除后行清理（盘上不在 → 返回缺席且不复活）", async () => {
    const root = fresh();
    seed(root, "B", "s_gone", [ev("e1", "session/header", { parentSession: null })]);
    seed(root, "B", "s_keep", [ev("e1", "session/header", { parentSession: null })]);
    const idx = new TreeIndex({ file: join(root, "db", "t.sqlite") });
    await idx.refresh(root);
    rmSync(join(root, "B", "s_gone"), { recursive: true, force: true });
    const nodes = await idx.refresh(root);
    expect(nodes.map((n) => n.sessionId).sort()).toEqual(["s_keep"]);
  });

  it("⑤ 坏库删重建：垃圾库文件 → refresh 照常出节点（fail-open），且库被重建为有效库（下次走缓存路径）", async () => {
    const root = fresh();
    seed(root, "B", "s_ok", [ev("e1", "session/header", { parentSession: null }), ev("e2", "session/label", { label: "名" })]);
    const file = join(root, "db", "t.sqlite");
    mkdirSync(join(root, "db"), { recursive: true });
    writeFileSync(file, "garbage not a sqlite db");
    const idx = new TreeIndex({ file });
    const nodes = await idx.refresh(root);
    expect(nodes.map((n) => n.sessionId)).toEqual(["s_ok"]); // 不阻塞 tree()（全局约束 8）
    // 库已重建：同判据二刷命中缓存（mtime/size 未变 → 拨回改写不刷新，证明读的是重建库里的缓存行）
    const f = join(root, "B", "s_ok", "agents", "session.jsonl");
    const st0 = { mtime: new Date(), atime: new Date() };
    utimesSync(f, st0.atime, st0.mtime);
    await idx.refresh(root);
    writeFileSync(f, [ev("e1", "session/header", { parentSession: null }), ev("e2", "session/label", { label: "变" })].join("\n") + "\n");
    utimesSync(f, st0.atime, st0.mtime);
    const again = await idx.refresh(root);
    expect(again.find((n) => n.sessionId === "s_ok")!.label).toBe("名");
  });

  it("⑥ 探针注入不可用 → 降级纯读（不建库不碰库，直读源出节点）", async () => {
    const root = fresh();
    seed(root, "B", "s_p", [ev("e1", "session/header", { parentSession: null }), ev("e2", "session/label", { label: "纯读" })]);
    const file = join(root, "db", "t.sqlite");
    const idx = new TreeIndex({ file, probe: () => false });
    const nodes = await idx.refresh(root);
    expect(nodes.find((n) => n.sessionId === "s_p")!.label).toBe("纯读");
  });

  it("⑦ harness 集成：h.tree() 走索引路径出当前桶节点（treeIndexFile 注入密封；索引全域维护、查询按桶）", async () => {
    const { createHarness } = await import("../index.ts");
    const { fakeProviderModule } = await import("@orosus/testing");
    const root = fresh();
    seed(root, "B-mine", "s_m", [ev("e1", "session/header", { parentSession: null }), ev("e2", "session/label", { label: "我的" })]);
    seed(root, "B-other", "s_o", [ev("e1", "session/header", { parentSession: null })]);
    const h = await createHarness({
      cwd: root,
      sessionsDir: join(root, "B-mine"),
      sessionsRoot: root,
      treeIndexFile: join(root, "db", "t.sqlite"), // 密封注入（缺省 ~/.orosus/db/）
      diagDir: root,
      spillDir: join(root, "spill"),
      modules: [fakeProviderModule("fake", [])],
      config: { userFile: join(root, "u.toml"), projectFile: join(root, "p.toml"), env: {}, cliOverrides: { model: "fake/x" } },
      discovery: { userDir: join(root, "m"), projectDir: join(root, "pm"), trustFile: join(root, "t.json") },
      secretsFile: join(root, "s.env"),
    });
    const nodes = await h.tree();
    expect(nodes.map((n) => n.sessionId)).toEqual(["s_m"]); // #17：只出当前桶（他桶 s_o 不进）
    expect(nodes[0]!.label).toBe("我的");
    expect((await h.tree()).map((n) => n.sessionId)).toEqual(["s_m"]); // 二刷命中缓存路径不炸
    await h.close();
  });
});
