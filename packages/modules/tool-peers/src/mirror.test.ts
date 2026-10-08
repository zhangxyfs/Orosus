import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractProjectCwd, heuristicWinPath, importMirror, scanMirrorSources, type MirrorBucket } from "./mirror.ts";
import { zcodeBucketKey } from "./importers.ts";
import { memoryBucketKey } from "./roots.ts";
import { listNotes } from "./memstore.ts";

// node:sqlite 经 createRequire 加载（vitest/vite 会改写 await import("node:sqlite")——core sqlite.ts 同款纪律）
const nodeSqlite = (() => { try { return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite"); } catch { return undefined; } })();

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "peers-mirror-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const sha1hex16 = (p: string): string => createHash("sha1").update(p).digest("hex").slice(0, 16);
const note = (dir: string, name = "n.md"): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "---\nname: N\ndescription: d\n---\n\nx\n");
};
const sessionLine = (cwd: string, extra = ""): string =>
  `{"v":1,"ts":"2026-10-08T00:00:00Z","cwd":${JSON.stringify(cwd)}${extra}}\n`;

describe("extractProjectCwd（G13：头 8KB 窗口 · 3 文件上限 · 单一值才采纳）", () => {
  it("首个 cwd 字段采纳（cc/qwen 会话 jsonl 共用）", () => {
    const f = join(root, "a.jsonl");
    writeFileSync(f, sessionLine("D:\\proj\\one"));
    expect(extractProjectCwd([f])).toEqual({ cwd: "D:\\proj\\one", conflict: false });
  });
  it("8KB 窗口：cwd 在 9KB 处读不到（绝不整读大文件）", () => {
    const f = join(root, "big.jsonl");
    writeFileSync(f, `${"x".repeat(9_000)}\n${sessionLine("D:\\far\\away")}`);
    expect(extractProjectCwd([f])).toEqual({ conflict: false });
  });
  it("3 文件上限（G13，scan 层候选截断）：cwd 只在第 4 个文件（排序后）→ 零 cwd 处理", () => {
    const proj = join(root, "claude", "projects", "Q--zz-limit-probe");
    note(join(proj, "memory"));
    for (const n of ["s1", "s2", "s3"]) writeFileSync(join(proj, `${n}.jsonl`), "no cwd\n");
    writeFileSync(join(proj, "s4.jsonl"), sessionLine("D:\\only\\in\\fourth"));
    const buckets = scanMirrorSources({ claude: join(root, "claude") });
    expect(buckets[0]).toMatchObject({ projectPath: undefined, how: "unresolved" });   // 若读了第 4 个 = session-cwd 命中
  });
  it("多文件 cwd 去重后多于一个 → conflict（G13：键碰撞/多项目混装——绝不猜着写桶）", () => {
    const a = join(root, "a.jsonl"), b = join(root, "b.jsonl");
    writeFileSync(a, sessionLine("D:\\proj\\one"));
    writeFileSync(b, sessionLine("D:\\proj\\two"));
    expect(extractProjectCwd([a, b])).toEqual({ conflict: true });
  });
  it("无 cwd 字段的文件跳过不计；读不开的文件跳过", () => {
    const a = join(root, "a.jsonl"), b = join(root, "gone.jsonl");
    writeFileSync(a, "no cwd\n");
    expect(extractProjectCwd([a, b])).toEqual({ conflict: false });
  });
});

describe("heuristicWinPath（G14：仅 win、仅 cc——'-' 两义枚举 + 验盘唯一存在）", () => {
  const fakeExists = (paths: string[]) => (p: string): boolean => paths.includes(p);
  it.skipIf(process.platform !== "win32")("唯一磁盘存在解读命中（分隔符解读）", () => {
    const hit = heuristicWinPath("D--develop-Orosus", fakeExists(["D:\\develop\\Orosus"]));
    expect(hit).toBe("D:\\develop\\Orosus");
  });
  it.skipIf(process.platform !== "win32")("字面量连字符解读命中（另一解读盘上不存在）", () => {
    const hit = heuristicWinPath("D--my-proj", fakeExists(["D:\\my-proj"]));
    expect(hit).toBe("D:\\my-proj");
  });
  it.skipIf(process.platform !== "win32")("零命中 → undefined；多命中 → undefined；形态不合 → undefined", () => {
    expect(heuristicWinPath("D--nowhere-at-all", fakeExists([]))).toBeUndefined();
    expect(heuristicWinPath("D--a-b", fakeExists(["D:\\a\\b", "D:\\a-b"]))).toBeUndefined();
    expect(heuristicWinPath("not-a-win-dir", fakeExists(["C:\\x"]))).toBeUndefined();
  });
  it.skipIf(process.platform !== "win32")("k>4 截断 → undefined（组合爆炸纪律）", () => {
    expect(heuristicWinPath("D--a-b-c-d-e-f", fakeExists(["D:\\a\\b\\c\\d\\e\\f"]))).toBeUndefined();
  });
});

describe("scanMirrorSources · cc 三级（session-cwd → win 启发式 → unresolved）", () => {
  it("session-cwd 命中：项目目录下会话 jsonl 带 cwd", () => {
    const proj = join(root, "claude", "projects", "D--develop-FakeProj");
    note(join(proj, "memory"));
    writeFileSync(join(proj, "s1.jsonl"), sessionLine("D:\\develop\\FakeProj"));
    const buckets = scanMirrorSources({ claude: join(root, "claude") });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ sourceId: "claude-code", projectPath: "D:\\develop\\FakeProj", how: "session-cwd", noteCount: 1 });
  });
  it("G13 多值冲突 → 直 unresolved（不落启发式——第三轮 doc-review 定案）", () => {
    const proj = join(root, "claude", "projects", "D--develop-Orosus");
    note(join(proj, "memory"));
    writeFileSync(join(proj, "a.jsonl"), sessionLine("D:\\proj\\one"));
    writeFileSync(join(proj, "b.jsonl"), sessionLine("D:\\proj\\two"));
    const buckets = scanMirrorSources({ claude: join(root, "claude") });
    expect(buckets[0]).toMatchObject({ projectPath: undefined, how: "unresolved" });
  });
  it.skipIf(process.platform !== "win32")("零 cwd 可得 → win 启发式（Q 盘不存在 → 零命中 unresolved）", () => {
    const proj = join(root, "claude", "projects", "Q--definitely-missing-proj");
    note(join(proj, "memory"));
    const buckets = scanMirrorSources({ claude: join(root, "claude") });
    expect(buckets[0]).toMatchObject({ projectPath: undefined, how: "unresolved" });
  });
  it("空桶（无 .md）不出列", () => {
    mkdirSync(join(root, "claude", "projects", "D--empty", "memory"), { recursive: true });
    expect(scanMirrorSources({ claude: join(root, "claude") })).toEqual([]);
  });
});

