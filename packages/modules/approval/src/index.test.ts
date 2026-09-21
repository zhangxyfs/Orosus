import { describe, it, expect, afterEach, beforeEach } from "vitest";
import def from "./index.ts";
import type { CommandUi } from "@orosus/contracts/module";
import { Access } from "@orosus/contracts/tool";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Ctx = Parameters<NonNullable<typeof def.activate>>[0];
type CmdHandler = (args: string, ui: CommandUi) => Promise<string> | string;

interface Harness {
  ctx: Ctx;
  listener: (payload: unknown) => Promise<unknown>;
  events: { type: string; payload: Record<string, unknown> }[];
  uiCalls: { title: string; items: string[] }[];
  commands: Map<string, CmdHandler>;
}

function fakeCtx(opts: { ui?: Partial<CommandUi>; config?: Record<string, unknown> } = {}): Harness {
  const events: Harness["events"] = [];
  let listener: Harness["listener"] = async () => undefined;
  const uiCalls: Harness["uiCalls"] = [];
  const commands = new Map<string, CmdHandler>();
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
    contribute: {
      tool: () => () => {},
      command: (name: string, handler: CmdHandler) => { commands.set(name, handler); return () => {}; },
      promptSection: () => () => {},
      configOverlay: () => () => {},
    },
    session: { append: (type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); } },
    events: {
      on: (_t: string, l: (p: unknown) => Promise<unknown>) => { listener = l as Harness["listener"]; return () => {}; },
      emit: () => Promise.resolve(),
    },
  } as unknown as Ctx;
  return { ctx, get listener() { return listener; }, set listener(l) { listener = l; }, events, uiCalls, commands };
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
  it("waterfall 集成：subprocess 触发询问——四选菜单（T9 起含写规则落盘），批准 → 通过", async () => {
    const h = fakeCtx({ ui: { choose: async (title, items) => { h.uiCalls.push({ title, items }); return "批准一次"; } } });
    await def.activate(h.ctx);
    const veto = await h.listener(bashPayload("ls -la"));
    expect(veto).toBeUndefined();
    expect(h.uiCalls).toHaveLength(1);
    expect(h.uiCalls[0]!.items).toEqual(["批准一次", "本会话始终允许", "始终允许（写规则落盘）", "拒绝"]);
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
    expect(h.uiCalls[0]!.items).toEqual(["批准一次", "本会话始终允许", "始终允许（写规则落盘）", "拒绝"]); // T9 起四选
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
    expect(order).toEqual([`ask:批准一次|本会话始终允许|始终允许（写规则落盘）|拒绝`]); // T9 起四选；第二个询问尚未发起
    release1();
    await Promise.all([p1, p2]);
    expect(order).toHaveLength(2);
  });
});

