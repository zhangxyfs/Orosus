import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { AtEntry } from "./tui/fullapp-at.ts";

/** @ 文件菜单数据源（m5-at-menu T5）：dir（相对 process.cwd() 的路径，根 = 空串）→ 目录条目全量。
 *  与 atfile.ts 同目录同层级（import node:fs——非 tui 家族件，tui 无 fs 纪律不破；宿主供数、
 *  UI 只消费）。导航点现读、不缓存（渲染期不碰文件系统）；失败 → { entries: [], miss: true }
 *  （目录不存在空态文案的依据）。
 *  归类（D7）：符号链接 statSync 跟随判定真实类型（dirent.isSymbolicLink 只说明是链接——目标
 *  是目录才算目录；stat 失败按文件——断链不炸不挂）。排序（D6）：目录在前、各组码元比较 < 升序
 *  ——不用 localeCompare（系统 locale 差异让测试漂移）。 */
/** 码元升序比较（D6——不用 localeCompare，系统 locale 差异让测试漂移）。 */
const byName = (a: AtEntry, b: AtEntry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function atMenuEntries(dir: string): { entries: AtEntry[]; miss?: boolean } {
  try {
    const dirents = readdirSync(resolve(process.cwd(), dir), { withFileTypes: true });
    const entries: AtEntry[] = dirents.map((d) => {
      if (!d.isSymbolicLink()) return { name: d.name, dir: d.isDirectory() };
      try {
        return { name: d.name, dir: statSync(resolve(process.cwd(), dir, d.name)).isDirectory() };
      } catch {
        return { name: d.name, dir: false }; // 断链按文件（D7——stat 失败不炸不挂）
      }
    });
    return { entries: [...entries.filter((e) => e.dir).toSorted(byName), ...entries.filter((e) => !e.dir).toSorted(byName)] };
  } catch {
    return { entries: [], miss: true }; // 目录不存在/不可读——空态可见反馈（UI 不炸）
  }
}
