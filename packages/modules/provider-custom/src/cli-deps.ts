import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { orosusHome } from "@orosus/contracts/home";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { defaultCatalogCacheFile, getCatalogWithSource, persistCatalogCache, readCatalogDiskCache, type Catalog } from "./catalog.ts";
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
      // F5 十轮用户拍板：键名 provider（旧 model 键清除防陈旧双写）
      doc["provider"] = providerName;
      delete doc["model"];
      saveDoc(doc);
    },
    setContextWindow: async (n) => {
      const doc = readDoc();
      doc["contextWindow"] = n; // 顶层 contextWindow（与 provider import --model 同落点）
      saveDoc(doc);
    },
    appendSecret: async (key, value) => {
      // MP-09：secrets.env 单行 upsert（对齐 tool-web settings.ts:49 upsertSecret 既定口径——此前纯
      // appendFileSync，同 key 更新时旧行残留、历代旧密钥明文永久累积；加载侧 loadSecretsEnv 后者覆盖
      // 只是功能兜底，文件越用越脏）。值含换行直接拒绝：多行粘贴会向 secrets.env 注入额外行（形如
      // X=Y 的注入行会被 loadSecretsEnv 静默生效成额外变量）；剥除则写入与调用方校验值不一致的坏 key
      // （menu verify 用的是原值）——拒绝并抛可读错误是两害取轻，命令错误通道是既定出口。
      if (/[\r\n]/.test(value)) throw new Error(`${key} 的值含换行——疑似多行粘贴，请整行重新粘贴（未写入）`);
      const existed = existsSync(secretsPath);
      const lines = existed ? readFileSync(secretsPath, "utf8").split("\n") : [];
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop(); // 尾部空行收拢——写盘恒以单换行收尾（追加不带出种子尾空行）
      const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`)); // 原地更新——不累积重复行
      if (idx >= 0) lines[idx] = `${key}=${value}`;
      else lines.push(`${key}=${value}`);
      writeFileSync(secretsPath, `${lines.join("\n")}\n`, { mode: 0o600 });
      if (!existed && process.platform !== "win32") chmodSync(secretsPath, 0o600); // Windows 无 0o600 等价——降级不静默
    },
    env: process.env,
    getCatalog: () => getCatalogWithSource({ cacheFile: defaultCatalogCacheFile() }), // 拉到即落盘——重启后离线也有全量目录
    // 本地文件源的缓存直读（2026-09-28 用户拍板）：~/.orosus/cache/models-dev.json 在场即直读不问路径
    readCacheCatalog: () => readCatalogDiskCache(defaultCatalogCacheFile()),
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