describe("scanMirrorSources · qwen 两级（session-cwd → unresolved，无启发式）", () => {
  it("chats/ 会话 jsonl 带 cwd 命中", () => {
    const proj = join(root, "qwen", "projects", "d--develop-fakeproj");
    note(join(proj, "memory"));
    mkdirSync(join(proj, "chats"), { recursive: true });
    writeFileSync(join(proj, "chats", "c1.jsonl"), sessionLine("D:\\develop\\FakeProj"));
    const buckets = scanMirrorSources({ qwen: join(root, "qwen") });
    expect(buckets[0]).toMatchObject({ sourceId: "qwen", projectPath: "D:\\develop\\FakeProj", how: "session-cwd" });
  });
  it("无会话文件 → unresolved（键全小写不可逆——G14：qwen 不做目录名启发式）", () => {
    const proj = join(root, "qwen", "projects", "d--develop-orosus");
    note(join(proj, "memory"));
    const buckets = scanMirrorSources({ qwen: join(root, "qwen") });
    expect(buckets[0]).toMatchObject({ projectPath: undefined, how: "unresolved" });
  });
});

describe("scanMirrorSources · zcode（session.directory 正向重算键精确匹配）", () => {
  it.skipIf(nodeSqlite === undefined)("db 命中：桶名 = zcodeBucketKey(directory)", () => {
    const dirs = ["D:\\develop\\Orosus", "D:\\develop\\OpenKnowledge"];
    const dbDir = join(root, "zcode", "cli", "db");
    mkdirSync(dbDir, { recursive: true });
    const db = new nodeSqlite!.DatabaseSync(join(dbDir, "db.sqlite"));
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)");
    for (const [i, d] of dirs.entries()) db.prepare("INSERT INTO session (id, directory) VALUES (?, ?)").run(`s${i}`, d);
    db.close();
    for (const d of dirs) note(join(root, "zcode", "cli", "memories", "projects", zcodeBucketKey(d), "memory"));
    const buckets = scanMirrorSources({ zcode: join(root, "zcode") });
    expect(buckets).toHaveLength(2);
    for (const b of buckets) {
      expect(b.how).toBe("session-db");
      expect(b.projectPath).toBeDefined();
      expect(zcodeBucketKey(b.projectPath!)).toBe(b.sourceDir.split(/[\\/]/).at(-2));   // 桶名 = 键重算
    }
  });
  it("db 缺失 → 全桶 unresolved（try-catch 包死）", () => {
    note(join(root, "zcode", "cli", "memories", "projects", zcodeBucketKey("D:\\develop\\Orosus"), "memory"));
    const buckets = scanMirrorSources({ zcode: join(root, "zcode") });
    expect(buckets[0]).toMatchObject({ how: "unresolved", projectPath: undefined });
  });
});

