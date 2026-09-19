import { appendFileSync, chmodSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { orosusHome } from "@orosus/contracts/home";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { defaultCatalogCacheFile, getCatalogWithSource, persistCatalogCache, type Catalog } from "./catalog.ts";
import type { MenuDeps, ProviderEntry } from "./menu.ts";

/** /provider 菜单的宿主侧副作用接线（D37）：config/secrets 的真实读写——读写 ~/.orosus/ 下约定文件。
 *  CLI 与嵌入式宿主可整体替换（覆盖个别口注入测试/自定义落点）。 */
export function defaultMenuDeps(overrides: Partial<MenuDeps> = {}): MenuDeps {
  const configPath = join(orosusHome(), "config.toml");
  const secretsPath = join(orosusHome(), "secrets.env");
  const readDoc = (): Record<string, unknown> => {
    if (!existsSync(configPath)) return {};
    return parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>; // BOM 剥离（v17）
  };
  const saveDoc = (doc: Record<string, unknown>): void => {
    writeFileSync(configPath, stringify(doc), "utf8"); // 全量重写——注释移除（M2 既定策略，命令输出明示）
  };
  return {
    loadProviders: async () => {
      const pc = (readDoc()["provider-custom"] as Record<string, unknown> | undefined)?.["providers"] ?? {};
      return pc as Record<string, ProviderEntry>;
    },
    saveProviders: async (next) => {
      const doc = readDoc();
      const pc = (doc["provider-custom"] as Record<string, unknown> | undefined) ?? {};
      pc["providers"] = next;
      doc["provider-custom"] = pc;
      saveDoc(doc);
    },
    setModel: async (providerName) => {
      const doc = readDoc();
      doc["model"] = providerName;
      saveDoc(doc);
    },
    setContextWindow: async (n) => {
      const doc = readDoc();
      doc["contextWindow"] = n; // 顶层 contextWindow（与 provider import --model 同落点）
      saveDoc(doc);
    },
    appendSecret: async (key, value) => {
      if (!existsSync(secretsPath)) {
        const fd = openSync(secretsPath, "a", 0o600);
        closeSync(fd);
        if (process.platform !== "win32") chmodSync(secretsPath, 0o600); // Windows 无 0o600 等价——降级不静默
      }
      appendFileSync(secretsPath, `${key}=${value}\n`);
    },
    env: process.env,
    getCatalog: () => getCatalogWithSource({ cacheFile: defaultCatalogCacheFile() }), // 拉到即落盘——重启后离线也有全量目录
    loadLocalCatalog: async (path) => {
      if (path === "") throw new Error("未输入 api.json 路径");
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8")); // 读失败（不存在/坏 JSON）原样抛——向导 catch 转可读文案
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("api.json 形状不对（须为厂商对象映射）");
      const catalog = parsed as Catalog;
      // 本地文件喂盘（用户方案）：一次导入即成磁盘缓存——此后「在线目录」离线也是全量数据
      persistCatalogCache(catalog, defaultCatalogCacheFile());
      return catalog;
    },
    fetchImpl: fetch,
    ...overrides,
  };
}
