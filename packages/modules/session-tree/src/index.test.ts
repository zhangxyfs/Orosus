import { describe, it, expect } from "vitest";
import type { ModuleContext, SessionTreeNode } from "@orosus/contracts/module";
import def from "./index.ts";
import { numberedTreeLines, renderTreeLines, resolveBranchTarget } from "./index.ts";

const n = (over: Partial<SessionTreeNode> & { sessionId: string }): SessionTreeNode => ({
  parentSession: null, sourceEntryId: null, createdAtMs: 1, updatedAtMs: 1, ownEvents: 1, ...over,
});

const tree: SessionTreeNode[] = [
  n({ sessionId: "root", label: "根会话", createdAtMs: 1, ownEvents: 10 }),
  n({ sessionId: "a", parentSession: "root", sourceEntryId: "e5", createdAtMs: 2, ownEvents: 3 }),
  n({ sessionId: "b", parentSession: "root", sourceEntryId: "e8", createdAtMs: 3, ownEvents: 2 }),
  n({ sessionId: "a1", parentSession: "a", sourceEntryId: "e6", createdAtMs: 4, ownEvents: 1 }),
  n({ sessionId: "orphan", parentSession: "gone", sourceEntryId: "eX", createdAtMs: 5, ownEvents: 1 }),
];

describe("renderTreeLines（会话树批 T12——纯函数：深度缩进/当前枝/未命名/孤立）", () => {
  it("① 父先子后、缩进两格每层、标题（自身 N 条）；当前枝整条 ▸ 标记；孤立节点殿后", () => {
    const lines = renderTreeLines(tree, "a1");
    expect(lines).toEqual([
      "▸ 根会话（自身 10 条）",       // 当前枝路径（root → a → a1）全部标记
      "  ▸ 新会话（自身 3 条）",      // a（当前枝中段，未命名显「新会话」）
      "    新会话（自身 2 条）",      // b（非当前枝，缩进两层无标记）
      "    ▸ 新会话（自身 1 条）",    // a1（当前，缩进两层）
      "  新会话（自身 1 条） · 根缺失", // 孤立节点：殿后 + 根缺失标注（原样保留；行首两空格 = 标记位占位）
    ]);
  });

  it("② 未命名节点显「新会话」不裸显 sid（2026-09-23 拍板）；无当前会话 = 无标记", () => {
    const lines = renderTreeLines(tree);
    expect(lines.some((l) => l.includes("root") || l.includes("a1"))).toBe(false); // 不裸显 sid
    expect(lines.every((l) => !l.startsWith("▸"))).toBe(true); // 无 current = 整树无 ▸
  });

  it("③ numberedTreeLines 序号与 resolveBranchTarget 同源（序号/sid 双解析、越界与未命中 undefined）", () => {
    const lines = numberedTreeLines(tree, "a1");
    expect(lines[0]).toMatch(/^1\. ▸ 根会话/);
    expect(resolveBranchTarget(tree, "1")).toBe("root");
    expect(resolveBranchTarget(tree, "3")).toBe("b"); // 渲染序：root(1) a(2) b(3) a1(4) orphan(5)
    expect(resolveBranchTarget(tree, "4")).toBe("a1");
    expect(resolveBranchTarget(tree, "a")).toBe("a");
    expect(resolveBranchTarget(tree, "6")).toBeUndefined();
    expect(resolveBranchTarget(tree, "s_nope")).toBeUndefined();
    expect(resolveBranchTarget(tree, "")).toBeUndefined();
  });
});