describe("scanMirrorSources · reasonix（sessions 扁平键反推 → sha1 匹配）", () => {
  it("sessions-dir 命中：`X_rest` → `X:\\rest` 枚举解读正向算 sha1 匹配桶名", () => {
    const proj = "D:\\develop\\DeepSeek-Reasonix";
    note(join(root, "reasonix", "memory", sha1hex16(proj)));
    mkdirSync(join(root, "reasonix", "sessions", "D_develop_DeepSeek-Reasonix"), { recursive: true });
    const buckets = scanMirrorSources({ reasonix: join(root, "reasonix") });
    expect(buckets[0]).toMatchObject({ sourceId: "reasonix", projectPath: proj, how: "sessions-dir" });
  });
  it("歧义候选 miss 不误配：字面量 `_` 解读才中、分隔符解读的 sha1 不中", () => {
    const proj = "D:\\my_proj";   // sessions 键 D_my_proj 的另一种解读是 D:\my\proj
    note(join(root, "reasonix", "memory", sha1hex16(proj)));
    mkdirSync(join(root, "reasonix", "sessions", "D_my_proj"), { recursive: true });
    const buckets = scanMirrorSources({ reasonix: join(root, "reasonix") });
    expect(buckets[0]).toMatchObject({ projectPath: "D:\\my_proj", how: "sessions-dir" });
    expect(sha1hex16("D:\\my\\proj")).not.toBe(sha1hex16(proj));   // 前提：两解读键确不同
  });
  it("sessions/ 缺失或无目录（散 jsonl 不参与）→ 全桶 unresolved", () => {
    note(join(root, "reasonix", "memory", sha1hex16("D:\\x")));
    mkdirSync(join(root, "reasonix", "sessions"), { recursive: true });
    writeFileSync(join(root, "reasonix", "sessions", "D_x.jsonl"), "loose file\n");
    expect(scanMirrorSources({ reasonix: join(root, "reasonix") })[0]).toMatchObject({ how: "unresolved" });
    expect(scanMirrorSources({ reasonix: join(root, "nowhere") })).toEqual([]);
  });
  it("memory/global 全局位跳过（方案「不做」——不混进 unresolved 报数）", () => {
    note(join(root, "reasonix", "memory", "global"));
    const proj = "D:\\some\\proj";
    note(join(root, "reasonix", "memory", sha1hex16(proj)));
    mkdirSync(join(root, "reasonix", "sessions", "D_some_proj"), { recursive: true });
    const buckets = scanMirrorSources({ reasonix: join(root, "reasonix") });
    expect(buckets).toHaveLength(1);   // global 不出列
    expect(buckets[0]).toMatchObject({ projectPath: proj, how: "sessions-dir" });
  });
});

