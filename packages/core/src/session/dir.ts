import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 会话目录按项目分桶（D46）：cwd 编码为安全目录名——非 [A-Za-z0-9._-] 一律替换为 "-"，
 *  清洗段截断 50 字符后接 8 hex 路径 hash 防碰撞（`D--develop-Orosus-a1b2c3d4` 形态）。
 *  纯函数：store 不感知桶语义，由 CLI 装配时调用（架构节定案）。 */
export function encodeCwd(cwd: string): string {
  const cleaned = cwd.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 50);
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return `${cleaned}-${hash}`;
}

/** 扫描条目：bucket = 桶目录名（undefined = 根平铺——存量会话，D46 原地兼容不迁移）。 */
export interface SessionFileEntry {
  id: string;
  file: string;
  dir: string;
  mtimeMs: number;
  bucket?: string;
}

const SESSION_EXT = /\.(jsonl|sqlite)$/;

/** 双层扫描（D46 统一件）：根平铺（存量）+ 一级桶目录（现行）——/sessions 列表、resume/fork 定位、
 *  未来 prune（T2）共用同一实现；CLI 复用之（铁律禁 core 反向 import apps，统一件落 core 侧）。 */
export function scanSessionFiles(root: string): SessionFileEntry[] {
  const out: SessionFileEntry[] = [];
  const push = (dir: string, bucket: string | undefined): void => {
    for (const f of readdirSync(dir)) {
      if (!SESSION_EXT.test(f)) continue;
      const file = join(dir, f);
      let st;
      try { st = statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ id: f.replace(SESSION_EXT, ""), file, dir, mtimeMs: st.mtimeMs, ...(bucket !== undefined ? { bucket } : {}) });
    }
  };
  try { push(root, undefined); } catch { /* 根不存在（尚无任何会话）*/ }
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try { push(join(root, d.name), d.name); } catch { /* 单桶不可读不炸整体 */ }
    }
  } catch { /* 同上 */ }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 定位既有会话（双层）——resume/fork 跨桶定位 sid 的统一入口；未找到 undefined（调用方决定报错口径）。 */
export function locateSessionFile(root: string, sessionId: string): SessionFileEntry | undefined {
  return scanSessionFiles(root).find((e) => e.id === sessionId);
}
