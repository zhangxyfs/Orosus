import type { SearchConfig, WebSearchBackend } from "../search.ts";
import { configuredKey } from "../search.ts";
import { tavilyBackend } from "./tavily.ts";
import { braveBackend } from "./brave.ts";

export interface BuildBackendsDeps {
  fetchImpl?: typeof fetch;
}

/** 按链序（llm→tavily→brave，D4）构已配置后端——llm 槽 T1b 接入（届时插到数组头保持链序）。
 *  key 未配置/未解析的档直接不进数组（cc-haha「档位 key 缺失即跳过」语义，available() 是第二道闸）。 */
export function buildBackends(cfg: SearchConfig, deps: BuildBackendsDeps = {}): WebSearchBackend[] {
  const out: WebSearchBackend[] = [];
  const tavilyKey = configuredKey(cfg.tavilyApiKey);
  if (tavilyKey !== undefined) out.push(tavilyBackend({ apiKey: tavilyKey, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) }));
  const braveKey = configuredKey(cfg.braveApiKey);
  if (braveKey !== undefined) out.push(braveBackend({ apiKey: braveKey, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) }));
  return out;
}
