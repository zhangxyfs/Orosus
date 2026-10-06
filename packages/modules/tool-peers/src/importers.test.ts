import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectSources, importNotes, organizeNotes, parseSourceNote, readSourceNotes, type SourceNote } from "./importers.ts";
import { listNotes } from "./memstore.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "peers-imp-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("parseSourceNote（各家格式 → 我们的 SourceNote）", () => {
  it("剥 frontmatter：name/description/type 落位、正文剥头", () => {
    const n = parseSourceNote("---\nname: Anchor Style\ndescription: how to cite\nmetadata:\n  type: reference\n---\n\nBody here.\n", "a.md");
    expect(n.title).toBe("Anchor Style");
    expect(n.summary).toBe("how to cite");
    expect(n.type).toBe("reference");
    expect(n.content).toContain("Body here.");
    expect(n.content).not.toContain("---");
  });
  it("裸 md：# 标题兜底 + 首行摘要；无标题落文件名", () => {
    const a = parseSourceNote("# 裸笔记\n\n第一行摘要有内容\n更多", "x.md");
    expect(a.title).toBe("裸笔记");
    expect(a.summary).toContain("第一行摘要");
    const b = parseSourceNote("没有标题的正文", "2026-01-02-file.md");
    expect(b.title).toBe("2026-01-02-file");
  });
});

describe("readSourceNotes / importNotes", () => {
  it("读源目录：跳 MEMORY.md、坏文件跳行（IO 异常）；导入按标题去重（已存在的跳过并报数）", () => {
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.md"), "---\nname: Note A\ndescription: da\n---\n\nA body\n");
    writeFileSync(join(src, "b.md"), "---\nname: Note B\ndescription: db\n---\n\nB body\n");
    writeFileSync(join(src, "MEMORY.md"), "# Memory Index\n");
    mkdirSync(join(src, "trap.md"));   // 目录冒充 .md → readFileSync EISDIR → 跳行
    const notes = readSourceNotes(src);
    expect(notes.map(n => n.title).toSorted()).toEqual(["Note A", "Note B"]);

    const dest = join(root, "dest", "memory");
    const r1 = importNotes(dest, notes);
    expect(r1.imported).toBe(2);
    expect(r1.skipped).toBe(0);
    expect(listNotes(dest)).toHaveLength(2);
    const r2 = importNotes(dest, notes);
    expect(r2.imported).toBe(0);
    expect(r2.skipped).toBe(2);
  });

  it("不覆盖已有记忆（走查修订四钉）：已有同标题时原内容原样保留——源里改了内容也不动盘上旧文", () => {
    const dest = join(root, "dest", "memory");
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    // 先落一条我们自己的记忆
    importNotes(dest, [{ title: "锚点写法", summary: "旧摘要", content: "旧正文——手工积累", type: "project" }]);
    // 源里出现同标题但内容不同的版本（比如在别家工具里也记过这事）
    writeFileSync(join(src, "x.md"), "---\nname: 锚点写法\ndescription: 新摘要\n---\n\n源里的新正文\n");
    const r = importNotes(dest, readSourceNotes(src));
    expect(r.imported).toBe(0);
    expect(r.skipped).toBe(1);
    // 原文件原样：内容/摘要都没被源版本顶掉
    const kept = listNotes(dest).find(n => n.title === "锚点写法")!;
    expect(kept.summary).toBe("旧摘要");
    expect(readFileSync(join(dest, kept.file), "utf8")).toContain("旧正文——手工积累");
    expect(readFileSync(join(dest, kept.file), "utf8")).not.toContain("源里的新正文");
    // 顺带：不同标题同 slug（CJK 全消 → note）不互踩——-2 后缀共存
    importNotes(dest, [{ title: "并行批纪律", summary: "s", content: "c1", type: "project" }]);
    const two = importNotes(dest, [{ title: "终端坑", summary: "s", content: "c2", type: "project" }]);
    expect(two.imported).toBe(1);
    expect(listNotes(dest)).toHaveLength(3);
  });
});

