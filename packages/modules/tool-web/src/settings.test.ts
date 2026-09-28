import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandUi, LlmPort } from "@orosus/contracts/module";
import { createSearchState } from "./search.ts";
import { createSettingsHandler, persistToolWebSearch, upsertSecret } from "./settings.ts";

let dir: string;
let configFile: string;
let secretsFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orosus-twsettings-"));
  configFile = join(dir, "config.toml");
  secretsFile = join(dir, "secrets.env");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 脚本化假 ui：choose 按队列出答案并记录问题；askSecret 记录调用（掩码通道钉——key 必须走它不走 ask）。 */
const mkUi = (over: { chooses?: string[]; secret?: string } = {}) => {
  const asks: string[] = [];
  const secretAsks: string[] = [];
  const chooses: string[] = [];
  const notices: string[] = [];
  const chooseQueue = [...(over.chooses ?? [])];
  const ui: CommandUi = {
    ask: async (q) => { asks.push(q); return ""; },
    askSecret: async (q) => { secretAsks.push(q); return over.secret ?? ""; },
    choose: async (title, items) => { chooses.push(title); const next = chooseQueue.shift(); return next ?? items[0]!; },
    confirm: async () => true,
    notice: (t) => { notices.push(t); },
  };
  return { ui, asks, secretAsks, chooses, notices };
};

const fakeLlm = (models?: string[]): LlmPort => ({
  stream: () => (async function* () { yield* []; })(),
  ...(models !== undefined ? { listModels: async () => models } : {}),
});

const readSecrets = (): string => (existsSync(secretsFile) ? readFileSync(secretsFile, "utf8") : "");

