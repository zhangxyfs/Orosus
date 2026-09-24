import { defineModule, type ModuleDefinition } from "@orosus/contracts/module";
import { fetchTool, type FetchDeps } from "./fetch.ts";

export { fetchTool, type FetchDeps } from "./fetch.ts";
export { defaultHtmlToMarkdown, type HtmlToMarkdown } from "./html-to-md.ts";

/** 模块工厂：deps 贯穿工具族（fetch 现在、search T1a 起）——生产默认件零参，测试注假件（tool-ask 工厂注 ui 同款）。 */
export const createToolWebModule = (deps: FetchDeps = {}): ModuleDefinition =>
  defineModule({
    name: "tool-web",
    version: "0.1.0",
    description: "web 抓取工具（web_fetch）——网页转 markdown，SSRF 逐跳防护",
    api: 1,
    uses: ["network"], // tool-shell uses:["subprocess"] 同款声明式权限标注
    activate(ctx) {
      ctx.contribute.tool(fetchTool(deps));
    },
  });

export default createToolWebModule();
