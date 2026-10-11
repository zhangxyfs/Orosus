/** /api/update 更新内容链（web 批 T12 交付、T13 自 api-settings.ts 拆出独立模块——评审指针：保持
 *  api-settings 内聚，拆分时行为不变）：
 *  - GET /api/update（§3 :264，A4 更新弹窗数据面）→ {current,latest?,hasUpdate,notes?,skipped?}：
 *    registry 全量 doc 自取（不动 update-check.ts 既有行为）；notes = readme 切「## 更新日志 →
 *    ### v<latest>」小节（sliceChangelogNotes——与 scripts/release.mts 发布门禁同一格式契约）、
 *    skipped = versions 键序中 current 与 latest 之间；懒取（弹窗打开才查）+ 1h 内存缓存 +
 *    失败静默降级（回落启动检查缓存 updateInfoNow——stale-while-error，update-check.ts D2 同口径）。
 *  模块加载即注册路由（api-settings.ts 转出 re-export 兼容既有测试注入面 import）。 */
import { OROSUS_USER_AGENT, OROSUS_VERSION } from "@orosus/contracts/version";
import { isNewerVersion, UPDATE_CHECK_TIMEOUT_MS, updateInfoNow } from "../update-check.ts";
import { registerRoute, sendJson } from "./server.ts";

/** registry 全量 doc URL（A4 选型：npm 是更新检查已验证可达的通道，registry doc 的 readme/versions
 *  字段白送更新内容与落后清单——不引入 GitHub/Gitea Release 习惯与网络依赖）。 */
const UPDATE_DOC_URL = "https://registry.npmjs.org/orosus";

/** 更新内容内存缓存 TTL（§5 自创值登记表 :345「更新 notes 内存缓存 1h」——弹窗重复打开不重打
 *  registry；版本内容演进以发布为界，1h 足新鲜）。 */
const UPDATE_NOTES_CACHE_MS = 60 * 60 * 1000;

/** registry 全量 doc 的消费面切片（形状校验后的窄视图）。 */
interface RegistryDoc {
  latest: string;
  versions: Record<string, unknown>;
  readme?: string | undefined;
}

/** 注入面 fetch（测试注假 registry——零真网络；缺省 global fetch）。最小结构面：url + headers/signal
 *  init、{ok, status?, json()} 返回（typeof fetch 的窄形——免测试件 cast 全套 Response 面）。 */
export type UpdateDocFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

let updateFetchImpl: UpdateDocFetch | undefined;
let updateDocCache: { at: number; doc: RegistryDoc } | undefined;

/** 测试注入：假 registry fetch（undefined = 复位回 global fetch）。 */
export const setUpdateFetchForTest = (f: UpdateDocFetch | undefined): void => {
  updateFetchImpl = f;
};

/** 测试复位：清 notes/doc 内存缓存（每用例独立懒取）。 */
export const resetUpdateCacheForTest = (): void => {
  updateDocCache = undefined;
};

/** registry 全量 doc 取数（fetchLatestUpdate 同款纪律：10s 超时手控句柄 + 形状校验；失败抛错由
 *  调用方静默降级——不动 update-check.ts 既有行为，web 侧自取）。 */
