import type { SearchResult, WebSearchBackend } from "../search.ts";

async function readErrorBody(res: Response): Promise<string> {
  const t = await res.text().catch(() => "");
  return t.slice(0, 200);
}

/** Brave 后端：请求形态 cc-haha backend.ts:236-246 逐字（GET api.search.brave.com/res/v1/web/search，
 *  X-Subscription-Token，count=8——SW-4）。snippet 取结果的 description 字段。 */
export function braveBackend(opts: { apiKey: string; fetchImpl?: typeof fetch }): WebSearchBackend {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  return {
    kind: "brave",
    available: () => opts.apiKey.trim() !== "",
    search: async (query, signal): Promise<SearchResult[]> => {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", "8");
      const res = await fetchImpl(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": opts.apiKey },
        signal,
      });
      if (!res.ok) throw new Error(`Brave 搜索失败：HTTP ${res.status} ${await readErrorBody(res)}`);
      const body = (await res.json()) as { web?: { results?: { title?: unknown; url?: unknown; description?: unknown }[] } };
      return (body.web?.results ?? []).flatMap((h) =>
        typeof h?.title === "string" && typeof h?.url === "string"
          ? [{ title: h.title, url: h.url, snippet: typeof h.description === "string" ? h.description : "" }]
          : []);
    },
  };
}
