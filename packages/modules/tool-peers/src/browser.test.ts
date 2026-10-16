import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserBody, browserEntries, browserPage, browserRowText, relativeTime, renderBrowserList, MEMORY_PAGE_SIZE } from "./browser.ts";
import { listNotes, writeNote } from "./memstore.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "peers-browser-")); mkdirSync(dir, { recursive: true }); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

describe("browserEntries（m5-peers T6c）", () => {
  it("第一项恒 MEMORY.md 本体，其后按索引引用顺序；标题取 frontmatter name 非文件名", async () => {
    writeNote(dir, "First Note", "s1", "b1");
    writeNote(dir, "Second Note", "s2", "b2");
    const entries = await browserEntries(dir);
    expect(entries[0]?.isIndex).toBe(true);
    expect(entries[0]?.file).toBe("MEMORY.md");
    expect(entries.slice(1).map(e => e.title)).toEqual(["Second Note", "First Note"]);   // 索引引用顺序（mtime 新者先被索引引用）
    expect(entries.every(e => !e.title.endsWith(".md") || e.isIndex)).toBe(true);   // 标题非文件名（索引行除外——它就叫 MEMORY.md）
  });

  it("孤儿笔记（有文件无索引行）按 mtime 补尾不丢", async () => {
    writeNote(dir, "Indexed", "s", "b");
    writeFileSync(join(dir, "2026-01-01-orphan.md"), "---\nname: Orphan\ndescription: o\n---\n\nbody\n");
    const titles = (await browserEntries(dir)).map(e => e.title);
    expect(titles).toContain("Orphan");
    expect(titles.indexOf("Orphan")).toBeGreaterThan(titles.indexOf("Indexed"));
  });

  it("无 MEMORY.md → 空列表（async 扫描同语义）", async () => {
    expect(await browserEntries(dir)).toEqual([]);
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
  it("行含标题与相对时间；◆ 标索引行", async () => {
    writeNote(dir, "First", "s1", "body1");
    utimesSync(join(dir, listNotes(dir)[0]!.file), new Date(NOW - 5 * 60_000), new Date(NOW - 5 * 60_000));   // mtime 钉 5 分钟前（墙钟漂移隔离）
    const entries = await browserEntries(dir);
    const lines = renderBrowserList(entries, NOW);
    expect(lines[0]!.text).toContain("◆");
    expect(lines[1]!.text).toContain("First");
    expect(lines[1]!.note).toBe("5 分钟前");
  });
  it("走查验形（2026-10-07 起）：行含简介（标题后、时间前）；2026-10-16 摘帽——简介全文进 text 段（截断归渲染端：GUI CSS/TUI 自适应）；结构行拼回单串与旧形态同形", async () => {
    writeNote(dir, "Has Desc", "一句话简介", "b");
    writeNote(dir, "Long Desc", "x".repeat(80), "b2");
    utimesSync(join(dir, listNotes(dir)[1]!.file), new Date(NOW - 30_000), new Date(NOW - 30_000));
    const lines = renderBrowserList(await browserEntries(dir), NOW);
    const hasDesc = lines.find(l => l.text.includes("Has Desc"))!;
    expect(hasDesc.text).toContain(" · 一句话简介");   // 简介在 text 段（note = 时间不混入）
    expect(hasDesc.note).toBe("刚刚");
    const longDesc = lines.find(l => l.text.includes("Long Desc"))!;
    expect(longDesc.text).toContain(` · ${"x".repeat(80)}`);   // 摘 60 帽：80 字全文（渲染端各自截断）
    expect(longDesc.text).not.toContain("…");   // 模块侧不再造 …
    expect(browserRowText(hasDesc)).toBe(`${hasDesc.text} · ${hasDesc.note}`);   // 拼回 = TUI/只读回落同形
    expect(browserRowText("‹ 上一页")).toBe("‹ 上一页");   // 字符串行（哨兵）原样
    expect(browserRowText({ text: "无注行" })).toBe("无注行");   // note 缺席不拼尾
  });
  it("tr 注入走键（ctx.t 接线钉）：索引行标题/相对时间经 peers.* 键；无 tr 回落作者中文", async () => {
    writeNote(dir, "N1", "s", "b");
    const tr = (k: string, p?: Record<string, string | number>, f?: string): string => {
      if (k === "peers.win.index.title") return "Shared memory index (MEMORY.md)";
      if (k === "peers.reltime.day") return `${p?.d} d ago`;
      if (k === "peers.reltime.min") return `${p?.m} min ago`;
      return f ?? k;
    };
    utimesSync(join(dir, "MEMORY.md"), new Date(NOW - 2 * 86_400_000), new Date(NOW - 2 * 86_400_000));   // 钉索引行 mtime（断言对象是 lines[0]）
    const lines = renderBrowserList(await browserEntries(dir), NOW, tr);
    expect(lines[0]!.text).toContain("Shared memory index (MEMORY.md)");
    expect(lines[0]!.note).toBe("2 d ago");
    expect(renderBrowserList(await browserEntries(dir), NOW)[0]!.text).toContain("共享记忆索引");   // 无 tr = 作者中文回落
  });
  it("body 读回原文 + 防穿越；MEMORY.md 可读", async () => {
    writeNote(dir, "N", "s", "content-here");
    const entries = await browserEntries(dir);
    expect(browserBody(dir, entries[1]!.file)).toContain("content-here");
    expect(browserBody(dir, "MEMORY.md")).toContain("# Memory Index");
    expect(browserBody(dir, "../evil.md")).toBeUndefined();
  });
});

describe("browserEntries 索引驱动快路径（2026-10-15 用户走查「列表卡」）", () => {
  it("标题/简介取自索引行（不读笔记正文）：手改 frontmatter name 后索引行标题滞后——「索引即缓存」；行标题与索引一致", async () => {
    writeNote(dir, "Original Title", "original summary", "b");
    // 事后手改笔记 frontmatter（不经模块写入侧——索引行保持旧标题）
    const files = listNotes(dir);
    const noteFile = join(dir, files[0]!.file);
    writeFileSync(noteFile, "---\nname: Hand Edited\ndescription: new\n---\n\nbody\n");
    const entries = await browserEntries(dir);
    expect(entries[1]?.title).toBe("Original Title");   // 来自索引行（快路径零正文读的实证：内容标题 Hand Edited 不上列表）
    expect(entries[1]?.summary).toBe("original summary");
  });

  it("索引引用指向不存在的文件 → 跳过不炸", async () => {
    writeNote(dir, "Alive", "s", "b");
    writeFileSync(join(dir, "MEMORY.md"), `# Memory Index\n\n- [Ghost](ghost.md) — g\n- [Alive](${listNotes(dir)[0]!.file}) — s\n`);
    const titles = (await browserEntries(dir)).map((e) => e.title);
    expect(titles).not.toContain("Ghost");
    expect(titles).toContain("Alive");
  });
});

describe("browserPage 分页（2026-10-15 用户走查「能不能分页加载」）", () => {
  const mk = (n: number): Parameters<typeof renderBrowserList>[0] =>
    Array.from({ length: n }, (_, i) => ({ file: `n${i}.md`, title: `笔记${i}`, summary: "", updatedAtMs: NOW - i * 1000, isIndex: false }));
  it(`单页（≤${MEMORY_PAGE_SIZE} 条）无哨兵；首页仅尾行「下一页」`, () => {
    const one = browserPage(mk(MEMORY_PAGE_SIZE), 1, NOW);
    expect(one.lines).toHaveLength(MEMORY_PAGE_SIZE);   // 恰一页：无哨兵
    expect(one.hasPrev).toBe(false);
    expect(one.hasNext).toBe(false);
    const two = browserPage(mk(MEMORY_PAGE_SIZE + 1), 1, NOW);
    expect(two.lines).toHaveLength(MEMORY_PAGE_SIZE + 1);   // 50 实行 + 尾哨兵
    expect(two.hasNext).toBe(true);
    expect(two.lines.at(-1)).toContain("下一页");
    expect(two.lines.at(-1)).toContain("还有 1 条");
  });
  it("中间页双哨兵（首行上一页/尾行下一页）；越界页码钳回；实行数 = 页容量", () => {
    const pg2 = browserPage(mk(120), 2, NOW);
    expect(pg2.pageCount).toBe(3);
    expect(pg2.lines[0]).toContain("上一页");
    expect(pg2.lines.at(-1)).toContain("下一页");
    expect(pg2.lines).toHaveLength(MEMORY_PAGE_SIZE + 2);   // 50 实行 + 双哨兵
    expect(browserPage(mk(120), 99, NOW).page).toBe(3);   // 越界钳回末页
    expect(browserPage(mk(120), 0, NOW).page).toBe(1);     // 钳回首页
    const last = browserPage(mk(120), 3, NOW);
    expect(last.lines).toHaveLength(20 + 1);               // 末页 20 实行 + 仅首哨兵
    expect(last.hasNext).toBe(false);
  });
});