describe("detectSources（D19 五源定位）", () => {
  it("五源在场/未安装混合：count 正确、未安装 dir undefined", () => {
    const claudeMem = join(root, "claude", "projects", "D--develop-Orosus", "memory");
    mkdirSync(claudeMem, { recursive: true });
    writeFileSync(join(claudeMem, "n.md"), "---\nname: C1\ndescription: d\n---\n\nx\n");
    mkdirSync(join(root, "codex", "memories"), { recursive: true });   // codex 用户全局直读（在场才报 dir）
    const homes = {
      claude: join(root, "claude"),
      zcode: join(root, "zcode"),
      qwen: join(root, "qwen"),
      codex: join(root, "codex"),
      reasonix: join(root, "reasonix"),
    };
    const srcs = detectSources(homes, "D:\\develop\\Orosus", "D:\\develop\\Orosus");
    expect(srcs.find(s => s.id === "claude-code")?.count).toBe(1);
    expect(srcs.find(s => s.id === "claude-code")?.dir).toBe(claudeMem);
    expect(srcs.find(s => s.id === "zcode")?.count).toBe(0);   // 目录不存在 = 0 条
    expect(srcs.find(s => s.id === "zcode")?.dir).toBeUndefined();   // 未安装 dir undefined（页面标「未安装」）
    expect(srcs.find(s => s.id === "codex")?.dir).toBe(join(root, "codex", "memories"));
  });
  it("ZCode 定位 = slug-hash16（cwd 小写 sha256 前 16——2026-10-06 本机实测形态）", () => {
    const homes = { zcode: join(root, "zcode") };
    const cwd = "D:\\develop\\Orosus";
    const hash = createHash("sha256").update(cwd.toLowerCase()).digest("hex").slice(0, 16);
    const expectDir = join(root, "zcode", "cli", "memories", "projects", `orosus-${hash}`, "memory");
    mkdirSync(expectDir, { recursive: true });
    writeFileSync(join(expectDir, "m.md"), "---\nname: Z1\ndescription: d\n---\n\nx\n");
    const srcs = detectSources(homes, "D:\\develop\\Orosus", cwd);
    expect(srcs.find(s => s.id === "zcode")?.count).toBe(1);
  });
});

describe("organizeNotes（D20 模型去重整理）", () => {
  const notes: SourceNote[] = [
    { title: "Anchor rules", summary: "s1", content: "c1", type: "project" },
    { title: "How to cite code", summary: "s2", content: "c2", type: "project" },
    { title: "Parallel batch discipline", summary: "s3", content: "c3", type: "project" },
  ];
  it("注入 fake：同主题两条合并（标题取首条、正文拼接、摘要重写）", async () => {
    const { notes: out, merged } = await organizeNotes(notes, async function* () {
      yield { type: "text/delta", text: '```json\n[{"members":[0,1],"summary":"merged summary"},{"members":[2]}]\n```' } as never;
    });
    expect(merged).toBe(1);
    expect(out).toHaveLength(2);
    expect(out[0]?.title).toBe("Anchor rules");
    expect(out[0]?.summary).toBe("merged summary");
    expect(out[0]?.content).toContain("c2");
    expect(out[1]?.title).toBe("Parallel batch discipline");
  });
  it("关开关（llm 缺省）= 零调用原样返回", async () => {
    const { notes: out, merged } = await organizeNotes(notes, undefined);
    expect(merged).toBe(0);
    expect(out).toEqual(notes);
  });
  it("llm 失败（finish error）= 降级机械导入（原样）", async () => {
    const { notes: out, merged } = await organizeNotes(notes, async function* () {
      yield { type: "text/delta", text: "partial" } as never;
      yield { type: "finish", kind: "error" } as never;
    });
    expect(merged).toBe(0);
    expect(out).toEqual(notes);
  });
  it("解析坏输出 = 原样降级不炸", async () => {
    const { notes: out, merged } = await organizeNotes(notes, async function* () {
      yield { type: "text/delta", text: "not json at all" } as never;
    });
    expect(merged).toBe(0);
    expect(out).toEqual(notes);
  });
});
