import { z } from "zod";
import { defineModule, type ModuleDefinition } from "@orosus/contracts/module";
import { fetchTool, type FetchDeps } from "./fetch.ts";
import { createSearchState, configuredKey, searchTool } from "./search.ts";

export { fetchTool, type FetchDeps } from "./fetch.ts";
export { defaultHtmlToMarkdown, type HtmlToMarkdown } from "./html-to-md.ts";
export {
  searchTool, createSearchState, configuredKey,
  type SearchConfig, type SearchDeps, type SearchResult, type WebSearchBackend,
} from "./search.ts";

/** [tool-web] 配置节（节名 = 模块名，全局约束 3）：search 子节承载后端选择与 per-backend key 占位符（v4.7——
 *  $ENV: 占位符是模块唯一 secrets 通道，secrets.env 不进 process.env；T1c 配置流写占位符不落真 key）。 */
const configSchema = z.object({
  search: z.object({
    backend: z.enum(["auto", "llm", "tavily", "brave"]).optional(),
    model: z.string().optional(),
    tavilyApiKey: z.string().optional(),
    braveApiKey: z.string().optional(),
  }).optional(),
});
export type ToolWebConfig = z.infer<typeof configSchema>;

export interface ToolWebDeps extends FetchDeps {
  /** 搜索后端链/HTTP 口/超时——测试注假件；缺省按模块 search 活态现构。 */
  searchBackends?: Parameters<typeof searchTool>[0]["backends"];
  searchTimeoutMs?: number;
}

/** 模块工厂：deps 贯穿工具族——生产默认件零参，测试注假件（tool-ask 工厂注 ui 同款）。 */
export const createToolWebModule = (deps: ToolWebDeps = {}): ModuleDefinition<ToolWebConfig> =>
  defineModule<ToolWebConfig>({
    name: "tool-web",
    version: "0.1.0",
    description: "web 工具：web_fetch（网页转 markdown）+ web_search（链式后端 llm→tavily→brave）",
    api: 1,
    uses: ["network"], // tool-shell uses:["subprocess"] 同款声明式权限标注
    config: configSchema,
    activate(ctx) {
      ctx.contribute.tool(fetchTool(deps));
      // search 活态：activate 期取纯分层快照，T1c 配置流经 holder.set 改写即时生效（approval apply/persist 同款）
      const searchState = createSearchState(ctx.config.search ?? {});
      // T1a 中间态注册门（kimi when 同款）：tavily/brave 任一 key 可用才注册——
      // T1b llm 槽接入后改恒注册（llm 槽恒可用，SW-15），届时本门连同「中间态全缺不注册」测试一起收口
      const hasKey = configuredKey(ctx.config.search?.tavilyApiKey) !== undefined
        || configuredKey(ctx.config.search?.braveApiKey) !== undefined;
      if (hasKey) {
        ctx.contribute.tool(searchTool({
          state: searchState,
          ...(deps.searchBackends !== undefined ? { backends: deps.searchBackends } : {}),
          ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.searchTimeoutMs !== undefined ? { timeoutMs: deps.searchTimeoutMs } : {}),
        }));
      }
    },
  });

export default createToolWebModule();
