import { z } from "zod";
import { defineModule, type ModuleContext } from "@orosus/contracts/module";
import { defineTool, type Tool, type ToolInfo } from "@orosus/contracts/tool";

/** 策略常数（SW-10 定案）：打分表 名词命中 10（MCP 12）/ 子串 5 / searchHint 4 / 描述词 2，精确名短路；
 *  默认 5 条帽 20；目录描述截断 80 字符；未命中近似名建议 ≤3；目录段 50 行帽。 */
const MAX_RESULTS = 5;
const HARD_CAP = 20;
const DESC_TRUNC = 80;
const MAX_SUGGEST = 3;
const CATALOG_LINE_CAP = 50;

type ToolsSeam = ModuleContext["tools"];

/** 名词切分：工具名按分隔符拆词（tool-fs__read → [tool, fs, read]——命名面天然带分隔符）。 */
const nameWords = (name: string): string[] => name.toLowerCase().split(/[-_:/]+/).filter((w) => w !== "");

/** 打分（cc-haha ToolSearchTool.ts:186-302 的收窄版——仅显式 deferred 域内评）：逐词累计，
 *  名词命中（query 词 = 工具名词）10 / MCP 属主 12 / 名子串 5 / hint 4 / 描述 2；精确名短路满分。 */
export function scoreTool(t: ToolInfo, terms: string[]): number {
  const words = nameWords(t.name);
  const name = t.name.toLowerCase();
  const hint = (t.searchHint ?? "").toLowerCase();
  const desc = t.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term) return 1000; // 精确名短路（qwen/cc-haha 同款）
    if (words.includes(term)) score += t.owner === "mcp" ? 12 : 10;
    else if (name.includes(term)) score += 5;
    if (hint.includes(term)) score += 4;
    if (desc.includes(term)) score += 2;
  }
  return score;
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** 未命中近似名建议（≤3）：任一查询词作前缀命中工具名/词即候选，名字典序。 */
function suggest(catalog: ToolInfo[], terms: string[]): string[] {
  const hits = catalog.filter((t) => {
    const words = nameWords(t.name);
    return terms.some((term) => t.name.toLowerCase().startsWith(term) || words.some((w) => w.startsWith(term)));
  });
  return hits.map((t) => t.name).sort().slice(0, MAX_SUGGEST);
}

/** meta 工具（kimi/qwen/cc-haha 三家同款形态）：搜索即 reveal——结果列「已加载：…（下一轮起可调用）」。 */
export function searchMetaTool(tools: ToolsSeam): Tool {
  return defineTool({
    name: "tool-search__search",
    description: `Search the deferred (on-demand) tool catalog and load matching tools.
Loaded tools become callable from the next request onward. Pass keywords from the task at hand;
use "select:name1,name2" to load exact tools directly, or "+term" to require a term.`,
    parameters: z.object({
      query: z.string().min(1).describe("工具名关键词（空格分词）；select:A,B 直选；+词 必含"),
    }),
    resolveExecution: (input) => {
      const { query } = input as { query: string };
      return Promise.resolve({
        accesses: [], // 纯注册表读写——零外部资源（ask-risky 常规放行）
        approvalRule: "tool-search__search",
        execute: () => {
          const catalog = tools.list({ deferredOnly: true }).filter((t) => !t.revealed);
          const q = query.trim();
          if (catalog.length === 0) {
            return Promise.resolve({ output: "按需目录为空——没有待加载的工具（全部已在请求中或未标 deferred）。", isError: false });
          }
          let picked: ToolInfo[] = [];
          let note = "";
          if (q.toLowerCase().startsWith("select:")) {
            const names = q.slice(7).split(",").map((s) => s.trim()).filter((s) => s !== "").slice(0, HARD_CAP);
            const unknown: string[] = [];
            for (const n of names) {
              const hit = catalog.find((t) => t.name === n);
              if (hit !== undefined) picked.push(hit);
              else unknown.push(n);
            }
            if (unknown.length > 0) note = `\n未命中（不在按需目录或已加载）：${unknown.join("、")}`;
          } else {
            const tokens = q.toLowerCase().split(/\s+/).filter((s) => s !== "");
            const required = tokens.filter((t) => t.startsWith("+")).map((t) => t.slice(1)).filter((s) => s !== "");
            const terms = tokens.filter((t) => !t.startsWith("+"));
            const hay = (t: ToolInfo) => `${t.name} ${t.searchHint ?? ""} ${t.description}`.toLowerCase();
            const candidates = catalog.filter((t) => required.every((r) => hay(t).includes(r)));
            const scored = candidates
              .map((t) => ({ t, s: scoreTool(t, terms) }))
              .filter((x) => x.s > 0)
              .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name));
            picked = scored.slice(0, MAX_RESULTS).map((x) => x.t);
            if (picked.length === 0) {
              const near = suggest(catalog, terms);
              return Promise.resolve({
                output: `未命中——按需目录共 ${catalog.length} 个工具。${near.length > 0 ? `近似：${near.join("、")}（可 select: 直选）` : "（无近似——换关键词或 select: 直选）"}`,
                isError: false,
              });
            }
          }
          if (picked.length === 0) {
            return Promise.resolve({ output: `未命中——按需目录共 ${catalog.length} 个工具。${note}`.trim(), isError: false });
          }
          tools.reveal(picked.map((t) => t.name));
          const lines = picked.map((t) => `已加载：${t.name} —— ${truncate(t.description, DESC_TRUNC)}`);
          return Promise.resolve({ output: `${lines.join("\n")}\n（下一轮起可调用）${note}`, isError: false });
        },
      });
    },
  });
}

/** 目录段文本（getter 活读——reveal 后条目即消失；空目录空串被装配过滤不占预算）。order 21（kernel 分配表空位）。 */
export function catalogText(tools: ToolsSeam): string {
  const hidden = tools.list({ deferredOnly: true }).filter((t) => !t.revealed);
  if (hidden.length === 0) return "";
  const lines = hidden.slice(0, CATALOG_LINE_CAP).map((t) => `  ${t.name} — ${truncate(t.description, DESC_TRUNC)}`);
  const more = hidden.length > CATALOG_LINE_CAP ? `\n  …还有 ${hidden.length - CATALOG_LINE_CAP} 个` : "";
  return `以下 ${hidden.length} 个工具按需加载（只知名、无 schema、不可直接调用——用 tool-search__search 加载，搜索即加载，下一轮起可调用）：\n${lines.join("\n")}${more}`;
}

export default defineModule({
  name: "tool-search",
  version: "0.1.0",
  description: "ToolSearch 按需加载——meta 工具（搜索即 reveal）+ 隐藏工具目录段",
  api: 1,
  mounts: ["tools.reveal", "tools.list", "contribute:tool", "contribute:promptSection"],
  // SW-26 启用开关 = 内核自带三层启停（[tool-search] enabled——保留键语义；配置键 enabled 是保留键会被剥离，
  // 自建 zod 键永远读不到——defaultEnabled:false 即「默认关」的正解）。关态 = 模块不激活 = 机制整门不启
  // （deferred 标记不生效、specs 零过滤、meta 工具与目录段不注册——防「标了 deferred 却无 meta 工具可 reveal」死锁）。
  defaultEnabled: false,
  activate(ctx) {
    ctx.tools.enable();
    ctx.contribute.tool(searchMetaTool(ctx.tools));
    ctx.contribute.promptSection({ order: 21, get text() { return catalogText(ctx.tools); } });
  },
});
