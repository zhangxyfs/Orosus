import { describe, it, expect } from "vitest";
import { OnboardingSession, type OnboardingDeps, type OnboardingProvider } from "./onboarding.ts";
import { stripAnsi, visibleWidth } from "./width.ts";

const PROVIDERS: OnboardingProvider[] = [
  { id: "openai", name: "OpenAI", envKey: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", type: "openai" },
  { id: "anthropic", name: "Anthropic", envKey: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com", type: "anthropic" },
  { id: "zhipu", name: "智谱 GLM", envKey: "ZHIPU_API_KEY", baseUrl: "https://open.bigmodel.cn/api/paas/v4", type: "openai" },
];

interface Calls {
  providers: { id: string; apiKey?: string }[];
  secrets: [string, string][];
  models: string[];
  defaults: [string, string][];
  searchPatches: Record<string, unknown>[];
  vision: string[];
  renders: number;
}

const mkDeps = (over: Partial<OnboardingDeps> = {}): { deps: OnboardingDeps; calls: Calls } => {
  const calls: Calls = { providers: [], secrets: [], models: [], defaults: [], searchPatches: [], vision: [], renders: 0 };
  const deps: OnboardingDeps = {
    providers: PROVIDERS,
    writeProvider: (p) => { calls.providers.push({ id: p.id, ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}) }); },
    appendSecret: (k, v) => { calls.secrets.push([k, v]); },
    setModel: (slot) => { calls.models.push(slot); },
    writeDefaultModel: (slot, model) => { calls.defaults.push([slot, model]); },
    writeSearch: (patch) => { calls.searchPatches.push(patch as Record<string, unknown>); },
    listModels: over.listModels ?? (async () => ["glm-5.3", "glm-5.3-air"]),
    writeVision: (v) => { calls.vision.push(v); },
    visionModels: over.visionModels ?? (async () => ["zai/glm-5.3-flash", "zai/glm-4.6v"]),
    detectMemorySources: over.detectMemorySources ?? (() => []),
    importMemory: over.importMemory ?? (async () => ({ imported: 0, skipped: 0, merged: 0 })),
    requestRender: () => { calls.renders += 1; },
    ...over,
  };
  return { deps, calls };
};

const type = (s: OnboardingSession, text: string): void => { for (const ch of text) s.handleKey(ch); };

