import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** 记忆桶键件（m5-peers-import-fix T1）：「记忆属于哪个项目」的答案从启动目录改成 git 仓库根（D1）。
 *  宿主（导入目的地）与模块（env.memoryDir）两侧共用同一把键；包内复刻 encodeCwd 的原因 =
 *  模块包运行时只许依赖 contracts + zod（package.json 纪律），键算法复刻 + 测试与 core 原件对拍防漂移
 *  （sanitizeRoot/zcodeSlug 同族先例，importers.ts）。 */

/** 向上找 .git，到根没有回退 cwd（自 apps/cli/src/main.ts 下沉，逻辑不变——cc/qwen 按项目记忆的
 *  定位基准：git 根才是「项目」）。 */
export function findGitRoot(cwd: string): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;   // 到根没有 .git → 用 cwd（探测退化为本目录）
    dir = parent;
  }
}

/** core encodeCwd 逐字复刻（session/dir.ts:8-12）：非 [A-Za-z0-9._-] 替换 "-"、清洗段截 50 字符、
 *  接 sha1(原 cwd) 前 8 hex（`D--develop-Orosus-a1b2c3d4` 形态）——与 core 原件对拍测试钉死。 */
export function encodeCwdLike(cwd: string): string {
  const cleaned = cwd.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 50);
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return `${cleaned}-${hash}`;
}

/** 记忆桶键 = encodeCwd(git 根)（D1：非 git 目录回退 cwd = 裸键）。 */
export function memoryBucketKey(cwd: string): string {
  return encodeCwdLike(findGitRoot(cwd));
}
