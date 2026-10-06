import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIndex, listNotes, noteFileName, noteBody, readNote, slugify, truncateIndex, writeNote } from "./memstore.ts";

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
});
