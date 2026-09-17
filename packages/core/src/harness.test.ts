import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chunk } from "@orosus/contracts/provider";
import { fakeModule, fakeProvider, fakeProviderModule } from "@orosus/testing";
import type { CommandUi, ModuleDefinition } from "@orosus/contracts/module";
import { InMemorySessionStore } from "./session/memory.ts";
import { createHarness } from "./index.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const script: Chunk[][] = [[{ type: "text/delta", text: "你好" }, { type: "finish", kind: "stop" }]];

// 密封性：userFile/projectFile 显式指向不存在的 tmp 路径，阻断真实 ~/.orosus 与 cwd 配置泄漏进测试；env 传 {} 阻断真实 OROSUS_* 变量；spillDir 同理
const hermetic = (dir: string) => ({
  userFile: join(dir, "no-user.toml"),
  projectFile: join(dir, "no-proj.toml"),
  env: {},
});

const makeHarness = async (extra: Parameters<typeof createHarness>[0] = {}) => {
  dir = mkdtempSync(join(tmpdir(), "orosus-harness-"));
  const base = {
    store: new InMemorySessionStore(),
    diagDir: dir,
    spillDir: join(dir, "spill"),
    modules: [fakeProviderModule("fake", script)],
    config: { ...hermetic(dir), cliOverrides: { model: "fake/m" } },
  };
  return createHarness({ ...base, ...extra, config: { ...base.config, ...extra.config } });
};

describe("createHarness（§8.1 编程式入口 + §4.2 启动序列）", () => {
  it("prompt 一轮：事件流 = 日志实时投影，session/header 含模块图摘要", async () => {
    const h = await makeHarness();
    const seen: string[] = [];
    let header: { moduleGraph?: { active?: string[] } } | undefined;
    const collect = (async () => {
      for await (const e of h.events()) {
        seen.push(e.type);
        if (e.type === "session/header") header = e as never;
        if (e.type === "turn/end") break;
      }
    })();
    await h.prompt("hi");
    await collect;
    expect(seen).toContain("session/header");
    expect(seen).toContain("user/message");
    expect(seen).toContain("assistant/message");
    expect(seen[seen.length - 1]).toBe("turn/end");
    expect(header!.moduleGraph!.active).toContain("provider-fake");
    await h.close();
  });

  it("未配置 model → prompt 报清晰错误（核心顶层 key，§6.6）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-harness-"));
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
      config: hermetic(dir),
      modules: [fakeProviderModule("fake", script)],
    });
    await expect(h.prompt("hi")).rejects.toThrow(/model/);
    await h.close();
  });

  it("model 指向不存在的 provider → 错误列出可用 provider", async () => {
    const h = await makeHarness({ config: { cliOverrides: { model: "ghost/x" } } });
    await expect(h.prompt("hi")).rejects.toThrow(/fake/);
    await h.close();
  });

  it("并发 prompt：第二个立即拒绝（守卫同步占坑，无 TOCTOU 窗口）", async () => {
    const h = await makeHarness();
    const first = h.prompt("hi"); // 不 await——但占坑是同步的，此行返回前 currentTurn 已设
    await expect(h.prompt("again")).rejects.toThrow(/进行中/);
    await first;
    await h.close();
  });

  it("close() 逆序停用模块（dispose 被调用）", async () => {
    let disposed = false;
    const m = fakeModule("m", { activate() { return { dispose() { disposed = true; } }; } });
    const h = await makeHarness({ modules: [fakeProviderModule("fake", script), m] });
    await h.close();
    expect(disposed).toBe(true);
  });

  it("close() 幂等；关闭后 prompt 拒绝（closed 守卫）", async () => {
    const h = await makeHarness();
    await h.close();
    await h.close(); // 幂等不抛
    await expect(h.prompt("hi")).rejects.toThrow(/已关闭/);
  });
});

  it("裸 provider 名 → defaultModel 生效；无 defaultModel → 报错列出可用 provider", async () => {
    const withDefault = fakeModule("provider-fd", {
      activate(ctx) {
        const { stream } = fakeProvider([[{ type: "text/delta", text: "ok" }, { type: "finish", kind: "stop" }]]);
        ctx.provide("provider:fd", { stream, defaultModel: "fd-mini" });
      },
    });
    const h = await makeHarness({ modules: [withDefault], config: { cliOverrides: { model: "fd" } } });
    await h.prompt("hi"); // 裸名路由到 fd-mini，正常完成
    await h.close();
    const h2 = await makeHarness({ config: { cliOverrides: { model: "fake" } } }); // fake 槽是纯 StreamFn，无 defaultModel
    await expect(h2.prompt("hi")).rejects.toThrow(/defaultModel|fake/);
    await h2.close();
  });

