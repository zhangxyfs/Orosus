/** markdown 管线装配壳（mdpipe 批 T0 拆分后）：实现按职责分居 md/ 目录——
 *  lex.ts（共享 marked 实例）/ inline.ts（行内 token）/ highlight.ts（代码高亮）/
 *  table.ts（表格）/ blocks.ts（块渲染 + renderLines 公共体）/ streaming.ts（流式冻结）。
 *  本件只 re-export 公开签名：renderMarkdown / createStreamingMarkdown / StreamingMarkdown
 *  ——签名与三个消费点（render.ts / docmodel.ts / streamview.ts）零改动。
 *  形态 = markdown 调研 9/9 先验（解析外包 marked、渲染自写）+ spike 原型实证件扩全。
 *  决策清单沿革（框架化方案书 F1 节 + mdpipe 批 v3 修订）：① 解析器 = marked（D53 拍板
 *  2026-09-21——只供 AST，渲染主权在自家渲染器）；② 渲染器 = 自写 ANSI token→theme 映射；
 *  ③ 表格 = 自写网格组件（mdpipe 批 T4 升级 pi 全边框 + 等比列宽）；④ 高亮 = ~~自写正则三形态~~
 *  → cli-highlight 全 token 化（v3 拍板 2026-09-22：引包对高亮豁免，T1 落地）；⑤ LaTeX =
 *  ~~可选件不排期~~ → 本批并入（v2 拍板 2026-09-22，T7 落地）。 */

import { renderLines } from "./md/blocks.ts";
import { createStreamingMarkdown } from "./md/streaming.ts";
import type { StreamingMarkdown } from "./md/streaming.ts";

/** 一次性渲染（回显面）：token 流 → 折行后的物理行数组。 */
export function renderMarkdown(src: string, width: number): string[] {
	return renderLines(src, width);
}

export type { StreamingMarkdown };
export { createStreamingMarkdown };