describe("审批硬化（M4-2 T9/B12）", () => {
  let dir: string | undefined;
  const freshDir = (): string => (dir = mkdtempSync(join(tmpdir(), "orosus-t9-")));
  afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it("⑤ 面板四选含「始终允许（写规则落盘）」（可分段命令）", async () => {
    const h = fakeCtx({ ui: { choose: async (title, items) => { h.uiCalls.push({ title, items }); return "批准一次"; } } });
    await def.activate(h.ctx);
    await h.listener(bashPayload("git status"));
    expect(h.uiCalls[0]!.items).toEqual(["批准一次", "本会话始终允许", "始终允许（写规则落盘）", "拒绝"]);
  });

  it("⑥ 选「始终允许」→ config [approval] rules 含生成规则（单段 git status → bash(git *)）", async () => {
    const base = freshDir();
    const configFile = join(base, "config.toml");
    const h = fakeCtx({ config: { configFile }, ui: { choose: async (title: string, items: string[]) => { h.uiCalls.push({ title, items }); return "始终允许（写规则落盘）"; } } });
    await def.activate(h.ctx);
    expect(await h.listener(bashPayload("git status"))).toBeUndefined();
    const cfg = readFileSync(configFile, "utf8");
    expect(cfg).toContain('tool = "tool-shell__bash(git *)"');
    expect(cfg).toContain('effect = "allow"');
    // 会话内即时生效：同命令二次零询问
    expect(await h.listener(bashPayload("git status"))).toBeUndefined();
    expect(h.uiCalls).toHaveLength(1);
  });

  it("⑦ 分段防搭车——git status; rm -rf / 在 bash(git *) 规则下仍询问；纯 git 复合零询问（核心增量）", async () => {
    const h = fakeCtx({
      config: { rules: [{ effect: "allow", tool: "tool-shell__bash(git *)" }] },
      ui: { choose: async (title, items) => { h.uiCalls.push({ title, items }); return "批准一次"; } },
    });
    await def.activate(h.ctx);
    // 反向对照先行：纯复合命中 git 前缀分段 → 规则放行零询问
    expect(await h.listener(bashPayload("git add . && git push"))).toBeUndefined();
    expect(h.uiCalls).toHaveLength(0);
    // 危险尾巴搭车：分段不全命中 → 退回询问（rm -rf 危险门 → 两选面板）
    await h.listener(bashPayload("git status; rm -rf /"));
    expect(h.uiCalls).toHaveLength(1);
    expect(h.uiCalls[0]!.items).toEqual(["批准一次", "拒绝"]);
  });

  it("⑧ eval → 面板退化两选（memoryKey null 现状语义）", async () => {
    const h = fakeCtx({ ui: { choose: async (title, items) => { h.uiCalls.push({ title, items }); return "批准一次"; } } });
    await def.activate(h.ctx);
    await h.listener(bashPayload("eval $(dangerous)"));
    expect(h.uiCalls[0]!.items).toEqual(["批准一次", "拒绝"]);
  });

  it("⑨ echo $HOME → 询问（reason 含不可分析、memoryKey null——今天放行进记忆，T9 增量）", async () => {
    const h = fakeCtx({ ui: { choose: async (title, items) => { h.uiCalls.push({ title, items }); return "批准一次"; } } });
    await def.activate(h.ctx);
    await h.listener(bashPayload("echo $HOME"));
    expect(h.uiCalls).toHaveLength(1);
    expect(h.uiCalls[0]!.title).toContain("不可分析");
    expect(h.uiCalls[0]!.items).toEqual(["批准一次", "拒绝"]); // memoryKey null → 无记忆无落盘
  });

  it("⑩ 复合命令规则生成——npm run build && npm test → 单条 bash(npm run build && npm test)", async () => {
    const base = freshDir();
    const configFile = join(base, "config.toml");
    const h = fakeCtx({ config: { configFile }, ui: { choose: async (title: string, items: string[]) => { h.uiCalls.push({ title, items }); return "始终允许（写规则落盘）"; } } });
    await def.activate(h.ctx);
    expect(await h.listener(bashPayload("npm run build && npm test"))).toBeUndefined();
    expect(readFileSync(configFile, "utf8")).toContain('tool = "tool-shell__bash(npm run build && npm test)"');
    // 复合规则命中同一复合命令（段列全等）——会话内即时生效
    expect(await h.listener(bashPayload("npm run build && npm test"))).toBeUndefined();
    expect(h.uiCalls).toHaveLength(1);
  });

  it("⑪ /permission 切换 → approval/policy 事件落日志", async () => {
    const base = freshDir();
    const h = fakeCtx({ config: { configFile: join(base, "config.toml") } });
    await def.activate(h.ctx);
    const handler = h.commands.get("approval__permission")!;
    const answers = ["始终询问（ask-always）"]; // 顶级菜单退役（2026-09-19 用户走查）——一级直达三档
    const ui: CommandUi = {
      ask: async () => { throw new Error("不应 ask"); },
      askSecret: async () => { throw new Error("不应 askSecret"); },
      confirm: async () => { throw new Error("不应 confirm"); },
      choose: async () => answers.shift() ?? "取消",
    };
    const out = await handler("", ui);
    expect(out).toBe("权限模式已切换：ask-always"); // 瘦身钉（2026-09-20 用户实测：只报切到什么）
    expect(h.events.some((e) => e.type === "approval/policy" && e.payload.mode === "ask-always")).toBe(true);
  });

  it("⑫ 项目层有 [approval] 节 → 规则写项目层文件（非用户层）", async () => {
    const base = freshDir();
    const userFile = join(base, "config.toml");
    const projectFile = join(base, "p.toml");
    writeFileSync(projectFile, '[approval]\nmode = "ask-risky"\n', "utf8");
    const h = fakeCtx({ config: { configFile: userFile, projectConfigFile: projectFile }, ui: { choose: async () => "始终允许（写规则落盘）" } });
    await def.activate(h.ctx);
    expect(await h.listener(bashPayload("git status"))).toBeUndefined();
    expect(readFileSync(projectFile, "utf8")).toContain('tool = "tool-shell__bash(git *)"'); // 写项目层
    expect(existsSync(userFile)).toBe(false);                                                // 用户层不动（未创建）
  });
});