describe("命令框架（T10：路由三层/CommandUi/内建表与别名，D35/D38）", () => {
  const cmdModule = (name: string, cmdName: string, handler: (args: string, ui: CommandUi) => Promise<string> | string) =>
    fakeModule(name, { mounts: ["contribute:command"], activate(ctx) { ctx.contribute.command(cmdName, handler); } });

  const ownHarness = async (extra: { modules?: ModuleDefinition[]; commandUi?: CommandUi; model?: string } = {}) => {
    dir = mkdtempSync(join(tmpdir(), "orosus-cmd-"));
    const store = new InMemorySessionStore();
    const fake = fakeProviderModule("fake", [[{ type: "text/delta", text: "x" }, { type: "usage", input: 3, output: 5 }, { type: "finish", kind: "stop" }]]);
    const h = await createHarness({
      store, diagDir: dir, spillDir: join(dir, "spill"),
      ...(extra.commandUi !== undefined ? { commandUi: extra.commandUi } : {}),
      modules: [fake, ...(extra.modules ?? [])],
      config: { ...hermetic(dir), ...(extra.model !== undefined ? { cliOverrides: { model: extra.model } } : {}) },
    });
    return { h, store };
  };

  it("① /m__cmd arg 路由到模块注册 handler，返回值作为 prompt 输出", async () => {
    const h = await makeHarness({ modules: [cmdModule("m", "m__cmd", (a) => `got:${a}`)] });
    expect(await h.prompt("/m__cmd hi")).toBe("got:hi");
    await h.close();
  });

  it("② 未知命令 → 报错列出可用命令（三层合并清单）", async () => {
    const h = await makeHarness({ modules: [cmdModule("m", "m__cmd", () => "x")] });
    await expect(h.prompt("/nope")).rejects.toThrow(/可用命令|help/);
    await h.close();
  });

  it("③ 命令不触发 agentLoop（无 turn/start、无 user/message）", async () => {
    const { h, store } = await ownHarness({ modules: [cmdModule("m", "m__cmd", () => "x")] });
    await h.prompt("/m__cmd q");
    const all = await store.all();
    expect(all.some((e) => e.type === "turn/start")).toBe(false);
    expect(all.some((e) => e.type === "user/message")).toBe(false);
    await h.close();
  });

  it("④ CommandUi 注入：handler 第二参收到宿主注入的 ui", async () => {
    const calls: string[] = [];
    const fakeUi: CommandUi = { ask: async (q) => { calls.push(`ask:${q}`); return "a"; }, choose: async (t) => { calls.push(`choose:${t}`); return "item"; }, confirm: async (q) => { calls.push(`confirm:${q}`); return true; } };
    const { h } = await ownHarness({ commandUi: fakeUi, modules: [cmdModule("m", "m__ui", async (_a, ui) => `${await ui.choose("t", ["item"])}|${await ui.ask("q")}`)] });
    expect(await h.prompt("/m__ui")).toBe("item|a");
    expect(calls).toContain("choose:t");
    await h.close();
  });

  it("⑤ 无头 fail-closed：默认拒绝式 ui 下交互命令带内失败", async () => {
    const h = await makeHarness({ modules: [cmdModule("m", "m__pick", (_a, ui) => ui.choose("t", ["x"]))] });
    await expect(h.prompt("/m__pick")).rejects.toThrow(/无交互环境/);
    await h.close();
  });

  it("⑥ 内建别名：/provider 转发 provider-custom__provider；目标不存在提示安装", async () => {
    const h1 = await makeHarness({ modules: [cmdModule("provider-custom", "provider-custom__provider", () => "菜单OK")] });
    expect(await h1.prompt("/provider")).toBe("菜单OK");
    await h1.close();
    const h2 = await makeHarness({});
    await expect(h2.prompt("/permission")).rejects.toThrow(/approval|安装/);
    await h2.close();
  });

  it("⑦ /model 切换：手动输入全名 → 下个 turn 的 request/header 落新 model", async () => {
    const fakeUi: CommandUi = { ask: async () => "fake/m2", choose: async (_t, items) => items.find((x) => x.includes("手动")) ?? items[0]!, confirm: async () => true };
    const { h, store } = await ownHarness({ commandUi: fakeUi, model: "fake/m1" });
    await h.prompt("/model");
    await h.prompt("hi");
    const headers = (await store.all()).filter((e) => e.type === "request/header");
    expect(headers.at(-1)!.model).toBe("m2"); // request/header 记 model 段（provider 在路由层，§6.2）
    await h.close();
  });

  it("⑧ /help：按类分组输出且含三层全部命令", async () => {
    const h = await makeHarness({ modules: [cmdModule("m", "m__cmd", () => "x")] });
    const out = await h.prompt("/help");
    expect(out).toContain("内建");
    expect(out).toContain("/model");
    expect(out).toContain("/help");
    expect(out).toContain("/status");
    expect(out).toContain("/usage");
    expect(out).toContain("/provider");
    expect(out).toContain("m__cmd");
    await h.close();
  });

  it("⑨ /status：输出含当前 model 与模块图摘要", async () => {
    const h = await makeHarness({});
    const out = await h.prompt("/status");
    expect(out).toContain("model");
    expect(out).toContain("fake/m");
    await h.close();
  });

  it("⑩ /usage：聚合 usage chunk 为累计 input/output", async () => {
    const { h } = await ownHarness({ model: "fake/m" });
    await h.prompt("hi");
    const out = await h.prompt("/usage");
    expect(out).toContain("3");
    expect(out).toContain("5");
    await h.close();
  });
});

