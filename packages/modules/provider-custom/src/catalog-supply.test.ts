import { describe, it, expect } from "vitest";
import { resolveWire, adaptBaseUrl } from "./infer.ts";
import { getCatalog, type Catalog } from "./catalog.ts";
import { runProviderMenu, type MenuUi, type MenuDeps } from "./menu.ts";

describe("协议推断（D34，kimi-code 实证映射收敛两族）", () => {
  it("type 已知两族直用（guessed=false）", () => {
    expect(resolveWire({ type: "anthropic" })).toEqual({ kind: "ok", wire: "anthropic", guessed: false });
    expect(resolveWire({ type: "openai" })).toEqual({ kind: "ok", wire: "openai", guessed: false });
  });

  it("显式 type 非两族拒绝（专有 SDK / 两族外协议）", () => {
    const r = resolveWire({ type: "google-genai" });
    expect(r.kind).toBe("invalid");
    expect(r.kind === "invalid" && r.reason).toMatch(/google-genai|专有|拒绝/);
    const bedrock = resolveWire({ npm: "@ai-sdk/amazon-bedrock" });
    expect(bedrock.kind).toBe("invalid"); // 专有 SDK 拒绝
  });

  it("缺省按 npm/id 关键词推断", () => {
    expect(resolveWire({ npm: "@ai-sdk/anthropic" })).toEqual({ kind: "ok", wire: "anthropic", guessed: true });
    expect(resolveWire({ id: "claude-relay" })).toEqual({ kind: "ok", wire: "anthropic", guessed: true });
    expect(resolveWire({ npm: "@ai-sdk/openai" })).toEqual({ kind: "ok", wire: "openai", guessed: true });
  });

  it("无线索猜 openai 标 guessed（兜底）", () => {
    expect(resolveWire({ id: "openrouter" })).toEqual({ kind: "ok", wire: "openai", guessed: true });
    expect(resolveWire({ npm: "@ai-sdk/some-unknown-vendor" })).toEqual({ kind: "ok", wire: "openai", guessed: true });
  });

  it("baseUrl 适配：anthropic 族剥尾部 /v1（glue 自拼 /v1/messages）；openai 族原样", () => {
    expect(adaptBaseUrl("https://x.example/v1", "anthropic")).toBe("https://x.example");
    expect(adaptBaseUrl("https://x.example/v1/", "anthropic")).toBe("https://x.example");
    expect(adaptBaseUrl("https://x.example/v1", "openai")).toBe("https://x.example/v1");
  });
});

describe("目录拉取与快照兜底（D34）", () => {
  it("拉取失败回退内置快照；TTL 内不重复拉取；payload 非对象拒收", async () => {
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount++;
      throw new Error("network down");
    }) as typeof fetch;
    const c1 = await getCatalog({ fetchImpl, now: () => 1_000 });
    expect(Object.keys(c1).length).toBeGreaterThan(0); // 快照兜底可用（离线导入）
    await getCatalog({ fetchImpl, now: () => 2_000 }); // TTL 内 → 不再 fetch
    expect(fetchCount).toBe(1);
    const bad = await getCatalog({ fetchImpl: (async () => new Response("[1,2]", { status: 200 })) as typeof fetch, now: () => 100_000 });
    expect(Object.keys(bad).length).toBeGreaterThan(0); // 非对象拒收 → 仍回退快照（错误不炸）
  });

  it("limit 窗口字段透传（M3 补强 T7）：models.<id>.limit 保留 / 缺省 undefined", async () => {
    const payload = {
      vendor: { type: "openai", api: "https://x", models: {
        "m-big": { id: "m-big", limit: { context: 262_144, output: 8_192 } },
        "m-plain": { id: "m-plain" },
      } },
    };
    const cat = await getCatalog({ fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch, now: () => 1_000_000 });
    expect(cat.vendor!.models!["m-big"]!.limit).toEqual({ context: 262_144, output: 8_192 });
    expect(cat.vendor!.models!["m-plain"]!.limit).toBeUndefined();
  });
});

// ---- 菜单（D37 规格：二级中文列表 + [添加新平台]；数据源两选；key 最少输入；校验即确认）----

