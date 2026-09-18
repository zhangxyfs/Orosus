import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWire, adaptBaseUrl } from "./infer.ts";
import { getCatalog, getCatalogWithSource, persistCatalogCache, resetCatalogCacheForTest, type Catalog } from "./catalog.ts";
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
    const c1 = await getCatalogWithSource({ fetchImpl, now: () => 1_000 });
    expect(Object.keys(c1.catalog).length).toBeGreaterThan(0); // 快照兜底可用（离线导入）
    expect(c1.source).toBe("builtin"); // 无缓存 + 失败 → 降级快照（降级态可见的根基）
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

  it("getCatalogWithSource 暴露降级态（走查：在线失败静默回退 7 家快照，用户以为列表被改小）：成功→online；TTL 命中沿用来源；失败但有旧缓存供旧数据不降级（stale-while-error）", async () => {
    // 前置：limit 测试已留 online 缓存（at=1_000_000）
    const fail = (async () => { throw new Error("network down"); }) as typeof fetch;
    const r1 = await getCatalogWithSource({ fetchImpl: fail, now: () => 1_700_000 }); // TTL 过期 + 失败 + 有旧缓存 → 供旧 online（比 7 家快照好）
    expect(r1.source).toBe("online");
    const ok = (async () => new Response(JSON.stringify({ vendor: { type: "openai", api: "https://x" } }), { status: 200 })) as typeof fetch;
    const r2 = await getCatalogWithSource({ fetchImpl: ok, now: () => 1_800_000 }); // 网络恢复 → 重取 online
    expect(r2.source).toBe("online");
    const r3 = await getCatalogWithSource({ fetchImpl: fail, now: () => 1_800_100 }); // TTL 内命中 → 沿用来源，fetch 不被调用
    expect(r3.source).toBe("online");
  });

  it("磁盘持久化（用户方案：拉到一次就落盘，之后 baseUrl 等从本地 JSON 取）：成功→写盘；重启后网络失败→读盘全量；坏文件忽略；builtin 不落盘", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-cat-"));
    try {
    const cacheFile = join(dir, "cache", "models-dev.json");
    const payloadA = { vendorA: { type: "openai", api: "https://a" } };
    const payloadB = { vendorB: { type: "openai", api: "https://b" } };
    const okA = (async () => new Response(JSON.stringify(payloadA), { status: 200 })) as typeof fetch;
    const okB = (async () => new Response(JSON.stringify(payloadB), { status: 200 })) as typeof fetch;
    const fail = (async () => { throw new Error("network down"); }) as typeof fetch;

    // ① 成功拉取 → 落盘（envelope：fetchedAt + catalog）
    resetCatalogCacheForTest();
    const r1 = await getCatalogWithSource({ fetchImpl: okA, now: () => 5_000_000, cacheFile });
    expect(r1.source).toBe("online");
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toEqual({ fetchedAt: 5_000_000, catalog: payloadA });

    // ② 模拟重启（内存缓存清空）+ 网络失败 → 读盘：全量数据、来源 disk、fetchedAt 保留
    resetCatalogCacheForTest();
    const r2 = await getCatalogWithSource({ fetchImpl: fail, now: () => 5_000_100, cacheFile });
    expect(r2.source).toBe("disk");
    expect(r2.catalog).toEqual(payloadA);
    expect(r2.fetchedAt).toBe(5_000_000);

    // ③ 网络恢复（TTL 过期后）→ 重取 online 并覆写盘上文件
    const r3 = await getCatalogWithSource({ fetchImpl: okB, now: () => 5_700_000, cacheFile });
    expect(r3.source).toBe("online");
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toEqual({ fetchedAt: 5_700_000, catalog: payloadB });

    // ④ 坏缓存文件（torn/corrupt）→ 忽略，回退 builtin；builtin 不写盘（盘上只存真实拉取数据——不让 7 家快照冒充本地缓存掩盖降级）
    resetCatalogCacheForTest();
    writeFileSync(cacheFile, "{corrupt", "utf8");
    const r4 = await getCatalogWithSource({ fetchImpl: fail, now: () => 5_900_000, cacheFile });
    expect(r4.source).toBe("builtin");
    expect(readFileSync(cacheFile, "utf8")).toBe("{corrupt"); // 原样未动
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("persistCatalogCache（本地文件源喂盘）：写入后 getCatalogWithSource 网络失败时读盘——用户下载的 api.json 一次入缓存，永久可用", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orosus-cat2-"));
    try {
      const cacheFile = join(dir, "cache", "models-dev.json");
      const full = { zhipuai: { type: "openai", api: "https://open.bigmodel.cn/api/paas/v4", env: ["ZHIPU_API_KEY"], models: { "glm-5.3": { id: "glm-5.3", limit: { context: 1_000_000 } } } } };
      persistCatalogCache(full, cacheFile, 7_000_000);
      resetCatalogCacheForTest();
      const fail = (async () => { throw new Error("network down"); }) as typeof fetch;
      const r = await getCatalogWithSource({ fetchImpl: fail, now: () => 7_000_100, cacheFile });
      expect(r.source).toBe("disk");
      expect(Object.keys(r.catalog)).toContain("zhipuai");
      expect(r.fetchedAt).toBe(7_000_000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

interface DepsState { saved: unknown; secrets: Array<[string, string]>; setModels: string[]; ctxWindows: number[] }
function fakeDeps(over: Partial<MenuDeps> = {}): MenuDeps & { state: DepsState } {
  const state: DepsState = { saved: null, secrets: [], setModels: [], ctxWindows: [] };
  const deps: MenuDeps = {
    loadProviders: async () => ({}),
    saveProviders: async (next) => { state.saved = JSON.parse(JSON.stringify(next)); },
    appendSecret: async (k, v) => void state.secrets.push([k, v]),
    setModel: async (n: string) => { state.setModels.push(n); },
    setContextWindow: async (n: number) => { state.ctxWindows.push(n); },
    env: {},
    getCatalog: async () => ({ catalog: { deepseek: { name: "DeepSeek", type: "openai", api: "https://api.deepseek.com/v1", env: ["DEEPSEEK_API_KEY"], models: { "deepseek-chat": { id: "deepseek-chat" } } } } as unknown as Catalog, source: "online" as const }),
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
      catalog: {
        "zhipuai-coding-plan": { name: "Zhipu AI Coding Plan", type: "openai", api: "https://a", env: ["ZHIPU_API_KEY"] },
        zai: { name: "Z.AI", type: "openai", api: "https://b" },
        zhipuai: { name: "Zhipu AI", type: "openai", api: "https://c" },
        anthropic: { name: "Anthropic", type: "anthropic", api: "https://d" },
      } as unknown as Catalog,
      source: "online" as const,
    });
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

  it("在线目录降级可见（走查：拉取失败静默回退内置快照 7 家，用户以为列表被改小）：厂商标题带回退警示；在线正常时无警示", async () => {
    let vendorTitle = "";
    const mkUi = (): MenuUi => {
      const answers = ["[添加新平台]", "在线目录（https://models.dev/api.json）", "取消"];
      return {
        choose: async (title, _items) => {
          if (String(title).includes("厂商")) vendorTitle = String(title);
          return answers.shift() ?? "取消";
        },
        ask: async () => "",
        confirm: async () => false,
      };
    };
    const degraded = fakeDeps();
    degraded.getCatalog = async () => ({ catalog: { deepseek: { name: "DeepSeek", type: "openai", api: "https://a" } } as unknown as Catalog, source: "builtin" as const });
    await runProviderMenu(mkUi(), degraded);
    expect(vendorTitle).toContain("在线目录拉取失败");
    expect(vendorTitle).toContain("内置快照");
    vendorTitle = "";
    const online = fakeDeps();
    online.getCatalog = async () => ({ catalog: { deepseek: { name: "DeepSeek", type: "openai", api: "https://a" } } as unknown as Catalog, source: "online" as const });
    await runProviderMenu(mkUi(), online);
    expect(vendorTitle).not.toContain("拉取失败");
    vendorTitle = "";
    const disk = fakeDeps(); // 磁盘缓存兜底：全量数据但来源如实标注 + 拉取时间
    disk.getCatalog = async () => ({ catalog: { deepseek: { name: "DeepSeek", type: "openai", api: "https://a" } } as unknown as Catalog, source: "disk" as const, fetchedAt: Date.now() - 5 * 60_000 });
    await runProviderMenu(mkUi(), disk);
    expect(vendorTitle).toContain("本地缓存");
    expect(vendorTitle).toContain("5 分钟前");
    expect(vendorTitle).not.toContain("内置快照");
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

  it("T4① 目录降级（builtin 快照）时 live 清单兜底挑默认模型：verify 响应体解析 → 所选写入 defaultModel（非 models[0]）+ setModel 裸名", async () => {
    const deps = fakeDeps({
      env: { DEEPSEEK_API_KEY: "sk-live" },
      getCatalog: async () => ({ catalog: { deepseek: { name: "DeepSeek", type: "openai", api: "https://api.deepseek.com/v1", env: ["DEEPSEEK_API_KEY"], models: {} } } as unknown as Catalog, source: "builtin" as const }), // 降级：条目在但无策展模型 → live 优先
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

  it("目录池真正解析 api.json 元数据（用户走查）：富标签（名称·上下文·日期）+ 发布日期新→旧排序 + 非 tool_call/过滤；全量目录在手时目录优先于端点实时清单（coding-plan 条目只列套餐内模型——live /models 会返回端点全部按量模型，选了就 1113）；选中写 contextWindow", async () => {
    // 形状取自真实 models.dev 的 zhipuai-coding-plan 条目
    const zcp = {
      "zhipuai-coding-plan": {
        name: "Zhipu AI Coding Plan", type: "openai", api: "https://open.bigmodel.cn/api/coding/paas/v4", env: ["ZHIPU_API_KEY"],
        models: {
          "glm-5.3": { id: "glm-5.3", name: "GLM-5.3", release_date: "2026-08-14", tool_call: true, limit: { context: 1_000_000, output: 131_072 } },
          "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM-5.3-Flash", release_date: "2026-08-26", tool_call: true, limit: { context: 1_000_000 } },
          "glm-4.6v": { id: "glm-4.6v", name: "GLM-4.6V", release_date: "2025-12-08", tool_call: true, limit: { context: 128_000 } },
          "glm-old-deprecated": { id: "glm-old-deprecated", status: "deprecated" },
          "glm-no-tool": { id: "glm-no-tool", tool_call: false },
          "glm-nodate": { id: "glm-nodate", tool_call: true }, // 无日期 → 排最后，标签退化为裸 id
        },
      },
    };
    let modelItems: string[] = [];
    const answers: string[] = ["[添加新平台]", "在线目录（https://models.dev/api.json）", "zhipuai-coding-plan（Zhipu AI Coding Plan）"];
    // live 干扰：端点 /models 返回全部按量模型（含套餐外的 flashx / glm-5.2）——不应出现在菜单
    const liveBody = JSON.stringify({ data: [{ id: "glm-5.3-flashx" }, { id: "glm-5.3-flash" }, { id: "glm-5.2" }, { id: "glm-4.5" }] });
    const deps = fakeDeps({
      env: { ZHIPU_API_KEY: "sk-live" },
      getCatalog: async () => ({ catalog: zcp as unknown as Catalog, source: "online" as const }),
      fetchImpl: (async () => new Response(liveBody, { status: 200 })) as typeof fetch,
    });
    const ui: MenuUi = {
      choose: async (title, items) => {
        if (String(title).includes("默认模型")) { modelItems = [...items]; return items[0]!; }
        return answers.shift() ?? "取消";
      },
      ask: async () => "",
      confirm: async () => false,
    };
    const out = await runProviderMenu(ui, deps);
    // 排序：flash（08-26）→ 5.3（08-14）→ 4.6v（12-08 旧年）→ 无日期殿后；deprecated 与 tool_call:false 不出现
    expect(modelItems[0]).toContain("glm-5.3-flash");
    expect(modelItems[0]).toContain("GLM-5.3-Flash");
    expect(modelItems[0]).toContain("1000K");
    expect(modelItems[1]).toContain("glm-5.3（GLM-5.3 · 1000K · 2026-08-14）");
    expect(modelItems[2]).toContain("glm-4.6v");
    expect(modelItems.at(-1)).toBe("glm-nodate");
    expect(modelItems.join("\n")).not.toContain("deprecated");
    expect(modelItems.join("\n")).not.toContain("glm-no-tool");
    // 目录优先：live 的套餐外模型（flashx/glm-5.2/glm-4.5）不进菜单
    expect(modelItems.join("\n")).not.toContain("flashx");
    expect(modelItems.join("\n")).not.toContain("glm-5.2（");
    expect(modelItems.join("\n")).not.toContain("glm-4.5");
    // 选中 glm-5.3-flash（context 1M）→ defaultModel 裸 id + 顶层 contextWindow 写入
    expect(deps.state.saved).toMatchObject({ "zhipuai-coding-plan": { defaultModel: "glm-5.3-flash" } });
    expect(deps.state.ctxWindows).toEqual([1_000_000]);
    expect(out).toContain("contextWindow = 1000000");
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