describe("tool-web__settings 配置流（M4-3 T1c）", () => {
  it("① LLM 默认项「自动」：写 backend=auto 且删除既有 model 键（零配置语义）；state 即时同步", async () => {
    writeFileSync(configFile, "[tool-web.search]\nbackend = \"auto\"\nmodel = \"kimi-code-plan-cn/k3-256k\"\n", "utf8");
    const state = createSearchState({ backend: "auto", model: "kimi-code-plan-cn/k3-256k" });
    const { ui, notices } = mkUi({ chooses: ["LLM Web Search——借你已配模型的联网能力（零新 key）", "自动（零配置·默认）"] });
    const handler = createSettingsHandler({ state, llm: fakeLlm(["a/m1"]), configFile, secretsFile });
    const out = await handler("", ui);
    expect(out).toBe(""); // 静默约定——成功走 notice
    const doc = readFileSync(configFile, "utf8");
    expect(doc).toContain('backend = "auto"');
    expect(doc).not.toContain("model");
    expect(state.current()).toEqual({ backend: "auto", model: undefined });
    expect(notices[0]).toContain("自动");
    expect(existsSync(secretsFile)).toBe(false); // LLM 路径不碰 secrets
  });

  it("② LLM 钉模型：listModels 出目录 → 选定 provider/model 限定形写 model", async () => {
    const state = createSearchState({});
    const { ui } = mkUi({ chooses: ["LLM Web Search——借你已配模型的联网能力（零新 key）", "指定模型…", "zhipuai-coding-plan/glm-5.3"] });
    const handler = createSettingsHandler({ state, llm: fakeLlm(["zhipuai-coding-plan/glm-5.3", "kimi-code-plan-cn/k3-256k"]), configFile, secretsFile });
    await handler("", ui);
    expect(readFileSync(configFile, "utf8")).toContain('model = "zhipuai-coding-plan/glm-5.3"');
    expect(state.current().model).toBe("zhipuai-coding-plan/glm-5.3");
  });

  it("③ listModels 不可用 → 钉模型项标「不可用」，选了不写盘只提示", async () => {
    const state = createSearchState({});
    const { ui, chooses, notices } = mkUi({ chooses: ["LLM Web Search——借你已配模型的联网能力（零新 key）", "指定模型…（不可用：当前端点无模型目录）"] });
    const handler = createSettingsHandler({ state, llm: fakeLlm(), configFile, secretsFile });
    await handler("", ui);
    expect(chooses[1]).toBeDefined();
    expect(existsSync(configFile)).toBe(false);
    expect(notices[0]).toContain("没有模型目录");
  });

  it("④ Tavily 全链：askSecret 通道（掩码钉）→ secrets 落真 key + config 写占位符 + backend auto + state 同步", async () => {
    const state = createSearchState({});
    const { ui, asks, secretAsks, notices } = mkUi({ chooses: ["Tavily——搜索 API（官网 tavily.com，需 key）"], secret: "tv-live-123" });
    const handler = createSettingsHandler({ state, llm: fakeLlm(), configFile, secretsFile });
    await handler("", ui);
    expect(secretAsks).toHaveLength(1);
    expect(secretAsks[0]).toContain("tavily.com"); // 菜单内展示官网（SW-16）
    expect(asks).toHaveLength(0); // key 绝不走非掩码通道
    expect(readSecrets()).toContain("TAVILY_API_KEY=tv-live-123");
    const doc = readFileSync(configFile, "utf8");
    expect(doc).toContain('tavilyApiKey = "$ENV:TAVILY_API_KEY"'); // 占位符非真 key（v4.7 机制钉）
    expect(doc).not.toContain("tv-live-123");
    expect(doc).toContain('backend = "auto"');
    expect(state.current().tavilyApiKey).toBe("$ENV:TAVILY_API_KEY");
    expect(notices[0]).toContain("Tavily");
  });

  it("⑤ Brave + 换 key 原地更新（secrets 不累积重复行）", async () => {
    upsertSecret(secretsFile, "BRAVE_API_KEY", "old-key");
    const state = createSearchState({});
    const { ui, secretAsks } = mkUi({ chooses: ["Brave——搜索 API（官网 brave.com/search/api，需 key）"], secret: "br-new-456" });
    const handler = createSettingsHandler({ state, llm: fakeLlm(), configFile, secretsFile });
    await handler("", ui);
    expect(secretAsks[0]).toContain("brave.com/search/api");
    const secrets = readSecrets();
    expect(secrets).toContain("BRAVE_API_KEY=br-new-456");
    expect(secrets).not.toContain("old-key");
    expect(secrets.match(/BRAVE_API_KEY=/g)).toHaveLength(1);
    expect(readFileSync(configFile, "utf8")).toContain('braveApiKey = "$ENV:BRAVE_API_KEY"');
  });

  it("⑥ 空输入 = 取消不写盘；upsertSecret/persistToolWebSearch 直驱：model undefined 删键语义", async () => {
    const state = createSearchState({});
    const { ui } = mkUi({ chooses: ["Tavily——搜索 API（官网 tavily.com，需 key）"], secret: "   " });
    const handler = createSettingsHandler({ state, llm: fakeLlm(), configFile, secretsFile });
    const out = await handler("", ui);
    expect(out).toBe("已取消");
    expect(existsSync(configFile)).toBe(false);
    expect(readSecrets()).toBe("");
    // 直驱面：patch 组合写
    persistToolWebSearch(configFile, { backend: "auto", model: "a/b", tavilyApiKey: "$ENV:TAVILY_API_KEY" });
    persistToolWebSearch(configFile, { model: undefined });
    const doc = readFileSync(configFile, "utf8");
    expect(doc).not.toContain("model");
    expect(doc).toContain('tavilyApiKey = "$ENV:TAVILY_API_KEY"'); // 他键不受影响
  });

  it.skipIf(process.platform === "win32")("⑦ MV-05 回归钉：既有宽权限 secrets.env 经 upsert 收紧到 0o600（writeFileSync mode 仅新建生效——chmodSync 兜底）", () => {
    // POSIX 权限位 Windows 无对应（chmod 只拨只读位）——本钉只在有真实 mode 位的平台跑
    writeFileSync(secretsFile, "OTHER=x\n", { mode: 0o644 });
    expect(statSync(secretsFile).mode & 0o777).toBe(0o644); // 前置：宽权限文件在档（原实现 upsert 后仍 644）
    upsertSecret(secretsFile, "TAVILY_API_KEY", "k1");
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600); // 收紧兑现
    expect(readSecrets()).toContain("TAVILY_API_KEY=k1");
    expect(readSecrets()).toContain("OTHER=x"); // 他行不受影响
    // 换 key 原地更新路径同样保持 0o600
    upsertSecret(secretsFile, "TAVILY_API_KEY", "k2");
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
    expect(readSecrets()).toContain("TAVILY_API_KEY=k2");
  });

  it("⑧ Esc 逐级返回（2026-09-28 用户拍板）：载体 Esc → 回顶层；钉模型 Esc → 回载体；key 输入 Esc → 回顶层；顶层 Esc 穿透", async () => {
    // ① 载体菜单 Esc（第 2 次 choose）→ 下一次 choose 又是顶层后端菜单；随后走 Tavily 空输入收场
    const e1 = mkUi();
    let n1 = 0;
    e1.ui.choose = async (title) => {
      e1.chooses.push(title);
      n1++;
      if (n1 === 2) throw new Error("已取消（Esc）");
      return n1 === 1 ? "LLM Web Search——借你已配模型的联网能力（零新 key）" : "Tavily——搜索 API（官网 tavily.com，需 key）";
    };
    const state1 = createSearchState({});
    const out1 = await createSettingsHandler({ state: state1, llm: fakeLlm(["a/m1"]), configFile, secretsFile })("", e1.ui);
    expect(e1.chooses.map((t) => t.slice(0, 7))).toEqual(["配置网络搜索（", "LLM Web", "配置网络搜索（"]);
    expect(out1).toBe("已取消");

    // ② 钉模型 Esc（第 3 次）→ 回载体菜单；随后选「自动」走完
    const e2 = mkUi();
    let n2 = 0;
    e2.ui.choose = async (title, items) => {
      e2.chooses.push(title);
      n2++;
      if (n2 === 3) throw new Error("已取消（Esc）");
      return n2 === 1 ? "LLM Web Search——借你已配模型的联网能力（零新 key）" : n2 === 2 ? "指定模型…" : items[0]!; // 载体层 items[0] = 自动
    };
    const state2 = createSearchState({});
    await createSettingsHandler({ state: state2, llm: fakeLlm(["a/m1"]), configFile, secretsFile })("", e2.ui);
    expect(e2.chooses.map((t) => t.slice(0, 7))).toEqual(["配置网络搜索（", "LLM Web", "钉住搜索模型（", "LLM Web"]);
    expect(state2.current().model).toBeUndefined(); // 「自动」落盘

    // ③ key 输入 Esc（askSecret 抛）→ 回顶层菜单；顶层再 Esc = 整体取消（穿透）
    const e3 = mkUi({ chooses: ["Tavily——搜索 API（官网 tavily.com，需 key）"] });
    e3.ui.askSecret = async () => { throw new Error("已取消（Esc）"); };
    let n3 = 0;
    const choose3 = e3.ui.choose;
    e3.ui.choose = async (title, items) => {
      n3++;
      if (n3 === 2) throw new Error("已取消（Esc）");
      return choose3(title, items);
    };
    const state3 = createSearchState({});
    await expect(createSettingsHandler({ state: state3, llm: fakeLlm(), configFile, secretsFile })("", e3.ui)).rejects.toThrow("已取消（Esc）");
    expect(existsSync(secretsFile)).toBe(false); // Esc 路径零写入
  });

  it("⑧b CM-13 回归钉：replace 分支收拢尾空行——二次/三次更新文件行数不变（旧实现每轮净增一个空行）", () => {
    upsertSecret(secretsFile, "TAVILY_API_KEY", "k1");
    const once = readSecrets();
    expect(once).toBe("TAVILY_API_KEY=k1\n"); // 单行 + 单收尾换行
    upsertSecret(secretsFile, "TAVILY_API_KEY", "k2");
    const twice = readSecrets();
    expect(twice).toBe("TAVILY_API_KEY=k2\n"); // 旧实现此处已是 "…k2\n\n"（split 尾空串 + 写回补 \n）
    expect(twice.split("\n")).toHaveLength(once.split("\n").length); // 行数不变钉
    upsertSecret(secretsFile, "TAVILY_API_KEY", "k3");
    expect(readSecrets().split("\n")).toHaveLength(2); // 三轮仍是 2 元素（内容行 + 尾空串）——旧实现 2/3/4 递增
    // 中间空行不受收拢（只收尾部）：两键夹一空行的既有文件，更新首键后形态保持
    writeFileSync(secretsFile, "A=1\n\nTAVILY_API_KEY=old\n", "utf8");
    upsertSecret(secretsFile, "TAVILY_API_KEY", "new");
    expect(readSecrets()).toBe("A=1\n\nTAVILY_API_KEY=new\n");
    // 空文件（split 得 [""]）append 不留前导空行——append 分支 push 前收拢保持原位
    writeFileSync(secretsFile, "", "utf8");
    upsertSecret(secretsFile, "BRAVE_API_KEY", "b1");
    expect(readSecrets()).toBe("BRAVE_API_KEY=b1\n");
  });
});
