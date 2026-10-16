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

    // 开窗即壳（2026-10-16 用户走查）：开窗帧 = 装填态（loading 件，无列表）——点击到窗壳零等待
    const shell = opened[0]!;
    expect(shell.widgets).toHaveLength(1);
    expect(shell.widgets[0]!.id).toBe("loading");
    expect(shell.widgets[0]!.text).toContain("正在装载");
    await new Promise((r) => { setTimeout(r, 20); });   // 冲 setTimeout(0) + 异步扫描链：装填 update 落账

    // 装填后首页：50 实行 + 尾哨兵 = 51 行（实行 = { text, note } 结构行——GUI 时间右贴/TUI 拼单串）；pginfo 在场
    const loadedWidgets = updates[0] as { id: string; kind: string; items?: ({ text: string; note?: string } | string)[]; text?: string }[];
    const list1 = loadedWidgets.find((w) => w.id === "list")!;
    expect(list1.items).toHaveLength(51);
    expect(list1.items!.at(-1) as string).toContain("下一页");   // 哨兵 = 字符串行
    const firstRow = list1.items![1] as { text: string; note?: string };   // items[0] = 索引行（◆）；实行按 mtime 序
    expect(firstRow.text).toMatch(/分页笔记 \d+/);
    expect(firstRow.text).toContain(" · s");   // 简介在主文段
    expect(firstRow.note).toMatch(/分钟前|刚刚|小时前/);   // 时间在 note 侧栏（不挤主文）
    expect(loadedWidgets.find((w) => w.id === "pginfo")!.text).toContain("第 1/2 页");
    expect(loadedWidgets.find((w) => w.id === "pginfo")!.text).toContain("共 56 条");

    // Enter 尾哨兵（index 50）→ update 整窗换页：第 2 页 = 首哨兵 + 6 实行 + pginfo 2/2
    (shell.onEvent as (e: unknown) => unknown)({ type: "activate", id: "list", index: 50 });
    const page2widgets = updates[1] as { id: string; items?: ({ text: string; note?: string } | string)[]; text?: string }[];   // update 参数 = widgets 数组本体（updates[0] = 装填）
    const page2 = page2widgets.find((w) => w.id === "list")!;
    expect(page2.items).toHaveLength(7); // ‹上一页 + 6 实行（无下一页哨兵）
    expect(page2.items![0] as string).toContain("上一页");
    expect(page2widgets.find((w) => w.id === "pginfo")!.text).toContain("第 2/2 页");

    // 页内偏移：第 2 页 index 1 = 首个实行（hasPrev 偏移 1）→ 开对应笔记（标题对行文 text 段）
    (shell.onEvent as (e: unknown) => unknown)({ type: "activate", id: "list", index: 1 });
    expect(views).toHaveLength(1);
    const rowTitle = (page2.items![1] as { text: string }).text.trim().split(" · ")[0]!;
    expect(views[0]!.title).toBe(rowTitle);
    expect(views[0]!.text).toMatch(/body-\d+/);
  });

  it("空仓门（2026-10-16 装填流重构）：MEMORY.md 缺席 → notice 不开窗（stat 级预检与旧全扫等价）", async () => {
    const h = activateWith({ ...FULL_ON, memoryBase: memBase, sessionsRoot });
    (h.listeners.get("session/start") as (p: unknown) => void)(bootPayload);   // dir 定位成功但仓空（beforeEach 只建会话文件）
    const notices: string[] = [];
    const dialogs: unknown[] = [];
    const ui = { dialog: (spec: unknown) => { dialogs.push(spec); return { update: () => {}, close: () => {} }; }, notice: async (m: string) => { notices.push(m); } } as never;
    await h.commandHandlers.get("tool-peers__memory")!("", ui);
    await new Promise((r) => { setTimeout(r, 5); });
    expect(notices[0]).toContain("还没有共享记忆");
    expect(dialogs).toHaveLength(0);   // 空仓不开窗壳（预检先于开窗）
  });
});