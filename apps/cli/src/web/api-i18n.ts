/** web-i18n M2：GET /api/i18n/messages → { ok, tag, messages }——web GUI 前端译表数据面。
 *  切片 = 仅 web. 前缀键（spec §1：机制上杜绝前端蹭 TUI 键 + payload 减半）；
 *  tag 解析：?tag= 归一（显式给但未知 = 非内置三语亦非已装语言包档 → 回落 config 语言；config 空 →
 *  en-US——api-settings locale GET 同口径；空串/缺省同 config 语言档）；
 *  store = 现建（getGraph 锚 anchorHarness，图换代窗降级不炸）+ mainTables（主表 web.* 键在此——
 *  api-settings locale GET 的临时 store 不带 mainTables，勿照抄）；无会话也出表（floor∪main——
 *  语言包段缺席如实，不 409）。 */
import { normalizeLocaleTag } from "@orosus/i18n";
import { loadConfig } from "@orosus/core";
import { mainTables } from "../locales/index.ts";
import { createLocaleStore } from "../i18n/store.ts";
import { configFacePaths } from "../config-face.ts";
import { registerRoute, sendJson } from "./server.ts";
import { anchorHarness } from "./api-settings.ts";

registerRoute("GET", "/api/i18n/messages", async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rawTag = url.searchParams.get("tag") ?? "";
  const configLang = loadConfig(configFacePaths()).core.language;
  const fallback = typeof configLang === "string" && configLang !== "" ? normalizeLocaleTag(configLang) : "en-US";
  const anchor = anchorHarness();
  const store = createLocaleStore({ getGraph: () => anchor?.h.graph(), mainTables });
  let tag = rawTag !== "" ? normalizeLocaleTag(rawTag) : fallback;
  try {
    await store.init(tag); // setTag + rebuild（merged = floor∪main∪catalog∪packs）
    if (rawTag !== "" && !store.availableLocales().some((e) => e.tag === tag)) {
      tag = fallback; // 未知显式 tag 回落服务端解析值（合法档 = 内置三语 ∪ 语言包槽——locale POST 同口径）
      await store.setLanguage(tag);
    }
  } catch { /* 图换代窗——merged 已含 floor∪main，语言包段缺席降级 */ }
  const table = store.tableFor(tag) ?? {};
  const messages: Record<string, string> = {};
  for (const [k, v] of Object.entries(table)) if (k.startsWith("web.")) messages[k] = v;
  sendJson(res, 200, { ok: true, tag, messages });
});
