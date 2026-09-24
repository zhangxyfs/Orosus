import { createRequire } from "node:module";
import type TurndownService from "turndown";

export type HtmlToMarkdown = (html: string) => Promise<string>;

/** HTML→markdown 转换器：懒加载单例（qwen web-fetch.ts:118-140 / cc-haha utils.ts:98-110 同款）——
 *  turndown 连 DOM 实现约 1.4MB 常驻堆，推迟到第一次 HTML 抓取才加载；实例无状态可复用。
 *  选项取 opencode webfetch.ts:182-192 定值；删 script/style/noscript 取 qwen 逐字集
 *  （turndown 默认保留这些元素的文本，水合 blob 与内联 CSS 会吃掉截断预算）。
 *  gfm 插件走 createRequire：该包无类型声明（@types 不存在），import 会在 noImplicitAny 下炸（TS7016），
 *  require 返回 any 不受查——CJS 包本质一致，无双实例风险（全仓唯一消费点）。 */
let cached: Promise<TurndownService> | undefined;

function getService(): Promise<TurndownService> {
  cached ??= import("turndown").then((td) => {
    const { gfm } = createRequire(import.meta.url)("turndown-plugin-gfm") as { gfm: TurndownService.Plugin };
    const service = new td.default({
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
    });
    service.use(gfm);
    service.remove(["script", "style", "noscript"]);
    return service;
  });
  return cached;
}

export const defaultHtmlToMarkdown: HtmlToMarkdown = async (html) => (await getService()).turndown(html);
