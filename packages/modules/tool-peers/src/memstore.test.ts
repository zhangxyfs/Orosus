import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIndex, listNotes, noteFileName, noteBody, readNote, slugify, truncateIndex, writeNote, writeNoteFile } from "./memstore.ts";
import { importNotes, type SourceNote } from "./importers.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "peers-mem-")); mkdirSync(dir, { recursive: true }); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("naming", () => {
  it("slugifies titles, CJK falls back to note", () => {
    expect(slugify("Anchor Style Guide")).toBe("anchor-style-guide");
    expect(slugify("锚点写法")).toBe("note");
    expect(noteFileName("Done!", new Date("2026-10-06T00:00:00Z"))).toBe("2026-10-06-done.md");
  });
});
describe("index", () => {
  it("writes note then index lists it, newest first", () => {
    writeNote(dir, "First", "sum1", "body1", new Date("2026-10-05T00:00:00Z"));
    writeNote(dir, "Second", "sum2", "body2", new Date("2026-10-06T00:00:00Z"));
    utimesSync(join(dir, "2026-10-05-first.md"), new Date("2026-10-05T00:00:00Z"), new Date("2026-10-05T00:00:00Z"));   // mtime 排序钉：同毫秒写 tie 必 flaky（知识索引 mtime 坑先例）
    const notes = listNotes(dir);
    expect(notes.map(n => n.title)).toEqual(["Second", "First"]);
    expect(buildIndex(notes)).toContain("- [Second](2026-10-06-second.md) — sum2");
    expect(readNote(dir, "2026-10-06-second.md")).toContain("body2");
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
    writeNote(dir, "T", "s", "c", new Date());
    expect(noteBody("T", "s", "c")).toContain("description: s");
  });
  it("same title updates the existing note instead of creating a duplicate (D25 查重)", () => {
    const f1 = writeNote(dir, "Anchor", "v1", "body1", new Date("2026-10-06T00:00:00Z"));
    const f2 = writeNote(dir, "Anchor", "v2", "body2", new Date("2026-10-06T01:00:00Z"));
    expect(f2).toBe(f1);
    expect(listNotes(dir)).toHaveLength(1);
    expect(readNote(dir, f1)).toContain("body2");
  });
});

describe("writeNoteFile（走查九：批量落盘路径件）", () => {
  it("单文件写不重建索引（MEMORY.md 不动）；importNotes 批量后索引一次含全部", () => {
    writeNoteFile(dir, "Solo", "s", "body", new Date("2026-10-06T00:00:00Z"));
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);   // 未建索引
    expect(readNote(dir, "2026-10-06-solo.md")).toContain("body");
    importNotes(dir, [{ title: "B1", summary: "sb", content: "cb", type: "project" }, { title: "B2", summary: "sb2", content: "cb2", type: "project" }]);
    const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(index).toContain("- [B1](");
    expect(index).toContain("- [B2](");
    expect(index).toContain("- [Solo](");   // 末次重建把批量前的散文件也一并入册
  });
});
