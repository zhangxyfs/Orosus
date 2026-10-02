import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedBundledCatalog, catalogProviderView, bundledCatalogFile, bundledCatalogHealthy } from "./bundled-catalog.ts";
import { defaultCatalogCacheFile } from "./catalog.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ob-catalog-"));

/** 信封构造（与 writeDiskCache 同形：{ fetchedAt, catalog }）。 */
const envelope = (catalog: unknown): string => JSON.stringify({ fetchedAt: 1700000000000, catalog });

/** 最小可用模型（usableCatalogModels 口径放行：非 embed、tool_call 非 false、text 输出缺省）。 */
const M = { id: "m1" };

describe("预装目录固化（2026-10-02 用户拍板——预装 models-dev.json 打开程序拷到 cache 下）", () => {
	it("① cache 缺失 → 拷预装件（合法信封、catalog 非空）；预装件本身缺失 → 静默跳过不炸", () => {
		const dir = tmp();
		const cacheFile = join(dir, "cache", "models-dev.json");
		seedBundledCatalog(cacheFile, bundledCatalogFile()); // 真预装件
		expect(existsSync(cacheFile)).toBe(true);
		const doc = JSON.parse(readFileSync(cacheFile, "utf8")) as { fetchedAt: number; catalog: Record<string, unknown> };
		expect(typeof doc.fetchedAt).toBe("number");
		expect(Object.keys(doc.catalog).length).toBeGreaterThan(100); // 全量快照（≥200 家量级）
		seedBundledCatalog(cacheFile, join(dir, "不存在的源.json")); // 源缺失——静默，已有缓存也不该被动
		expect(existsSync(cacheFile)).toBe(true);
	});

	it("② cache 已有合法缓存 → 不回滚（在线拉取的新数据原样保留）；坏 JSON → 重拷修复", () => {
		const dir = tmp();
		const cacheFile = join(dir, "models-dev.json");
		writeFileSync(cacheFile, envelope({ myprovider: { api: "https://x", env: ["X"], models: { m1: M } } }), "utf8");
		seedBundledCatalog(cacheFile, bundledCatalogFile());
		const kept = JSON.parse(readFileSync(cacheFile, "utf8")) as { catalog: Record<string, unknown> };
		expect(Object.keys(kept.catalog)).toEqual(["myprovider"]); // 未被预装件覆盖
		writeFileSync(cacheFile, "{ 坏 json", "utf8");
		seedBundledCatalog(cacheFile, bundledCatalogFile());
		const fixed = JSON.parse(readFileSync(cacheFile, "utf8")) as { catalog: Record<string, unknown> };
		expect(Object.keys(fixed.catalog).length).toBeGreaterThan(100); // 坏文件被预装件修复
		rmSync(dir, { recursive: true, force: true });
	});

	it("③ 预装件健康自检：仓库资产存在、可解析、defaultCatalogCacheFile 落点即用户拍板路径", () => {
		expect(bundledCatalogHealthy()).toBe(true);
		expect(defaultCatalogCacheFile()).toContain(join("cache", "models-dev.json"));
	});
});

describe("引导第 2 页提供商视图（catalogProviderView——从盘上目录缓存派生，替换 SW-21 烤码快照正源）", () => {
	let cacheFile = "";
	beforeAll(() => {
		cacheFile = join(tmp(), "models-dev.json");
		writeFileSync(cacheFile, envelope({
			// 上游真实形态：openai/anthropic 无 api 字段——烤码端点兜底表补（BUILTIN_SNAPSHOT 人工核过的端点）
			openai: { env: ["OPENAI_API_KEY"], npm: "@ai-sdk/openai", name: "OpenAI", models: { "gpt-1": M } },
			anthropic: { env: ["ANTHROPIC_API_KEY"], npm: "@ai-sdk/anthropic", name: "Anthropic", models: { "c-1": M } },
			"zhipuai-coding-plan": { api: "https://open.bigmodel.cn/api/coding/paas/v4", env: ["ZHIPU_API_KEY"], npm: "@ai-sdk/openai-compatible", name: "Zhipu Coding Plan", models: { "glm-1": M } },
			// 应排除：本地服务（免 Key 概念 2026-10-02 拍板退役）/ 无端点且不在烤码兜底表 / env 空 / 只有 embedding 模型
			lmstudio: { api: "http://localhost:1234/v1", env: [], npm: "@ai-sdk/openai-compatible", name: "LM Studio", models: { "l-1": M } },
			noend: { env: ["G_API_KEY"], npm: "@ai-sdk/openai", name: "Groq-like", models: { m: M } },
			nokey: { api: "https://x.example/v1", env: [], npm: "@ai-sdk/openai", models: { m: M } },
			embedonly: { api: "https://e.example/v1", env: ["E_API_KEY"], npm: "@ai-sdk/openai", models: { "text-embed": { id: "text-embed" } } },
			// 字典序殿后家（z 开头验证排序）
			"zzz-cloud": { api: "https://zzz.example/v1", env: ["ZZZ_API_KEY"], npm: "@ai-sdk/openai", models: { "z-1": M } }
		}), "utf8");
	});

	it("① 过滤：env 空本地家不列（免 Key 概念退役）/ 无端点且兜底表也缺 / 无可用 text 模型的家不列", () => {
		const view = catalogProviderView(cacheFile)!;
		const ids = view.map((p) => p.id);
		expect(ids).toContain("openai");
		expect(ids).not.toContain("lmstudio"); // localhost 条目——本地服务概念退役不列
		expect(ids).not.toContain("ollama"); // 已整体移除
		expect(ids).not.toContain("noend");
		expect(ids).not.toContain("nokey");
		expect(ids).not.toContain("embedonly");
	});

	it("② 端点兜底：openai 无 api 字段 → 烤码表端点", () => {
		const view = catalogProviderView(cacheFile)!;
		expect(view.find((p) => p.id === "openai")?.baseUrl).toBe("https://api.openai.com/v1");
	});

	it("③ 排序：头部序列优先（openai→anthropic→zhipuai-coding-plan），其余 id 字典序殿后", () => {
		const view = catalogProviderView(cacheFile)!;
		const ids = view.map((p) => p.id);
		expect(ids.indexOf("openai")).toBeLessThan(ids.indexOf("anthropic"));
		expect(ids.indexOf("anthropic")).toBeLessThan(ids.indexOf("zhipuai-coding-plan"));
		expect(ids.indexOf("zhipuai-coding-plan")).toBeLessThan(ids.indexOf("zzz-cloud"));
		const tails = ids.filter((id) => !["openai", "anthropic", "zhipuai-coding-plan"].includes(id));
		expect(tails).toStrictEqual([...tails].toSorted((a, b) => a.localeCompare(b))); // 非头部家字典序
	});

	it("④ 映射：envKey/baseUrl/type（npm 协议），视图不带模型清单也不带 local（SW-21 不嵌模型级数据）", () => {
		const view = catalogProviderView(cacheFile)!;
		expect(view.find((p) => p.id === "anthropic")).toMatchObject({ name: "Anthropic", envKey: "ANTHROPIC_API_KEY", type: "anthropic" });
		for (const p of view) {
			expect(p).not.toHaveProperty("models");
			expect(p).not.toHaveProperty("local");
		}
	});

	it("⑤ 盘上无缓存/坏文件 → undefined（调用方回退烤码快照）", () => {
		expect(catalogProviderView(join(tmp(), "缺失.json"))).toBeUndefined();
		const bad = join(tmp(), "bad.json");
		writeFileSync(bad, "{ 坏", "utf8");
		expect(catalogProviderView(bad)).toBeUndefined();
	});
});