describe("首次使用引导弹窗（M4-3 T1d——施工基准 onboarding 原型）", () => {
  it("① 五页流转与锁定：p1 Ctrl+N 进 p2；p2 未配 Ctrl+N 锁定带原因；配好（含选默认模型）进 p3；p3 未选 Ctrl+N 锁定；选定后进 p5；p5 未勾选 Ctrl+N 跳过完成", async () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps);
    expect(s.handleKey("ctrl+n")).toBeUndefined();
    expect(s.stateRef.page).toBe(2);
    // p2 未配置：Ctrl + N 锁定 + 原因提示（不发完成）
    expect(s.handleKey("ctrl+n")).toBeUndefined();
    expect(s.stateRef.page).toBe(2);
    expect(s.stateRef.p2.notice).toContain("先配置一个提供商");
    // 配一家（zhipu，sel=2）——输完 Key 进选默认模型子态（2026-10-07 修：裸名 setModel 前置）
    s.handleKey("down"); s.handleKey("down");
    s.handleKey("enter"); // 进输入态
    type(s, "zk-1");
    s.handleKey("enter"); // 确认 Key → 选模型子态
    expect(calls.secrets).toEqual([["ZHIPU_API_KEY", "zk-1"]]);
    expect(s.stateRef.p2.mode).toBe("pick");
    await new Promise((r) => setTimeout(r, 0)); // 异步清单到达
    s.handleKey("enter"); // 选首个模型 glm-5.3
    expect(calls.defaults).toEqual([["zhipu", "glm-5.3"]]); // 条目 defaultModel 先落盘
    expect(calls.models).toEqual(["zhipu"]); // 裸名 setModel 此刻才合法（首个自动设为当前使用）
    expect(s.stateRef.p2.active).toBe("zhipu");
    expect(s.stateRef.p2.mode).toBe("list"); // 选完回列表态
    // 进 p3（F14 视觉页——可不选直接下一步，默认不开启）
    expect(s.handleKey("ctrl+n")).toBeUndefined();
    expect(s.stateRef.page).toBe(3);
    expect(s.handleKey("ctrl+n")).toBeUndefined(); // 视觉页可跳过 → 进 p4 搜索页
    expect(s.stateRef.page).toBe(4);
    expect(s.handleKey("ctrl+n")).toBeUndefined(); // 未选定 → 锁定
    expect(s.stateRef.p3.notice).toContain("先选择一个搜索后端");
    // LLM 默认项选定（Enter 进 llm 子态 → 选默认项）
    s.handleKey("enter");
    s.handleKey("enter");
    expect(calls.searchPatches).toEqual([{ backend: "auto", model: undefined }]);
    expect(s.stateRef.p3.chosen).toBe("llm");
    expect(s.handleKey("ctrl+n")).toBeUndefined();   // T6d：搜索选定后进第 5 页（原「完成」顺延）
    expect(s.stateRef.page).toBe(5);
    expect(s.handleKey("ctrl+n")).toEqual({ kind: "completed" });   // 未勾选源 = 跳过导入直接完成
  });

  it("② p2 多家配置（各选默认模型）+ Space 切换当前使用；未配置行 Space 给「先输入 Key」提示（SW-25）", async () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps);
    s.handleKey("ctrl+n");
    // 配 openai（sel=0）——首个：选定模型即自动设为当前使用
    s.handleKey("enter"); type(s, "ok-1"); s.handleKey("enter");
    await new Promise((r) => setTimeout(r, 0));
    s.handleKey("enter"); // 选 glm-5.3
    // 配 anthropic（sel=1）——次家：选定模型不抢当前使用（Space 再切）
    s.handleKey("down"); s.handleKey("enter"); type(s, "ak-1"); s.handleKey("enter");
    await new Promise((r) => setTimeout(r, 0));
    s.handleKey("enter");
    expect(calls.defaults).toEqual([["openai", "glm-5.3"], ["anthropic", "glm-5.3"]]);
    expect(calls.models).toEqual(["openai"]); // 只有首个自动设为当前使用
    expect(s.stateRef.p2.active).toBe("openai");
    // Space 切到 anthropic（已带默认模型——裸名 setModel 合法）
    s.handleKey(" ");
    expect(calls.models).toEqual(["openai", "anthropic"]);
    expect(s.stateRef.p2.active).toBe("anthropic");
    // 未配置行（zhipu sel=2）Space → 提示
    s.handleKey("down"); s.handleKey(" ");
    expect(s.stateRef.p2.notice).toContain("先输入 智谱 GLM 的 Key");
    expect(calls.models).toEqual(["openai", "anthropic"]);
  });

  it("③ p2 空 Key 回车 → 暖金提示；输入态 ↑↓ 换行草稿按行保留（SW-25）", () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps);
    s.handleKey("ctrl+n");
    s.handleKey("enter");
    s.handleKey("enter"); // 空 draft 确认
    expect(s.stateRef.p2.notice).toContain("Key 不能为空");
    expect(s.stateRef.p2.noticeKind).toBe("warn");
    // openai 输一半 ↓ 换 anthropic 输一半 ↑ 换回 → 草稿各自保留
    type(s, "half-");
    s.handleKey("down");
    expect(s.stateRef.p2.mode).toBe("key"); // 换行后仍在输入态
    type(s, "ak-");
    s.handleKey("up");
    expect(s.stateRef.p2.drafts["openai"]).toBe("half-");
    expect(s.stateRef.p2.drafts["anthropic"]).toBe("ak-");
    // Backspace 删到空 = 退出输入态（SW-25）
    s.handleKey("backspace"); s.handleKey("backspace"); s.handleKey("backspace"); s.handleKey("backspace"); s.handleKey("backspace");
    expect(s.stateRef.p2.drafts["openai"]).toBe("");
    s.handleKey("backspace");
    expect(s.stateRef.p2.mode).toBe("list");
  });

  it("④ p3 LLM 跨提供商钉选：llm → provs → models → 钉选值 provider/model 限定形（SW-24）", async () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps, { configured: ["zhipu", "openai"], active: "zhipu" });
    s.handleKey("ctrl+n"); s.handleKey("ctrl+n"); s.handleKey("ctrl+n"); // → p3 视觉页（跳过）→ p4 搜索页
    s.handleKey("enter"); // opts → llm
    s.handleKey("down"); s.handleKey("enter"); // 另选一个模型…
    expect(s.stateRef.p3.stage).toBe("provs");
    // provs 只列第 2 页已配置的（zhipu 使用中在前?——顺序 = providers 序）
    s.handleKey("enter"); // 选 zhipu（sel=0 因 active 预定位）
    expect(s.stateRef.p3.stage).toBe("models");
    await new Promise((r) => setTimeout(r, 0)); // 异步清单到达
    expect(s.stateRef.p3.models).toEqual(["glm-5.3", "glm-5.3-air"]);
    s.handleKey("down"); s.handleKey("enter"); // 钉 glm-5.3-air
    expect(calls.searchPatches).toEqual([{ backend: "auto", model: "zhipu/glm-5.3-air" }]);
    expect(s.stateRef.p3.model).toBe("zhipu/glm-5.3-air");
    expect(s.stateRef.p3.stage).toBe("opts");
  });

  it("⑤ p3 模型清单拉取失败 → 手动输入行回退（SW-24）", async () => {
    const { deps, calls } = mkDeps({ listModels: async () => { throw new Error("端点不可达"); } });
    const s = new OnboardingSession(deps, { configured: ["zhipu"], active: "zhipu" });
    s.handleKey("ctrl+n"); s.handleKey("ctrl+n"); s.handleKey("ctrl+n"); // → p4（视觉页跳过）
    s.handleKey("enter"); s.handleKey("down"); s.handleKey("enter");
    s.handleKey("enter"); // 选 zhipu
    await new Promise((r) => setTimeout(r, 0));
    expect(s.stateRef.p3.stage).toBe("manual");
    type(s, "glm-5.3");
    s.handleKey("enter");
    expect(calls.searchPatches).toEqual([{ backend: "auto", model: "zhipu/glm-5.3" }]);
  });

  it("⑥ p3 Tavily key：输入 → secrets + 占位符写盘；输入态 ↑↓ 可换 Brave（草稿按行保留）", () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps, { configured: ["zhipu"], active: "zhipu" });
    s.handleKey("ctrl+n"); s.handleKey("ctrl+n"); s.handleKey("ctrl+n"); // → p4（视觉页跳过）
    s.handleKey("down"); s.handleKey("enter"); // Tavily
    type(s, "tv-1");
    s.handleKey("down"); // 换 Brave——草稿保留
    expect(s.stateRef.p3.keyOpt).toBe("brave");
    type(s, "br-1");
    s.handleKey("up"); // 换回 Tavily
    expect(s.stateRef.p3.drafts["tavily"]).toBe("tv-1");
    expect(s.stateRef.p3.drafts["brave"]).toBe("br-1");
    s.handleKey("enter"); // 确认 Tavily
    expect(calls.secrets).toEqual([["TAVILY_API_KEY", "tv-1"]]);
    expect(calls.searchPatches).toEqual([{ backend: "auto", tavilyApiKey: "$ENV:TAVILY_API_KEY" }]);
    expect(s.stateRef.p3.chosen).toBe("tavily");
    expect(s.handleKey("ctrl+n")).toBeUndefined();   // T6d：选定后进 p5（原「完成」顺延一页）
    expect(s.stateRef.page).toBe(5);
    expect(s.handleKey("ctrl+n")).toEqual({ kind: "completed" });   // 未勾选源 = 跳过导入完成
  });

  it("⑦ Ctrl + Q 仅第 1 页退出；第 2/3 页给提示不退出（SW-22）", () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps);
    expect(s.handleKey("ctrl+q")).toEqual({ kind: "quit" });
    const s2 = new OnboardingSession(deps);
    s2.handleKey("ctrl+n");
    expect(s2.handleKey("ctrl+q")).toBeUndefined();
    expect(s2.stateRef.p2.notice).toContain("仅在第 1 页可用");
    expect(s2.stateRef.page).toBe(2);
  });

  it("⑧ Backspace 逐级返回链（SW-24）：models→provs→llm→opts；key 空草稿→opts", async () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps, { configured: ["zhipu"], active: "zhipu" });
    s.handleKey("ctrl+n"); s.handleKey("ctrl+n"); s.handleKey("ctrl+n"); // → p4（视觉页跳过）
    s.handleKey("enter"); s.handleKey("down"); s.handleKey("enter"); s.handleKey("enter"); // → models（等清单）
    await new Promise((r) => setTimeout(r, 0));
    expect(s.stateRef.p3.stage).toBe("models");
    s.handleKey("backspace");
    expect(s.stateRef.p3.stage).toBe("provs");
    s.handleKey("backspace");
    expect(s.stateRef.p3.stage).toBe("llm");
    s.handleKey("backspace");
    expect(s.stateRef.p3.stage).toBe("opts");
    // key 态空草稿 backspace → opts
    s.handleKey("down"); s.handleKey("enter");
    expect(s.stateRef.p3.stage).toBe("key");
    s.handleKey("backspace");
    expect(s.stateRef.p3.stage).toBe("opts");
  });

  it("⑨ 渲染定高钉（2026-10-07 框高随内容收缩后语义）：同状态重绘恒定 + notice 出现/消失不跳框（恒占位）+ 第 2 页两态恒撑满；页/子态切换框随内容（内容少不再大片空白）", async () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps);
    const h = (sess: OnboardingSession) => sess.render(120, 30).lines.length;
    const h1 = h(s);
    expect(h(s)).toBe(h1); // 同状态重绘恒定（防闪烁实质）
    expect(h1).toBeLessThan(24); // p1 内容 ~8 行 → 框收缩（旧恒 24 大片空白）
    s.handleKey("ctrl+n"); // p2 list
    const h2list = h(s);
    s.handleKey("enter"); // p2 key 态
    expect(h(s)).toBe(h2list); // 第 2 页两态恒撑满（key 态列表动态 bodyH−5 布局以满高为准）
    s.handleKey("backspace"); // 回 list
    s.handleKey("down"); s.handleKey("down"); s.handleKey("enter"); type(s, "zk"); s.handleKey("enter");
    expect(s.stateRef.p2.mode).toBe("pick"); // 输完 Key → 选默认模型子态（2026-10-07 修）
    expect(h(s)).toBe(h2list); // 第 2 页三态恒撑满（子态切换不跳框）
    await new Promise((r) => setTimeout(r, 0)); // 清单到达
    expect(h(s)).toBe(h2list);
    s.handleKey("enter"); // 选定模型
    expect(h(s)).toBe(h2list); // 配置完成 notice 出现不跳框
    expect(h2list).toBe(23); // 撑满 = 6 框架行 + bodyH 17（旧口径上限）
    s.handleKey("ctrl+n"); // p3 视觉页（opts）
    const h3 = h(s);
    expect(h(s)).toBe(h3);
    s.handleKey("ctrl+n"); // p4 网络搜索（opts）
    const h4 = h(s);
    expect(h(s)).toBe(h4);
    // 小终端等比收窄（760×540 原型值按字符栅格适配——SW-22）
    const small = s.render(80, 20);
    expect(small.lines.length).toBeLessThanOrEqual(18);
    expect(small.width).toBeLessThanOrEqual(72);
  });

  it("⑩ 渲染内容钉：页头步进/标题、页脚键位带空格（Ctrl + N）、锁定置灰原因、Esc 未占用注记", () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps);
    const p1 = s.render(120, 30).lines.join("\n");
    expect(p1).toContain("引导 1 / 5");   // T6d 加页后分母随标题数组派生
    expect(p1).toContain("欢迎使用 Orosus（连山）");
    expect(p1).toContain("Ctrl + N");
    expect(p1).toContain("Esc 未占用");
    s.handleKey("ctrl+n");
    const p2 = s.render(120, 30).lines.join("\n");
    expect(p2).toContain("引导 2 / 5");
    expect(p2).toContain("先配好一家提供商"); // 锁定原因（Ctrl + N 置灰带 why）
    // key 态静默盲输形态（SW-23：已输入 N 字符，不逐键掩码）
    s.handleKey("enter"); type(s, "abc");
    const p2k = s.render(120, 30).lines.join("\n");
    expect(p2k).toContain("已输入 3 字符");
    expect(p2k).not.toContain("●●●");
  });

  it("⑪ 粘贴路由：输入态 handlePaste 整段进草稿（API Key 首要输入方式）；非输入态吞掉", () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps);
    s.handleKey("ctrl+n");
    s.handlePaste("should-ignore"); // list 态吞掉
    expect(s.stateRef.p2.drafts["openai"]).toBeUndefined();
    s.handleKey("enter");
    s.handlePaste("sk-live-123\r\n"); // key 态进草稿（剥换行）
    expect(s.stateRef.p2.drafts["openai"]).toBe("sk-live-123");
    s.handleKey("enter");
    expect(s.stateRef.p2.configured).toContain("openai");
  });

  it("⑫ p4 排板钉（2026-10-07 用户走查）：opts 说明行与选项间空行、框高随内容收缩（内容少不再大片空白）；models/provs 长清单按框高钳制 + 快捷键行钉底（旧全量 forEach 超高被裁尾丢提示行）", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, envKey: `P${i}_KEY`, baseUrl: "https://x", type: "openai" as const }));
    const { deps } = mkDeps({ providers: many, listModels: async () => Array.from({ length: 30 }, (_, i) => `m${i}`) });
    const s = new OnboardingSession(deps, { configured: many.map((m) => m.id), active: "p0" });
    s.handleKey("ctrl+n"); s.handleKey("ctrl+n"); s.handleKey("ctrl+n"); // → p4 opts
    const g = s.render(120, 30);
    const bodyH = g.lines.length - 6;
    const body = g.lines.slice(3, 3 + bodyH).map((l) => stripAnsi(l));
    expect(bodyH).toBeLessThan(17); // opts 内容 7 行 → 框收缩（旧恒 bodyH=17 下方大片空白）
    const lead = body.findIndex((l) => l.includes("搜索后端按"));
    expect(body[lead + 1]!.replace(/│/g, "").trim()).toBe(""); // 说明行与选项间空行（剥框线后空）
    expect(body[lead + 2]).toContain("LLM Web Search");
    expect(body[bodyH - 1]!.replace(/│/g, "").trim()).toBe(""); // notice 恒占位 = 正文末行
    // llm → 另选模型 → provs（12 家已配置全显；快捷键行钉底）
    s.handleKey("enter"); // llm 子态
    s.handleKey("down"); s.handleKey("enter"); // provs 子态
    const gp = s.render(120, 30);
    const bH = gp.lines.length - 6;
    const bp = gp.lines.slice(3, 3 + bH).map((l) => stripAnsi(l));
    expect(bp.filter((l) => /P\d+/.test(l))).toHaveLength(12); // 12 家全显（provs 行仅名字；= 满高预算 vis 12）
    expect(bp[bH - 2]).toContain("Enter 选提供商"); // 快捷键行钉底（notice 上一行）
    // models：30 个模型钳到满高预算 vis=bodyHFull−5（含函数头说明+空行两行）、窗口跟随选中项、快捷键行钉底
    s.handleKey("enter"); // → models（异步清单）
    await new Promise((r) => setTimeout(r, 0));
    const gm = s.render(120, 30);
    const mH = gm.lines.length - 6;
    expect(mH).toBe(17); // 长清单 → 满框
    const bm = gm.lines.slice(3, 3 + mH).map((l) => stripAnsi(l));
    expect(bm.filter((l) => /m\d+/.test(l))).toHaveLength(12); // vis = 17−5（说明+空行+铅行+快捷键+notice）
    expect(bm[mH - 2]).toContain("Enter 钉住");
    for (let i = 0; i < 14; i++) s.handleKey("down"); // sel=14 → 窗口跟随（start=13，选中项落第二行）
    const gm2 = s.render(120, 30);
    expect(stripAnsi(gm2.lines[6]!)).toContain("m13"); // 首行 = start 项
    expect(stripAnsi(gm2.lines[7]!)).toContain("▌m14"); // 选中项（▌ 高亮）落列表第二行
  });
});

