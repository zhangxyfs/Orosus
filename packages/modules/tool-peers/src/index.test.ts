import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import mod, { configSchema } from "./index.ts";

describe("tool-peers module", () => {
  it("registers with expected identity", () => {
    const def = mod as unknown as { name: string; version: string; api: number };
    expect(def.name).toBe("tool-peers");
    expect(def.api).toBe(1);
  });

  // v2 增补：默认卸载断言（缺省 true 的反向——validate.ts:27）
  it("defaults to disabled", () => {
    const def = mod as unknown as { defaultEnabled?: boolean };
    expect(def.defaultEnabled).toBe(false);
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
  listeners: Map<string, (p: unknown) => unknown>;
}
const activateWith = (config: unknown, session?: { id?: string }): Harness => {
  const tools: { name: string }[] = [];
  const sections: { order: number; text: string }[] = [];
  const commands: string[] = [];
  const listeners = new Map<string, (p: unknown) => unknown>();
  const ctx = {
    config,
    session: session ?? {},
    llm: undefined,
    events: { on: (type: string, l: (p: unknown) => unknown) => { listeners.set(type, l); return () => {}; }, emit: async () => {} },
    contribute: {
      tool: (t: { name: string }) => { tools.push(t); },
      promptSection: (s: { order: number; text: string }) => { sections.push(s); },
      command: (name: string) => { commands.push(name); return () => {}; },
    },
  };
  (mod as { activate?: (ctx: unknown) => void }).activate?.(ctx);
  return { tools, sections, commands, listeners };
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
  const memoryDir = (): string => join(memBase, "D--proj-x", "memory");

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
    // sessionsRoot 下 s1 已有主日志（beforeEach 建）——activate 时无事件、靠 bootById 补
    const h = activateWith({ ...FULL_ON, memoryBase: memBase, sessionsRoot }, { id: "s1" });
    expect(h.listeners.has("session/start")).toBe(true);   // 后续新会话仍走事件
    mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(join(memoryDir(), "MEMORY.md"), "# Memory Index\n\n- [T](f.md) — s\n");
    expect(h.sections[0]!.text).toContain("- [T](f.md) — s");   // 段非空 = env.self 已 boot
  });

  it("全开 = 六工具 + 一段", () => {
    const h = activateWith(FULL_ON);
    expect(h.tools).toHaveLength(6);
    expect(h.sections).toHaveLength(1);
  });
});
