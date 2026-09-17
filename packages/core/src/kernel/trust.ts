import { existsSync, readFileSync, writeFileSync, openSync, closeSync, chmodSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/** 信任存储（§8.5）：key = 模块目录绝对路径（归一化——Windows 盘符大小写）。
 *  解析失败视为空 store（全部重新确认，fail-closed 方向——五轮审查定案）。 */
export interface TrustStore {
  entries: Record<string, { hash: string; confirmedAt: string }>;
}

/** 路径归一化：resolve 后 Windows 侧再 toLowerCase（盘符 D:\ 与 d:\ 失配会让已确认模块反复重确认——M1 check-boundaries 同款坑）。 */
export function normalizeTrustKey(root: string): string {
  const abs = isAbsolute(root) ? resolve(root) : resolve(root);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function loadTrustStore(file: string): TrustStore {
  if (!existsSync(file)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as TrustStore;
    if (typeof parsed === "object" && parsed !== null && typeof parsed.entries === "object") {
      const normalized: TrustStore["entries"] = {}; // 读入侧归一键——手改/旧版 trust.json 的混合大小写路径统一
      for (const [k, v] of Object.entries(parsed.entries)) normalized[normalizeTrustKey(k)] = v;
      return { entries: normalized };
    }
    return { entries: {} };
  } catch {
    return { entries: {} }; // 坏文件视为空——全部重新确认（fail-closed）
  }
}

export function saveTrustStore(file: string, store: TrustStore): void {
  if (!existsSync(file)) {
    const fd = openSync(file, "a", 0o600);
    closeSync(fd);
    if (process.platform !== "win32") chmodSync(file, 0o600); // Windows 无 0o600 等价——降级不静默（五轮审查）
  }
  writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
}

/** 信任判定（§8.5）：用户级恒过（亲手放置）；项目级按内容 hash——未登记 unconfirmed / 变更 hash-changed。 */
export function checkTrust(opts: {
  layer: "user" | "project";
  root: string;
  entryHash: string;
  store: TrustStore;
}): { ok: true } | { ok: false; reason: "unconfirmed" | "hash-changed" } {
  if (opts.layer === "user") return { ok: true };
  const key = normalizeTrustKey(opts.root);
  const entry = opts.store.entries[key];
  if (entry === undefined) return { ok: false, reason: "unconfirmed" };
  if (entry.hash !== opts.entryHash) return { ok: false, reason: "hash-changed" };
  return { ok: true };
}

/** 登记确认（`module trust` 子命令与确认流的写入口）。 */
export function trustModule(file: string, root: string, entryHash: string): void {
  const store = loadTrustStore(file);
  store.entries[normalizeTrustKey(root)] = { hash: entryHash, confirmedAt: new Date().toISOString() };
  saveTrustStore(file, store);
}
