import { describe, it, expect } from "vitest";
import def from "./index.ts";
import type { CommandUi } from "@orosus/contracts/module";
import { Access } from "@orosus/contracts/tool";

type Ctx = Parameters<NonNullable<typeof def.activate>>[0];

interface Harness {
  ctx: Ctx;
  listener: (payload: unknown) => Promise<unknown>;
  events: { type: string; payload: Record<string, unknown> }[];
  uiCalls: { title: string; items: string[] }[];
}

function fakeCtx(opts: { ui?: Partial<CommandUi>; config?: Record<string, unknown> } = {}): Harness {
  const events: Harness["events"] = [];
  let listener: Harness["listener"] = async () => undefined;
  const uiCalls: Harness["uiCalls"] = [];
  const ui: CommandUi = {
    ask: opts.ui?.ask ?? (async () => { throw new Error("无交互环境（headless）"); }),
    askSecret: opts.ui?.askSecret ?? (async () => { throw new Error("无交互环境（headless）"); }),
    choose: opts.ui?.choose
      ?? (async (title: string, items: string[]) => { uiCalls.push({ title, items }); throw new Error("无交互环境（headless）"); }),
    confirm: opts.ui?.confirm ?? (async () => { throw new Error("无交互环境（headless）"); }),
  };
  const ctx = {
    config: { mode: "ask-risky", rules: [], ...opts.config },
    configRead: () => Promise.resolve(undefined),
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    ui,
    services: { get: () => Promise.reject(new Error("no")), getOptional: () => Promise.resolve(undefined) },
    provide: () => {},
    contribute: { tool: () => () => {}, command: () => () => {}, promptSection: () => () => {}, configOverlay: () => () => {} },
    session: { append: (type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); } },
    events: {
      on: (_t: string, l: (p: unknown) => Promise<unknown>) => { listener = l as Harness["listener"]; return () => {}; },
      emit: () => Promise.resolve(),
    },
  } as unknown as Ctx;
  return { ctx, get listener() { return listener; }, set listener(l) { listener = l; }, events, uiCalls };
}

const bashPayload = (command: string) => ({
  callId: "c1",
  name: "tool-shell__bash",
  args: { command },
  accesses: [Access.subprocess()],
  approvalRule: `tool-shell__bash(${command})`,
  matchesRule: (ruleArgs: string) => (ruleArgs.endsWith("*") ? command.startsWith(ruleArgs.slice(0, -1)) : command === ruleArgs),
});

describe("approval 模块（waterfall 首个消费方）", () => {
  it("waterfall 集成：subprocess 触发询问——三选菜单（批准一次/本会话始终允许/拒绝），批准 → 通过", async () => {
    const h = fakeCtx({ ui: { choose: async (title, items) => { h.uiCalls.push({ title, items }); return "批准一次"; } } });
    await def.activate(h.ctx);
    const veto = await h.listener(bashPayload("ls -la"));
    expect(veto).toBeUndefined();
    expect(h.uiCalls).toHaveLength(1);
    expect(h.uiCalls[0]!.items).toEqual(["批准一次", "本会话始终允许", "拒绝"]);
    expect(h.uiCalls[0]!.title).toContain("tool-shell__bash");
    expect(h.uiCalls[0]!.title).toContain("ls -la");
  });

  it("拒绝 → { deny: true }；批准 → undefined；事件 approval/requested + approval/resolved 落日志", async () => {
    const h = fakeCtx({ ui: { choose: async () => "拒绝" } });
    await def.activate(h.ctx);
    const veto = await h.listener(bashPayload("ls"));
    expect(veto).toEqual({ deny: true, reason: expect.stringContaining("用户拒绝执行") });
    const h2 = fakeCtx({ ui: { choose: async () => "批准一次" } });
    await def.activate(h2.ctx);
    expect(await h2.listener(bashPayload("ls"))).toBeUndefined();
    const seq = h.events.map((e) => e.type);
    expect(seq).toEqual(["approval/requested", "approval/resolved"]);
    expect(h.events[0]!.payload).toMatchObject({ callId: "c1", name: "tool-shell__bash" });
    expect(h.events[1]!.payload).toMatchObject({ decision: "deny", source: "user" });
    expect(h2.events[1]!.payload).toMatchObject({ decision: "allow-once" });
  });

  it("危险命令菜单无『本会话始终允许』；『本会话始终允许』登记后同规则再触发零询问（会话记忆）", async () => {
    const h = fakeCtx({ ui: { choose: async (title: string, items: string[]) => { h.uiCalls.push({ title, items }); return "本会话始终允许"; } } });
    await def.activate(h.ctx);
    await h.listener(bashPayload("git status"));
    expect(h.uiCalls[0]!.items).toEqual(["批准一次", "本会话始终允许", "拒绝"]);
    await h.listener(bashPayload("git status")); // 记忆命中
    expect(h.uiCalls).toHaveLength(1);
    // 危险命令：memoryKey=null → 菜单两选，且多次触发始终询问
    const h2 = fakeCtx({ ui: { choose: async (title: string, items: string[]) => { h2.uiCalls.push({ title, items }); return "批准一次"; } } });
    await def.activate(h2.ctx);
    await h2.listener(bashPayload("rm -rf ~/proj"));
    expect(h2.uiCalls[0]!.items).toEqual(["批准一次", "拒绝"]);
    await h2.listener(bashPayload("rm -rf ~/proj"));
    expect(h2.uiCalls).toHaveLength(2);
  });

  it("无头（拒绝式 ui）→ 监听者抛错 = waterfall 否决（fail-closed）；并行双询问 FIFO 串行化", async () => {
    const h = fakeCtx(); // 缺省 ui 全部抛"无交互环境"
    await def.activate(h.ctx);
    await expect(h.listener(bashPayload("ls"))).rejects.toThrow(/无交互环境/);
    // 串行化：两个并发询问，第二个 choose 在第一个完成后才发起
    const order: string[] = [];
    let release1!: () => void;
    const gate1 = new Promise<void>((r) => { release1 = r; });
    const h2 = fakeCtx({
      ui: {
        choose: async (_t, items) => {
          order.push(`ask:${items.join("|")}`);
          if (order.length === 1) await gate1; // 第一个询问挂起
          return "批准一次";
        },
      },
    });
    await def.activate(h2.ctx);
    const p1 = h2.listener({ ...bashPayload("ls"), callId: "c1" });
    const p2 = h2.listener({ ...bashPayload("pwd"), callId: "c2" });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([`ask:批准一次|本会话始终允许|拒绝`]); // 第二个询问尚未发起
    release1();
    await Promise.all([p1, p2]);
    expect(order).toHaveLength(2);
  });
});