const fakeUi = (script: { choose?: string[]; ask?: string[]; confirm?: boolean[] } ): MenuUi => {
  const chooseQueue = [...(script.choose ?? [])];
  const askQueue = [...(script.ask ?? [])];
  const confirmQueue = [...(script.confirm ?? [])];
  return {
    choose: async (_t, _items) => chooseQueue.shift() ?? "",
    ask: async (_q) => askQueue.shift() ?? "",
    confirm: async (_q) => confirmQueue.shift() ?? true,
  };
};

const rejectingUi = (): MenuUi => ({
  choose: async () => { throw new Error("无交互环境"); },
  ask: async () => { throw new Error("无交互环境"); },
  confirm: async () => { throw new Error("无交互环境"); },
});

interface DepsState { saved: unknown; secrets: Array<[string, string]>; setModels: string[] }
function fakeDeps(over: Partial<MenuDeps> = {}): MenuDeps & { state: DepsState } {
  const state: DepsState = { saved: null, secrets: [], setModels: [] };
  const deps: MenuDeps = {
    loadProviders: async () => ({}),
    saveProviders: async (next) => { state.saved = JSON.parse(JSON.stringify(next)); },
    appendSecret: async (k, v) => void state.secrets.push([k, v]),
    setModel: async (n: string) => { state.setModels.push(n); },
    env: {},
    getCatalog: async () => ({ deepseek: { name: "DeepSeek", type: "openai", api: "https://api.deepseek.com/v1", env: ["DEEPSEEK_API_KEY"], models: { "deepseek-chat": { id: "deepseek-chat" } } } }) as unknown as Catalog,
    loadLocalCatalog: async () => ({}),
    fetchImpl: (async () => new Response("[]", { status: 200 })) as typeof fetch,
    ...over,
  };
  return Object.assign(deps, { state }) as MenuDeps & { state: DepsState };
}

