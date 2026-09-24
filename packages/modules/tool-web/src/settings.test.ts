import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
  it("① LLM 默认项「用当前模型」：写 backend=auto 且删除既有 model 键（零配置语义）；state 即时同步", async () => {
    writeFileSync(configFile, "[tool-web.search]\nbackend = \"auto\"\nmodel = \"kimi-code-plan-cn/k3-256k\"\n", "utf8");
    const state = createSearchState({ backend: "auto", model: "kimi-code-plan-cn/k3-256k" });
    const { ui, notices } = mkUi({ chooses: ["LLM Web Search——借你已配模型的联网能力（零新 key）", "用当前模型（零配置·默认）"] });
    const handler = createSettingsHandler({ state, llm: fakeLlm(["a/m1"]), configFile, secretsFile });
    const out = await handler("", ui);
    expect(out).toBe(""); // 静默约定——成功走 notice
    const doc = readFileSync(configFile, "utf8");
    expect(doc).toContain('backend = "auto"');
    expect(doc).not.toContain("model");
    expect(state.current()).toEqual({ backend: "auto", model: undefined });
    expect(notices[0]).toContain("用当前模型");
    expect(existsSync(secretsFile)).toBe(false); // LLM 路径不碰 secrets
  });

  it("② LLM 钉模型：listModels 出目录 → 选定 provider/model 限定形写 model", async () => {
    const state = createSearchState({});
    const { ui } = mkUi({ chooses: ["LLM Web Search——借你已配模型的联网能力（零新 key）", "钉住指定模型…", "zhipuai-coding-plan/glm-5.3"] });
    const handler = createSettingsHandler({ state, llm: fakeLlm(["zhipuai-coding-plan/glm-5.3", "kimi-code-plan-cn/k3-256k"]), configFile, secretsFile });
    await handler("", ui);
    expect(readFileSync(configFile, "utf8")).toContain('model = "zhipuai-coding-plan/glm-5.3"');
    expect(state.current().model).toBe("zhipuai-coding-plan/glm-5.3");
  });

  it("③ listModels 不可用 → 钉模型项标「不可用」，选了不写盘只提示", async () => {
    const state = createSearchState({});
    const { ui, chooses, notices } = mkUi({ chooses: ["LLM Web Search——借你已配模型的联网能力（零新 key）", "钉住指定模型…（不可用：当前端点无模型目录）"] });
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
});