describe("/permission 直达三档 + /yolo（用户走查 2026-09-19：顶级菜单多余；yolo 一键从不询问）", () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), "orosus-perm-")); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const mkUi = (answers: string[]): { u: CommandUi; asked: string[] } => {
    const asked: string[] = [];
    return { asked, u: {
      ask: async () => { throw new Error("不应 ask"); },
      askSecret: async () => { throw new Error("不应 askSecret"); },
      confirm: async () => { throw new Error("不应 confirm"); },
      choose: async (t: string, items: string[]) => { asked.push(`${t}::${items.join("|")}`); return answers.shift() ?? "取消"; },
    } };
  };

  it("① /permission 无参 → 直接三档菜单（无顶级菜单、无规则清单项）", async () => {
    const h = fakeCtx({ config: { configFile: join(base, "c1.toml"), projectConfigFile: join(base, "no-proj.toml") } });
    await def.activate(h.ctx);
    const { u, asked } = mkUi(["始终询问（ask-always）"]);
    const out = await h.commands.get("approval__permission")!("", u);
    expect(asked).toHaveLength(1); // 一级直达——不再「切换权限模式」二级跳
    expect(asked[0]).toContain("当前权限模式：ask-risky");
    expect(asked[0]).toContain("从不询问");
    expect(asked[0]).not.toContain("查看规则清单");
    expect(out).toContain("ask-always");
    expect(h.events.some((e) => e.type === "approval/policy" && e.payload.mode === "ask-always")).toBe(true);
    expect(readFileSync(join(base, "c1.toml"), "utf8")).toContain('mode = "ask-always"');
  });

  it("② /permission rules → 规则清单文本直出（不弹菜单）", async () => {
    const h = fakeCtx({ config: { rules: [{ effect: "allow", tool: "tool-shell__bash(git *)" }] } });
    await def.activate(h.ctx);
    const { u, asked } = mkUi([]);
    const out = await h.commands.get("approval__permission")!("rules", u);
    expect(asked).toHaveLength(0); // 零交互
    expect(out).toContain("tool-shell__bash(git *)");
    expect(out).toContain("allow");
  });

  it("②b /permission ask-always 直参直达（F5 用户实测：全屏二级菜单选定后再弹 choose = 三级弹窗）", async () => {
    const h = fakeCtx({ config: { configFile: join(base, "c2b.toml"), projectConfigFile: join(base, "no-proj.toml") } });
    await def.activate(h.ctx);
    const { u, asked } = mkUi([]);
    const out = await h.commands.get("approval__permission")!("ask-always", u);
    expect(asked).toHaveLength(0); // 零交互——不弹菜单
    expect(out).toBe("权限模式已切换：ask-always");
    expect(readFileSync(join(base, "c2b.toml"), "utf8")).toContain('mode = "ask-always"');
    expect(h.events.some((e) => e.type === "approval/policy" && e.payload.mode === "ask-always")).toBe(true);
    const bad = await h.commands.get("approval__permission")!("bogus", u);
    expect(bad).toContain("未知权限模式");
  });

  it("③ /yolo（approval__yolo）→ 零交互直接 never + 写盘 + policy 事件", async () => {
    const h = fakeCtx({ config: { configFile: join(base, "c3.toml"), projectConfigFile: join(base, "no-proj.toml") } });
    await def.activate(h.ctx);
    const { u, asked } = mkUi([]);
    const out = await h.commands.get("approval__yolo")!("", u);
    expect(asked).toHaveLength(0); // 一键——无菜单
    expect(out).toBe("权限模式已切换：never"); // 瘦身钉同上
    expect(readFileSync(join(base, "c3.toml"), "utf8")).toContain('mode = "never"');
    expect(h.events.some((e) => e.type === "approval/policy" && e.payload.mode === "never")).toBe(true);
  });
});
