import { resolve, sep } from "node:path";
import type { Access } from "@orosus/contracts/tool";

/** fs 路径归一化：resolve 后统一比较；win32 盘符与整路径大小写归一（trust key 同款坑）。 */
function normalizeFsPath(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/** 前缀重叠按目录边界：/dir 与 /dir/deep/z.ts 重叠，/dir 与 /dirx 不重叠。 */
function fsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const boundary = shorter.endsWith(sep) ? shorter : shorter + sep;
  return longer.startsWith(boundary);
}

/** §6.3 冲突矩阵：fs.read × fs.read 恒不冲突；fs 读写按归一化前缀重叠；network 同 host；
 * subprocess 与 subprocess/fs.write/network 冲突（不透明执行，跨 kind 例外）而与 fs.read 不冲突；
 * kind:"all" 与一切冲突。 */
export function accessConflict(a: Access, b: Access): boolean {
  if (a.kind === "all" || b.kind === "all") return true;
  if (a.kind === "subprocess" || b.kind === "subprocess") {
    const other = a.kind === "subprocess" ? b : a;
    if (other.kind === "subprocess") return true;
    return other.kind === "fs.write" || other.kind === "network";
  }
  if (a.kind === "network" && b.kind === "network") return a.host === b.host;
  if ((a.kind === "fs.read" || a.kind === "fs.write") && (b.kind === "fs.read" || b.kind === "fs.write")) {
    if (a.kind === "fs.read" && b.kind === "fs.read") return false; // 读撕裂可重试，写破坏不可逆
    return fsOverlap(normalizeFsPath(a.path), normalizeFsPath(b.path));
  }
  return false; // network × fs 跨 kind 原则上不冲突
}

/** D40 贪心分组：按 call 序加入最早的无冲突组，否则开新组。纯函数、确定性；
 * 组间串行执行、组内并行（§6.3 数据驱动的并发调度）。 */
export function scheduleByAccesses(calls: { accesses: Access[] }[]): number[][] {
  const groups: { members: number[]; accesses: Access[] }[] = [];
  calls.forEach((call, i) => {
    const fit = groups.find((g) => !g.accesses.some((ga) => call.accesses.some((ca) => accessConflict(ga, ca))));
    if (fit !== undefined) {
      fit.members.push(i);
      fit.accesses.push(...call.accesses);
    } else {
      groups.push({ members: [i], accesses: [...call.accesses] });
    }
  });
  return groups.map((g) => g.members);
}