describe("importMirror（T4：多桶各归各 + unresolved 跳过报数 + 强停后续桶不跑）", () => {
  const bucket = (sourceDir: string, projectPath: string | undefined, n = 1): MirrorBucket => ({
    sourceId: "claude-code", sourceDir, projectPath,
    how: projectPath === undefined ? "unresolved" : "session-cwd", noteCount: n,
  });
  it("多桶各归各：桶 A 笔记落桶 A 键目录（memoryBase/<memoryBucketKey>/memory）", async () => {
    const base = join(root, "memories", "projects");
    const srcA = join(root, "srcA"), srcB = join(root, "srcB");
    note(srcA, "a.md");
    note(srcB, "b.md");
    const projA = "D:\\works\\alpha", projB = "D:\\works\\beta";
    const r = await importMirror(base, [bucket(srcA, projA), bucket(srcB, projB)]);
    expect(r).toEqual({ projects: 2, imported: 2, updated: 0, skipped: 0, unresolved: 0 });
    expect(listNotes(join(base, memoryBucketKey(projA), "memory")).map(n => n.title)).toEqual(["N"]);
    expect(listNotes(join(base, memoryBucketKey(projB), "memory"))).toHaveLength(1);
    expect(memoryBucketKey(projA)).not.toBe(memoryBucketKey(projB));   // 前提：两项目不同桶
  });
  it("unresolved 跳过并计数；onProject 前置（第 N/共 M）", async () => {
    const base = join(root, "memories", "projects");
    const srcA = join(root, "srcA"), srcUnknown = join(root, "srcU");
    note(srcA); note(srcUnknown);
    const ticks: [number, number, string][] = [];
    const r = await importMirror(base, [bucket(srcUnknown, undefined), bucket(srcA, "D:\\works\\alpha")], {
      onProject: (done, total, label) => ticks.push([done, total, label]),
    });
    expect(r).toEqual({ projects: 1, imported: 1, updated: 0, skipped: 0, unresolved: 1 });   // unresolved 桶不进 onProject 序列
    expect(ticks).toEqual([[1, 1, "D:\\works\\alpha"]]);
    expect(listNotes(join(base, memoryBucketKey("D:\\works\\alpha"), "memory"))).toHaveLength(1);
  });
  it("强停：当前桶硬中断 + 后续桶不跑（走查十二-④ 同语义）", async () => {
    const base = join(root, "memories", "projects");
    const srcA = join(root, "srcA"), srcB = join(root, "srcB");
    note(srcA); note(srcB);
    const ac = new AbortController();
    const seen: string[] = [];
    const r = await importMirror(base, [bucket(srcA, "D:\\works\\alpha"), bucket(srcB, "D:\\works\\beta")], {
      onProject: (done, _total, label) => { seen.push(label); if (done === 1) ac.abort(); },   // 第 1 桶开搬即停
      signal: ac.signal,
    });
    expect(seen).toEqual(["D:\\works\\alpha"]);   // 第 2 桶没跑
    expect(r.projects).toBe(1);
    expect(listNotes(join(base, memoryBucketKey("D:\\works\\beta"), "memory"))).toHaveLength(0);
  });
});
