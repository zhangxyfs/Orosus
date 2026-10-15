import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import mod, { configSchema } from "./index.ts";
import { writeNote } from "./memstore.ts";
import { memoryBucketKey } from "./roots.ts";

describe("tool-peers module", () => {
  it("registers with expected identity", () => {
    const def = mod as unknown as { name: string; version: string; api: number };
    expect(def.name).toBe("tool-peers");
    expect(def.api).toBe(1);
  });

  // D12 翻案（2026-10-06 走查）：默认挂载——字段缺省（validate.ts:27 缺省 true）
  it("defaults to enabled（走查翻案 D12）", () => {
    const def = mod as unknown as { defaultEnabled?: boolean };
    expect(def.defaultEnabled).not.toBe(false);
  });

  it("config schema declares all keys with D13 defaults (validate 硬规则——未声明键被 strip)", () => {
    const parsed = configSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.workspaceMemory).toBe(false);   // D13 两键默认关
      expect(parsed.data.sessionPeers).toBe(false);
      expect(parsed.data.injectIndex).toBe(true);
      expect(parsed.data.windowMinutes).toBe(10);
      expect(parsed.data.leaseMinutes).toBe(30);
    }
  });
});

interface Harness {
  tools: { name: string }[];
  sections: { order: number; text: string }[];
  commands: string[];
  commandHandlers: Map<string, (args: string, ui: unknown) => Promise<string>>;
  listeners: Map<string, (p: unknown) => unknown>;
}
const activateWith = (config: unknown, session?: { id?: string }): Harness => {
  const tools: { name: string }[] = [];
  const sections: { order: number; text: string }[] = [];
  const commands: string[] = [];
  const commandHandlers = new Map<string, (args: string, ui: unknown) => Promise<string>>();
  const listeners = new Map<string, (p: unknown) => unknown>();
  const ctx = {
    config,
    session: session ?? {},
    llm: undefined,
    events: { on: (type: string, l: (p: unknown) => unknown) => { listeners.set(type, l); return () => {}; }, emit: async () => {} },
    contribute: {
      tool: (t: { name: string }) => { tools.push(t); },
      promptSection: (s: { order: number; text: string }) => { sections.push(s); },
      command: (name: string, handler: (args: string, ui: unknown) => Promise<string>) => { commands.push(name); commandHandlers.set(name, handler); return () => {}; },
    },
  };
  (mod as { activate?: (ctx: unknown) => void }).activate?.(ctx);
  return { tools, sections, commands, commandHandlers, listeners };
};

const FULL_ON = { workspaceMemory: true, sessionPeers: true, injectIndex: true, windowMinutes: 10, leaseMinutes: 30 };
const ALL_OFF = { workspaceMemory: false, sessionPeers: false, injectIndex: true, windowMinutes: 10, leaseMinutes: 30 };