describe("p2 选默认模型子态（2026-10-07 修——裸名 setModel 的前置：旧版输完 Key 直写 provider = 裸槽名，条目无 defaultModel，写出解析必炸的自相矛盾配置）", () => {
  it("① 输完 Key 进子态：清单到达可选定，写 defaultModel 在前、setModel 裸名在后；渲染含铅行与模型行", async () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps);
    s.handleKey("ctrl+n");
    s.handleKey("enter"); type(s, "ok-1"); s.handleKey("enter");
    expect(s.stateRef.p2.mode).toBe("pick");
    expect(s.stateRef.p2.pickFor).toBe("openai");
    expect(s.stateRef.p2.pickLoading).toBe(true); // 先落「加载中」
    await new Promise((r) => setTimeout(r, 0));
    expect(s.stateRef.p2.pickModels).toEqual(["glm-5.3", "glm-5.3-air"]);
    const txt = stripAnsi(s.render(120, 30).lines.join("\n"));
    expect(txt).toContain("选一个默认模型"); // 铅行（OpenAI）
    expect(txt).toContain("glm-5.3");
    s.handleKey("down"); s.handleKey("enter"); // 选 glm-5.3-air
    expect(calls.defaults).toEqual([["openai", "glm-5.3-air"]]);
    expect(calls.models).toEqual(["openai"]); // 首个自动设为当前使用
    expect(s.stateRef.p2.active).toBe("openai");
    expect(s.stateRef.p2.mode).toBe("list");
  });

  it("② 清单拉取失败 → 手输行回退（SW-24 口径）：输入模型名回车写盘；Backspace 删草稿", async () => {
    const { deps, calls } = mkDeps({ listModels: async () => { throw new Error("端点不可达"); } });
    const s = new OnboardingSession(deps);
    s.handleKey("ctrl+n");
    s.handleKey("enter"); type(s, "ok-1"); s.handleKey("enter");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.stateRef.p2.pickManual).toBe(true);
    type(s, "glm-4.7");
    s.handleKey("backspace"); // 删一位 → glm-4.
    expect(s.stateRef.p2.pickDraft).toBe("glm-4.");
    type(s, "7");
    s.handleKey("enter");
    expect(calls.defaults).toEqual([["openai", "glm-4.7"]]);
    expect(calls.models).toEqual(["openai"]);
  });

  it("③ 空清单同失败回退手输（SW-24）；手输粘贴整段进草稿", async () => {
    const { deps, calls } = mkDeps({ listModels: async () => [] });
    const s = new OnboardingSession(deps);
    s.handleKey("ctrl+n");
    s.handleKey("enter"); type(s, "ok-1"); s.handleKey("enter");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.stateRef.p2.pickManual).toBe(true);
    s.handlePaste("glm-5.3\r\n");
    s.handleKey("enter");
    expect(calls.defaults).toEqual([["openai", "glm-5.3"]]);
  });

  it("④ 放弃选择（Backspace）回列表：零写盘、ctrl+n 仍锁 needOne、定位回该槽行", async () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps);
    s.handleKey("ctrl+n");
    s.handleKey("down"); s.handleKey("down");
    s.handleKey("enter"); type(s, "zk-1"); s.handleKey("enter");
    expect(s.stateRef.p2.mode).toBe("pick");
    s.handleKey("backspace"); // 放弃
    expect(s.stateRef.p2.mode).toBe("list");
    expect(s.stateRef.p2.sel).toBe(2); // 回列表定位到该槽（zhipu）
    expect(calls.defaults).toEqual([]);
    expect(calls.models).toEqual([]); // 不写裸名——引导写盘 bug 的修复核心
    s.handleKey("ctrl+n");
    expect(s.stateRef.page).toBe(2); // active 仍空 → 锁定
    expect(s.stateRef.p2.notice).toContain("先配置一个提供商");
    // Space 重进选模型（configured 无 modelDone）
    s.handleKey(" ");
    expect(s.stateRef.p2.mode).toBe("pick");
    expect(s.stateRef.p2.notice).toContain("还没有默认模型");
    await new Promise((r) => setTimeout(r, 0));
    s.handleKey("enter");
    expect(calls.defaults).toEqual([["zhipu", "glm-5.3"]]); // 选定补写
    expect(calls.models).toEqual(["zhipu"]); // Space 语义：选定即设当前使用
  });

  it("⑤ 槽已带默认模型（重走引导/重输 Key，initial.modelDone）→ 不进子态，旧路径直设当前使用", async () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps, { configured: ["zhipu", "openai"], active: null, modelDone: ["zhipu"] });
    s.handleKey("ctrl+n");
    s.handleKey("down"); s.handleKey("down");
    s.handleKey("enter"); type(s, "zk-2"); s.handleKey("enter");
    expect(s.stateRef.p2.mode).toBe("key"); // 不进选模型——留输入态（旧口径：可继续换行输别家 Key）
    expect(calls.models).toEqual(["zhipu"]); // 首个自动设为当前使用（裸名此刻合法）
    expect(s.stateRef.p2.notice).toContain("并设为当前使用");
    // Space 切到 openai（无默认模型）→ 进子态而非裸名 setModel
    s.handleKey("up"); s.handleKey("up"); s.handleKey(" ");
    expect(s.stateRef.p2.mode).toBe("pick");
    expect(calls.models).toEqual(["zhipu"]);
  });
});

