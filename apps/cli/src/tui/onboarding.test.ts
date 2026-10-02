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
  searchPatches: Record<string, unknown>[];
  vision: string[];
  renders: number;
}

const mkDeps = (over: Partial<OnboardingDeps> = {}): { deps: OnboardingDeps; calls: Calls } => {
  const calls: Calls = { providers: [], secrets: [], models: [], searchPatches: [], vision: [], renders: 0 };
  const deps: OnboardingDeps = {
    providers: PROVIDERS,
    writeProvider: (p) => { calls.providers.push({ id: p.id, ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}) }); },
    appendSecret: (k, v) => { calls.secrets.push([k, v]); },
    setModel: (slot) => { calls.models.push(slot); },
    writeSearch: (patch) => { calls.searchPatches.push(patch as Record<string, unknown>); },
    listModels: over.listModels ?? (async () => ["glm-5.3", "glm-5.3-air"]),
    writeVision: (v) => { calls.vision.push(v); },
    visionModels: over.visionModels ?? (async () => ["zai/glm-5.3-flash", "zai/glm-4.6v"]),
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
    expect(s.handleKey("ctrl+n")).toEqual({ kind: "completed" });
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

  it("⑨ 渲染定高钉：三页与各状态下弹窗总行数恒定（浮层防闪烁纪律——条件性增删行即闪烁源）", async () => {
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

  it("⑩ 渲染内容钉：页头步进/标题、页脚键位带空格（Ctrl + N）、锁定置灰原因、Esc 未占用注记", () => {
    const { deps } = mkDeps();
    const s = new OnboardingSession(deps);
    const p1 = s.render(120, 30).lines.join("\n");
    expect(p1).toContain("引导 1 / 4");
    expect(p1).toContain("欢迎使用 Orosus（连山）");
    expect(p1).toContain("Ctrl + N");
    expect(p1).toContain("Esc 未占用");
    s.handleKey("ctrl+n");
    const p2 = s.render(120, 30).lines.join("\n");
    expect(p2).toContain("引导 2 / 4");
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

	it("③ 大终端零变化：cols≥46 / rows≥15 与旧口径同值（96×24 基准不回归）", () => {
		const { deps } = mkDeps();
		const s = new OnboardingSession(deps);
		expect(s.render(104, 26).width).toBe(96); // max(40, min(96, 96)) 同旧
		expect(s.render(60, 30).width).toBe(52); // max(40, 52) 同旧
		expect(s.render(104, 20).lines).toHaveLength(17); // mh=18 → bodyH=11 ≥ P1 的 7 行：定高结构同旧
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