const fetchRegistryDoc = async (): Promise<RegistryDoc> => {
  const doFetch: UpdateDocFetch = updateFetchImpl ?? ((url, init) => fetch(url, init));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const res = await doFetch(UPDATE_DOC_URL, {
      headers: { accept: "application/json", "user-agent": OROSUS_USER_AGENT },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = (await res.json()) as { "dist-tags"?: { latest?: unknown }; versions?: unknown; readme?: unknown };
    if (typeof doc["dist-tags"]?.latest !== "string") throw new Error("unexpected registry payload shape");
    return {
      latest: doc["dist-tags"].latest,
      versions: typeof doc.versions === "object" && doc.versions !== null && !Array.isArray(doc.versions) ? (doc.versions as Record<string, unknown>) : {},
      ...(typeof doc.readme === "string" ? { readme: doc.readme } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
};

/** npm registry readme「## 更新日志」段 → `### v<latest>` 小节切片（A4 更新内容数据源——纯函数，
 *  测试直调两形）。段界：段头 ^##\s+更新日志\s*$ 起、下一个 ^## 止；小节头 ^###\s+v<版本>\s*$
 *  严格形（scripts/release.mts readmeChangelogGate 发布门禁同一格式契约——两端一枚钉）。
 *  返回小节全文（含 `### v<latest>` 头行——前端 marked 直渲）、尾空行剪净；无段/无该版小节 →
 *  undefined（前端降级形态：版本号 + 落后列表 + 指引）。 */
export function sliceChangelogNotes(readme: string | undefined, latest: string): string | undefined {
  if (typeof readme !== "string" || readme === "") return undefined;
  const target = `### v${latest}`;
  const lines = readme.split(/\r?\n/);
  const sectionRe = /^##\s+更新日志\s*$/;
  let phase: "seek" | "section" = "seek";
  let inSub = false;
  const out: string[] = [];
  for (const line of lines) {
    if (phase === "seek") {
      if (sectionRe.test(line)) phase = "section";
      continue;
    }
    if (/^##\s/.test(line)) break; // 下一个 h2——更新日志段止
    if (/^###\s/.test(line)) {
      inSub = line.trim() === target; // 小节头严格形（尾随空白容忍）
      if (inSub) out.push(line.trim());
      continue;
    }
    if (inSub) out.push(line);
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out.length > 0 ? out.join("\n") : undefined;
}

/** skipped 推导：registry `versions` 键序（npm 按发布序插入）中 current 与 latest 之间的版本号
 *  （不含两端——current 是在跑版、latest 是目标版；任一不在键序 = []，如实不猜）。 */
const skippedVersions = (versions: Record<string, unknown>, current: string, latest: string): string[] => {
  const keys = Object.keys(versions);
  const i = keys.indexOf(current);
  const j = keys.indexOf(latest);
  return i >= 0 && j > i + 1 ? keys.slice(i + 1, j) : [];
};

/** GET /api/update → {current, latest?, hasUpdate, notes?, skipped?}（§3 :264，A4 更新弹窗数据面）。
 *  - 懒取：弹窗打开才查（server 不后台轮检）；1h 内存缓存命中不重打 registry；
 *  - 失败静默降级：doc 取数失败/坏形状 → 回落启动检查缓存 updateInfoNow（stale-while-error——
 *    update-check.ts D2 同口径），仍无 → {current, hasUpdate:false}（latest 缺省）；
 *  - latest 已知即随包回（即使 hasUpdate:false——「已是最新」也要能显示到什么版）；
 *    notes/skipped 仅 hasUpdate 且 doc 在手时出（降级形不走这两个键——前端按缺席判降级）。 */
registerRoute("GET", "/api/update", async (_req, res) => {
  const current = OROSUS_VERSION;
  let doc = updateDocCache !== undefined && Date.now() - updateDocCache.at < UPDATE_NOTES_CACHE_MS ? updateDocCache.doc : undefined;
  if (doc === undefined) {
    try {
      doc = await fetchRegistryDoc();
      updateDocCache = { at: Date.now(), doc };
    } catch {
      doc = undefined; // 静默降级——回落启动检查缓存（横幅同源值）
    }
  }
  if (doc === undefined) {
    const info = updateInfoNow();
    if (info === undefined) {
      sendJson(res, 200, { current, hasUpdate: false });
      return;
    }
    sendJson(res, 200, { current, latest: info.latest, hasUpdate: isNewerVersion(info.latest, current) });
    return;
  }
  const latest = doc.latest;
  const hasUpdate = isNewerVersion(latest, current);
  if (!hasUpdate) {
    sendJson(res, 200, { current, latest, hasUpdate: false });
    return;
  }
  const notes = sliceChangelogNotes(doc.readme, latest);
  sendJson(res, 200, {
    current,
    latest,
    hasUpdate: true,
    ...(notes !== undefined ? { notes } : {}),
    skipped: skippedVersions(doc.versions, current, latest),
  });
});
