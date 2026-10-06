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

describe("organizeNotes（D20 走查八-③ 重定义：逐条内容优化 + 重写 description）", () => {
  const notes: SourceNote[] = [
    { title: "Anchor rules", summary: "旧摘要A", content: "乱糟糟的原文A", type: "project" },
    { title: "Parallel discipline", summary: "旧摘要B", content: "原文B", type: "project" },
  ];
  const fakeLlm = (replyFor: (src: string) => string) => async function* (req: { messages: { content: { text: string }[] }[] }) {
    const src = req.messages[0]!.content[0]!.text;
    yield { type: "text/delta", text: replyFor(src) } as never;
  };

  it("逐条优化：内容与摘要按模型输出替换、标题不动；onProgress 每条一步", async () => {
    const steps: string[] = [];
    const { notes: out, merged } = await organizeNotes(
      notes,
      fakeLlm(src => `{"description": "新摘要-${src.slice(0, 12)}", "content": "整理后的正文"}`),
      (done, total, title) => { steps.push(`${done}/${total}:${title}`); },
    );
    expect(merged).toBe(2);
    expect(out[0]!.title).toBe("Anchor rules");
    expect(out[0]!.summary).toContain("新摘要-");
    expect(out[0]!.content).toBe("整理后的正文");
    expect(out[1]!.title).toBe("Parallel discipline");
    expect(steps).toEqual(["1/2:Anchor rules", "2/2:Parallel discipline"]);
  });
  it("关开关（llm 缺省）= 零调用原样返回，进度仍逐步（机械档进度条数据源）", async () => {
    const steps: string[] = [];
    const { notes: out, merged } = await organizeNotes(notes, undefined, (_d, _t, title) => { steps.push(title); });
    expect(merged).toBe(0);
    expect(out).toEqual(notes);
    expect(steps).toHaveLength(2);
  });
  it("单条失败（finish error / 坏输出）= 该条原样降级，其余照常整理", async () => {
    let call = 0;
    const mixed = async function* () {
      call++;
      if (call === 1) yield { type: "text/delta", text: "not json" } as never;   // 第一条：坏输出 → 原样
      else yield { type: "finish", kind: "error" } as never;   // 第二条：失败 → 原样
    };
    const { notes: out, merged } = await organizeNotes(notes, mixed);
    expect(merged).toBe(0);
    expect(out).toEqual(notes);
  });
  it("只给 description 不给 content = 内容保原文（乱才动）", async () => {
    const { notes: out, merged } = await organizeNotes(notes, fakeLlm(() => `{"description": "只重写摘要"}`));
    expect(merged).toBe(2);   // 两条摘要都被改
    expect(out[0]!.content).toBe("乱糟糟的原文A");   // 内容没动
    expect(out[0]!.summary).toBe("只重写摘要");
  });
});