describe("session-tree 模块（T12——命令注册与三缝转发）", () => {
  type Handler = (args: string, ui: unknown) => Promise<string> | string;
  const mkCtx = (session: Partial<ModuleContext["session"]>) => {
    const commands = new Map<string, Handler>();
    const ctx = {
      config: {}, configRead: async () => ({}),
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      ui: { ask: async () => "", askSecret: async () => "", choose: async () => "", confirm: async () => false },
      llm: { stream: async function* () {} },
      services: { get: async () => undefined, getOptional: async () => undefined },
      provide: () => {},
      contribute: {
        tool: () => () => {}, promptSection: () => () => {}, configOverlay: () => () => {},
        command: (name: string, handler: Handler) => { commands.set(name.replace("session-tree__", ""), handler); return () => commands.delete(name); },
      },
      session: { append: () => {}, ...session },
      tools: { reveal: () => {}, list: () => [], enable: () => {} },
      events: { on: () => () => {}, emit: async () => {} },
    } as unknown as ModuleContext;
    return { ctx, commands };
  };
  const ui = { viewText: () => {}, notice: async () => {} } as unknown as Parameters<Handler>[1];
  const dialogUi = () => ({
    notice: async () => {},
    dialog: (spec: { widgets: unknown[]; onEvent?: (e: unknown) => unknown }) => {
      spec.onEvent?.({ type: "activate", id: "tree", index: 1 }); // 开窗即模拟 Enter 第 2 项
      return { update: () => {}, close: () => {} };
    },
  }) as unknown as Parameters<Handler>[1];

  it("④ 模块形状：name/mounts（fork+switch 两门）/defaultEnabled；view 命令注册", () => {
    expect(def.name).toBe("session-tree");
    expect(def.mounts).toEqual(["contribute:command", "session.fork", "session.switch"]);
    expect(def.defaultEnabled).toBe(true);
    const { ctx, commands } = mkCtx({ tree: async () => tree, id: "a1" });
    void def.activate(ctx);
    expect(commands.has("view")).toBe(true);
    expect(commands.has("branch")).toBe(true);
  });

  it("⑤ view：dialog 开窗渲染序号树 + Enter 转发 switchTo；行模式宿主回落 viewText", async () => {
    const switched: string[] = [];
    const { ctx, commands } = mkCtx({ tree: async () => tree, id: "a1", switchTo: async (sid) => { switched.push(sid); return true; } });
    void def.activate(ctx);
    await commands.get("view")!("", dialogUi());
    expect(switched).toEqual(["a"]); // 渲染序第 2 项 = a（Enter 跳枝转发）
    // 无 dialog（行模式）：回落 viewText
    let fallbackText = "";
    const ui2 = { notice: async () => {}, viewText: (_t: string, text: string) => { fallbackText = text; } } as unknown as Parameters<Handler>[1];
    await commands.get("view")!("", ui2);
    expect(fallbackText).toContain("根会话");
  });

  it("⑥ branch：序号目标 → fork（atEntryId = 该节点分叉点）；缺省 = fork() 无参；他枝分叉点 → 捕获提示先跳枝", async () => {
    const forkCalls: Array<{ atEntryId?: string } | undefined> = [];
    const { ctx, commands } = mkCtx({ tree: async () => tree, id: "a1", fork: async (opts) => { forkCalls.push(opts); return { sessionId: "s_new" }; } });
    void def.activate(ctx);
    await commands.get("branch")!("1", ui); // 序号 1 = root（分叉点 null → atEntryId undefined → 无参 fork）
    expect(forkCalls).toEqual([undefined]); // 根节点 sourceEntryId = null → 缺省（当前末尾）
    await commands.get("branch")!("2", ui); // a 的分叉点 e5
    expect(forkCalls[1]).toEqual({ atEntryId: "e5" });
    const out = await commands.get("branch")!("99", ui);
    expect(out).toContain("未找到目标会话");
    // fork 抛错（分叉点不在当前投影）→ 人话提示
    const { ctx: ctx2, commands: c2 } = mkCtx({ tree: async () => tree, id: "a1", fork: async () => { throw new Error("分叉点不在当前投影内：e8"); } });
    void def.activate(ctx2);
    const err = await c2.get("branch")!("3", ui); // 渲染序 3 = b，分叉点 e8（不在 a1 的投影里）
    expect(err).toContain("先 /session-tree__view 回车跳到该枝");
  });

  it("⑦ 判空降级：三缝全无（老宿主）→ view/branch 返回提示不炸", async () => {
    const { ctx, commands } = mkCtx({ id: "s1" });
    void def.activate(ctx);
    expect(await commands.get("view")!("", ui)).toContain("不支持会话树");
    expect(await commands.get("branch")!("", ui)).toContain("不支持分叉");
  });
});
