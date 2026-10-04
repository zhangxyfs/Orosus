import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { orosusHome } from "@orosus/contracts/home";
import { parse } from "smol-toml";

/* ── 路径桶名（拷贝自 packages/core/src/session/dir.ts:8 encodeCwd——铁律 2：模块只能 import
 * @orosus/contracts，contracts 未转出该函数（T9 复用注第一步已核）；与其保持同步。前置归一化是
 * 本批加的（四轮审修口径）：encodeCwd 自身不做盘符归一（dir.ts:9 只替换非法字符，C:/c: 清洗后仍异、
 * sha1 亦异）——先 resolve + win32 toLowerCase（同 core trust.ts:29-32 normalizeTrustKey 精神）再编码。 */
export function projectBucketKey(cwd: string): string {
  const normalized = process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
  const cleaned = normalized.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 50);
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 8);
  return `${cleaned}-${hash}`;
}

/** canonical JSON：键序无关的稳定序列化（嵌套对象递归排序键、数组保序——ZCode 同款 digest 口径）。 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** 项目层 hooks 配置节的 sha256 digest。节体 = [hooks] 解包后的内容（与执行面同源）；键序无关
 *（canonical）；文件不存在/坏 TOML → undefined（无项目层 = 门不适用）。 */
export function projectHooksDigest(projectFile: string): string | undefined {
  try {
    if (!existsSync(projectFile)) return undefined;
    const doc = parse(readFileSync(projectFile, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const section = typeof doc["hooks"] === "object" && doc["hooks"] !== null ? doc["hooks"] : doc;
    return createHash("sha256").update(canonicalJson(section), "utf8").digest("hex");
  } catch {
    return undefined;
  }
}

export interface TrustRecord {
  digest: string;
  trustedAt: string;
}

/** 信任记录文件：~/.orosus/hooks/hooks-trust.json（用户拍板入 hooks/ 新目录——首写 mkdir recursive 在
 *  写侧（T10 /settings 审查动作，走 core atomicWriteTextSync）；本读侧只读，损坏当无记录（容错对齐
 *  trust.ts quarantine 先例——坏文件由写侧留档改名，读侧不修文件）。 */
export const trustFilePath = (): string => join(orosusHome(), "hooks", "hooks-trust.json");

/** 读信任表：键 = projectBucketKey(cwd)。损坏/缺席 = 空表（项目层待审——fail-closed 方向）。 */
export function readTrustTable(file: string): Record<string, TrustRecord> {
  try {
    if (!existsSync(file)) return {};
    const raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const out: Record<string, TrustRecord> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v !== null && typeof v === "object" && typeof (v as Record<string, unknown>)["digest"] === "string") {
        out[k] = { digest: (v as Record<string, unknown>)["digest"] as string, trustedAt: String((v as Record<string, unknown>)["trustedAt"] ?? "") };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 信任评估（dispatch 前现算——digest 毫秒级不缓存，改配置立即重新待审）：
 *  无项目层 = 不适用（放行）；digest 匹配 = 放行；否则整层不执行（调用方记 skipped-untrusted）。 */
export function evaluateProjectTrust(projectFile: string, cwd: string, trustFile: string): { applicable: boolean; trusted: boolean; digest?: string } {
  const digest = projectHooksDigest(projectFile);
  if (digest === undefined) return { applicable: false, trusted: true };
  const table = readTrustTable(trustFile);
  const record = table[projectBucketKey(cwd)];
  return { applicable: true, trusted: record?.digest === digest, digest };
}