describe("T6 门控矩阵与索引段", () => {
  let root: string;
  let memBase: string;
  let sessionsRoot: string;
  const bootPayload = { session_id: "s1", transcript_path: "", cwd: "" };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "peers-t6-"));
    memBase = join(root, "mem");
    sessionsRoot = join(root, "sessions");
    mkdirSync(join(sessionsRoot, "D--proj-x", "s1", "agents"), { recursive: true });
    writeFileSync(join(sessionsRoot, "D--proj-x", "s1", "agents", "session.jsonl"), "{}\n");   // bootById 定位锚（主日志在场）
    bootPayload.transcript_path = join(sessionsRoot, "D--proj-x", "s1", "agents", "session.jsonl");
    bootPayload.cwd = root;
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const fireStart = (h: Harness): void => { (h.listeners.get("session/start") as (p: unknown) => void)(bootPayload); };
  const memoryDir = (): string => join(memBase, memoryBucketKey(bootPayload.cwd), "memory");   // T7：桶键 = memoryBucketKey(cwd)

  it("双关 = activate 零贡献（零工具零段零 token；浏览命令不受门控——D17）", () => {
    const h = activateWith(ALL_OFF);
    expect(h.tools).toHaveLength(0);
    expect(h.sections).toHaveLength(0);
    expect(h.commands).toEqual(["tool-peers__memory"]);   // 命令带模块名前缀（激活期强校验 activate.ts:463）
  });

  it("sessionPeers 单开 = 只 peers 三件、无段", () => {
    const h = activateWith({ ...FULL_ON, workspaceMemory: false });
    expect(h.tools.map(t => t.name)).toEqual(["tool-peers__peers", "tool-peers__claim", "tool-peers__release"]);
    expect(h.sections).toHaveLength(0);
  });

  it("workspaceMemory 单开 = memory 三件 + order 5 段；段活读索引行与引导句", () => {
    const h = activateWith({ ...FULL_ON, sessionPeers: false, memoryBase: memBase, sessionsRoot });
    expect(h.tools.map(t => t.name)).toEqual(["tool-peers__memory__write", "tool-peers__memory__list", "tool-peers__memory__read"]);
    expect(h.sections).toHaveLength(1);
    fireStart(h);   // session/start 缓存自身会话 → memoryDir ready
    mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(join(memoryDir(), "MEMORY.md"), "# Memory Index\n\n- [T](f.md) — s\n");
    const section = h.sections[0]!;
    expect(section.order).toBe(5);
    expect(section.text).toContain("- [T](f.md) — s");
    expect(section.text).toContain("tool-peers__memory__read");
    expect(section.text).toContain("# Shared Project Memory");
  });

  it("injectIndex=false 或无 MEMORY.md → 段空串", () => {
    const h = activateWith({ ...FULL_ON, injectIndex: false, memoryBase: memBase, sessionsRoot });
    fireStart(h);
    expect(h.sections[0]!.text).toBe("");
    const h2 = activateWith({ ...FULL_ON, memoryBase: memBase, sessionsRoot });
    fireStart(h2);   // 未 boot 段也空（memoryDir undefined）
    expect(h2.sections[0]!.text).toBe("");
  });

  it("索引超护栏 → WARNING 行（D5）", () => {
    const h = activateWith({ ...FULL_ON, memoryBase: memBase, sessionsRoot });
    fireStart(h);
    mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(join(memoryDir(), "MEMORY.md"), `# Memory Index\n\n${"x".repeat(30_000)}\n`);
    expect(h.sections[0]!.text).toContain("WARNING");
  });

  it("D26 中途启用补捞：activate 时按 session.id 扫桶定位（session/start 已过不重放）", () => {
    // sessionsRoot 下 s1 已有主日志（beforeEach 建）——activate 时无事件、靠 bootById 补；
    // bootById 的 cwd 兜底 = process.cwd()（env.ts:37 同式）——T7 起记忆桶键按它现算
    const h = activateWith({ ...FULL_ON, memoryBase: memBase, sessionsRoot }, { id: "s1" });
    expect(h.listeners.has("session/start")).toBe(true);   // 后续新会话仍走事件
    const d26Dir = join(memBase, memoryBucketKey(process.cwd()), "memory");
    mkdirSync(d26Dir, { recursive: true });
    writeFileSync(join(d26Dir, "MEMORY.md"), "# Memory Index\n\n- [T](f.md) — s\n");
    expect(h.sections[0]!.text).toContain("- [T](f.md) — s");   // 段非空 = env.self 已 boot
  });

  it("全开 = 六工具 + 一段", () => {
    const h = activateWith(FULL_ON);
    expect(h.tools).toHaveLength(6);
    expect(h.sections).toHaveLength(1);
  });

  it("走查修订一：空态/not-ready 走 notice toast 返回空串；无 notice 口（无头）回退返回串", async () => {
    const h = activateWith(FULL_ON);   // 未 fire session/start、无 session.id → env 未 boot
    const handler = h.commandHandlers.get("tool-peers__memory")!;
    const notices: string[] = [];
    expect(await handler("", { notice: (t: string) => { notices.push(t); } })).toBe("");
    expect(notices[0]).toContain("尚未定位到当前项目会话");
    expect(await handler("", {})).toContain("尚未定位到当前项目会话");   // 无头回退：返回串承载
  });
});

