import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

let atomicSeq = 0;

/** 原子文本写（CK-07 修复，harness user config 写盘共用——CH-08）：同目录临时文件 + rename 原子替换。
 *  旧实现 writeFileSync 直覆写——写入中途崩溃/Ctrl-C 留半截文件，信任存储的耐久性配不上安全角色。
 *  rename 在 POSIX 与 Windows（MOVEFILE_REPLACE_EXISTING）均为原子覆写；mode 仅 POSIX 生效
 *  （tmp 先显式 chmod 钉正 umask，rename 后再钉一次——既有宽权限文件（如手建 644）也被纠正，
 *  旧实现 0o600 只在新建分支生效）。 */
export function atomicWriteTextSync(file: string, data: string, opts: { mode?: number } = {}): void {
  const tmp = `${file}.tmp-${process.pid}-${atomicSeq++}`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", ...(opts.mode !== undefined ? { mode: opts.mode } : {}) });
    if (opts.mode !== undefined && process.platform !== "win32") chmodSync(tmp, opts.mode);
    renameSync(tmp, file);
    if (opts.mode !== undefined && process.platform !== "win32") chmodSync(file, opts.mode);
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort 清扫——rename 成功时 tmp 已不存在 */ }
  }
}

/** 信任存储（§8.5）：key = 模块目录绝对路径（归一化——Windows 盘符大小写）。
 *  解析失败视为空 store（全部重新确认，fail-closed 方向——五轮审查定案）。 */
export interface TrustStore {
  entries: Record<string, { hash: string; confirmedAt: string }>;
}

/** 路径归一化：resolve 后 Windows 侧再 toLowerCase（盘符 D:\ 与 d:\ 失配会让已确认模块反复重确认——M1 check-boundaries 同款坑）。 */
export function normalizeTrustKey(root: string): string {
  const abs = resolve(root); // CK-13：resolve 对相对/绝对输入同途——原 isAbsolute 三元两分支相同（重构残余死代码）
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function loadTrustStore(file: string): TrustStore {
  if (!existsSync(file)) return { entries: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return quarantineCorrupt(file);
  }
  if (typeof parsed !== "object" || parsed === null) return quarantineCorrupt(file);
  const entries = (parsed as TrustStore).entries;
  if (typeof entries !== "object" || entries === null) return quarantineCorrupt(file);
  const normalized: TrustStore["entries"] = {}; // 读入侧归一键——手改/旧版 trust.json 的混合大小写路径统一
  for (const [k, v] of Object.entries(entries)) normalized[normalizeTrustKey(k)] = v;
  return { entries: normalized };
}

/** 坏/异形 trust.json 处置（CK-07）：原样留档改名后按空 store 走——fail-closed 确认语义不变
 *  （本进程全部重新确认），但旧登记字节不再被下一次 save 无痕覆盖（.corrupt-<ts> 可手工恢复）。
 *  留档 best-effort：只读介质/权限不足时不阻塞启动。 */
function quarantineCorrupt(file: string): TrustStore {
  try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* best-effort */ }
  return { entries: {} };
}

export function saveTrustStore(file: string, store: TrustStore): void {
  // CK-07：tmp+rename 原子写 + 0600 无条件（旧实现 writeFileSync 直覆写、chmod 仅新建分支）
  atomicWriteTextSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** 信任判定（§8.5 / m5 T17 决策点 25、设计空白 19）：
 *  项目级按内容 hash——未登记 unconfirmed / 变更 hash-changed（入口文件变了重确认，防 MCPoison 投毒）；
 *  用户级从「恒免」修订为「一次性确认不追 hash」——认登记不看内容（自己地盘，改动不烦；
 *  walkthrough 旧规「用户级恒免确认」就此修订）；未登记 = unconfirmed（进面板「待确认」桶走首挂弹窗）。 */
export function checkTrust(opts: {
  layer: "user" | "project";
  root: string;
  entryHash: string;
  store: TrustStore;
}): { ok: true } | { ok: false; reason: "unconfirmed" | "hash-changed" } {
  const key = normalizeTrustKey(opts.root);
  const entry = opts.store.entries[key];
  if (opts.layer === "user") return entry === undefined ? { ok: false, reason: "unconfirmed" } : { ok: true };
  if (entry === undefined) return { ok: false, reason: "unconfirmed" };
  if (entry.hash !== opts.entryHash) return { ok: false, reason: "hash-changed" };
  return { ok: true };
}

/** 登记确认（`module trust` 子命令与确认流的写入口）。
 *  CK-07 并发口径：读-改-写三步全同步——单线程 JS 内天然串行（无 await 窗口，进程内互斥无需另设）；
 *  半截文件面由 saveTrustStore 的原子写消灭。跨进程同时确认的丢更新窗口仍在（无文件锁——单用户
 *  低频操作，两入口同时确认不同模块才触发；fail-closed 方向，表现为须重新确认，可用性损害非安全损害）。 */
export function trustModule(file: string, root: string, entryHash: string): void {
  const store = loadTrustStore(file);
  store.entries[normalizeTrustKey(root)] = { hash: entryHash, confirmedAt: new Date().toISOString() };
  saveTrustStore(file, store);
}