describe("几何钳制（CTU-05 回归钉 2026-09-28——下限钳制把「最小设计尺寸 40×12」置于终端实际尺寸之上：cols≤40 时 mw=40 ≥ cols、col=0 合成行写满底行右角格，conhost 无 DECAWM 自动换行滚屏；P1 body 恒 7 行只垫不裁使 lines 超 mh 预算。修复后 col+width ≤ cols−1 恒成立〔popuplayout availW=cols−1 同口径〕、body 裁到 bodyH）", () => {
  // 合成末行宽 = col + 可见行宽（fullscreen overlay 合成后不再受底行 cols−1 截断——防御①只在文本层）
  const composedLastRowW = (g: { lines: string[]; row: number; col: number; width: number }): number =>
    g.col + Math.max(...g.lines.map((l) => visibleWidth(l)));

  it("① 边界矩阵：cols×rows 全档（含旧口径全数越界的 cols≤40 × rows 9–14）合成末行宽 ≤ cols−1、行不越屏", () => {
    const { deps } = mkDeps();
    for (const page of [1, 2, 3] as const) {
      const s = new OnboardingSession(deps, { configured: ["zhipu"], active: "zhipu" });
      for (let p = 1; p < page; p++) s.handleKey("ctrl+n");
      if (page === 2) s.handleKey("enter"); // key 输入态（body 行数最多的一档）
      for (const cols of [12, 20, 30, 36, 40, 41, 44, 60, 96, 110]) {
        for (const rows of [7, 9, 10, 11, 12, 13, 14, 15, 20, 30]) {
          const g = s.render(cols, rows);
          expect(g.col + g.width, `p${page} ${cols}×${rows} 宽`).toBeLessThanOrEqual(cols - 1);
          expect(composedLastRowW(g), `p${page} ${cols}×${rows} 合成末行`).toBeLessThanOrEqual(cols - 1);
          expect(g.row + g.lines.length, `p${page} ${cols}×${rows} 高`).toBeLessThanOrEqual(Math.max(rows, 6));
        }
      }
    }
  });

  it("② 具体边界钉：cols=36 弹窗宽 = cols−1 = 35（旧 40 越界）；rows=10 行数 ≤ 10（旧 P1 body 溢出 13 行）", () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps);
    const g36 = s.render(36, 30);
    expect(g36.width).toBe(35); // 旧：max(40, 28) = 40 > cols
    expect(g36.col).toBe(0);
    const g = s.render(36, 10);
    expect(g.lines.length).toBeLessThanOrEqual(10); // 旧：mh=12、body 只垫不裁 → 13 行
    expect(g.lines.length).toBeGreaterThanOrEqual(6); // 退化也保住框结构（顶框/头/底框可见）
  });

	it("③ 大终端零变化：cols≥46 宽度与旧口径同值（96 基准不回归）；2026-10-07 框高随内容收缩后行数 ≤ 旧恒值、第 2 页仍恒撑满", () => {
		const { deps } = mkDeps();
		const s = new OnboardingSession(deps);
		expect(s.render(104, 26).width).toBe(96); // max(40, min(96, 96)) 同旧
		expect(s.render(60, 30).width).toBe(52); // max(40, 52) 同旧
		expect(s.render(104, 20).lines.length).toBeLessThanOrEqual(17); // 收缩后 ≤ 旧恒 bodyH=11 档（P1 实际 8 行内容 → 14）
		s.handleKey("ctrl+n");
		expect(s.render(104, 20).lines).toHaveLength(17); // 第 2 页恒撑满（列表分页/输入块钉底都以满高布局）
	});

	it("④ 贴输入框上缘 + 与输入框同宽同左缘（2026-10-02 拍板，推翻居中+固定 96 宽）：dock = 输入框几何 → 底边贴其上一行、col=0、width=输入框宽；不传保持居中", () => {
		const { deps } = mkDeps();
		const s = new OnboardingSession(deps);
		const g = s.render(110, 30, { bottom: 25, width: 98 });
		expect(g.row).toBe(25 - g.lines.length); // 弹窗 ╰ 在 divRow−1，与 view/dialog 窗 dock 几何同款
		expect(g.row + g.lines.length).toBe(25);
		expect(g.col).toBe(0); // 左缘 = 输入框左缘（左栏 col=0）
		expect(g.width).toBe(98); // 宽度 = 输入框宽 leftW（不再钉 96）
		expect(g.col + g.width).toBeLessThanOrEqual(109); // CTU-05 不变量 col+width ≤ cols−1 不破
		const narrow = s.render(110, 30, { bottom: 25, width: 120 }); // 越界宽钳到 cols−1（左栏不会这么宽，防御性）
		expect(narrow.width).toBe(109);
		const c = s.render(110, 30); // 不传 → 居中兜底（几何矩阵测试口径不变）
		expect(c.row).toBe(Math.floor((30 - c.lines.length) / 2));
		expect(c.col).toBe(Math.floor((110 - c.width) / 2));
	});

	it("⑤ 简介行回流（2026-10-02 走查：102 格 > 内容区 93 格被截尾丢「可插拔。」）：折行无损、尾巴可见、恒宽不破", () => {
		const { deps } = mkDeps();
		const s = new OnboardingSession(deps);
		const g = s.render(110, 30);
		const joined = g.lines.map((l) => stripAnsi(l).replace(/[│╭╮╰╯─]/g, "")).join("").replace(/\s+/g, "");
		expect(joined).toContain("可插拔。"); // 旧被截掉的尾巴
		expect(joined).toContain("模型与能力都可插拔"); // 全句完整（折行不丢字；垫空格已剥）
		for (const l of g.lines) expect(visibleWidth(l)).toBe(g.width); // 每行账面恒宽（右框线不漂）
	});

	it("⑥ p2 列表动态页大小 + 提示行钉底（2026-10-02 用户拍板）：列表撑满正文至「第 x / y 页」上一行、提示行贴灰色分隔线、翻页键与渲染同源", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, envKey: `P${i}_KEY`, baseUrl: "https://x", type: "openai" as const }));
		const { deps } = mkDeps({ providers: many });
		const s = new OnboardingSession(deps);
		s.handleKey("ctrl+n"); // → p2 列表态
		const g = s.render(120, 30);
		const bodyH = g.lines.length - 6; // 正文行数 = 总行数 − 顶框/标题/头分隔/脚分隔/脚/底框 6 行
		const pageSize = s.stateRef.p2.pageSize;
		expect(pageSize).toBe(bodyH - 2); // 动态 = 正文 − 提示行 − notice 行
		expect(pageSize).toBeGreaterThan(4);
		const body = g.lines.slice(3, 3 + bodyH).map((l) => stripAnsi(l));
		expect(body.filter((l) => l.includes("_KEY"))).toHaveLength(pageSize); // 列表撑满页宽（行含 envKey 即提供商行）
		expect(body[bodyH - 1]).toContain("第 1 /"); // 提示行 = 正文末行
		expect(body[bodyH - 1]).toContain("PgUp / PgDn 翻页");
		expect(body[bodyH - 2]!.replace(/│/g, "").trim()).toBe(""); // 其上一行 = notice 占位（剥框后空）
		expect(stripAnsi(g.lines[3 + bodyH]!)).toMatch(/^│─+│$/); // 提示行下一行 = 灰色分隔线（钉底成立）
		// 动态收缩：小终端页宽跟随正文
		const small = s.stateRef.p2.pageSize;
		s.render(60, 16);
		expect(s.stateRef.p2.pageSize).toBeLessThan(small);
		// 翻页键与渲染同源：PgDn → 页 2 首行 = providers[pageSize]
		s.render(120, 30);
		s.handleKey("pageDown");
		expect(s.stateRef.p2.pageIdx).toBe(1);
		expect(s.stateRef.p2.sel).toBe(pageSize);
		const g2 = s.render(120, 30);
		expect(stripAnsi(g2.lines[3]!)).toContain("P15"); // 页 2 首行（0..pageSize−1 在页 1）
		expect(s.stateRef.p2.pageSize).toBe(pageSize); // 同尺寸页宽稳定
	});

	it("⑦ p2 key 态列表撑满 + 输入块钉底（2026-10-07 用户走查：旧收窄恒 4 行大半正文空白、静默行悬中腰）：列表能显多少显多少、快捷键/空行/粘贴提示/静默盲输/notice 五行恒贴底", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, envKey: `P${i}_KEY`, baseUrl: "https://x", type: "openai" as const }));
		const { deps } = mkDeps({ providers: many });
		const s = new OnboardingSession(deps);
		s.handleKey("ctrl+n"); // → p2 列表态
		for (let i = 0; i < 6; i++) s.handleKey("down"); // sel=6（窗口跟随：选中项落列表第二行）
		s.handleKey("enter"); // → key 态
		const g = s.render(120, 30);
		const bodyH = g.lines.length - 6;
		const body = g.lines.slice(3, 3 + bodyH).map((l) => stripAnsi(l));
		const vis = bodyH - 5; // 列表区 = 正文 − 快捷键/空行/粘贴/静默/notice 五行
		const rows = body.filter((l) => l.includes("_KEY"));
		expect(rows).toHaveLength(vis); // 列表撑满剩余正文（旧：恒 4 行）
		expect(rows[0]).toContain("P5");
		expect(rows[1]).toContain("P6"); // 窗口跟随选中项
		expect(body[bodyH - 5]).toContain("↑ ↓ 换提供商"); // 快捷键行
		expect(body[bodyH - 4]!.replace(/│/g, "").trim()).toBe(""); // 空行
		expect(body[bodyH - 3]).toContain("粘贴 P6 的 API Key"); // 粘贴提示行
		expect(body[bodyH - 2]).toContain("静默盲输"); // 静默盲输行贴底（正文倒数第二行）
		expect(body[bodyH - 1]!.replace(/│/g, "").trim()).toBe(""); // notice 占位 = 正文末行
		expect(stripAnsi(g.lines[3 + bodyH]!)).toMatch(/^│─+│$/); // 钉底成立：正文下一行 = 灰色分隔线
		// 小终端退化：bodyH≤5 时 vis 钳 1、裁尾兜底不炸
		expect(() => s.render(80, 12)).not.toThrow();
	});
});

