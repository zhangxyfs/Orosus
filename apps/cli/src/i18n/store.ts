/**
 * m5-i18n T2：宿主语言 store——合并表构建 + tag 缓存 + reload 失效。
 *
 * 合并序（方案 §5.1/§5.4 逐键解析序，后者覆盖前者）：
 *   floor（@orosus/i18n 地板）∪ main（apps/cli/src/locales 界面主目录，T4 起）
 *   ∪ 全部 i18n.catalog.* 槽的 active 段 ∪ i18n.locale.<active> 语言包槽（槽优先）。
 * 解析链（@orosus/i18n chainFor）：active → en-US；zh-TW 特例经 zh-CN；缺键 → fallback 参数 → key。
 *
 * t() 是每帧热路径：合并表按 tag 预构建（rebuild 异步），t() 只读同步缓存（m5-render-perf 敏感区）。
 * 挂/卸载语言包都走 h.reload()——宿主 reload 后调 store.rebuild()。
 */

import type { LocaleMessages } from "@orosus/contracts/module";
import { chainFor, createT, floorCatalogs, normalizeLocaleTag } from "@orosus/i18n";
import type { Messages, TInstance } from "@orosus/i18n";

/** store 依赖的图读面（h.graph() 的结构子集——测试注入假图用）。 */
export interface LocaleGraphFace {
	services: {
		getOptional(key: string): Promise<unknown | undefined>;
		keys(prefix?: string): string[];
	};
	records?: readonly { name: string }[];
}

export interface LocaleStoreDeps {
	getGraph(): LocaleGraphFace | undefined;
	/** 界面主目录（T4 起 = apps/cli/src/locales）；测试注入。 */
	mainTables?(): Record<string, Messages>;
	/** 坏形状槽的记录口（缺省 console.warn——生产接宿主日志）。 */
	warn?(msg: string): void;
}

/** 内置三语（原生名永不翻译——P4）。 */
export const BUILTIN_LOCALES: readonly { tag: string; native: string }[] = [
	{ tag: "zh-CN", native: "简体中文" },
	{ tag: "zh-TW", native: "繁體中文" },
	{ tag: "en-US", native: "English" },
];

/** 语言包槽原生名（槽 impl 未带 native 时的已知表；未知 tag 显示 tag 本身）。 */
const KNOWN_NATIVE: Record<string, string> = { "ja-JP": "日本語", "ko-KR": "한국어", "ru-RU": "Русский" };

function isPlainStringRecord(v: unknown): v is Messages {
	return typeof v === "object" && v !== null && Object.values(v).every((x) => typeof x === "string");
}

/** 语言包槽 impl 解析（LocalePackImpl 鸭子判定——坏形状返回 undefined）。 */
function asLocalePack(impl: unknown): { messages: Messages; native?: string } | undefined {
	if (isPlainStringRecord(impl)) return { messages: impl };
	if (typeof impl === "object" && impl !== null && isPlainStringRecord((impl as { messages?: unknown }).messages)) {
		const pack = impl as { messages: Messages; native?: unknown };
		return { messages: pack.messages, ...(typeof pack.native === "string" ? { native: pack.native } : {}) };
	}
	return undefined;
}

/** 模块目录槽 impl 解析（LocaleCatalog 形状：Record<tag, Messages>；段坏 = 整 catalog 拒收）。 */
function asLocaleCatalog(impl: unknown): Map<string, Messages> | undefined {
	if (typeof impl !== "object" || impl === null || Array.isArray(impl)) return undefined;
	const out = new Map<string, Messages>();
	for (const [rawTag, seg] of Object.entries(impl as Record<string, unknown>)) {
		if (!isPlainStringRecord(seg)) return undefined;
		out.set(normalizeLocaleTag(rawTag), seg);
	}
	return out;
}

export interface LocaleEntry {
	tag: string;
	native: string;
	fromPack: boolean;
}

export interface LocaleStore {
	/** 同步翻译口（热路径——只读预构建合并表）。 */
	t: TInstance;
	/** 启动初始化：定 tag + 首次构建（config.language > 检测值由宿主定好后传入）。 */
	init(rawTag: string): Promise<void>;
	/** 切语言（写盘由宿主 T3 做——store 只换 tag + 重建链上合并表）。 */
	setLanguage(rawTag: string): Promise<void>;
	/** 当前 tag（归一形）。 */
	activeTag(): string;
	/** reload 后重建（挂/卸载语言包、catalog 增删都经此）。 */
	rebuild(): Promise<void>;
	/** /locale 列表：内置三语原生名 + 语言包槽动态追加（P4）。 */
	availableLocales(): LocaleEntry[];
	/** P1：当前语言只该来自语言包槽（内置无此表且槽空）——宿主英文提示一次用。 */
	packMissing(): boolean;
}