describe("记忆浏览窗分页（2026-10-15 用户走查「能不能分页加载」）", () => {
  let root: string;
  let memBase: string;
  let sessionsRoot: string;
  const bootPayload = { session_id: "s1", transcript_path: "", cwd: "" };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "peers-page-"));
    memBase = join(root, "mem");
    sessionsRoot = join(root, "sessions");
    mkdirSync(join(sessionsRoot, "D--proj-x", "s1", "agents"), { recursive: true });
    writeFileSync(join(sessionsRoot, "D--proj-x", "s1", "agents", "session.jsonl"), "{}\n");
    bootPayload.transcript_path = join(sessionsRoot, "D--proj-x", "s1", "agents", "session.jsonl");
    bootPayload.cwd = root;
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("56 条 → 2 页：首页 50 实 + 尾「下一页」哨兵 + pginfo；哨兵 Enter → update 翻页（首「‹ 上一页」）；页内偏移映射开正确笔记", async () => {
    const dir = join(memBase, memoryBucketKey(bootPayload.cwd), "memory");
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 55; i++) writeNote(dir, `分页笔记 ${String(i).padStart(2, "0")}`, "s", `body-${i}`);
    const h = activateWith({ ...FULL_ON, memoryBase: memBase, sessionsRoot });
    (h.listeners.get("session/start") as (p: unknown) => void)(bootPayload);

    const opened: { widgets: { id: string; kind: string; interactive?: boolean; items?: string[]; text?: string }[]; onEvent?: (e: unknown) => unknown }[] = [];
    const updates: { widgets: { id: string; kind: string; items?: string[]; text?: string }[] }[] = [];
    const views: { title: string; text: string }[] = [];
    const handle = { update: (widgets: unknown) => { updates.push(widgets as never); }, close: () => {} };
    const ui = {
      dialog: (spec: { widgets: unknown[]; onEvent?: (e: unknown) => unknown }) => { opened.push(spec as never); return handle; },
      viewText: (title: string, text: string) => { views.push({ title, text }); },
      notice: async () => {},
    } as never;   // 命令 handler 的 ui 参数（对话/查看口 mock）
    await h.commandHandlers.get("tool-peers__memory")!("", ui);

    // 首页：50 实行 + 尾哨兵 = 51 行；pginfo 页码件在场
    const first = opened[0]!;
    const list1 = first.widgets.find((w) => w.id === "list")!;
    expect(list1.items).toHaveLength(51);
    expect(list1.items!.at(-1)).toContain("下一页");
    expect(first.widgets.find((w) => w.id === "pginfo")!.text).toContain("第 1/2 页");
    expect(first.widgets.find((w) => w.id === "pginfo")!.text).toContain("共 56 条");

    // Enter 尾哨兵（index 50）→ update 整窗换页：第 2 页 = 首哨兵 + 6 实行 + pginfo 2/2
    (first.onEvent as (e: unknown) => unknown)({ type: "activate", id: "list", index: 50 });
    const page2widgets = updates[0] as { id: string; items?: string[]; text?: string }[];   // update 参数 = widgets 数组本体
    const page2 = page2widgets.find((w) => w.id === "list")!;
    expect(page2.items).toHaveLength(7); // ‹上一页 + 6 实行（无下一页哨兵）
    expect(page2.items![0]).toContain("上一页");
    expect(page2widgets.find((w) => w.id === "pginfo")!.text).toContain("第 2/2 页");

    // 页内偏移：第 2 页 index 1 = 首个实行（hasPrev 偏移 1）→ 开对应笔记（标题对行文）
    (first.onEvent as (e: unknown) => unknown)({ type: "activate", id: "list", index: 1 });
    expect(views).toHaveLength(1);
    const rowTitle = page2.items![1]!.trim().split(" · ")[0]!; // 行文「  标题 · 简介 · 时间」
    expect(views[0]!.title).toBe(rowTitle);
    expect(views[0]!.text).toMatch(/body-\d+/);
  });
});
