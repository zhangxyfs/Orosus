/** 预装目录与引导提供商视图（2026-10-02 用户拍板——推翻「烤码 7 家快照作引导第 2 页正源」旧口径）：
 *  assets/models-dev.json = models.dev/api.json 全量信封随包分发（出厂时点快照）；引导弹出时刻
 *  seedBundledCatalog 固化到 ~/.orosus/cache/models-dev.json（缺或坏才拷——在线拉取的新数据不被
 *  回滚）；此后引导第 2 页提供商列表（catalogProviderView）与第 4 页模型清单（disk-first 管道）
 *  都从盘上缓存获取——离线首跑也是全量。烤码 BUILTIN_SNAPSHOT 降为末位兜底（seed 失败 + 无盘 +
 *  无网的极端场景），供给链形态见 catalog.ts getCatalogWithSource。 */

import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCatalogDiskCache, usableCatalogModels, type Catalog, type CatalogEntry } from "./catalog.ts";
import { BUILTIN_SNAPSHOT, type SnapshotProviderView } from "./builtin-snapshot.ts";

/** 预装件落点（bundledSkillsDir 同款：模块文件相对定位——源码直跑期成立；打包布局变化即静默断链，
 *  seed 对缺失文件只跳过，供给链末位仍有烤码快照接住）。 */
export function bundledCatalogFile(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "models-dev.json");
}

/** 预装固化（用户拍板「打开程序时候拷到 cache 下」）：cache 缺失或损坏（非法信封）→ 拷预装件覆盖；
 *  已有合法缓存（在线拉取的更新数据）不动。失败静默——固化是增强不是前提（skill 固化同纪律）。 */
export function seedBundledCatalog(cacheFile: string, sourceFile: string = bundledCatalogFile()): void {
	try {
		if (readCatalogDiskCache(cacheFile) !== undefined) return; // 已有合法缓存——不回滚
		mkdirSync(dirname(cacheFile), { recursive: true });
		copyFileSync(sourceFile, cacheFile);
	} catch {
		// 预装件缺失 / 路径不可写——静默，本次会话供给链仍有烤码快照兜底
	}
}

/** 头部优先序列（走查体验：前几页全是认识的入口；其余按 id 字典序殿后——全量派生不裁剪，翻页齐全）。
 *  前 6 位 = 旧烤码快照原序（id 随上游 models.dev 改名更新：moonshot→moonshotai、z-ai→zai），
 *  随后补国内常用入口（目录条目实测在册）。 */
const HEAD_FIRST = [
	"openai", "anthropic", "deepseek", "moonshotai", "zai", "openrouter",
	"zhipuai-coding-plan", "zhipuai", "kimi-code-plan-cn", "moonshotai-cn", "minimax-cn",
] as const;

/** 烤码端点兜底（openai/anthropic 等条目上游 models.dev 已无 api 字段——引导没有手动填端点步骤，
 *  盲填必错：只认烤码快照里人工核过的端点，其余缺 api 家不列〔/provider 菜单交互式填端点兜住〕）。 */
const BAKED_ENDPOINTS: Record<string, string> = Object.fromEntries(
	Object.values(BUILTIN_SNAPSHOT).map((p) => [p.id, p.api]),
);

/** 引导第 2 页提供商视图（从盘上目录缓存派生——SW-21 裁剪快照的替换正源）：
 *  过滤 = 云厂商须 env 非空且有可用 text 模型（没有可钉模型的配了也没用）且端点在场（目录 api，
 *  缺则查烤码兜底表，仍缺不列——引导没有手动填端点步骤）；type 按 npm 协议映射（@ai-sdk/anthropic
 *  → anthropic，其余 openai 兼容——models.dev 的 npm 字段即协议声明）；排序 = 头部序列优先 + 其余
 *  id 字典序。（2026-10-02 用户拍板：「本地服务免 Key」从未是产品设计——localhost 条目不列、
 *  烤码 ollama 已删。）盘上无缓存/坏文件 → undefined（调用方回退烤码快照）。 */
export function catalogProviderView(cacheFile: string): SnapshotProviderView[] | undefined {
	const catalog: Catalog | undefined = readCatalogDiskCache(cacheFile);
	if (catalog === undefined) return undefined;
	const hasEnv = (e: CatalogEntry): boolean => Array.isArray(e.env) && e.env.length > 0;
	return Object.entries(catalog)
		.map(([id, e]): (SnapshotProviderView & { sort: [number, string] }) | undefined => {
			if (!hasEnv(e) || usableCatalogModels(e).length === 0) return undefined;
			const api = typeof e.api === "string" ? e.api : "";
			const baseUrl = api !== "" ? api : BAKED_ENDPOINTS[id] ?? ""; // 缺 api 的云厂商走烤码端点兜底
			if (baseUrl === "") return undefined;
			const head = (HEAD_FIRST as readonly string[]).indexOf(id);
			return {
				id,
				name: e.name ?? id,
				...(e.env?.[0] !== undefined ? { envKey: e.env[0] } : {}),
				baseUrl,
				type: String(e.npm ?? "").includes("anthropic") ? "anthropic" : "openai",
				sort: [head === -1 ? Number.MAX_SAFE_INTEGER : head, id],
			};
		})
		.filter((r): r is SnapshotProviderView & { sort: [number, string] } => r !== undefined)
		.toSorted((a, b) => a.sort[0] - b.sort[0] || a.sort[1].localeCompare(b.sort[1]))
		.map(({ sort: _sort, ...view }) => view);
}

/** 预装件健康自检（测试/诊断用）：存在、可解析、非空。 */
export function bundledCatalogHealthy(sourceFile: string = bundledCatalogFile()): boolean {
	try {
		return statSync(sourceFile).size > 2 && readCatalogDiskCache(sourceFile) !== undefined;
	} catch {
		return false;
	}
}
