import type { SearchResult, WebSearchBackend } from "../search.ts";

/** 错误体截取（cc-haha readErrorBody 同款）——失败详情带内给模型，200 字符帽。 */
async function readErrorBody(res: Response): Promise<string> {
  const t = await res.text().catch(() => "");
  return t.slice(0, 200);
}

/** Tavily 后端：请求形态 cc-haha backend.ts:201-216 逐字（POST api.tavily.com/search，Bearer，
 *  max_results=8，search_depth=basic，include_answer=false——SW-4）。snippet 取结果的 content 字段。 */
export function tavilyBackend(opts: { apiKey: string; fetchImpl?: typeof fetch }): WebSearchBackend {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  return {
    kind: "tavily",
    available: () => opts.apiKey.trim() !== "",
    search: async (query, signal): Promise<SearchResult[]> => {
      const res = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, max_results: 8, search_depth: "basic", include_answer: false }),
        signal,
      });
      if (!res.ok) throw new Error(`Tavily 搜索失败：HTTP ${res.status} ${await readErrorBody(res)}`);
      const body = (await res.json()) as { results?: { title?: unknown; url?: unknown; content?: unknown }[] };
      return (body.results ?? []).flatMap((h) =>
        typeof h?.title === "string" && typeof h?.url === "string"
          ? [{ title: h.title, url: h.url, snippet: typeof h.content === "string" ? h.content : "" }]
          : []);
    },
  };
}
