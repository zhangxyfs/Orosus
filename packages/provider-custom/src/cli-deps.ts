import { appendFileSync, chmodSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { getCatalog, type Catalog } from "./catalog.ts";
import type { MenuDeps, ProviderEntry } from "./menu.ts";

/** /provider 菜单的宿主侧副作用接线（D37）：config/secrets 的真实读写——读写 ~/.orosus/ 下约定文件。
 *  CLI 与嵌入式宿主可整体替换（覆盖个别口注入测试/自定义落点）。 */
export function defaultMenuDeps(overrides: Partial<MenuDeps> = {}): MenuDeps {
  const configPath = join(homedir(), ".orosus", "config.toml");
  const secretsPath = join(homedir(), ".orosus", "secrets.env");
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
    appendSecret: async (key, value) => {
      if (!existsSync(secretsPath)) {
        const fd = openSync(secretsPath, "a", 0o600);
        closeSync(fd);
        if (process.platform !== "win32") chmodSync(secretsPath, 0o600); // Windows 无 0o600 等价——降级不静默
      }
      appendFileSync(secretsPath, `${key}=${value}\n`);
    },
    env: process.env,
    getCatalog: (): Promise<Catalog> => getCatalog({}),
    loadLocalCatalog: async (path) => JSON.parse(readFileSync(path, "utf8")) as Catalog,
    fetchImpl: fetch,
    ...overrides,
  };
}
