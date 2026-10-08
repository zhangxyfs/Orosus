import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIndex, listNotes, noteFileName, noteBody, readNote, slugify, truncateIndex, writeNote, writeNoteFile } from "./memstore.ts";
import { importNotes } from "./importers.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "peers-mem-")); mkdirSync(dir, { recursive: true }); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("naming", () => {
  it("slug 保留 CJK（走查十二-③——旧形全消成 note）；文件名 = slug(标题) 无日期前缀", () => {
    expect(slugify("Anchor Style Guide")).toBe("anchor-style-guide");
    expect(slugify("锚点写法")).toBe("锚点写法");   // 不再退化为 note（140 条中文记忆不再全叫 note-2/note-3）
    expect(slugify("!!!")).toBe("note");           // 纯符号兜底
    expect(noteFileName("Done!")).toBe("done.md");
    expect(noteFileName("锚点写法")).toBe("锚点写法.md");
  });
  it("noteBody source_name：改题留原题档（同题不写防自指）", () => {
    expect(noteBody("Anchor Style", "s", "c", "project", "锚点写法")).toContain("source_name: 锚点写法");
    expect(noteBody("T", "s", "c")).not.toContain("source_name");
    expect(noteBody("T", "s", "c", "project", "T")).not.toContain("source_name");   // 同题不写
  });
  it("D13 四类 type 落盘：user/feedback 与 project/reference 同款 frontmatter 形态", () => {
    expect(noteBody("T", "s", "c", "user")).toContain("type: user");
    expect(noteBody("T", "s", "c", "feedback")).toContain("type: feedback");
    expect(noteBody("T", "s", "c")).toContain("type: project");   // 缺省仍 project
  });
});
describe("index", () => {
  it("writes note then index lists it, newest first", () => {
    writeNote(dir, "First", "sum1", "body1");
    writeNote(dir, "Second", "sum2", "body2");
    utimesSync(join(dir, "first.md"), new Date("2026-10-05T00:00:00Z"), new Date("2026-10-05T00:00:00Z"));   // mtime 排序钉：同毫秒写 tie 必 flaky（知识索引 mtime 坑先例）
    const notes = listNotes(dir);
    expect(notes.map(n => n.title)).toEqual(["Second", "First"]);
    expect(buildIndex(notes)).toContain("- [Second](second.md) — sum2");
    expect(readNote(dir, "second.md")).toContain("body2");
    expect(readNote(dir, "../evil.md")).toBeUndefined();          // 防穿越
  });
  it("truncates over guard", () => {
    const big = "x".repeat(30_000);
    const t = truncateIndex(big);
    expect(t.truncated).toBe(true);
    expect(t.text.length).toBeLessThanOrEqual(25_000);
    expect(t.text).toContain("WARNING");
  });
  it("frontmatter carries name/description", () => {
    writeNote(dir, "T", "s", "c");
    expect(noteBody("T", "s", "c")).toContain("description: s");
  });
  it("same title updates the existing note instead of creating a duplicate (D25 查重)", () => {
    const f1 = writeNote(dir, "Anchor", "v1", "body1");
    const f2 = writeNote(dir, "Anchor", "v2", "body2");
    expect(f2).toBe(f1);
    expect(listNotes(dir)).toHaveLength(1);
    expect(readNote(dir, f1)).toContain("body2");
  });
});

describe("writeNoteFile（走查九：批量落盘路径件）", () => {
  it("单文件写不重建索引（MEMORY.md 不动）；importNotes 批量后索引一次含全部", () => {
    writeNoteFile(dir, "Solo", "s", "body");
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);   // 未建索引
    expect(readNote(dir, "solo.md")).toContain("body");
    importNotes(dir, [{ title: "B1", summary: "sb", content: "cb", type: "project" }, { title: "B2", summary: "sb2", content: "cb2", type: "project" }]);
    const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(index).toContain("- [B1](");
    expect(index).toContain("- [B2](");
    expect(index).toContain("- [Solo](");   // 末次重建把批量前的散文件也一并入册
  });
});
