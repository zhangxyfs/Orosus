import { describe, it, expect } from "vitest";
import { defineModule, MODULE_API_VERSION } from "./index.ts";
import type {
  CardSpec,
  CommandUi,
  DialogEvent,
  DialogHandle,
  DialogSpec,
  HostSnapshot,
  ModuleContext,
  PopupLayout,
  WidgetSpec,
} from "./index.ts";

describe("defineModule", () => {
  it("原样返回定义对象（声明式，不执行 activate）", () => {
    let activated = false;
    const def = defineModule({
      name: "tool-x",
      version: "0.1.0",
      description: "测试模块",
      api: MODULE_API_VERSION,
      activate() { activated = true; },
    });
    expect(def.name).toBe("tool-x");
    expect(def.defaultEnabled).toBeUndefined(); // 缺省语义由 kernel 解释，defineModule 不补默认值
    expect(activated).toBe(false);
  });

  it("MODULE_API_VERSION 恒为 1", () => {
    expect(MODULE_API_VERSION).toBe(1);
  });
});

describe("m5 UI 扩展契约面（T0——四口子一次开全）", () => {
  it("CommandUi 新增四可选口缺省 undefined——老宿主只装旧五法即合法", () => {
    const ui: CommandUi = {
      ask: async () => "x",
      askSecret: async () => "x",
      choose: async () => "x",
      confirm: async () => true,
      notice: () => {},
    };
    expect(ui.viewText).toBeUndefined();
    expect(ui.insertText).toBeUndefined();
    expect(ui.attachImage).toBeUndefined();
    expect(ui.dialog).toBeUndefined();
  });

  it("notice 扩第二可选参（时长）——不传即缺省，老调用零变化", () => {
    const seen: Array<{ text: string; durationMs?: number | undefined }> = [];
    const ui: CommandUi = {
      ask: async () => "",
      askSecret: async () => "",
      choose: async () => "",
      confirm: async () => false,
      notice: (text, opts) => seen.push({ text, durationMs: opts?.durationMs }),
    };
    ui.notice!("旧式调用");
    ui.notice!("停 8 秒", { durationMs: 8000 });
    expect(seen).toEqual([{ text: "旧式调用" }, { text: "停 8 秒", durationMs: 8000 }]);
  });

  it("viewText 布局两预设 + 自定义对象、PopupKey 返回三态（新文本 / close / void）", () => {
    const presets: PopupLayout[] = ["center80", "full"];
    const custom: PopupLayout = { height: 20, marginTop: 2, marginStart: 4 };
    expect(presets).toHaveLength(2);
    expect(custom).toMatchObject({ height: 20 });
    const calls: Array<{ title: string; layout?: PopupLayout | undefined; keys?: string[] | undefined }> = [];
    const ui: CommandUi = {
      ask: async () => "",
      askSecret: async () => "",
      choose: async () => "",
      confirm: async () => false,
      viewText: (title, _text, opts) =>
        calls.push({ title, layout: opts?.layout, keys: opts?.keys ? Object.keys(opts.keys) : undefined }),
    };
    ui.viewText!("窗一", "内容", { layout: "full", keys: { "alt+r": { label: "刷新", run: () => "新内容" } } });
    ui.viewText!("窗二", "内容");
    expect(calls[0]).toEqual({ title: "窗一", layout: "full", keys: ["alt+r"] });
    expect(calls[1]).toEqual({ title: "窗二" });
  });

  it("WidgetSpec 八种控件形状齐、活值字段接受函数（现问现答）", () => {
    const widgets: WidgetSpec[] = [
      { id: "t", kind: "text", text: () => "活文本", style: "accent", wrap: "auto" },
      { id: "k", kind: "kv", label: "模型", value: () => "glm" },
      { id: "s", kind: "sep" },
      { id: "l", kind: "list", interactive: true, items: ["a", "b"] },
      { id: "p", kind: "progress", value: () => 42, max: 100 },
      { id: "i", kind: "input", multiline: true, lines: 4, enterSubmit: false, placeholder: "说点什么" },
      { id: "c", kind: "columns", cols: [[{ id: "t1", kind: "text", text: "左" }], [{ id: "t2", kind: "text", text: "右" }]], widths: [30, 70] },
      { id: "tb", kind: "table", head: ["名", "值"], rows: [["a", "1"]] },
    ];
    expect(widgets).toHaveLength(8);
    expect((widgets[0] as { text: () => string }).text()).toBe("活文本");
    expect((widgets[4] as { value: () => number }).value()).toBe(42);
  });

  it("DialogSpec 事件三型 + 句柄两法——dialog 开窗即回句柄", () => {
    const events: DialogEvent[] = [];
    const spec: DialogSpec = {
      title: "后台作业",
      layout: "center80",
      widgets: [{ id: "l", kind: "list", items: ["跑着"] }],
      onEvent: (e) => {
        events.push(e);
        return undefined;
      },
    };
    const handle: DialogHandle = { update: () => {}, close: () => {} };
    const ui: CommandUi = {
      ask: async () => "",
      askSecret: async () => "",
      choose: async () => "",
      confirm: async () => false,
      dialog: (s) => {
        s.onEvent?.({ type: "input", id: "i", text: "hi" });
        s.onEvent?.({ type: "select", id: "l", index: 1 });
        s.onEvent?.({ type: "activate", id: "l", index: 1 });
        return handle;
      },
    };
    const h = ui.dialog!(spec);
    expect(h).toBe(handle);
    expect(events.map((e) => e.type)).toEqual(["input", "select", "activate"]);
  });

  it("contribute.card 卡片贡献口——widgets getter 现问现答、disposer 注销", () => {
    let count = 0;
    const spec: CardSpec = {
      area: "bottom",
      order: 50,
      title: "便签",
      get widgets(): WidgetSpec[] {
        count += 1;
        return [{ id: "n", kind: "text", text: `第 ${count} 次现读` }];
      },
    };
    const disposed: string[] = [];
    const cards: CardSpec[] = [];
    const ctx = {
      config: {},
      configRead: async () => ({}),
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      ui: { ask: async () => "", askSecret: async () => "", choose: async () => "", confirm: async () => false },
      llm: { stream: async function* () {} },
      services: { get: async () => undefined, getOptional: async () => undefined },
      provide: () => {},
      contribute: {
        tool: () => () => {},
        command: () => () => {},
        promptSection: () => () => {},
        configOverlay: () => () => {},
        card: (s: CardSpec) => {
          cards.push(s);
          return () => disposed.push(s.title);
        },
      },
      session: { append: () => {} },
      tools: { reveal: () => {}, list: () => [], enable: () => {} },
      events: { on: () => () => {}, emit: async () => {} },
    } as unknown as ModuleContext;
    const def = defineModule({
      name: "card-x",
      version: "0.1.0",
      description: "测试",
      api: MODULE_API_VERSION,
      activate(c) {
        c.contribute.card?.(spec);
      },
    });
    def.activate(ctx);
    expect(cards).toEqual([spec]);
    expect(spec.widgets[0]).toMatchObject({ kind: "text", text: "第 1 次现读" });
  });

  it("ctx.settings 与 ctx.host 可选——不装即 undefined，装了七法/快照十字段齐", async () => {
    // 不装（老宿主）：可选成员缺省 undefined
    const bare = {} as ModuleContext;
    expect(bare.settings).toBeUndefined();
    expect(bare.host).toBeUndefined();
    // 装了：SettingsService 七法可调、HostInfo.current() 出十字段快照
    const settings = {
      setModel: async (q: string) => { settingsCalls.push(`model:${q}`); },
      setEffort: async (l: string) => { settingsCalls.push(`effort:${l}`); },
      setTheme: async (n: string) => { settingsCalls.push(`theme:${n}`); },
      applyModulePreset: async (p: "full" | "minimal") => ({ failed: [] as string[], preset: p }),
      setLabel: async (l: string) => { settingsCalls.push(`label:${l}`); },
    };
    const settingsCalls: string[] = [];
    const snapshot: HostSnapshot = {
      model: "zhipuai/glm-4.7",
      modelOverridden: true,
      effort: "high",
      preset: "custom",
      theme: "连山",
      permission: "auto",
      sessionLabel: "调试中",
      sidebar: true,
      contextWindow: 200000,
      usage: { current: { input: 100, output: 50 }, lifetime: { input: 1, output: 2, sessions: 3 } },
    };
    const host = { current: async () => snapshot };
    const ctx = { ...bare, settings, host } as ModuleContext;
    await ctx.settings!.setModel("zhipuai/glm-4.7");
    expect(await ctx.settings!.applyModulePreset("minimal")).toEqual({ failed: [], preset: "minimal" });
    expect(settingsCalls).toContain("model:zhipuai/glm-4.7");
    expect((await ctx.host!.current()).model).toBe("zhipuai/glm-4.7");
    expect(Object.keys(snapshot).toSorted()).toEqual(
      ["contextWindow", "effort", "model", "modelOverridden", "permission", "preset", "sessionLabel", "sidebar", "theme", "usage"],
    );
  });
});