// F14 第 3 页 · 配置视觉模型（D12 三态 + 5 行恒定列表 + 可跳过默认不开启）
describe("首次使用引导弹窗 · p3 视觉模型页（m5-media F14）", () => {
  const toP3 = (s2: OnboardingSession): void => {
    s2.handleKey("ctrl+n"); s2.handleKey("ctrl+n"); // → p3 视觉页
  };

  it("F14-① 三选项：停用/auto 写盘即留页提示；Ctrl+N 跳过零写入（默认不开启）", () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps, { configured: ["zhipu"], active: "zhipu" });
    toP3(s);
    expect(s.stateRef.page).toBe(3);
    s.handleKey("enter"); // opts[0] 停用
    expect(calls.vision).toEqual(["off"]);
    expect(s.stateRef.pv.notice).toContain("tool-media");
    s.handleKey("down"); s.handleKey("enter"); // auto
    expect(calls.vision).toEqual(["off", "auto"]);
    expect(s.stateRef.pv.notice).toContain("自动");
    const { calls: c2 } = mkDeps();
    const s3 = new OnboardingSession(deps, { configured: ["zhipu"], active: "zhipu" });
    s3.handleKey("ctrl+n"); s3.handleKey("ctrl+n"); s3.handleKey("ctrl+n"); // 直接跳过
    expect(s3.stateRef.page).toBe(4);
    expect(c2.vision).toEqual([]); // 跳过不写盘（缺省即 off）
  });

  it("F14-② 指定模型：Enter 进列表（异步清单到达）→ Enter 写盘限定形；Backspace 回选项页", async () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps, { configured: ["zhipu"], active: "zhipu" });
    toP3(s);
    s.handleKey("down"); s.handleKey("down"); s.handleKey("enter"); // 指定模型 → list
    expect(s.stateRef.pv.mode).toBe("list");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.stateRef.pv.models).toEqual(["zai/glm-5.3-flash", "zai/glm-4.6v"]);
    s.handleKey("enter"); // 选第一个
    expect(calls.vision).toEqual(["zai/glm-5.3-flash"]);
    s.handleKey("backspace"); // 已在 opts——backspace 无副作用
    expect(s.stateRef.pv.mode).toBe("opts");
  });

  it("F14-③ 空清单空态指路；拉取失败同回退提示；Ctrl+N 始终可走", async () => {
    const { deps } = mkDeps({ visionModels: async () => [] });
    const s = new OnboardingSession(deps, { configured: ["zhipu"], active: "zhipu" });
    toP3(s);
    s.handleKey("down"); s.handleKey("down"); s.handleKey("enter");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.stateRef.pv.notice).toContain("没有目录可证的多模态模型");
    const { deps: d2 } = mkDeps({ visionModels: async () => { throw new Error("目录不可读"); } });
    const s2 = new OnboardingSession(d2, { configured: ["zhipu"], active: "zhipu" });
    toP3(s2);
    s2.handleKey("down"); s2.handleKey("down"); s2.handleKey("enter");
    await new Promise((r) => setTimeout(r, 0));
    expect(s2.stateRef.pv.notice).toContain("读取失败");
    expect(s2.handleKey("ctrl+n")).toBeUndefined();
    expect(s2.stateRef.page).toBe(4);
  });

  it("F14-④ 渲染钉：视觉页标题/三选项行/列表恒定 5 行（防闪烁铁律）", () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps, { configured: ["zhipu"], active: "zhipu" });
    toP3(s);
    const r1 = s.render(80, 24);
    const txt = r1.lines.map((l) => stripAnsiSafe(l)).join("\n");
    expect(txt).toContain("配置视觉模型");
    expect(txt).toContain("暂不启用（默认）");
    expect(txt).toContain("指定视觉模型");
    expect(r1.lines).toHaveLength(s.render(80, 24).lines.length); // 定高
  });
});

