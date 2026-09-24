import { describe, it, expect } from "vitest";
import { OnboardingSession, type OnboardingDeps, type OnboardingProvider } from "./onboarding.ts";

const PROVIDERS: OnboardingProvider[] = [
  { id: "openai", name: "OpenAI", envKey: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", type: "openai", local: false },
  { id: "anthropic", name: "Anthropic", envKey: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com", type: "anthropic", local: false },
  { id: "zhipu", name: "智谱 GLM", envKey: "ZHIPU_API_KEY", baseUrl: "https://open.bigmodel.cn/api/paas/v4", type: "openai", local: false },
  { id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", type: "openai", local: true },
];

interface Calls {
  providers: { id: string; apiKey?: string }[];
  secrets: [string, string][];
  models: string[];
  searchPatches: Record<string, unknown>[];
  renders: number;
}

const mkDeps = (over: Partial<OnboardingDeps> = {}): { deps: OnboardingDeps; calls: Calls } => {
  const calls: Calls = { providers: [], secrets: [], models: [], searchPatches: [], renders: 0 };
  const deps: OnboardingDeps = {
    providers: PROVIDERS,
    writeProvider: (p) => { calls.providers.push({ id: p.id, ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}) }); },
    appendSecret: (k, v) => { calls.secrets.push([k, v]); },
    setModel: (slot) => { calls.models.push(slot); },
    writeSearch: (patch) => { calls.searchPatches.push(patch as Record<string, unknown>); },
    listModels: over.listModels ?? (async () => ["glm-5.3", "glm-5.3-air"]),
    requestRender: () => { calls.renders += 1; },
    ...over,
  };
  return { deps, calls };
};

const type = (s: OnboardingSession, text: string): void => { for (const ch of text) s.handleKey(ch); };

describe("首次使用引导弹窗（M4-3 T1d——施工基准 onboarding 原型）", () => {
  it("① 三页流转与锁定：p1 Ctrl+N 进 p2；p2 未配 Ctrl+N 锁定带原因；配好进 p3；p3 未选 Ctrl+N 锁定；选定后完成", async () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps);
    expect(s.handleKey("ctrl+n")).toBeUndefined();
    expect(s.stateRef.page).toBe(2);
    // p2 未配置：Ctrl + N 锁定 + 原因提示（不发完成）
    expect(s.handleKey("ctrl+n")).toBeUndefined();
    expect(s.stateRef.page).toBe(2);
    expect(s.stateRef.p2.notice).toContain("先配置一个提供商");
    // 配一家（zhipu，sel=2）
    s.handleKey("down"); s.handleKey("down");
    s.handleKey("enter"); // 进输入态
    type(s, "zk-1");
    s.handleKey("enter"); // 确认 Key
    expect(calls.secrets).toEqual([["ZHIPU_API_KEY", "zk-1"]]);
    expect(calls.models).toEqual(["zhipu"]); // 首个配好自动设为当前使用（SW-25）
    // 进 p3
    expect(s.handleKey("ctrl+n")).toBeUndefined();
    expect(s.stateRef.page).toBe(3);
    expect(s.handleKey("ctrl+n")).toBeUndefined(); // 未选定 → 锁定
    expect(s.stateRef.p3.notice).toContain("先选择一个搜索后端");
    // LLM 默认项选定（Enter 进 llm 子态 → 选默认项）
    s.handleKey("enter");
    s.handleKey("enter");
    expect(calls.searchPatches).toEqual([{ backend: "auto", model: undefined }]);
    expect(s.stateRef.p3.chosen).toBe("llm");
    expect(s.handleKey("ctrl+n")).toEqual({ kind: "completed" });
  });

  it("② p2 多家配置 + Space 切换当前使用；未配置行 Space 给「先输入 Key」提示（SW-25）", () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps);
    s.handleKey("ctrl+n");
    // 配 openai（sel=0）
    s.handleKey("enter"); type(s, "ok-1"); s.handleKey("enter");
    // 配 anthropic（sel=1）
    s.handleKey("down"); s.handleKey("enter"); type(s, "ak-1"); s.handleKey("enter");
    expect(calls.models).toEqual(["openai"]); // 只有首个自动设为当前使用
    expect(s.stateRef.p2.active).toBe("openai");
    // Space 切到 anthropic
    s.handleKey(" ");
    expect(calls.models).toEqual(["openai", "anthropic"]);
    expect(s.stateRef.p2.active).toBe("anthropic");
    // 未配置行（zhipu sel=2）Space → 提示
    s.handleKey("down"); s.handleKey(" ");
    expect(s.stateRef.p2.notice).toContain("先输入 智谱 GLM 的 Key");
    expect(calls.models).toEqual(["openai", "anthropic"]);
  });

  it("③ p2 本地服务免 Key：Enter 即配置并自动当前使用（ollama）", () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps);
    s.handleKey("ctrl+n");
    s.handleKey("down"); s.handleKey("down"); s.handleKey("down"); // ollama sel=3
    s.handleKey("enter"); // list → key 态
    s.handleKey("enter"); // key 态回车 = 确认（免 Key）
    expect(calls.providers).toEqual([{ id: "ollama" }]);
    expect(calls.secrets).toEqual([]);
    expect(calls.models).toEqual(["ollama"]);
    expect(s.stateRef.p2.notice).toContain("本地服务无需 Key");
  });

  it("④ p2 空 Key 回车 → 暖金提示；输入态 ↑↓ 换行草稿按行保留（SW-25）", () => {
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

  it("⑤ p3 LLM 跨提供商钉选：llm → provs → models → 钉选值 provider/model 限定形（SW-24）", async () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps, { configured: ["zhipu", "openai"], active: "zhipu" });
    s.handleKey("ctrl+n"); s.handleKey("ctrl+n"); // → p3
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

  it("⑥ p3 模型清单拉取失败 → 手动输入行回退（SW-24）", async () => {
    const { deps, calls } = mkDeps({ listModels: async () => { throw new Error("端点不可达"); } });
    const s = new OnboardingSession(deps, { configured: ["zhipu"], active: "zhipu" });
    s.handleKey("ctrl+n"); s.handleKey("ctrl+n");
    s.handleKey("enter"); s.handleKey("down"); s.handleKey("enter");
    s.handleKey("enter"); // 选 zhipu
    await new Promise((r) => setTimeout(r, 0));
    expect(s.stateRef.p3.stage).toBe("manual");
    type(s, "glm-5.3");
    s.handleKey("enter");
    expect(calls.searchPatches).toEqual([{ backend: "auto", model: "zhipu/glm-5.3" }]);
  });

  it("⑦ p3 Tavily key：输入 → secrets + 占位符写盘；输入态 ↑↓ 可换 Brave（草稿按行保留）", () => {
    const { deps, calls } = mkDeps();
    const s = new OnboardingSession(deps, { configured: ["zhipu"], active: "zhipu" });
    s.handleKey("ctrl+n"); s.handleKey("ctrl+n");
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
    expect(s.handleKey("ctrl+n")).toEqual({ kind: "completed" });
  });

  it("⑧ Ctrl + Q 仅第 1 页退出；第 2/3 页给提示不退出（SW-22）", () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps);
    expect(s.handleKey("ctrl+q")).toEqual({ kind: "quit" });
    const s2 = new OnboardingSession(deps);
    s2.handleKey("ctrl+n");
    expect(s2.handleKey("ctrl+q")).toBeUndefined();
    expect(s2.stateRef.p2.notice).toContain("仅在第 1 页可用");
    expect(s2.stateRef.page).toBe(2);
  });

  it("⑨ Backspace 逐级返回链（SW-24）：models→provs→llm→opts；key 空草稿→opts", async () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps, { configured: ["zhipu"], active: "zhipu" });
    s.handleKey("ctrl+n"); s.handleKey("ctrl+n");
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

  it("⑩ 渲染定高钉：三页与各状态下弹窗总行数恒定（浮层防闪烁纪律——条件性增删行即闪烁源）", async () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps);
    const h = (sess: OnboardingSession) => sess.render(120, 30).lines.length;
    const h1 = h(s);
    s.handleKey("ctrl+n"); // p2 list
    const h2 = h(s);
    s.handleKey("enter"); // p2 key 态（列表收窄 4 行）
    const h3 = h(s);
    s.handleKey("backspace"); // 回 list
    s.handleKey("down"); s.handleKey("down"); s.handleKey("enter"); type(s, "zk"); s.handleKey("enter");
    s.handleKey("ctrl+n"); // p3
    const h4 = h(s);
    s.handleKey("enter"); // llm 子态
    const h5 = h(s);
    expect(new Set([h1, h2, h3, h4, h5]).size).toBe(1);
    // 小终端等比收窄（760×540 原型值按字符栅格适配——SW-22）
    const small = s.render(80, 20);
    expect(small.lines.length).toBeLessThanOrEqual(18);
    expect(small.width).toBeLessThanOrEqual(72);
  });

  it("⑪ 渲染内容钉：页头步进/标题、页脚键位带空格（Ctrl + N）、锁定置灰原因、Esc 未占用注记", () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps);
    const p1 = s.render(120, 30).lines.join("\n");
    expect(p1).toContain("引导 1 / 3");
    expect(p1).toContain("欢迎使用 Orosus（连山）");
    expect(p1).toContain("Ctrl + N");
    expect(p1).toContain("Esc 未占用");
    s.handleKey("ctrl+n");
    const p2 = s.render(120, 30).lines.join("\n");
    expect(p2).toContain("引导 2 / 3");
    expect(p2).toContain("先配好一家提供商"); // 锁定原因（Ctrl + N 置灰带 why）
    expect(p2).toContain("本地"); // ollama 本地标记
    // key 态静默盲输形态（SW-23：已输入 N 字符，不逐键掩码）
    s.handleKey("enter"); type(s, "abc");
    const p2k = s.render(120, 30).lines.join("\n");
    expect(p2k).toContain("已输入 3 字符");
    expect(p2k).not.toContain("●●●");
  });

  it("⑫ 粘贴路由：输入态 handlePaste 整段进草稿（API Key 首要输入方式）；非输入态吞掉", () => {
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
});