describe("/provider 多级菜单（D37）", () => {
  it("添加流程：选数据源→选厂商→env_key 已设零输入→校验 2xx→自动写入", async () => {
    const deps = fakeDeps({ env: { DEEPSEEK_API_KEY: "sk-live" } });
    const ui = fakeUi({ choose: ["[添加新平台]", "在线目录（https://models.dev/api.json）", "deepseek（深度求索）", "deepseek-chat" /* T4：目录兜底挑默认模型 */], ask: [""] /* 关键字过滤=空 */ });
    const out = await runProviderMenu(ui, deps);
    expect(deps.state.saved).toMatchObject({ deepseek: { type: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "$ENV:DEEPSEEK_API_KEY", defaultModel: "deepseek-chat" } });
    expect(deps.state.setModels).toEqual(["deepseek"]); // T4：裸名写顶层 model（onboarding 复检闭环）
    expect(deps.state.secrets).toHaveLength(0); // 零输入：没写 secrets
    expect(out).toContain("success");
    expect(out).toContain('model = "deepseek" 裸名即用');
  });

  it("目录厂商清单按字母序（同前缀供应商相邻——2026-09-18 用户要求：zai/zhipuai/zhipuai-coding-plan 挨着）", async () => {
    const deps = fakeDeps();
    deps.getCatalog = async () => ({
      "zhipuai-coding-plan": { name: "Zhipu AI Coding Plan", type: "openai", api: "https://a", env: ["ZHIPU_API_KEY"] },
      zai: { name: "Z.AI", type: "openai", api: "https://b" },
      zhipuai: { name: "Zhipu AI", type: "openai", api: "https://c" },
      anthropic: { name: "Anthropic", type: "anthropic", api: "https://d" },
    }) as unknown as Catalog;
    let vendorItems: string[] = [];
    const answers = ["[添加新平台]", "在线目录（https://models.dev/api.json）", "取消"];
    const ui: MenuUi = {
      choose: async (title, items) => {
        if (String(title).includes("厂商")) vendorItems = [...items];
        return answers.shift() ?? "取消";
      },
      ask: async () => "",
      confirm: async () => false,
    };
    await runProviderMenu(ui, deps);
    const ids = vendorItems.map((s) => s.split("（")[0]!);
    expect(ids.slice(0, 4)).toEqual(["anthropic", "zai", "zhipuai", "zhipuai-coding-plan"]); // 字母序，同前缀相邻
    expect(ids.at(-1)).toBe("取消");
  });

  it("本地文件源防御：空路径 → 取消文案；坏 JSON → 可读失败文案（走查：空回车曾 ENOENT 炸栈）", async () => {
    const deps = fakeDeps();
    const ui1 = fakeUi({ choose: ["[添加新平台]", "本地文件（api.json）"], ask: [""] });
    expect(await runProviderMenu(ui1, deps)).toContain("已取消（未输入路径");
    const ui2 = fakeUi({ choose: ["[添加新平台]", "本地文件（api.json）", "[添加新平台]", "本地文件（api.json）"], ask: ["C:/no/such/api.json", "C:/no/such/api.json"] });
    const deps3 = fakeDeps();
    deps3.loadLocalCatalog = async () => { throw new Error("ENOENT: no such file"); };
    const out2 = await runProviderMenu(ui2, deps3); // 第二次调用需重新排队 choose（首项仍是已关联平台列表）
    expect(out2).toContain("读取本地目录失败");
  });

  it("T4① live 清单挑默认模型：verify 响应体解析 → 所选写入 defaultModel（非 models[0]）+ setModel 裸名", async () => {
    const deps = fakeDeps({
      env: { DEEPSEEK_API_KEY: "sk-live" },
      fetchImpl: (async () => new Response(JSON.stringify({ data: [{ id: "deepseek-reasoner" }, { id: "deepseek-chat" }] }), { status: 200 })) as typeof fetch,
    });
    const ui = fakeUi({ choose: ["[添加新平台]", "在线目录（https://models.dev/api.json）", "deepseek（深度求索）", "deepseek-reasoner"], ask: [""] });
    const out = await runProviderMenu(ui, deps);
    expect(deps.state.saved).toMatchObject({ deepseek: { defaultModel: "deepseek-reasoner" } }); // 用户所选，非目录 models[0]
    expect(deps.state.setModels).toEqual(["deepseek"]); // 裸名（三轮 P2①）
    expect(out).toContain("deepseek-reasoner");
  });

  it("T4② live 坏形状/空 → 目录清单兜底供选（同样写 defaultModel 与 model）", async () => {
    const deps = fakeDeps({
      env: { DEEPSEEK_API_KEY: "sk-live" },
      fetchImpl: (async () => new Response("not-json", { status: 200 })) as typeof fetch, // json 解析失败 → body undefined → live 空
    });
    const ui = fakeUi({ choose: ["[添加新平台]", "在线目录（https://models.dev/api.json）", "deepseek（深度求索）", "deepseek-chat"], ask: [""] });
    const out = await runProviderMenu(ui, deps);
    expect(deps.state.saved).toMatchObject({ deepseek: { defaultModel: "deepseek-chat" } }); // 目录兜底
    expect(deps.state.setModels).toEqual(["deepseek"]);
    expect(out).toContain("deepseek-chat"); // 兜底菜单的选中值出现在回显
  });

  it("校验三分支：401 密钥无效不写入；404 警告后 confirm 写入", async () => {
    // 401 → 不写入
    const d401 = fakeDeps({ fetchImpl: (async () => new Response("nope", { status: 401 })) as typeof fetch });
    const ui401 = fakeUi({ choose: ["[添加新平台]", "在线目录（https://models.dev/api.json）", "deepseek（深度求索）"], ask: [""] });
    const out = await runProviderMenu(ui401, d401);
    expect(out).toContain("密钥无效");
    expect(d401.state.saved).toBeNull();
    // 404 → confirm 后写入
    const d404 = fakeDeps({ fetchImpl: (async () => new Response("{}", { status: 404 })) as typeof fetch });
    const ui404 = fakeUi({ choose: ["[添加新平台]", "在线目录（https://models.dev/api.json）", "deepseek（深度求索）", "deepseek-chat" /* T4 */], ask: [""], confirm: [true] });
    const out404 = await runProviderMenu(ui404, d404);
    expect(out404).toContain("无法校验");
    expect(d404.state.saved).toMatchObject({ deepseek: { baseUrl: "https://api.deepseek.com/v1" } });
  });

  it("无头 fail-closed：拒绝式 ui → 带『无交互环境』错误，不写任何文件", async () => {
    const deps = fakeDeps();
    await expect(runProviderMenu(rejectingUi(), deps)).rejects.toThrow(/无交互环境/);
    expect(deps.state.saved).toBeNull();
    expect(deps.state.secrets).toHaveLength(0);
  });
});