/** 测试内小件：剥 ANSI（onboarding.test 顶部已有 stripAnsi 则复用——此处防御性自带）。 */
function stripAnsiSafe(s2: string): string {
  // 终端代码合法形态：ANSI 判定正则必须含 ESC 控制符（lint 基线批定点豁免——width.ts 同款）
  // oxlint-disable-next-line no-control-regex
  return s2.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("首次使用引导弹窗 · p5 导入记忆页（m5-peers T6d）", () => {
  const SRC = [
    { id: "claude-code", label: "Claude Code", note: "~/.claude/…", count: 12, available: true },
    { id: "zcode", label: "ZCode", note: "~/.zcode/cli/…", count: 37, available: true },
    { id: "qwen", label: "qwen-code", note: "", count: 0, available: true },
    { id: "codex", label: "codex", note: "~/.codex/…", count: 0, available: false },
  ];
  const toP5 = async (over: Partial<OnboardingDeps> = {}): Promise<OnboardingSession> => {
    const { deps } = mkDeps({ detectMemorySources: () => SRC, ...over });
    const s = new OnboardingSession(deps);
    s.handleKey("ctrl+n"); s.handleKey("enter"); type(s, "k"); s.handleKey("enter");   // p2 输 Key → 选模型子态
    await new Promise((r) => setTimeout(r, 0));   // 清单到达
    s.handleKey("enter");   // 选定默认模型（首个自动设为当前使用）
    s.handleKey("ctrl+n"); s.handleKey("ctrl+n");   // p3 视觉跳过 → p4
    s.handleKey("enter"); s.handleKey("enter"); s.handleKey("ctrl+n");   // p4 选定 → p5
    return s;
  };

  it("① Space 勾选/取消；0 条与未安装源给提示不可勾", async () => {
    const s = await toP5();
    expect(s.stateRef.page).toBe(5);
    s.handleKey(" ");   // sel=0 Claude Code → 勾
    expect([...s.stateRef.pm.checked]).toEqual(["claude-code"]);
    s.handleKey(" ");   // 再按 → 取消
    expect(s.stateRef.pm.checked.size).toBe(0);
    s.handleKey("down"); s.handleKey("down");   // sel=2 qwen 0 条
    s.handleKey(" ");
    expect(s.stateRef.pm.notice).toContain("没有可导入的笔记");
    s.handleKey("down"); s.handleKey(" ");   // sel=3 codex 未安装
    expect(s.stateRef.pm.notice).toContain("没有可导入的笔记");
    expect(s.stateRef.pm.checked.size).toBe(0);
  });

  it("② 整理开关行 Space 切换（默认关——D20）", async () => {
    const s = await toP5();
    for (let i = 0; i < SRC.length; i++) s.handleKey("down");   // sel=4 = 开关行
    expect(s.stateRef.pm.organize).toBe(false);
    s.handleKey(" ");
    expect(s.stateRef.pm.organize).toBe(true);
  });

  it("③ ctrl+n 有勾选 → 异步导入 → finish 回调带 importResult；期间再按不理", async () => {
    const finished: unknown[] = [];
    let importedArgs: [string[], boolean] | undefined;
    const s = await toP5({
      importMemory: async (ids, organize) => { importedArgs = [ids, organize]; return { imported: 49, skipped: 3, merged: 0 }; },
      finish: (o) => { finished.push(o); },
    });
    s.handleKey("down");   // sel=1 ZCode
    s.handleKey(" ");
    expect(s.handleKey("ctrl+n")).toBeUndefined();   // 导入中不完成
    expect(importedArgs).toEqual([["zcode"], false]);
    await new Promise((r) => setTimeout(r, 10));
    expect(finished).toEqual([{ kind: "completed", importResult: { imported: 49, skipped: 3, merged: 0 } }]);
    expect(s.stateRef.pm.notice).toContain("已导入 49 条");
  });

  it("④ organize 开启时 importMemory 收到 true（开关透传）", async () => {
    let got: boolean | undefined;
    const s = await toP5({ importMemory: async (_ids, organize) => { got = organize; return { imported: 1, skipped: 0, merged: 1 }; } });
    for (let i = 0; i < SRC.length; i++) s.handleKey("down");   // 开关行
    s.handleKey(" ");   // 开
    s.handleKey("up");   // 回源行（qwen 0 条…再 up 到 codex？——up 到 sel=3 codex 不可勾）
    s.handleKey("up");   // sel=2
    s.handleKey("up");   // sel=1 ZCode
    s.handleKey(" ");
    s.handleKey("ctrl+n");
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toBe(true);
  });

  it("⑤ 导入失败 → err notice、不 finish（可直接 Ctrl+N 完成）", async () => {
    const finished: unknown[] = [];
    const s = await toP5({
      importMemory: async () => { throw new Error("disk"); },
      finish: (o) => { finished.push(o); },
    });
    s.handleKey(" ");
    s.handleKey("ctrl+n");
    await new Promise((r) => setTimeout(r, 10));
    expect(finished).toEqual([]);
    expect(s.stateRef.pm.notice).toContain("导入失败");
    expect(s.handleKey("ctrl+n")).toEqual({ kind: "completed" });   // 手动完成兜底
  });

  it("⑥ 渲染：标题「从其他 agent 导入记忆」、源行含条数、整理开关含 token 提示、未勾选 ctrl+n 脚注 why", async () => {
    const s = await toP5();
    const text = stripAnsi(s.render(120, 30).lines.join("\n"));
    expect(text).toContain("引导 5 / 5");
    expect(text).toContain("从其他 agent 导入记忆");
    expect(text).toContain("12 条笔记");
    expect(text).toContain("未安装");
    expect(text).toContain("用模型整理导入的记忆");
    expect(text).toContain("逐条优化内容");
  });
});
