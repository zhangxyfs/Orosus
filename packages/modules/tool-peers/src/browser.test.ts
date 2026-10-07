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
  it("走查验形（2026-10-07）：行含简介（标题后、时间前）；简介帽 60 字截断带 …", () => {
    writeNote(dir, "Has Desc", "一句话简介", "b");
    writeNote(dir, "Long Desc", "x".repeat(80), "b2");
    utimesSync(join(dir, listNotes(dir)[1]!.file), new Date(NOW - 30_000), new Date(NOW - 30_000));
    const lines = renderBrowserList(browserEntries(dir), NOW);
    const hasDesc = lines.find(l => l.includes("Has Desc"))!;
    expect(hasDesc).toContain(" · 一句话简介 · ");
    const longDesc = lines.find(l => l.includes("Long Desc"))!;
    expect(longDesc).toContain(` · ${"x".repeat(59)}… · `);   // 60 帽：59 字 + …
  });
  it("tr 注入走键（ctx.t 接线钉）：索引行标题/相对时间经 peers.* 键；无 tr 回落作者中文", () => {
    writeNote(dir, "N1", "s", "b");
    const tr = (k: string, p?: Record<string, string | number>, f?: string): string => {
      if (k === "peers.win.index.title") return "Shared memory index (MEMORY.md)";
      if (k === "peers.reltime.day") return `${p?.d} d ago`;
      if (k === "peers.reltime.min") return `${p?.m} min ago`;
      return f ?? k;
    };
    utimesSync(join(dir, "MEMORY.md"), new Date(NOW - 2 * 86_400_000), new Date(NOW - 2 * 86_400_000));   // 钉索引行 mtime（断言对象是 lines[0]）
    const lines = renderBrowserList(browserEntries(dir), NOW, tr);
    expect(lines[0]).toContain("Shared memory index (MEMORY.md)");
    expect(lines[0]).toContain("2 d ago");
    expect(renderBrowserList(browserEntries(dir), NOW)[0]).toContain("共享记忆索引");   // 无 tr = 作者中文回落
  });
  it("body 读回原文 + 防穿越；MEMORY.md 可读", () => {
    writeNote(dir, "N", "s", "content-here");
    const entries = browserEntries(dir);
    expect(browserBody(dir, entries[1]!.file)).toContain("content-here");
    expect(browserBody(dir, "MEMORY.md")).toContain("# Memory Index");
    expect(browserBody(dir, "../evil.md")).toBeUndefined();
  });
});
