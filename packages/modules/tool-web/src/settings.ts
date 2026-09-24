import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { orosusHome } from "@orosus/contracts/home";
import type { CommandHandler, LlmPort } from "@orosus/contracts/module";
import type { SearchConfig, SearchStateHolder } from "./search.ts";

/** tool-web__settings 配置流的宿主面（D9：配置流本体归 web 模块自有命令，host 菜单挂接）。 */
export interface SettingsDeps {
  state: SearchStateHolder;
  llm: LlmPort;
  /** 缺省 ~/.orosus/config.toml（approval defaultConfigFile 同款单一解析点 orosusHome）。 */
  configFile?: string;
  secretsFile?: string;
}

function readToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>; // BOM 剥离（approval 同款 v17 注记——Windows 写盘默认带 BOM）
}

export interface SearchPatch {
  backend?: string | undefined;
  model?: string | undefined; // undefined 语义 = 删除该键（零配置钉选解除）
  tavilyApiKey?: string | undefined;
  braveApiKey?: string | undefined;
}

/** [tool-web] search 节写回（读-改-写全量重写——approval persistMode 既定策略同款）。
 *  只写用户层：per-backend key 属用户凭据，项目层 config 有进 git 的风险面（不写项目层的取舍登记）。 */
export function persistToolWebSearch(configFile: string, patch: SearchPatch): void {
  const doc = readToml(configFile);
  const section = (doc["tool-web"] as Record<string, unknown> | undefined) ?? {};
  const search = (section["search"] as Record<string, unknown> | undefined) ?? {};
  if (patch.backend !== undefined) search["backend"] = patch.backend;
  if ("model" in patch) {
    if (patch.model === undefined) delete search["model"];
    else search["model"] = patch.model;
  }
  if (patch.tavilyApiKey !== undefined) search["tavilyApiKey"] = patch.tavilyApiKey;
  if (patch.braveApiKey !== undefined) search["braveApiKey"] = patch.braveApiKey;
  section["search"] = search;
  doc["tool-web"] = section;
  mkdirSync(dirname(configFile), { recursive: true }); // 目录缺省即建（/model 写盘同款保底）
  writeFileSync(configFile, stringify(doc), "utf8");
}

/** secrets.env 单行 upsert（D37 KEY=VALUE 形——换 key 原地更新不累积重复行；0o600 与 spill 同档）。 */
export function upsertSecret(secretsFile: string, name: string, value: string): void {
  const lines = existsSync(secretsFile) ? readFileSync(secretsFile, "utf8").split("\n") : [];
  const idx = lines.findIndex((l) => l.trim().startsWith(`${name}=`));
  if (idx >= 0) lines[idx] = `${name}=${value}`;
  else {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    lines.push(`${name}=${value}`);
  }
  mkdirSync(dirname(secretsFile), { recursive: true });
  writeFileSync(secretsFile, `${lines.join("\n")}\n`, { mode: 0o600 });
}

const CURRENT_DESC: Record<string, string> = {
  auto: "auto 链（llm→tavily→brave 取第一个可用）",
  llm: "钉死 llm",
  tavily: "钉死 tavily",
  brave: "钉死 brave",
};

/** 三级配置流（SW-18 定案）：LLM Web Search（选模型当搜索载体——Reasonix web_search_model 思想）/
 *  Tavily / Brave（显官网 + askSecret 掩码输 key）。写盘后 holder.set 即时生效（清 SW-19 粘性）；
 *  成功反馈走 notice（静默约定——不落流区；SW-22 成功语义永不用错误通道）。 */
export function createSettingsHandler(deps: SettingsDeps): CommandHandler {
  const configFile = deps.configFile ?? join(orosusHome(), "config.toml");
  const secretsFile = deps.secretsFile ?? join(orosusHome(), "secrets.env");
  const applyState = (patch: SearchConfig): void => {
    deps.state.set({ ...deps.state.current(), ...patch });
  };
  return async (_args, ui) => {
    const cur = deps.state.current();
    const curDesc = `当前：${CURRENT_DESC[cur.backend ?? "auto"] ?? cur.backend}${cur.model !== undefined && cur.model !== "" ? `，搜索模型 ${cur.model}` : ""}`;
    const top = await ui.choose(`配置网络搜索（${curDesc}）——选择要配置的后端`, [
      "LLM Web Search——借你已配模型的联网能力（零新 key）",
      "Tavily——搜索 API（官网 tavily.com，需 key）",
      "Brave——搜索 API（官网 brave.com/search/api，需 key）",
    ]);
    if (top.startsWith("LLM")) {
      const hasCatalog = deps.llm.listModels !== undefined;
      const subItems = ["用当前模型（零配置·默认）"];
      subItems.push(hasCatalog ? "钉住指定模型…" : "钉住指定模型…（不可用：当前端点无模型目录）");
      const sub = await ui.choose("LLM Web Search——搜索载体", subItems);
      if (sub.startsWith("用当前模型")) {
        persistToolWebSearch(configFile, { backend: "auto", model: undefined });
        applyState({ backend: "auto", model: undefined });
        ui.notice?.("已保存：LLM Web Search 用当前模型（零配置）——搜索链 llm→tavily→brave 生效");
        return "";
      }
      if (!hasCatalog) {
        ui.notice?.("当前端点没有模型目录——可手写 config.toml 的 [tool-web] search.model 钉模型");
        return "";
      }
      const models = await deps.llm.listModels!();
      if (models.length === 0) {
        ui.notice?.("模型目录为空——可手写 config.toml 的 [tool-web] search.model 钉模型");
        return "";
      }
      const picked = await ui.choose("钉住搜索模型（provider/model）", models);
      persistToolWebSearch(configFile, { backend: "auto", model: picked });
      applyState({ backend: "auto", model: picked });
      ui.notice?.(`已保存：LLM Web Search 钉住 ${picked}——搜索链 llm→tavily→brave 生效`);
      return "";
    }
    const isTavily = top.startsWith("Tavily");
    const envName = isTavily ? "TAVILY_API_KEY" : "BRAVE_API_KEY";
    const site = isTavily ? "tavily.com" : "brave.com/search/api";
    const key = (await ui.askSecret(`${isTavily ? "Tavily" : "Brave"} API key（官网 ${site} 注册获取——输入不显示，回车提交，空输入取消）`)).trim();
    if (key === "") return "已取消";
    upsertSecret(secretsFile, envName, key); // 真 key 只落 secrets.env（掩码输入，不落日志）
    const placeholder = `$ENV:${envName}`; // config 只写占位符——$ENV: 是模块唯一 secrets 通道（v4.7 机制钉）
    persistToolWebSearch(configFile, isTavily ? { backend: "auto", tavilyApiKey: placeholder } : { backend: "auto", braveApiKey: placeholder });
    applyState(isTavily ? { backend: "auto", tavilyApiKey: placeholder } : { backend: "auto", braveApiKey: placeholder });
    ui.notice?.(`已保存：${isTavily ? "Tavily" : "Brave"} key——搜索链 llm→tavily→brave 生效`);
    return "";
  };
}