export function createLocaleStore(deps: LocaleStoreDeps): LocaleStore {
	const warn = deps.warn ?? ((msg: string) => console.warn(msg));
	let tag = "en-US";
	let merged = new Map<string, Messages>();
	let packs = new Map<string, { messages: Messages; native?: string }>();
	// catalog 槽按语言段归位：tag → 该语言的全部目录段（合并序 = 槽 key 枚举序）
	let catalogByTag = new Map<string, Messages>();
	const t = createT({ tag, getTable: (x: string) => merged.get(x) });

	const rebuild = async (): Promise<void> => {
		const graph = deps.getGraph();
		packs = new Map();
		const catalogs = new Map<string, Map<string, Messages>>(); // owner → per-tag 段
		const slotKeys = graph?.services.keys("i18n.") ?? [];
		const moduleNames = new Set(graph?.records?.map((r) => r.name) ?? []);
		await Promise.all(
			slotKeys.map(async (key) => {
				const impl = await graph!.services.getOptional(key);
				if (impl === undefined) return;
				if (key.startsWith("i18n.locale.")) {
					const pack = asLocalePack(impl);
					if (pack === undefined) {
						warn(`i18n：语言包槽 ${key} 形状非法（期待扁平键值表或 { native, messages }）——已忽略`);
						return;
					}
					packs.set(normalizeLocaleTag(key.slice("i18n.locale.".length)), pack);
				} else if (key.startsWith("i18n.catalog.")) {
					const owner = key.slice("i18n.catalog.".length);
					if (moduleNames.size > 0 && !moduleNames.has(owner)) {
						warn(`i18n：目录槽 ${key} 槽名 ≠ 模块名（拒收档，§5.4 ④）——已忽略`);
						return;
					}
					const catalog = asLocaleCatalog(impl);
					if (catalog === undefined) {
						warn(`i18n：目录槽 ${key} 形状非法（期待 Record<tag, 键值表>）——已忽略（降级不炸）`);
						return;
					}
					catalogs.set(owner, catalog);
				}
			}),
		);
		const nextByTag = new Map<string, Messages>();
		for (const catalog of catalogs.values()) {
			for (const [segTag, seg] of catalog) {
				const acc = { ...nextByTag.get(segTag), ...seg }; // spread falsy 安全（undefined 展开为空）
				nextByTag.set(segTag, acc);
			}
		}
		catalogByTag = nextByTag;
		merged = new Map();
		for (const chainTag of new Set([...chainFor(tag), "en-US"])) {
			const main = deps.mainTables?.()[chainTag] ?? {};
			const floor = floorCatalogs[chainTag] ?? {};
			const catalogSeg = catalogByTag.get(chainTag) ?? {};
			const pack = packs.get(chainTag);
			merged.set(chainTag, { ...floor, ...main, ...catalogSeg, ...(pack?.messages) }); // 语言包槽优先（§5.1）
		}
	};

	return {
		t,
		async init(rawTag) {
			tag = normalizeLocaleTag(rawTag);
			t.setTag(tag);
			await rebuild();
		},
		async setLanguage(rawTag) {
			tag = normalizeLocaleTag(rawTag);
			t.setTag(tag);
			await rebuild();
		},
		activeTag: () => tag,
		rebuild,
		availableLocales(): LocaleEntry[] {
			const out: LocaleEntry[] = BUILTIN_LOCALES.map((b) => ({ ...b, fromPack: false }));
			for (const [packTag, pack] of [...packs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
				if (out.some((e) => e.tag === packTag)) continue;
				out.push({ tag: packTag, native: pack.native ?? KNOWN_NATIVE[packTag] ?? packTag, fromPack: true });
			}
			return out;
		},
		packMissing(): boolean {
			if (BUILTIN_LOCALES.some((b) => b.tag === tag)) return false;
			return !packs.has(tag);
		},
	};
}

export type { LocaleMessages };