describe("ctx.ui 注入链（M3 T2，D35 修订）", () => {
  it("宿主 commandUi 经 harness→kernel→activate 到达 ctx.ui 为同一实例；未注入时为拒绝式缺省", async () => {
    const injected: CommandUi = { ask: async () => "a", choose: async (_t, i) => i[0]!, confirm: async () => true };
    const seen: CommandUi[] = [];
    const probe = fakeModule("ui-probe", {
      activate(ctx) {
        seen.push((ctx as unknown as { ui: CommandUi }).ui);
      },
    });
    const h1 = await makeHarness({ commandUi: injected, modules: [probe, fakeProviderModule("fake", script)] });
    expect(seen[0]).toBe(injected); // 同一实例（引用相等）
    await h1.close();
    const h2 = await makeHarness({ modules: [fakeModule("ui-probe2", { activate(ctx) { seen.push((ctx as unknown as { ui: CommandUi }).ui); } }), fakeProviderModule("fake", script)] });
    await expect(seen[1]!.ask("x")).rejects.toThrow(/无交互环境/); // 缺省拒绝式（fail-closed）
    await h2.close();
  });
});

describe("ctx.llm 二级模型口（D39，M3 T4）", () => {
  const collect = async (s: AsyncIterable<Chunk>): Promise<{ text: string; finish?: Chunk | undefined }> => {
    let text = "";
    let finish: Chunk | undefined;
    for await (const c of s) {
      if (c.type === "text/delta") text += c.text;
      if (c.type === "finish") finish = c;
    }
    return { text, finish };
  };

  it("① 模块经 ctx.llm.stream 调当前 provider：system/messages 透传、汇聚 text delta", async () => {
    const { stream, requests } = fakeProvider([
      [{ type: "text/delta", text: "摘要内容" }, { type: "finish", kind: "stop" }],
      [{ type: "text/delta", text: "主对话" }, { type: "finish", kind: "stop" }],
    ]);
    let run: (() => Promise<{ text: string }>) | undefined;
    const consumer: ModuleDefinition = {
      ...fakeModule("llm-consumer"),
      activate(ctx) {
        run = () => collect(ctx.llm.stream({ system: "总结以下对话", messages: [{ role: "user", content: [{ kind: "text", text: "历史…" }] }] }));
      },
    };
    const h = await makeHarness({
      modules: [
        { ...fakeProviderModule("fake", []), activate: (ctx) => ctx.provide("provider:fake" as never, stream) },
        consumer,
      ],
    });
    const r = await run!();
    expect(r.text).toBe("摘要内容");
    expect(requests[0]).toMatchObject({ model: "m", system: "总结以下对话" }); // model = 解析后的模型名（provider 槽已路由）
    expect(requests[0]!.messages[0]).toMatchObject({ role: "user" });
    expect(requests[0]!.tools).toEqual([]); // 二级调用不带工具
    await h.close();
  });

  it("② /model 运行期覆盖对 ctx.llm 生效（切换后 stream 用新 model）", async () => {
    const fake1 = fakeProvider([[{ type: "text/delta", text: "一号" }, { type: "finish", kind: "stop" }]]);
    const fake2 = fakeProvider([[{ type: "text/delta", text: "二号" }, { type: "finish", kind: "stop" }]]);
    let call: ((which: "a" | "b") => Promise<{ text: string }>) | undefined;
    const consumer: ModuleDefinition = {
      ...fakeModule("llm-consumer"),
      activate(ctx) {
        call = (which) => collect(ctx.llm.stream({ messages: [{ role: "user", content: [{ kind: "text", text: which }] }] }));
      },
    };
    const provA: ModuleDefinition = { ...fakeModule("provider-a"), activate: (ctx) => ctx.provide("provider:a" as never, fake1.stream) };
    const provB: ModuleDefinition = { ...fakeModule("provider-b"), activate: (ctx) => ctx.provide("provider:b" as never, fake2.stream) };
    const ui: CommandUi = { ask: async () => "b/two", choose: async (_t, items) => items.find((i) => i.includes("手动输入"))!, confirm: async () => false };
    const h = await makeHarness({
      commandUi: ui,
      modules: [provA, provB, consumer],
      config: { ...hermetic(dir), cliOverrides: { model: "a/one" } },
    });
    expect((await call!("a")).text).toBe("一号"); // 初始 model a/one
    await h.prompt("/model"); // ui.ask 返回 "b/two" → model 覆盖
    expect((await call!("b")).text).toBe("二号"); // 新 model b/two 经同一 llm 口
    expect(fake2.requests[0]).toMatchObject({ model: "two" });
    await h.close();
  });

  it("③ 未配置 model → llm.stream 产出带内 finish error（不 reject）", async () => {
    dir = mkdtempSync(join(tmpdir(), "orosus-harness-"));
    let run: (() => Promise<{ finish?: Chunk | undefined }>) | undefined;
    const consumer: ModuleDefinition = {
      ...fakeModule("llm-consumer"),
      activate(ctx) {
        run = () => collect(ctx.llm.stream({ messages: [{ role: "user", content: [{ kind: "text", text: "x" }] }] }));
      },
    };
    const h = await createHarness({
      store: new InMemorySessionStore(), diagDir: dir, spillDir: join(dir, "spill"),
      config: hermetic(dir),
      modules: [fakeProviderModule("fake", []), consumer],
    });
    const r = await run!();
    expect(r.finish).toMatchObject({ type: "finish", kind: "error" });
    await h.close();
  });

  it("④ reload 后 ctx.llm 仍指向当前解析（Unchanged 模块的闭包经惰性 holder）", async () => {
    const fp = fakeProvider([
      [{ type: "text/delta", text: "重载后仍可用" }, { type: "finish", kind: "stop" }],
    ]);
    let run: (() => Promise<{ text: string }>) | undefined;
    const consumer: ModuleDefinition = {
      ...fakeModule("llm-consumer"),
      activate(ctx) {
        run = () => collect(ctx.llm.stream({ messages: [{ role: "user", content: [{ kind: "text", text: "x" }] }] }));
      },
    };
    const h = await makeHarness({
      modules: [
        { ...fakeProviderModule("fake", []), activate: (ctx) => ctx.provide("provider:fake" as never, fp.stream) },
        consumer,
      ],
    });
    const report = await h.reload();
    expect(report.unchanged).toContain("llm-consumer");
    expect((await run!()).text).toBe("重载后仍可用"); // 不是"llm 口未注入"
    await h.close();
  });
});
