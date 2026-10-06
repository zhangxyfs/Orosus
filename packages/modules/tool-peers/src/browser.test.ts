import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserBody, browserEntries, relativeTime, renderBrowserList } from "./browser.ts";
import { listNotes, writeNote } from "./memstore.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "peers-browser-")); mkdirSync(dir, { recursive: true }); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

describe("browserEntries（m5-peers T6c）", () => {
  it("第一项恒 MEMORY.md 本体，其后按索引引用顺序；标题取 frontmatter name 非文件名", () => {
    writeNote(dir, "First Note", "s1", "b1");
    writeNote(dir, "Second Note", "s2", "b2");
    const entries = browserEntries(dir);
    expect(entries[0]?.isIndex).toBe(true);
    expect(entries[0]?.file).toBe("MEMORY.md");
    expect(entries.slice(1).map(e => e.title)).toEqual(["Second Note", "First Note"]);   // 索引引用顺序（mtime 新者先被索引引用）
    expect(entries.every(e => !e.title.endsWith(".md") || e.isIndex)).toBe(true);   // 标题非文件名（索引行除外——它就叫 MEMORY.md）
  });

  it("孤儿笔记（有文件无索引行）按 mtime 补尾不丢", () => {
    writeNote(dir, "Indexed", "s", "b");
    writeFileSync(join(dir, "2026-01-01-orphan.md"), "---\nname: Orphan\ndescription: o\n---\n\nbody\n");
    const titles = browserEntries(dir).map(e => e.title);
    expect(titles).toContain("Orphan");
    expect(titles.indexOf("Orphan")).toBeGreaterThan(titles.indexOf("Indexed"));
  });

  it("无 MEMORY.md → 空列表", () => {
    expect(browserEntries(dir)).toEqual([]);
  });
});

describe("relativeTime（/sessions 同款 + 超 30 天落日期）", () => {
  it("刚刚 / 分钟 / 小时 / 天 / 日期（同年 MM-DD、跨年 YYYY-MM-DD）", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("刚刚");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
    expect(relativeTime(NOW - 3 * 3600_000, NOW)).toBe("3 小时前");
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2 天前");
    expect(relativeTime(Date.parse("2026-08-28T00:00:00Z"), NOW)).toBe("08-28");   // >30 天 → 同年日期
    expect(relativeTime(Date.parse("2025-09-28T00:00:00Z"), NOW)).toBe("2025-09-28");   // 跨年带年
  });
});

describe("renderBrowserList 与 browserBody", () => {
  it("行含标题与相对时间；◆ 标索引行", () => {
    writeNote(dir, "First", "s1", "body1");
    utimesSync(join(dir, listNotes(dir)[0]!.file), new Date(NOW - 5 * 60_000), new Date(NOW - 5 * 60_000));   // mtime 钉 5 分钟前（墙钟漂移隔离）
    const entries = browserEntries(dir);
    const lines = renderBrowserList(entries, NOW);
    expect(lines[0]).toContain("◆");
    expect(lines[1]).toContain("First");
    expect(lines[1]).toContain("5 分钟前");
  });
  it("body 读回原文 + 防穿越；MEMORY.md 可读", () => {
    writeNote(dir, "N", "s", "content-here");
    const entries = browserEntries(dir);
    expect(browserBody(dir, entries[1]!.file)).toContain("content-here");
    expect(browserBody(dir, "MEMORY.md")).toContain("# Memory Index");
    expect(browserBody(dir, "../evil.md")).toBeUndefined();
  });
});
